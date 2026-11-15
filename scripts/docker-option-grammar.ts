/** Offline Docker CLI v29.1.3 argv grammar, not an executor/value validator.
 * Source commit f52814d454173982e6692dd7e290a41b828d9cbc.
 * Complete independent source ledger and tradeoffs: docs/naming-docker-option-investigation.md.
 */
export interface DockerOption {
  name: string;
  shorthand?: string;
  takesValue: boolean;
}
type Phase = 'root' | 'run' | 'create';

function options(takesValue: boolean, entries: string): DockerOption[] {
  return entries
    .trim()
    .split(/\s+/)
    .map((entry) => {
      const [name, shorthand] = entry.split('/');
      return { name: name!, shorthand, takesValue };
    });
}

// opts.go:187–326. Hidden/deprecated/platform-specific registrations still
// participate in lexical parsing; visibility is not option arity.
const common = [
  ...options(
    true,
    `
    attach/a device-cgroup-rule device gpus env/e env-file entrypoint group-add
    hostname/h domainname label/l label-file restart stop-signal stop-timeout
    sysctl ulimit user/u workdir/w cap-add cap-drop security-opt userns cgroupns
    add-host dns dns-opt dns-option dns-search expose ip ip6 link link-local-ip
    mac-address publish/p net network net-alias network-alias log-driver
    volume-driver log-opt storage-opt tmpfs volumes-from volume/v mount health-cmd
    health-interval health-retries health-timeout health-start-period
    health-start-interval blkio-weight blkio-weight-device cidfile cpuset-cpus
    cpuset-mems cpu-count cpu-percent cpu-period cpu-quota cpu-rt-period
    cpu-rt-runtime cpu-shares/c cpus device-read-bps device-read-iops
    device-write-bps device-write-iops io-maxbandwidth io-maxiops memory/m
    memory-reservation memory-swap memory-swappiness oom-score-adj pids-limit
    cgroup-parent ipc isolation pid shm-size uts runtime annotation kernel-memory
  `,
  ),
  ...options(
    false,
    `interactive/i read-only tty/t rm privileged publish-all/P
    no-healthcheck oom-kill-disable init`,
  ),
];

export const dockerGrammar: Readonly<Record<Phase, readonly DockerOption[]>> = {
  root: [
    ...options(true, 'config log-level/l tlscacert tlscert tlskey host/H context/c'),
    ...options(false, 'debug/D tls tlsverify help/h version/v'),
  ],
  run: [
    ...common,
    ...options(true, 'name detach-keys pull platform'),
    ...options(false, 'detach/d sig-proxy quiet/q use-api-socket help disable-content-trust'),
  ],
  create: [
    ...common,
    ...options(true, 'name pull platform'),
    ...options(false, 'quiet/q use-api-socket help disable-content-trust'),
  ],
};

const lookups = Object.fromEntries(
  Object.entries(dockerGrammar).map(([phase, flags]) => [
    phase,
    {
      long: new Map(flags.map((flag) => [flag.name, flag])),
      short: new Map(flags.filter((flag) => flag.shorthand).map((flag) => [flag.shorthand!, flag])),
    },
  ]),
) as Record<Phase, { long: Map<string, DockerOption>; short: Map<string, DockerOption> }>;

interface ParsedOptions {
  next: number;
  names: string[];
  problem?: string;
}

function parseOptions(words: string[], start: number, phase: Phase): ParsedOptions {
  const names: string[] = [];
  const grammar = lookups[phase];
  let index = start;
  const problem = (message: string): ParsedOptions => ({ next: index, names, problem: message });
  while (index < words.length) {
    const word = words[index]!;
    if (word === '--') return { next: index + 1, names };
    // Empty quoted argv entries are positional too; never discard them.
    if (!word.startsWith('-') || word === '-') break;
    if (word.startsWith('--')) {
      const equals = word.indexOf('=');
      const name = word.slice(2, equals < 0 ? undefined : equals);
      const flag = grammar.long.get(name);
      if (!flag) return problem(`unknown Docker ${phase} option --${name} for pinned CLI v29.1.3`);
      if (equals >= 0) {
        if (phase !== 'root' && name === 'name') names.push(word.slice(equals + 1));
      } else if (flag.takesValue) {
        if (index + 1 >= words.length)
          return problem(`missing value for Docker ${phase} option --${name}`);
        // pflag consumes even a value that is empty or looks like --another-flag.
        const value = words[++index]!;
        if (phase !== 'root' && name === 'name') names.push(value);
      }
    } else {
      for (let char = 1; char < word.length; char++) {
        const shorthand = word[char]!;
        const flag = grammar.short.get(shorthand);
        if (!flag)
          return problem(`unknown Docker ${phase} shorthand -${shorthand} for pinned CLI v29.1.3`);
        const rest = word.slice(char + 1);
        // pflag: explicit =value ends a short cluster, including boolean flags.
        if (rest.startsWith('=')) break;
        if (flag.takesValue) {
          if (!rest) {
            if (index + 1 >= words.length)
              return problem(`missing value for Docker ${phase} shorthand -${shorthand}`);
            index++;
          }
          break;
        }
      }
    }
    index++;
  }
  return { next: index, names };
}

export interface DockerDeclaration {
  names: string[];
  problem?: string;
}

/** Words AFTER the docker executable; shell quoting is handled by the caller. */
export function dockerDeclaration(words: string[]): DockerDeclaration {
  const root = parseOptions(words, 0, 'root');
  if (root.problem) {
    // Unrelated Docker verbs are not container creation declarations. Ambiguous
    // creation commands cannot silently pass an unsupported root grammar.
    return words.some((word) => word === 'run' || word === 'create')
      ? { names: [], problem: root.problem }
      : { names: [] };
  }
  let index = root.next;
  if (words[index] === 'container') index++;
  const command = words[index];
  if (command !== 'run' && command !== 'create') return { names: [] };
  const parsed = parseOptions(words, index + 1, command);
  if (parsed.problem) return parsed;
  if (parsed.next >= words.length)
    return { names: parsed.names, problem: `missing IMAGE for Docker ${command}` };
  // SetInterspersed(false): everything from IMAGE onward is opaque payload.
  return { names: parsed.names };
}

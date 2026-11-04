import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkSource } from '../../scripts/check-naming-policy.ts';
import { dockerGrammar } from '../../scripts/docker-option-grammar.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const report = readFileSync(join(root, 'docs/naming-docker-option-investigation.md'), 'utf8');
// Independently transcribed upstream registration facts, not the production map.
// Completeness compares every option/alias/short/type, not only hand-picked names.
const ledger = report
  .split('<!-- BEGIN DOCKER SOURCE LEDGER -->')[1]!
  .split('<!-- END DOCKER SOURCE LEDGER -->')[0]!
  .split('\n')
  .filter((line) => /^(common|root|run|create) (value|boolean) /.test(line))
  .flatMap((line) => {
    const [scope, kind, ...entries] = line.split(/\s+/);
    return entries.map((entry) => {
      const match = entry.match(/^([^/@]+)(?:\/([^@]))?@(\d+)$/);
      if (!match) throw new Error(`invalid upstream ledger entry: ${entry}`);
      return {
        scope: scope!,
        name: match[1]!,
        shorthand: match[2],
        takesValue: kind === 'value',
        line: Number(match[3]),
      };
    });
  });

interface Probe {
  label: string;
  source: string;
  expected: number;
  manual?: boolean;
  file?: string;
}
const matrix: Probe[] = [];
function probe(
  label: string,
  source: string,
  expected: number,
  manual = false,
  file?: string,
): void {
  matrix.push({ label, source, expected, manual, file });
}

for (const command of ['run', 'create'] as const) {
  for (const flag of ledger.filter(
    (entry) => entry.scope === 'common' || entry.scope === command,
  )) {
    const prefix = `docker ${command}`;
    const long = `--${flag.name}`;
    if (flag.takesValue) {
      probe(`${command} ${long} separate`, `${prefix} ${long} postgres16 --name URL-27 alpine`, 1);
      probe(`${command} ${long} equals`, `${prefix} ${long}=postgres16 --name=URL-27 alpine`, 1);
      probe(
        `${command} ${long} payload`,
        `${prefix} ${long} postgres16 alpine echo --name URL-27`,
        0,
      );
      probe(`${command} ${long} empty`, `${prefix} ${long} "" --name URL-27 alpine`, 1);
      probe(
        `${command} ${long} flag-looking separate value`,
        `${prefix} ${long} --name=URL-27 alpine`,
        flag.name === 'name' ? 1 : 0,
      );
      probe(
        `${command} ${long} flag-looking equals value`,
        `${prefix} ${long}=--name=URL-27 alpine`,
        flag.name === 'name' ? 1 : 0,
      );
      probe(
        `${command} ${long} required value is --`,
        `${prefix} ${long} -- --name URL-27 alpine`,
        1,
      );
      probe(`${command} ${long} missing value`, `${prefix} ${long}`, 1, true);
      if (flag.shorthand) {
        const short = `-${flag.shorthand}`;
        probe(`${command} ${short} separate`, `${prefix} ${short} value --name URL-27 alpine`, 1);
        probe(`${command} ${short} attached`, `${prefix} ${short}value --name URL-27 alpine`, 1);
        probe(`${command} ${short} equals`, `${prefix} ${short}=value --name URL-27 alpine`, 1);
        probe(
          `${command} ${short} cluster`,
          `${prefix} -it${flag.shorthand} value --name URL-27 alpine`,
          1,
        );
        probe(
          `${command} ${short} attached cluster`,
          `${prefix} -it${flag.shorthand}value --name URL-27 alpine`,
          1,
        );
        probe(`${command} ${short} empty`, `${prefix} ${short} '' --name URL-27 alpine`, 1);
        probe(
          `${command} ${short} flag-looking value`,
          `${prefix} ${short} --name=URL-27 alpine`,
          0,
        );
        probe(`${command} ${short} missing value`, `${prefix} ${short}`, 1, true);
      }
    } else {
      probe(`${command} ${long} bare boolean`, `${prefix} ${long} --name URL-27 alpine`, 1);
      probe(
        `${command} ${long} explicit boolean`,
        `${prefix} ${long}=false --name URL-27 alpine`,
        1,
      );
      probe(
        `${command} ${long} boolean IMAGE boundary`,
        `${prefix} ${long} false --name URL-27`,
        0,
      );
      probe(
        `${command} ${long} harmless payload`,
        `${prefix} ${long} alpine printf '%s\\n' --name=URL-27`,
        0,
      );
      if (flag.shorthand) {
        const short = `-${flag.shorthand}`;
        probe(`${command} ${short} bare boolean`, `${prefix} ${short} --name URL-27 alpine`, 1);
        probe(
          `${command} ${short} explicit boolean`,
          `${prefix} ${short}=false --name URL-27 alpine`,
          1,
        );
        probe(
          `${command} ${short} explicit clustered boolean`,
          `${prefix} -it${flag.shorthand}=false --name URL-27 alpine`,
          1,
        );
        probe(
          `${command} ${short} boolean IMAGE boundary`,
          `${prefix} ${short} false --name URL-27`,
          0,
        );
      }
    }
  }
  for (const flag of ledger.filter((entry) => entry.scope === 'root')) {
    const forms = flag.takesValue
      ? [`--${flag.name} value`, `--${flag.name}=value`, `--${flag.name} ""`]
      : [`--${flag.name}`, `--${flag.name}=false`];
    if (flag.shorthand)
      forms.push(
        ...(flag.takesValue
          ? [`-${flag.shorthand} value`, `-${flag.shorthand}value`, `-${flag.shorthand}=value`]
          : [`-${flag.shorthand}`, `-${flag.shorthand}=false`]),
      );
    for (const form of forms) {
      probe(`${command} root ${form}`, `docker ${form} ${command} --name URL-27 alpine`, 1);
      probe(
        `${command} root payload ${form}`,
        `docker ${form} container ${command} alpine echo --name URL-27`,
        0,
      );
    }
  }
}

// Exact returned defect, aliases, root causes and bounded unsupported grammar.
for (const [source, expected, manual] of [
  ['docker run --net bridge --name URL-27 alpine', 1],
  ['docker create --net bridge --name=URL-27 alpine', 1],
  ['docker run --network bridge --net-alias worker --name URL-27 alpine', 1],
  ['docker run --net=bridge --name URL-27 alpine', 1],
  ['docker run --entrypoint "" --name URL-27 alpine', 1],
  ['docker run -- --name URL-27 alpine', 0],
  ['docker run --rm alpine echo --name URL-27', 0],
  ["docker run --rm alpine printf '%s\\n' --name=URL-27", 0],
  ['docker run --name postgres16 alpine echo --name URL-27', 0],
  ['docker run --name url8 alpine', 0],
  ['docker run --name api-v2 alpine', 0],
  ['echo "docker run --net bridge --name URL-27 alpine"', 0],
  ['echo done # docker run --net bridge --name URL-27 alpine', 0],
  ['docker run --future-value option --name URL-27 alpine', 1, true],
  ['docker run --future=value --name URL-27 alpine', 1, true],
  ['docker run -z option --name URL-27 alpine', 1, true],
  ['docker create --detach alpine', 1, true],
  ['docker create --detach-keys x --name URL-27 alpine', 1, true],
  ['docker --future option run --name URL-27 alpine', 1, true],
  ['docker --future option ps', 0],
  ['docker ps --future-option', 0],
  ['docker run --net bridge', 1, true],
] as [string, number, boolean?][])
  probe(source, source, expected, manual);

for (const source of [
  'docker run --net bridge --name URL-27 alpine',
  'docker create --net bridge --name=URL-27 alpine',
  'docker run --network bridge --net-alias worker --name URL-27 alpine',
]) {
  probe(
    `workflow scalar ${source}`,
    `name: CI\nsteps:\n  - run: ${source}`,
    1,
    false,
    '.github/workflows/demo.yml',
  );
  probe(
    `workflow block ${source}`,
    `name: CI\nsteps:\n  - run: |\n      ${source}`,
    1,
    false,
    '.github/workflows/demo.yml',
  );
}

describe('source-pinned complete Docker option grammar', () => {
  it('matches every frozen upstream registration, arity and short alias', () => {
    expect(ledger).toHaveLength(126);
    for (const phase of ['root', 'run', 'create'] as const) {
      const expected = ledger
        .filter((entry) => entry.scope === phase || (phase !== 'root' && entry.scope === 'common'))
        .map(({ name, shorthand, takesValue }) => ({ name, shorthand, takesValue }))
        .sort((a, b) => a.name.localeCompare(b.name));
      const actual = [...dockerGrammar[phase]].sort((a, b) => a.name.localeCompare(b.name));
      expect(actual, phase).toEqual(expected);
      expect(new Set(actual.map((entry) => entry.name)).size).toBe(actual.length);
      const shorts = actual.flatMap((entry) => (entry.shorthand ? [entry.shorthand] : []));
      expect(new Set(shorts).size).toBe(shorts.length);
    }
    expect(dockerGrammar.run).toHaveLength(107);
    expect(dockerGrammar.create).toHaveLength(104);
    expect(dockerGrammar.root).toHaveLength(12);
  });

  it.each(matrix)('$label', ({ source, expected, manual, file }) => {
    const found = checkSource(file ?? 'scripts/probe.sh', source);
    expect(found, source).toHaveLength(expected);
    if (manual) expect(found[0]?.reason, source).toBeTruthy();
    else
      expect(
        found.every((finding) => !finding.reason),
        source,
      ).toBe(true);
  });

  it('runs the entire independent matrix through the real CLI without runtime/network access', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'naming-docker-matrix-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: tmp });
      const expectedFiles = new Set<string>();
      const expectedManual = new Set<string>();
      const files = matrix.map((entry, index) => {
        const file = `scripts/matrix/probe-${index}${entry.file?.endsWith('.yml') ? '.yml' : '.sh'}`;
        mkdirSync(join(tmp, file, '..'), { recursive: true });
        writeFileSync(join(tmp, file), entry.source);
        if (entry.expected) expectedFiles.add(file);
        if (entry.manual) expectedManual.add(file);
        return file;
      });
      execFileSync('git', ['add', '.'], { cwd: tmp });
      const result = spawnSync(
        process.execPath,
        ['--experimental-strip-types', join(root, 'scripts/check-naming-policy.ts')],
        {
          cwd: tmp,
          encoding: 'utf8',
          maxBuffer: 8 * 1024 * 1024,
          env: {
            ...process.env,
            HTTP_PROXY: 'http://127.0.0.1:9',
            HTTPS_PROXY: 'http://127.0.0.1:9',
          },
        },
      );
      expect(result.status, result.stderr).toBe(1);
      const lines = result.stderr.split('\n').filter((line) => line.startsWith('scripts/matrix/'));
      expect(lines).toHaveLength(expectedFiles.size);
      expect(new Set(lines.map((line) => line.split(':')[0]))).toEqual(expectedFiles);
      expect(
        new Set(
          lines
            .filter((line) => line.includes('manual naming review required:'))
            .map((line) => line.split(':')[0]),
        ),
      ).toEqual(expectedManual);
      expect(result.stdout).toContain(
        `${expectedFiles.size - expectedManual.size} violation(s), ${expectedManual.size} manual-review finding(s)`,
      );
      for (const [index, file] of files.entries())
        expect(readFileSync(join(tmp, file), 'utf8')).toBe(matrix[index]!.source);
      expect(execFileSync('git', ['diff', '--exit-code'], { cwd: tmp, encoding: 'utf8' })).toBe('');
      console.log(
        `Docker grammar CLI matrix: ${matrix.length} fixtures; ${expectedFiles.size} expected diagnostics (${expectedManual.size} manual-review); no runtime execution`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});

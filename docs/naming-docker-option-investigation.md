# Docker option-arity recurrence: investigation before retry

Dependency: PR #11 at `775c130c482e9b7397ab2ddd3dc53aec7c97f51b`.
[Full submitted FAIL report](https://github.com/roy-melamed/url-shortener-api/pull/11#pullrequestreview-5773362290).
Investigation performed before implementation, 2026-11-04. Michael was notified
that this recurrence paused the patch/retry loop for a root-cause investigation.
No Docker executable, daemon, container, database or cloud resource was invoked.
Public upstream source was read via HTTPS/GitHub only; scanned examples are text.

## Root cause and complete comparison

The previous parser maintained a hand-selected **value-only** option set. It
silently treated unknown long options as booleans, then mistook their separate
values for IMAGE. Tests sampled canonical spellings rather than checking every
upstream registration. Adding only two aliases would repeat that design error.

Source inspected: Docker CLI **v29.1.3**, annotated tag resolved to immutable
commit **`f52814d454173982e6692dd7e290a41b828d9cbc`**:

| Source at that commit                   | SHA-256 of fetched full file                                       | Investigation                                                                        |
| --------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `cli/command/container/opts.go`         | `25120cedc0f8f197fa3b6da2f64d61e91c9ee31f346a6b1b500419df0b6245b8` | All 97 common flag registrations, hidden aliases, deprecated/platform-specific flags |
| `cli/command/container/run.go`          | `0d9cc0fe36e2400bb014f79219c425418577c2cdf5652a225afc3a009f34d669` | 10 run-only registrations, non-interspersed parsing                                  |
| `cli/command/container/create.go`       | `c4b674953d43e3e5073fe5efa1056c647c13ef337b74cecedefd11fcc4e857bf` | 7 create-only registrations, non-interspersed parsing                                |
| `cli/flags/options.go`                  | `d2bf68c3ce37773168ddf12c7ed18f5e895ecc152c535ac4e000a603043034e7` | Root client flags, constant `FlagTLSVerify=\"tlsverify\"`                            |
| `cli/cobra.go`                          | `1c18dcf915bd37004a481509f5dc35d82d1aabfbf1d30918ae28737edc6beb33` | Root flags before verb, non-interspersed global parse, root help                     |
| `cmd/docker/docker.go`                  | `1c0fc026f2673545f2f7dea0019b0065034d96797683de46ef40898f09cb7220` | Root version flag, TraverseChildren                                                  |
| `vendor/github.com/spf13/pflag/flag.go` | `65e9c5e5f763cb701a26873ce16584642d442d64277ed688956e8b560c30d3cd` | Long/short parsing and `--`/IMAGE boundaries, lines 980–1165                         |
| `vendor/github.com/spf13/pflag/bool.go` | `52807d740167c62c8dfd2cc5ab16ff2ae3834d5f0e78573b190aaa89b960ac16` | Boolean `NoOptDefVal=true`, including explicit `=false`                              |

[Immutable source tree](https://github.com/docker/cli/tree/f52814d454173982e6692dd7e290a41b828d9cbc).

Comparison against the old sets found **five**, not two, missing value flags:
`net`, `net-alias`, hidden `dns-opt` (alias of `dns-option`), and Windows flags
`io-maxbandwidth`, `io-maxiops`. No old value flag was extraneous in the union of
run/create. All 10 value-taking short flags were present, but boolean shorts,
explicit short `=value`, command-specific validity and global flags were not
modeled. Run-only `detach-keys` must not silently apply to create. Deprecated
`kernel-memory` remains registered and value-taking in this exact upstream version.

Additional independently reproduced bypasses on the unchanged parent helper:
`--dns-opt timeout:3`, `--io-maxbandwidth 1024`, `--io-maxiops 100`, each followed
by `--name URL-27 alpine`; `--entrypoint "" --name URL-27 alpine` (lexer discarded
empty quoted arguments); `docker --context build run --name URL-27 alpine`.
Each returned zero findings. Unknown `--not-a-v29-option value` also silently
hid a subsequent name. These are lexical/grammar classification defects, not
resource-specific exceptions. No runtime command was run to reproduce them.

## Bounded strategy proposed before coding

Replace the guessed set with a **source-pinned complete registry** for this CLI
version, including common, command-specific and root phases, boolean/value arity
and case-sensitive short aliases. Preserve quoted empty argv words. Parse option
boundaries without evaluating values, validating daemon semantics or executing
anything. Unknown/missing option grammar must produce a visible **manual-review
diagnostic**, not a guessed IMAGE and silent pass. Keep parsed names distinct
from grammar diagnostics; the latter do not claim a resource violates naming.

Tradeoffs: finite offline data is reproducible and audits all v29.1.3 spellings;
it cannot promise support for future Docker/plugin flags or arbitrary shell
evaluation. An upgrade/unknown flag requires source-backed review and matrix
updates, not an identifier allowlist. Full shell interpretation/daemon-based
discovery would violate the task boundary and is rejected. A pinned registry
plus unknown-grammar failure is safer than adding aliases indefinitely or
silently assuming every unknown option is boolean.

### Complete supported argv grammar

- Recognized direct command: optional literal leading assignments/simple `sudo`,
  `docker` (or literal path ending `/docker`), root flags, optional `container`,
  `run`/`create`, command flags, IMAGE, payload. Global `-c/-l/-v/-h` have their
  root meanings before the verb; after it they mean CPU shares/label/volume/hostname.
- Required-value long flag: `--flag value` or `--flag=value`; a separate value is
  consumed **even if empty, `--`, or flag-looking**. Values are not expanded/read.
- Boolean: bare `--flag`/`-f` consumes no following word (NoOptDefVal); `=value`
  consumes the rest of that token. Boolean/type/API/platform value validation is
  outside this lexical naming check, not asserted as Docker acceptance.
- Shorts are case-sensitive, may cluster; a value-taking short consumes its
  attached remainder (`-p8080:80`, `-p=8080:80`) or one following word (`-itp value`).
  A boolean's explicit `=value` ends its cluster; it is never reinterpreted as flags.
- First non-option word (including an empty quoted word) ends the phase; command
  phase stops at IMAGE, never scans payload. `--` terminates options unless
  consumed as a required value. Root phase ends at the command, not its arguments.
- Unsupported/unknown creation grammar requires manual review, not runtime calls.
  Other Docker verbs remain outside the container-creation naming extractor.
  Complex wrappers/substitution, Docker flags between `container` and the verb,
  arbitrary shell control flow and newer CLI versions remain explicitly unproved.

### Complete frozen source registration ledger

This independent audit ledger is checked against the production registry in
tests. `name/short@line`; names without `/short` have no shorthand. `common`
comes from opts.go; `run`/`create` from their corresponding files. Root entries
come from options.go except help@52 (cobra.go) and version@162 (docker.go).
Types were determined from registration calls, not guessed from help visibility.
Hidden aliases remain valid. Counts: common **88 value + 9 boolean**; run adds
**4 + 6** → **107**; create adds **3 + 4** → **104**; root **7 + 5** → **12**.

<!-- BEGIN DOCKER SOURCE LEDGER -->

```text
common value attach/a@187 device-cgroup-rule@188 device@189 gpus@190 env/e@192 env-file@193 entrypoint@194 group-add@195 hostname/h@196 domainname@197 label/l@199 label-file@200 restart@202 stop-signal@203 stop-timeout@204 sysctl@206 ulimit@208 user/u@209 workdir/w@210 cap-add@214 cap-drop@215 security-opt@217 userns@218 cgroupns@219 add-host@227 dns@228 dns-opt@231 dns-option@232 dns-search@234 expose@235 ip@236 ip6@237 link@238 link-local-ip@239 mac-address@240 publish/p@241 net@244 network@245 net-alias@248 network-alias@249 log-driver@253 volume-driver@254 log-opt@255 storage-opt@256 tmpfs@257 volumes-from@258 volume/v@259 mount@260 health-cmd@263 health-interval@264 health-retries@265 health-timeout@266 health-start-period@267 health-start-interval@269 blkio-weight@274 blkio-weight-device@275 cidfile@276 cpuset-cpus@277 cpuset-mems@278 cpu-count@279 cpu-percent@281 cpu-period@283 cpu-quota@284 cpu-rt-period@285 cpu-rt-runtime@287 cpu-shares/c@289 cpus@290 device-read-bps@292 device-read-iops@293 device-write-bps@294 device-write-iops@295 io-maxbandwidth@296 io-maxiops@298 memory/m@300 memory-reservation@301 memory-swap@302 memory-swappiness@303 oom-score-adj@305 pids-limit@306 cgroup-parent@309 ipc@310 isolation@311 pid@312 shm-size@313 uts@314 runtime@315 annotation@320 kernel-memory@325
common boolean interactive/i@198 read-only@201 tty/t@207 rm@211 privileged@216 publish-all/P@242 no-healthcheck@271 oom-kill-disable@304 init@317
run value name@62 detach-keys@63 pull@64 platform@73
run boolean detach/d@60 sig-proxy@61 quiet/q@65 use-api-socket@66 help@70 disable-content-trust@77
create value name@73 pull@74 platform@84
create boolean quiet/q@75 use-api-socket@76 help@81 disable-content-trust@89
root value config@119 log-level/l@121 tlscacert@124 tlscert@125 tlskey@126 host/H@130 context/c@131
root boolean debug/D@120 tls@122 tlsverify@123 help/h@52 version/v@162
```

<!-- END DOCKER SOURCE LEDGER -->

Planned regression matrix: every ledger entry on its applicable command, canonical
and hidden aliases, separate/equals/empty/flag-looking values, boolean bare/equals,
short separate/attached/equals/cluster forms, root versus command scope, real
names versus harmless payload/prose, unknown grammar and missing values. Helper
and real CLI must agree; batch real-CLI fixtures avoid thousands of Node startups.
Existing R1–R5 and all compatibility tests remain required. No names, resources,
runtime configuration, Jira, deployment or parent PR branch changes are authorized.

## Implementation and executed verification

The pre-code proposal above was reported to Michael before implementation.
Implemented the bounded strategy in `scripts/docker-option-grammar.ts`, with
the shell lexer retaining empty quoted words. The checker now distinguishes
forbidden identifier findings from **manual-review grammar diagnostics** in both
individual messages and summary counts; either blocks the command with exit 1.
Unknown creation flags are not silently blessed or guessed to be booleans.
No Docker executable is called to resolve grammar or values.

`tests/unit/docker-option-grammar.test.ts` independently parses this frozen
source ledger and compares every production long name, shorthand, arity and
phase membership. A registry omission, including a hidden alias, fails that
completeness test. The **1,984-case matrix** is built from the audit ledger, not
the production registry. Every case is exercised through the helper and again
as a separate file in one batched **real CLI** Git fixture, with expected
diagnostic paths/types and unchanged fixture contents checked. Batching avoids
1,984 Node startups; it does not skip the real file enumeration/CLI path.

The matrix covers all common/run/create/root flags, both canonical and hidden
alias entries, separate/equals/empty/flag-looking required values, booleans,
short forms/clusters/attached values, IMAGE/payload boundaries, real names,
harmless prose and explicit unknown/incomplete grammar. The reported alias cases
are also covered as workflow scalars and blocks. All **168 inherited tests**
remain unchanged, including R1–R5, legitimate numbers and exact legacy exceptions.

### Red proof on the parent, not a claim that green CI meant acceptance

Replayed the new matrix in a disposable local fixture with the **unchanged
parent checker** from `775c130c482e9b7397ab2ddd3dc53aec7c97f51b`. Only the
fixture's checker was replaced, never PR #11's branch. `npm ci` exited **0**;
`npx vitest run tests/unit/docker-option-grammar.test.ts` exited **1**:
**536 failed / 1,450 passed (1,986 tests)**. This detects the systematic missing
arity/empty/global/unknown behavior, not merely the two exact aliases.

### Final-tree results (2026-11-04)

Executed in the isolated implementation checkout and repeated in a **clean
local Git clone** of the final staged snapshot, with no ignored `.opencode`
profiles. Candidate exported via `git checkout-index`, committed only in a
disposable verification fixture and cloned with `git clone --no-hardlinks`.
This verification requires no remote push, Docker, DB or cloud access.

| Command                                                                                    | Actual exit / result                                                             |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `npm ci`                                                                                   | 0                                                                                |
| `npm run check:naming`                                                                     | 0                                                                                |
| `npx vitest run tests/unit/naming-policy.test.ts tests/unit/docker-option-grammar.test.ts` | 0 — **2,154 passed**, two files                                                  |
| `npm run lint`                                                                             | 0                                                                                |
| `npm run typecheck`                                                                        | 0                                                                                |
| `npm run test:coverage`                                                                    | 0 — **2,306 passed / 10 existing DB tests skipped**, 20 files passed / 1 skipped |
| `npm run build`                                                                            | 0                                                                                |
| `git diff --check`                                                                         | 0                                                                                |

Formatting exited 0; clean-clone working tree remained clean. Coverage thresholds
and the existing `src/**` instrumentation scope are unchanged; percentages from
that suite are not claimed as checker source coverage. The new grammar suite
has 1,986 tests: source-ledger completeness, 1,984 helper cases and a complete
batched CLI replay. HTTP proxies are poisoned in the CLI fixture; it runs only
Node/the checker and local Git, never the text of a scanned command.

### Preserved scope and next gate

Four files change: checker, new grammar module, new grammar tests and this
investigation/evidence report. The prior test file, SQL/YAML behavior, compatibility
registry and single-occurrence/path restrictions, normative policy/root
instructions, package/dependencies/CI gate, approved specifications, backup
script/systemd units, runtime configs, resource/data/volume/backup identities and
connection strings remain unchanged. No Jira, runtime inventory, resource
operation, schedule, installation, deployment, merge or self-approval occurred.

This report is developer evidence, not a Dwight verdict or Pam post-merge QA.
All earlier FAIL verdicts remain historical failures on their exact heads; no
parent PR branch is modified or review thread resolved here. The new corrective
PR targets `fix/naming-resource-boundaries` (PR #11) and must receive a new
exact-head Dwight review through his assigned session. A CLI upgrade requires
new source comparison and matrix evidence, not a silent registry edit.

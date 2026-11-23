# Local coordinator implementation evidence

Ryan implementation report for URL-32, 2026-11-22 through 2026-11-23. The initial
incomplete and disk-blocked reports are preserved as history; the resumed-check
section records current implementation evidence. This is neither Pam QA nor
final Jira acceptance evidence. The authorized review PR does not authorize a
Jira mutation, fixture activation, deployment, merge or production operation.

## Authority and provenance

- Isolated checkout: `/tmp/opencode/url32-local-reconciliation-stop`.
- Branch: `feature/URL-32-local-reconciliation-stop`; additions remain uncommitted.
- Verified remote main/base: `484b801f24406e1644d6f5c90157be032504d4b0`.
- Verified tree: `7e46ba989fcb53d3576d1761af156d725c88f0ec`.
- Read-only GitHub check: `gh api repos/roy-melamed/url-shortener-api/commits/main --jq '{sha,tree:.commit.tree.sha}'`, exit 0; base/tree matched before continuing edits.
- Complete authorized Jira description transfer was compared against the full
  governing documents before coding. No Jira API operation was performed here.
- Governing documents under the approved external specification tree were
  rehashed unchanged with `sha256sum` (exit 0):
  - reconciliation work item v5: `649b0b66104a4630540223237fbfdade863037eddf68e6b3c09579bde82d9e4d`;
  - stop/expiry requirements v9: `fcfefeda98d1fff5b38d11db89634a2dc9417f6b6c461e689059c8b46efa8f5e`;
  - stop/expiry design v1: `0c90b9253c648fcfd5d7441c85ba54d27a4ae28529fbaf9f1f71028cf4144052`.

No old daemon/helper was copied or imported. Existing resource names, connections,
backup configuration and historical approvals were not modified. Semantic naming
review: new domain-purpose names describe local coordination and disposable
journaling; no ticket-derived durable identifiers or resource migrations.

## Files

- `tools/local-coordinator/src/local_coordinator/{__init__,core,journal,control}.py`
- `tools/local-coordinator/README.md`
- `tests/local-coordinator/{fixtures,test_core,test_control,test_isolation_recovery}.py`
- `tests/unit/local-coordinator.test.ts`
- This evidence document.

## Actual commands and results

Commands ran in the isolated checkout. Raw local logs are under
`/tmp/opencode/url32-*.log`; no logs were uploaded. These summaries are suitable
for a future GitHub review but do not bind an uncommitted tree to a PR head.

- `npm ci --offline --ignore-scripts --no-audit --no-fund`: exit 0; 333 packages
  from cache, lockfile unchanged, no lifecycle scripts; `url32-install.log`.
- `PYTHONPATH=tools/local-coordinator/src python3 -B -m unittest discover -s tests/local-coordinator -v`:
  exit 0; 36 tests, 11.777s, OK; `url32-focused.log`.
- `npm test`: exit 0; 40 files passed, 2 skipped; 2685 tests passed, 28 skipped;
  `url32-npm-test-final.log`.
- `npm run lint`: exit 0; `url32-lint-final.log`.
- `npm run check:naming`: exit 0, zero violations; `url32-naming-final.log`.
- `npm run typecheck`: exit 0; `url32-typecheck-final.log`.
- `npm run build`: exit 0; `url32-build-final.log`.
- `npm run format:check`: exit 0 before docs; `url32-format-final.log`.
  Documentation-inclusive run initially exited 1 for Markdown table formatting
  (`url32-format-docs.log`); the table was replaced with this list before rerun.
  Documentation-inclusive rerun exited 0 (`url32-format-docs-rerun.log`).
- `npm run check:watcher-offline`: exit 0; `url32-watcher-check.log`.
- `npm run test:watcher-offline`: exit 0; `url32-watcher-test.log`.
- `git diff --check`: exit 0; tracked changes only. New untracked files were
  separately parsed/formatted.
- `python3 -B -m coverage --version`: exit 1; coverage CLI unavailable, not success.
- `PYTHONPATH=tools/local-coordinator/src python3 -B -m trace --count --summary --missing --coverdir /tmp/opencode/url32-python-coverage --module unittest discover -s tests/local-coordinator -v`:
  exit 0; 36 tests, 24.237s, OK; `url32-python-coverage.log` and annotated files.

Exact syntax check (exit 0; eight Python files parsed, no bytecode):

```sh
python3 -B - <<'PY'
import ast
from pathlib import Path
paths = sorted(Path('tools/local-coordinator/src').rglob('*.py')) + sorted(Path('tests/local-coordinator').glob('*.py'))
for path in paths:
    ast.parse(path.read_text(), filename=str(path))
print(f'Parsed {len(paths)} Python source/test files; no bytecode written')
PY
```

Earlier executed failures are retained: initial parallel lint exited 2 and format
check exited 2 because tests created/removed temporary directories under the repo
while scanners traversed them. A later format check exited 1 for the new TS bridge.
Tests now use sibling disposable roots and bridge formatting is corrected; final
lint/format runs exited 0. No checker, test requirement or exclusion was weakened.

Node was `v24.21.0`; Python uses SQLite `3.45.1` with no-checkpoint-on-close support.
Repository V8 coverage: statements 97.13% (847/872), branches 97.43% (607/623),
functions 96.63% (201/208), lines 97.73% (776/794). This covers the configured
TypeScript source, **not Python**. Separate stdlib trace line summaries: core 97%,
journal 98%, control 96%; these are rounded trace estimates, not branch coverage
or proof that all acceptance cases pass. Existing PostgreSQL/MailHog-dependent
tests were skipped by repository configuration, not executed or waived as passed.

## Executed local evidence

Fixtures use fixed UTC start `2026-11-22T00:00:00Z`, explicit mock issue/run/opaque
credential-reference allowlists, hash actual module sources, and inject the v9
policy digest. Scope/config are synthetic, not real fixture or role identity.

The 36-test suite exercises disabled startup/reopen, exact expiry and clock faults,
union/dependency planning, synthetic evidence correlation, replay and transient
5/30/120-second rules, fourth-attempt denial, atomic declared caps, concurrent
clients against halt, stale generations/fences/completions, stop quota/fsync/storage
faults, real hung gate/delayed persistence, 30-minute timeout, corruption/WAL
preservation through close, verified backup/selected-snapshot union rollback,
quarantine, import capability denial and isolation/privacy. Crash probes execute
before/after claim, reconciliation, completion and retry commits. The recovered
facade remains disabled. Sink restore/dispatch counters remain zero.

Observed rollback scenario: snapshot disabled epoch 0; arm and complete a mock
operation; halt increments epoch; restore the older selected snapshot into a new
candidate; union retains the current epoch, completed operation, attempts, charges,
deadline and stop evidence. Tests compare original DB/WAL and selected snapshot
bytes before/after; only candidate audit gains the rollback event.

## Initial local gaps — historical, superseded by the gap recheck below

Passing current regressions does not establish complete AC-COORD-LOCAL-1..6 or
AC-STOP-1..11. In particular:

1. Low-level `claim` is not yet strictly bound to a currently eligible persisted
   plan/dependency verdict. It can be invoked for an allowlisted issue without
   first reconciling its dependencies. This must be closed and negatively tested.
2. The fresh read-only stop verifier checks state/hash/epoch, reservations and
   operation states, but does not yet generate/persist the complete independent
   verifier receipt with a denied-admission probe and exact source binding.
3. `invoke` exposes only halt/inspect. Snapshot/rollback/revoke-plan methods exist,
   but the complete reviewed request-ID/idempotency command contract is unfinished.
4. The acceptance fault matrix is not exhaustive: all stop fsync/cancellation/
   receipt crash cut points, overflow/incomplete migration, cold-process restart,
   and all revocation ambiguity branches still need explicit tests. Concrete sink
   records remain mutable Python lists, not an independently protected audit log.
5. No immutable implementation head, reviewed PR, required hosted CI results or
   Pam exact-merged-main verification exists. Evidence must be rerun/bound to the
   completed artifact before a PR handoff. No technical PASS is claimed.

These are local engineering work, not a request to waive criteria or obtain new
product authorization. All work is preserved for continuation; no PR was created.
Out-of-scope live adapters, actual custody/provider expiry/revocation, entitlement,
resources/quota/$0/30-day retention, owner authentication, GATE-0, service
activation and production release remain blocked/unexecuted. Mock success cannot
substitute for any of them.

## Gap recheck — implementation and regression traceability

The requested local gaps have corresponding implementation changes and executed
negative regressions. This is Ryan's local evidence, not a technical-review,
hosted-CI, post-merge Pam or operational PASS. No external write or PR was made.

Current inventory adds `src/local_coordinator/verifier.py` under the tool package
and `tests/local-coordinator/test_gap_regressions.py`. All work remains in the
same isolated checkout/branch; no existing user work was reverted or removed.

### Closed gaps

1. **Persisted eligible claims:** `plan` persists the complete injected snapshot
   and current lease with transactional eligibility/rejection reasons. `claim`
   requires a matching PLANNED record under the current lease and recomputes
   dependency eligibility in the same transaction that reserves capacity. Effects
   and completions recheck the exact dependency-closure hash. Scope changes,
   missing/blocked/cyclic dependencies, stale plans, changed stage/fingerprint and
   restart leases cannot admit work. Rejected issue-local plans leave unrelated
   eligible work processable. Reservation replays cannot switch run/cost inputs;
   retry WAIT cannot be bypassed through direct effect initiation.
2. **Independent read-only verifier:** `verifier.verify_stop` opens a fresh
   read-only connection without a writer/broker/sink capability, checks durable
   epoch/state, cancelled queues, inactive reservations, revoked handles, scope
   plan and retained digest. It computes the actual package-source digest rather
   than trusting a caller's source label. `inspect` performs an actual denied
   claim probe and checks unchanged journal/sink hashes. The separately generated
   receipt binds source/policy/config, fixture/session/generation, state hash and
   probe; halt persists it in a bounded stop-audit transaction before reporting
   LOCAL_STOPPED. Any failed phase remains BLOCKED. Scope plans persist all exact
   injected target IDs, start/deadline, nominated operator and fixed planned
   disable/revoke operations; no provider operation is executed.
3. **Control contracts:** halt/inspect/snapshot/rollback/revoke-plan all have
   exact options validation and injected caller/root/fixture boundaries. Every
   mutating command uses UUID request IDs; identical completed requests replay
   their receipts and conflicting/cross-command reuse blocks. Inspect is
   deliberately read-only and has no request ID in the approved shape. Snapshot
   and revocation receipts are durable in the original journal. Rollback receipts
   are durable only in the request-bound new candidate, so rollback leaves the
   original DB/WAL/snapshot bytes unchanged. Explicit candidate capabilities
   cannot be replaced with arbitrary live paths. No CLI/listener or enable/unlock
   command was added. Incomplete commands block rather than reset a candidate.
4. **Fault tests:** fifteen before/after commit/fsync cuts cover the disable,
   quiescence and verifier-receipt transactions; three additional crash cuts
   cover before/after cancellation and after verifier generation. Reopen stays
   disabled with attempts/charges retained. Overflow, incomplete migrations,
   ACL mismatch, cold-interpreter reopen after closing the original connection,
   cached-handle denial and provider-ambiguity simulation have explicit tests.
   Rollback rejects ambiguous claims and altered/unregistered snapshot metadata.
   Prior hung-gate/delayed-fsync tests remain enabled, including the real
   five-second wait; no timing/test requirement was weakened.
5. **Audit sink mutation:** exposed initiation/read records are tuples with
   read-only properties and no mutable public dictionary; restore/dispatch
   counters cannot be reassigned. Tests reject append/reassignment and preserve
   the prior record. Private internals are not a security boundary against
   malicious same-UID/root code, and no such protection is claimed.

### Acceptance matrix

- **AC-COORD-LOCAL-1:** `test_union_stuck_unchanged_missing_and_dependency_isolation`,
  union/reopen control tests, persisted-plan and issue-local isolation regressions.
- **AC-COORD-LOCAL-2:** journal reopen/WAL/corruption tests, dependency hash checks,
  complete-snapshot rejection, incomplete migration and immutable-history checks.
- **AC-COORD-LOCAL-3:** replay and claim/reconciliation/completion/retry crash tests;
  exact 5/30/120 timing, fourth-attempt rejection and direct-effect WAIT denial.
- **AC-COORD-LOCAL-4:** core positive/negative evidence predicates, source/session/
  operation-token correlation and pending/stale/missing/cancelled CI regressions.
- **AC-COORD-LOCAL-5:** protected-gate dry-run rejection, failed-QA preservation,
  completion idempotency and zero operational transition/dispatch/restore calls.
- **AC-COORD-LOCAL-6 / AC-STOP-1:** denied import capabilities (including verifier),
  disabled startup, scope isolation and privacy tests; only explicit disposable
  initialization creates local state.
- **AC-STOP-2 / AC-STOP-3:** validated SQLite/audit state, overflow/migration/ACL/
  storage failures, fresh leases and both in-process and cold-process reopening.
- **AC-STOP-4 / AC-STOP-5:** stop request replay/conflicts, two-client admission
  races, bounded timeout/fault matrix, fresh source-bound verifier, denied probe,
  inactive leases and no new normal writes/reads/effects after disable/restart.
- **AC-STOP-6:** exact deadline branches and clock faults in core/control tests,
  one-second injected watchdog cadence, unknown/future trusted timestamp denial,
  terminal state preservation and no deadline/budget reset on restart.
- **AC-STOP-7 / AC-STOP-9:** independently verified expiry scope plan, all three
  opaque-reference provider plan shapes, revoked-handle tombstones/cached denial,
  synthetic 401/403/404/missing/unknown/failed-final ambiguity predicates. External
  verdicts always remain BLOCKED_UNEXECUTED with zero retry/provider call.
- **AC-STOP-8:** committed-WAL backup, registered snapshot hashes/metadata,
  selected-snapshot restore plus authoritative audit suffix, new disabled
  candidate, request replay and original byte preservation; ambiguous/invalid
  recovery quarantines both copies rather than erasing evidence.
- **AC-STOP-10 / AC-STOP-11:** persisted attempt/budget/cap checks, crash/reopen,
  no fourth attempt, 30-minute timeout, quota/storage exhaustion with stop priority
  and no refund/reset. These are declared mock reservation units, not provider
  quotas, actual runner billing or aggregate external fixture-count proof. No
  required suite or case was omitted to fit a claimed cap.

No local result establishes account authority, independently protected custody,
provider expiry/revocation, actual quotas/$0/30-day archival, GATE-0, hosted CI,
technical review, Pam acceptance or production readiness. Those external/review
gates remain unexecuted; no role, permission, release or historical approval was
changed. The implementation tree is still uncommitted; any future review must
bind an immutable exact head and rerun required checks on that revision.

### Historical disk-blocked recheck (2026-11-22)

**BLOCKED / no PR:** the latest full `npm test` attempt exited **1**. It ran
39 passing files, one failing file and two skipped files: **2684 tests passed,
one failed, 28 skipped** (97.68s). The existing backup mock harness in
`tests/unit/backup-units.test.ts` failed its real staging-space preflight:
`1107693568` bytes free was below the unchanged required reserve `1140850688`
bytes (`2 * 536870912 + 67108864`). Raw evidence:
`/tmp/opencode/url32-gaps-npm-test.log`. This is not a coordinator assertion
failure, but it is a failed required repository check, not a PASS or waiver.

No reserve, limit, test, fixture count or checker was reduced; no pre-existing
artifact/worktree was deleted. Further full-suite execution requires sufficient
real staging capacity above that reserve, with working headroom. No unauthorized
cleanup, resource change or blind same-condition retry was attempted.

The final source additionally rejects truthy non-boolean quiescence confirmation;
the focused suite and static checks below were rerun after that hardening. The
full repository suite has **not** been rerun on that final change because the
measured capacity blocker remains. Earlier green full-suite/V8 numbers above are
historical and do not certify the final tree. Final full-suite coverage is not
available and no successful final coverage gate is claimed.

Final focused/static results (each named command actually executed):

- `PYTHONPATH=tools/local-coordinator/src python3 -B -m unittest discover -s tests/local-coordinator -v`:
  exit **0**, **52 tests passed**, 22.168s; `url32-gaps-focused-final.log`.
- `npm run lint`: exit **0**; `url32-gaps-lint.log`.
- `npm run check:naming`: exit **0**, zero violations; `url32-gaps-naming.log`.
- `npm run typecheck`: exit **0**; `url32-gaps-typecheck.log`.
- `npm run build`: exit **0**; `url32-gaps-build.log`.
- `npm run format:check`: exit **0**; `url32-gaps-format.log` (rerun including
  this final evidence update).
- The exact `ast.parse` syntax command printed earlier: exit **0**, ten Python
  files parsed with no bytecode; `url32-gaps-syntax.log`.
- `npm run check:watcher-offline`: exit **0**; `url32-gaps-watcher-check.log`.
- `npm run test:watcher-offline`: exit **0**; `url32-gaps-watcher-test.log`.
- `git diff --check`: exit **0**; untracked additions remain separately checked
  by syntax/formatting and the source manifest.
- `PYTHONPATH=tools/local-coordinator/src python3 -B -m trace --count --summary --missing --coverdir /tmp/opencode/url32-gaps-python-coverage --module unittest discover -s tests/local-coordinator -v`:
  exit **0**, **52 tests passed**, 19.516s; `url32-gaps-python-coverage-final.log`.
  Rounded stdlib trace line estimates: core **97%**, control **97%**, journal
  **96%**, verifier **100%**. These are not branch coverage or operational proof.

A final read-only remote-main check still returned the exact approved base/tree.
The tested final package-source digest is
`50abfce9850cbe1cf18721d9c81a13f447b776a5c24e9b0c9f955657b2f2592e`
(canonical JSON list of sorted package `.py` source text, SHA-256). Individual
source/test SHA-256 values are preserved in
`/tmp/opencode/url32-gaps-manifest-final.log`; this is a source manifest, not a
Git commit or authenticated approval.

Representative executed fixture from the final focused log (removed only by its
own test cleanup, not an external fixture):

- Root: `/tmp/opencode/coordinator-tests-s36bfp3j/coordinator-mock-cdne7y39`.
- Selected snapshot: sibling `coordinator-mock-tw7fmj3u`.
- Candidate: sibling `coordinator-recovery-beb6d4433ca4b421407a74045ef602a4b6cfdadc11f8140df292e94816fec688`.
- Synthetic issue/fixture: `mock-issue` / `mock-fixture`; fixed UTC seed recorded
  above; generation **1**, claim epoch **0**, stop epoch **1**.
- Operation: `6a8e42306093bbe81fb417b2447bcfd5ee85d35f8b1ec92e1c21f94670f19621`.
- Snapshot digest: `7c54df2d59d883cf0c993b63a029e9eea5cd456331aa714a46112f3a8125e0ae`.
- Restored audit tail: `4e42da9a9bde5e7e8bb83defb04c65bab99b6083c401323a6ab5e6456421d70f`.
- Independent mock-verifier receipt hash:
  `5455759cc9dcb3e352b83598825e1313f4cc5019ed886b4370a16d03fabf4ecf`.

All new files remain uncommitted and preserved. The requested local gaps now have
implementation/regression evidence, but required all-green final verification is
**not achieved**. Stop here without a PR; restore safe disk capacity and rerun the
full required suite before any readiness/review handoff. No operational, CI,
technical-review or Pam acceptance PASS is asserted.

## Resumed required checks after safe disk recovery (2026-11-23)

The Product Owner reported cache-only cleanup (npm, pip and apt archives) without
touching repositories/worktrees, agent state, databases/backups, Docker volumes or
uncommitted code. Ryan performed no cleanup. Initial independent verification:

- `pwd`: `/tmp/opencode/url32-local-reconciliation-stop`.
- `df -B1 /`: **2304028672 bytes available**, above the unchanged backup reserve
  **1140850688 bytes**. No reserve or preflight bypass was changed.
- `git status --short --branch`: branch
  `feature/URL-32-local-reconciliation-stop`; only the thirteen intended new
  implementation/test/evidence files were untracked; no tracked edits.
- `git rev-parse HEAD HEAD^{tree}`: base
  `484b801f24406e1644d6f5c90157be032504d4b0`, tree
  `7e46ba989fcb53d3576d1761af156d725c88f0ec`.
- `git worktree list`: the isolated checkout was still bound to that branch/base.
- `gh api repos/roy-melamed/url-shortener-api/commits/main --jq '{sha,tree:.commit.tree.sha}'`:
  exit **0**, remote main still matched both pinned values.
- Governing v5/v9/design-v1 SHA-256 values were independently rehashed with
  `sha256sum` and still matched the authority section above. No specification
  was edited and no operational daemon was imported or copied.

### Executed command outcomes

All commands ran from the isolated checkout, with real repository configuration
and default test selection. No source/test changes were needed after recovery.
Raw sanitized logs are under `/tmp/opencode/url32-resumed-*.log`.

- `npm test`: exit **0**, **2685 tests passed, 28 skipped**; **40 files passed,
  two skipped**; 100.71s. Includes coverage and the unchanged full backup mock
  harness; `url32-resumed-npm-test.log`. Skipped PostgreSQL/MailHog-dependent
  cases remain unexecuted, not passed; no new skip or waiver was introduced.
- `npm run lint`: exit **0**; `url32-resumed-lint.log`.
- `npm run typecheck`: exit **0**; `url32-resumed-typecheck.log`.
- `npm run build`: exit **0**; `url32-resumed-build.log`.
- `npm run check:naming`: exit **0**, zero declaration violations;
  `url32-resumed-naming.log`. Semantic review confirmed descriptive local names,
  no ticket-derived durable resources and no compatibility/resource migration.
- `npm run format:check`: exit **0**; `url32-resumed-format.log`; also rerun after
  updating this report/README before commit.
- `npm run check:watcher-offline`: exit **0**, nine files, zero findings;
  `url32-resumed-watcher-check.log`.
- `npm run test:watcher-offline`: exit **0**, **62 tests passed**;
  `url32-resumed-watcher-test.log`.
- `PYTHONPATH=tools/local-coordinator/src python3 -B -m unittest discover -s tests/local-coordinator -v`:
  exit **0**, **52 tests passed**, 30.184s; `url32-resumed-focused.log`.
- Python syntax: the exact `ast.parse` command below exited **0**, **ten files**
  parsed without bytecode; `url32-resumed-syntax.log`.
- `git diff --check`: exit **0**; `url32-resumed-diff-check.log`; staged additions
  are also checked with `git diff --cached --check` before commit.

```sh
python3 -B - <<'PY'
import ast
from pathlib import Path
paths = sorted(Path('tools/local-coordinator/src').rglob('*.py')) + sorted(Path('tests/local-coordinator').glob('*.py'))
for path in paths:
    ast.parse(path.read_text(), filename=str(path))
print(f'Parsed {len(paths)} Python source/test files; no bytecode written')
PY
```

The fresh V8 coverage result is statements **97.13% (847/872)**, branches
**97.43% (607/623)**, functions **96.63% (201/208)** and lines
**97.73% (776/794)**. These are configured TypeScript source coverage, not Python
coverage or operational acceptance. The source digest and acceptance matrix above
bind the separately executed Python regressions; no live capability or provider
revocation was tested. Existing watcher and backup modules were not modified.

Additional fresh Python coverage command:
`PYTHONPATH=tools/local-coordinator/src python3 -B -m trace --count --summary --missing --coverdir /tmp/opencode/url32-resumed-python-coverage --module unittest discover -s tests/local-coordinator -v`:
exit **0**, 52 tests, 19.176s; `url32-resumed-python-coverage.log`. Rounded trace
line estimates remain core **97%**, control **97%**, journal **96%**, verifier
**100%**; these do not measure branch coverage or prove operational safety.

Staged payload identity, computed with `git write-tree` followed by
`git rev-parse <index-snapshot>:<path>` (exit **0**):

- Package source subtree `tools/local-coordinator/src/local_coordinator`:
  `7009838518c0767babb9ae18368d7ae36c2b7ab9`.
- Python test subtree `tests/local-coordinator`:
  `5eb236b31cb1a4d1482e036e67761cf1e0cdd5b0`.
- Vitest bridge blob `tests/unit/local-coordinator.test.ts`:
  `b586b2c2206d844955bdef215b5ce2030e03eff1`.
- Package SHA-256 source digest is unchanged:
  `50abfce9850cbe1cf18721d9c81a13f447b776a5c24e9b0c9f955657b2f2592e`.

Only documentation changed after the resumed test executions. Final staging and
formatting checks include those documentation changes; no generated output,
dependency, cache, database or host-service file is included in the commit.

The disk blocker is resolved for this resumed run. The local slice and its
requested gap regressions are ready for an exact-head review PR, not merge or
operational acceptance. The containing Git commit/full tree and PR URL are bound
in the PR description after creating the commit, avoiding a self-referential
commit/tree hash inside this evidence file. Required hosted CI, Dwight's actual
exact-head review, Michael's verified merge, Pam's exact-merged-main QA and human
acceptance/release gates remain separate and are not asserted here.

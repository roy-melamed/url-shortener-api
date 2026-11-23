# Final mock admission boundary — URL-32 F1 correction

Ryan local implementation evidence, 2026-11-23. Not Dwight's technical verdict,
Pam QA, operational acceptance, provider authorization or merge approval.

## Authority, original finding and branch isolation

The Product Owner authorized a **new corrective PR**, retaining the original
implementation plus this local correction. No live adapter, provider call,
credential, activation, deployment, Jira operation or merge is authorized.

- Current main/base independently verified:
  `484b801f24406e1644d6f5c90157be032504d4b0`, tree
  `7e46ba989fcb53d3576d1761af156d725c88f0ec`.
- Original implementation commit retained unchanged:
  `25e2c831e74d712f4bb6f53a830563a013ddb187`; its parent is the exact base above.
- Corrective branch: `feature/URL-32-final-admission-expiry`, in the existing
  isolated checkout `/tmp/opencode/url32-local-reconciliation-stop`. It was
  forked at the retained implementation commit without reset, amend or loss of
  uncommitted work. The new PR contains both implementation and correction.
- [Original PR #36](https://github.com/roy-melamed/url-shortener-api/pull/36)
  remains unmerged and unpatched. Its technical FAIL and unresolved historical
  finding are not relabelled as passed or resolved by Ryan.
- [Dwight's durable review](https://github.com/roy-melamed/url-shortener-api/pull/36#pullrequestreview-6018107178)
  and [blocking F1 thread](https://github.com/roy-melamed/url-shortener-api/pull/36#discussion_r4663044273)
  describe the exact-head reproduction. Read the complete review and local log
  `/tmp/opencode/pr36-dwight-independent-probes.log`. Original source digest:
  `50abfce9850cbe1cf18721d9c81a13f447b776a5c24e9b0c9f955657b2f2592e`.

Governing reconciliation v5, stop/expiry v9 and design v1 are unchanged. Their
full authority/hashes and original implementation evidence remain in
[`local-coordinator-implementation-evidence.md`](local-coordinator-implementation-evidence.md).

## Root cause and correction

The old `_guard` time sample occurred before `_fence` and dependency validation.
The journal gate serialized broker writes but did not stop the injected clock
advancing during validation. At fixture/provider equality the old sink could
still record a new effect/read; a later watchdog noticed expiry too late. Green
old tests and CI did not cover that interval.

The correction retains the journal gate and transaction, then:

1. Performs the existing full fence/dependency and eligibility validation.
2. Acquires the explicit mock clock's admission lock at the final sink boundary.
3. Revalidates admission/lease, boot, UTC/monotonic validity, all applicable
   fixture/credential deadlines and job reservation timeout.
4. Records the mock initiation/read while still holding that clock lock and the
   journal gate. `MockClock.advance()` and direct fault-injection field writes
   participate in the same lock; neither can cross the final sample-to-record
   interval. No callback/live effect adapter was introduced.

If the deadline is reached during validation, the final guard closes admission,
rolls back the normal transaction and uses the **existing** stop primitive to
persist terminal EXPIRED, invalidate leases/handles and verify quiescence. No
sink initiation/read occurs, and no later watchdog is needed. Job timeout is
resampled too and uses the existing STOPPED/recovery path. Stop remains bounded
to five seconds or reports BLOCKED; no quota, history, attempt or lease safeguard
was relaxed. Locks are created only by explicit mock initialization, not import.

This is synchronization of a concrete trusted disposable fake, not protection
against malicious same-UID Python reflection, a freeze of host/provider time,
authenticated identity, external cancellation or operational stop certification.

## Deterministic regression matrix

`tests/local-coordinator/test_admission_boundary.py` adds five tests and **42**
deterministic cases, while retaining the previous 52 tests unchanged:

- After the original `_fence` returns, advance to **D−1ns / D / D+1ns** for the
  immutable fixture deadline, earliest provider expiry and one-hour issuance/
  request minimum. Exercise **both effect and handle read**, with same-thread
  delayed-validation hooks and a separate advancing thread coordinated by events
  (36 cases). The one-hour job is claimed near its credential deadline, without
  extending or bypassing the thirty-minute job timeout.
- D−1ns is a positive control: valid work is admitted. At D and D+1ns both sinks
  remain empty, memory is disabled and durable state is already EXPIRED. Check
  epoch, immutable deadlines, revoked tombstone, attempts, charges and fresh stop
  verification; reopen remains disabled and rejects stale effect/read/retry with
  unchanged audit tail. Watchdog calls are forbidden by the test hook.
- During sink entry, a second thread proves it cannot acquire the clock lock or
  finish either `advance()` or direct clock assignment before the sink record
  (four cases). The existing request precedes expiry; the next request at
  equality is denied and expires immediately without a watchdog.
- Cross thirty-minute reservation equality during validation for both operations
  (two cases): no initiation/read, disabled and durable STOPPED, no refund/reset.

The targeted/full coordinator suite passed **57 tests** in the first local run.
Final required command results and exact payload identity are recorded below
after executing the complete checks. No test/reserve/coverage threshold or
optional selection was weakened to obtain success.

## Executed complete payload checks

All ran from the isolated checkout on the corrective branch. Initial disk
availability was **1722585088 bytes**; the existing backup reserve remained
**1140850688 bytes**. No cleanup, resource operation, reserve change or bypass
was performed. All commands below exited **0**:

- `npm test`: **2685 passed, 28 existing optional skipped**; 40 files passed,
  two skipped; 101.03s; `/tmp/opencode/url32-f1-npm-test.log`. Includes the full
  coverage run, unchanged backup harness and expanded Python bridge. Skips are
  unexecuted, not passed or newly waived.
- `npm run lint`: `url32-f1-lint.log`.
- `npm run typecheck`: `url32-f1-typecheck.log`.
- `npm run build`: `url32-f1-build.log`.
- `npm run check:naming`: zero violations, plus semantic naming review;
  `url32-f1-naming.log`. No durable resource naming or compatibility migration.
- `npm run format:check`: `url32-f1-format.log`; also rerun after evidence edits.
- `npm run check:watcher-offline`: nine files, zero findings;
  `url32-f1-watcher-check.log`.
- `npm run test:watcher-offline`: **62 passed**, 6.318s;
  `url32-f1-watcher-test.log`.
- `PYTHONPATH=tools/local-coordinator/src python3 -B -m unittest discover -s tests/local-coordinator -v`:
  **57 passed**, 34.427s; `url32-f1-focused.log`.
- The exact syntax command below: **11 files parsed**, no bytecode;
  `url32-f1-syntax.log`.
- `git diff --check` and `git diff --cached --check`: zero findings;
  `url32-f1-diff-check.log` and final staged inspection.

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

Fresh configured TypeScript V8 coverage: statements **97.13% (847/872)**,
branches **97.43% (607/623)**, functions **96.63% (201/208)**, lines
**97.73% (776/794)**. This is not Python coverage.

Separately executed:
`PYTHONPATH=tools/local-coordinator/src python3 -B -m trace --count --summary --missing --coverdir /tmp/opencode/url32-f1-python-coverage --module unittest discover -s tests/local-coordinator -v`:
exit **0**, 57 tests, 24.150s; `url32-f1-python-coverage.log`. Rounded Python
trace line estimates: core **97%**, control **97%**, journal **96%**, verifier
**100%**. Not branch coverage, actual provider testing or operational proof.

## Exact corrective payload and retained gates

The final source/test payload has these identities, computed from the staged
tree with `git write-tree` and `git rev-parse <tree>:<path>` (exit **0**):

- Package-source SHA-256:
  `724a39cd8b7413de1e25c684038e89f1a4b86a917d14006333b2e0477526e856`.
- Package source Git subtree:
  `4c715e9c26c9610dcfed2bd222b6a9423b2ab02c`.
- Python tests Git subtree:
  `9d9069430b88d78e27f5b727cb1364d2528d1c56`.
- F1 regression test Git blob:
  `3d11973f804d0da4b955fafed2b4afc76ea54c52`.

Only evidence/README edits followed the complete payload checks. Final source,
test contents and the entire staged diff were inspected, including a cached
whitespace check. No workflow, dependency/lockfile, application, infrastructure,
schema, backup, checker, policy, approved specification or original test changed.

After creating the correction commit, all required checks are repeated on that
exact committed head before opening the **new** corrective PR. Their outcome,
full head SHA and complete containing Git tree are bound in its PR description;
the evidence file does not attempt to embed its own containing commit/tree hash.
The original implementation remains the parent commit, with the reviewed main
as its parent. PR #36 and its branch are not changed or merged.

New commits invalidate Dwight's prior exact-head verdict; only a new review of
the corrective PR can adjudicate F1. Existing green tests/CI never substitute for
that review. Dwight/Michael/Pam/human gates remain unchanged; Ryan does not merge,
resolve the old review as passed, perform Pam acceptance, modify Jira, activate
anything or claim real permissions, provider expiry/revocation, custody, quotas,
GATE-0 or production readiness.

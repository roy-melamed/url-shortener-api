# Disposable local coordinator

Owned by the URL shortener service. This package is a local-only
simulation, not a daemon, scheduler, operational stop tool or authenticated broker.
Imports initialize nothing. Only explicit `MockControl.initialize` may create a
disposable journal; every facade starts with admission closed. Nothing imports
the existing evidence watcher or an operational daemon.

## Layout and boundaries

- `src/local_coordinator/core.py`: deterministic policies, document identity,
  clock/deadline arithmetic, union planning, reservations and synthetic predicates.
- `src/local_coordinator/journal.py`: explicit 0700 disposable sandboxes, SQLite
  WAL/FULL transactions, append-only audit chain, verified backups and recovery.
- `src/local_coordinator/control.py`: concrete mock clock/sink, exact injected
  identity lists, admission leases/fences, attempts, stop, inspection and rollback.
- `src/local_coordinator/verifier.py`: fresh read-only stop validation, exact
  module-source binding and independently generated receipt.
- `../../tests/local-coordinator`: synthetic fixtures and Python regression tests.
- `../../tests/unit/local-coordinator.test.ts`: normal Vitest suite bridge.

Python 3.12 and SQLite with `Connection.setconfig` and
`SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE` are required for journal preservation. Unsupported
SQLite fails closed. A retained digest is required to reopen existing state; the
digest is not authentication or independently protected custody. The explicit
`mock-local-fsync` receipt is a test assumption, not filesystem certification.

Fixture identities, scope/source/config/policy hashes, clocks and opaque handles
are injected. No credentials, provider clients, network endpoints, subprocess
dispatch, host scheduler, service activation or environment discovery exist in
the implementation. `RecordingSink` records tuples only. Its confirmation and
drain cost are synthetic; no actual provider or worker termination is demonstrated.
Synthetic COMMENT/PASS evidence is never formal GitHub approval, actor identity,
actual CI, Pam acceptance or production authority.

## Local tests

From the repository root:

```sh
PYTHONPATH=tools/local-coordinator/src python3 -B -m unittest discover -s tests/local-coordinator -v
npm test
npm run lint
npm run check:naming
npm run typecheck
npm run build
npm run format:check
```

Tests explicitly create private sibling temporary roots named
`coordinator-tests-*/coordinator-mock-*`, then remove only their own roots.
Journals and snapshots contain synthetic data. Tests never delete original
operational journals, resources, volumes or historical approvals.

Stop closes memory admission before trying the serialized durable disable.
Unconfirmed persistence, drain or elapsed time returns BLOCKED. A timed-out
evidence thread may subsequently finish its bounded stop transaction; it cannot
reopen admission, and the earlier timeout is never changed into success.
Rollback restores a selected SQLite snapshot into a fresh candidate, verifies
its history is a prefix of current history, appends the authoritative suffix,
and records rollback only in the candidate. Original DB/WAL and snapshot remain
unchanged. Divergent histories are quarantined, not merged heuristically.

The F1 correction rechecks trusted clock/expiry, lease and job timeout **after**
fence/dependency validation, immediately before each sink effect/handle read.
Final validation and sink recording share the explicit mock clock's admission
lock while the journal gate remains held. Both `advance()` and direct mock clock
field assignments use that lock: time can advance during expensive validation,
but cannot slip between the final sample and the sink record. This serializes
the trusted disposable fake only; it is not a provider-native clock/stop control.

## Injected control contracts

`MockControl.invoke` implements the reviewed command shapes as method calls, not
a CLI, network listener, shell executor or live adapter. Every options dictionary
includes `fixture_root`, `fixture_id` and injected `caller`, with these exact
additional fields:

- `halt`: UUID `request_id`, `operator="roy"`, fixed-code `reason`.
- `inspect`: `read_only=True`, `expect_disabled=True`; deliberately no request ID
  and no write, as specified by the reviewed shape.
- `snapshot`: UUID `request_id`. Pass an explicitly created `Sandbox` as the
  separate `candidate` capability, not as an arbitrary path/argv value.
- `rollback`: UUID `request_id`, exact `snapshot_id`, `expected_epoch`; separately
  inject `selected`, `snapshot_receipt`, and the explicitly allocated candidate.
- `revoke-plan`: UUID `request_id`, allowlisted opaque `credential_ref`, and
  `provider` (`github-installation`, `jira-oauth`, or `token-store`). No tokens.

Allocate a rollback command destination with
`Sandbox.request_candidate(original_sandbox, request_id)`; reopen that same
destination explicitly with `existing=True`. The root name binds original root
and request ID. Its durable receipt permits replay after process restart and
rejects conflicting inputs without writing the authoritative original DB/WAL.
Snapshot/revocation receipts reside in the original append-only control journal;
all command types reject cross-command request-ID reuse. An interrupted command
without a verified receipt remains BLOCKED, never silently repaired or retried.

Claims require a persisted eligible plan under the current generation/epoch/
session/boot lease, matching stage/fingerprint and validated dependencies. Effects
also recheck a hash of that dependency closure; unrelated issue changes do not
invalidate it. An issue-local rejected plan does not close unrelated admission.
Shared journal/clock/storage faults still close memory admission.

The sink exposes read-only tuple snapshots, not mutable public audit lists. This
is API-level mutation protection, not protection against a malicious same-UID
Python debugger/root writer. Stop verification likewise proves local simulated
predicates, not authenticated operator identity or provider termination.

## Evidence and remaining external gates

The original PR #36 received a blocking technical FAIL for the final-boundary
expiry race. Its review and earlier evidence remain preserved. See the corrective
implementation and test evidence in
[`../../docs/local-coordinator-final-admission-fix-evidence.md`](../../docs/local-coordinator-final-admission-fix-evidence.md),
and the earlier resumed-check history in
[`../../docs/local-coordinator-implementation-evidence.md`](../../docs/local-coordinator-implementation-evidence.md)
for executed checks and local acceptance traceability. There is
no CLI/listener, real credential, external revocation, service, deployment or
production readiness claim. Real custody, native expiry, operator authentication,
quota/$0 proof, provider permissions and GATE-0 remain blocked and out of scope.

The corrective branch retains the original implementation commit but does not
modify or merge PR #36. A new review PR is not approval to merge, activate a
fixture or deploy anything. Required checks use the unchanged backup reserve.

# Jira evidence watcher — safe offline simulation

Owner: engineering squad. Tracking: URL-29. Implements only the human-authorized
offline phase of the unchanged [committed design](../../docs/jira-evidence-watcher-design.md#11-explicitly-authorized-phase-safe-offline-implementation)
at `7ae16495696cbab215ac5366bf77f02c55062870`.

**Not a daemon, live Jira integration or delivery tool.** No installer, executable
entry point, environment/credential discovery, live/network adapter, subprocess,
session control, socket, consumer protocol or OS service files. Nothing to
install, start, enable, arm or deploy. There is no disabled live fallback.
Application code and its runtime dependencies remain unchanged.

## Run only the synthetic tests

From the repository root with Python **3.12.x** and its standard-library SQLite:

```sh
npm run check:watcher-offline
npm run test:watcher-offline
```

No Python packages need installation. `-B` prevents bytecode-cache writes.
The AST check validates Python syntax and the package's capability/import boundary;
it is **not** a static Python type checker or an OS sandbox. Existing repository
TypeScript typechecking and coverage/build checks still run unchanged. CI adds
only a Python 3.12 test toolchain and these offline checks, not an operational job.

For stdlib executable-line tracing (not branch or operational coverage):

```sh
PYTHONPATH=tools/jira-evidence-watcher/src python3 -B -m trace \
  --count --summary --missing --ignore-dir /usr \
  --coverdir /tmp/evidence-watcher-test-coverage \
  --module unittest discover -s tests/jira-evidence-watcher
```

## Boundaries by construction

- `FixtureConfig` requires `fixture-jira.invalid`, project key `SYNTH`, reserved
  six-digit ASCII `99…` numeric IDs and explicit `fixture-human-*` allowlist data.
  Nothing reads the real project config, actor list, environment or credentials.
  A fixture account match is **not proof of human provenance** under shared accounts.
- `FixtureSource` accepts literal JSON only, not a URL/path/client/callback.
  `FixtureTransport` reads that source's memory and returns scripted failures;
  it is a fake **page transport**, not notification delivery. `OfflineScanner`
  accepts exactly the concrete fixture transport and virtual clock, not arbitrary
  live adapter implementations/subclasses. No network-capable module is imported.
- `DisposableState` creates its own new private temporary directory and a fixed
  SQLite basename. No path/config API targets an existing ledger/application DB.
  Reopen is limited to that same sandbox. The directory is 0700; DB/WAL/SHM are 0600. It is removed only when the test sandbox is explicitly closed. Ordinary
  Python callers/host administrators are trusted: this is not isolation against
  arbitrary code execution or same-UID tampering.
- No production issue keys/content/credentials are fixture data. IDs are parsed
  without coercion; UTC timestamps, history shapes, exact project/type/status IDs,
  author account ID/type/active status and historical membership are validated.
  Display names, signatures/status labels are never authentication. Malformed or
  ambiguous full history holds the **whole scan** rather than advancing coverage.
  Only normalized metadata/digests persist; no raw history/body/JQL/prose logs.

## Simulated persistence and reconciliation guarantees

- A simulated future fence is persisted before scanning and cannot be changed or
  deleted via SQL. Config digest binds collection boundaries, not just flattened
  values. Missing/corrupt/wrong-schema/mismatched-config state is not reset/rebuilt.
- Event identity hashes canonical length-delimited version/site/numeric issue/
  opaque history/system field/from/to IDs. It does not depend on key, timestamp,
  scan or installation. Both event ID and original composite are unique; normalized
  history reuse/mutation/removal is checked. Histories before the original fence
  never enter the outbox, including late visibility, slow bootstrap and restart.
- SQLite WAL, foreign keys, FULL synchronous mode and a bounded 100ms **test-only**
  busy timeout are used. Event decisions, one pending outbox row per eligible event,
  inventory/history dedupe, completed bound and revision are one `BEGIN IMMEDIATE`
  transaction. Revision compare-and-set prevents stale concurrent scan commits.
  Injected crashes before commit roll back; after-commit crashes preserve facts.
- The local `simulated_work_identities` table deduplicates an issue/action-revision
  identity independently of event IDs. Multiple eligible facts may reference it.
  It contains **no consumer receipt, work intent/claim, execution, lease or ack**.
  Pending outbox facts can only be inspected, never drained/delivered by this API.
  This does not certify duplicate-free real work execution.
- Frozen minute windows use 60s lag, inclusive 15min overlap, never a current-Done
  filter. Complete/reopen facts remain eligible but marked superseded; later
  approvals have new event IDs. Full-history sweeps on restart/hourly virtual polls
  catch visible retained history beyond overlap and directly reread known issues.
  Both search and changelog pagination validate completion, progress and bounds;
  metadata drift requires complete reread (three attempts), otherwise a hold.
- All page data is staged **in memory**, then applied atomically. Durable
  `scan_runs` records remain `collecting` after interruptions; a restart refetches
  from page zero, not from a claimed completed page. This deliberately does not
  claim durable page-token resume or implement every later operational table in
  the design. Finite scans/bounded fixture sizes are assumed; no partial scan is
  reported completed. Max fixture 2 MiB; 100 values/page, 1,000 pages, 10,000
  histories/issues. Cross-page repeated history identities hold coverage.
- Requests are virtual, sequential and reserve a durable slot at least 10s apart
  (≤6/min average). Valid simulated Retry-After seconds/IMF-fixdate is a minimum,
  never capped to local backoff; jitter is an explicit deterministic sequence.
  Five attempts/cycle, deferred retry and a one-probe half-open hold after three
  failed cycles are persisted. No real sleeping or real HTTP response is involved.
  Unexpected/auth/coverage responses hold with a fixed enum; no refresh/login.
  Clock rollback or >24h jump holds instead of rewriting the fence/watermark.

## What this phase does not prove

Fault tests inject logical exceptions at every transaction checkpoint and close/
reopen disposable SQLite files. They do not kill a process, simulate real power
loss, certify fsync hardware, or validate VM backups/operations. Source/visibility
completeness holds only for the finite retained synthetic fixtures tested, not
Jira permissions, indexing, moves/deletion or historical retention in production.

No live event completeness, actor provenance/real allowlist approval, Herdr
delivery/ack/work scheduling, authenticated session binding, service readiness,
production ledger/backup recovery or deployment acceptance is claimed. All
integration/operational approvals in design §12 remain outstanding. A PR merge
and green offline tests do not authorize any expansion of this phase.

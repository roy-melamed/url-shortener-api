# Jira evidence watcher — safe offline implementation evidence

Tracking: URL-29. Design ancestry:
`7ae16495696cbab215ac5366bf77f02c55062870`, containing
`docs/jira-evidence-watcher-design.md`. That document is **unchanged** by the
implementation. Scope is only its human-authorized §1.1 offline subset, not the
future operational architecture. This is pre-PR developer evidence, not Dwight
approval or Pam merged-code QA. The PR identifies the exact submitted head.

## Implemented and tested

| Invariant                                      | Executed synthetic evidence                                                                                                                                                                                                                                                |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact fixture scope and actor matching         | Fixed `.invalid` site/SYNTH project, exact ASCII project/type/status IDs, explicit `fixture-human-*` policy; missing/app/machine/unauthorized/inactive actors rejected. Names, signatures and status labels never authorize an event.                                      |
| Fail-closed histories                          | Malformed IDs/timestamps/pages/items, contradictory history IDs/status items, ambiguous ordering, chain gaps, project/type moves, drift and history removal hold the entire scan; no partial completed cursor or outbox commit.                                            |
| Immutable simulated fence/no historical replay | Fence created at least five virtual minutes ahead before scanning, SQL update/delete triggers, config hash validation on reopen; `< A` histories remain suppressed during slow bootstrap, late visibility, repeated sweeps and restart; `>= A` eligible facts retained.    |
| Stable identity/dedupe                         | Length-delimited event tuple includes site/numeric issue/history/system field/from/to, excludes key/time/install/scan; composite and hash uniqueness plus normalized history digest consistency. Canonical collision/foreign-key fault tests roll back.                    |
| Atomic durable state                           | `BEGIN IMMEDIATE` decisions/history registry/inventory/outbox/completed bounds/revision transaction. Two-connection stale scan/busy writer tests, seven injected transaction crash checkpoints and close/reopen recovery.                                                  |
| No duplicate outbox/work identity              | One pending outbox row per eligible event; multiple acceptance cycles yield distinct facts but one unique simulated issue/action-revision identity. No claim, receipt, execution, consumer or ack protocol exists.                                                         |
| Complete-then-reopen                           | Acceptance retained as a superseded observed fact despite current non-Done state; no Done filter. A later acceptance is a new event; repeated scans add no duplicate rows.                                                                                                 |
| Pagination/reconciliation                      | Server-clamped/many pages, 121 retained status records, invalid/empty/repeated/nonprogressing pages, total drift, before/after metadata reread, known issue disappearance, lag beyond overlap, hourly/restart full sweeps.                                                 |
| Windows/retry/clock                            | Frozen lagged minute upper bound, inclusive overlap, durable virtual request slots/not-before, exact Retry-After minimum (including large/date values), jitter, five-attempt ceiling, three-cycle hold/one-probe recovery, permanent responses, rollback/large-jump holds. |
| Privacy and capability boundary                | No raw prose in DB/normalized facts/logs; operation/time-only fake call ledger; no output on normal ingestion; private sandbox files. AST import/call checks plus exact concrete fakes, no live adapters/network/credentials/env/subprocess/session capabilities.          |

The 52 unittest methods contain additional parameterized/subTest negative cases
and seven transaction crash checkpoints; they are reported as **52 tests**, not
inflated into a claim of live end-to-end coverage. Independent developer test
work initially exposed Unicode numeric acceptance and config-hash collection
boundary collisions; both were corrected with retained regression tests. One
restart test initially reset its virtual clock backwards; it was corrected to
reuse persisted virtual time, not by weakening the rollback hold.

## Actual verification (2026-11-06)

Local runtime: **Python 3.12.3 / SQLite 3.45.1**. No Python packages installed;
runtime and tests use the standard library. CI selects Python 3.12.x and runs
the two new offline checks in the existing quality job. No daemon/service job.

Executed in the isolated worktree, then repeated in a **clean local Git clone of
the final candidate** with no ignored workstation profiles. Commands and actual
exit codes:

| Command                         | Exit / result                                                                    |
| ------------------------------- | -------------------------------------------------------------------------------- |
| `npm ci`                        | 0                                                                                |
| `npm run lint`                  | 0 (existing ESLint scope)                                                        |
| `npm run check:naming`          | 0                                                                                |
| `npm run typecheck`             | 0 (existing TypeScript scope)                                                    |
| `npm run check:watcher-offline` | 0 — Python AST syntax/capability lint                                            |
| `npm run test:watcher-offline`  | 0 — **52/52 synthetic Python tests**                                             |
| stdlib `trace` command below    | 0 — all 52 tests repeated                                                        |
| `npm run test:coverage`         | 0 — **2,306 passed / 10 existing DB tests skipped**, 20 files passed / 1 skipped |
| `npm run build`                 | 0 (existing application build)                                                   |
| `git diff --check`              | 0                                                                                |

Formatting of touched JSON/YAML/Markdown exited 0. The clean-clone candidate was
exported from the index into a disposable local Git fixture, committed there and
cloned with `git clone --no-hardlinks`; no remote was needed for verification.
`git status --short` remained empty after checks. Design content is byte-identical
to its authorized design commit and retained in the implementation PR's ancestry.

Python executable-line tracing used:

```sh
PYTHONPATH=tools/jira-evidence-watcher/src python3 -B -m trace \
  --count --summary --missing --ignore-dir /usr \
  --coverdir /tmp/evidence-watcher-test-coverage \
  --module unittest discover -s tests/jira-evidence-watcher
```

Stdlib trace reports model **100%**, store **100%**, simulation **96%** executable
lines. This is **not branch coverage**, physical-fault coverage, or a promise
that every input is supported. The TypeScript coverage configuration/thresholds
are unchanged and still apply to `src/**`, not this Python library. Python AST
lint is not static type analysis; no Python static type checker or wheel builder
is installed/claimed. The Python artifact is source-only with inert metadata,
no executable/installation hook; the available repository build passes.

## Honest limits / blocked later phases

- Concrete literal-JSON fakes/virtual clocks only, no production client or fallback.
  Test fixture scope/account matches do not establish live human provenance,
  approved real actor allowlists, permissions, event completeness or live mapping.
- SQLite state exists only in factory-created disposable test directories. WAL/
  FULL synchronous configuration and logical crash/close/reopen tests assume the
  filesystem's normal durability; no power kill, real disk-full/fsync failure,
  production backup/restore, OS process lock or host recovery is certified.
- Page staging is in memory. Incomplete scan records do not advance a completed
  cursor; restart refetches page zero. Durable page-token resume and operational
  staging cleanup/retention are not claimed. Full reconciliation covers only
  finite retained visible synthetic histories; hidden/deleted live events remain
  the design's explicit capture limit, not a solved acceptance criterion.
- Outbox facts remain `pending-offline`, inspectable only; the simulated work
  identity is not a work intent/claim or consumer interface. No notification
  drain, Herdr adapter/socket/prompt/event, receiver/ack, execution or deployment
  action exists. No consumer readiness or service readiness is claimed.
- No credentials/environment integration, live preflight/discovery, production
  allowlist approval, service/unit template, install/enable/start/restart/linger,
  daemon schedule, application/DB/volume/backup/cloud mutation or deployment is
  introduced. All later approvals in design §12 remain blocked. Normal external
  ticket workflow coordination is separate from—and never exercised by—the
  synthetic watcher code or tests.

The standalone README documents the API construction boundary and limits. New
tests/data are wholly synthetic; no real Jira issue body or production credentials
are fixtures or logs. No approved PRD/requirements/design or existing resource/
connection/backup identifiers were edited. Green offline checks are not live
integration, delivery, operational or deployment acceptance.

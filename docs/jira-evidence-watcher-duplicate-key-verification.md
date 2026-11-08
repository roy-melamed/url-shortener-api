# Offline watcher duplicate-key correction evidence

Ryan developer rework, 2026-11-08. Tracking only: URL-29.
This is developer evidence, not reviewer approval or merged-code QA acceptance.

## Finding and reproduction

Addresses [Dwight's submitted FAIL review](https://github.com/roy-melamed/url-shortener-api/pull/13#pullrequestreview-5800329297)
and [blocking R1 thread](https://github.com/roy-melamed/url-shortener-api/pull/13#discussion_r4492604037)
at `6166b8d05451f95f9471aa4866732bce34e315a1`. This replacement branch starts
at that exact head, retaining the complete offline implementation and unchanged
authorized design ancestor `7ae16495696cbab215ac5366bf77f02c55062870`.
No commit is pushed to PR #13; that PR's FAIL is not superseded by a developer claim.

Before the correction, the actual concrete source/transport/scanner/disposable
SQLite path with literal actor keys machine-then-human printed `outbox=1 revision=1`;
human-then-machine printed `outbox=0 revision=1`. The six new unittest methods,
run against the original code, exited **1** (42 subTest/assertion failures).
They reproduce the ambiguous parsing and missing fixed-error boundary; mocks
in the no-classification assertions also expose downstream `snapshot-invalid`
instead of the required input rejection. The separate unmocked reproduction
above confirms the actual eligible-fact insertion defect.

## Correction and regression assertions

`literal_json` now uses the standard-library decoder's `object_pairs_hook`.
At every object depth, `unique_object` inspects decoded key pairs for duplicates
before constructing that dictionary. This catches escaped-equivalent keys and
identical repeated values too, independent of key order, without special-casing
actor/status names. The internal exception contains a fixed code only; the
existing public boundary raises `OfflineError("fixture-json-invalid") from None`.
No key, value, fixture body or JSON decoder diagnostic is included in the error.
No runtime dependency, capability, adapter, flag or quality-gate change is added.

Six regression methods cover:

- Literal actor `accountId`, status `from`, nested metadata `project`, fixture
  configuration `page_size`, and deeply nested metadata/config `humans` duplicates;
  both value orders and ordinary/escaped-equivalent decoded spellings.
- Every malformed fixture routed through the actual construction chain
  `FixtureSource -> FixtureTransport -> OfflineScanner -> disposable SQLite`.
  Rejection occurs at source decoding, before a scanner can be constructed:
  classifier/apply are not called, no snapshot is accepted, and engine state,
  all counts, outbox and scan-run count remain unchanged (revision zero).
- Rejected replacement after real bootstrap **and** incremental scans leaves
  the accepted source object, transport calls, full/incremental completed bounds,
  watermark/revision and all durable counts unchanged. Subsequent valid polling
  remains idempotent. A rejected input is not silently retried using old data.
- The same guard rejects ambiguous scripted transport JSON, including status
  and Retry-After keys. Arrays, empty objects and equal keys in separate objects
  remain valid; equal names across objects are not duplicates.
- Full unmocked valid human/machine controls still yield respectively one/zero
  eligible pending outbox facts, one processed event and revision one.
- Fixed exception args, suppressed chained context, no cause and no stdout/stderr;
  diagnostic formatting contains no synthetic private values or actor identity.

## Executed checks

Isolated worktree `/tmp/opencode/jira-watcher-duplicate-keys`, branch
`fix/jira-watcher-duplicate-keys`. The PR body identifies the exact submitted
commit containing this tested code. Python 3.12 standard library only. Commands
were executed after the code/tests correction; documentation alone was added
afterward. No workstation profiles or external integrations are test inputs.

| Command                         | Actual exit/result                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| `npm ci`                        | 0                                                                                          |
| `npm run lint`                  | 0                                                                                          |
| `npm run check:naming`          | 0                                                                                          |
| `npm run typecheck`             | 0; existing TypeScript scope                                                               |
| `npm run check:watcher-offline` | 0; AST syntax/capability check, not Python static type analysis                            |
| `npm run test:watcher-offline`  | 0; 58/58 Python tests                                                                      |
| trace command below             | 0; 58 tests, model/store 100%, simulation 96%, new regression module 100% executable lines |
| `npm run test:coverage`         | 0; 2,306 passed / 10 existing DB tests skipped; 20 files passed / 1 skipped                |
| `npm run build`                 | 0; existing application build, not a Python wheel build                                    |
| `git diff --check`              | 0                                                                                          |

```sh
PYTHONPATH=tools/jira-evidence-watcher/src python3 -B -m unittest discover \
  -s tests/jira-evidence-watcher -p test_duplicate_json.py -v
# Before correction: exit 1. Included in passing 58-test suite after correction.

PYTHONPATH=tools/jira-evidence-watcher/src python3 -B -m trace \
  --count --summary --missing --ignore-dir /usr \
  --coverdir /tmp/opencode/watcher-r1-trace \
  --module unittest discover -s tests/jira-evidence-watcher
```

Line tracing is not branch/security completeness or operational certification.
Existing TypeScript coverage thresholds and workflow checks are unchanged.
The original [implementation evidence](jira-evidence-watcher-offline-verification.md)
describes the earlier 52-test revision; the 58-test results here supersede its
test count for this correction, not its offline limitations.

## Unchanged boundaries

Pure synthetic fixture parsing, concrete memory-only fakes and disposable SQLite
only. No live Jira/auth/network or credentials/env integration, no real production
status/actor mapping, Herdr/session/consumer delivery, service operation, deployment
or application/resource/data change. No Jira issue read/write or workflow/field
change is made in this correction turn; Michael's pre-live workflow decision is
still required. No design/PRD/acceptance criteria change. No claim of live human
provenance, event completeness, delivery, physical power-loss recovery, service
readiness or QA acceptance. Ryan does not merge or self-review. Dwight must review
the replacement PR's exact current head, including inherited workflow changes.

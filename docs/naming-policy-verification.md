# Naming policy implementation — technical verification

Base: `01bcc128510736eac556c5b31e5e15ef1c119f44`.
Scope: policy, shared agent instructions, static guard, its regression tests,
package command and one CI step. This is pre-PR developer evidence, not a
Dwight verdict or Pam merged-code acceptance report.

## Executed checks (2026-11-04)

Executed in the isolated policy worktree, then repeated in a **clean local Git
clone of the staged snapshot**, created without copying ignored workstation
files. The clone had **no `.opencode` directory** before or after checks.
All commands below exited **0** in both checkouts:

| Command                                           | Result                                                   |
| ------------------------------------------------- | -------------------------------------------------------- |
| `npm ci`                                          | Clean dependency install                                 |
| `npm run check:naming`                            | 0 violations in the repository; existing names unchanged |
| `npx vitest run tests/unit/naming-policy.test.ts` | 46/46 passed                                             |
| `npm run lint`                                    | ESLint only; no duplicate naming invocation              |
| `npm run typecheck`                               | Passed                                                   |
| `npm run test:coverage`                           | 19 files passed, 1 skipped; 198 tests passed, 10 skipped |
| `npm run build`                                   | Passed                                                   |
| `git diff --check`                                | Clean                                                    |

Existing DB integration tests are the 10 skipped tests: no live PostgreSQL
access was enabled. Existing configured coverage thresholds remain unchanged;
full suite coverage: lines 82.25%, statements 80.91%, branches 82.08%,
functions 83.33%. Coverage instrumentation remains the project's `src/**` scope;
the checker itself is exercised by the 46 behavioral tests, not claimed to be
included in those source-coverage percentages.

Formatting on the changed Markdown/TS/JSON/YAML files also exited 0. Initial
focused runs exposed env-extension filtering, `--name` extraction and a
Markdown table-spacing assertion; these were corrected and all final checks
above rerun successfully. No quality threshold was lowered.

## Regression evidence

- Direct `URL-27` resource/property/construct names fail, while traceability
  descriptions, comments, docs, branches and historical report filenames pass.
- Compact evidenced `url27-backup`/suffix variants and the exact `url8` legacy
  derivations fail in new resource configs; no generic numeric-token ban.
- Legitimate `url8`, `api-v2`, `postgres16`, `postgres-16`, IPv6/schema versions
  and task-specific scratch artifacts pass.
- Both exact existing `url27-backup` declarations and the exact existing backup
  DB default pass once at their original paths. New paths, duplicates and altered
  declarations fail. No wildcard migration-directory exemption exists.
- New TS migration table/schema/index calls (including named index options) and
  SQL table/index declarations fail when ticket-derived; numeric filenames and
  descriptive existing migrations pass.
- Workflow names/job mapping keys are checked; comments and arbitrary `run`
  prose are not. CI has exactly one standalone naming step.
- An integration test creates a local Git fixture and injects three violations
  into active YAML/env/migration files: repository scan returns three findings
  and the real command exits **1** as expected. Docs containing legacy names
  remain allowed. HTTP proxies are poisoned in that subprocess; the guard's only
  subprocess is local `git ls-files`, and it imports no runtime/cloud adapters.
- Role requirements come from tracked `AGENTS.md` and the normative policy
  table, not ignored profiles. A clean-clone run proves portability.

## Clean-clone reproduction

Before implementation commit, the candidate index was exported with
`git checkout-index --all --prefix=<temporary-root>/`, initialized and committed
in that disposable local fixture, then cloned with `git clone --no-hardlinks`
into a fresh directory. No remote push or resource operation occurred. Run the
commands in the table after `test ! -e .opencode`; after checks, `git status
--short` was empty and the profile-absence assertion still exited 0. For later
review, clone/check out the submitted head and run the same commands.

## Audit and safety boundaries

The normative policy contains the full 89-tracked-file baseline reference index,
compatibility inventory, proposed future descriptive replacements and migration
risks, incorporating Jim's specification proposal and Dwight's separately
performed, read-only Docker inventory. No ephemeral memo link is required to
understand the durable policy. Runtime observations are attributed and dated;
no live SQL catalogue or cloud inventory was obtained by this implementation.

No Jira changes, resource rename/recreation, backup/config/connection-string
change, Docker/SQL/cloud call, data/volume operation, schedule, installation or
deployment was performed. Runtime source, infra, existing operational scripts,
Compose/env, systemd, migrations and approved PRD/specification artifacts remain
byte-identical to the base; only package/CI check wiring changes. Ignored
agent configuration is neither tracked nor required; `.gitignore` is unchanged.
Manual semantic review is still required for dynamic/multiline/unsupported
declarations and excluded documentation examples; the policy documents these
limits explicitly. The guard never auto-fixes a name.

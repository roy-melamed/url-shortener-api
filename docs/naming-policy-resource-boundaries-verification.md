# Naming resource boundaries — R3–R5 developer verification

Dependency: [PR #10](https://github.com/roy-melamed/url-shortener-api/pull/10),
parent `2c7b2d21346ea3d746af9cbc39587534db66dde4`, itself stacked on PR #9.
[Dwight's exact-head FAIL report](https://github.com/roy-melamed/url-shortener-api/pull/10#pullrequestreview-5768687068)
was read in full before implementation. R1/R2 were verified fixed in that review;
all 106 inherited tests and both fixes are retained. This is developer evidence,
not Dwight approval or post-merge QA acceptance. Neither parent PR is updated or
merged by this correction.

## Reproduced before fixing

In a new isolated worktree at the reviewed parent, added 31 R3–R5 probes through
both `checkSource` and the real CLI, without first changing the checker.
`npx vitest run tests/unit/naming-policy.test.ts` exited **1**, with
**34 failed / 134 passed (168)**. Reproduced all eight required examples:

| Probe                                                    | Parent actual CLI exit | Expected / corrected exit |
| -------------------------------------------------------- | ---------------------- | ------------------------- |
| `docker run --rm alpine echo --name URL-27`              | 1                      | 0                         |
| `docker run --rm alpine printf '%s\n' --name=URL-27`     | 1                      | 0                         |
| `docker run --name postgres16 alpine echo --name URL-27` | 1                      | 0                         |
| Workflow `run:` scalar with the first Docker command     | 1                      | 0                         |
| `SELECT $$Example: CREATE TABLE URL-27$$;`               | 1                      | 0                         |
| `SELECT $memo$Example: CREATE TABLE "URL-27"$memo$;`     | 1                      | 0                         |
| `CREATE TABLE public."URL-27" (id int);`                 | 0                      | 1                         |
| `CREATE TABLE "public"."URL-27" (id int);`               | 0                      | 1                         |

These inputs were only text in disposable local Git fixtures: no Docker command
or SQL statement was executed. Original PRs #9/#10 and their branches were not
modified.

## Corrections and additional controls

- **R3:** the Docker run/create extractor consumes standard value-taking option
  arguments (long options, `--option=value`, short flags, attached/clustered short
  values) and stops at the first positional **IMAGE**, or explicit `--`. Payload
  arguments are never interpreted as container options. The offline option-arity
  table describes Docker syntax, not a naming allowlist. Tests pair allowed
  post-image examples with rejected pre-image `--name`/`--name=` and Docker create
  cases, options taking image-looking values, `--network`/`--env`/`--label`,
  short/clustered/attached flags, workflows and separate commands.
- **R4:** SQL tokenization treats matched `$$…$$` and `$tag$…$tag$` delimiters as
  one string token. The closing tag must match exactly. Dollar-quoted CREATE-like
  text is not code. Controls cover alternate/numeric-suffixed tags, different
  dollar delimiters inside literals, single-quoted examples, and a real CREATE
  following a dollar string (still rejected).
- **R5:** dot is a separate token in CREATE targets. Every literal component of a
  qualified target is checked, including quoted schema/table combinations,
  whitespace around dots, `IF NOT EXISTS` and index targets. Valid qualified
  `url8`, `postgres16`, `api-v2` and IPv6-oriented names still pass. No schema
  changes or renames are used to make tests pass.

The guard remains conservative/static: complex wrappers, dynamic evaluation,
indirect SQL delivery and tool-version-specific options require the policy's
manual semantic review. No full shell/SQL interpreter or external/runtime call
is introduced. Standard option arity can be extended with reviewed regression
tests when Docker syntax changes, never by exempting a forbidden identifier.

## Actual final-tree checks (2026-11-04)

Executed in the isolated implementation checkout and repeated in a **clean local
Git clone of the staged candidate**, without `.opencode`/ignored workstation
profiles. For the clean clone, exported the candidate index into a disposable
local Git fixture, committed only that verification snapshot locally and cloned
it with `git clone --no-hardlinks` (no remote push for verification).

| Command                                           | Exit / result                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------ |
| `npm ci`                                          | 0                                                                              |
| `npm run check:naming`                            | 0 — existing exact compatibility exceptions unchanged                          |
| `npx vitest run tests/unit/naming-policy.test.ts` | 0 — **168/168 passed**                                                         |
| `npm run lint`                                    | 0                                                                              |
| `npm run typecheck`                               | 0                                                                              |
| `npm run test:coverage`                           | 0 — **320 passed / 10 existing DB tests skipped**, 19 files passed / 1 skipped |
| `npm run build`                                   | 0                                                                              |
| `git diff --check`                                | 0                                                                              |

All **62 new tests** run the 31 probes once through the helper and once through
the real checker CLI. CLI assertions cover exact finding count and exit, file
diagnostics for violations, and unchanged fixture contents. Allowed cases return
zero findings/exit 0; actual prohibited names return findings/exit 1. Proxies are
poisoned in the CLI probes; the checker invokes only local Git enumeration, never
Docker/SQL/cloud commands. Formatting also exited 0. Clean-clone `git status
--short` was empty after checks. The existing coverage configuration/thresholds
and `src/**` instrumentation scope remain unchanged; these source percentages
are not claimed as checker source coverage.

## Preserved scope

Only the checker, naming tests and this new evidence report change. R1 quoted
YAML handling, R2 prose/comment handling, all inherited regression coverage,
exact compatibility declarations and their duplicate/path boundaries, legitimate
numeric identifiers, normative policy, package/CI wiring and its one naming gate
remain intact. Backup script, systemd units, resources/data/volumes, backup
paths/manifests, runtime configurations/connections, migrations and approved
specification files are unchanged. No Jira, external resource operation,
installation, schedule, deployment, self-approval or merge occurred. Michael must
route the new stacked corrective PR's exact head to Dwight for review.

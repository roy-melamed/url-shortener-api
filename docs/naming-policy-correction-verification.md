# Naming declaration corrections — R1/R2 developer evidence

Dependency: [PR #9](https://github.com/roy-melamed/url-shortener-api/pull/9),
parent head `0aafee229dff859cbf12130fa3ebcaa6552afb40`.
[Dwight's submitted FAIL review and reproduction report](https://github.com/roy-melamed/url-shortener-api/pull/9#pullrequestreview-5768381725)
was read in full before implementation. This correction is stacked onto that
branch; it does not update PR #9, merge either PR or claim review/QA acceptance.

## Reproduced first (2026-11-04)

In a new isolated correction worktree at the reviewed head, added the initial
R1/R2 helper + real-CLI regressions **before changing the checker**.

`npx vitest run tests/unit/naming-policy.test.ts` exited **1**:
**22 failed / 64 passed (86)**. Ordinary single/double quoted YAML mapping keys
and quoted `container_name` fields bypassed detection (CLI exit 0 instead of 1).
Workflow `echo "example --name URL-27"`, shell inline-comment examples and
`printf` text resembling `CREATE TABLE` falsely failed (CLI exit 1 instead of 0).
The original PR head/branch was not modified.

## Correction

- **R1:** recognize ordinary single- and double-quoted YAML mapping keys, including
  sequence mappings; decode ordinary quoted scalar keys/values without executing
  anything. Strip only actual unquoted inline comments, not hashes inside values.
  Resource-field and mapping-key checks still apply to active YAML/workflows.
- **R2:** replace the unconditional creation-string regex with context-specific
  extraction. Shell command words retain quoted text as a single argument;
  comments and printed `echo`/`printf` examples are not invocations. Real direct
  `docker run/create --name` declarations are checked, including quoted names,
  `--name=`, command separators, simple leading assignments/`sudo`, and the
  `docker container` form. Workflow `run` scalars/blocks use that command extraction
  instead of scanning arbitrary prose. SQL creation checks run on SQL-file tokens,
  distinguishing quoted identifiers from string literals and comments; actual
  table/schema/database/index checks and existing TS migration checks remain.
- Exact compatibility declarations/paths/counts are unchanged; no legacy names
  were renamed or broadly allowlisted. Legitimate numeric names, migration
  enforcement, scope exclusions and the one standalone CI naming gate remain.

This remains a conservative static guard, not a full YAML/shell/SQL interpreter.
Complex wrappers, command substitution, dynamic/multiline shell evaluation and
indirect SQL delivery require the same manual semantic review documented by the
policy; no command or resource definition is executed to discover an identifier.

## Executed final-code verification

Executed locally, then repeated in a **clean Git clone of the candidate snapshot**
with no `.opencode` directory or ignored workstation profiles. Exported the Git
index into a disposable fixture, initialized/committed that fixture locally, and
cloned with `git clone --no-hardlinks`. No remote push was used for verification.

| Command                                           | Actual exit / result                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------ |
| `npm ci`                                          | 0                                                                              |
| `npm run check:naming`                            | 0 — repository compatibility declarations preserved                            |
| `npx vitest run tests/unit/naming-policy.test.ts` | 0 — **106/106 passed**                                                         |
| `npm run lint`                                    | 0                                                                              |
| `npm run typecheck`                               | 0                                                                              |
| `npm run test:coverage`                           | 0 — **258 passed / 10 existing DB tests skipped**, 19 files passed / 1 skipped |
| `npm run build`                                   | 0                                                                              |
| `git diff --check`                                | 0                                                                              |

The additional **60 tests** exercise 30 R1/R2 probes each through `checkSource`
and through the **real CLI in disposable local Git fixtures**. Forbidden literal
resource declarations return **1**, permitted prose/numeric cases return **0**,
and tests assert finding counts, file diagnostics and unchanged fixture contents.
CLI probes poison HTTP proxies and invoke only Node/the checker and local Git,
never Docker, databases or cloud APIs. Coverage thresholds are unchanged; the
reported source coverage remains the project's `src/**` scope, not a claim of
checker source-coverage instrumentation.

The original 46 tests still verify exact legacy exceptions, duplicate/new-path
rejection, legitimate numeric identifiers, schema migrations, role instructions
without local profiles, and one CI gate. No active directory was newly excluded.
Formatting checks exited 0. Clean-clone `git status --short` was empty after
verification.

## Preserved boundaries

Changes are confined to the checker, naming tests and this correction report.
The normative policy, root instructions, package/CI wiring, original verification
report, operational scripts (including `scripts/postgres-backup.sh`), systemd
units, connection strings, runtime configs, backup names/manifests, resources,
data/volumes and approved specs remain unchanged. No Jira operation, runtime
inventory, dump/restore, installation, schedule, deployment or merge occurred.
Michael must route the new corrective PR's exact head to Dwight for review.

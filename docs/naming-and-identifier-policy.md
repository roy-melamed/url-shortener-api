# Naming & Identifier Policy

**Normative, project-wide.** MUST/MUST NOT are requirements for all agents and
contributors, for specifications through implementation, review and QA. Read
this policy before any work. It authorizes **no renaming or deployment**.

## New durable names

- Jira IDs belong only in work tracking, work branches, commits, PRs, traceability
  prose, and task-specific temporary artifacts (including QA scratch names).
  They MUST NOT generate durable technical names, even after removing punctuation
  or changing case (`URL-27` → `url27-backup` is still ticket-derived).
- Choose descriptive **domain-purpose-owner** names, not ticket/person/agent,
  sprint or incidental implementation identifiers. Ownership means the owning
  product/service/team, not a person's handle. Document the owner and lifecycle
  in the design or resource inventory; not every namespace needs all three words.
- This covers cloud resources, databases/schemas/tables/columns, containers,
  images/tags, volumes/networks, queues, APIs/routes, configuration/env keys,
  classes/types/namespaces, files/directories/paths, logging/metrics/alert labels.
- Prefer platform-appropriate conventions: kebab-case for resources and paths;
  snake_case for PostgreSQL names; UPPER_SNAKE_CASE env/config keys;
  PascalCase classes/types, camelCase functions/variables; stable lowercase API
  resource nouns with meaningful versioning. Preserve established public contracts.
- Legitimate domain numbers are allowed (`url8` as a genuine domain term,
  `ipv6`, `postgres16`, `/v1/links`, `sha256`). Numbers alone are not evidence of
  a ticket derivation. Explain ambiguous provenance in review.
- Examples: `url-shortener-postgres-backup`, `click-aggregation`,
  `click_event_dedup`, `REDIRECT_STATUS`. Environment/region/lifecycle belong in
  explicit metadata or documented suffixes; never encode credentials or secrets.

## Existing names: compatibility, not endorsement

Do not rename, recreate, delete, switch runtime references, alter connections,
retarget backups, or change data/volumes to comply with this policy. Preserve
historical documents, migration history, tests and evidence. References to old
names are not new declarations. Every existing name remains a compatibility
constraint pending explicit approval, even if nonconforming or not installed.

### Explicit exception inventory

| Existing identifier                                             | Dependency / exact existing declaration                                                                                                                                                                             | Disposition                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url8-pg`                                                       | Likely ticket-derived legacy violation per human examples. Existing PG16 container identity; design §14.2/14.3/14.6, requirements FR-9.2; restore runbook guards against targeting it                               | Preserve container and its anonymous volume; no active creation declaration found in this snapshot. Do not add new declarations under this name.                                                                                                                                                                            |
| `url8_acceptance`                                               | Likely ticket-derived legacy violation per human examples. Existing DB; `scripts/postgres-backup.sh:57` `BACKUP_DATABASES` default; dump/object filenames, restore rehearsal, schema tests and runbook depend on it | Preserve DB and backup/restore compatibility. Exact single existing assignment is exempt, not arbitrary new occurrences.                                                                                                                                                                                                    |
| `url27-backup`                                                  | `scripts/postgres-backup.sh:41` `SCRIPT_NAME`; `deploy/systemd/url-shortener-postgres-backup.service:56` `SyslogIdentifier`                                                                                         | **Known direct Jira-derived log identifiers, nonconforming.** Preserve both despite not being installed. Only these exact single assignments are exempt. Future approval could select `postgres-backup` / `url-shortener-postgres-backup`; coordinate journal queries, dashboards and alert matching to avoid lost signals. |
| `ryan-url8-postgres-1`, `ryan-url8_pgdata`, `ryan-url8_default` | Dwight read-only confirmed container/volume/network, 2026-11-04 12:16 UTC; old Compose project `ryan-url8`                                                                                                          | Compatibility constraints. Never create, rename, remove or mutate; no repository declarations are exempt for these names.                                                                                                                                                                                                   |

The descriptive existing OCI bucket `url-shortener-postgres-backups`, prefix
`postgres/`, `urlshortener`, legacy AWS `database-1`, config keys and all deployed
targets remain untouched. This policy is not permission to alter any runtime.
Task-only `url27-restore-scratch-*` and test temp directories are transient work
artifacts, not an exception to durable naming.

## Migration workflow (separate approval required)

1. Read-only inventory: identifiers, owner, consumers, DNS/connection references,
   data/volume ownership, backups/restores, logs/metrics/dashboards/alerts,
   secrets references and external/public contracts.
2. Propose descriptive replacements and explicit affected environments/resources,
   dependency ordering, aliases/compatibility window, verification, rollback,
   data-preservation and recovery plan. Obtain owner/human approval for the exact
   migration and any deployment. Policy adoption alone is never approval.
3. Implement only the approved scope; no automatic renames, destructive recreate,
   data/volume operation or connection-string rewrite. Test consumers and restore
   compatibility, observe signals, then retire aliases only with approval.
4. Update the exception inventory/checker only as part of the reviewed migration.
   A failing check is not justification to expand an allowlist or rename a resource.

## Repository-wide naming audit (2026-11-04)

Snapshot: `01bcc128510736eac556c5b31e5e15ef1c119f44`. Ryan read all **89
tracked files**, including dotfiles, dependency lock, source, five migrations,
CDK, Compose, env example, systemd, scripts, tests and historical docs. Identifier
searches and manual review were read-only. No naming implementation code executes
resource definitions. Jim's spec review and Dwight's architectural/runtime audit
were incorporated. This is not merged-code QA or a live SQL/cloud inventory.

Dwight's read-only Docker enumeration and selected metadata inspection sampled
the daemon at **2026-11-04 ~12:16 UTC** (ps -a, image/network/volume ls and
selected inspect fields; no container exec, SQL, cloud calls, secret environment
dump or mutation). Runtime facts below are attributed to that observation, not
inferred from configuration. Empty membership/Created status is NOT evidence
that storage is unused or safe to delete. PostgreSQL catalogue and live AWS/OCI
objects were not queried. Proposed install paths do not prove installed services.

| Current name / status                                                                              | Evidence, config/runtime references                                                                                                                                                       | Compatibility dependencies                                                                                                                                                                           | Proposed descriptive replacement (future approval only)             | Migration risk                                                                                                                       |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `url8-pg` — running; likely ticket-derived legacy violation                                        | Dwight observed PG16 container `e458afa9da70…`, default bridge, published 5432; design §§14.2–14.3, runbook refusal guards                                                                | Exact anonymous volume `48cb4f965e640b5d97bb08bb33cd0d663e02b93a990e412ef5b5656d7790fd3c`; operator selectors, future DNS/probes, network plans. Backup script uses local socket, not this hostname. | `url-shortener-postgres`                                            | **High:** live identity/storage, AD-16/17 no-recreate constraint, routing/connection continuity. No aliases verified.                |
| `url8_acceptance` — documented existing DB, not re-queried; likely ticket-derived legacy violation | Backup script line 57, runbook/rehearsal, design §14.6, requirements FR-9.2; Docker env shows only initial `urlshortener`, not full SQL catalogue                                         | Dump selection, archive internal DB name (`pg_restore --create`), `<db>.dump` basename, manifests, immutable old object keys, possible external test connections/grants not inspected                | `urlshortener_acceptance` and future `urlshortener_acceptance.dump` | **High:** changing defaults alone breaks restore compatibility; do not rewrite old backups, grants, connection strings or manifests. |
| `url27-backup` — definite Jira-derived durable log identity                                        | Script line 41 → log prefix and alert JSON `service`; unit line 56 `SyslogIdentifier`                                                                                                     | Journal queries, log dashboards, alert routing/matching (external consumers not inventoried). Descriptive unit filename is already correct.                                                          | `url-shortener-postgres-backup` (or reviewed `postgres-backup`)     | **Medium:** lost alerts/log continuity if changed independently; migrate script/unit/consumers together, even though not installed.  |
| `ryan-url8` — observed Compose project label; likely agent/ticket leakage                          | Selected container/volume/network inspect; Compose has no explicit top-level project name (`docker-compose.yml:18–52`); old worktree provenance                                           | Directory/`-p`/project-name selection controls all generated identities and volume lookup                                                                                                            | `url-shortener-dev-<workspace>` for future new stacks only          | **High:** changing project can attach a fresh empty volume or create parallel resources.                                             |
| `ryan-url8-postgres-1` — **Created, not running**, not presumed disposable                         | Dwight inspected `b97d159efa57…`, `postgres:16-alpine`, project `ryan-url8`, service `postgres`; HostConfig requests 5432 and network mode `ryan-url8_default`, active endpoint map empty | Mounts `ryan-url8_pgdata`, distinct from live container's volume; prospective host-port conflict                                                                                                     | Future generated `url-shortener-dev-<workspace>-postgres-1`         | **Medium/high:** do not start/remove/recreate; preserve separate data identity.                                                      |
| `ryan-url8_pgdata` — observed local named volume; contents not inspected                           | Volume labels project `ryan-url8`, volume key `pgdata`; mounted by Created container                                                                                                      | Compose project + volume key, data continuity; not the live `url8-pg` volume                                                                                                                         | Future new `url-shortener-dev-<workspace>_pgdata`                   | **High:** wrong volume mapping appears as empty DB; no data copies/recreation authorized.                                            |
| `ryan-url8_default` — observed bridge with empty member map                                        | Network inspect `f1098c29b882…`, `172.18.0.0/16`, project `ryan-url8`; Created container HostConfig still names it                                                                        | Project ownership, subnet allocation, potential future firewall references                                                                                                                           | Future generated `url-shortener-dev-<workspace>_default`            | **Medium:** recreation/attachment changes need approval; empty map does not authorize removal.                                       |

These exact `url8-*` cases are human-identified **likely legacy violations**, not
general proof that the valid numeric domain term `url8` is forbidden. No runtime
resource was changed by Ryan or Dwight for this policy. No stopped/inactive
classification is asserted beyond the inspected Created container.

### Complete baseline reference index for the known names

Line numbers are for the immutable snapshot above; semantic dependencies matter
more than line numbers after edits. Historical/test mentions are retained.

- `scripts/postgres-backup.sh`: 41,57.
- `deploy/systemd/url-shortener-postgres-backup.service`: 52,56.
- `docs/postgres-backup-recovery-runbook.md`: 28,59,204,205,207,217,227,232,
  258,260,261,266,268,273,297,304.
- `docs/url-27-restore-rehearsal-20261103.md`: 17,19,22,37.
- `tests/backup/run-tests.sh`: 19,113,129–131,178.
- `tests/unit/backup-units.test.ts`: 280,308,323.
- `specs/url-shortener-api/requirements.md`: 11,43,44,72,208,214,249,289,
  317,318,369,376,382.
- `specs/url-shortener-api/design.md`: 20,50,61,109,120,126,136,138,139,172,
  198,282,437,518,583,609,616,620,621,646,681,682,697,728,805,806,808,809,
  819,820,823,825,830,831,834,837,844,849,851,858,867,871,884,889,893,894,
  898,899,914,919,922,923,925,936,964,970,975,1039,1043,1049.

Other audited identifiers: package/pool `url-shortener-api`; Compose services
`postgres`, `jaeger`, `mailhog` and key `pgdata`; configured `urlshortener`
DB/user and env interfaces in `.env.example`, `src/platform/config.ts` and
`db.ts`; descriptive OCI bucket/prefix; 15 schema tables and indexes across
the five migrations; domain jobs/routes under `src`; CDK stack `UrlShortenerApi`,
construct IDs and parameter/output names in `infra/bin/app.ts` and
`infra/lib/{prerequisites,url-shortener-stack}.ts`. Retain all. Provider image
versions/hashes, API versions, migration ordering, generated logical IDs,
anonymous volume IDs, ports/CIDRs and required CI check names are not ticket
violations. `urlshortener_db/app/edge` are design proposals (not present in
Dwight's listing), not resources to create. No application image, Redis identity,
SQL catalogue or live cloud names are invented by this audit.

## Enforcement and limitations

Every agent MUST enforce semantic naming during coordination, spec, design,
implementation, review and QA. Run `npm run check:naming` (one explicit CI
step; `lint` remains linter-only) for the deterministic, read-only static guard. No Docker, DB, network or
cloud access is used.

The guard scans Git tracked and nonignored untracked authored `.ts/.js/.mjs`,
JSON, YAML, shell/env, SQL, service/timer files. TypeScript AST checks literal
resource/name properties, selected variable names, construct second arguments,
class and namespace declarations. Migrations **are included**: selected schema
creation/rename methods (`createTable/createSchema/createIndex`, constraints,
types/sequences and table/schema/index rename) inspect literal arguments and
named options, never execute migrations. Line-based checks cover simple resource
scalar assignments/mapping keys, `CREATE DATABASE/SCHEMA/TABLE/INDEX` (including
unique indexes), and `--name` declarations.
Direct boundary-delimited issue tokens of registered project key `URL`
(`URL-27`, case-insensitive) and the exact known compact legacy derivations above are rejected in
these contexts. The three exact existing compatibility declarations are allowed
once each at their exact paths; adding a duplicate or a new config still fails.

Docs/specs, tests/fixtures/reports, `.opencode` instructions,
and generated/dependency outputs are excluded. GitHub workflow YAML **is scanned
for selected declaration keys** (including persistent workflow/job names), not
arbitrary `run` text or comments. Jira prose remains allowed. Issue prose,
branches and filenames alone never fail. Active resource declarations must not be
hidden in excluded directories. No migration directory or filename is exempt;
the five baseline migrations have descriptive identifiers and need no exception.
Any future historical migration exception requires an exact file/declaration,
not a directory exclusion. Migration ordering/timestamps are not scanned as names.
Future migrations still require semantic review.
This is NOT a full YAML/shell/SQL parser or data-flow/type checker: indirect string
construction, multiline declarations, templates, arbitrary spelling changes and
runtime-injected values need human/reviewer checks. A pass does not certify all
names, ownership or provenance. Other Jira project keys require explicit
registration/review rather than treating all word-number names as violations.
Review new syntax/locations to extend the guard
with regression tests, not to weaken policy.

## Adoption review checklist

Review purpose/owner, stable contract and numeral provenance; absence of ticket or
agent derivation; platform syntax; compatibility exceptions/dependency evidence;
safe approved migration if needed; no secrets; static and semantic tests. Michael
coordinates compliance, Jim checks specifications, Dwight checks design/current
PR head, Ryan implements/tests, Pam validates on the merged code without renaming.

Jim's specification review proposal (2026-11-04) informed the
syntax, ownership, traceability and migration rules. Its description of existing
numeric names is narrowed here: grandfathering is not evidence that a name was
domain-derived. Historical AWS/Oracle wording inconsistencies remain outside this
policy's scope; approved PRD/requirements/design are unchanged.

### Five-role responsibilities (shared tracked instructions)

| Role    | Requirement                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------ |
| Michael | Read/enforce this policy during coordination; require naming evidence and explicit migration approval.       |
| Jim     | Read/enforce it in specifications; distinguish traceability, numeric domain semantics and durable contracts. |
| Dwight  | Read/enforce it in design and exact-head review; review scope/limitations and compatibility dependencies.    |
| Ryan    | Read/enforce it in implementation; run the guard and regression tests; never rename to silence a finding.    |
| Pam     | Read/enforce it in merged-code QA; test allowed/forbidden cases without mutating resources.                  |

Root `AGENTS.md` is auto-loaded repository-wide and binds every role above.
Workstation `.opencode/agents` files are ignored local configuration, not a
portable policy source or a test dependency. No tracked profiles or ignore-rule
changes are introduced. Tests must pass with all local profiles absent.

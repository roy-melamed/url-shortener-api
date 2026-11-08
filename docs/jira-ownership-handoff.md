# Jira ownership handoff — local implementation and proposed admin contract

Owner: engineering squad. Tracking: URL-30. Lifecycle: source-only policy planner
and synthetic tests; **not installed, configured or activated Jira automation**.
This policy is independent of the URL-29 evidence watcher. It introduces no Done
status and grants no permission, approval, execution or deployment authority.

## Authorization and inspected context

Human authorizes implementing/testing assignment handoffs, not production Jira
configuration, permissions, credentials, live rule testing, service activation or
deployment. Dwight's assigned-session guidance explicitly permits a pure
project-scoped local planner/guard, synthetic tests and a proposed admin runbook.
Approved PRD/requirements/design, shared instructions and the existing
`specs/url-shortener-api/squad.config.json` remain unchanged.

Repository inspection found no existing ownership automation, Jira write client,
automation-rule exporter/importer or nonproduction Jira test harness in `src`,
`scripts`, `.github` or `tools`. The separate Python watcher is synthetic-only
and remains untouched. Existing Vitest/TypeScript tooling can test a pure planner
without adding a client or dependencies. New code is in
`scripts/jira-ownership-policy.ts`; nothing imports it from an application entry
point, CLI, workflow job, watcher or scheduled service. There is no executor,
webhook endpoint, network call, credential/environment reader, install command
or production configuration artifact.

For coordination, loaded project config and read URL-30 plus current project
status metadata through MCP. Confirmed project ID `10001` and work types Epic
`10006`, Subtask `10007`, Task `10008`, Story `10009`. Project status metadata
and the supplied ticket/human direction establish the following exact mapping:

| Target status          | ID      | Assignment target                |
| ---------------------- | ------- | -------------------------------- |
| To Do                  | `10004` | Agents                           |
| In Progress            | `10005` | Agents                           |
| Code Review            | `10006` | Agents                           |
| Ready For Testing      | `10007` | Agents                           |
| Testing                | `10008` | Agents                           |
| QA Failed              | `10042` | Agents                           |
| Evidence Review        | `10009` | Roy personal account             |
| Approved               | `10010` | **No edit, migration or replay** |
| Deployed to Production | `10011` | Not active; no assignment        |

Agents account: `712020:66c3ccd4-64f2-4056-b92f-9505825f58f6`.
Roy personal account: `70121:29771871-918e-4058-959a-76f07cb45530`.
No status-category inference: Testing's category is Done, but its explicit ID is
in the active set. Approved's category does not make it active. Unknown IDs fail
closed. Names/categories are not accepted input substitutes for IDs.

These mappings are project data, not a rewrite of global squad defaults. Roy
remains the existing config fallback and the explicitly requested implementation
assignee for URL-30. Agent Owner was already Developer and is not edited.

## Implemented local contract

`OfflineOwnershipPolicy(activatedAt, baseline)` accepts normalized typed metadata
only. Baseline capture issues **zero assignments**. It records a per-issue
timestamp floor and permanently protects baseline Approved issue IDs for that
local instance. It does not enumerate Jira, bulk reassign active issues or replay
histories. Only post-fence status-entry events are candidates.

`plan(event, currentSnapshot)` validates exact project/type IDs, numeric issue/
status IDs, account identity shape, required fields and millisecond UTC times.
Malformed inputs produce fixed redacted no-op reasons; invalid baseline throws
only `ownership-baseline-invalid`. This is an object API, not a JSON parser.
There is no untrusted JSON loading or raw Jira payload interpretation.

- Current Approved, baseline-protected Approved and transitions from Approved
  cannot yield edits. Observed current Approved becomes protected for the session.
- Unknown/inactive status, issue/type/status mismatch, duplicate event identity,
  same-status event, pre/equal-fence or out-of-order event and stale observation
  produce no assignment. Event time must exactly match the snapshot's update time;
  later field edits cause a conservative hold, not inference of status freshness.
- Explicit active entry targets Agents; Evidence Review entry targets Roy.
  Evidence Review → In Progress requires exact Roy actor ID; another actor is a
  no-op. This account match is a guard, **not strict human-provenance proof** or
  enforcement of who can transition Jira. Other legitimate active entries are
  status-driven, not a role/identity authorization mechanism.
- Correct current assignee produces no edit. A null assignee can be planned.
- The frozen plan's `fields` contains **only** `assignee.accountId`. It never
  includes status, Agent Owner (`customfield_10043`), labels, comments or updates.
  Agent Owner is uninterpreted optional snapshot data: preserve set/null/unset
  values, never synthesize, clear or normalize it in an assignment payload.
- `assignmentStillCurrent(plan, freshSnapshot)` requires a fresh matching project,
  issue/type/status/update timestamp/assignee, and rejects Approved before a
  simulated edit. It does not compare or overwrite Agent Owner. Assignment is
  not evidence acceptance and never triggers a watcher, Herdr or task execution.

State is **volatile and local**. Plans are consumed locally as observations, not
durable delivered work. There is no persistence/retry receipt or actual assignment
executor. Do not restart a real integration and replay historical events through
this class: persistent protected IDs, checkpoint semantics and verified trigger
delivery would need a separately reviewed implementation/configuration contract.

## Proposed admin/nonproduction contract — not applied

All steps below are prerequisites for later separately authorized work, not
commands or permission to configure this tenant now.

1. **Michael/admin verifies sandbox and permissions:** name the nonproduction
   site/project and issue types, approved automation actor, assignable target
   users, Browse/Edit/Assign capabilities and transition restrictions; inventory
   existing conflicting automation/default-assignment rules, loop behavior and
   actor attribution. Do not alter permissions or grant access to make tests pass.
2. **Approve exact trigger/coverage semantics:** new status transitions only,
   explicit project/type/status IDs, fresh issue reread, exact Roy identity on
   review return, activation boundary, event ordering/idempotency and permanent
   baseline Approved protection. A category, assignee, comment or signature is
   never approval or role authentication. Existing Approved records are excluded
   from every evaluation, test selection and migration; no historical scan action.
3. **Proposed rules for review:** project-scoped status-entry trigger to each
   enumerated active status → assign Agents; entry to Evidence Review → assign
   Roy; Evidence Review return to In Progress → require exact Roy actor, assign
   Agents. Action payload is Assignee only. Guard current Approved, protected IDs,
   unknown mappings, stale observations and already-correct assignee before action.
   No issue-created/bootstrap/scheduled bulk rule or historical replay is proposed.
4. **Resolve race guarantees before live approval:** fresh read is mandatory but
   does not make a later Jira edit atomic. A ticket could become Approved between
   check and assignment. No Jira compare-and-set primitive has been demonstrated.
   Until admin/security proves serialized execution or an equivalent effective
   guard at the write boundary, the absolute no-Approved-write guarantee is
   unverified and live implementation/configuration must remain blocked. Never
   describe local matching timestamps as atomic Jira CAS.
5. **Nonproduction tests after explicit approval:** new disposable test issues,
   every active ID, review/return with Roy and other actors, set/null/unset Agent
   Owner, duplicate/out-of-order events, changed issue before edit, Approved at
   baseline/current/write boundary, conflicting rules and permission failure.
   Confirm actual audit actor and unchanged Agent Owner/history. Record real
   commands/actions, exits/outcomes and tenant evidence; no production fixtures.
6. **Review/release/rollback:** new exact-head Dwight review/CI and Pam merged-SHA
   QA; only an explicitly approved operator may apply reviewed tenant configuration.
   Rollback disables only the new rules; no historical Approved restoration/replay,
   blanket reassignment, permission change or watcher activation. Reconcile any
   active assignment repair individually under separate authorization.

## Exact live verification blocker

No approved nonproduction Jira site/project, test-rule administration scope or
write-boundary serialization/CAS evidence was supplied or verified. Existing
interactive MCP issue access does **not** demonstrate automation-admin access,
rule actor capabilities, sandbox availability, assignability for every issue type,
absence of conflicting rules or effective transition restrictions. This turn does
not probe configuration/admin endpoints or request credentials. Michael/admin
must establish and authorize those prerequisites before live configuration/testing.

**BLOCKED:** actual tenant automation enforcement and full live acceptance. Local
unit/integration tests prove only planner plus in-memory adapter-contract behavior.
No actual Jira rule was configured or tested. URL-30 coordination (human assignee,
In Progress/Code Review, unchanged Developer owner) is separate from policy rollout.
No Evidence Review transition or final acceptance claim is made by Ryan.

## Executed developer verification — 2026-11-08

New isolated branch `feature/jira-ownership-handoff` from main
`68bef6e` (full base SHA recorded by the PR). No existing tracked file is edited;
the planner, two test modules and this report are the only additions. An initial
test-fixture TypeScript literal-inference error was corrected by explicitly typing
the mutable mock snapshot; the final commands below were rerun afterward.

| Command                                                                                                                                                                          | Actual exit/result                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `npm ci`                                                                                                                                                                         | 0; no lockfile/dependency change                                                                                          |
| `npm run lint`                                                                                                                                                                   | 0                                                                                                                         |
| `npm run check:naming`                                                                                                                                                           | 0                                                                                                                         |
| `npm run typecheck`                                                                                                                                                              | 0; includes the new script/tests                                                                                          |
| targeted policy coverage command below                                                                                                                                           | 0; **40 tests**, 2 files; policy statements 100% (52/52), branches 100% (56/56), functions 100% (5/5), lines 100% (48/48) |
| `npm run check:watcher-offline`                                                                                                                                                  | 0; unchanged Python syntax/capability checks                                                                              |
| `npm run test:watcher-offline`                                                                                                                                                   | 0; **58 tests**; unchanged separate watcher                                                                               |
| `npm run test:coverage`                                                                                                                                                          | 0; **2,346 passed / 10 existing DB tests skipped**, 22 files passed / 1 skipped                                           |
| `npm run build`                                                                                                                                                                  | 0; existing application build; planner is source-only, separately typechecked                                             |
| `npx prettier --check scripts/jira-ownership-policy.ts tests/unit/jira-ownership-policy.test.ts tests/integration/jira-ownership-handoff.test.ts docs/jira-ownership-handoff.md` | 0                                                                                                                         |
| `git diff --check` and staged diff check                                                                                                                                         | 0                                                                                                                         |

```sh
npx vitest run tests/unit/jira-ownership-policy.test.ts \
  tests/integration/jira-ownership-handoff.test.ts \
  --coverage --coverage.include=scripts/jira-ownership-policy.ts
```

The targeted command instruments the planner explicitly; the unchanged repository
coverage command still measures `src/**` and enforces existing thresholds. No
coverage setting/gate or workflow was relaxed. Coverage is local code evidence,
not a claim of exhaustive races or actual Jira configuration enforcement.

Tests cover every explicit active target, Evidence Review, exact Roy return,
other actor rejection, current/baseline Approved protection including reopening,
historical/equal-fence/no-op/duplicate/out-of-order events, project/type/status/
identity/field-shape errors, current-assignee idempotence, null assignee, invalid
baseline, frozen Assignee-only payloads and fresh-read mismatches. In-memory
handoff/return integration checks preserve Agent Owner object identity, null and
unset values. The fake read-before-edit integration discards a plan when the
fresh status is Approved; it does not simulate an atomic production write.

Whole-repository formatter failures previously documented on main are outside
this PR; only touched-file formatting is claimed here. No live nonproduction or
production rule/configuration/permissions tests were executed. **Live acceptance
remains BLOCKED** by the prerequisites above, regardless of green local checks.

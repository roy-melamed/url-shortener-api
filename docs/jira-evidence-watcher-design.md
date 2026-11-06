# Jira evidence watcher — architecture and activation gates

**Author:** Dwight — Software Architect and Code Reviewer

**Date:** 2026-11-05; phase authorization updated 2026-11-06

**Tracking only:** [URL-29](https://melamed.atlassian.net/browse/URL-29)

**Verdict:** **DESIGN READY FOR SAFE OFFLINE IMPLEMENTATION; LIVE INTEGRATION/ACTIVATION BLOCKED** by §12. The human explicitly authorized the bounded offline phase on 2026-11-06 (§1.1). This does not approve production identities, live integrations, services, deployment or QA acceptance.

## 1. Scope, evidence and invariants

Prepared in isolated worktree `/tmp/opencode/jira-evidence-watcher-design`, branch `design/jira-evidence-watcher`, based on main `9d7f878335c7f950940c6631e50ba43c5f3191fc`. The 2026-11-06 direction authorizes a **design-document-only commit** on this branch before Ryan begins the safe offline phase. The dirty feature checkout is not edited. This architecture task makes no code changes, Jira operations, Herdr prompts/events, service operations, session changes or PR; committing this document does not implement or activate the watcher.

Inputs: approved immutable `PRD.md`; `specs/url-shortener-api/requirements.md`, `design.md` and `squad.config.json`; tracked `AGENTS.md`; `docs/naming-and-identifier-policy.md`; assigned architecture brief. The watcher is squad coordination infrastructure, not a URL-shortener feature or a revision to product acceptance criteria. AD-16/17 and the delivery safeguards remain binding.

Service/domain name **`jira-evidence-watcher`**: purpose = observe evidence acceptance, owner = engineering squad; lifecycle = operator-managed coordination service. No tracking key/person name generates a durable technical identifier. Existing application/database/backup/container/network/volume names are compatibility constraints, never migration targets of this work.

### 1.1 Explicitly authorized phase: safe offline implementation

**Human direction, 2026-11-06:** Ryan may implement the following bounded offline phase now, without waiting for the separate security/operational approvals in §12. Dwight's current assignment is only to finalize and commit this design document, not implement that code. This authorization supersedes the earlier blanket implementation block **only** for the scope below; it is not blanket approval of the full operational architecture.

| Implementable now | Required offline boundary |
|---|---|
| Parser and identity-allowlist validation | Pure parsing/classification of synthetic Jira histories and explicit fixture configuration; exact account/project/status IDs, negative and malformed-input cases, no display-name/signature trust. Candidate production account IDs remain unapproved for production use. |
| SQLite activation fence, stable event identity/dedupe and durable outbox | Disposable local test databases; atomic scan/event/outbox/watermark transactions, bootstrap/no-historical-replay and crash/restart recovery. A simulated fence is not a production activation fence; no operational ledger is armed. |
| Mock-only polling/reconciliation | Injected in-memory/file-fixture sources and fake clock/retry responses; pagination, overlap, delayed visibility, complete/reopen and reconciliation behavior. No production Jira auth/client integration, network calls or credential discovery. |
| Simulated Jira-history tests | Offline fixtures/fault injection for the authorized parser/store/mock scanner and privacy/safety invariants; no actual transitions, agent execution, prompts or external delivery. Local fixtures/fakes are not live-integration or operational acceptance evidence. |

**Still blocked, including implementation/integration in this phase:** production Jira authentication/client integration and all live Jira calls (including read-only discovery/preflight); Herdr delivery/consumer integration and prompts/events; credential provisioning; OS service/unit files or other host-service configuration, installation, enablement, startup/restart and lingering; and any deployment. Do not add a live adapter behind a disabled flag, automatic network fallback, bridge/consumer socket integration or disabled service template and count it as offline work. Later-phase proposals in §§2, 5, 8–10 remain architecture descriptions only.

The offline executable/test path must be capability-free with respect to Jira and Herdr: fixtures only, no credentials, no subprocess/session control, no network client fallback, no runtime writes outside disposable watcher-test state. Fail closed on unsupported inputs. Pending outbox records may be inspected/asserted locally, **never drained to a real recipient**. Use clearly synthetic site/project/status/actor identifiers for successful fixtures; any config-derived account ID may be tested only as provisional data, not promoted to a production allowlist. A matching account ID demonstrates classification mechanics, not strict human provenance under shared credentials.

Offline completion requires reproducible commands/exit codes and fixture assertions covering the permitted invariants, followed by normal implementation PR/exact-head review/CI and merged-code QA safeguards. It cannot claim Jira connectivity, live event completeness, Herdr delivery/acknowledgement, production human provenance, service readiness or deployment acceptance. Security/operational gates do not block writing/testing this bounded offline code; they **do** block expansion beyond it.

### Hard safety contract

1. Jira **Done means evidence accepted only**. A qualifying history item produces a typed **reconcile notification**, never a command, deployment authorization or unconditional continuation instruction.
2. The watcher cannot transition/comment/edit Jira, change Agent Owner, deploy, merge, delete, migrate, modify application data/resources or fan out work. Only its own private operational ledger/outbox/backup files are writable. Its HTTP client has an exact read-operation allowlist (§2), including read-only search POST; all other methods/routes are denied.
3. Michael alone reconciles fresh workflow/dependency/GitHub state, chooses already-authorized non-destructive eligible work, and uses the normal squad review/CI/merge/QA gates. The notification does not widen his permissions. No agent performs Evidence Review → Done.
4. Production requires separate explicit human approval of the **exact artifact/commit and target environment**, regardless of Jira state or previous approval. No watcher payload authorizes destructive work, database changes or production deployment.
5. No issue text, description, comment, attachment, arbitrary URL, shell fragment or actor display name enters a prompt template, command argument, log or executable decision. Treat all Jira content as untrusted data. A fixed template plus bounded validated identifiers is the entire notification.
6. Never start, restore, fork, restart, rename, move or replace Michael/OpenCode/Herdr sessions. Absence, ambiguity, blocked state or identity mismatch means queue and alert, not “repair by launching another Michael.”

### Guarantee, with honest limits

- Durable local ingestion/outbox and **at-least-once notification with idempotent consumption**, not exactly-once Herdr prompting or exactly-once arbitrary agent side effects.
- Every visible, retained, qualifying history after a fixed activation fence is eventually ingested under eventual Jira visibility, stable permissions, eventual connectivity, sufficient scan capacity and intact durable state. Overlap plus complete reconciliation handles delayed indexing and restart gaps.
- REST search is not a transactional event log. Issues deleted/hidden/archived/moved out before discovery, removed history, indefinite index lag or a compromised shared human account defeat an unconditional “no lost human events” guarantee. These are activation-contract constraints, not silent PASS conditions. If unconditional audit capture is required, add an owner-approved source-side durable event/audit feed with retention; polling alone is insufficient.

## 2. Jira identity, credentials and exact REST contract

**No live Jira discovery is executed for this document.** IDs not in project config remain undiscovered; implementation must discover/validate them during an explicitly authorized read-only preflight, record them, and fail closed on ambiguity.

### 2.1 Pinned scope and actor policy

Read the reviewed deployed copy of `specs/url-shortener-api/squad.config.json` (not a mutable feature checkout):

| Setting | Initial proposal / source |
|---|---|
| Site | `https://melamed.atlassian.net` — `jira.site` |
| Project key | `URL` — `jira.projectKey` |
| Initial candidate human account allowlist | `{ "70121:29771871-918e-4058-959a-76f07cb45530" }` — `jira.defaultAssignee.accountId` |
| Agent Owner metadata | `customfield_10043`, Human option `10025`; never used to authenticate the actor |
| Project numeric ID | **Undiscovered**, pin only after authorized `GET /rest/api/3/project/URL` |
| Evidence Review and Done status IDs | **Undiscovered**, discover per issue type via `GET /rest/api/3/project/{projectId}/statuses`, human-review exact mappings |

The configured assignee supplies a **candidate**, not proof of human authorship or approval. Require owner confirmation of the allowlist and human-only control of those identities. Match `history.author.accountId` exactly; reject missing/anonymized authors, app/service principals and non-allowlisted accounts. Never use `displayName`, email, comment signatures, assignee, status category or Agent Owner as actor authentication. Status item must have system `fieldId="status"` and pinned `from`/`to` IDs for Evidence Review → Done. `fromString`/`toString` are diagnostics only, not identity. Multiple status IDs with the same name require explicit mapping; no generic category `done` match.

**Critical identity blocker:** existing shared agent/human Jira credentials can attribute an agent transition to the allowlisted owner account. Changelog account ID then cannot distinguish human UI action from automation/API use. Strict human-only triggering requires the allowlisted human identity not be usable by agents/automation, with separate nonallowlisted machine principals and suitable permission policy. “Agents promise not to transition” is defense in depth, not independent authentication. If credentials remain shared, the strict requirement is unverified and automatic dispatch stays disabled; a signature or extra owner-looking comment does not solve it.

Revalidate project/status mappings on startup and daily; a key rename, unexpected project ID, removed/replaced status or issue-type workflow change pauses classification/delivery and alerts. Reviewed config version/hash is persisted with decisions; config changes never silently expand allowlists or replay old history. New configuration requires explicit operator approval and existing pending-event revalidation, not state deletion.

### 2.2 HTTP operations and pagination

Base = the pinned site for a separately approved scoped API token, or `https://api.atlassian.com/ex/jira/{verifiedCloudId}` for an approved OAuth/scoped-token flow that requires the gateway. Cloud ID is not guessed. Do not send a token to a host supplied by an issue, redirect, response `self`, `nextPage` or command-line argument. Validate TLS, disable cross-origin redirects, bound responses and timeouts. Build paths using validated numeric issue IDs, not untrusted `self` URLs.

**Future preflight/read allowlist:**

- `GET /rest/api/3/myself` — validate authenticated machine principal and its timezone; it must not be an allowlisted human principal.
- `GET /rest/api/3/project/URL` and `/rest/api/3/project/{projectId}/statuses` — pin project/status mapping across issue types.
- Optional operator-only `GET /rest/api/3/user?accountId={encodedId}` — identity confirmation if Browse users and groups permission is approved; not needed per poll. Failure to obtain optional user lookup never changes author matching to names.
- `POST /rest/api/3/search/jql` — **enhanced search**, not deprecated `/search`; read-only operation despite POST.
- `GET /rest/api/3/issue/{numericIssueId}?fields=project,status,updated,issuetype` — fresh project/type/current status validation.
- `GET /rest/api/3/issue/{numericIssueId}/changelog?startAt=0&maxResults=100` and subsequent pages — authoritative history extraction. Do not rely on truncated `expand=changelog`.

Example **template**, substitute only internally generated UTC boundaries and verified numeric project ID:

```json
{
  "jql": "project = <projectId> AND updated >= \"<L:yyyy-MM-dd HH:mm>\" AND updated <= \"<U:yyyy-MM-dd HH:mm>\" ORDER BY updated ASC, key ASC",
  "fields": ["project", "status", "updated", "issuetype"],
  "maxResults": 50
}
```

Here `L = max(activation fence rounded down, last_completed_upper - 15 minutes)`; `U = trusted current time minus 60 seconds`, rounded down to a minute. Persist the frozen request boundaries per scan. The JQL account must use UTC, verified from `/myself`; otherwise preflight blocks until approved timezone handling is configured/tested (never change Jira preferences automatically). Exact timestamp eligibility uses full UTC changelog timestamps, **not** minute-rounded JQL strings. Upper-bound exclusion due to an issue being updated again is picked up at its new `updated` timestamp by later scans/reconciliation.

**Never add current `status = Done`** or `resolution` or assignee filters. A human may complete then reopen before a poll. An optional history-based JQL optimization is not the correctness source; the design scans actual histories for all candidate issues.

For search, carry the same body, ordering, fields and boundaries through every page, adding the returned opaque `nextPageToken`. Honor actual API page sizes; do not infer completion from “fewer than 50.” Stop only at documented last-page/no-next-token completion, validate contradictory `isLast`/token states, reject repeated tokens/nonprogress. Token expiry restarts the same scan window with deduplication. `reconcileIssues` is limited to 50 known IDs and consistent across pages; it cannot discover unknown issues or guarantee global index consistency. The baseline design does not depend on it.

For each candidate, validate `fields.project.id == pinnedProjectId` and allowed issue type before fetching history. Page changelog from oldest (`startAt=0`, `maxResults=100`); consume `values`, stable history IDs, `created`, author ID, and only status items. Advance using returned `startAt + len(values)`; use `isLast`/reported total consistently, continue until complete, and treat empty nonterminal/repeated/nonprogressing pages as incomplete. History grows concurrently: exact event dedupe plus overlapping complete rereads covers appends; deletions/reordering trigger reconciliation/hold, not a trusted timestamp-only tail cursor. No assumption that changelog IDs are globally contiguous/numerically time-ordered.

Re-read issue metadata after history extraction. If `updated`/project/type changed, queue a reread; do not certify that the old current-status observation is still current. A status event can be retained as an observed fact even when superseded. Unknown schemas, missing IDs, multiple contradictory status items or unparsable timestamps are quarantined without dispatch.

Full reconciliation query (all pages, no status/time lower bound):

```json
{
  "jql": "project = <projectId> ORDER BY key ASC",
  "fields": ["project", "status", "updated", "issuetype"],
  "maxResults": 50
}
```

Perform it hourly and after restart/permissions recovery; fetch complete changelogs for all visible project issues and previously known issue IDs. A known ID that is no longer returned must be checked directly; 403/404 is an explicit coverage gap. Current project membership must match before notification. If moves are permitted, require reliable historical project-membership reconstruction from retained move/project history; ambiguous membership at event time is quarantined. An issue moved out before first discovery is an acknowledged polling blind spot. Activation must either forbid such removal/moves before reconciliation or approve a stronger source-side capture mechanism. Archived/restricted issues need an explicit visibility/retention policy; search silence is not evidence of complete access.

### 2.3 Credentials and permissions

Preferred: owner-provisioned dedicated nonhuman read-only principal with Browse Projects and required issue-security visibility **only for this project**, no Transition/Edit/Delete/Deploy/Admin capabilities; expired/revoked access is a blocker. Scopes do not replace Jira permissions. Endpoint allowlisting is additional defense.

For OAuth, documented classic scope union for the core routes is `read:jira-work`; `/myself` and optional identity lookup add `read:jira-user`; `offline_access` is needed only for a reviewed refresh-token flow. No `write:*`, `manage:*` or administration scope. Granular scopes are endpoint-specific: enhanced-search currently lists `read:issue-details:jira`, `read:field.default-value:jira`, `read:field.option:jira`, `read:field:jira`, `read:group:jira`; changelog lists `read:issue-meta:jira`, `read:avatar:jira`, `read:issue.changelog:jira`; project/status/identity routes add their published read scopes. Provision against the exact API contract and test the complete union; do not assume `read:issue.changelog:jira` alone suffices. Classic read scopes are simpler, with project restriction through principal permissions. If project/user discovery requires excessive scope, an operator supplies reviewed immutable discovery output instead of widening the daemon.

API-token alternative: separately approved scoped expiring token/identity, route appropriate to that token, read-only scopes and project permissions verified. Basic authentication email/token, OAuth refresh token/client secret and access token stay in a protected secret store, not source/config/argv/logs. **Interactive Atlassian MCP consent/session credentials are not daemon credentials**: do not scrape OpenCode/MCP OAuth storage, export the human's token, assume consent grants unattended use, or trigger an interactive flow from a service. Owner must select and provision a supported unattended authentication flow, rotation/revocation procedure and credential custodian. None is supplied or accessed here.

Use systemd credentials (§8) or an owner-approved secret source; secrets read from a descriptor/credential file, not `Environment=` or command arguments. Pin allowed endpoint origins; no insecure TLS bypass. Refresh atomically, serialize refresh-token rotation, persist new rotated tokens before retiring the previous state according to provider contract; an uncertain refresh result holds/alerts. Do not silently fall back to interactive/shared credentials.

## 3. Bootstrap, restart, overlap and reconciliation

### 3.1 First activation: fixed future fence, never “mark everything seen now”

1. Installation/read-only validation is not activation. Complete identity, scope, permission, mappings, consumer and runbook gates while dispatch is disabled.
2. In one durable transaction create an immutable installation/epoch record, config hash, `mode=BOOTSTRAP`, and a **future UTC activation fence A** (e.g. next whole minute at least 5 minutes ahead). Persist it **before** scanning and before A. The operator approves the fence, using a synchronized trusted clock cross-checked against Jira HTTP Date (not claiming the HTTP Date is a transactional event sequence). If clock offset exceeds 5 seconds or uncertainty crosses A, hold the boundary events for operator reconciliation; no fabricated exact cutoff.
3. Complete a project inventory and full-history scan, streaming only minimal normalized metadata. Classify all history with `created < A` as historical/non-dispatchable. **Never** set the baseline to the end of a long initialization scan: events at/after A discovered during initialization must enter the staged event/outbox path, not be absorbed into baseline.
4. Scan again over the activation boundary and perform full reconciliation after A. Events with `created >= A` qualify even on issues already Done, newly created, or reopened during bootstrap. Exactly equal timestamps are included and deduped by event identity, not by `created > lastSeen`.
5. Enter `ACTIVE` only after bootstrap inventory completion, verified coverage and durable consumer readiness; pending qualifying events since A can then dispatch. A delayed/failed bootstrap resumes the **same A**, not a new “now.” If delayed visibility later reveals old history `< A`, suppress it permanently. Retain A across all restarts/upgrades/backups. A new epoch is an explicit reviewed operator decision, never automatic recovery.

This defines “no historical replay” as no dispatch of transitions earlier than the approved A. Acceptances during preflight before A are deliberately outside the service activation interval; communicate this to the human. Polling cannot retroactively provide an atomic initialization boundary without either a timestamp/visibility contract or source-side sequencing.

### 3.2 Normal operation and outages

Poll every 60 seconds with 0–10 seconds schedule jitter; one tenant poller, one scan at a time. Use the fixed lagged upper watermark U and inclusive overlap L from §2. A watermark is **completed scan coverage**, not a claim that Jira indexing can never reveal older changes. No cursor advancement to wall-clock “now,” maximum returned `updated`, newest status event or an incomplete last page.

After an outage resume from persisted watermark minus overlap, with bounded sequential windows if backlog is large; do not discard the outage interval or reset the fence. Prioritize current incremental windows and fairly interleave full reconciliation, using durable scan progress. Sweep all project histories hourly so eventual search lag beyond overlap does not permanently lose retained visible events. Full sweep always applies the original A; it never dispatches older approval histories. Inventory changes and access regressions are explicit anomalies. An incomplete sweep cannot be reported healthy.

Search pagination is not promised to be a snapshot. Concurrent updates may move candidates between pages/windows. Repeated overlapping scans, direct refresh of known IDs and complete sweeps are required; timestamp order alone is insufficient. Continuous overload, disappearing issues or indefinite lag void the no-loss assumption and alert. Page/request budgets pause/resume rather than silently truncate; backlog age is measurable.

### 3.3 Complete then reopen, and later approvals

Example: Evidence Review → Done at t1 by allowlisted human, Done → In Progress at t2, poll at t3. Both retained status histories are read even though current status is not Done. Persist the t1 acceptance event and mark its observation `superseded`; **notify only the qualifying acceptance fact**, with a fixed “reconcile; current state may differ” instruction. This event grants no resumption authorization. No separate reopened-event prompt is emitted by this service.

Michael checks the complete relevant fresh status sequence and current project/status before resuming anything. A t1 event superseded by reopening is acknowledged as `no_action_superseded`; he must not treat it as a currently satisfied dependency. A later Evidence Review → Done at t4 is a different history/event ID and can prompt a new reconciliation. A later Done reached by some other status path/actor is not interchangeable with the original human acceptance. Race after any recheck is still possible: revalidate at task-claim/delegation and all existing workflow gates; no destructive operation can rely on the notification.

## 4. Durable state and atomicity

### 4.1 Storage choice and proposed schema

SQLite on local persistent disk, not NFS/tmpfs/repository checkout. Low volume favors a single-writer embedded DB over a new DB service. Python 3.12 standard-library `sqlite3` is proposed for the standalone daemon/bridge: no application runtime dependency changes. Python 3.12.3 is present on this VM; runtime/SQLite versions and security updates must be pinned/verified at implementation. Do not create a shared writable database between different service users.

Poller owns `watcher.sqlite3`; the bridge owns a separate `consumer.sqlite3`. Enable foreign keys, WAL, `synchronous=FULL`, a bounded busy timeout (5s), schema-version checks, and a process-held nonblocking file lock for the entire daemon lifetime. SQLite WAL durability still relies on fsync-capable persistent storage. Never run two hosts against the same files. Schema below is a design contract, **not executed DDL**; columns have NOT NULL except explicitly optional fields and bounded lengths/check constraints in implementation.

| Table | Key and important fields / constraints |
|---|---|
| `watcher_state` | Singleton: schema version, installation UUID, site identity/cloud ID, pinned project ID, immutable A, reviewed config hash/version, mode, `completed_upper_utc`, last full reconciliation, monotonic revision. Separate completed watermark per project/installation; no multi-project default. |
| `scan_runs` | Scan UUID, kind bootstrap/incremental/full, frozen L/U/request hash, next page token (optional), state in-progress/complete/applied/failed, start/end, error code only. |
| `scan_issues` | PK `(scan_id, issue_id)`, project/type, observed updated/status, changelog paging progress/completion, needs-reread flag. |
| `staged_status_items` | Unique `(scan_id, issue_id, history_id, field_id, from_id, to_id)`, event UTC, actor account ID, validated normalized metadata/coverage only. No raw history/body/description. |
| `processed_events` | PK `event_id`; unique `(site_identity, issue_id, history_id, field_id, from_id, to_id)`; event UTC, A/config version, actor ID (optional after expiry), classification eligible/historical/actor-rejected/quarantined, reason enum, first/last observation, superseded observation. |
| `notification_outbox` | Unique FK `event_id`, payload schema version/hash, pending/leased/awaiting-ack/acked/held, next-attempt, attempt count, lease owner/token/expiry, target binding version, final disposition/ack UTC. Never delete unacknowledged events on retry exhaustion. |
| `delivery_attempts` | Attempt UUID, FK event, random nonce digest, binding/session ID, lease fencing generation, start/deadline, result submitted/definitely-rejected/uncertain/acked, bounded error enum. No terminal transcript. |
| `operational_faults` | Random fault ID, category, first/last occurrence, count, alert state; no secret, issue content or HTTP body. |
| bridge `consumer_receipts` | PK event ID; payload hash, site/project/epoch, target session/binding, acceptance/ack states, durable timestamps. Hash mismatch for same ID is a security fault. |
| bridge `work_intents` | Unique `(event_id, work_identity)` plus **unique active work identity independent of event**; claim state/lease/fencing token, existing task/session reference, outcome, needs-reconciliation. No automatic rerun after an uncertain external side effect. |

`event_id = SHA-256(canonical length-delimited [version, site_identity, numeric_issue_id, history_id, "status", from_status_id, to_status_id])`. Store original composite under a unique constraint as well as its hash; do not use issue key, timestamp, display name or polling run as identity. Include distinct status-item tuple if one history contains multiple items; contradictory status items are quarantined. History IDs are opaque strings. Issue keys are tracking data, not database identity or executable routing. Never reset event IDs when reinstalling; installation UUID is **not** part of the event hash.

### 4.2 Atomic ingestion/cursor transaction

HTTP calls occur outside write transactions. Persist page staging/progress transactionally; crashes can restart any page. No partial page or inconsistent scan becomes complete. Once every required search/changelog page and reread is complete, a single `BEGIN IMMEDIATE` transaction:

1. Recheck config/epoch and completed-scan preconditions using state revision.
2. Insert normalized decisions into `processed_events` with conflict dedupe; for newly eligible, nonhistorical accepted-source records insert exactly one `notification_outbox` row in the same transaction. Quarantine is not eligible. Duplicate event rows must match stored canonical facts.
3. Update inventory/checkpoint and `completed_upper_utc = U` for the incremental scan, or full-reconciliation checkpoint for a full scan; mark the scan applied. Commit all or none.

Thus no advanced cursor can exist without its event decisions/outbox, and no committed eligible event lacks its outbox. A failed page leaves the old completed cursor; staged rows are not dispatched. Disk full, corruption, failed fsync or wrong schema prevents commit and dispatch, preserves old state and alerts. On recovery validate integrity/config; do not rebuild an empty DB automatically.

### 4.3 Crash windows and delivery states

| Failure point | Required recovery |
|---|---|
| Fetch/staging before ingest commit | Old cursor retained; refetch/reread, event identity dedupes. |
| After ingest/outbox commit, before delivery | Pending outbox survives reboot. |
| After lease/attempt commit, before prompt | Expired lease becomes **uncertain**, not assumed unsent; inspect durable receipt/reconcile before retry. |
| Prompt sent, timeout/crash before result persisted | Uncertain delivery; never mark acknowledged from exit code or idle state. Retry only same event after receipt check; no duplicate execution via consumer uniqueness. |
| Herdr says submitted, Michael has not accepted | Awaiting ack; alert on age. Prompt submission is not acceptance or task completion. |
| Michael acceptance committed, remote outbox ack lost | On retry consumer returns the same receipt; poller idempotently records ack. |
| Work intent committed, delegation happened, result unknown | Hold `needs_reconciliation`; inspect existing tasks/sessions/effects. Do not delegate again because a timer expired. |
| Reboot/restore after successful notification | Same event hash/consumer record prevents execution again; reconcile both stores before enabling dispatch. |

Outbox delivery and Herdr cannot share a transaction; **exactly-once prompting is not claimed**. Submission may be duplicated. Durable consumer acceptance plus work-intent constraints provide effectively-once scheduling only where actions are idempotent/reconcilable. Arbitrary external agent actions are not transactional: uncertainty requires a hold/operator or Michael reconciliation rather than automatic replay. No unsafe TTL-based “probably complete” decision.

## 5. Herdr targeting, acknowledgement and safe continuation

### 5.1 Existing binding and preconditions

Read-only inspection on 2026-11-05 found Herdr **0.9.3**, protocol **22**; local registry `/home/ubuntu/.config/herdr/ai-squad-sessions.json` is mode 0600. Registry and live `herdr agent list/get michael` agree on existing pane `w1:p2`, session **`ses_e786808ecfferXgczBsL6jkb2b`**, workspace `w1`, project directory `/home/ubuntu/projects/ai-squad`. `herdr pane process-info --pane w1:p2` shows `opencode --session` with that exact ID. State was working; this is an observation, **not permission to prompt now** or a permanent identity guarantee. No session/pane was modified for this design.

Future bridge accepts an operator-reviewed binding copied from that registry. Before **every** attempt, using fixed absolute CLI path and argv (or equivalently verified typed socket API), check:

1. Exactly one live agent matches the binding's session ID, workspace and pane; registry matches the pinned binding version. Name “michael” alone is insufficient. Pane IDs can be reused after reboot; never auto-follow a name to another session.
2. Live process-info matches the same existing OpenCode session/process identity and approved directory. No shell/login screen/password prompt/permission form/model-provider login may be mistaken for an agent. Require verified interactive readiness and a real current state; Herdr's idle fallback is not proof of readiness/completion. Unknown, blocked or ambiguous detection holds delivery. Prefer idle/done **and** independently verified readiness; do not steer a working turn by default.
3. Acquire the bridge single-sender lock and a versioned event lease; recheck binding immediately before prompting and after submission. Do not prompt to a pane by numeric ID without those checks.

Herdr's observed `AgentPromptParams` has only `target`, `text`, optional `wait`; no expected-session/CAS or idempotency/consumer-ack parameter was found. Therefore metadata-check → prompt has a TOCTOU race. **Activation gate:** a cooperative routing lock respected by all pane/session managers must cover verification through submission, and the receiver validates intended session before claiming work. If that coordination cannot be guaranteed, unattended Herdr delivery remains disabled until a reviewed expected-session-bound transport exists. Post-send verification can detect a race, not undo a misrouted prompt. Do not disguise this as an atomic identity guarantee. Payload is intentionally harmless even if misrouted; an unintended session must reject the claim.

No OpenCode API fallback, session auto-discovery/start, background-service auto-start, restore script or `opencode --session` launch is part of the watcher. OpenCode V2's API docs expose existing-session prompt/message routes, but integration compatibility and auth are unverified here; using its client discovery may start a background service. That is not an allowed “helpful” recovery path. Changing transport requires separate review.

### 5.2 Bounded notification and subprocess safety

Future bridge invokes the discovered/pinned `herdr` executable using a subprocess **argv array, shell disabled**, with fixed verbs and validated bound target. Do not construct `/bin/sh -c`, interpolate a Jira field, use command substitution, or send terminal paste/key sequences. Conceptual argv (not executed):

```text
["/home/ubuntu/.local/bin/herdr", "agent", "prompt", "w1:p2", fixed_template_plus_validated_envelope]
```

Template says: “Evidence-acceptance event observed; NOT deployment/destructive authorization. Intended existing session: <pinnedSession>. Claim this event via the local receipt interface, reconcile fresh Jira/dependencies/evidence, then acknowledge; duplicates must not execute work twice. Do not start a new session.” Envelope contains schema version, event SHA-256, numeric issue ID, validated project key, history ID, UTC event time, expected session/binding version and random per-attempt nonce. Optional browse URL is **constructed** from pinned site plus validated issue key, never copied from Jira. No summary/description/comments/links or human display name. Do not send the raw actor account ID unnecessarily; receiver can fetch authoritative history.

Maximum UTF-8 payload 2 KiB; reject unknown fields, control/escape characters and oversized/invalid IDs rather than truncating identities. Fixed template is not derived from Jira prose. Allow only needed environment variables; set known cwd/HOME and Herdr config/socket context under the approved user, not inherited arbitrary `HERDR_*`, proxy or shell settings. Pin trusted executable owner/hash/release; never `npm install`/`pip install` or update tools at runtime.

Bound invocation to 15 seconds and bounded stdout/stderr (e.g. 64 KiB, parsed in memory, never journaled verbatim). Do not use `--wait` as proof of this prompt's completion: it can observe an already-working turn. `agent_prompt_stalled`, process timeout, broken pipe and post-submit identity drift are **uncertain**, not reasons for immediate resend. A definite pre-submit `agent_blocked` can be queued without claiming delivery. Cap one outstanding notification per bound consumer; aggregate only a fixed “N pending” health signal, not unbounded prompt batches.

### 5.3 Receipt protocol — proposed, not an existing Herdr capability

The poller exposes a narrow local Unix socket (`/run/jira-evidence-watcher/control.sock`) to the approved bridge UID only, using filesystem permissions and `SO_PEERCRED`. Protocol only leases typed outbox envelopes, returns existing receipt state and accepts idempotent ack/hold results. No arbitrary SQL, prompt text, shell execution, session selection, URL fetch or “run task” RPC. Per-attempt nonce and fencing token bind response to event/payload/session/binding; expired attempts cannot overwrite newer decisions. Already accepted event IDs return the stored acknowledgement even when the attempt nonce changes.

The bridge exposes a separate private local consumer interface to Michael, with fixed subcommands proposed in §9: `accept`, `ack`, `status`. Before making any task decision Michael invokes `accept` with event ID/attempt nonce/intended existing session; the helper rechecks live binding and atomically inserts or reads `consumer_receipts`. A uniqueness conflict returns “already accepted” and the existing reconciliation/work state; it must not resume work again. `accept` is admission, not success; `ack` after reconciliation records `no_action_superseded`, `no_action_already_satisfied`, `eligible_intents_recorded`, or `blocked_reconciliation`. Ack contains no Jira prose. The bridge durably commits the receipt before returning an authenticated transport ack to the poller.

**This local helper/ack interface does not exist today and is a prerequisite**, not a claim that Herdr already implements it. Socket/nonce/UID authenticate the local caller and attempt, not an independent model/role identity under shared Unix credentials. Same-UID compromise can forge receipts; receiver role/session checks are enforced by policy plus controlled local binding, not cryptographic agent identity. If independent agent authentication is required, use a narrowly authenticated broker/agent integration and review it before activation.

On no acknowledgement after 5 minutes: query the consumer ledger; if absent, reverify binding/routing lock and schedule the **same event ID**, not a new event. At most 3 automatic submission attempts with jittered 5/15/30 minute delays; then hold and alert, preserving pending state. Michael busy/unavailable queues do not burn send-attempt counts. On an accepted-but-incomplete receipt, do not re-prompt execution; alert Michael/operator to reconcile the existing claim. Terminal text, echoed prompts, agent idle flags and a bare printed ACK signature are never durable acknowledgement.

### 5.4 Resume only eligible existing work

Michael's consumer sequence is mandatory: durable accept → authoritative current Jira project/status/history and relevant evidence/dependency reads → record reconciliation decision/work intents → idempotent ack. He verifies that the specific acceptance still applies, all blocking dependencies are currently satisfied and the intended next action is within existing approved scope. A shared event never globally unblocks the backlog.

For each eligible task, create a canonical `work_identity` from stable issue/task identity plus the approved work revision/action, not from the triggering event alone. Enforce a single active intent and existing agent/session association; inspect the actual agent and existing task record before delegation. Multiple Done events/dependencies cannot create parallel copies of the same task. After uncertain delegation, reconcile the existing session/result instead of spawning a replacement or retransmitting execution. Non-idempotent/destructive actions are excluded altogether. Michael still routes every implementation PR to Dwight and verifies exact-head gates; Pam alone owns merged-code acceptance. No automatic final Jira acceptance/Done transition is introduced.

## 6. Rate limits, failures, health and alerting

Proposed low-volume budget: one in-flight Jira request, average ≤6 requests/minute (token bucket burst 2), normally one search/minute plus changed-issue pages; reconciliation fairly shares the budget. Keep page sizes 50 search / 100 changelog and measure actual requests/response limits. Backlog capacity/issue count must be validated; no claim the budget fits an arbitrarily large project. Timeout: connect 5s, response 20s; response size ceiling (e.g. 2 MiB/page) is a fail/hold, not a truncated successful page. No live rate-limit stress tests.

| Condition | Policy |
|---|---|
| HTTP 429 | Respect valid `Retry-After` as a minimum (seconds; defensively accept valid HTTP-date), plus nonnegative jitter. Persist tenant `not_before` so reboot cannot defeat it; honor rate-limit reset metadata when stricter. Pause tenant requests conservatively. Never cap a large server delay down to the local backoff ceiling. |
| Timeout/DNS/reset/408/5xx | Bounded exponential backoff with full jitter: uniform(0, min(300s, 2s × 2^attempt)); valid Retry-After on 503 remains a minimum. At most 5 request attempts per cycle, then durable deferred retry, no lost cursor/event. Circuit opens after repeated cycles; recover with one probe, not parallel bursts. |
| 401 / expired secret | At most one serialized supported refresh; otherwise pause ingestion/dispatch and actionable credential alert. No automatic login or human-token fallback. |
| 403 / 404 known issue/project | Coverage/security/move/deletion ambiguity, not “nothing to process.” Quarantine affected scan, alert owner; no automatic deletion of known IDs or advancement past unresolved coverage. |
| 400 invalid query / schema / endpoint removal | Permanent configuration/contract fault: pause affected processing and alert; do not widen query/scope or use a write endpoint. |
| Malformed/repeated pagination / expired token | Retry boundedly; token expiry restarts frozen window. Persistent fault holds cursor. Maximum page/time budget means incomplete/resumable, not success. |
| SQLite busy/full/corrupt / failed backup | Busy retry ≤5s then deferred hold; full/corrupt/fsync failure stops commits/delivery and alerts. No auto-vacuum/destructive rebuild or state reset. |
| Herdr absent/mismatch/busy/blocked | Ingestion continues; durable outbox waits. No session repair/replacement. Alert according to age; never treat idle fallback as acceptance. |

Persist next retry time and error **enum**, not response body. Backoff sleeps are interruptible; use monotonic time for in-process deadlines and trusted UTC for durable scheduling. Clock rollback never advances watermark or rewrites A; forward jumps/large offset hold ingestion boundaries for reconciliation. SIGTERM completes or rolls back short transactions, releases locks and marks in-flight attempts uncertain. Poller and delivery have independent health, so “process alive” is not “events delivered.”

**Redacted observability:** log only component/version, random correlation/fault ID, operation class, HTTP status class, counts, durations, lag/queue-age buckets, retry count/delay, mode, error enum. No issue keys/IDs/titles/status prose, actor account IDs, raw history/JQL/payloads, auth headers/tokens, page tokens, terminal output, session transcripts, secret paths containing sensitive values or exceptions with HTTP bodies. Low-cardinality metrics only; no event/issue/user labels. Restrict log access and retention to 14 days. A protected diagnostic command can expose minimal ledger records to authorized operators; never public health endpoints.

Separate heartbeat from successful poll and completed sweep: update liveness every 30s, poll-success age, full-reconciliation age, oldest unacked event, pending/held counts, DB integrity/backup age and binding health. Proposed alerts: crash/missed heartbeat >2min; no successful poll >5min; oldest unacked >10min; full reconciliation overdue >2h; permanent auth/mapping/corruption/binding fault immediately; backup stale >26h; resource/disk threshold warning. Alert includes severity, fault ID, age, action (“renew machine credential”, “verify existing session binding”, “recover ledger”), and runbook path only. Deduplicate/escalate faults; reminder ≤hourly. Human-owned external alert channel/heartbeat monitor is **unprovisioned**; logging alone is not an actionable notification when Herdr is down.

## 7. Privacy, retention and backup/recovery

- Persist only numeric issue/project/history/status identities, event UTC, actor account ID necessary for audit/classification, decision/config version, receipt/work metadata and hashes. No issue content, attachments, descriptions, comments, avatars, email or full REST JSON. Drop unrelated changelog fields in memory without storing/logging them.
- Permissions: directories 0700, SQLite DB/WAL/SHM/backups 0600, umask 0077; Unix socket access narrowly granted (§8). Reject symlinks/untrusted ownership for configuration, credentials, DB and sockets. No tokens in either SQLite store.
- Pending/held/unacknowledged events are never age-expired. Applied staging/raw normalized page rows: prune after 7 days only when linked decisions/outbox are durable. Acknowledged audit metadata/actor IDs and detailed delivery attempts: proposed 90 days; remove unnecessary account-ID material thereafter. Retain **compact dedupe tombstones** (event hash/composite digest, fence/config decision, ack disposition) for the service lifetime, because full reconciliation rereads history; purging dedupe state can replay old post-A events. Privacy policy must approve that minimized lifetime retention. Decommissioning needs explicit retention/export decision, not automatic wipe.
- Daily consistent SQLite online backup (or `VACUUM INTO` only in a tested maintenance path) of **both** stores, plus immutable A/config/mapping/binding versions; do not copy a live main DB while omitting its WAL. Validate backup integrity and recovery in a sandbox. Proposed encrypted backups: 7 daily local copies, 30 days off-VM only to an explicitly approved destination/key custodian; no existing application backup bucket/policy reused or modified automatically. Off-VM backup/keys/access are missing activation inputs. Budget private disk and backup size; no runtime cleanup of unrelated data.
- Provisional operational targets for approval: RPO ≤24h for disk loss with daily backup, RTO ≤4h staffed recovery; process reboot loses no **committed** local state under intact filesystem assumptions. Recovery restores both stores/config, keeps original A, starts dispatch disabled, runs complete reconciliation, compares receipts/work intents, and holds every uncertain external effect before re-enabling. A stale/lost consumer store cannot be treated as “nothing executed.” An empty replacement DB is not recovery. Data loss with no reliable receipts requires manual effect reconciliation; do not mass re-prompt.
- Shutdown/decommission stops polling/delivery, revokes machine credentials separately, preserves encrypted ledger/tombstones until the approved retention endpoint, and removes only watcher-owned files under an approved runbook. No deletion of Jira/application resources.

## 8. Supervision, privilege boundaries and VM restart

### Recommended split deployment (all proposed, nothing installed)

1. **System poller**, dedicated unprivileged OS account `jira-evidence-watcher`, no interactive login/sudo/Docker group, owns `/var/lib/jira-evidence-watcher`. It can read Jira and write its ledger, but has **no Herdr/OpenCode socket, home, application checkout or deployment credentials**. Root-owned code/config, systemd `LoadCredential=` / `LoadCredentialEncrypted=` (availability and key recovery to be verified) supplies daemon-only Jira secret material at runtime. No plaintext `EnvironmentFile` for secrets.
2. **User bridge**, existing Herdr-owning Unix user `ubuntu`, owns only coordination state under `%h/.local/state/jira-evidence-watcher`. It has access to the existing Herdr socket and the poller's narrow socket, but **no Jira machine token**. This is deliberately separated from the network poller. It uses a narrow local ack interface and does not execute arbitrary shell. Because `ubuntu` already controls powerful agent sessions, same-UID compromise remains a risk; sandboxing reduces exposure but cannot manufacture role isolation.

System unit proposal: `/etc/systemd/system/jira-evidence-watcher.service`, `Type=simple`, `User=jira-evidence-watcher`, reviewed service/socket group, `StateDirectory=jira-evidence-watcher`, `RuntimeDirectory=jira-evidence-watcher`, `UMask=0077`, `Restart=on-failure`, `RestartSec=30s`, bounded start-rate limits, `TimeoutStopSec=30s`. `After=network-online.target`/`Wants=network-online.target` are readiness hints, not proof of Jira connectivity. Runtime socket mode 0660 with a dedicated narrowly populated bridge group and explicit caller UID validation. Other state files remain private; adding `ubuntu` to a group is separately reviewed installation, not done here.

Sandbox targets: `NoNewPrivileges=yes`, empty capability bounding/ambient sets, `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp=yes`, `PrivateDevices=yes`, kernel/control-group/module protections, SUID/SGID restriction, `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6`, no executable writable state, memory/CPU/task/fd limits (initial 128MiB/10%CPU/32 tasks; validate load), restricted writable state/runtime/credential-rotation paths. `MemoryDenyWriteExecute`/syscall filters must be tested against chosen Python/TLS/SQLite; do not blindly promise compatible hardening. Network egress policy should allow only approved Atlassian/TLS/DNS paths; CDN IP churn prevents simplistic static-IP allowlists. No public listener or inbound webhook.

User unit proposal: `%h/.config/systemd/user/jira-evidence-bridge.service`, `Type=simple`, `WantedBy=default.target`, bounded restart policy, no dependency that starts/restarts Herdr/OpenCode, `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ProtectHome=read-only`, private tmp/devices, local Unix-only communication where tested, writable paths only bridge state/runtime and any explicitly verified Herdr CLI log requirement. Per-user sandbox features depend on VM/systemd user-namespace support; verify effective settings. Do not expose the whole writable home merely to silence a permission error.

On VM boot the system poller may ingest safely **without Herdr**. The bridge waits for the existing approved Herdr server/socket **and same live Michael session** to become available. Do not invent a `herdr.service` name or boot ordering dependency before discovering the actual installation; no `ExecStartPre` restore/login/agent launch. If the user manager must run without an interactive login, **user lingering** may be required; `loginctl enable-linger ubuntu` requires explicit host-owner approval and security review. This watcher must not arrange restoration of Michael; an authorized existing operational mechanism/operator owns it. If pane mapping changes after reboot, delivery holds until the same session ID is verified and the reviewed binding is updated through the runbook.

System poller can restart indefinitely with backoff without dispatching; the bridge can run while Herdr is unavailable without boot loops or duplicate sessions. Health/alerts distinguish server absent, session absent, binding mismatch, busy, permanent credential fault and live-but-unacknowledged work. Do not restart an otherwise healthy service to reload an unrelated agent model/config.

## 9. Deliverable phase boundaries

Only this document is changed by the architecture task. Ryan may implement only the offline subset explicitly authorized in §1.1; the wider package/operational paths below are retained as later-phase proposals, not permission to implement integrations or create/install service files now.

| Path / package | Purpose |
|---|---|
| `tools/jira-evidence-watcher/` | **Now:** standalone offline parser/classifier, SQLite fence/dedupe/outbox and fixture-backed mock scanner/reconciler. **Deferred:** production Jira reader/auth, transport/outbox delivery, bridge and consumer helper. Pin/test runtime; no application imports/runtime dependency edits. |
| `tools/jira-evidence-watcher/pyproject.toml` | Packaging/entry points and pinned development/test tooling; avoid third-party runtime dependencies unless justified/reviewed. |
| `deploy/systemd/jira-evidence-watcher.service` | **Deferred; do not create now.** Disabled-by-default system-poller template only after approvals. |
| `deploy/systemd/jira-evidence-bridge.service` | **Deferred; do not create now.** Disabled-by-default user-service template only after approvals. |
| `deploy/jira-evidence-watcher.example.json` | **Deferred operational configuration.** Current-phase fixture configuration belongs with offline tests and uses synthetic mappings, not approved production bindings. |
| `docs/jira-evidence-watcher-runbook.md` | Credential ownership, preflight, fence approval, staged activation, pause/recovery/backup/rotation/rollback and alerts. |
| `tests/jira-evidence-watcher/` | **Now:** simulated Jira-history/pagination/retry fixtures, SQLite/crash/clock/dedupe/atomicity tests and mock reconciliation. **Deferred:** Herdr/consumer integration and service/sandbox operational harness. No production transitions. |

Installed code proposal `/opt/jira-evidence-watcher/releases/<contentDigest>` is immutable/root-owned with a reviewed current-release pointer; runtime state lives outside the checkout. System config `/etc/jira-evidence-watcher/config.json` and credential sources are owner-restricted; user binding config under `%h/.config/jira-evidence-watcher/` is operator-owned/reviewed. State paths/SQLite schemas use domain names above, not tracking keys. Future helper interface needs explicit subcommands `validate`, `health`, `accept`, `ack`, `status`, `pause-dispatch`, `arm`, `enable-dispatch`, `backup`, `reconcile`; sensitive operations require appropriate local operator identity. `arm` atomically records the approved future A; `enable-dispatch` must verify the approved binding/config/fence and all readiness gates. Dispatch is false by default, including new installs; neither subcommand is available to a notification/receipt caller. Do not implement an arbitrary `exec` or templated shell option.

## 10. Staged activation and rollback runbook contract

**DESIGN ONLY. Every install/enable/start/linger/secret-provisioning step below is separately gated on human-reviewed architecture, credential ownership and a reviewed executable runbook. No commands in this section were executed.** A code merge is not activation consent.

The **offline phase in §1.1 is already authorized** and may proceed before the operational review gate below. These steps describe later integration/activation, not prerequisites that re-block the permitted offline parser/store/mock tests. No service files, production clients or Herdr integration are authorized by their presence in this runbook proposal.

1. **Later integration/operational review gate:** approve §12 decisions and safety/identity/retention contract before extending beyond §1.1. Freeze exact artifact/release digest, target VM, machine principal, owner/operator/alert recipient, project/status mapping and existing session binding. Prove human/agent credential separation. Specify activation window and approved test environment. If unresolved, stop expansion/integration/activation; the authorized offline phase may still proceed.
2. **Implementation review gate:** separate implementation PR, Dwight exact-head review of all code/test/workflow changes, successful required CI; Michael handles verified merge under normal safeguards. Pam tests exact merged SHA in a clean checkout. This applies to the offline implementation too, without authorizing the later blocked integrations. No service files/operations, live Jira calls, credential provisioning, Herdr integration or deployment in current-phase CI/QA. Fixture tests do not certify production connectivity.
3. **Offline artifact/preflight:** build a versioned release without runtime downloads; static config/schema validation and migration/backup restore tests on disposable watcher-only state. Review sandbox capabilities; verify no write Jira endpoint, resource CLI, session-management verb or arbitrary prompt exists. Operator signs off exact runbook and artifact/VM before installation.
4. **Install only, still disabled:** authorized operator creates reviewed service identity/group/paths, installs immutable release and **disabled** unit templates, provisions credentials through the approved secret path, applies filesystem permissions and daemon-reload as required. No automatic enable/start in package hooks. Host-owner permission is needed for any lingering/group membership changes. The current design author does none of this.
5. **Authorized shadow validation:** after separate start permission, run a bounded read-only preflight/shadow mode with **dispatch disabled** and a disposable shadow DB that cannot become production active by accident. Validate site/cloud/project/status IDs, principal/issue visibility, pagination/UTC, rate budget, live existing-session binding and alert channel. Do not emit prompts or record past Done events as active approvals. Evidence contains redacted commands/exit codes/counts, not secrets/content.
6. **Consumer canary:** in an approved nonproduction harness, verify fixed-envelope routing, TOCTOU lock cooperation, ack/dedupe across crashes and all negative safety cases. No synthetic production event treated as real acceptance; production bypass flags are forbidden. Install/review Michael's consumer protocol before dispatch can be enabled.
7. **Arm the real ledger:** operator explicitly approves future A and durable production DB creation. Persist A/config while disabled (§3), inventory, cross-boundary catch-up, then compare minimal counts/coverage. Arming must succeed before A; if not, reapproval is required, not implicit historical replay. Owner confirms service is now responsible for events at/after A.
8. **Enable ongoing operation only with explicit permission:** operator enables/starts the system poller and user bridge (or changes running shadow service to reviewed active configuration through a controlled restart/reload), first ingestion-only, then separately enables dispatch after readiness/ack/binding checks. Enable lingering only if separately approved. Record exact installed digest/config/fence/backup and redacted health evidence. No application deployment/timer/container/network changes.
9. **Operational observation:** verify liveness, scan/sweep completion, pending/outbox/receipt flow and first genuine eligible event under the approved policy. A real human transition is not manufactured by the service. No genuine event available means end-to-end production observation remains pending, not falsely passed.

The following **future operator command ordering** makes the unit boundary explicit; these are inert design examples, not commands to run now. They are insufficient without the approved files/config/secret source and helper implementation above. Execute user-manager commands only as the existing `ubuntu` user with its approved user-manager environment, never by inventing a second Herdr user/session:

| Stage, after its separate approval | Exact systemd operation proposed |
|---|---|
| Installed templates inspected; still disabled | Root/operator: `systemctl daemon-reload`; existing user: `systemctl --user daemon-reload`. Neither starts a service. |
| Authorized bounded shadow start with shadow config/DB and dispatch false | Root/operator: `systemctl start jira-evidence-watcher.service`; existing user: `systemctl --user start jira-evidence-bridge.service`. No enablement; stop both after validation before selecting production state. |
| Boot persistence separately authorized, production state armed and dispatch still false | Root/operator: `systemctl enable jira-evidence-watcher.service`; existing user: `systemctl --user enable jira-evidence-bridge.service`; then `start` each exact unit if stopped. No `--now` shortcut conflating the gates. |
| User lingering only if host-owner approved | Root/operator: `loginctl enable-linger ubuntu`; record previous lingering state so rollback does not disable a pre-existing requirement of other user services. |
| Verify exact units, no secrets/content | `systemctl is-active jira-evidence-watcher.service`, `systemctl is-enabled jira-evidence-watcher.service`; existing user uses corresponding `systemctl --user` commands for `jira-evidence-bridge.service`; protected helper reports ingestion/delivery readiness separately. |
| Rollback after dispatch pause/uncertain-attempt hold | Existing user: `systemctl --user stop jira-evidence-bridge.service`, then `systemctl --user disable jira-evidence-bridge.service`; root/operator: `systemctl stop jira-evidence-watcher.service`, then `systemctl disable jira-evidence-watcher.service`. Preserve both ledgers/fence and all unrelated services/sessions. |

Do not automatically undo lingering or group membership on rollback: inspect prior state/dependencies and obtain separate permission. Exact secret provisioning, helper invocation syntax/config arguments, effective unit sandbox and release switch commands must be finalized in the implementation runbook and tested before any of these operations is authorized.

**Rollback sequence:** authorized operator pauses dispatch first; marks in-flight attempts uncertain and drains/holds them without claiming they were unsent; stops/disables **only watcher/bridge units** if needed. Keep credentials/ledgers/A/tombstones/backups intact and no Jira or session rollback. Inspect receipts/work intents before any resubmission. Restore a prior signed release only if DB schema is compatible; otherwise stay stopped and restore/test a consistent pair of backed-up stores with dispatch disabled. Never drop/auto-downgrade tables or reset the fence to restart “clean.” Reconcile fresh full histories and external work effects before explicit re-enable. Revoke/rotate a compromised daemon token through its owner; do not touch interactive MCP credentials, application backups, Herdr sessions or unrelated services. Stop/disable commands belong in the reviewed runbook, scoped to exact watcher unit names; no broad `killall`, service restart or recursive deletion.

## 11. Threat model and verification plan

### Threats and residual risks

| Threat | Control / limitation |
|---|---|
| Spoofed “human” display name/signature or app transition | Exact changelog account ID allowlist + system status IDs; reject absent/app authors. Shared owner credentials remain a **blocking identity gap**. |
| Prompt/shell injection in issue fields or malformed IDs | No issue text fetched for prompting; typed bounded envelope, origin/path validation, argv without shell, fixed reconciliation-only template; never evaluate Jira text. |
| Credential theft / overbroad principal | Separate read-only machine identity, protected systemd credentials, restricted permissions, origin allowlist, redacted telemetry, poller/bridge split; host-root compromise remains outside application guarantees. |
| Misrouted pane, registry tampering, session duplication | Pin expected existing session + process binding, trusted reviewed registry, cooperative routing lock, receiver check, never create/restore sessions. Native Herdr lacks verified CAS; gate remains until mitigated. |
| Duplicate/replayed deliveries, forged ACK, crash after side effect | Stable event ID, durable consumer receipt/unique work intent, nonce/lease fencing, local peer credentials; same-UID agent auth is policy not independent identity; uncertain external effects hold. |
| Missed approvals due to reopening/index lag/pagination | No current-Done candidate filter; full histories, overlap, atomic watermark/outbox and complete periodic reconciliation; visibility/history removal remains an explicit capture limit. |
| Old approval replay after bootstrap/restore/config changes | Immutable A, classification fence and permanent minimized tombstones, config versioning, paired-store recovery, no automatic rebaseline. |
| Cross-project moves, status-name reuse / workflow drift | Pinned project/status/type IDs + live metadata validation, historical membership checks/hold; mapping changes require approval. |
| DoS via huge histories/response/token loops/DB growth | Bounded pages/responses/time/rate, durable progress, size/lag alerts and disk quotas; never truncate and declare success. |
| Done used as production approval / repeated destructive actions | Reconcile-only protocol, no write/deploy/session-management tools in poller, normal squad gates, exact-artifact/target human approval separate. |

### Tests required before operational acceptance (not executed here)

Ryan may implement/run the **offline subset** of this plan now: simulated Jira parsing/allowlist validation, mock pagination/polling/reconciliation, virtual-time/failure responses, SQLite fence/dedupe/outbox/cursor durability and privacy/safety invariants. No live HTTP/auth client, credential discovery, Herdr delivery/consumer integration, service files or operational test execution is authorized. The remaining tests below are future integration/operational requirements, not current-phase scope or evidence already obtained.

1. **Classifier matrix:** exact status IDs/path, wrong source/target/project/type, same-name status in another workflow, missing/anonymized/app/unauthorized actor, spoofed name/signature, shared-account scenario rejected as unverified, duplicate/reordered items, multiple approval cycles and corrupted timestamps. Input order must not affect unique eligible event set.
2. **Pagination/coverage:** zero/single/many pages, server-clamped sizes, repeated/expired tokens, empty nonterminal pages, malformed total/isLast, >100 history items, equal event timestamps, append during scan, issue updated out of a frozen window, deletion/move/access loss, delayed search visibility both within and beyond overlap. Compare against a reference complete retained event log; no silent cursor advance on failed coverage.
3. **Bootstrap/races/clock:** old Done history never prompts; transition immediately before/at/after A, transition during slow baseline and restart, complete/reopen before poll, reapprove later, clock jumps/UTC timezone mismatch/index lag, crash before/after saving A, delayed initialization and restored fence. Explicitly test `< A` suppression and `>= A` capture, plus uncertain boundary hold.
4. **Durability/property/fault injection:** kill at every staging/commit/cursor/outbox/lease/prompt/receipt/ack/delegation boundary; fsync/full disk/busy/corrupt DB, duplicate processes, stale leases, restore old DB pair or only one store, expired payload nonce, conflicting payload hash. Invariant: advanced completed cursor implies durable decisions+outbox; eligible committed event implies exactly one outbox identity; work identity cannot have two active claims.
5. **Delivery/consumer:** socket absent/permissions wrong, fake/stale Michael name, same pane different session, same session moved pane, wrong project/cwd, blocked/working/idle-fallback/login screen, binding changed in check/send race, timeout after accepted submission, prompt echo mistaken for ack, replayed/forged/stale ack, restart after delegation. Assert zero session create/restore/restart/shell-paste calls and zero duplicate non-idempotent task execution; uncertain actions remain held.
6. **Security/privacy:** hostile issue text/escape sequences/JQL/path injection/SSRF redirects, oversize fields, malicious `self`/nextPage URLs, actor/key in all exception paths, token/header/body redaction, permissions/symlinks, hostile same-UID receipt attempts, missing trusted binding, no write Jira route. Test exact syscall/verb/endpoint allowlists and sandbox effective permissions.
7. **Failure/retry/operations:** deterministic virtual-time 429 (including huge Retry-After), 503, missing/invalid retry header, jitter bounds, retry ceiling/circuit, auth refresh/revocation, no busy loops while Herdr absent, shutdown/boot without user login, no duplicates after reboot, live health versus stalled ingestion, delivery backlog and external alerts, safe stop/rollback and successful paired-store restoration. Do not induce Jira rate limits or modify production workflows/resources for testing.

### Operational acceptance criteria and evidence

- Human-approved architecture/identity/credential/retention/runbook decisions; no unresolved strict-human or session-binding guarantee disguised as a pass.
- Complete offline tests and exact-head CI/review; Pam's post-merge verification of available suites on actual merged SHA remains separate from this design.
- Owner-authorized nonproduction/preflight evidence proves correct read scopes/project/security visibility, status mappings, UTC/fence, all-page traversal, least-privilege sandbox and no forbidden HTTP/session/resource operation.
- Normal target: eligible retained event reconciled within **5 minutes** when Jira indexes promptly, Herdr is ready and configured capacity suffices; late indexing caught by the next completed hourly sweep. Busy/missing consumer surfaces as backlog, not a false latency pass. Alert within configured thresholds; no silent drops or endless automatic work retries.
- Boot/restart/kill tests prove recovery of committed ledger/outbox and original A; observed duplicate prompt delivery causes no duplicate claimed execution. Restore exercise verifies RPO/RTO and uncertain-effect hold.
- Redacted linked report records exact artifact/config/fence, tested environment, commands/exits, expected-versus-actual event counts/coverage, replay/dedupe/crash evidence, deferrals and owners; logs contain no secrets/issue content. Activation/production approval is separate and explicit. No unexecuted criterion is marked PASS.

## 12. Authorized offline phase, remaining gates and final design verdict

**SAFE OFFLINE IMPLEMENTATION AUTHORIZED NOW** by the 2026-11-06 human direction, strictly within §1.1. The gates below apply to the blocked integration/operational phases; they do not prevent Ryan implementing/testing the authorized offline subset. No provisional identity/status mapping becomes a production approval through this phase authorization.

| Gate | Required decision/evidence | Owner |
|---|---|---|
| **Human-only provenance — dispatch/production gate** | Confirm initial config-derived account allowlist; separate human identity from all agent/API automation. If sharing persists, strict human-authored detection cannot be certified; do not activate automatic dispatch. Offline allowlist tests do not resolve this. | Human project owner / Michael |
| **Daemon credentials/access — integration gate** | Select/approve unattended OAuth or scoped-token flow, nonhuman principal, project/security visibility, scopes, expiry/rotation/custodian and secure credential source before production auth/client integration or credential provisioning. Interactive MCP is not a substitute. | Human/ops |
| **Project/status mapping — live-integration gate** | Separate authorization for read-only discovery/pinning of project/status/type IDs, UTC validation and account/service permissions. No live Jira calls are authorized in the offline phase; use synthetic fixtures only. | Michael coordinating authorized implementer/ops |
| **Routing + consumer ack — integration gate** | Approve the security/routing/receipt design before implementing Herdr delivery/consumer integration. Later implement/test durable receipt/work-intent helper and binding validation; approve cooperative routing lock or expected-session-bound transport. Native Herdr 0.9.3 has no verified CAS/idempotent ack. | Michael + implementer; Dwight reviews |
| **Capture completeness — live-operation contract gate** | Approve visibility/history retention and restrictions on deletion/archive/move before reconciliation, or require durable source-side capture. Define reconciliation capacity/SLO and clock-boundary uncertainty handling. No unconditional losslessness promise from REST polling alone; fixture coverage does not establish live completeness. | Human owner / Michael |
| **Supervision/security — service implementation/activation gate** | Approve split OS identities, precise socket/peer permissions, sandbox and executable trust, actual Herdr socket/context/boot ownership, user lingering if needed before OS service files/configuration or install/enable/start/restart operations. None is authorized in the offline phase. | Host owner/ops |
| **Privacy/backup/alerts — activation gate** | Approve 90-day metadata + lifetime minimized tombstones, encrypted backup destination/key custodian/RPO/RTO, disk budget and independent actionable alert channel. | Human/ops |
| **Staged release/activation — activation/deployment gate** | Reviewed implementation PR/CI/QA, exact release+VM/runbook, approved operational activation fence and explicit install/enable/start/dispatch permissions. No activation or deployment permission is granted by the offline phase or design-document commit. | Human owner; squad per role |

**Final verdict:** **PROCEED WITH THE EXPLICITLY AUTHORIZED SAFE OFFLINE IMPLEMENTATION PHASE**: parser/identity-allowlist validation, SQLite activation fence/event dedupe/outbox, mock-only polling/reconciliation and simulated Jira-history tests (§1.1). Ryan can implement these now; Dwight's task remains the design-document-only commit. The broader polling → atomic event/outbox → existing-session reconcile → durable dedupe/ack architecture remains conditional and fails closed on identity ambiguity, incomplete capture and uncertain delivery/execution. Production Jira auth/client integration, all live Jira calls, Herdr delivery/consumer integration, credential provisioning, OS service files/operations and deployment **remain blocked** pending the separate approvals above. It is not ready to install or activate. No claim of exactly-once Herdr prompting or independently authenticated human authorship under shared credentials is made; simulated tests/provisional IDs do not certify either. Michael should obtain the remaining gates before expanding beyond the offline phase. No resource migration or service/session change is made here.

## References and verification boundary

Public contracts read on 2026-11-05 (documentation research, **not Jira tenant operations**):

- [Jira enhanced issue search](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/#api-rest-api-3-search-jql-post), [search/reconcile consistency](https://developer.atlassian.com/cloud/jira/platform/search-and-reconcile/).
- [Jira paginated issue changelogs](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-issueidorkey-changelog-get), [project/status metadata](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-projects/), [published OpenAPI](https://dac-static.atlassian.com/cloud/jira/platform/swagger-v3.v3.json).
- [Jira rate limiting](https://developer.atlassian.com/cloud/jira/platform/rate-limiting/), [OAuth scopes](https://developer.atlassian.com/cloud/jira/platform/scopes-for-oauth-2-3LO-and-forge-apps/).
- [OpenCode V2 API](https://opencode.ai/v2/docs/api), consulted only to identify why no undocumented API/session-start fallback is assumed.
- Installed Herdr read-only help/schema (`herdr api schema --json`, protocol 22, `AgentPromptParams`) and live `agent list/get` / `pane process-info`; registry read, no session mutation or prompt sent for this assignment.

Design checks performed: existing tracked naming checker against the clean base plus Markdown artifact (0 violations); whitespace/diff including the untracked artifact, and worktree-isolation inspection. To avoid installing dependencies, invoked the byte-identical checker/grammar from the earlier isolated review clone with this scratch worktree as cwd; both source files were first compared byte-for-byte. These checks validate document isolation/naming only, **not** the proposed daemon, credentials, REST polling, service sandbox, delivery or activation acceptance. No application/daemon tests or operational actions are claimed executed.

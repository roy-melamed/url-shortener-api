# Offline Agent Owner recommendations

Owner: engineering squad. Lifecycle: explicitly supplied disposable local fixture
state only. Tracking: URL-30 partial corrective slice, not ticket acceptance.

## Source and policy

Implemented from verified current approved main
`4a94d58a8aa19b08ecf1ba2211b7018abfb2084d` (PR34 merged). Before coding, Ryan read
historical PR16's merged `scripts/jira-ownership-policy.ts`, its unit/integration
tests, documentation and Pam's QA FAIL; amendment v2 SHA-256
`5bbe168cd3326eb3170313843600c718d0b1d7d1fb2c559f986303d6acc95968`; and the complete
current Jira description transferred by the authorized orchestrator. The operative
offline appendix matches v2; old Agents-assignee/deployment clauses are superseded.
The transferred issue is a read-only input, not Ryan's direct Jira observation.

The historical planner/tests and QA FAIL remain unchanged. The new independent
`scripts/agent-owner-recommendation.ts` does not import, invoke, wrap or revive its
Assignee policy. No application/entrypoint/watcher/workflow imports the new module.
No historical account/status constants are silently adopted as runtime discovery.

## Explicit inputs and outputs

- Supply a normalized `OwnerRecommendationConfig`: project URL, exact configured
  `customfield_10043`, configured Roy accountId, six Agent Owner option IDs, the
  explicit Ryan→developer alias, and explicit approved/Evidence Review/active
  status IDs. No configuration file is read. Tests compare these normalized
  fixture mappings against committed squad.config.json; that read is test-only.
  Complete mappings must have distinct valid numeric options. The field cannot
  be retargeted to Assignee or arbitrary Jira fields.
- `baselineOwnerRecommendations(config, fence, baseline)` returns baseline state
  **without proposals**. Duplicate/future/malformed baseline rows fail closed.
- `recommendAgentOwner(config, state, observation, current, requestedRole, evidence?)`
  returns either a hold or a recommendation plus new local state. A recommendation's
  `fields` is exactly `{customfield_10043: {id: configuredOptionId}}`. It contains
  no assignee/status/comment/label/link or other action. Roy must remain assignee
  by configured accountId; null/non-Roy holds, never repair. Already-correct owner
  holds. Role is explicit, never inferred from a status/category/display name.
- A normalized observation is a **fixture handoff observation**, not a verified
  webhook or a proposed transition. It binds event ID, issue, from/current status,
  revision and timestamp. Role handoffs need not change status.
  Event IDs are stable within the supplied project ledger; reusing one for
  another issue or altered payload is still a duplicate, not new work.
  Unknown statuses, mismatched snapshots, at/before-baseline observations and nonincreasing per-issue
  revision/time cannot propose. Processed observations, including valid holds,
  are consumed locally so adding evidence/changing roles does not replay them.
- Approved/current/from-or-to-Approved/protected-history observations retain a protected
  issue marker in returned state, including after reopening. All retained state
  must be passed back by the caller; no hidden mutable ledger exists.
  Validated protected holds consume the same project-wide event identity before
  returning, including repeated/reopened observations. Protection still takes
  precedence over duplicate/staleness reason codes; both ledgers must have room
  for any new fact. A full seen/protected ledger returns a capacity hold with no
  continuation state if either required fact cannot be retained, never eviction
  or an incomplete protected-hold state. Existing already-recorded facts need no
  new slot, even at capacity. Preserve the original input state when blocked.
- Evidence Review can model **only Agent Owner Human**, with an explicit matching
  snapshot, fixture role Pam, PASS and eligible=true. Missing, inconsistent, stale,
  wrong-role or wrong-outcome context holds. No transition, final evidence post,
  human approval or executor operation exists. Fixture assertions do not
  authenticate Pam, certify actual QA, or authorize a Jira action.
- `ownerRecommendationStillCurrent(proposal, config, returnedState, fresh, evidence?)`
  compares all normalized snapshot fields, configuration, returned local state,
  role/field payload and any evidence binding. Changed issue/status/revision/time,
  assignee/owner/protection/config/state/evidence invalidates the recommendation.
  It is **not atomic compare-and-set**, a lock, a signature, or execution authority.

All input data is cloned/validated without invoking getters/toJSON, and remains
unchanged. Output contains fixed reason codes, configured field/option IDs and
SHA-256 correlation fingerprints rather than raw issue/event/account IDs or ticket
text. The only import is the existing built-in deterministic `createHash`; no
randomness, current clock, config discovery, environment/credential, filesystem,
network/Jira/Herdr adapter, subprocess, scheduler or persistence is accessed.
Malformed data/exceptions return fixed redacted holds or false, never parser dumps.
New results are deeply frozen. Fingerprints bind local data only, not identities.

## State limits and non-claims

State is supplied and returned as ordinary data: version/config fingerprint,
baseline fence, consumed event fingerprints, protected issue fingerprints and
per-issue revision/time. It is not saved or recovered by the module. Deliberately
discarding/forging/rebaselining local state can defeat prior observations; this
API does not claim durable restart protection or trusted state custody. It cannot
close the read/write race or prove permissions/serialized enforcement.

Technical fixture limits (20 nesting levels, 50,000 data nodes, 10,000 array/state
entries and bounded scalar identifiers) hold rather than truncate, evict or reset.
These are input/CPU/memory bounds, not an operational retention/retry policy. If a
hold supplies no state, there is no validated continuation state; do not infer
permission to reset a ledger. No new live policy is decided here.

Full URL-30 historical QA FAIL is **not resolved**. Live enforcement remains
BLOCKED pending the PO/Jira-admin synchronization/concurrency decision, scoped
tenant permissions, security review and an authorized nonproduction fixture.
No dependency, live adapter/executor/synchronizer, automatic assignment/repair,
workflow transition, service, resource, activation, deployment or QA is included.

## Verification

Unit tests cover all configured mappings, Ryan alias, malformed config, Roy/null/
non-Roy, already-correct owner, exact payload, baseline/protected/reopened history,
duplicate/stale/out-of-order observations, every freshness dimension, Pam/Human
evidence guards, capacity, frozen inputs, deterministic output and redaction.
The capability test statically checks the one-import boundary and executes the
compiled module in an isolated VM with only deterministic hashing supplied and
environment/network/process/credential-discovery/scheduling/logging capabilities
denied during import and calls. This tests the closed dependency boundary, not
an OS sandbox or authenticated actor. Real repo quality checks, the original
historical tests and separate offline-watcher suite remain required unchanged.

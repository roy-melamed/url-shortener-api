# Watcher acceptance blockers and formatting rework evidence

Ryan developer report — 2026-11-08. Tracking: URL-29. **Full acceptance remains
FAIL/BLOCKED; this PR fixes formatting only.** This is not Pam's acceptance
milestone, a replacement architecture, a workflow decision or permission to
implement/activate deferred integrations.

## Verified QA provenance and bounded correction

Read [Pam's actual GitHub QA report](https://github.com/roy-melamed/url-shortener-api/pull/14#issuecomment-6720674316)
via GitHub API and verified PR #14 is MERGED with merge commit
`b0f0243f172c3bc1d4ef21e7826d30512c5a936d`. Freshly fetched `origin/main`
equals that commit; this new isolated branch starts there. PR #14 remains
immutable. Pam reports the authorized offline phase PASS but full ticket FAIL;
green offline tests cannot close the live acceptance gaps.

Reproduced `npx prettier --check docs/jira-evidence-watcher-design.md` exit **1**
on that base. Ran Prettier on only that document; file check now exits **0**.
Only Markdown table alignment/separator widths and whitespace change. An executed
comparison of every line with whitespace removed, excluding table-separator-only
lines, found identical content (exit **0**). No architecture, authorization,
acceptance criteria, mapping, proposed service operation or security gate changed.
The earlier reports' unchanged-design statements describe their historical heads;
this PR explicitly authorizes and discloses the formatting-only change.

The scope restriction comes from the current human instruction and the existing
project decision/blocker identified there as **Jira comment 10106**, consistent
with design §§1.1/12. That Jira comment was **not reread or modified** in this
turn; no Jira operations were performed. Michael coordinates prerequisite
decisions and Pam owns her existing FAIL milestone. This document does not
infer approval from silence or change either role's record.

## AC-by-AC dependency analysis

AC numbering and assessment follow Pam's linked report, not revised acceptance
criteria. Owners below are the decision roles in existing design §12, not a claim
that an approval has been granted or work has been assigned.

| AC / remaining gap                                                                                         | Specific unresolved prerequisite and decision owner                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Evidence required before implementation/testing can satisfy the AC                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1 — Live project Evidence Review → Done detection and human provenance: FAIL**                           | **Product/Jira admin:** human reports this project has no `Done` status. Decide the intended workflow contract and, if appropriate, separately authorize an administrator to configure it. **Never substitute Approved**, a Done category or a similarly named status. **Human owner/Michael:** approve a human-only account allowlist and separation from every agent/API credential; shared account IDs cannot prove human origin. **Human/ops:** approve a separate least-privilege nonhuman unattended credential flow, scopes, secure custody/rotation and project/security access. **Michael/ops:** obtain explicit authorization for read-only tenant preflight and exact project/type/status IDs. | Approved product/admin resolution first; then separately authorized nonproduction discovery/access/provenance evidence and a reviewed implementation/test assignment. Synthetic `SYNTH` / `99…` IDs are not production mappings. No credential provisioning or live Jira call is authorized now.                                                                       |
| **2 — Production cursor/ledger/outbox and no duplicate execution: PARTIAL → FAIL**                         | **Human/ops:** approve persistent storage location/ownership, durability assumptions, disk limits, backup encryption/custodian/RPO/RTO, retention and tombstone policy. **Michael + implementer, Dwight review:** approve receipt/work-intent protocol, independent work identity, claim/lease fencing and uncertain-effect handling, including paired-store restoration. **Human owner/Michael:** accept a realistic capture-completeness contract (permissions, history retention, deletion/moves/archive) or require durable source-side capture.                                                                                                                                                      | Reviewed later implementation plus authorized fault/reboot/paired-store restore and consumer-dedupe evidence. Disposable SQLite tests prove local simulation invariants only, not a production ledger or exactly-once external execution. No migration/storage setup is authorized now.                                                                                |
| **3 — Existing Michael Herdr session, harmless duplicate delivery and reconciliation: FAIL**               | **Michael + implementer, Dwight review:** approve expected-session-bound routing, registry/process trust, check/send race handling (cooperative routing lock or verified transport binding), and authenticated receipt/ack/work-intent design. Native transport's CAS/idempotent-ack guarantees must be established, not assumed. **Host owner/ops:** approve socket/peer permissions and executable trust boundaries.                                                                                                                                                                                                                                                                                    | Separately authorized integration scope and nonproduction acceptance environment must exist before a bridge/consumer is implemented. Tests must exercise stale/wrong binding, uncertain send/ack, duplicate receipt/claim and reconciliation-before-dispatch without creating/restoring/restarting sessions. No Herdr path is authorized now.                          |
| **4 — Real pagination/retries/429 plus redacted operations and persistent-failure alerts: PARTIAL → FAIL** | Credential/access/mapping gates in AC1 apply. **Human owner/Michael:** decide visibility/capture limits, reconciliation capacity/SLO and clock uncertainty behavior. **Human/ops:** approve independent actionable alert destination, recipient/escalation thresholds, liveness/backlog/disk monitoring and redacted telemetry/retention.                                                                                                                                                                                                                                                                                                                                                                 | Authorized nonproduction adapter/security tests, rate-limit simulation rather than induced production 429s, redaction tests and executed stalled-ingestion/backlog/alert evidence. Current virtual transport and fixed error codes do not establish real HTTP, permission completeness, alert delivery or production liveness.                                         |
| **5 — Full authorization/recovery/Herdr dedupe/no-restart/non-destructive tests: PARTIAL → FAIL**          | **Michael:** obtain bounded approvals and an available nonproduction acceptance environment after AC1–4 designs are resolved; **human/ops:** authorize fault/storage/recovery exercises on disposable integration resources. **Dwight:** review exact-head implementation/security tests; **Pam:** run post-merge suites and negative acceptance checks on the resulting main SHA.                                                                                                                                                                                                                                                                                                                        | Existing 58 offline tests remain meaningful but cannot test components deliberately absent. Later tests must cover real adapter/consumer boundaries, duplicate execution/uncertain effects, strict provenance, forbidden session operations and nonauthorization of destructive/deployment actions. Do not add dormant live paths to make these tests appear complete. |
| **6 — Service/configuration and activation/rollback, disabled until authorized: FAIL**                     | **Host owner/ops:** approve split OS principals, exact filesystem/socket/peer/sandbox/executable permissions, boot context and lingering policy. **Human owner:** separately authorize service/config implementation (currently blocked even if templates would be disabled). **Human/ops:** approve runbook, exact release/environment, operational fence, backup/restore and rollback behavior. Installation, enablement, startup, dispatch and production deployment require their own explicit permissions.                                                                                                                                                                                           | Only after those decisions: separately reviewed configuration/units and authorized nonproduction security/boot/stop/rollback evidence, with preserved ledgers/fence and uncertain attempts held. Architecture prose is not a deployable unit or activation test. No service template, install/start/linger, migration or deployment is added here.                     |
| **7 — Exact merged QA SHA and configured workflow: PARTIAL / not accepted**                                | **Michael:** coordinate visible blockers and route exact-head review/verified merge under safeguards. **Pam alone:** test actual resulting main SHA and update her existing milestone; only on full PASS may Pam post final Jira evidence and move to Evidence Review with configured Human owner. **Human only:** Evidence Review → Done, if an approved workflow provides that transition.                                                                                                                                                                                                                                                                                                              | This PR's developer head/checks do not replace post-merge QA. No Done status/transition is invented, no acceptance evidence is posted by Ryan, and no Jira edit/transition is made. Human approval of evidence still does not authorize deployment.                                                                                                                    |

### Safe ordering / decision requests for Michael

1. Obtain the product/admin decision for the absent Done status and the security
   decision for strict human provenance. If either remains unresolved, keep full
   acceptance blocked; do not reinterpret Approved or silently weaken human-only
   detection.
2. Obtain credential/access/capture-contract and receipt/routing/security approvals
   before assigning any live adapter or Herdr implementation. Public architecture
   proposals and existing interactive MCP access are not those approvals.
3. Obtain host/storage/privacy/alerting and nonproduction test permissions before
   assigning production-ledger or service/configuration work. Approve only the
   exact later scope; implementation permission is not install/start permission.
4. Require new reviewed PRs, real CI and Pam's merged-SHA acceptance evidence for
   later work. Keep operational release/dispatch/deployment decisions separate.

No new safe-offline feature is needed to repair this formatting defect. Adding
more synthetic tests cannot satisfy the missing live/security/service ACs. The
existing architecture gates and full ticket criteria are retained, not lowered.

## Actual isolated verification

Commands ran in `/tmp/opencode/watcher-design-format`, new branch
`fix/watcher-design-format`, based on the verified merged main above. Only the
design document was formatted; this report is the sole added artifact. All
runtime, fixtures/tests, workflow/dependency and approved spec content remain
unchanged. No Jira/Herdr/service/cloud/production operation was invoked.

| Command                                                                       | Exit / result                                                                   |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `npm ci`                                                                      | 0; locked dependencies, no fixes or lockfile change                             |
| `npx prettier --check docs/jira-evidence-watcher-design.md` before correction | **1**, reproduced Pam's concrete defect                                         |
| `npm run format:check` on untouched base                                      | **1**, 11 files including watcher design                                        |
| `npx prettier --write docs/jira-evidence-watcher-design.md`                   | 0                                                                               |
| `npx prettier --check docs/jira-evidence-watcher-design.md` after correction  | **0**                                                                           |
| `npm run lint`                                                                | 0                                                                               |
| `npm run check:naming`                                                        | 0                                                                               |
| `npm run typecheck`                                                           | 0; existing TypeScript scope                                                    |
| `npm run check:watcher-offline`                                               | 0; Python AST syntax/capability lint, not static typing                         |
| `npm run test:watcher-offline`                                                | 0; **58/58** offline tests                                                      |
| `npm run test:coverage`                                                       | 0; **2,306 passed / 10 existing DB tests skipped**, 20 files passed / 1 skipped |
| `npm run build`                                                               | 0; existing application build                                                   |
| `git diff --check`                                                            | 0                                                                               |
| `npm run format:check` after design correction                                | **1**, ten pre-existing files below; not claimed green                          |

The ten remaining formatter failures were all reproduced on the untouched main
base and are outside this PR's correction scope. None is edited or excluded:

- `docs/delivery-safeguards.md`
- `eslint.config.mjs`
- `migrations/1793270000002-slugs-links.ts`
- `src/platform/errors.ts`
- `tests/helpers/schema-recorder.ts`
- `tests/integration/db-schema.test.ts`
- `tests/integration/dev-entrypoint.test.ts`
- `tests/unit/errors.test.ts`
- `tests/unit/no-db-literals.test.ts`
- `tests/unit/schema-contract.test.ts`

The PR body records its exact submitted head and final touched-file formatting
check, including this report. Whole-repository formatting remains visibly failing;
no formatter configuration, CI check or quality threshold is disabled/relaxed.
File-level correction and green available suites do **not** pass full URL-29
acceptance or authorize any blocked capability.

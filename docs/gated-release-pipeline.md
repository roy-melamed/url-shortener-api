# Gated AWS release pipeline — developer evidence and operator contract

Tracking: URL-20. Owner: URL-shortener engineering. This is **workflow code and
offline verification**, not deployment authorization, merged-code QA or a claim
of a working staging/production environment.

## Approved scope and dependency

The approved PRD, design §9.6, preserved AWS scope in design §14.10–14.11, and
the explicit URL-20 assignment authorize this pipeline only. This does not
re-scope it to Oracle, modify approved requirements or implement URL-23's
OpenAPI/contract suite. URL-20's In Progress / Roy Melamed / Developer state was
reported by Michael in the assignment; Jira tooling is unavailable in this
session, so no new independent Jira readback/transition is claimed.

URL-19 merge `dd1e33f13aa35ca175a1e81fd36f849d99015cff` is an ancestor of the
worktree's current-main base (`git merge-base --is-ancestor`, exit 0).
[Pam's actual merged-SHA PASS](https://github.com/roy-melamed/url-shortener-api/pull/6#issuecomment-6557306052)
was read, including its owner-side deployment/network prerequisite limitations.
URL-7 is Approved per the assignment. Neither approved issue, `infra/`, `src/`,
migrations, CDK entrypoint, prerequisites checklist nor approved specification is
changed by this work. Existing CI checks are preserved; offline `cdk synth` is
added after build, closing the explicit CI gap in Pam's URL-19 report.

Worktree `/tmp/opencode/gated-release-pipeline`, branch
`feature/gated-release-pipeline`, base main
`01962f8a25cd141d99c669cece4811b8a059ce0b`. URL-9/10/16 unmerged branches are
not imported. The blocked Dwight pane is **not contacted or retried**; this PR
must await an authorized exact-head review and remains unmerged.

## Sequence and immutable approval binding

`.github/workflows/ci.yml` continues the PR/main quality checks and adds synth.
It has read-only permissions and **no deployment or cloud credentials**.

`.github/workflows/release.yml` is **manual `workflow_dispatch` only** on exact
`refs/heads/main`, with an explicitly matching `expected_sha` input. Checkout is
pinned to the workflow SHA. No push, PR, `pull_request_target`, `workflow_run`,
auto-merge, approval API write or unattended production trigger exists.
All actions in the privileged release workflow are pinned to resolved full
commit SHAs (version comments retained); the existing quality workflow is
preserved apart from its additive synth step.

1. Hosted, unprivileged candidate job: `npm ci` → lint → naming → typecheck →
   existing offline watcher checks → unit/integration/unchanged coverage gates →
   build → **`cdk synth`**. No secret or OIDC permission is available here.
2. Read-only preflight verifies complete owner target inputs, distinct staging
   and production targets/origins, existing environments with required **User**
   reviewers, self-review prevention, protected-branch restriction, and protected
   main. Missing config or denied/404 metadata blocks before environment jobs.
   It never creates or modifies an environment.
3. Package the **tested cloud assembly/assets, built output, unchanged forward
   migrations, package manifest and lockfile** once. Store source SHA/run and
   SHA-256 of the payload in a manifest. Upload as immutable v4 artifact
   `release-candidate` (90-day retention). Select its exact ID/archive digest;
   display artifact/source/workflow SHA, operation and target digests in the
   approval summary. No rebuild or re-synthesis in target jobs.
4. Protected **staging** approval/job: verify downloaded archive bytes against
   GitHub's selected SHA-256 **before extraction**, allow only the two expected
   artifact entries, check payload/source provenance, recheck environment policy
   and actual run/environment approval history from a configured User reviewer.
   Refuse changed target inputs. Only then request OIDC role credentials.
5. Assert actual AWS account/region and the approved **existing** RDS instance's
   endpoint, port and database against the protected migration connection.
   Require `sslmode=verify-full`; no credentials in argv or logs.
6. **Prepare, do not execute**, a CloudFormation change set using the frozen
   assembly (`cdk deploy --method prepare-change-set`). Validate that it is
   executable and the stack is in an allowed state. No migration/traffic change
   follows failed/no-op preparation. No `cdk bootstrap`, force deploy or resource
   deletion is invoked.
   Resource removals, definite/conditional replacements and uninspected paginated
   change sets are rejected. Destructive infrastructure evolution requires a
   separately reviewed process, not an implicit rollback exception.
7. Run `node-pg-migrate up` against the artifact's migrations, with order checking.
   A failed migration stops the sequence. Only after success may
   `execute-change-set` change traffic. Wait for actual create/update completion.
8. Resolve the four Lambda resources from the **frozen template**, download their
   actual running code through AWS's signed URLs (never logged), check active/
   successful state and AWS CodeSha256, and compare the regular bundle files
   byte-for-byte with the reviewed assembly assets. No version endpoint or alias
   is invented in the frozen URL-19 application.
9. AC-set observability smoke: real `/healthz` and `/readyz` 200, privacy-safe
   structured completion log with the probe request ID and nonzero trace ID,
   positive `http.server.requests` metric in the observation window, and that
   correlated trace returned by X-Ray. Bounded retries retain the same observation
   ID/window for delayed logs/metrics. Reverify running code after smoke.
10. **Production depends on candidate AND successful staging**, then requires its
    own explicit protected-environment approval. It repeats binding checks,
    migrations-before-traffic, running-code verification and smoke on the exact
    same artifact ID. No `always`, skipped gate, or `continue-on-error` path.

The human release owner must inspect Pam's exact merged-SHA QA and acceptance
evidence before approving production. CI/staging success does not substitute for
Pam's post-merge QA or the human-only evidence-acceptance step; this workflow
does not perform Jira acceptance or manufacture that evidence.

Preparing a change set before migrations is intentional: the frozen URL-19 stack
uses unqualified Lambda traffic targets, not a versioned alias/promotion seam.
Executing the stack first would change traffic too soon. This two-phase pipeline
keeps the existing code untouched while placing migrations before traffic. CDK's
interactive IAM-change prompt is replaced by `--require-approval never` **only
inside the independently authorized protected job**; this does not disable or
substitute for either explicit human environment gate.

Approval is bound to immutable artifact ID/archive/payload/source SHA and target
digest in one workflow run. Changed inputs fail closed. Candidate regeneration
in a re-run is rejected to avoid replaying old run-level approvals against new
inputs; retrying an unchanged failed target job retains the same binding. The
code never replays or edits approval history or asks for duplicate approval to an
unchanged authorized binding. GitHub may independently present its native gates.

## Owner-supplied prerequisites — no invented values

No configuration value, secret, environment, runner or AWS resource is provisioned
by this PR. Before any separately authorized dispatch, the owner must arrange:

- Existing protected GitHub `staging` and `production` environments, required
  authorized User reviewers, prevent-self-review, protected-branch restriction,
  and protected main. The run token must be able to **read** environment policy
  and deployment approval history; permission denial is a blocker, not a bypass.
- Repository variables `RELEASE_STAGING_TARGET` / `RELEASE_PRODUCTION_TARGET`,
  containing owner-supplied JSON with exactly these fields:

  | Field                                                           | Meaning                                                                                                                    |
  | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
  | `account`, `region`, `roleArn`                                  | Actual target and least-privileged OIDC role; trust restricted to this repository/environment/main                         |
  | `stack`                                                         | The existing frozen assembly's physical stack name; no renaming or retargeting                                             |
  | `runnerLabel`                                                   | Explicit label of an authorized dedicated **self-hosted Linux** private-network runner, not a runner created here          |
  | `parameters`                                                    | All eleven exact owner inputs in the unchanged `docs/aws-prerequisites.md`; secret **ARN references**, never secret values |
  | `origin`                                                        | HTTPS shared-domain origin matching DomainLabel/HostedZoneName; no credentials/path/query                                  |
  | `logGroup`, `metricNamespace`, `metricName`, `metricDimensions` | Actual observability read targets; metric name must be `http.server.requests`                                              |
  | `rollbackCompatibilityEvidence`                                 | Rollback only: reviewed HTTPS evidence that the previous artifact works against the current forward schema                 |

- Environment-scoped `RELEASE_DATABASE_URL`: an explicitly supplied private DB
  migration connection, existing approved DB, least-privileged migration role,
  verified TLS and trusted CA. **This is a required configuration contract, not a
  claim that a secret with this name exists or that any value was discovered.**
- An authorized ephemeral/dedicated private runner with Node 22, AWS CLI v2,
  tar/unzip, npm access and private RDS connectivity. Untrusted PR code never runs
  there through this workflow. Hosted runners cannot be presumed to reach private
  RDS; missing/offline private runners remain unexecuted, never green.
- Existing CDK bootstrap resources and scoped publish/deploy IAM; policy also
  needs read access to STS identity, existing RDS metadata, CloudFormation state,
  Lambda code, CloudWatch logs/metrics and X-Ray. No broad/admin policy or new
  credential is selected here. Network, DNS/certificate and AWS prerequisites
  retain their URL-19 owner and safeguards.
- The actual readiness/log/metric/trace implementations and externally authorized
  nonproduction access. The current main scaffold does **not** gain URL-16 or
  other unfinished business features here; smoke fails if evidence is absent.

The fixed assembly stack name must match both approved target bindings. If that
requires separate accounts/regions to keep staging isolated, the owner must
provide those existing targets; the pipeline will not rewrite the frozen stack
to invent another deployment topology.

Self-hosted job workspaces are disposable, not an operator's working tree.
Artifacts contain no `.env`, credentials or node_modules. Payload/verification
scratch paths are gitignored. Raw subprocess stderr/stdout, DB URLs, signed code
download URLs and provider exceptions are not echoed into workflow logs.

## Rollback and failure handling

Dispatch `operation=rollback` only with the immutable artifact ID from a
**completed successful same-repository, main, manual release workflow**. The source
artifact must be unexpired, correctly named and digested, and match its source
run/SHA. A rollback run does not upload a new candidate or rebuild the old one.
Both target gates, exact target bindings, artifact download validation, code-byte
verification and smoke still apply. Database migrations are **not** rolled back
or reapplied from an older release; current forward schema remains in place.
Reviewed schema-compatibility evidence is mandatory, bound through target config
and human approval. A URL's presence is not automatic proof of its contents;
the approving human must inspect that evidence. No compatibility claim is made
without that review/staging validation.

Migration failure prevents traffic change; any subsequent error prevents a
verified/deployed outcome. CloudFormation may itself roll back a failed stack
operation; that never rolls the DB down. A cancelled/timed-out job can leave an
authorized CloudFormation operation in progress: inspect actual state and exact
running artifact before deciding recovery. No forced cancellation, automatic DB
rollback, blind redeploy loop or false success is implemented. A no-change retry
may stop closed rather than silently invent a successful release; investigate
its durable state before recovery. Previous artifacts that have expired are a
named recovery blocker, not grounds to rebuild an alleged identical release.

## Verification boundaries and current access evidence

Unit tests cover policy failures, exact-context checks, missing/weak environment
protection, bot/unapproved/wrong-environment review rejection, changed target or
payload rejection, approval replay prevention, immutable rollback provenance,
archive digest/path guards, stop-before-traffic on migration failure, forward-only
ordering, and health/log/metric/trace smoke negative cases. Workflow structural
tests verify the DAG and lack of privileged automatic triggers. These are offline
fixtures — **not evidence that GitHub/AWS actually enforced a live release**.

Read-only GitHub calls for `environments/staging` and `environments/production`
each returned **HTTP 404** in this session (2026-11-12). That means environment
metadata is **unavailable to this caller**, not proof that it does not exist.
No environment was created or modified. The workflow's policy checks must stop
on that response. Jira MCP is unavailable; no credential search/workaround was
attempted.

Staging/prod deployment, private migrations, real AC smoke, running-release
verification, approval enforcement and rollback execution are **UNEXECUTED**.
No release workflow was dispatched, no AWS command/deploy was run by this task,
no staging/prod resource was changed and no forced notification occurred. There
is no unapproved deferral or claim of green-through-staging: these are explicit
acceptance/access blockers pending authorized prerequisites.

The PR records final exact-head local command exits and actual PR CI logs. Only
quality CI (including the added synth step) may be reported green after inspection.
Ryan does not merge. Dwight's blocked reviewer is not retried; a genuine authorized
exact-head review remains required. Pam owns merged-SHA QA; human production
authorization remains separate. Shared account credentials still cannot prove
account-level separation of an AI role from a human; configuration flags, policy
fixtures, labels and a green CI run do not authenticate human release approval.

## Executed local checks (2026-11-12)

| Command                                                                                  | Exit / actual result                                                            |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `npm ci`                                                                                 | 0; existing exact lockfile, no dependency changes                               |
| `npm run format:check`                                                                   | 0                                                                               |
| `npm run lint`                                                                           | 0                                                                               |
| `npm run check:naming`                                                                   | 0; zero findings plus semantic review                                           |
| `npm run typecheck`                                                                      | 0                                                                               |
| targeted `npx vitest run tests/unit/release-{policy,control,execution,workflow}.test.ts` | 0; **22 passed**                                                                |
| `npm run check:watcher-offline`                                                          | 0                                                                               |
| `npm run test:watcher-offline`                                                           | 0; **58 passed**                                                                |
| `npm test`                                                                               | 0; **2,368 passed / 10 existing optional DB skips**, 26 files passed /1 skipped |
| `npm run build`                                                                          | 0                                                                               |
| `npm run cdk:synth`                                                                      | 0; offline, no credentials/lookups/deploy                                       |
| Native strip-types frozen-assembly validation                                            | 0; actual assembly's default stack ID/template accepted                         |
| Native payload manifest + local tar packaging                                            | 0; local fixture only, not a release/production artifact                        |
| `git diff --check`, protected-source diff                                                | 0                                                                               |

Full unchanged-source coverage: **82.25% lines / 80.91% statements / 82.08%
branches / 83.33% functions**. Existing auth/links coverage gates are unchanged.
Script policy tests are executed, but are not misrepresented as `src/` coverage.
Initial checks caught an over-narrow inferred UUID fixture type, a credential
static guard flagging the validator's literal ARN prefix, and the actual CDK
manifest omitting its default `stackName`. These were corrected (semantic ARN
component parsing and the documented assembly-ID default), then checks reran;
no existing guard, check or exception was weakened. The existing 13 moderate npm
advisories and esbuild install-script warning were disclosed, not silently fixed.

New durable workflow/helper/artifact names describe release purpose and are
owned by URL-shortener engineering. Run IDs identify transient change sets,
not Jira/agent-derived resources. Existing infra/DB/network/volume/backup names
and references remain unchanged. PR CI evidence must show the exact submitted
head and successful **explicit `cdk:synth` step**, not just a YAML declaration.

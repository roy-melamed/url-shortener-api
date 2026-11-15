# Observability spine — implementation and verification

Tracking: URL-16. Owner: URL-shortener engineering. Developer evidence only;
not post-merge QA, staging alert verification, deployment or acceptance.

## Source, scope and dependency decision

Read the approved PRD (`Status: Approved`, 2026-10-08), current requirements,
design §§8.1–8.5 and URL-16's actual Jira description/comments. Explicit assignment
authorizes the lightweight local spine plus the historical AWS alarm/SNS code.
URL-7 and URL-19 are Approved dependencies; neither issue nor any approved source
artifact was modified. URL-9 and URL-10's unmerged implementation branches are
not dependencies and were not imported.

Branch `feature/local-observability`, isolated `/tmp/opencode/local-observability`,
base `01962f8a25cd141d99c669cece4811b8a059ce0b`. URL-16 was transitioned using
its discovered transition **21**, then verified **In Progress / Roy Melamed /
Developer** before implementation. No assignee change. Interrupted helper work
was inspected directly; provider usage-limit errors were not counted as completed
implementation or review. Work resumed in the same configured session, without
changing model, account or credentials.

**Specification boundary:** current requirements AD-16/17 supersede the AWS
deployment basis with Oracle/Redis and withdraw the former 99.9% target, whereas
the assigned URL-16 Jira/design §8 historical AWS scope still names SQS, RDS
Proxy, X-Ray and that availability budget. This change does not restore AWS as
the active platform or decide the availability conflict. Shared code is portable;
the requested AWS artifacts remain code-only. Ongoing measurement/evidence
ownership stays with URL-24/URL-17. Michael/Jim must reconcile any proposed
availability acceptance baseline; no monitoring history or 99.9% achievement is
asserted and no approved specification is overwritten.

## Implemented contracts

### Request logs and privacy gate

- One completion line per request, including failures: ISO `timestamp`, numeric
  `level`, bounded `requestId`, `traceId`, route **template**, method, status,
  duration in ms, principal `{type,id}`, outcome and optional safe `errorCode`.
- Caller request IDs accept only 1–128 ASCII identifier characters; otherwise a
  ULID is generated. Raw URLs, request/response objects, SQL/driver errors,
  stack traces, bodies, headers and IP fields are not logged. Unknown structured
  fields and child bindings are discarded. Authorization, cookies, passwords,
  access/refresh tokens are censored; startup URL/address string arguments are
  scrubbed. Neither hostname nor PID base fields are emitted.
- `setRequestObservation` is a validated feature-owner hook: UUID user/key IDs
  only, bounded redirect/cache/country outcomes, no tokens or IP arguments.
  The scaffold correctly remains anonymous until its actual auth owner resolves
  a principal. No redirect/auth/CAPTCHA business behavior was invented.
- `check:log-shape` is a distinct required CI command and also part of the full
  test suite. It checks real positive/404/500/readiness log output, secret-bearing
  input/header/body/query/error fixtures, nested objects and child bindings.
  This is a tested logging contract, not a general-purpose secret classifier:
  future code must not place secrets in arbitrary trusted message templates.

### Health and readiness

`GET /healthz` remains unauthenticated liveness with no dependency check.
`GET /readyz` performs **only `SELECT 1 AS ready`** through the existing configured
pool seam (direct local DB or injected proxy URL). Pool acquisition is bounded
at 1s; the readiness query has a 1s client timeout, in addition to the existing
server statement timeout. Failed clients are disposed; pool shutdown is tied to
app close. Broken idle clients do not cause an unhandled EventEmitter exception.
Results are 200 `{status:"ok"}` or 503 `{status:"unavailable"}` with no-store and
no host/error/credential details. No queue is silently made a liveness dependency.

`npm run probe:readiness -- <local-/readyz-URL> [samples] [intervalMs]` is an
opt-in, bounded observation collector. It reports timestamp/healthy/duration,
not URLs or response bodies. Remote HTTPS requires the caller's explicit
`--authorized-nonproduction` flag **and actual external authorization**; the flag
does not grant access. No scheduler, staging probe or production probe is
installed or executed by this work. Probe samples are not monthly availability.

### Metrics, traces and feature integration

The actual OTel Meter emits counters, duration histogram and queue/DLQ gauges.
Only enumerated route/method/result/cache/kind/reason/subject-type labels and
valid statuses survive. No unbounded user IDs, IPs, SQL, referrers or URLs are
metric dimensions. In-memory SDK collection verifies a nonempty sample from
**every catalog family**, including the latency histogram and error counter.
Those fixture emissions prove instrument contracts, **not production feature
activity**.

| §8.3 family                                                          | Spine / actual owner hook under F-19                                                                                                                                  |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http.server.requests`, `http.server.duration`, `http.server.errors` | Wired to actual shared HTTP responses; errors count server 5xx by route/status                                                                                        |
| `redirect.requests{result,cache}`                                    | Typed `redirect` hook; URL-13 records real redirect outcomes                                                                                                          |
| `links.created{kind}`, `idempotency.replays`                         | Typed hooks; URL-11 records committed create/replay outcomes                                                                                                          |
| `auth.failures{reason}` including `anon_create_rejected`             | URL-9/21/22 credential handlers; URL-11 anonymous-create decision                                                                                                     |
| `ratelimit.rejected{subject_type}`, `captcha.challenged/failed`      | URL-10/11 real limiter/CAPTCHA decisions                                                                                                                              |
| `geo.resolved/miss`                                                  | URL-13 resolver outcome; no IP-valued labels                                                                                                                          |
| `click.messages.enqueued/failed`                                     | URL-13 real producer outcomes                                                                                                                                         |
| `sqs.depth`, `dlq.depth`                                             | Typed bounded gauge hooks; historical AWS native queue metrics/alarm dimensions are wired to existing queue constructs; active Redis integration stays with its owner |
| RDS / RDS-Proxy native metrics                                       | Historical AWS construct references, not a replacement database or fabricated local metric                                                                            |

Native startup registers the SDK **before dynamically loading app/pg adapters**.
The Lambda factory preserves its async warm-up while doing the same. Importing
the telemetry module alone does not start an SDK. Missing OTLP endpoint disables
export/SDK startup; zero trace ID denotes disabled tracing rather than an invented
trace. Explicit configured local startup produces real nonzero trace IDs.

HTTP outgoing, pg and AWS SDK/SQS instrumentations are registered; Fastify owns
incoming HTTP spans so one privacy-safe server span correlates each completion.
W3C traceparent is validated, baggage and arbitrary tracestate are not persisted.
The queue carrier/link helper connects a producer to an aggregation span without
copying payloads. `geoLookup(callback)` creates a resolver span without taking an
IP argument. No SQS producer/consumer or GeoIP feature implementation is invented.

The export-boundary span processor projects an explicit safe ReadableSpan:
bounded attributes, stable operation names, no raw SQL/network/URL/header/error
events, fixed resource attributes and payload-free links. Exception status is
retained without sensitive exception messages/stacks. SDK recording is 100%; the
local collector retains all traces. The AWS collector example uses **tail
sampling** (ERROR policy plus 10% probabilistic baseline), not head sampling that
cannot recover a later error. It requires complete trace-affine delivery to the
collector; bounded buffers/late arrivals can still lose telemetry. Production
generators use the official X-Ray-compatible ID generator. No claim of an active
AWS collector, complete historical tracing or live SQS tracing is made.

### Opt-in local tools and historical AWS code

For a **new disposable local stack**, the separate
`deploy/observability/compose.local.yaml` defines a collector (OTLP on loopback
14318, Prometheus on 18889) and Jaeger UI on loopback 16686, with no persistent
volumes. Run it only explicitly with an isolated project name. It does not alter
the original Compose stack, `.env`, Oracle DB/network/volume or a running service.
`.env.example` now points to the collector: Jaeger alone accepts traces but does
not accept metric exports. Local endpoint validation rejects credentials,
query/fragment/path and nonloopback origins.

`deploy/observability/aws-collector.yaml` is an ADOT-compatible example for OTLP
to X-Ray and CloudWatch EMF, with explicit sampling policy. IAM, region, collector
placement, authenticated access and target deployment are external owner inputs.
No credential lookup, layer installation or AWS call is performed here.

`ServiceAlarms` adds exactly seven alarms to the existing historical stack:

1. API 5xx/count **>1% over 5min** (percentage math, not absolute errors).
2. GET/HEAD redirect integration **p95 >120ms for ten consecutive minutes**;
   conservative cache-miss budget, includes integration overhead (no cache-hit
   latency claim).
3. `/readyz` 5xx in **two consecutive one-minute windows**; actual request traffic
   is required. The probe above is opt-in, not a fabricated running uptime probe.
4. Actual click DLQ visible depth **>0**.
5. Actual click queue oldest-message age **>300s**.
6. Actual proxy backend connections / allowed capacity **>80%**.
7. Actual maintenance Lambda Errors **>0**.

Missing data remains missing, not healthy. All alarm/OK actions target the shared
SNS topic. Publish permission is scoped to the exact alarm ARNs and account.
An existing owner-managed topic may be injected; no subscriber, email/Slack
endpoint or forced notification is invented. Route detailed metrics are enabled
in the synthesized API stage. Synth tests assert exactly seven alarms, periods,
thresholds, metric references/dimensions, SNS actions/policy and zero subscriptions.
No AWS deployment or forced alarm/SNS/page action occurred.

## Executed verification and remaining acceptance boundary

The PR body records the exact head, final command exits/counts and fresh CI link.
Required checks retain all previous steps and unchanged auth/links coverage gates.
New durable names are descriptive service-purpose names; `check:naming` and
semantic review preserve all existing runtime/DB/volume/backup identities.

Local final executed commands (2026-11-12):

| Command                                   | Exit / result                                                                            |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| `npm ci`                                  | 0; pinned lockfile install                                                               |
| `npm run format:check`                    | 0                                                                                        |
| `npm run lint`                            | 0                                                                                        |
| `npm run check:naming`                    | 0; zero findings                                                                         |
| `npm run typecheck`                       | 0                                                                                        |
| `npm run check:log-shape`                 | 0; 6 tests passed                                                                        |
| `npm run check:watcher-offline`           | 0                                                                                        |
| `npm run test:watcher-offline`            | 0; 58 tests                                                                              |
| `npm test`                                | 0; **2,369 passed / 10 existing optional DB tests skipped**, 29 files passed / 1 skipped |
| `npm run build`                           | 0                                                                                        |
| `npm run cdk:synth`                       | 0; offline, no deploy                                                                    |
| `git diff --check`, protected source diff | 0                                                                                        |

Full-suite coverage: **85.17% lines / 84.69% statements / 83.59% branches /
84.21% functions**, platform lines **90.52%**. Existing auth/links gates remain
unchanged. Native child-process execution is verified but is not misrepresented
as instrumented Vitest coverage. Initial checks exposed incompatible OTel-v3
constructor typing, a Pino base-bindings null case, and Pino child-bindings
bypassing its parent formatter; these were corrected and the regression gate
rerun. Early failing invocations are not passing evidence. Dependencies remain
exact-pinned; npm's 13 moderate advisories and esbuild/protobufjs install-script
warnings are disclosed, not silently fixed or waived.

The native-runtime integration test boots a real SDK in a separate Node process,
serves real HTTP traffic, validates a remote traceparent and linked queue/GeoIP
spans, and captures actual encoded OTLP HTTP traces **and metrics** through a
disposable loopback collector fixture. It asserts nonzero correlated trace IDs,
exported request/error/histogram instruments and absence of planted secrets/IPs.
With CI-only service flags it additionally runs SELECT 1 against dedicated
PostgreSQL and forwards traces to real dockerized Jaeger, then queries Jaeger's
API for the exact emitted trace. CI execution must be inspected before claiming
those service checks ran; local mocks are not that evidence.

Local Docker enumeration exits **1: permission denied connecting to the Docker
socket**. Therefore real local PostgreSQL/Jaeger and collector-container operation
are **unexecuted locally**. No privilege escalation or production database was
used. CI defines disposable PostgreSQL 16 and Jaeger test services; the DB fixture
guards the loopback `observability_test` target and performs no migration/reset.

**Still unexecuted/unverified, not approved deferrals or passed criteria:**

- Staging forced error → actual CloudWatch alarm state change → actual SNS
  notification (X-14 / AC-FR-10.5). Authorized nonproduction deployment/access and
  owner-managed confirmed notification target are unavailable in this session.
- Actual deployed ADOT → X-Ray/CloudWatch delivery, collector tail sampling under
  load, real SQS delivery/aggregation links and production feature metrics.
  Feature-specific hooks remain with their F-19 owner tickets above.
- Running uptime probe / monitoring history and any availability acceptance
  baseline. URL-24/URL-17 own the continuing evidence; no period is invented.

These limits block full live acceptance; there is no self-approved waiver. Ryan
submits implementation for exact-head Dwight review and never merges, deploys,
marks QA PASS or moves an issue to Evidence Review. Pam must verify the exact
merged main SHA and retain the named blockers until actually resolved.

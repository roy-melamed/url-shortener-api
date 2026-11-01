# Infrastructure (URL-19) — AWS CDK

The `UrlShortenerApi` stack is the whole AWS footprint of the URL Shortener API.
It is written against the approved design and requirements, **synthesizes
offline**, and **deploys nowhere until the owner supplies the AWS
prerequisites** (`docs/aws-prerequisites.md`).

```bash
npm run cdk:synth        # offline synthesis → cdk.out/ (gitignored)
npm test                 # includes the synthesis assertions in tests/infra/
```

There is intentionally **no deploy script** in this repository: staging and
production deploys are gated on owner-provided values and human approval
(D-15 / design §9.6, URL-20 owns the pipeline).

## What the stack creates, and why

| Resource                                                                                                                                                                          | Design/decision refs                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| API Gateway **HTTP API** with `GET /healthz`, `GET /readyz` → `apiFn`, `ANY /v1/{proxy+}` → `apiFn`, `GET`/`HEAD /{slug}` → `redirectFn`, `$default` → JSON 404                   | §3.1 (static precedence over `{slug}`), §5.1                                                            |
| **Four Lambdas** in private subnets: `redirectFn` (1024 MB/10 s, reserved 500), `apiFn` (512 MB/30 s, reserved 200), `aggregatorFn` (512 MB/60 s), `maintenanceFn` (256 MB/300 s) | D-1, NFR-3, §9.4 (concurrency caps), §1.3 (Node 22 + TypeScript)                                        |
| **SQS** click queue (48 h retention, 360 s visibility) + **DLQ** (maxReceiveCount 5) → `aggregatorFn`, batch ≤ 100                                                                | D-8, §3.6 (`reportBatchItemFailures` deliberately off — whole-batch redelivery + the §13-c1 dedup gate) |
| **RDS Proxy** (`POSTGRESQL`, `RequireTLS`, secret auth) + target group pointing at the **existing** RDS instance                                                                  | D-4, §9.4, FR-9.2 — **no database is ever created**                                                     |
| **Secrets Manager references** for DB/JWT/OAuth/CAPTCHA; `DATABASE_URL` composed at deploy time from `{{resolve:secretsmanager:…}}` + the proxy endpoint                          | §6.2, §10.6-era env contract (`src/platform/config.ts`)                                                 |
| VPC with public/private subnets, **1 NAT gateway** and the four §6.3 **VPC endpoints** (SQS, Secrets Manager, CloudWatch Logs, X-Ray)                                             | §6.3, §3.9                                                                                              |
| **Route 53** alias to **one shared custom domain** (+ ACM DNS-validated certificate)                                                                                              | §3.1, NFR-9                                                                                             |
| **EventBridge Scheduler** group + one schedule per §3.7 job (4 daily, `rate-limit-hygiene` hourly) targeting `maintenanceFn`                                                      | §3.7, backlog-audit F-14                                                                                |

## What it deliberately does not create

- **No CloudFront / CDN / edge / WAF** — AD-1 (origin click counts), AD-2
  (transient in-process GeoIP, no edge layer), AD-7 (in-app rate limiting).
- **No per-user or custom domains** — NFR-9: single shared domain now, the v2
  extension point stays documented in design §10.6.
- **No RDS instance/cluster** — FR-9.2: the PostgreSQL instance already exists
  and is managed externally (A1/AD-11).
- **No SES resources, no hosted zone** — both are owner-side prerequisites.
- **No alarms/log groups policy** — observability wiring (alarms → SNS,
  `/readyz` probes, access-log format) is URL-16's scope.

## Local parity — running the maintenance jobs without a cloud (FR-9.3, NFR-7)

Design §3.7 schedules five jobs in the cloud. The same handler runs locally:

```bash
npm run job:maintenance -- list
npm run job:maintenance -- idempotency-gc     # or dedup-gc, aggregate-purge,
                                              # rate-limit-hygiene, tombstone-audit
```

The runner loads the gitignored `.env` exactly like `npm run dev` and invokes
`src/functions/maintenance.ts` with the same `{ job }` payload the EventBridge
Scheduler rules inject. Local cron parity:

```cron
0 3 * * *  cd <repo> && npm run job:maintenance -- idempotency-gc
0 3 * * *  cd <repo> && npm run job:maintenance -- dedup-gc
0 3 * * *  cd <repo> && npm run job:maintenance -- aggregate-purge
* * * * *  cd <repo> && npm run job:maintenance -- rate-limit-hygiene
0 4 * * *  cd <repo> && npm run job:maintenance -- tombstone-audit
```

## Who owns what

- **URL-19 (this ticket)** owns the infrastructure and the handler _entry
  points_/wiring. `aggregatorFn` and `maintenanceFn` currently **fail loudly**
  ("not implemented yet") rather than silently dropping clicks or skipping GC
  — see `src/functions/aggregator.ts` and `src/functions/maintenance.ts`.
- **URL-14** owns the §3.6 aggregation logic and all five §3.7 job runners
  (backlog-audit F-13/F-23); it replaces those two handlers and registers the
  runners in the `maintenanceFn` job registry.
- **URL-12 / URL-13** own the `/v1` CRUD and the redirect behaviour behind
  `apiFn`/`redirectFn`; **URL-16** owns alarms, metrics and `/readyz`;
  **URL-20** owns the CI/CD pipeline that will run `cdk synth`/`cdk deploy`.

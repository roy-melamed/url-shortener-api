# Design Document: URL Shortener API

| Field | Value |
|---|---|
| **Artifact** | `specs/url-shortener-api/design.md` |
| **Status** | Architecture decisions **human-resolved 2026-10-12** (AD-1…AD-15, §11) · **platform revised 2026-11-02** (AD-16: Oracle Cloud VM / Docker Compose, superseding A1/AD-11 and A2/AD-12) · **operational choices approved 2026-11-02** (AD-17: Redis Streams, OCI backups, Caddy, secrets, alerts, manual CI/CD gate, SSH tunnel test path) |
| **Date** | 2026-10-11 (initial) · **Revised 2026-10-12** (resolutions incorporated) · **Readiness review 2026-10-13** (§13 corrections c1–c4, escalation E1) · **Oracle platform update 2026-11-02** (AD-16, AD-17) |
| **Author** | Dwight Schrute — Architect & Code Reviewer |
| **Inputs** | `/home/roy/projects/ai-squad/PRD.md` (Approved, 2026-10-08, immutable) · `specs/url-shortener-api/requirements.md` (Reconciled, revised 2026-11-02 for AD-16/AD-17) |
| **Decisions recorded** | AD-1…AD-15 resolved by human (Michael) 2026-10-12; **AD-16** and **AD-17** resolved by human (Michael) 2026-11-02 — see §11 (resolution log) |
| **Next hand-off** | Implementation tickets **created 2026-10-12** on explicit instruction: Epic **URL-6**, tasks **URL-7…URL-17** (project URL, assignee = human owner, Agent Owner = Developer) → Developer, coordinated by Michael. **2026-11-02:** propose Oracle Docker Compose scope (see §14.11 Jira proposal); URL-19 (AWS CDK) remains in Evidence Review / Agent Owner Human; URL-20 (AWS CI/CD) remains To Do / Agent Owner Developer. |
| **Notes** | PRD.md not modified. `requirements.md` revised 2026-11-02 by Jim to record AD-16. **Historical AWS design (PR #6, URL-19, URL-20) is preserved as superseded, not erased.** AWS CDK source files in `infra/`, `cdk.json`, `docs/aws-prerequisites.md`, and `tests/infra/` remain in the repository as the record of the approved AWS design. AM-2 (PRD footer status inconsistency) remains a documentation matter for the human owner. |

---

## 1. Overview

### 1.1 Purpose and scope

A privacy-first URL shortener delivered as an API + database only: accounts with dual authentication (API keys + JWT), link CRUD with auto-generated and custom slugs, idempotent creation, fast anonymous redirects (302, 410, 404), aggregate-only analytics (total/referrer/country), QR code generation (PNG/SVG), per-user rate limiting, risk-triggered CAPTCHA-protected creation, and full observability. **Deployment platform (AD-16, 2026-11-02):** containerized Docker Compose on the confirmed Oracle Cloud Ubuntu ARM64 VM, reusing the existing PostgreSQL 16 container `url8-pg`; the historical AWS serverless design (Lambda + API Gateway + RDS Proxy + CDK) is preserved as superseded. Targets: 10,000+ users, 1,000,000+ links (NFR-2) — scale targets are retained as design targets; the single-VM deployment is acknowledged as a personal MVP that may require horizontal scaling to meet them.

Scope boundaries (PRD §4, requirements §3.2): no frontend, no custom domains (NFR-9: designed-for), no teams, no bulk ops, no webhooks, no interstitials, no GDPR workflows, no monetization. **Out of scope for AD-16:** migration or modification of the existing AWS RDS `database-1`, its data, or any AWS resource; any data migration/deletion is a separate, unmade decision. This document does not implement features and does not modify the PRD. All architectural forks that previously required human input were **resolved on 2026-10-12 (AD-1…AD-15, §11)**; the deployment platform was **resolved on 2026-10-12/2026-11-02 (AD-16)**; key operational tooling choices were **resolved on 2026-11-02 (AD-17)**; residual open items are implementation specifics and product clarifications tracked in §10 and §11.2.

### 1.2 System context

#### 1.2.1 Current approved context — Oracle Cloud VM / Docker Compose (AD-16, 2026-11-02)

```
  Client ──HTTPS──────▶  Oracle Cloud Ubuntu ARM64 VM
  (server-to-server,      ┌─────────────────────────────────────────────────────────┐
   browsers, visitors)    │  Reverse proxy (Caddy/nginx) :443 → app:3000           │
                          │  TLS termination + HTTP→HTTPS redirect                  │
                          │  (single shared domain per NFR-9)                     │
                          │                                                         │
                          │  ┌─────────────────────────────────────────────────┐   │
                          │  │  Docker network: urlshortener_app (egress)      │   │
                          │  │  app (Node 22 Fastify)                          │   │
                          │  │  ├── /healthz, /readyz, /v1/*, GET /{slug}     │   │
                          │  │  ├── transient GeoIP (in-memory, AD-2)         │   │
                          │  │  └── enqueue click ──▶ redis/streams ──▶ aggregator │
                          │  │       {eventId, linkId, referrerHost,          │   │
                          │  │        country, day} — no IP                    │   │
                          │  │                                                 │   │
                          │  │  aggregator worker  maintenance scheduler      │   │
                          │  │  (URL-14 logic)     (cron/supercronic)         │   │
                          │  └──────────┬────────────────────────────────────┘   │
                          │             │ app↔DB private network only            │
                          │  ┌──────────┴────────────────────────────────────┐   │
                          │  │  Docker network: urlshortener_db (DB-only)     │   │
                          │  │  PostgreSQL 16 (`url8-pg`) persistent volume   │   │
                          │  │  NO published ports · NO public exposure       │   │
                          │  └─────────────────────────────────────────────────┘   │
                          │                                                         │
                          │  Secrets: owner-provided, injected at deploy,           │
                          │  never committed. Backup sidecar → off-VM store.        │
                          │  Logs/metrics/traces: self-hosted (e.g. Prometheus/     │
                          │  Grafana/Loki/Jaeger) replacing CloudWatch/X-Ray.       │
                          └─────────────────────────────────────────────────────────┘
```

**Hard constraints from AD-16:** reuse the running `url8-pg` container and its exact current persistent volume; Compose must not create/recreate a Postgres service or use `down -v`; PostgreSQL must not be publicly exposed; restart policies, health checks, persistent storage, and automated backups are required; no committed secrets; no new AWS resources; no deletion of AWS resources/databases; HA/Multi-AZ/99.9% explicitly not required.

#### 1.2.2 Historical AWS context — superseded by AD-16, preserved for audit

```
                        ┌─────────────────────────────────────────────────────────┐
                        │ AWS (existing account)                                  │
  Client ──HTTPS──────▶  │  Route 53 ─▶ API Gateway (HTTP API, custom domain)      │
  (server-to-server,      │                 │        NO CDN / CloudFront in front   │
   browsers, visitors)    │     ┌───────────┴────────────┬──────────────┐  (AD-1/2/7)│
                         │     ▼                        ▼              │           │
                         │  redirectFn               apiFn            │           │
                         │  (GET /{slug})      (everything /v1/*)      │           │
                         │  + transient GeoIP                          │           │
                         │  (in-memory, AD-2)                          │           │
                         │     │  │                    │               │           │
                         │     │  └─ enqueue click ──▶ SQS ─▶ aggregatorFn         │
                         │     │   {eventId, linkId, referrerHost,            │           │
                         │     │    country, day} — no IP            │           │
                         │     ▼                           ▼           │           │
                         │  in-process LRU cache   maintenanceFn       │           │
                         │  (Tier-1 only, AD-1)   (scheduled jobs)     │           │
                         │     │                           │           │           │
                         │     └────────┬──────────────────┘           │           │
                         │              ▼                              │           │
                         │        RDS Proxy ──▶ Amazon RDS PostgreSQL  │           │
                         │   (existing, Multi-AZ confirmed per A1,     │           │
                         │    private subnets)                         │           │
                         │                                              │           │
                         │  Secrets Manager · SES · OTel ─▶ CloudWatch │           │
                         │  (secrets)        (email)  (logs/metrics/    │           │
                         │                     traces, alarms → SNS)   │           │
                         └─────────────────────────────────────────────────────────┘
```

*The AWS diagram above was the approved design through PR #6 (URL-19). AD-16 (2026-11-02) superseded its runtime platform while preserving the product behavior, module boundaries, and privacy invariants. The CDK source files remain in the repository as historical record.*

 Local dev: same Fastify app runs as a plain Node HTTP server against docker-compose
 (PostgreSQL + Jaeger + MailHog + local geo DB) — no Lambda/API Gateway emulation (FR-9.3, NFR-7).

### 1.3 Technology stack (AD-16, 2026-11-02 — Oracle Cloud VM / Docker Compose)

| Layer | Choice | Requirement drivers |
|---|---|---|
| Runtime | Node.js 22 LTS + TypeScript (strict), running inside Docker containers on ARM64 | FR-9.3, NFR-7 — same image local and deployed; `node:22-slim`/`node:22-alpine` have ARM64 variants |
| Web framework | **Fastify** + JSON Schema validation, plain `listen()` inside the container; `aws-lambda-fastify` retained in source for the historical AWS entrypoint only | FR-7.2, NFR-1, FR-9.3 — AD-16 keeps Fastify as the application server; dual-entrypoint code is historical, not the active deploy path |
| Deploy platform | **Docker Compose on the confirmed Oracle Cloud Ubuntu ARM64 VM** — single-VM personal MVP; HA/Multi-AZ/99.9% explicitly not required | FR-9.1, FR-9.2, NFR-3 · **revised AD-16** (supersedes A2/AD-12) |
| Data access | `pg` driver + parameterized SQL + `node-pg-migrate` migrations | NFR-7; predictable hot-path queries; unchanged by platform switch |
| Database | **Existing PostgreSQL 16 container `url8-pg`** on the same VM, persistent Docker volume, private Docker network only — no RDS Proxy, no AWS RDS dependency for the Oracle path | FR-9.2 (revised by AD-16) · **supersedes A1/AD-11** |
| Async pipeline | **Redis Streams** (persistent, consumer groups, retry/DLQ) → aggregator worker container; **not synchronous per-click DB write**; redelivery/replay horizon must remain strictly shorter than 7-day `click_event_dedup` token retention | FR-4.4, FR-5, NFR-4 · **approved AD-17** |
| QR generation | `qrcode` npm (pure-JS: PNG via pngjs, SVG string) | FR-6.1/6.2 — no native deps → portable |
| Auth | Self-managed: argon2id passwords, JWT access + rotating refresh, hashed API keys, **Google + GitHub adapters only** (`openid-client` + GitHub OAuth, PKCE) | FR-1.1/1.2/1.3, NFR-5, AD-14 (Q6/A5 resolved) |
| Country resolution | In-process **transient GeoIP** module (geo DB via local file); vendor TBD (§10.9) | FR-5.1, AD-2 (Q4 → Option B) |
| CAPTCHA | Pluggable **`CaptchaProvider`** interface, trigger mode **`suspicious`**; vendor TBD (§10.8) | FR-2.7, AD-3 (Q5 → mode resolved) |
| Email | Owner's existing transactional email provider/SMTP relay reachable from the VM; local dev still MailHog; **standard double opt-in** verification | FR-1.2, AD-14 (A5 confirmed) · **provider approved AD-17** |
| Rate limiting | Sliding-window counter in PostgreSQL, subjects `user:`/`apikey:` | FR-8.1/8.2, AD-7 (Q3/A4/AM-4 resolved) |
| Logging | `pino` structured JSON to stdout; collected by host/agent or sidecar (replacing CloudWatch Logs) | FR-10.1, FR-10.6 |
| Metrics/traces | OpenTelemetry → self-hosted backend (Prometheus/Grafana/Loki/Jaeger) replacing CloudWatch/X-Ray; local OTLP → Jaeger retained | FR-10.3/10.4, FR-10.6 · **approved AD-17** |
| Alerting | Self-hosted alerting (Prometheus Alertmanager) for health/log/resource/disk/backup alerts → owner notification channel (email/Slack) replacing CloudWatch Alarms→SNS | FR-10.5 · **approved AD-17** |
| Backup | Daily encrypted dumps (`urlshortener`, `url8_acceptance`, `pg_dumpall --globals-only`) to **Oracle Cloud Object Storage** with 7-day retention; **verified restore test required before production**; ongoing cadence/target/owner open AD-17 follow-on #1; least-privilege DB credentials | FR-9.2, NFR-6 · **approved AD-17** |
| Reverse proxy | **Caddy** for HTTPS termination when a domain exists; no public ports until then | FR-9.1 · **approved AD-17** |
| Secrets | Protected outside Git (`.env`/Docker Secrets/CI variables); no committed literals | NFR-5, NFR-7 · **approved AD-17** |
| IaC | **Docker Compose files** in the repository (git-committed, no secrets); historical AWS CDK files preserved | One-language toolchain; NFR-7 · AD-16 replaces CDK with Compose for the active path |
| CI/CD | GitHub Actions: lint → typecheck → test → build → image build → compose validation → deploy to staging VM → **manual human approval gate** → deploy to prod VM | Approval gates never bypassed; **approved AD-17** · SSH/self-hosted runner/registry/VM credentials owner-supplied and currently missing |

**Platform rationale (AD-16, 2026-11-02):** the owner approved a personal MVP on the confirmed single Oracle Cloud ARM64 VM, reusing the existing `url8-pg` container and volume. This explicitly trades AWS-managed HA, scaling, and observability for operational simplicity and cost, with the understanding that HA/Multi-AZ and the former 99.9% target are withdrawn. Product behavior (redirects, async aggregation, privacy invariants) and application code are unchanged; only the runtime platform, secrets model, and operational tooling are replaced. The historical AWS CDK implementation (PR #6, URL-19) remains in the repository as a superseded record.

---

## 2. Architecture Decisions and Rationale

> Numbering: **D-1…D-15** below are design decisions owned by the Architect. Human-gated decisions are **AD-1…AD-15** (§11). All previously conditional rows now carry their resolution.

| # | Decision | Rationale | Requirement drivers · status |
|---|---|---|---|
| **D-1** | Deploy platform: **Docker Compose on the confirmed Oracle Cloud Ubuntu ARM64 VM**; single-VM personal MVP; app/aggregator/scheduler/reverse-proxy containers. Historical AWS Lambda + API Gateway entrypoints preserved in source, superseded by AD-16. | Owner-approved personal MVP (AD-16); reuses existing `url8-pg`; operational simplicity on a single VM; HA/Multi-AZ/99.9% explicitly not required | FR-9.1/9.2 · **revised AD-16** (supersedes AD-12) |
| **D-2** | Framework: **Fastify on TypeScript/Node 22**; active entrypoint is plain `listen()` inside the app container; historical Lambda adapter (`aws-lambda-fastify`) retained in source only | Fast startup, low overhead; JSON-Schema validation; identical application code local and deployed; no cloud emulation needed for development | FR-7.1–7.3, NFR-7 · retained under AD-16 |
| **D-3** | Data access: raw `pg` + parameterized SQL + `node-pg-migrate` | Full control over hot-path query plans; zero runtime magic; trivially runs against local Postgres and the `url8-pg` container | NFR-7, FR-9.3 · final |
| **D-4** | Deployed DB access: **direct `pg.Pool` over a private Docker network** to the existing `url8-pg` container; no RDS Proxy in the Oracle path. RDS Proxy remains in the historical AWS CDK stack only | Single-container/single-VM deployment has low connection churn; tiny per-container pool (`max=2`) is sufficient; private Docker network provides network isolation | FR-9.2, NFR-7 · **revised AD-16** (supersedes A1/AD-11 RDS Proxy leg) |
| **D-5** | Auto slug: **7-char base62 (`[a-zA-Z0-9]`), crypto-random, insert-with-retry** (max 8 attempts on unique-violation) | 62⁷ ≈ 3.5×10¹² space; at 1M links per-insert collision probability ≈ 3×10⁻⁷; DB unique constraint is the single source of truth (no allocator to race) | FR-2.2, FR-2.4 · final |
| **D-6** | Custom slug: strict validation (3–50 chars, **`[a-zA-Z0-9]`** app + DB CHECK) via **`slug_reservations` tombstone table**; collision → `409` with **3 availability-checked alternatives** | Tombstones let `links` rows hard-delete (FR-1.4) while slugs stay reserved FCFS (FR-2.4) | FR-2.3/2.4 · **resolved AD-5 (never release), AD-8 (strict charset, 3 suggestions)** |
| **D-7** | Idempotency: **PostgreSQL-backed records** — `UNIQUE(principal, key)`, **create executes in one ACID transaction** (§3.5; persisted `in_progress` eliminated — §13-c2), 24h TTL, request-hash mismatch → `409` | Survives container restarts and multi-container concurrency; crash mid-create rolls back cleanly (no partial row, no stuck record); replays return stored response with no duplicate row; no extra infrastructure | FR-2.5, AC-04 · **amended §13-c2** |
| **D-8** | Click aggregation: redirect → **Redis Streams (persistent, consumer groups, retry/DLQ)** → aggregator worker container → **eventId-deduped (§13-c1)** upserts into **daily aggregate buckets + un-capped `BIGINT` all-time totals**; **no raw click-event rows ever stored**; daily buckets purged after 30 days; totals kept indefinitely. **No synchronous per-click DB write.** AWS SQS remains in the historical CDK stack only | Strongest reading of NFR-4/FR-5.2; per-event ULID dedup gives exactly-once *effects* under at-least-once delivery; queue redelivery/replay horizon must be strictly shorter than the 7-day `click_event_dedup` token retention (§14.5 safety rule). **Approved AD-17 (Redis Streams); URL-14 owns consumer behavior** | FR-4.4, FR-5, NFR-4 · **approved AD-17** |
| **D-9** | Redirect caching: **Tier-1 per-container LRU** (positive 60s / negative 30s) + **`Cache-Control: no-store`** on 302s; **no Tier-2 CDN** | AD-1: accurate origin click counts required; 302s are not browser-cacheable; Tier-1 bounds edit-staleness at 60s while every repeat hit still reaches origin | FR-4.1/4.4, NFR-1 · **resolved AD-1 (302 branch)** |
| **D-10** | Rate limiting: **sliding-window counter in PostgreSQL** (1-minute windows, weighted estimate), subjects `user:` / `apikey:` at uniform **100 req/min** | AD-7: in-app branch chosen; no Redis dependency (NFR-7, local parity); weighted sliding window avoids fixed-window 2×-burst flaw; subject-keyed policy rows leave a tier extension point without redesign | FR-8.1–8.3 · **resolved AD-7 (Q3/A4/AM-4)** |
| **D-11** | Auth: **self-managed** — argon2id passwords; JWT access (15 min) + rotating refresh (hashed, revocable); API keys `usk_<prefix>_<secret>` stored as prefix + SHA-256, constant-time verify; **Google + GitHub** authorization-code + PKCE | Dual auth (FR-1.3) in one middleware chain; hashed credentials revocable on account deletion (FR-1.4); no hosted UI keeps service API-only and locally runnable | FR-1.1–1.4, NFR-5/7 · **confirmed AD-14 (providers + double opt-in)** |
| **D-12** | QR codes **generated on demand, never stored**; `?format=png\|svg`; payload = **short URL**; no styling options | Stateless, zero eviction logic; pure-JS lib works identically in container and local | FR-6.1/6.2 · **resolved AD-15 (Q7)** |
| **D-13** | Observability: **pino (JSON) + OpenTelemetry**; deployed backend = self-hosted **Prometheus/Grafana/Loki/Jaeger** on the VM; alerting = **Prometheus Alertmanager** covering health/log/resource/disk/backup alerts → owner notification channel (email/Slack); local: OTLP → dockerized Jaeger retained | One instrumentation set for cloud and local (FR-10.6); AWS-specific backends (CloudWatch/X-Ray/SNS) no longer apply. **Approved AD-17** | FR-10.1–10.6, NFR-8 · **approved AD-17** |
| **D-14** | Analytics schema: `country_code CHAR(2) NOT NULL DEFAULT 'ZZ'` (unknown sentinel — §13-c3) fed by **transient request-time GeoIP (AD-2)**; referrer stored as **host only** (lowercased, `www.` stripped, `(direct)` bucket); counts `BIGINT` | Only the ISO country code leaves the resolver — IP never persisted/logged; `'ZZ'` keeps composite PK/UNIQUE upsert targets NULL-free (NULLs are not equal — c3); host-only referrer caps cardinality and avoids leaking token-bearing referrer URLs; `BIGINT` absorbs any realistic volume (AD-9) | FR-5.1/5.2, NFR-4 · **resolved AD-2 (Option B), AD-9; sentinel amended §13-c3** |
| **D-15** | CI/CD: GitHub Actions: lint → typecheck → test → build → Docker image build → compose validation → deploy to staging VM → **manual human approval gate** → deploy to prod VM; migrations as pre-deploy step; rollback = redeploy previous image tag (forward-only migrations). Historical CDK synth/deploy path preserved in URL-20 | Un-bypassable human gate; image-tag rollback; safe rollback posture; no new AWS resources created by the Oracle pipeline. **Approved AD-17** · missing owner-supplied: SSH/self-hosted runner/registry/VM credentials | FR-9.1 · **approved AD-17** |

---

## 3. Component Design

### 3.1 Edge and routing

- **Oracle path:** reverse proxy (**Caddy** — approved AD-17) terminates TLS on one custom domain when available (single shared domain per NFR-9) and forwards to the Fastify app container on `:3000`. Until a domain exists, testing uses SSH port-forwarding to a loopback-only listener (§14.2.2). **No CDN/edge layer in front** — per AD-1 (origin counts) and AD-2/AD-7 (no edge layer). The reverse proxy performs HTTP→HTTPS redirect and may provide coarse IP-level rate limiting as a backstop (application-level enforcement remains AD-7's sliding window).
- **Historical AWS path (preserved):** Route 53 + API Gateway HTTP API on one custom domain; CDK artifacts remain in `infra/`.
- Routes (single-segment `{slug}` can never collide with multi-segment `/v1/...` paths):
  - `GET/HEAD /{slug}` → served by the app container (historically `redirectFn`; explicit static routes `/healthz`, `/readyz` take precedence; those exact strings are rejected at slug-creation time as reserved).
  - `/v1/*` → served by the app container (historically `apiFn`; static prefixes always win over the path-parameter route).
  - `/*` otherwise → JSON 404 envelope (no frontend exists).
- Fastify schemas remain the single validation source; access-log format **excludes client IP** (§6.5); reverse-proxy logs must also exclude visitor IP or store it only transiently.

### 3.2 Redirect service

Flow for `GET /{slug}` (served by the app container; historically `redirectFn` in the AWS Lambda design of §1.2.2):

1. Validate slug shape (3–50, strict `[a-zA-Z0-9]` per AD-8); reject → JSON 404.
2. **Cache lookup (Tier-1 LRU, AD-1)**: keyed by slug → `{destination, state, expiresAt, cachedAt}`. Positive TTL 60s; **negative TTL 30s** (protects PostgreSQL from scanners without masking new creations beyond 30s). Tier-2 CDN does **not** exist in this design. **Correctness on hit (§13-c4):** a cached *active* entry whose `expiresAt` is non-null and `<= now()` is treated as **Expired immediately** (410) — the TTL never extends a link past its expiry.
3. On miss: indexed lookup via the private Docker network to `url8-pg` (`SELECT destination_url, state …`), budgeted ≤ 20ms p95.
4. State resolution:
   - **Active** → **302** (AD-1) with `Location: destination` and **`Cache-Control: no-store`** (AD-1: accurate origin counts).
   - **Expired** (`expires_at <= now()`) → `410 Gone`, JSON envelope (FR-4.2).
   - **Unknown / deleted** → `404`, JSON envelope (FR-4.3). Negative-cached 30s.
5. **Country resolution (AD-2 — Option B):** transient, request-time GeoIP lookup inside the handler — the source IP is taken from the request context, resolved to an ISO-3166-1 alpha-2 code **in memory**, and only the code leaves the resolver. The IP is **never persisted, never logged, never placed in queue messages**; lookup failure → `'ZZ'` unknown sentinel — keys are never NULL (§13-c3) (best-effort, does not affect the redirect). Runs on every request (cache hit included) — in-process lookup costs microseconds; no edge layer involved.
6. **Click emission (best-effort, non-blocking):** for active redirects, enqueue `{eventId (ULID), linkId, referrerHost (normalized host only), countryCode, day}` to **Redis Streams** (§14.5) — `eventId` is the dedup key that yields exactly-once aggregation effects despite at-least-once delivery (§13-c1). Failure here **never blocks or fails the redirect** (availability outranks analytics completeness); failures surface via metric + DLQ alarm. No IP/PII in the message (FR-4.4, NFR-4). **The AWS SQS mechanism remains in the historical CDK stack (§1.2.2) only; the active Oracle path uses Redis Streams approved under AD-17.**
7. Structured log line (no visitor IP — §6.5) + metrics/traces.

### 3.3 API service — middleware chain

```
requestId/trace → pino request log → body/schema validation →
authentication resolver (API key | JWT) →
rate limiter (AD-7: sliding window, subjects user:/apikey:, 100 req/min) →
email-verification gate (link creation only, FR-1.2) →
risk evaluation → CAPTCHA gate only if 'suspicious' (AD-3) →
route handler → consistent JSON response/error envelope
```

Modules:

- **auth**: register (email+password), login, refresh (rotating), verify-email (double opt-in, AD-14), logout/revoke, `DELETE /v1/me`, API-key CRUD (plaintext returned once), Google/GitHub OAuth (AD-14: adapters shipped exclusively).
- **links**: create (§3.4), list (cursor, `pageSize≤100`), get, patch (`destinationUrl` only — AD-6), delete.
- **analytics**: read-only aggregates (§4.3) — country breakdown sourced from AD-2's resolver output.
- **qr**: on-demand PNG/SVG of the short URL (ownership enforced).
- **health**: `/healthz` (liveness, no dependencies), `/readyz` (`SELECT 1` over the private Docker network to `url8-pg` + queue connection check).

Ownership checks (FR-3.2): every link-scoped query carries `AND user_id = $principal` — authorization lives in the SQL predicate, not post-hoc filtering.

### 3.4 Create-flow (final — all branches resolved)

```
POST /v1/links
 1. Rate limit (subject = user or api key, 100 req/min, AD-7)          [FR-8]
 2. Require authentication: no credentials → 401 UNAUTHENTICATED
    (anonymous creation not permitted — AD-4, Q10 Branch 1)
 3. Email-verification gate: unverified → 403 EMAIL_NOT_VERIFIED       [FR-1.2]
 4. Risk evaluation → CAPTCHA only when mode triggers:
    mode = 'suspicious' (AD-3) — challenge risk-triggered requests only.
    Risk inputs (config-tunable): account age below threshold, prior
    rate-limit/CAPTCHA failures, recent creation velocity, API-key age.
    Verification via pluggable CaptchaProvider (vendor TBD §10.8).
    Failure → 403 CAPTCHA_REQUIRED / CAPTCHA_INVALID                   [FR-2.7]
 5. Validate destination URL: http/https scheme only, ≤2048 chars,
    parseable, no javascript:/data: URIs                               [§6.4]
 6. Slug:
      absent  → generate 7-char base62, INSERT with retry-on-conflict  [D-5]
      present → strict regex ^[a-zA-Z0-9]{3,50}$ (AD-8), then
                INSERT INTO slug_reservations — on conflict:
                409 CONFLICT {error.suggestions:[3 availability-checked]
                                                              entries} [FR-2.4, AD-8]
 7. Idempotency wrapper (§3.5)                                          [FR-2.5]
 8. INSERT link (expires_at optional; permanent default)                [FR-2.6]
 9. Return {id, slug, shortUrl, destinationUrl, createdAt, expiresAt}
```

`links.user_id` is `NOT NULL` — anonymous creates cannot exist (AD-4).

### 3.5 Idempotency implementation (FR-2.5) — **single transaction (amended §13-c2)**

Scoped to `(principal, key)`; the **entire create executes in one ACID transaction**, so a crash at any point rolls back to a clean pre-request state:

1. **Pre-transaction (no writes):** authenticate, validate body/destination, rate-limit, CAPTCHA/verification gates (§3.4 steps 1–5).
2. **BEGIN** → `INSERT idempotency_records (principal, key, request_hash, state='completed', response_status, response_body, link_id, …) ON CONFLICT DO NOTHING` — a same-key conflict is detected here, **before** any write to `links`/`slug_reservations`.
3. **Conflict** → `ROLLBACK`, read the committed record:
   - `completed` + `request_hash` matches → replay stored response verbatim (AC-04).
   - `completed` + hash differs → `409 IDEMPOTENCY_PAYLOAD_MISMATCH`.
4. **Inserted** → same transaction continues: reserve slug (`slug_reservations` insert; the auto-slug retry loop re-issues the whole transaction on unique-violation, max 8 attempts — D-5) → `INSERT links` → serialize the response into the record → **COMMIT** → return the response.
5. **Crash recovery:** process kill / timeout / failover mid-create ⇒ the open transaction **rolls back** — no partial `links` row, no orphaned `slug_reservations` row, no persisted idempotency record. A retry with the same key re-executes cleanly and creates exactly one link (no stuck state, no duplicate).
6. **Concurrency:** two racing same-key requests — the loser's unique insert waits on the winner's transaction (PostgreSQL speculative insertion), conflicts at commit, rolls back, re-reads (≤1 retry / 100 ms) and replays the winner's committed response; a genuine in-flight edge returns `409 IDEMPOTENCY_IN_PROGRESS` + `Retry-After: 1`. The persisted `in_progress` state is **eliminated** (§13-c2); the `state` CHECK is retained for forward compatibility but is only ever written as `completed`.
7. TTL = 24 hours (architect-set); maintenance scheduler (§3.7) deletes expired records daily.

Postgres over Redis/Dynamo: durability across container recycling, transactional coupling with the link insert (**now a single transaction**), one fewer system (NFR-7).

### 3.6 Aggregator — **dedup-aware (amended §13-c1)**

> The aggregator runs as a containerized worker under Docker Compose (historically `aggregatorFn` in AWS Lambda). Queue transport is **Redis Streams** approved under AD-17; see §14.5 for persistence/redelivery safety rules.

- Queue batch (≤100) → **dedup gate:** `INSERT INTO click_event_dedup (event_id) ON CONFLICT DO NOTHING` per message; conflicting (already-counted) eventIds — duplicate deliveries, redriven batches, consumer retries — are **excluded from counting**. The redirect path still performs **zero** per-click DB writes; dedup lives entirely in this transaction.
- Survivors → `GROUP BY link_id, day, referrer_host` / `GROUP BY link_id, day, country_code` → bulk `INSERT … ON CONFLICT DO UPDATE SET count = count + EXCLUDED.count` + `UPDATE links SET click_count = click_count + $n` — **all in one transaction per batch → exactly-once counting effects despite at-least-once delivery** (FIFO not required).
- Also maintains the **all-time `referrer_totals` / `country_totals`** incrementally in the same transaction (AD-10: totals are permanent; buckets are 30-day working data).
- **Privacy:** dedup rows are bare ULIDs — no link/referrer/country/timestamp payload, therefore not click-event records; purged at **7 days** by the maintenance scheduler (well inside FR-5.2(c)'s 30-day ceiling); queue retention/redelivery horizon must be strictly shorter than 7 days (historical SQS design: 48h; see §14.5 safety rule). CI privacy gate covers the table's columns (§6.5).
- Orphaned linkIds (link deleted between enqueue and consume) → dedup row recorded, aggregates skipped + metric (deletion wins, FR-5.3).
- Partial batch failure → queue redelivers the batch; already-counted eventIds dedup on reprocessing; exhausted retries → **DLQ/dead-letter stream** (alarm §8.5).

### 3.7 Maintenance scheduler

> Runs as a containerized scheduled-job runner under Docker Compose (e.g. `supercronic` or a lightweight cron-in-container; historically `maintenanceFn` invoked by EventBridge in the AWS Lambda design of §1.2.2).

| Job | Schedule | Action |
|---|---|---|
| Idempotency GC | daily | Delete `idempotency_records` older than 24h |
| Dedup GC | daily | Delete `click_event_dedup` rows older than **7 days** (§13-c1) |
| Aggregate purge | daily | Delete **daily buckets older than 30 days** — all-time totals untouched (AD-10: conservative lifetime confirmed; no downsampling, AD-9) |
| Rate-limit hygiene | hourly | Delete expired window rows |
| Tombstone audit | daily | Log reservation volume; **never release `released_at`** (AD-5: slugs locked FCFS permanently in this phase; column retained solely as an extension point, always NULL) |

### 3.8 Email (FR-1.2, AD-14)

Standard **double opt-in**: verification link with single-use, expiring token (hashed at rest). **Oracle path:** owner's existing transactional email provider/SMTP relay reachable from the VM — **approved AD-17**. Local dev swaps to SMTP (MailHog) via env config. A5 confirmed. **AWS SES remains in the historical AWS CDK stack only (§1.2.2).**

### 3.9 External dependencies & implementation boundaries

| Dependency | Used by | Boundary |
|---|---|---|
| **Google OIDC / GitHub OAuth only** (AD-14) | auth module | Outbound HTTPS from the VM; no additional providers in MVP |
| Email/transactional mail | email module | Owner's existing provider/SMTP relay — **approved AD-17**; SMTP-swappable locally (MailHog); AWS SES is historical-only |
| **CaptchaProvider** (mode `suspicious`, AD-3) | create flow | Interface + trigger policy shipped; **concrete vendor open — §10.6**; provider injected by config, not compiled in |
| **GeoIP database** (transient resolver, AD-2) | redirect handler | In-process local file; **vendor/license open — §10.7**; returns country code only |
| PostgreSQL (`url8-pg`) | all DB-access paths | User-defined private Docker network only; no new Compose ports; legacy HostPort handled per §14.2 Option A/B; **Multi-AZ no longer applies (AD-16)** |
| Async queue | redirect (produce), aggregator (consume) | **Redis Streams** — **approved AD-17**; persistence, consumer groups, retry + dead-letter stream alarm |
| Secrets | all services | Protected outside Git — **approved AD-17**; owner-provided, injected at deploy, never committed; AWS Secrets Manager is historical-only |
| Module boundaries | `auth`, `links`, `analytics`, `qr`, `geo`, `platform` (db, config, observability) | Domain modules import nothing from Lambda/API Gateway → local run + unit tests without cloud emulation |

**Historical AWS boundary (superseded, §1.2.2):** the AWS design used SES, RDS + RDS Proxy, SQS via VPC endpoints, and Secrets Manager. Those dependencies are preserved in the CDK source and in §1.2.2 but are **not** the active Oracle path.

---

## 4. Data Model

### 4.1 Schema (DDL sketch — authoritative in migrations)

```sql
-- Identity ------------------------------------------------------------------------------
CREATE TABLE users (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email            CITEXT UNIQUE NOT NULL,
  password_hash    TEXT,                          -- NULL for social-only accounts
  email_verified_at TIMESTAMPTZ,                  -- double opt-in (AD-14)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE auth_identities (                    -- Google/GitHub only (AD-14)
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL,                 -- 'google' | 'github'
  provider_subject TEXT NOT NULL,
  UNIQUE (provider, provider_subject)
);

CREATE TABLE email_tokens (
  id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL, token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ
);

CREATE TABLE refresh_tokens (
  id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL, family_id UUID NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ
);

CREATE TABLE api_keys (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL UNIQUE,                -- clear, for O(1) lookup
  key_hash  TEXT NOT NULL,                        -- SHA-256 of full key
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ
);

-- Slugs & links --------------------------------------------------------------------------
CREATE TABLE slug_reservations (                  -- FCFS tombstones (FR-2.4)
  slug        TEXT PRIMARY KEY
              CHECK (slug ~ '^[a-zA-Z0-9]{3,50}$'),   -- strict charset (AD-8)
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ                         -- ALWAYS NULL: never released (AD-5);
                                                  -- retained only as future extension point
);

CREATE TABLE links (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL                  -- NOT NULL: anonymous create forbidden (AD-4)
                  REFERENCES users(id) ON DELETE CASCADE,
  slug            TEXT NOT NULL REFERENCES slug_reservations(slug),
  destination_url TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ,                    -- NULL = permanent (FR-2.6); set at creation
                                                  -- only — not mutable via PATCH (AD-6)
  click_count     BIGINT NOT NULL DEFAULT 0       -- un-capped all-time total (AD-9)
);
CREATE UNIQUE INDEX links_slug_uk ON links(slug);
CREATE INDEX links_user_idx ON links(user_id, created_at DESC);

CREATE TABLE idempotency_records (
  id UUID PRIMARY KEY,
  principal      TEXT NOT NULL,                   -- 'user:<uuid>' | 'apikey:<uuid>'
  key            TEXT NOT NULL,
  request_hash   TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN ('in_progress','completed')),
                 -- only 'completed' persisted since §13-c2 (single-txn create);
                 -- CHECK kept for forward compatibility
  response_status INT, response_body JSONB, link_id UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  UNIQUE (principal, key)
);

-- Rate limiting (AD-7: in-app sliding window, user:/apikey: subjects only) ----------------
CREATE TABLE rate_limit_windows (
  subject      TEXT NOT NULL,                     -- 'user:<uuid>' | 'apikey:<uuid>'
  window_start TIMESTAMPTZ NOT NULL,
  prev_count   INT NOT NULL DEFAULT 0,
  curr_count   INT NOT NULL DEFAULT 0,
  PRIMARY KEY (subject, window_start)
);

-- Analytics: aggregates only — no event rows, ever (AD-10) ---------------------------------
CREATE TABLE click_buckets_daily (                -- working data; PURGED at 30 days (AD-10)
  link_id UUID NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  day DATE NOT NULL, count BIGINT NOT NULL,
  PRIMARY KEY (link_id, day)
);
CREATE TABLE referrer_buckets_daily (
  link_id UUID NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  day DATE NOT NULL, referrer_host TEXT NOT NULL, count BIGINT NOT NULL,
  PRIMARY KEY (link_id, day, referrer_host)
);
CREATE TABLE country_buckets_daily (
  link_id UUID NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  country_code CHAR(2) NOT NULL DEFAULT 'ZZ'       -- 'ZZ' = unknown sentinel (§13-c3): keys never NULL,
              CHECK (country_code ~ '^[A-Z]{2}$'),-- else ISO-3166-1 alpha-2 from transient GeoIP
                                                  -- (AD-2); source IP never stored
  count BIGINT NOT NULL,
  PRIMARY KEY (link_id, day, country_code)
);
-- All-time rollups: permanent, un-capped BIGINT (AD-9/AD-10) -------------------------------
CREATE TABLE referrer_totals (link_id UUID REFERENCES links(id) ON DELETE CASCADE,
                              referrer_host TEXT NOT NULL, count BIGINT NOT NULL,
                              PRIMARY KEY (link_id, referrer_host));
CREATE TABLE country_totals  (link_id UUID REFERENCES links(id) ON DELETE CASCADE,
                              country_code CHAR(2) NOT NULL DEFAULT 'ZZ'
                                CHECK (country_code ~ '^[A-Z]{2}$'),   -- §13-c3 sentinel
                              count BIGINT NOT NULL,
                              PRIMARY KEY (link_id, country_code));

-- Click dedup: exactly-once aggregation effects (§13-c1) -----------------------------------
CREATE TABLE click_event_dedup (
  event_id   TEXT PRIMARY KEY,                     -- ULID emitted at click time; bare token only
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()    -- purged at 7 days (maintenance scheduler)
);
```

### 4.2 Lifecycle & deletion (FR-1.4, FR-5.3 — AD-13 confirmed)

- **Delete link:** row removed (hard delete; `slug_reservations` row **remains** — slug stays taken per FR-2.4/AC-FR-2.4 and AD-5); analytics cascade via FK; redirect thereafter → 404.
- **Delete account:** confirmed **hard-delete cascade** via transactional FK constraints (A7/AD-13): `users` delete cascades → identities, tokens, API keys, links, all analytics rows. Slug reservations are **not** released (AD-5: never released; FR-2.4 keeps deleted-link slugs reserved).
- **PATCH scope (AD-6):** `destinationUrl` only; `expiresAt` immutable after creation this phase.
- FR-3.1 "delete/disable" wording: `DELETE /v1/links/{id}` satisfies AC-FR-3.1 as written; a reversible disable state would be an additive `disabled_at` — still awaiting clarification (§10.4).

### 4.3 Analytics reads

`GET /v1/links/{id}/analytics[?from&to]`:

- `totalClicks` = `links.click_count` (un-capped BIGINT, AD-9).
- Referrer/country breakdowns = `referrer_totals` / `country_totals` (all-time default, kept indefinitely per AD-10), or summed from daily buckets when a range is given (max span **30 days** — enforced; buckets older than 30 days are purged).
- `countryBreakdown` values originate solely from AD-2's transient resolver output (code only); stored `'ZZ'` (unknown) is surfaced as `country: null` with label `unknown` (§13-c3).

### 4.4 Scale math (NFR-2)

| Dimension | Estimate |
|---|---|
| 1M links × (~250B row + slug index) | ≈ **300–500 MB** — trivial for the `url8-pg` instance; slug B-tree stays in memory |
| 10k users + API keys/refresh tokens | ≈ tens of MB |
| Analytics: buckets bounded by active links × days × distinct referrers/countries (≤250 countries); buckets purged at 30 days; totals = distinct (link, referrer) pairs | Steady-state low GB worst case; **no unbounded growth** |
| Counts | `BIGINT` un-capped — no downsampling/rollup caps (AD-9); overflow not a practical concern (max 9.2×10¹⁸) |
| Writes | Redirect path does **zero** per-click DB writes (batched async aggregation) |

---

## 5. API Design Notes

### 5.1 Conventions (FR-7)

- Base path `/v1`; JSON in/out; `Content-Type: application/json`.
- **Error envelope (FR-7.2), used by every error incl. 401/404/410/429:**

```json
{ "error": { "code": "NOT_FOUND", "message": "Human-readable summary.",
             "requestId": "01J…", "details": [ { "field": "slug", "issue": "taken" } ] } }
```

- Codes: `VALIDATION_ERROR, UNAUTHENTICATED, EMAIL_NOT_VERIFIED, FORBIDDEN, NOT_FOUND, GONE, CONFLICT, IDEMPOTENCY_IN_PROGRESS, IDEMPOTENCY_PAYLOAD_MISMATCH, RATE_LIMITED, CAPTCHA_REQUIRED, CAPTCHA_INVALID, INTERNAL`.
- Rate-limit headers on authenticated responses: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`; `429` adds `Retry-After` (FR-8.2).
- Auth: `Authorization: Bearer <jwt>` or `Bearer usk_…` (API key) — resolved by token shape, verified per D-11.
- Pagination: cursor-based (`cursor`, `pageSize≤100`) — single-resource ops elsewhere (FR-3.3).
- Active-link responses use **302 + `Location` + `Cache-Control: no-store`** (AD-1); `404`/`410` return JSON bodies (FR-7.3).

### 5.2 Endpoint map

| Method & path | Auth | Notes | Requirements · decisions |
|---|---|---|---|
| `POST /v1/users` | none | Register (email+password); creates unverified user | FR-1.1 |
| `GET /v1/auth/providers` | none | Optional — lists configured providers (Google, GitHub per AD-14) | FR-1.1, AD-14 |
| `POST /v1/auth/oauth/{provider}/callback` | none | Google/GitHub code+PKCE exchange — providers **exclusively** these two | FR-1.1, AD-14 |
| `POST /v1/auth/sessions` | none | Login → access + refresh tokens | FR-1.3 |
| `POST /v1/auth/tokens/refresh` | refresh token | Rotating refresh | FR-1.3 |
| `POST /v1/auth/emails/verify` | none | Single-use token, double opt-in | FR-1.2, AD-14 |
| `POST /v1/auth/api-keys` / `GET` / `DELETE /{id}` | JWT | Plaintext key returned once | FR-1.3 |
| `GET /v1/me` / `DELETE /v1/me` | JWT | Hard-delete cascade (AD-13) | FR-1.4 |
| `POST /v1/links` | API key or JWT — **required; anonymous → 401** (AD-4) | `Idempotency-Key` optional; body `{destinationUrl, slug?, expiresAt?, captchaToken?}`; CAPTCHA only when risk-evaluator says suspicious (AD-3); 409 + `suggestions[3]` on collision (AD-8); 403 `EMAIL_NOT_VERIFIED` if unverified | FR-2.1–2.7, AD-3/4/8 |
| `GET /v1/links` | API key or JWT | Cursor list of **own** links | FR-3.1 |
| `GET /v1/links/{id}` | owner | 403 for non-owner | FR-3.2 |
| `PATCH /v1/links/{id}` | owner | **`destinationUrl` only** — `expiresAt` not mutable this phase | FR-3.1, AD-6 |
| `DELETE /v1/links/{id}` | owner | Hard delete + analytics cascade; slug stays reserved | FR-3.1, FR-5.3, AD-5 |
| `GET /v1/links/{id}/analytics` | owner | totals + referrer + country (transient GeoIP, AD-2); optional ≤30d range | FR-5.1–5.2 |
| `GET /v1/links/{id}/qr?format=png\|svg` | owner | Payload = **short URL**; **no styling options** (AD-15); default `png` | FR-6.1–6.2, AD-15 |
| `GET /{slug}` | none (anonymous visitor) | **302** (AD-1) + `no-store`, 410, 404 — JSON bodies on errors | FR-4.1–4.4, AD-1 |
| `GET /healthz`, `GET /readyz` | none | Liveness / readiness | FR-10.2 |

### 5.3 Redirect status & caching — **RESOLVED (AD-1, 2026-10-12)**

**Decision: 302 branch.** `REDIRECT_STATUS = 302` (kept as config for operational flexibility; product default fixed at 302). Consequences now baked into the design:

- `Cache-Control: no-store` on redirect responses; browsers never cache → **every repeat visit reaches origin → FR-4.4 counts stay accurate** (the stated reason for the choice).
- **Tier-1 in-process LRU** (60s positive / 30s negative) ships — server-side only; every cache-miss path and all repeat traffic still emits clicks from origin, so origin counts remain the true counts.
- **Tier-2 CDN explicitly excluded** — no CDN/edge layer in front of the reverse proxy (reinforced by AD-2 and AD-7). Any future proposal to add one is a new human decision.
- The 301 alternative and CDN-invalidation design are retired (recorded in §11 for audit).

### 5.4 QR (FR-6 — AD-15 resolved)

`qrcode.toBuffer(shortUrl, {type:'png'})` / `qrcode.toString(shortUrl, {type:'svg'})`; `?format=` query parameter selects output; ownership check identical to analytics. **Payload = short URL confirmed; styling/options out of scope.**

---

## 6. Security

### 6.1 Authentication & authorization (FR-1.3, NFR-5)

- **JWT:** signed with owner-provided key (never committed), 15-min expiry, `sub`/`iat`/`jti`; refresh tokens hashed, rotating with reuse-detection (reuse → revoke family).
- **API keys:** `usk_<8-char prefix>_<32-byte secret>`; store prefix + SHA-256(full key); constant-time verify; plaintext shown once; revocable.
- **Email verification gate** enforced inside the links service (not just middleware) — no code path creates links for unverified users (FR-1.2).
- **Ownership:** SQL predicates (`user_id = $principal`) on every link-scoped read/update/delete/QR/analytics query (FR-3.2).
- **Anonymous creation forbidden** on `POST /v1/links` (AD-4) → unauthenticated attempt returns `401 UNAUTHENTICATED`; `links.user_id NOT NULL` enforces it at the data layer too.

### 6.2 Secrets management

**Oracle path:** owner-provided secrets injected at deploy via `.env`/Docker Secrets/CI variables: DB credentials (app and migration roles), JWT signing key, OAuth client secrets, CAPTCHA secret, backup-upload credentials, TLS certificate/key (if not Let's Encrypt). Never committed; file permissions `0600`; rotation supported (JWT key IDs for overlap). Local dev reads a gitignored `.env` through the same config interface.

**Historical AWS path (superseded, §1.2.2):** Secrets Manager for DB credentials (RDS Proxy consumed the same secret), JWT signing key, OAuth client secrets, CAPTCHA secret; fetched at cold start, cached per Lambda container.

### 6.3 Network

**Oracle path:** `url8-pg` attached to a user-defined DB-private Docker network (`urlshortener_db`); Compose must not publish any new DB port. The existing legacy Docker HostPort binding (`0.0.0.0`/`[::]`:5432) remains until owner approves remediation via §14.2 Option A (DOCKER-USER + OCI NSG filtering) or Option B (container recreation). App/aggregator/scheduler/queue on a separate egress-capable network (`urlshortener_app`); reverse proxy (Caddy when a domain exists) on an edge network exposing `:443` only. See §14.2 for the detailed plan. In-network TLS to Postgres is optional but recommended (`sslmode=prefer` or `verify-ca` if certificates are provisioned). Outbound HTTPS for OAuth/email/CAPTCHA through the host public interface.

**Historical AWS path (superseded, §1.2.2):** RDS + RDS Proxy in private subnets (Multi-AZ confirmed per A1/AD-11); Lambdas in private subnets (VPC); TLS required to Postgres (`sslmode=verify-full`); VPC endpoints for SQS/Secrets Manager/CloudWatch/X-Ray; NAT for SES/OAuth/CAPTCHA egress. No public DB endpoint.

### 6.4 Input & output protection

- Destination URL: scheme allowlist `http/https` only (blocks `javascript:`/`data:` redirect XSS), parse-validated, length-capped (2048).
- Slug: strict `^[a-zA-Z0-9]{3,50}$` shared by API validator, DB CHECK, and route guard (AD-8); reserved words (`healthz`, `readyz`) rejected.
- All SQL parameterized; Fastify JSON Schema rejects unknown/oversized bodies.
- Open-redirect abuse is inherent to the product; designated mitigations are rate limiting + risk-triggered CAPTCHA (FR-2.7, AD-3/AD-7) — no destination allowlist invented.
- Minimal stack traces in responses (full error correlated by `requestId` in logs).

### 6.5 Privacy (FR-5.2, NFR-4) — enforced in code paths

- **No visitor IP is ever stored:** application logs exclude IP; reverse-proxy access logs must omit or transiently hold `clientIp`; async click messages carry no IP; no analytics column exists for IP (CI schema-review gate fails on any `ip`/`user_agent`-like column). The AWS API Gateway/SQS specifics of the historical design (§1.2.2) are superseded by these Oracle-path rules.
- **GeoIP (AD-2):** the source IP exists only as a transient in-memory argument to the resolver; only the ISO country code is emitted (queue message, aggregates, logs). The resolver never writes to any store; privacy-regression test asserts this (§7).
- Referrer stored as **host only** (query strings stripped — they often carry tokens/PII).
- Aggregate-only persistence: no raw event table exists (D-8/AD-10); daily buckets purged at 30 days; all-time totals are counts, kept indefinitely (AD-10).

### 6.6 Abuse controls (FR-8, FR-2.7 — AD-3/AD-7 resolved)

- **Sliding-window limiter:** 100 req/min per `user:`/`api:key` subject, applied pre-handler on `/v1/*`; `429` + `Retry-After`. Uniform baseline (A4 confirmed; Q3: no tiers in MVP; subject-keyed policy rows retain a future extension point).
- **Anonymous/redirect traffic is not application-rate-limited** (AM-4 closed by AD-7's scope: in-app `user:`/`apikey:` subjects only; CloudFront/WAF explicitly rejected under the historical AWS design and remains rejected on Oracle). Reverse-proxy-level throttling remains the coarse backstop.
- **CAPTCHA:** `CaptchaProvider` interface, **mode `suspicious`** (AD-3) — only risk-triggered creations are challenged (risk inputs in §3.4 step 4). Concrete vendor open (§10.6).

---

## 7. Testing Strategy

| Layer | Scope | Tooling |
|---|---|---|
| Unit | Slug entropy + strict charset (AD-8), suggestion generation (3 availability-checked), idempotency state machine, sliding-window math, error-envelope shape, URL validator, referrer host normalization, risk-evaluator thresholds (AD-3) | Vitest, 90% line-coverage gate on `auth`/`links` |
| Integration | Migrations on real Postgres; create→collide→409+3-suggestions; idempotent replay incl. concurrent race; redirect states (302/`no-store`, 410, 404); anonymous `POST /links` → 401 (AD-4); delete cascades | Testcontainers (or docker-compose PG) |
| Crash & dedup (§13 review) | Fault injection: kill mid-create → retry same `Idempotency-Key` → exactly one link, no stuck record (§3.5/c2); duplicate queue `eventId` replay → counts increment once (§3.6/c1); expired link on cache hit → 410 immediately (§3.2/c4); `'ZZ'` country never NULL in keys (§4.1/c3) | Testcontainers + consumer-replay harness |
| Contract | Fastify JSON Schemas ↔ generated OpenAPI; consumer response validation | `@fastify/swagger` + snapshots |
| Privacy regression | Static schema check (no IP/PII columns), log-shape assertion (no `clientIp`), async click-message allowlist, **GeoIP resolver: assert IP not persisted anywhere** (AD-2) | CI lint rule |
| CAPTCHA behavior | `suspicious` mode: clean requests pass without challenge; risk-flagged requests require valid token (AD-3) | Unit + integration |
| Load/perf | Redirect p95 vs §9.1 budgets on seeded 1M-link DB; burst to concurrency caps; cache hit-rate (informs §10.1) | k6 in staging |
| E2E (staging) | AC-01…AC-13 happy paths incl. observability smoke (health, log line, metric, trace) | GitHub Actions nightly |
| Resilience | PostgreSQL restart/network blip → 5xx + `/readyz` red; DLQ path; aggregator retry | Staging fault injection |

QA (Pam) owns formal QA execution; this section defines engineering verification and CI gates.

---

## 8. Observability (FR-10, NFR-8)

### 8.1 Tooling decision (FR-10.6)

**pino + OpenTelemetry everywhere; self-hosted backend = Prometheus/Grafana/Loki/Jaeger on the Oracle VM; Alertmanager for health/log/resource/disk/backup alerts; dockerized Jaeger + stdout locally.** One instrumentation codebase for cloud and local; no SaaS dependency; OTel mandated by FR-10.4. **Approved AD-17. CloudWatch + X-Ray + SNS are historical AWS-path backends only (§1.2.2).**

### 8.2 Structured logging (FR-10.1)

One JSON line per request: `timestamp, level, requestId, traceId, route, method, status, durationMs, principal (type+id, no tokens), outcome (redirect: active|expired|unknown, cache: hit|miss, country: resolved|none), errorCode?`. **No visitor IP, no destination query strings, no credentials** (pino redact list on `authorization`, `set-cookie`).

### 8.3 Metrics (FR-10.3)

`http.server.requests` (count + duration histogram + errors by route/status); `redirect.requests{result,cache}` → redirect volume; `links.created{kind}`; `auth.failures{reason}` (incl. `anon_create_rejected` — AD-4); `ratelimit.rejected{subject_type}`; `captcha.challenged` / `captcha.failed` (AD-3); `geo.resolved` / `geo.miss` (AD-2); `click.messages.enqueued/failed`; `queue.depth`; `dlq.depth`; `idempotency.replays`; PostgreSQL metrics via the self-hosted observability stack. **AWS-specific metrics (SQS depth, RDS/RDS-Proxy via CloudWatch) are historical-only (§1.2.2).**

### 8.4 Tracing (FR-10.4)

OTel auto-instrumentation (HTTP, `pg`, queue client, GeoIP resolver span) → OTLP → self-hosted backend (e.g. Grafana Tempo/Jaeger) on the Oracle VM; OTLP → Jaeger locally (AC-FR-10.4). Sampling: 10% prod (100% on error), 100% local. Span links connect redirect → click message → aggregation. **AWS X-Ray/ADOT are historical-only (§1.2.2).**

### 8.5 Health & alerting (FR-10.2, FR-10.5)

- `/healthz` liveness (no deps); `/readyz` readiness (DB via private Docker network) — unauthenticated, minimal detail. See §14.3 for the multi-layer probe strategy (external `pg_isready` substitute for the missing `url8-pg` container healthcheck).
- Alarms → owner notification channel (email/Slack) via **Prometheus Alertmanager** (approved AD-17): (1) 5xx rate >1%/5min; (2) redirect p95 over budget 10min; (3) `/readyz` failure ×2; (4) **dead-letter stream depth > 0**; (5) aggregator lag > 5min; (6) PostgreSQL connections > 80% of configured pool; (7) maintenance job failure; (8) disk/log-volume high; (9) backup failure; (10) VM resource pressure (CPU/memory/disk). **AWS SNS/CloudWatch Alarms are historical-only (§1.2.2).**

---

## 9. Scalability & Performance

### 9.1 Latency budgets (NFR-1 — Architect-set targets)

| Path | p50 | p95 | p99 |
|---|---|---|---|
| Redirect, warm, cache hit | ≤ 30 ms | ≤ 60 ms | ≤ 120 ms |
| Redirect, warm, cache miss (DB lookup) | ≤ 50 ms | ≤ 120 ms | ≤ 250 ms |
| Authenticated API mutations | ≤ 150 ms | ≤ 500 ms | ≤ 1,000 ms |
| Analytics read / QR generation | ≤ 200 ms | ≤ 600 ms | ≤ 1,200 ms |

Measured at the Fastify handler boundary inside the app container (reverse proxy adds ~5–15ms; in-process GeoIP adds <1ms). DB lookup sub-budget: ≤ 20ms p95. **No cold-start row — containers run continuously.** Latency targets are retained as architect-set design goals; the single-VM deployment with 2 CPUs and shared resources may not meet them under high load (load tests required). **Availability target: 99.9% monthly is withdrawn by AD-16** (single-VM personal MVP; HA/Multi-AZ explicitly not required). Levers if budgets miss: Tier-1 cache tuning, app container resource bump, queue batch sizing, reverse-proxy tuning. **Excluded by decision:** Tier-2 CDN (AD-1), edge/CloudFront layers (AD-2, AD-7).

**Historical AWS note (superseded, §1.2.2):** budgets were previously stated at the Lambda handler boundary with API Gateway overhead; availability was tied to Multi-AZ RDS and 99.9%. AD-16 withdrew those assumptions while keeping the latency targets as goals.

### 9.2 Scale posture (NFR-2)

1M links ≈ 300–500MB (§4.4) — storage is a non-issue; pressure points are redirect QPS and connection churn, addressed by Tier-1 cache (hot slugs skip DB), tiny per-container `pg.Pool` (`max=2`), batched async aggregation (no per-click writes), and container resource limits. The single-VM deployment with 2 CPUs and ~11 GiB RAM is a hard ceiling; horizontal scaling is out of scope for AD-16 and would require a future platform decision. Scale targets (1M links, 10k users) remain design goals, not guaranteed on the MVP VM.

### 9.3 Availability (NFR-3)

- **AD-16 explicitly withdraws HA, Multi-AZ, and the 99.9% target.** The MVP is a single Oracle Cloud VM reusing the existing `url8-pg` container; any VM outage, host maintenance, or Docker failure can take the service down.
- Async queue decouples redirect availability from analytics; DLQ preserves failures; health endpoints + alarms; forward-only migrations with staging soak and human approval gate; rollback = redeploy previous image tag.

**Historical AWS note (superseded, §1.2.2):** Multi-AZ RDS was confirmed under A1/AD-11 and supported a 99.9% target. AD-16 superseded that platform.

### 9.4 Connection-exhaustion analysis (containers × PostgreSQL)

Risk: app containers could open many concurrent connections to the single `url8-pg` instance; failover or restart can cause connection storms.

Mitigations (Oracle path):

1. **No RDS Proxy** in the Oracle path; `url8-pg` is reached directly over the private Docker network. Per-container pool sizing is therefore critical.
2. Small per-container pool (`pg.Pool` max = **2**, `statement_timeout` 5s, `idle_timeout` 10s). With app + aggregator + scheduler + backup sidecar, worst-case open DB connections stay well under `url8-pg`'s `max_connections`; alarm at 80% (§8.5).
3. **Container concurrency is bounded by VM resources (2 CPUs, ~11 GiB)** rather than by reserved concurrency; the reverse proxy provides coarse throttling.
4. Tier-1 cache removes the majority of DB round-trips.
5. Fail-fast: pool acquire timeout → `503` JSON + alarm, never pile-up; container restart on crash via `restart: unless-stopped`.

Local dev connects directly (same pool abstraction). The historical AWS design (§1.2.2) used RDS Proxy and reserved concurrency; those mitigations are preserved in the CDK source but do not apply to the Oracle path.

### 9.5 Reverse proxy & scaling

The reverse proxy terminates TLS and forwards to the app container; scaling is bounded by the single VM's 2 CPUs and ~11 GiB RAM. Reverse-proxy-level throttling provides a coarse backstop for runaway principals. **Edge rate-limiting (CloudFront/WAF) explicitly rejected under the historical AWS design (AD-7)** and remains rejected on Oracle. No CDN in front (AD-1/AD-2). Horizontal scaling is out of scope for AD-16.

### 9.6 CI/CD & deployment

GitHub Actions: `lint → typecheck → unit/integration → contract → build → Docker image build → compose config validation → deploy to staging VM/project → migrate + smoke (AC set) → **manual approval** → deploy to prod VM/project`. Migrations run as an idempotent pipeline step before traffic shift. Rollback = redeploy previous image tag (migrations forward-only). No approval gate bypassed. Owner supplies SSH/self-hosted runner credentials, container registry, and VM targets.

**Historical AWS path (preserved, not active):** URL-20 tracks the AWS CI/CD pipeline (`cdk synth`, Lambda/API Gateway deploy). It remains **To Do / Agent Owner Developer** and is not treated as completed by AD-16.

---

## 10. Open Architectural Questions

Technical items not settled by AD-1…AD-17; none block starting implementation except §10.6 for a live CAPTCHA path and missing owner-supplied infrastructure in §11.2:

1. **Cache-tier sufficiency** — does in-process LRU hit-rate meet DB-load/latency targets at realistic QPS on the 2-CPU VM? Gate: k6 load test. (Tier-2 CDN excluded by AD-1; a shared *application-layer* cache such as Redis/Valkey would still preserve origin-count accuracy and would be a separate, new decision if needed.)
2. **Container resource tuning** — memory/CPU limits for the app container that balance latency against the shared VM resources; load-test on the actual ARM64 VM.
3. **Per-container `pg.Pool` sizing** — final `max_connections` vs container concurrency needs staging measurement against the running `url8-pg` instance.
4. **FR-3.1 "delete/disable" wording** — single `DELETE` endpoint satisfies AC-FR-3.1 as written; confirm whether a reversible "disable" state is intended (additive `disabled_at`). Minor; routed to Michael.
5. **QR response caching** — ETag caching if the QR endpoint sees notable traffic (correctness unaffected).
6. **CAPTCHA provider vendor** (Q5's vendor half — mode resolved by AD-3, vendor not named): the `CaptchaProvider` interface and `suspicious` trigger ship regardless, but a concrete adapter (e.g., Turnstile / hCaptcha / reCAPTCHA) must be selected before FR-2.7 exercises a live challenge. **Needs human/vendor decision — see §11 still-open list.**
7. **GeoIP database vendor/license** for AD-2 Option B (e.g., MaxMind GeoLite2 requires an account/EULA; alternatives exist). Affects local file provisioning on the VM and local-dev file provisioning only; Lambda layer no longer applies; schema and flow are unaffected.

**Resolved by AD-17 (no longer open):** click-event transport → Redis Streams; backup target/retention → daily encrypted OCI Object Storage with 7-day retention; reverse proxy → Caddy when domain exists; email → existing provider; observability → Prometheus/Grafana/Loki/Jaeger/Alertmanager; CI/CD → GitHub Actions with manual approval gate. Implementation specifics remain in §11.2.

**Historical AWS-only questions (superseded, §1.2.2):** Lambda memory/provisioned-concurrency tuning and RDS Proxy pool sizing were open under the AWS design; they are no longer applicable to the Oracle path.

---

## 11. Unresolved Architectural Decisions — RESOLUTION LOG

> This section was created as *Unresolved Architectural Decisions*. **All 15 items were resolved by the human decision-maker (Michael) on 2026-10-12.** The original blocking item, options, and the recorded resolution are kept below for audit. Nothing here was decided by the Architect. Residual items that still need input are listed in §11.2 (and §10).

### 11.1 Resolutions (all complete)

| # | Decision (originally blocked by) | Options that were on the table | **Resolution (human, 2026-10-12)** | Requirements |
|---|---|---|---|---|
| **AD-1** | Redirect caching / **Q8** | 302 branch vs 301 branch (+CDN) | **302 branch.** Unconditional Tier-1 in-process LRU; `Cache-Control: no-store`; **Tier-2 CDN not included/configured** — accurate origin counts required. | FR-4.1/4.4, AC-05, NFR-1 |
| **AD-2** | Country ingestion / **Q4** | A: CloudFront viewer-country header · B: transient request-time GeoIP | **Option B.** In-process GeoIP module inside `redirectFn`; in-memory only, never persisted; **no CDN/CloudFront edge in front of API Gateway.** | FR-5.1/5.2, AC-09, NFR-4 |
| **AD-3** | CAPTCHA wiring / **Q5** | mode `always` vs `suspicious`; provider pluggable | **Pluggable `CaptchaProvider`, mode = `suspicious`** — challenge risk-triggered creates only, not every create. *(Provider vendor still open — §11.2, §10.6.)* | FR-2.7, AC-FR-2.7, AC-11 |
| **AD-4** | Anonymous create / **Q10**, A6 | Branch 1: auth required · Branch 2: anonymous allowed | **Branch 1.** `POST /v1/links` requires authentication; anonymous → **401**; `links.user_id NOT NULL`; A6 becomes moot. | FR-2.7, FR-1.2 |
| **AD-5** | Slug reservation release / **Q1** | never release vs grace-period reclaim | **MVP: never release** tombstones; slugs locked first-come-first-served permanently; `released_at` retained (always NULL) only as an extension point. | FR-2.4, AC-03 |
| **AD-6** | PATCH field set / **Q2** | destinationUrl only vs also expiresAt | **`destinationUrl` only** — `expiresAt` not mutable this phase. | FR-2.6, FR-3.1 |
| **AD-7** | Rate-limit scope / **Q3, A4, AM-4** | in-app (Postgres) vs CloudFront/WAF; tiers vs uniform | **In-app Postgres sliding window** for `user:`/`apikey:` subjects at the uniform 100 req/min baseline (A4 confirmed; Q3 closed for MVP — no tiers; subject-policy extension retained). **No CloudFront/WAF rate rules**; anonymous redirect traffic not app-limited (AM-4 closed). | FR-8.1–8.3, AC-11 |
| **AD-8** | Slug charset & suggestions / **AM-1, AM-5** | strict `[a-zA-Z0-9]` vs allow `-`; suggestion count | **Strict `[a-zA-Z0-9]`** enforced in app validator **and** DB CHECK (no hyphens); collision → **409 with 3 availability-checked alternatives** in the body. | FR-2.3/2.4, AC-03 |
| **AD-9** | Click-count precision / **Q9** | caps/downsampling vs plain BIGINT | **Un-capped `BIGINT` totals** alongside daily buckets; **no downsampling or maintenance caps** for target volume. | FR-5.1/5.2, AC-09 |
| **AD-10** | Aggregate lifetime / **AM-3, A3** | conservative vs alternative readings | **Conservative reading confirmed.** Raw events never stored; daily analytic buckets **purged after 30 days**; all-time totals kept **indefinitely**; A3 (per-link aggregates, not per-click logs) confirmed. | FR-5.1/5.2, NFR-4, A3 |
| **AD-11** | HA / performance claims / **A1** | confirm vs qualify | **A1 confirmed 2026-10-12** — adequately provisioned, **Multi-AZ** RDS instance assumed. §9.1 latency budgets and **99.9% availability target stood on that basis**. **SUPERSEDED 2026-11-02 by AD-16** (Oracle single-VM platform; HA/Multi-AZ/99.9% explicitly not required) — record preserved. | FR-9.2, NFR-2/3/7 |
| **AD-12** | Platform confirmation / **A2** | AWS Lambda + HTTP API vs alternatives | **Confirmed 2026-10-12: AWS Lambda + API Gateway HTTP API inside the VPC**; dual-entrypoint portability pattern maintained. **SUPERSEDED 2026-11-02 by AD-16** (Docker Compose on Oracle Cloud VM) — record preserved; CDK source remains in repository. | FR-9.1/9.3, A2 |
| **AD-13** | Account deletion / **A7** | hard-delete cascade vs soft delete | **Confirmed: hard-delete cascade** with standard transactional FK constraints. | FR-1.4, FR-5.3, AC-13 |
| **AD-14** | OAuth providers & email / **Q6, A5** | provider set; verification semantics | **Ship exclusively Google + GitHub adapters**; **standard double opt-in** email verification enforced. | FR-1.1/1.2, AC-01, A5 |
| **AD-15** | QR payload & styling / **Q7** | payload confirm; styling scope | **Payload = short URL**; **`?format=` query parameter** (png\|svg); **styling options out of scope.** | FR-6.1/6.2, AC-10 |
| **AD-16** | **Deployment-platform migration** / owner request (supersedes A1/AD-11, A2/AD-12) | Oracle Cloud VM vs retained AWS serverless | **Human-approved 2026-11-02 (Michael):** personal MVP runs on the confirmed **Oracle Cloud Ubuntu ARM64 VM** via **Docker Compose**, reusing the existing **PostgreSQL 16 container `url8-pg`** and its persistent Docker volume. Conditions: DB **private-network-only**, restart policies, health checks, persistent storage, automated backups, no committed secrets, no new AWS resources, no deletion of AWS resources/databases, **HA/Multi-AZ/99.9% explicitly NOT required**. AWS RDS `database-1` and all AWS resources remain untouched; data/dependency review and any migration are separate, unmade decisions. | FR-9.1–9.3, AC-FR-9.1/9.2, NFR-3, NFR-7, AC-NFR-3 |
| **AD-17** | **Oracle operational tooling choices** / owner request (builds on AD-16) | Redis Streams vs alternatives; OCI Object Storage vs other backup target; Caddy vs nginx/Traefik; self-hosted observability stack specifics; manual CI/CD gate details | **Human-approved 2026-11-02 (Michael):** **Redis Streams** for async click aggregation (preserve dedup/retry/DLQ/zero per-click writes); **daily encrypted backups** of `urlshortener`, `url8_acceptance`, and PostgreSQL globals to **Oracle Cloud Object Storage** with **7-day retention**; **verified restore test required before production** (ongoing cadence/target/owner open); **protected secrets outside Git**; **Caddy** for HTTPS when a domain exists, otherwise SSH port-forward loopback test path; **owner's existing email provider**; basic health/log/resource/disk/backup alerts via **Prometheus/Grafana/Loki/Jaeger/Alertmanager**; **GitHub Actions with manual deployment approval gate**. Missing specifics remain open (§11.2). | FR-4.4, FR-5, FR-9.1–9.3, FR-10, NFR-3/7/8 |

### 11.2 Still open (not covered by the AD-17 resolutions)

| Item | Nature | Impact | Owner |
|---|---|---|---|
| CAPTCHA **provider vendor** (Q5's vendor half) | Dependency choice — interface/mode resolved by AD-3, vendor never named | FR-2.7 cannot exercise a live challenge until an adapter target is chosen (§10.8) | Human (Michael) |
| FR-3.1 **"delete/disable" wording** (§10.4) | Minor product clarification | Endpoint already satisfies AC-FR-3.1; reversible disable would be additive | Human (Michael) |
| GeoIP **database vendor/license** (§10.9) | Dependency choice for AD-2 Option B | Local file provisioning only on Oracle (Lambda layer no longer applicable) | Human/Developer |
| **AM-2** (PRD footer says "draft" while header says "Approved") | Documentation inconsistency, reported not resolved | None on architecture; PRD is immutable to this artifact | Human (Jim flagged originally) |
| **requirements.md §8 markers** | Its `[PENDING …]` flags predate the 2026-10-12 resolutions | Regenerated by Jim to reflect AD-1…AD-17 | Jim / Michael |
| **AD-17 follow-on #1 — OCI backup specifics** | Operational details approved in principle | OCI Object Storage bucket/region/credentials, encryption key management, exact backup time-of-day, numeric RPO/RTO targets, restore-test cadence/target/owner, and credential separation (least-privilege per-DB dump role for `pg_dump` plus a separately controlled globals-export role for `pg_dumpall --globals-only`) must be specified before implementation | Human/ops |
| **AD-17 follow-on #2 — Redis Streams retention** | Operational detail approved in principle | Exact stream retention (recommended ≤48h, strictly <7 days), persistence config (`appendonly`, AOF rewrite), memory limit, and consumer-group retry/DLQ semantics must be configured before implementation | Developer/Architect |
| **AD-17 follow-on #3 — Caddy/domain/certificate** | Operational detail approved in principle | Domain name, DNS A/AAAA records, Let's Encrypt vs owner cert, Caddyfile config, and OAuth/email callback domain readiness must be supplied before public HTTPS deploy | Human/ops |
| **AD-17 follow-on #4 — CI/CD runner & registry credentials** | Missing owner-supplied infrastructure | GitHub Actions self-hosted runner or SSH deploy key, container registry credentials, staging/prod VM targets, and notification channels must be supplied before pipeline wiring | Human/ops |
| **AD-17 follow-on #5 — `url8-pg` restart policy / network disconnect** | Operational change requiring separate approval | Applying `docker update --restart` to the running DB container or disconnecting it from default `bridge` is a change to the live DB container; owner must explicitly approve each step after reviewing the plan | Human (Michael) |

---

## 12. Traceability to Requirement IDs

> Status markers below reflect the 2026-10-12 resolutions: **[RESOLVED AD-x]** = human decision incorporated; no requirement remains architecturally blocked. Requirements.md's own markers are stale-but-untouched (see header note).

| Requirement | Design sections / decisions · status |
|---|---|
| FR-1.1 (register, social) | §3.3 auth, §3.9, D-11 · **[RESOLVED AD-14: Google+GitHub only]** |
| FR-1.2 (email verification gate) | §3.4 step 3, §3.8, §6.1 · **[RESOLVED AD-14: double opt-in confirmed]** |
| FR-1.3 (API keys + JWT) | §3.3 chain, §5.1, §6.1, D-11 · final |
| FR-1.4 (account deletion) | §4.2, §6.1 · **[RESOLVED AD-13: hard-delete cascade]** |
| FR-2.1–2.2 (create, auto slug) | §3.4, D-5 · final |
| FR-2.3 (custom slug) | §3.4 step 6, D-6 · **[RESOLVED AD-8: strict `[a-zA-Z0-9]`]** |
| FR-2.4 (collision + suggestions) | §3.4 step 6, §4.1, D-6 · **[RESOLVED AD-8: 3 suggestions; AD-5: no reclamation]** |
| FR-2.5 (idempotency) | §3.5, D-7 · **[amended §13-c2: single-transaction create, crash-safe]** |
| FR-2.6 (expiration) | §3.4 step 8, §5.2 PATCH, §4.2 · **[RESOLVED AD-6: creation-time only]** |
| FR-2.7 (rate limit + CAPTCHA) | §3.4 steps 1/4, §6.6 · **[RESOLVED AD-3: suspicious-mode; AD-4: auth required; AD-7: in-app limiter]** · vendor open §10.6 |
| FR-3.1–3.3 (link management) | §3.3, §5.2, §4.2 · **[RESOLVED AD-6]** · disable-wording §10.4 |
| FR-4.1 (redirect status) | §3.2 step 4, §5.3 · **[RESOLVED AD-1: 302 + no-store, no CDN]** |
| FR-4.2 / FR-4.3 (410 / 404) | §3.2 steps 2/4 (expired evaluated in-memory on cache hit — §13-c4), §5.1 codes · final |
| FR-4.4 (click count, no PII) | §3.2 steps 5–7, §3.6 (eventId dedup — §13-c1), §6.5 · **[RESOLVED AD-1 (origin-accurate), AD-2 (no IP)]** |
| FR-5.1 (analytics reads) | §4.3, D-14 ('ZZ' sentinel — §13-c3) · **[RESOLVED AD-2: transient GeoIP; AD-9: un-capped; A3 confirmed AD-10]** |
| FR-5.2 (privacy) | §4.1 buckets + `click_event_dedup` (bare ULIDs, 7-day purge — §13-c1), §6.5 · **[RESOLVED AD-10: no raw events, 30d buckets, permanent totals; AD-2]** |
| FR-5.3 (delete analytics) | §4.2 cascades, §3.6 · final |
| FR-6.1–6.2 (QR PNG/SVG) | §3.3 qr, §5.4, D-12 · **[RESOLVED AD-15: short-URL payload, format param, no styling]** |
| FR-7.1–7.3 (REST, JSON errors) | §5.1–5.2, D-2 · final |
| FR-8.1–8.3 (rate limiting) | §6.6, D-10 · **[RESOLVED AD-7: in-app Postgres sliding window, uniform baseline, user:/apikey: only]** |
| FR-9.1 (containerized deploy) | §1.2, §1.3, D-1, D-15, §14.9 · **[AD-16 + AD-17: Docker Compose on Oracle Cloud VM; GitHub Actions + manual gate; HA/99.9% not required]** |
| FR-9.2 (PostgreSQL data store) | §1.2, §4, §9.4, D-4, §14.2, §14.6 · **[AD-16 + AD-17: existing `url8-pg` container + persistent volume; OCI Object Storage daily backups with 7-day retention; private Docker network; A1/AD-11 superseded]** |
| FR-9.3 (local dev) | §1.2, §1.3, D-2, D-3, §7 · **[RETAINED under AD-16: same Fastify app runs locally and in the container]** |
| FR-10.1 (JSON logs) | §8.2 · final (Loki stack approved AD-17) |
| FR-10.2 (health) | §3.3 health, §8.5, §14.2, §14.3 · final |
| FR-10.3 (metrics) | §8.3 · final (Prometheus approved AD-17) |
| FR-10.4 (OTel tracing) | §8.4 · final (Grafana Tempo/Jaeger approved AD-17) |
| FR-10.5 (alerting) | §8.5 · final (Alertmanager approved AD-17) |
| FR-10.6 (lightweight/local tools) | §8.1 · final (self-hosted stack approved AD-17) |
| NFR-1 (latency budgets) | §9.1 — stands as architect-set targets; redirect = 302/no-store per AD-1; single-VM deployment may not meet original p95 budgets under load |
| NFR-2 (scale) | §4.4, §9.2 · final (scale targets retained as design targets; single VM may require horizontal scaling to meet them) |
| NFR-3 (availability) | §9.3, §8.5, §14 · **AD-16: single-VM personal MVP; HA, Multi-AZ, and 99.9% target explicitly NOT required** |
| NFR-4 (privacy) | §6.5, D-8/D-14 · **[RESOLVED AD-2, AD-10]** |
| NFR-5 (security) | §6.1, §6.6, §14.1, §14.7 · **[RESOLVED AD-3, AD-4, AD-7; secrets-outside-Git approved AD-17]** |
| NFR-6 (data lifecycle) | §4.2, §3.7 · **[RESOLVED AD-13, AD-5]** |
| NFR-7 (portability/local) | §1.3, D-2, D-3, §8.1 · **[AD-16: runs locally and on Oracle Cloud VM from same codebase; no cloud-vendor lock-in]** |
| NFR-8 (observability) | §8.1–8.5 · final (Prometheus/Grafana/Loki/Jaeger/Alertmanager approved AD-17) |
| NFR-9 (custom domains later) | §10.x (domain is an open implementation detail under AD-17 follow-on #3) · extension point retained |
| AC-01…AC-13 | AC-03 → AD-8/AD-5 · AC-05 → AD-1 · AC-09 → AD-2/AD-9/AD-10 · AC-10 → AD-15 · AC-11 → AD-3/AD-7 · AC-13 → AD-13 — **all formerly gated ACs now have resolved inputs** |
| Readiness review (2026-10-13) | §13 — corrections **c1–c4** applied (FR-2.5, FR-4.2, FR-4.4, FR-5.1, FR-5.2, schema §4.1); escalation **E1** open (cache-immediacy windows) · tickets URL-7/8/11/13/14 + foundation bootstrap ticket; AD-16/AD-17 platform/operational choices added 2026-11-02 |

---

## 13. Readiness Review — Corrections & Escalations (2026-10-13)

> Implementation-readiness review commissioned by Michael (orchestrator). Findings **B1–B4** were evaluated against this design. Corrections **c1–c4** are accepted architecture amendments, incorporated inline in the sections referenced below; this section is the durable audit record. Items requiring a product/human decision are isolated in **§13.3 ESCALATIONS** and were **not** decided by the Architect. No product requirement was invented, altered, or resolved by this review. Traceability updated in §12. Jira touched: new foundation/bootstrap ticket **URL-18** (created — bootstrap-coverage gaps), description/AC updates to **URL-7, URL-8, URL-11, URL-13, URL-14**, Blocks links URL-18 → URL-7/URL-8. Full audit: `specs/url-shortener-api/readiness-audit.md`.

### 13.1 Findings & accepted corrections

| # | Finding (B-numbering from the review brief) | Verdict | Evidence before amendment | Correction (accepted) | Inline amended | Tickets |
|---|---|---|---|---|---|---|
| **c1 (B1)** | Standard-queue at-least-once delivery can deliver click events more than once → analytics double-counted | **REAL DEFECT** | old §3.6: batches upserted with no per-event dedup key; old §1.2 message carried no event identity | ULID `eventId` added to the click message (§3.2 step 6, §1.2); `click_event_dedup(event_id PK, created_at)` inserted `ON CONFLICT DO NOTHING` **in the same transaction** as the aggregate upserts → exactly-once *counting effects* on a standard queue (FIFO not required); partial-batch redeliveries and consumer retries dedup on reprocess; dedup rows are bare ULIDs — no link/referrer/country/timestamp payload (privacy-compliant: purged at 7 days ≪ FR-5.2(c) 30-day ceiling; queue redelivery horizon must be strictly shorter than 7 days, e.g. ≤48h). **Queue transport approved AD-17: Redis Streams; SQS is historical-only (§1.2.2).** | §1.2, §3.2, §3.6, §3.7, §4.1, D-8, §7, §12, §14.5 | URL-13 (emit `eventId`), URL-14 (dedup gate + purge), URL-8 (table) |
| **c2 (B2)** | Idempotent link creation lacked explicit transaction boundaries + crash recovery → partial link row or stuck `in_progress` record possible | **REAL DEFECT** | old §3.5: two-phase write — insert `in_progress` → create link → update `completed` as separate statements; crash between phases left orphaned/stuck state and blocked replays for up to 24h | **Single ACID transaction**: idempotency insert → slug reservation → link insert → response capture → COMMIT (§3.5); conflict detected at the idempotency insert *before* any `links` write; crash ⇒ automatic rollback ⇒ clean retry (no recovery job needed); persisted `in_progress` state eliminated — racing loser waits on the winner's unique insert (speculative insertion), rolls back, re-reads, replays; slug retry loop re-issues the whole transaction | §3.5, §4.1, D-7, §7, §12 | URL-11 (transactional create + crash-injection AC), URL-8 (state comment) |
| **c3 (B3)** | Nullable `country_code` inside composite PRIMARY KEY/UNIQUE — NULLs are not equal → `ON CONFLICT` never matches → silent duplicate rows in `country_buckets_daily` / `country_totals` | **REAL DEFECT** | old §4.1: `country_code CHAR(2)` nullable in `PRIMARY KEY (link_id, day, country_code)` and `(link_id, country_code)` | Sentinel: `country_code CHAR(2) NOT NULL DEFAULT 'ZZ' CHECK (~ '^[A-Z]{2}$')` on both tables — `'ZZ'` = ISO 3166-1 user-assigned "unknown" bucket; upsert targets now always match (no NULL-in-key duplication); resolver failure emits `'ZZ'`, never NULL (§3.2 step 5); API surfaces `'ZZ'` as `country: null`, label `unknown` (§4.3) | §3.2, §4.1, §4.3, D-14, §12 | URL-8 (schema), URL-13 (emission), URL-14 (write/read mapping) |
| **c4 (B4)** | Redirect Tier-1 cache may serve stale destinations, or serve a deleted/expired link as active, until TTL expiry | **REAL DEFECT (expired leg)** — split treatment | old §3.2: cache entry `{destination, state}` with no per-entry expiry evaluation; D-9/§5.3 documented only *edit*-staleness | **Accepted fix:** cache entries carry `expiresAt`/`cachedAt` (§3.2 step 2); on hit, expiry is evaluated **in memory** → an expired link returns 410 immediately regardless of remaining TTL — TTL can never extend a link past expiry. **Already handled:** stale *destination* on edit ≤60s is the documented, AD-1-approved trade-off (D-9/§5.3); origin counts unaffected (`no-store`). **Escalated:** deleted-as-active window and negative-cache creation window → **E1** (§13.3) | §3.2, §12 | URL-13 (+ E1 pending human decision) |

### 13.2 Design invariants preserved after correction

- The redirect path still performs **zero per-click DB writes** — dedup happens inside the aggregator's transaction (§3.6), not the request path.
- **No raw click events stored:** `click_event_dedup` rows are bare ULIDs with no link/referrer/country/timestamp payload — dedup tokens, not event records; purged at 7 days (inside FR-5.2(c)'s 30-day ceiling). The CI privacy gate (§6.5) is extended to cover the dedup table's columns.
- AD-1 (302 + no-store, Tier-1 LRU, no CDN), AD-2 (transient GeoIP), AD-9/AD-10 (un-capped totals, 30-day buckets, no raw events) are unchanged; c1–c4 implement them *consistently*, they do not revise them.
- Migrations stay forward-only and non-destructive: c3 adds NOT NULL + DEFAULT + CHECK to previously-nullable columns on empty (pre-launch) tables; c1 adds one new table; c2 relaxes a write pattern only.

### 13.3 ESCALATIONS — human decision required (NOT decided by the Architect)

**E1 — Redirect cache immediacy windows (product-visible; AC semantics must be confirmed).**

Conflict: AD-1 (human, 2026-10-12) approves an *unconditional* Tier-1 LRU (positive 60s / negative 30s), while AC-FR-3.1 implies a deleted link stops resolving "as an active link" *immediately*, and a newly created slug may 404 for up to the negative TTL. Correction c4 fixes the *expired* leg architecturally (in-memory expiry check); three legs remain product-visible:

- (a) a deleted/disabled link may still 302 for up to **60s** after deletion (also applies to account-cascade deletes);
- (b) a newly created slug may 404 for up to **30s** after creation (negative cache);
- (c) destination edits propagate in ≤60s (already accepted under AD-1/D-9 — confirm as intended).

Options for the human decision-maker:

- **Option A — accept bounded windows** (simplest; optionally shorten TTLs, e.g. 15s/10s): AC-FR-3.1 tolerance documented as "within cache TTL (≤60s)".
- **Option B — strict immediacy**: drop positive/negative state caching entirely — every redirect performs a DB lookup (§9.1 miss-budget p95 ≤120 ms still met); §9.2 loses its primary DB-load lever, so §10.1 would need revisiting under load.
- **Option C — shared cache + invalidation**: a shared in-memory cache (e.g. Redis/Valkey) with mutation-published invalidation (new infra + cost; §10.1 already framed any shared cache as a separate human decision).

Pending this decision, URL-13 implements exactly what AD-1 approved (60s/30s TTLs as specified) plus the c4 in-memory expiry fix; Option C must not be implemented without a new human decision.

Related still-open items unchanged: §10.6 (CAPTCHA vendor), §10.7 (GeoIP vendor/license), §10.4 (FR-3.1 delete/disable wording — interacts with E1(a)), AM-2 and requirements.md markers (Jim).

---

## 14. Oracle Cloud VM Deployment Design (AD-16)

> This section records the **approved** personal-MVP deployment architecture on the confirmed Oracle Cloud Ubuntu ARM64 VM, including AD-17 operational tooling choices. It is an architecture/documentation update only — no implementation, no container/DB/network changes, no deployment. Product behavior and all prior non-platform decisions (AD-1…AD-15) are preserved. Historical AWS design (PR #6, URL-19, URL-20) remains in the repository as superseded record.

### 14.1 Host facts and constraints (read-only assessment)

| Attribute | Observed value | Design implication |
|---|---|---|
| Host | `ai-squad-vnic`, Ubuntu 6.17 Oracle kernel, AArch64/Neoverse-N1 | ARM64 container images required; Node 22 official images support ARM64 |
| CPU | 2 CPUs | Severe concurrency ceiling; CPU limits must leave headroom for PG |
| RAM | 11.65 GiB (~10 GiB available at sample) | Shared across OS, Docker, PostgreSQL, app, proxy, queue, observability |
| Disk | 34 GiB free | Tight for images, logs, local backup staging; immediate off-VM upload required |
| Docker | 29.1.3 / Compose 2.40.3 | `docker compose` CLI available; can use user-defined networks |
| PostgreSQL container | `url8-pg` running `postgres:16-alpine` on ARM64 | Reuse as-is; do not recreate or `down -v` |
| `url8-pg` current config | default `bridge` only; **no healthcheck**; restart policy `no`; no CPU/memory limits; `json-file` logs without rotation; 5432 bound on `0.0.0.0` and `[::]` via docker-proxy | Must add health/readiness probes externally; must address port binding and log rotation without breaking the running container |
| Host firewall evidence | `DOCKER-USER` chain is empty; Docker's `FORWARD`/`DOCKER` rules permit the DNATed 5432 path; host `INPUT` chain has a final reject but does **not** govern forwarded Docker traffic; OCI NSG/security-list rules were not inspected | A host `INPUT` reject alone does not protect the published 5432 port; protection must be applied in `DOCKER-USER` (persistent) **and** OCI NSG/security-list rules for IPv4/IPv6 |
| `url8-pg` volume | anonymous persistent volume `48cb4f...` | Must be preserved exactly; Compose must not replace it |
| Other container | `ryan-url8-postgres-1` exists (Created state, binds 5432, separate volume) | Do not start or remove; avoid port conflicts |
| Backup automation | none found in searched cron/systemd; crontab utility/spool absent | Backups must be implemented as part of the deployment work; cannot rely on host cron |
| Generic backup file | `ai-squad-backup.tar.gz` present but **not verified** as a DB backup | Do not treat as a verified restore point without owner confirmation |

**What was NOT verified:** Oracle Cloud NSG/security-list rules, host firewall rules beyond the observed empty `DOCKER-USER` chain and final `INPUT` reject, internet reachability from the VM or to it, domain/DNS, TLS certificate source, off-VM storage credentials. No claim is made that the DB is currently private-only, that the host is secure, or that Internet reachability is confirmed.

### 14.2 Network topology

**Approved final topology:**

1. **`urlshortener_db`** — user-defined Docker network, **DB-only**. `url8-pg` is the **only** member; no app/worker/proxy/queue service joins this network. The app service reaches the DB by container name/DNS on this network only. **Compose must not publish any new DB port.**
2. **`urlshortener_app`** — user-defined Docker network for app, aggregator, scheduler, and Redis/queue (if used). The app container joins **both** `urlshortener_db` (to reach `url8-pg`) and `urlshortener_app` (for controlled egress). Worker/scheduler/queue containers join only the networks they need. This network is **egress-capable** so app containers can reach external OAuth/email/CAPTCHA providers through the host's public interface; it must **not** be declared `internal: true` unless an explicit egress proxy is added and approved.
3. **`urlshortener_edge`** — network (or host network) for the reverse proxy, exposing `:443` only. The reverse proxy joins `urlshortener_edge` and `urlshortener_app`; it forwards inbound HTTPS to the app container and must not have access to `urlshortener_db`.

**Current state vs. target:** the running `url8-pg` is currently attached to Docker's default `bridge` network only. The target state is `url8-pg` on `urlshortener_db` only. Adding the new network is non-disruptive (`docker network connect`), but **disconnecting `url8-pg` from `bridge` must be sequenced during a maintenance window**: a brief disconnect is required, and if the operation fails the container could lose network connectivity. Rollback is `docker network connect bridge url8-pg`. Until the disconnect is complete and verified, the container retains its default-bridge membership.

**Port 5432 wildcard binding:** the read-only assessment found `url8-pg` currently publishes 5432 on `0.0.0.0` and `[::]` via docker-proxy. Attaching the container to a new private network does **not** remove that binding. **The database is therefore not currently private** even after `urlshortener_db` is added. Safe resolution options (owner must approve one):

- **Option A (preferred, non-destructive):** leave the container running. The legacy Docker HostPort binding (`0.0.0.0`/`[::]`:5432) remains in place; Compose must not add any new DB port publishing. External reachability is blocked by **both**:
  - A persistent `DOCKER-USER` chain rule (survives Docker daemon restart) on IPv4 and IPv6 that **permits** 5432 ingress from the local host and from the `urlshortener_db`/`urlshortener_app` bridge subnets (so app→DB traffic continues to work) and **drops** 5432 ingress from all other sources; and
  - OCI NSG/security-list rules denying 5432 ingress from any non-local source on both IPv4 and IPv6.
  Host `INPUT` chain rules alone do **not** protect Docker-published ports because Docker routes through `FORWARD`/`DOCKER-USER`. A naïve `DROP` in `DOCKER-USER` would also break app→DB traffic, so the rule must whitelist the approved bridge path. **Option A does not achieve "no Docker HostPort binding at all"; it only makes the existing binding effectively unreachable externally and limited to the approved path.** Acceptance gate: external `nmap`/`nc` from another host shows 5432 filtered/closed on both IPv4 and IPv6 while `pg_isready -h url8-pg -p 5432` still succeeds from an app container on `urlshortener_db`.
- **Option B (destructive, requires verified backup + approval):** stop the `url8-pg` container and recreate it with **no published ports** (`ports: []`), attaching only `urlshortener_db`, while reusing the exact same anonymous volume (`docker run ... --volumes-from url8-pg` or by identifying and mounting the same volume with `--mount source=<volume-id>,target=/var/lib/postgresql/data`). **This is the only option that yields no Docker HostPort binding at all.** It is a fallback because it interrupts PostgreSQL and risks the volume if done incorrectly. **Only allowed after a verified `pg_dump`/`pg_dumpall` backup is stored off-VM and the owner explicitly approves the recreation.**

**External verification gates:**
- From the VM itself: `docker exec url8-pg ss -ltn | grep 5432` shows only the container listener, not `0.0.0.0`/`[::]` if Option B is used.
- From another host on IPv4: `nmap -p5432 <vm-ipv4>` → `filtered` or `closed`.
- From another host on IPv6: `nmap -6 -p5432 <vm-ipv6>` → `filtered` or `closed`.
- From the app container on `urlshortener_db`: `pg_isready -h url8-pg -p 5432` succeeds.

### 14.2.1 Prepared remediation plan for the existing wildcard 5432 binding (plan only — no implementation)

> Owner preference (AD-17): **persistent OCI NSG + IPv4/IPv6 DOCKER-USER filtering** (Option A path). The owner has asked for a prepared/verified plan before applying it. This section documents that plan; no rule, network, container, or firewall change is performed.

**Current facts (read-only observations):**
- `url8-pg` is running on Docker's default `bridge` network.
- It has a Docker HostPort binding to `0.0.0.0` and `[::]` on port 5432 via docker-proxy.
- `DOCKER-USER` is empty; Docker's `FORWARD`/`DOCKER` rules permit the DNATed 5432 path.
- Host `INPUT` chain has a final reject but does **not** govern forwarded Docker traffic.
- Host primary NIC is `enp0s6` with IPv4 `10.0.0.87/24` and route `10.0.0.0/24`.
- The host currently has **no global IPv6 address** (only link-local), even though `url8-pg` is published on `[::]`.
- Docker default `bridge` network CIDR is `172.17.0.0/16`.
- Stale `ryan-url8_default` network CIDR is `172.18.0.0/16` and is link-down; it must not be reused.
- Docker `DefaultAddressPools` is unset; new user-defined bridge networks default to the next available `/16` unless explicitly created with a custom subnet.
- OCI NSG/security-list rules and any VCN/peered routes remain unverified.
- The container, its image, its published port, and its volume are **not modified** by this plan.

**Candidate DB bridge subnet (proposed for review, not created):**
- Proposed `urlshortener_db` subnet: **`172.19.0.0/16`**.
- This does not overlap the observed host route (`10.0.0.0/24`), Docker default bridge (`172.17.0.0/16`), or the stale `ryan-url8_default` network (`172.18.0.0/16`).
- Final subnet selection and any `urlshortener_app` subnet must be conditional on checking **all OCI VCN and peered routes** before any network is created.
- The candidate subnet is a planning value only; no Docker network, `iptables`/`nftables` rule, or NSG rule has been applied.

**Plan steps (to be reviewed and approved by owner before execution):**

1. **Discovery / conflict check:**
   - Record the VM's actual primary NIC, default route, and any existing `iptables`/`nftables` rules.
   - Record the current Docker bridge CIDRs for `docker0` (default bridge) and the to-be-created `urlshortener_db`/`urlshortener_app` networks.
   - Verify no other host process or container binds 5432 (note: `ryan-url8-postgres-1` exists and must not be started).

2. **Define target network and allowed path:**
   - Create `urlshortener_db` as a user-defined bridge (DB-only), using the candidate `172.19.0.0/16` subnet **only after** verifying it does not overlap any OCI VCN or peered route.
   - `url8-pg` will be connected to `urlshortener_db` (and optionally disconnected from default `bridge` in a later, separately approved step).
   - The only allowed 5432 ingress paths are:
     - Loopback (`127.0.0.1`/`::1`) for admin/probes.
     - The `urlshortener_db` bridge subnet (for app/aggregator/scheduler/backup containers).
     - The `urlshortener_app` bridge subnet only if a backup or sidecar container there requires it (default: deny; approve explicitly if needed).
   - All other IPv4/IPv6 sources to 5432 are dropped.

3. **Persist rules across reboot:**
   - Install a systemd service or `iptables-save`/`nftables` ruleset that re-creates the `DOCKER-USER` chain rules after Docker daemon start.
   - Use `iptables -I DOCKER-USER …` (or nftables equivalent) so rules survive `dockerd` restart; do not rely on host `INPUT` alone.

4. **OCI NSG/security-list rules:**
   - Add ingress rules denying TCP 5432 from `0.0.0.0/0` and `::/0` on the VNIC/security list.
   - **IPv6 note:** even though this host currently has no global IPv6 address, `url8-pg` is published on `[::]`, so external IPv6 ingress to 5432 must still be explicitly denied and verified. A future global IPv6 assignment would otherwise expose the port.
   - Allow 5432 only from an explicit admin/source CIDR if remote admin access is required; default to deny.

5. **Rollback:**
   - Before applying, save current `iptables-save`/`nftables` ruleset.
   - Rollback command: restore saved ruleset + `docker network connect bridge url8-pg` if disconnect was performed + remove NSG deny rules.

6. **Verification (external):**
   - From another host on IPv4: `nmap -p5432 <vm-ipv4>` → `filtered` or `closed`.
   - From another host on IPv6: `nmap -6 -p5432 <vm-ipv6>` → `filtered` or `closed` (required even though the host currently has no global IPv6 address, because `url8-pg` is published on `[::]` and an IPv6 address could be assigned later).
   - From app container on `urlshortener_db`: `pg_isready -h url8-pg -p 5432` succeeds.
   - **No claim of "private-only" is made until these gates pass.**

**Important constraints:**
- This plan preserves the existing `url8-pg` container and its anonymous volume; no recreation is required for Option A.
- Any change to the `url8-pg` container itself — including applying `docker update --restart`, adding a Docker `HEALTHCHECK`, disconnecting from default `bridge`, or recreating it — requires a separate explicit owner approval.
- Option B (container recreation with no HostPort) remains documented as the only path to "no Docker HostPort binding at all."

### 14.2.2 Non-domain temporary test path

Until a domain and TLS certificate are available, the application can be tested via **SSH local port-forwarding only**:
- Run the app container with Fastify listening on `127.0.0.1:3000` inside the VM (not exposed publicly).
- Use `ssh -L 3000:127.0.0.1:3000 user@<vm-ip>` from a workstation to access the API/redirects over loopback.
- No public app port (80/443) is opened and no public TLS certificate is assumed.
- **Limitation:** OAuth and email provider callbacks typically require a public domain/HTTPS endpoint; full provider integration may be blocked until a domain is configured. Local/dev OAuth/email overrides (e.g. MailHog) can be used for non-domain testing.

### 14.3 Restart, health, and readiness

> **Clarification:** Docker Compose `restart:` policies restart a container when its **main process exits** (or the container stops). They do **not** restart a container solely because a Docker `HEALTHCHECK` reports `unhealthy`. Therefore restart-on-exit and health/readiness detection are separate controls.

Because `url8-pg` is external to Compose and currently lacks a Docker healthcheck and has `restart: no`, readiness/recovery must be handled at multiple layers:

| Control | Scope | What it checks | How |
|---|---|---|---|
| **Restart on process exit** | App, aggregator, scheduler, queue, proxy, backup containers only | Main process exited/crashed | `restart: unless-stopped` (or `always` for DB-critical paths). Does **not** trigger on `unhealthy` healthcheck. |
| **Restart on process exit for `url8-pg` (post-approval)** | Existing `url8-pg` container, no recreation needed | Postgres process exited/crashed | `docker update --restart unless-stopped url8-pg` (or `always`) applies a restart policy to the running container while preserving its current ID and volume. **No command now; owner approval required.** |
| **App liveness `/healthz`** | App container | Fastify process is running | HTTP GET from reverse proxy and from an external uptime check |
| **App readiness `/readyz`** | App container | App can reach PostgreSQL via `pg.Pool` | HTTP GET executes `SELECT 1`; fails (non-200) when DB unreachable |
| **External DB probe/alert** | Operational substitute for a missing container healthcheck | PostgreSQL process is accepting connections on the private network | `docker compose exec app pg_isready -h url8-pg -p 5432` or a sidecar probe; on repeated failure, alert owner; recovery is manual |
| **Container healthcheck (future)** | Only if `url8-pg` is ever recreated with owner approval | Postgres process healthy inside container | Add `HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD pg_isready -U … -d …` to the recreated image; combine with `restart: unless-stopped` so process-death triggers restart. Not possible on the running container without recreation. |

**Health vs. restart separation for `url8-pg`:** restart-on-exit can be added later with `docker update` (no recreation, no volume risk). Healthchecking the existing container must remain external (`pg_isready` probe + alert) because adding a Docker `HEALTHCHECK` requires recreating the image/container. A future recreation (Option B) can combine both. No `docker update`, `docker restart`, or recreation is performed without owner approval.

**Reverse proxy health checks:** proxy should fail open only to a static maintenance page; otherwise route to app only when app `/healthz` returns 200.

### 14.4 Resource limits and log rotation

Given 2 CPUs / ~11 GiB / 34 GiB disk:

| Service | CPU | Memory | Notes |
|---|---|---|---|
| `app` | 1.0 | 1 GiB | Single Fastify process |
| `postgres` (`url8-pg`) | 1.0 | 4 GiB | Current container has no limits; applying limits requires container recreation (Option B) |
| `redis` (queue) | 0.25 | 256 MiB | Tiny if Redis Streams selected |
| `proxy` | 0.25 | 128 MiB | Caddy/nginx |
| `aggregator` | 0.5 | 512 MiB | Batch worker |
| `scheduler` | 0.1 | 128 MiB | Cron launcher |
| `backup` sidecar | 0.1 | 128 MiB | Runs `pg_dump` + upload |
| Reserve for host/Docker | — | ~4 GiB | OS, Docker daemon, build cache |

**Log rotation:** all Compose services must set `logging: { driver: "json-file", options: { max-size: "10m", max-file: "5" } }` to prevent the 34 GiB disk from filling. Application logs are JSON; host-level collection (e.g. `promtail`/`fluent-bit`) ships to Loki or off-VM store.

### 14.5 Async click aggregation (D-8 preserved)

**Product behavior unchanged:** redirect path performs **zero per-click DB writes**. Click messages are emitted asynchronously and consumed by an aggregator worker that applies the §13-c1 `eventId` dedup gate.

**Approved transport (AD-17):** **Redis Streams** with persistence enabled (`appendonly yes`), a consumer group per worker, explicit ACK/NACK, retry counter, and a dead-letter stream for exhausted retries. This preserves:
- non-blocking redirect path;
- at-least-once delivery with exactly-once counting effects via `click_event_dedup`;
- bounded redelivery/replay window strictly shorter than dedup-token retention (see safety rule below);
- no raw click-event rows stored.

**Safety rule — redelivery horizon must be shorter than dedup retention:** the established `click_event_dedup` tokens are purged after **7 days** (§3.6, §3.7, §4.1). To prevent a late redelivery from double-counting after its token is gone, the Redis Streams maximum retention/replay horizon must be **strictly less than 7 days**. A **recommended** default is **≤ 48 hours**, matching the historical AWS SQS design's bound (§3.6, §13-c1). The exact retention is an implementation detail to be configured by the developer; changing it to ≥ 7 days or changing `click_event_dedup` retention requires a separate human approval.

**Open implementation details (AD-17 follow-on #2):** exact stream retention (≤48h recommended), `appendonly`/`appendfsync` policy, AOF rewrite scheduling, Redis memory limit, consumer-group count, and DLQ stream retention. URL-14 owns the consumer behavior; the current aggregator stub is intentionally unimplemented and must be replaced by URL-14 logic.

### 14.6 Backups

**Required:** automated backups of both `urlshortener` and `url8_acceptance` databases, including required globals (roles, tablespaces if any). The current host has no backup automation.

**Approved baseline (AD-17):**
- **Cadence:** daily.
- **Target:** **Oracle Cloud Object Storage** (encrypted).
- **Retention:** 7 days on OCI Object Storage.
- **Scope:** per-database `pg_dump` of `urlshortener` and `url8_acceptance` plus `pg_dumpall --globals-only`.
- **Restore test:** a verified restore test is required before production; ongoing cadence, target database, and owner remain open (AD-17 follow-on #1).

**Architecture:**
1. **Backup runtime:** a dedicated ARM64 PostgreSQL-client/backup image (e.g. `postgres:16-alpine` on ARM64) attached to `urlshortener_db` only, **or** a verified host-installed PostgreSQL client running on the VM. The Node application image must **not** be assumed to contain `pg_dump`/`pg_dumpall`.
2. **Per-database dumps:** for each of `urlshortener` and `url8_acceptance`, run `pg_dump -Fc -d … --no-owner --no-privileges` (or owner-approved flags) over the private Docker network to a staging directory, using a least-privilege DB role that has `CONNECT` on the target database and `SELECT` on required tables/schemas. The live DB volume is **not mounted** into the backup job.
3. **Globals export:** run `pg_dumpall --globals-only` (or equivalent role/tablespace export) using a privileged/admin role over the private Docker network. Store this globals dump alongside the per-database dumps.
4. **Encryption & upload:** encrypt all dumps immediately (e.g. `gpg` symmetric or age), then upload to **Oracle Cloud Object Storage**. **No new AWS resources under AD-16's no-new-AWS-resource rule.**
5. **Retention pruning** at 7 days on OCI Object Storage.
6. **Verified restore test** before production deploy to a throwaway local database (restore globals, then per-DB dumps). Ongoing cadence, target, and owner remain open (AD-17 follow-on #1).

**Owner/ops decisions still open (AD-17 follow-on #1):** OCI Object Storage bucket/region, OCI credentials/S3-compatible endpoint, encryption key management, exact backup time-of-day, least-privilege backup role provisioning, restore-test cadence/target/owner, RPO/RTO numeric targets. **No backup or database operation is performed by this design update.**

### 14.7 Secrets

AWS Secrets Manager ARNs (`SECRET_ARN_*`) no longer apply to the Oracle runtime. **Approved model (AD-17):** all secrets protected outside Git.

| Secret | Oracle source |
|---|---|
| DB credentials | Inject into app via `.env` or Docker Secret; migrations may use a separate admin user |
| JWT signing key | Owner-generated 256-bit key, injected at deploy, never committed |
| OAuth client secrets | Injected at deploy |
| CAPTCHA secret | Injected at deploy |
| TLS certificate/key | Let's Encrypt (Caddy automates) or owner-provided cert |
| Backup upload credentials | Injected at deploy |
| OCI Object Storage credentials | Injected at deploy |

**Rules:** no secret literals in git; `.env` on VM `0600`; prefer Docker Secrets or CI-injected env over static files; rotation procedures documented. **Approved AD-17.**

### 14.8 Reverse proxy, domain, certificate, and egress

- **Reverse proxy:** **Caddy** — **approved AD-17** for HTTPS termination when a domain exists. Until then, the temporary test path is SSH port-forwarding to a loopback-only listener (§14.2.2).
- **Domain:** single shared domain (NFR-9); DNS A/AAAA records point to the VM public IP. Domain name, DNS provider, and certificate source (Let's Encrypt vs owner-provided) are open implementation details (AD-17 follow-on #3).
- **Certificate:** Let's Encrypt (requires port 80/443 reachable and domain control) or owner-provided cert.
- **Egress for providers:** OAuth (Google/GitHub), email/transactional mail, CAPTCHA verification reach the internet via the host public interface through the `urlshortener_app` network. If that network is ever made `internal: true`, an explicit HTTP/HTTPS egress proxy must be added.
- **OAuth/email callback limitation:** until a public domain/HTTPS endpoint exists, provider callbacks may not function; use local/dev overrides (MailHog, local OAuth config) for non-domain testing.

### 14.9 CI/CD

**Approved pipeline (AD-17):** GitHub Actions with a **manual deployment approval gate**.

**CI:** lint → typecheck → test → build → Docker image build → `docker compose config` validation → image push to owner-approved registry (or build on VM).

**Deployment:** approval-gated staging deploy to the VM (or a staging compose project on the same VM) → migration smoke test → health/readiness verification → **manual human approval** → production deploy.

**Rollback:** redeploy previous image tag; DB migrations remain forward-only.

**Owner-supplied blockers (currently missing):** VM SSH/self-hosted runner credentials, container registry credentials, staging/prod VM targets, DNS/domain, TLS certificate source, notification channels. These must be supplied before the pipeline can be wired.

### 14.10 Historical AWS design preservation

- `infra/`, `cdk.json`, `docs/aws-prerequisites.md`, `tests/infra/`, and the historical Lambda entrypoints in `src/functions/` and `src/lambda.ts` remain in the repository.
- URL-19 (AWS CDK) stays in **Evidence Review / Agent Owner Human** with PR #6 as its delivered code; human acceptance proceeds on AWS merits.
- URL-20 (AWS CI/CD pipeline) stays **To Do / Agent Owner Developer**; its unimplemented AWS pipeline must not be called complete. It is not silently re-scoped to the Oracle path.
- Any future decision to retire the AWS path is a separate, explicit human approval.

### 14.11 Proposed Oracle Compose runtime scope — URL-27 (proposal only; no ticket created)

> **Jira issue URL-27 is proposed, not created, by this design update.** A live read-only Jira search confirmed URL-27 does not exist. No Jira issue is created, edited, or transitioned. URL-19 (AWS CDK) stays in **Evidence Review / Agent Owner Human** and URL-20 (AWS CI/CD pipeline) stays **To Do / Agent Owner Developer**.

**Proposed summary (URL-27):** Oracle Docker Compose runtime baseline — production-ready Compose definition, private container networking and `url8-pg` firewall remediation plan, Redis Streams async click-aggregation pipeline, daily encrypted Oracle Cloud Object Storage backups, Caddy HTTPS reverse proxy (domain-gated), self-hosted observability/alerting stack, and secrets management. **Excludes the GitHub Actions deployment workflow**, which is proposed as a separate dependent task.

**Proposed scope (URL-27):**
- Add Oracle-path Docker Compose files (app, aggregator, scheduler, Redis Streams, Caddy, backup sidecar, observability stack) with no committed secrets.
- Implement the approved `url8-pg` network/firewall remediation plan (§14.2.1) only after owner approval (AD-17 follow-on #5), including user-defined bridge networks and health/readiness wiring.
- Implement Redis Streams producer/consumer wiring preserving `eventId` dedup, retry, DLQ, and zero per-click DB writes.
- Implement daily encrypted Oracle Cloud Object Storage backup job with 7-day retention; include a **verified restore test before production** (ongoing cadence, target, and owner remain open AD-17 follow-on #1).
- Implement Caddy HTTPS config (domain-dependent) and SSH-tunnel loopback test path for non-domain phases.
- Wire Prometheus/Grafana/Loki/Jaeger/Alertmanager for health/log/resource/disk/backup alerts.
- Provide documented runtime health checks, secrets-injection conventions, and operator runbooks compatible with the approved **manual GitHub Actions deployment approval gate** (§14.9), but do **not** implement the Actions workflow itself.

**Dependencies / links proposal (URL-27):**
- Depends on / links to: URL-8 (schema/migrations), URL-11 (transactional create), URL-13 (emit `eventId`), URL-14 (dedup gate), and URL-18 (bootstrap).
- Does not supersede URL-19 (AWS CDK — Evidence Review / Agent Owner Human) or URL-20 (AWS CI/CD — To Do / Agent Owner Developer).
- URL-20’s AWS pipeline was never implemented; re-scoping URL-20 to an Oracle CI/CD pipeline is an **alternative human decision only** and would require explicit owner approval with its AWS audit history retained.
- Suggested parent: existing Epic URL-6. Suggested Agent Owner = Developer; assignee = human owner for credentials/approval gates.

**Proposed additional task (no guessed issue key):** A separate Oracle CI/CD pipeline task may be created under Epic URL-6 to own the GitHub Actions workflow with the **manual deployment approval gate** (§14.9), container registry credentials, self-hosted runner or SSH deploy key, staging/prod VM targets, and notification channels. It would depend on URL-27 (runtime baseline) and on AD-17 follow-on #4. Do not assign an issue key in this document.

---

*Produced by the Architect; revised 2026-10-12 to incorporate human resolutions AD-1…AD-15; readiness-reviewed 2026-10-13 (§13: corrections c1–c4 accepted and applied inline, escalation E1 open); **platform and operational tooling revised 2026-11-02 to incorporate human decisions AD-16 (Oracle Cloud VM / Docker Compose) and AD-17 (Redis Streams, OCI backups, Caddy, secrets, alerts, manual CI/CD gate, SSH tunnel test path)**. PRD.md was not modified. `requirements.md` was revised by Jim 2026-11-02 to record AD-16/AD-17. Historical AWS design (PR #6, URL-19, URL-20) is preserved as superseded record; no AWS CDK files, databases, containers, networks, volumes, GitHub workflows, firewall rules, or cloud resources were altered. Jira implementation tickets remain in their prior states (URL-19 Evidence Review / Agent Owner Human; URL-20 To Do / Agent Owner Developer). Implementation of application features is the Developer's responsibility; this artifact defines the architecture and its decision state, not the code.*

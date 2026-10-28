# Design Document: URL Shortener API

| Field | Value |
|---|---|
| **Artifact** | `specs/url-shortener-api/design.md` |
| **Status** | Architecture decisions **human-resolved 2026-10-12** (AD-1…AD-15, §11) — ready for implementation hand-off |
| **Date** | 2026-10-11 (initial) · **Revised 2026-10-12** (resolutions incorporated) · **Readiness review 2026-10-13** (§13 corrections c1–c4, escalation E1) |
| **Author** | Dwight Schrute — Architect & Code Reviewer |
| **Inputs** | `/home/roy/projects/ai-squad/PRD.md` (Approved, 2026-10-08, immutable) · `specs/url-shortener-api/requirements.md` (Draft, 2026-10-11) |
| **Decisions recorded** | AD-1…AD-15 resolved by human (Michael) 2026-10-12 — see §11 (resolution log) |
| **Next hand-off** | Implementation tickets **created 2026-10-12** on explicit instruction: Epic **URL-6**, tasks **URL-7…URL-17** (project URL, assignee = human owner, Agent Owner = Developer) → Developer, coordinated by Michael |
| **Notes** | PRD.md and requirements.md **not modified** by this revision. requirements.md §8 still displays the original `[PENDING Q1..Q10]`/`[A1..A7]`/`[AM1..AM5]` markers; regenerating it to reflect the resolutions is Jim's responsibility (author), per squad workflow. AM-2 (PRD footer status inconsistency) remains a documentation matter for the human owner. |

---

## 1. Overview

### 1.1 Purpose and scope

A privacy-first URL shortener delivered as an API + database only: accounts with dual authentication (API keys + JWT), link CRUD with auto-generated and custom slugs, idempotent creation, fast anonymous redirects (302, 410, 404), aggregate-only analytics (total/referrer/country), QR code generation (PNG/SVG), per-user rate limiting, risk-triggered CAPTCHA-protected creation, and full observability — deployed serverless against the existing AWS RDS PostgreSQL instance (FR-9). Targets: 10,000+ users, 1,000,000+ links (NFR-2).

Scope boundaries (PRD §4, requirements §3.2): no frontend, no custom domains (NFR-9: designed-for), no teams, no bulk ops, no webhooks, no interstitials, no GDPR workflows, no monetization. This document does not implement features and does not modify the PRD or requirements. All architectural forks that previously required human input were **resolved on 2026-10-12 (AD-1…AD-15, §11)**; residual open items are technical/product clarifications tracked in §10.

### 1.2 System context (approved)

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
 Local dev: same Fastify app runs as a plain Node HTTP server against docker-compose
 (PostgreSQL + Jaeger + MailHog + local geo DB) — no Lambda/API Gateway emulation (FR-9.3, NFR-7).
```

### 1.3 Technology stack (A2 confirmed — §11 AD-12)

| Layer | Choice | Requirement drivers |
|---|---|---|
| Runtime | Node.js 22 LTS + TypeScript (strict) | FR-9.3, NFR-7 — first-class Lambda support, runs natively locally |
| Web framework | **Fastify** + JSON Schema validation, wrapped by `aws-lambda-fastify` for Lambda and plain `listen()` for local | FR-7.2, NFR-1, FR-9.3 — dual-entrypoint pattern **retained by AD-12** |
| Serverless platform | **AWS Lambda + API Gateway HTTP API (v2)** in the existing VPC — *confirmed 2026-10-12* | FR-9.1, FR-9.2, AD-12 (A2 resolved) |
| Data access | `pg` driver + parameterized SQL + `node-pg-migrate` migrations | NFR-7; predictable hot-path queries |
| Database | Existing **Multi-AZ** RDS PostgreSQL behind **AWS RDS Proxy** — *A1 confirmed* | FR-9.2, §9.4 connection analysis |
| Async pipeline | Amazon SQS (standard queue + DLQ) → aggregator Lambda | FR-4.4, FR-5, NFR-4 |
| QR generation | `qrcode` npm (pure-JS: PNG via pngjs, SVG string) | FR-6.1/6.2 — no native deps → portable Lambda/local |
| Auth | Self-managed: argon2id passwords, JWT access + rotating refresh, hashed API keys, **Google + GitHub adapters only** (`openid-client` + GitHub OAuth, PKCE) | FR-1.1/1.2/1.3, NFR-5, AD-14 (Q6/A5 resolved) |
| Country resolution | In-process **transient GeoIP** module (geo DB via Lambda layer / local file); vendor TBD (§10.9) | FR-5.1, AD-2 (Q4 → Option B) |
| CAPTCHA | Pluggable **`CaptchaProvider`** interface, trigger mode **`suspicious`**; vendor TBD (§10.8) | FR-2.7, AD-3 (Q5 → mode resolved) |
| Email | AWS SES in deploy; SMTP adapter locally (MailHog); **standard double opt-in** verification | FR-1.2, AD-14 (A5 confirmed) |
| Rate limiting | Sliding-window counter in PostgreSQL, subjects `user:`/`apikey:` | FR-8.1/8.2, AD-7 (Q3/A4/AM-4 resolved) |
| Logging | `pino` structured JSON to stdout → CloudWatch Logs | FR-10.1, FR-10.6 |
| Metrics/traces | OpenTelemetry → AWS Distro for OTel → CloudWatch Metrics + X-Ray; local OTLP → Jaeger | FR-10.3/10.4, FR-10.6 |
| Alerting | CloudWatch Alarms → SNS (email/Slack) | FR-10.5 |
| IaC | AWS CDK (TypeScript) | One-language toolchain; NFR-7 |
| CI/CD | GitHub Actions: lint → test → build → synth → deploy staging → **human approval gate** → prod | Approval gates never bypassed |

**Platform rationale (AD-12, confirmed):** Lambda over Cloud Run: same-VPC reach to private RDS (no cross-cloud networking), native RDS Proxy/Secrets Manager/SQS/ADOT integration, managed scaling via HTTP API. The dual-entrypoint design keeps a containerized fallback (Cloud Run-class) viable with no code change beyond the entrypoint — portability retained deliberately.

---

## 2. Architecture Decisions and Rationale

> Numbering: **D-1…D-15** below are design decisions owned by the Architect. Human-gated decisions are **AD-1…AD-15** (§11). All previously conditional rows now carry their resolution.

| # | Decision | Rationale | Requirement drivers · status |
|---|---|---|---|
| **D-1** | Serverless platform: **AWS Lambda + API Gateway HTTP API**; four functions (`redirectFn`, `apiFn`, `aggregatorFn`, `maintenanceFn`) | Same-VPC proximity to RDS; HTTP API lower latency/cost than REST API; redirect path gets an independent scaling unit and bulk-radius-of-failure separation from management API (NFR-3) | FR-9.1/9.2 · **confirmed AD-12** |
| **D-2** | Framework: **Fastify on TypeScript/Node 22**, dual entrypoint (Lambda adapter / local `listen`) | Fast startup, low overhead for latency budget; JSON-Schema validation yields FR-7.2-consistent errors; identical code local vs cloud | FR-7.1–7.3, NFR-7 · confirmed AD-12 |
| **D-3** | Data access: raw `pg` + parameterized SQL + `node-pg-migrate` | Full control over hot-path query plans; zero runtime magic; trivially runs against local Postgres | NFR-7, FR-9.3 · final |
| **D-4** | All deployed DB access flows through **RDS Proxy**; direct connection locally | Connection-exhaustion control — math in §9.4: multiplexing, session pinning, failover re-routing, Secrets Manager auth | FR-9.2, NFR-2, NFR-3 · final |
| **D-5** | Auto slug: **7-char base62 (`[a-zA-Z0-9]`), crypto-random, insert-with-retry** (max 8 attempts on unique-violation) | 62⁷ ≈ 3.5×10¹² space; at 1M links per-insert collision probability ≈ 3×10⁻⁷; DB unique constraint is the single source of truth (no allocator to race) | FR-2.2, FR-2.4 · final |
| **D-6** | Custom slug: strict validation (3–50 chars, **`[a-zA-Z0-9]`** app + DB CHECK) via **`slug_reservations` tombstone table**; collision → `409` with **3 availability-checked alternatives** | Tombstones let `links` rows hard-delete (FR-1.4) while slugs stay reserved FCFS (FR-2.4) | FR-2.3/2.4 · **resolved AD-5 (never release), AD-8 (strict charset, 3 suggestions)** |
| **D-7** | Idempotency: **PostgreSQL-backed records** — `UNIQUE(principal, key)`, **create executes in one ACID transaction** (§3.5; persisted `in_progress` eliminated — §13-c2), 24h TTL, request-hash mismatch → `409` | Survives Lambda restarts and multi-container concurrency; crash mid-create rolls back cleanly (no partial row, no stuck record); replays return stored response with no duplicate row; no extra infrastructure | FR-2.5, AC-04 · **amended §13-c2** |
| **D-8** | Click aggregation: redirect → **SQS (best-effort, non-blocking)** → aggregator Lambda → **eventId-deduped (§13-c1)** upserts into **daily aggregate buckets + un-capped `BIGINT` all-time totals**; **no raw click-event rows ever stored**; daily buckets purged after 30 days; totals kept indefinitely | Strongest reading of NFR-4/FR-5.2; per-event ULID dedup gives exactly-once *effects* under at-least-once delivery; queue in-flight messages live ≤ SQS retention (≪30 days); SQS absorbs bursts and isolates redirect availability from analytics | FR-4.4, FR-5, NFR-4 · **confirmed AD-9 (no caps), AD-10 (conservative lifetime), A3; dedup amended §13-c1** |
| **D-9** | Redirect caching: **Tier-1 per-container LRU** (positive 60s / negative 30s) + **`Cache-Control: no-store`** on 302s; **no Tier-2 CDN** | AD-1: accurate origin click counts required; 302s are not browser-cacheable; Tier-1 bounds edit-staleness at 60s while every repeat hit still reaches origin | FR-4.1/4.4, NFR-1 · **resolved AD-1 (302 branch)** |
| **D-10** | Rate limiting: **sliding-window counter in PostgreSQL** (1-minute windows, weighted estimate), subjects `user:` / `apikey:` at uniform **100 req/min** | AD-7: in-app branch chosen; no Redis dependency (NFR-7, local parity); weighted sliding window avoids fixed-window 2×-burst flaw; subject-keyed policy rows leave a tier extension point without redesign | FR-8.1–8.3 · **resolved AD-7 (Q3/A4/AM-4)** |
| **D-11** | Auth: **self-managed** — argon2id passwords; JWT access (15 min) + rotating refresh (hashed, revocable); API keys `usk_<prefix>_<secret>` stored as prefix + SHA-256, constant-time verify; **Google + GitHub** authorization-code + PKCE | Dual auth (FR-1.3) in one middleware chain; hashed credentials revocable on account deletion (FR-1.4); no hosted UI keeps service API-only and locally runnable | FR-1.1–1.4, NFR-5/7 · **confirmed AD-14 (providers + double opt-in)** |
| **D-12** | QR codes **generated on demand, never stored**; `?format=png\|svg`; payload = **short URL**; no styling options | Stateless, zero eviction logic; pure-JS lib works identically in Lambda and local | FR-6.1/6.2 · **resolved AD-15 (Q7)** |
| **D-13** | Observability: **pino (JSON) + OpenTelemetry → ADOT → CloudWatch (logs/metrics) + X-Ray (traces)**; alarms → SNS; local: same OTLP pipeline to dockerized Jaeger | One instrumentation set for cloud and local (FR-10.6); no SaaS required to develop | FR-10.1–10.6, NFR-8 · final |
| **D-14** | Analytics schema: `country_code CHAR(2) NOT NULL DEFAULT 'ZZ'` (unknown sentinel — §13-c3) fed by **transient request-time GeoIP (AD-2)**; referrer stored as **host only** (lowercased, `www.` stripped, `(direct)` bucket); counts `BIGINT` | Only the ISO country code leaves the resolver — IP never persisted/logged; `'ZZ'` keeps composite PK/UNIQUE upsert targets NULL-free (NULLs are not equal — c3); host-only referrer caps cardinality and avoids leaking token-bearing referrer URLs; `BIGINT` absorbs any realistic volume (AD-9) | FR-5.1/5.2, NFR-4 · **resolved AD-2 (Option B), AD-9; sentinel amended §13-c3** |
| **D-15** | CI/CD: CDK stacks via GitHub Actions; migrations as pre-deploy pipeline step; staging → **human approval** → prod; rollback = redeploy previous artifact (forward-only migrations) | Un-bypassable human gate; safe rollback posture | FR-9.1 · final |

---

## 3. Component Design

### 3.1 Edge and routing

- Route 53 + API Gateway **HTTP API** on one custom domain (single shared domain per NFR-9). **No CloudFront/CDN in front** — per AD-1 (origin counts) and AD-2/AD-7 (no edge layer).
- Routes (single-segment `{slug}` can never collide with multi-segment `/v1/...` paths):
  - `GET/HEAD /{slug}` → `redirectFn` (explicit static routes `/healthz`, `/readyz` take precedence; those exact strings are rejected at slug-creation time as reserved).
  - `/v1/*` → `apiFn` (static prefixes always win over the path-parameter route).
  - `/*` otherwise → JSON 404 envelope (no frontend exists).
- API Gateway: managed scaling (no action required); Fastify schemas are the single validation source; access-log format **excludes client IP** (§6.5); gateway-level throttling remains the coarse backstop (application-level enforcement is AD-7's sliding window).

### 3.2 Redirect service (`redirectFn`)

Flow for `GET /{slug}`:

1. Validate slug shape (3–50, strict `[a-zA-Z0-9]` per AD-8); reject → JSON 404.
2. **Cache lookup (Tier-1 LRU, AD-1)**: keyed by slug → `{destination, state, expiresAt, cachedAt}`. Positive TTL 60s; **negative TTL 30s** (protects RDS from scanners without masking new creations beyond 30s). Tier-2 CDN does **not** exist in this design. **Correctness on hit (§13-c4):** a cached *active* entry whose `expiresAt` is non-null and `<= now()` is treated as **Expired immediately** (410) — the TTL never extends a link past its expiry.
3. On miss: indexed lookup via RDS Proxy (`SELECT destination_url, state …`), budgeted ≤ 20ms p95.
4. State resolution:
   - **Active** → **302** (AD-1) with `Location: destination` and **`Cache-Control: no-store`** (AD-1: accurate origin counts).
   - **Expired** (`expires_at <= now()`) → `410 Gone`, JSON envelope (FR-4.2).
   - **Unknown / deleted** → `404`, JSON envelope (FR-4.3). Negative-cached 30s.
5. **Country resolution (AD-2 — Option B):** transient, request-time GeoIP lookup inside the handler — the source IP is taken from the request context, resolved to an ISO-3166-1 alpha-2 code **in memory**, and only the code leaves the resolver. The IP is **never persisted, never logged, never placed in queue messages**; lookup failure → `'ZZ'` unknown sentinel — keys are never NULL (§13-c3) (best-effort, does not affect the redirect). Runs on every request (cache hit included) — in-process lookup costs microseconds; no edge layer involved.
6. **Click emission (best-effort, non-blocking):** for active redirects, send `{eventId (ULID), linkId, referrerHost (normalized host only), countryCode, day}` to SQS — `eventId` is the dedup key that yields exactly-once aggregation effects despite at-least-once delivery (§13-c1). Failure here **never blocks or fails the redirect** (NFR-3 outranks analytics completeness); failures surface via metric + DLQ alarm. No IP/PII in the message (FR-4.4, NFR-4).
7. Structured log line (no visitor IP — §6.5) + metrics/traces.

### 3.3 API service (`apiFn`) — middleware chain

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
- **health**: `/healthz` (liveness, no dependencies), `/readyz` (`SELECT 1` through RDS Proxy + queue check).

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
7. TTL = 24 hours (architect-set); `maintenanceFn` deletes expired records daily.

Postgres over Redis/Dynamo: durability across container recycling, transactional coupling with the link insert (**now a single transaction**), one fewer system (NFR-7).

### 3.6 Aggregator (`aggregatorFn`) — **dedup-aware (amended §13-c1)**

- SQS batch (≤100) → **dedup gate:** `INSERT INTO click_event_dedup (event_id) ON CONFLICT DO NOTHING` per message; conflicting (already-counted) eventIds — duplicate deliveries, redriven batches, consumer retries — are **excluded from counting**. The redirect path still performs **zero** per-click DB writes; dedup lives entirely in this transaction.
- Survivors → `GROUP BY link_id, day, referrer_host` / `GROUP BY link_id, day, country_code` → bulk `INSERT … ON CONFLICT DO UPDATE SET count = count + EXCLUDED.count` + `UPDATE links SET click_count = click_count + $n` — **all in one transaction per batch → exactly-once counting effects despite at-least-once delivery** (standard queue retained; FIFO not required).
- Also maintains the **all-time `referrer_totals` / `country_totals`** incrementally in the same transaction (AD-10: totals are permanent; buckets are 30-day working data).
- **Privacy:** dedup rows are bare ULIDs — no link/referrer/country/timestamp payload, therefore not click-event records; purged at **7 days** by `maintenanceFn` (well inside FR-5.2(c)'s 30-day ceiling); queue retention 48h bounds the redelivery horizon. CI privacy gate covers the table's columns (§6.5).
- Orphaned linkIds (link deleted between enqueue and consume) → dedup row recorded, aggregates skipped + metric (deletion wins, FR-5.3).
- Partial batch failure → SQS redelivers the batch; already-counted eventIds dedup on reprocessing; exhausted retries → **DLQ** (alarm §8.5).

### 3.7 Maintenance (`maintenanceFn`, EventBridge Scheduler)

| Job | Schedule | Action |
|---|---|---|
| Idempotency GC | daily | Delete `idempotency_records` older than 24h |
| Dedup GC | daily | Delete `click_event_dedup` rows older than **7 days** (§13-c1) |
| Aggregate purge | daily | Delete **daily buckets older than 30 days** — all-time totals untouched (AD-10: conservative lifetime confirmed; no downsampling, AD-9) |
| Rate-limit hygiene | hourly | Delete expired window rows |
| Tombstone audit | daily | Log reservation volume; **never release `released_at`** (AD-5: slugs locked FCFS permanently in this phase; column retained solely as an extension point, always NULL) |

### 3.8 Email (FR-1.2, AD-14)

Standard **double opt-in**: verification link with single-use, expiring token (hashed at rest) via SES; local dev swaps to SMTP (MailHog) via env config. A5 confirmed.

### 3.9 External dependencies & implementation boundaries

| Dependency | Used by | Boundary |
|---|---|---|
| **Google OIDC / GitHub OAuth only** (AD-14) | auth module | Outbound HTTPS (NAT egress); no additional providers in MVP |
| SES | email module | Outbound; SMTP-swappable locally |
| **CaptchaProvider** (mode `suspicious`, AD-3) | create flow | Interface + trigger policy shipped; **concrete vendor open — §10.8**; provider injected by config, not compiled in |
| **GeoIP database** (transient resolver, AD-2) | redirectFn | In-process file (Lambda layer / local path); **vendor/license open — §10.9**; returns country code only |
| RDS + RDS Proxy | all functions | Private subnets, Multi-AZ (A1 confirmed), TLS required |
| SQS | redirectFn (produce), aggregator (consume) | Gateway VPC endpoint; DLQ alarm |
| Secrets Manager | cold-start fetch (DB creds, JWT key, OAuth clients, CAPTCHA secret) | Interface VPC endpoints; cached per container, never in env/logs |
| Module boundaries | `auth`, `links`, `analytics`, `qr`, `geo`, `platform` (db, config, observability) | Domain modules import nothing from Lambda/API Gateway → local run + unit tests without cloud emulation |

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
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()    -- purged at 7 days (maintenanceFn)
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
| 1M links × (~250B row + slug index) | ≈ **300–500 MB** — trivial for RDS; slug B-tree stays in memory |
| 10k users + API keys/refresh tokens | ≈ tens of MB |
| Analytics: buckets bounded by active links × days × distinct referrers/countries (≤250 countries); buckets purged at 30 days; totals = distinct (link, referrer) pairs | Steady-state low GB worst case; **no unbounded growth** |
| Counts | `BIGINT` un-capped — no downsampling/rollup caps (AD-9); overflow not a practical concern (max 9.2×10¹⁸) |
| Writes | Redirect path does **zero** per-click DB writes (SQS batched upserts) |

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
- **Tier-2 CDN explicitly excluded** — no CloudFront/CDN in front of API Gateway (reinforced by AD-2 and AD-7). Any future proposal to add one is a new human decision.
- The 301 alternative and CDN-invalidation design are retired (recorded in §11 for audit).

### 5.4 QR (FR-6 — AD-15 resolved)

`qrcode.toBuffer(shortUrl, {type:'png'})` / `qrcode.toString(shortUrl, {type:'svg'})`; `?format=` query parameter selects output; ownership check identical to analytics. **Payload = short URL confirmed; styling/options out of scope.**

---

## 6. Security

### 6.1 Authentication & authorization (FR-1.3, NFR-5)

- **JWT:** signed with key from Secrets Manager, 15-min expiry, `sub`/`iat`/`jti`; refresh tokens hashed, rotating with reuse-detection (reuse → revoke family).
- **API keys:** `usk_<8-char prefix>_<32-byte secret>`; store prefix + SHA-256(full key); constant-time verify; plaintext shown once; revocable.
- **Email verification gate** enforced inside the links service (not just middleware) — no code path creates links for unverified users (FR-1.2).
- **Ownership:** SQL predicates (`user_id = $principal`) on every link-scoped read/update/delete/QR/analytics query (FR-3.2).
- **Anonymous creation forbidden** on `POST /v1/links` (AD-4) → unauthenticated attempt returns `401 UNAUTHENTICATED`; `links.user_id NOT NULL` enforces it at the data layer too.

### 6.2 Secrets management

Secrets Manager for DB credentials (RDS Proxy consumes the same secret), JWT signing key, OAuth client secrets, CAPTCHA secret; fetched at cold start, cached per container, never logged, rotation supported (JWT key IDs for overlap). Local dev reads a gitignored `.env` through the same config interface.

### 6.3 Network

RDS + RDS Proxy in **private subnets** (Multi-AZ confirmed per A1/AD-11); Lambdas in private subnets (VPC); TLS required to Postgres (`sslmode=verify-full`); VPC endpoints for SQS/Secrets Manager/CloudWatch/X-Ray; NAT for SES/OAuth/CAPTCHA egress. No public DB endpoint.

### 6.4 Input & output protection

- Destination URL: scheme allowlist `http/https` only (blocks `javascript:`/`data:` redirect XSS), parse-validated, length-capped (2048).
- Slug: strict `^[a-zA-Z0-9]{3,50}$` shared by API validator, DB CHECK, and route guard (AD-8); reserved words (`healthz`, `readyz`) rejected.
- All SQL parameterized; Fastify JSON Schema rejects unknown/oversized bodies.
- Open-redirect abuse is inherent to the product; designated mitigations are rate limiting + risk-triggered CAPTCHA (FR-2.7, AD-3/AD-7) — no destination allowlist invented.
- Minimal stack traces in responses (full error correlated by `requestId` in logs).

### 6.5 Privacy (FR-5.2, NFR-4) — enforced in code paths

- **No visitor IP is ever stored:** application logs exclude IP; API Gateway access-log format omits `clientIp`; SQS click messages carry no IP; no analytics column exists for IP (CI schema-review gate fails on any `ip`/`user_agent`-like column).
- **GeoIP (AD-2):** the source IP exists only as a transient in-memory argument to the resolver; only the ISO country code is emitted (queue message, aggregates, logs). The resolver never writes to any store; privacy-regression test asserts this (§7).
- Referrer stored as **host only** (query strings stripped — they often carry tokens/PII).
- Aggregate-only persistence: no raw event table exists (D-8/AD-10); daily buckets purged at 30 days; all-time totals are counts, kept indefinitely (AD-10).

### 6.6 Abuse controls (FR-8, FR-2.7 — AD-3/AD-7 resolved)

- **Sliding-window limiter:** 100 req/min per `user:`/`api:key` subject, applied pre-handler on `/v1/*`; `429` + `Retry-After`. Uniform baseline (A4 confirmed; Q3: no tiers in MVP; subject-keyed policy rows retain a future extension point).
- **Anonymous/redirect traffic is not application-rate-limited** (AM-4 closed by AD-7's scope: in-app `user:`/`apikey:` subjects only; CloudFront/WAF explicitly rejected). Gateway-level throttling remains the coarse backstop.
- **CAPTCHA:** `CaptchaProvider` interface, **mode `suspicious`** (AD-3) — only risk-triggered creations are challenged (risk inputs in §3.4 step 4). Concrete vendor open (§10.8).

---

## 7. Testing Strategy

| Layer | Scope | Tooling |
|---|---|---|
| Unit | Slug entropy + strict charset (AD-8), suggestion generation (3 availability-checked), idempotency state machine, sliding-window math, error-envelope shape, URL validator, referrer host normalization, risk-evaluator thresholds (AD-3) | Vitest, 90% line-coverage gate on `auth`/`links` |
| Integration | Migrations on real Postgres; create→collide→409+3-suggestions; idempotent replay incl. concurrent race; redirect states (302/`no-store`, 410, 404); anonymous `POST /links` → 401 (AD-4); delete cascades | Testcontainers (or docker-compose PG) |
| Crash & dedup (§13 review) | Fault injection: kill mid-create → retry same `Idempotency-Key` → exactly one link, no stuck record (§3.5/c2); duplicate SQS `eventId` replay → counts increment once (§3.6/c1); expired link on cache hit → 410 immediately (§3.2/c4); `'ZZ'` country never NULL in keys (§4.1/c3) | Testcontainers + consumer-replay harness |
| Contract | Fastify JSON Schemas ↔ generated OpenAPI; consumer response validation | `@fastify/swagger` + snapshots |
| Privacy regression | Static schema check (no IP/PII columns), log-shape assertion (no `clientIp`), SQS message allowlist, **GeoIP resolver: assert IP not persisted anywhere** (AD-2) | CI lint rule |
| CAPTCHA behavior | `suspicious` mode: clean requests pass without challenge; risk-flagged requests require valid token (AD-3) | Unit + integration |
| Load/perf | Redirect p95 vs §9.1 budgets on seeded 1M-link DB; burst to concurrency caps; cache hit-rate (informs §10.1) | k6 in staging |
| E2E (staging) | AC-01…AC-13 happy paths incl. observability smoke (health, log line, metric, trace) | GitHub Actions nightly |
| Resilience | RDS failover/proxy blip → 5xx + `/readyz` red; DLQ path; aggregator retry | Staging fault injection |

QA (Pam) owns formal QA execution; this section defines engineering verification and CI gates.

---

## 8. Observability (FR-10, NFR-8)

### 8.1 Tooling decision (FR-10.6)

**pino + OpenTelemetry everywhere; CloudWatch + X-Ray in AWS; dockerized Jaeger + stdout locally.** One instrumentation codebase for cloud and local; no SaaS dependency; OTel mandated by FR-10.4; CloudWatch alarms cover "basic alerting."

### 8.2 Structured logging (FR-10.1)

One JSON line per request: `timestamp, level, requestId, traceId, route, method, status, durationMs, principal (type+id, no tokens), outcome (redirect: active|expired|unknown, cache: hit|miss, country: resolved|none), errorCode?`. **No visitor IP, no destination query strings, no credentials** (pino redact list on `authorization`, `set-cookie`).

### 8.3 Metrics (FR-10.3)

`http.server.requests` (count + duration histogram + errors by route/status); `redirect.requests{result,cache}` → redirect volume; `links.created{kind}`; `auth.failures{reason}` (incl. `anon_create_rejected` — AD-4); `ratelimit.rejected{subject_type}`; `captcha.challenged` / `captcha.failed` (AD-3); `geo.resolved` / `geo.miss` (AD-2); `click.messages.enqueued/failed`; `sqs.depth`; `dlq.depth`; `idempotency.replays`; RDS/RDS-Proxy metrics via CloudWatch.

### 8.4 Tracing (FR-10.4)

OTel auto-instrumentation (HTTP, `pg`, SQS, GeoIP resolver span) → ADOT → X-Ray in AWS; OTLP → Jaeger locally (AC-FR-10.4). Sampling: 10% prod (100% on error), 100% local. Span links connect redirect → click message → aggregation.

### 8.5 Health & alerting (FR-10.2, FR-10.5)

- `/healthz` liveness (no deps); `/readyz` readiness (DB via proxy) — unauthenticated, minimal detail.
- Alarms → SNS → email/Slack: (1) 5xx rate >1%/5min; (2) redirect p95 over budget 10min; (3) `/readyz` failure ×2; (4) **DLQ depth > 0**; (5) aggregator lag > 5min; (6) RDS Proxy connections > 80%; (7) maintenance job failure.

---

## 9. Scalability & Performance

### 9.1 Latency budgets (NFR-1 — Architect-set; **stand per AD-11/A1 confirmation**)

| Path | p50 | p95 | p99 |
|---|---|---|---|
| Redirect, warm, cache hit | ≤ 30 ms | ≤ 60 ms | ≤ 120 ms |
| Redirect, warm, cache miss (DB lookup) | ≤ 50 ms | ≤ 120 ms | ≤ 250 ms |
| Redirect, cold start (amortized allowance) | — | — | ≤ 1,000 ms |
| Authenticated API mutations | ≤ 150 ms | ≤ 500 ms | ≤ 1,000 ms |
| Analytics read / QR generation | ≤ 200 ms | ≤ 600 ms | ≤ 1,200 ms |

Measured at the Lambda handler boundary (API GW adds ~5–15ms; in-process GeoIP adds <1ms). DB lookup sub-budget: ≤ 20ms p95. Availability target: **99.9% monthly** for the redirect path (NFR-3, A1 confirmed Multi-AZ). Levers if budgets miss: Tier-1 cache tuning, `redirectFn` memory bump, provisioned concurrency (cost trade-off — measure first). **Excluded by decision:** Tier-2 CDN (AD-1), edge/CloudFront layers (AD-2, AD-7).

### 9.2 Scale posture (NFR-2)

1M links ≈ 300–500MB (§4.4) — storage is a non-issue; pressure points are redirect QPS and connection churn, addressed by Tier-1 cache (hot slugs skip DB), RDS Proxy (multiplexing), batched SQS aggregation (no per-click writes), reserved concurrency caps (tuned by load test).

### 9.3 Availability (NFR-3)

- **Multi-AZ RDS confirmed (A1/AD-11)** → 99.9% target and §9.1 budgets stand.
- Two independent entry functions; SQS decouples redirect availability from analytics; DLQ preserves failures; health endpoints + alarms; forward-only migrations with staging soak and human approval gate; rollback = redeploy previous artifact.

### 9.4 Connection-exhaustion analysis (serverless × PostgreSQL)

Risk: functions burst to hundreds/thousands of concurrent executions; naive pooling exceeds RDS `max_connections`; failover connection storms can crash the DB.

Mitigations (all part of the approved design):

1. **RDS Proxy**: multiplexes many invocations onto fewer DB connections, pins sessions, re-routes on failover, authenticates via Secrets Manager (rotation-safe).
2. Small per-container pool (`pg.Pool` max = **2**, `statement_timeout` 5s, `idle_timeout` 10s).
3. **Reserved concurrency caps** (initial `redirectFn` 500 / `apiFn` 200) bound worst-case demand; worst-case proxy connections stay well under instance `max_connections` with headroom; alarm at 80% (§8.5).
4. Tier-1 cache removes the majority of DB round-trips.
5. Fail-fast: pool acquire timeout → `503` JSON + alarm, never pile-up.

Local dev connects directly (no proxy) — the pool abstraction is the seam.

### 9.5 API Gateway & scaling

HTTP API scales managed; account concurrency + per-function reserved concurrency are the real ceilings; gateway throttling backstop for runaway principals. **Edge rate-limiting (CloudFront/WAF) explicitly rejected (AD-7)** — revisiting it would be a new human decision. No CDN in front (AD-1/AD-2).

### 9.6 CI/CD & deployment

GitHub Actions: `lint → unit/integration → contract → build (esbundle) → cdk synth → deploy staging → migrate + smoke (AC set) → **manual approval** → prod`. Migrations run as an idempotent pipeline step before traffic shift. Rollback = redeploy previous image (migrations forward-only). No approval gate bypassed.

---

## 10. Open Architectural Questions

Technical items not settled by AD-1…AD-15; none block starting implementation except §10.8 for a live CAPTCHA path:

1. **Cache-tier sufficiency** — does in-process LRU hit-rate meet DB-load/latency targets at realistic QPS? Gate: k6 load test. (Tier-2 CDN excluded by AD-1; a shared *application-layer* cache such as ElastiCache would still preserve origin-count accuracy and would be a separate, new decision if needed.)
2. **Lambda memory / provisioned-concurrency tuning** — benchmark for cost/latency optimum on `redirectFn` before buying provisioned concurrency.
3. **RDS Proxy pool sizing** — final `max_connections` vs reserved-concurrency numbers need staging measurement against the confirmed instance class.
4. **FR-3.1 "delete/disable" wording** — single `DELETE` endpoint satisfies AC-FR-3.1 as written; confirm whether a reversible "disable" state is intended (additive `disabled_at`). Minor; routed to Michael.
5. **QR response caching** — ETag caching if the QR endpoint sees notable traffic (correctness unaffected).
6. **Custom-domain readiness (NFR-9)** — schema is domain-agnostic today (no domain column; future composite unique key) and routing is single-domain; extension point documented, no MVP work.
7. **Disaster recovery specifics** — A1/AD-11 confirm Multi-AZ; backup cadence/RPO/RTO remain externally owned — confirm language before finalizing DR claims.
8. **CAPTCHA provider vendor** (Q5's vendor half — mode resolved by AD-3, vendor not named): the `CaptchaProvider` interface and `suspicious` trigger ship regardless, but a concrete adapter (e.g., Turnstile / hCaptcha / reCAPTCHA) must be selected before FR-2.7 exercises a live challenge. **Needs human/vendor decision — see §11 still-open list.**
9. **GeoIP database vendor/license** for AD-2 Option B (e.g., MaxMind GeoLite2 requires an account/EULA; alternatives exist). Affects the Lambda layer and local-dev file provisioning only; schema and flow are unaffected.

---

## 11. Unresolved Architectural Decisions — RESOLUTION LOG

> This section was created as *Unresolved Architectural Decisions*. **All 15 items were resolved by the human decision-maker (Michael) on 2026-10-12.** The original blocking item, options, and the recorded resolution are kept below for audit. Nothing here was decided by the Architect. Residual items that still need input are listed in §11.2 (and §10).

### 11.1 Resolutions (all complete)

| # | Decision (originally blocked by) | Options that were on the table | **Resolution (human, 2026-10-12)** | Requirements |
|---|---|---|---|---|
| **AD-1** | Redirect caching / **Q8** | 302 branch vs 301 branch (+CDN) | **302 branch.** Unconditional Tier-1 in-process LRU; `Cache-Control: no-store`; **Tier-2 CDN not included/configured** — accurate origin counts required. | FR-4.1/4.4, AC-05, NFR-1 |
| **AD-2** | Country ingestion / **Q4** | A: CloudFront viewer-country header · B: transient request-time GeoIP | **Option B.** In-process GeoIP module inside `redirectFn`; in-memory only, never persisted; **no CDN/CloudFront edge in front of API Gateway.** | FR-5.1/5.2, AC-09, NFR-4 |
| **AD-3** | CAPTCHA wiring / **Q5** | mode `always` vs `suspicious`; provider pluggable | **Pluggable `CaptchaProvider`, mode = `suspicious`** — challenge risk-triggered creates only, not every create. *(Provider vendor still open — §11.2, §10.8.)* | FR-2.7, AC-FR-2.7, AC-11 |
| **AD-4** | Anonymous create / **Q10**, A6 | Branch 1: auth required · Branch 2: anonymous allowed | **Branch 1.** `POST /v1/links` requires authentication; anonymous → **401**; `links.user_id NOT NULL`; A6 becomes moot. | FR-2.7, FR-1.2 |
| **AD-5** | Slug reservation release / **Q1** | never release vs grace-period reclaim | **MVP: never release** tombstones; slugs locked first-come-first-served permanently; `released_at` retained (always NULL) only as an extension point. | FR-2.4, AC-03 |
| **AD-6** | PATCH field set / **Q2** | destinationUrl only vs also expiresAt | **`destinationUrl` only** — `expiresAt` not mutable this phase. | FR-2.6, FR-3.1 |
| **AD-7** | Rate-limit scope / **Q3, A4, AM-4** | in-app (Postgres) vs CloudFront/WAF; tiers vs uniform | **In-app Postgres sliding window** for `user:`/`apikey:` subjects at the uniform 100 req/min baseline (A4 confirmed; Q3 closed for MVP — no tiers; subject-policy extension retained). **No CloudFront/WAF rate rules**; anonymous redirect traffic not app-limited (AM-4 closed). | FR-8.1–8.3, AC-11 |
| **AD-8** | Slug charset & suggestions / **AM-1, AM-5** | strict `[a-zA-Z0-9]` vs allow `-`; suggestion count | **Strict `[a-zA-Z0-9]`** enforced in app validator **and** DB CHECK (no hyphens); collision → **409 with 3 availability-checked alternatives** in the body. | FR-2.3/2.4, AC-03 |
| **AD-9** | Click-count precision / **Q9** | caps/downsampling vs plain BIGINT | **Un-capped `BIGINT` totals** alongside daily buckets; **no downsampling or maintenance caps** for target volume. | FR-5.1/5.2, AC-09 |
| **AD-10** | Aggregate lifetime / **AM-3, A3** | conservative vs alternative readings | **Conservative reading confirmed.** Raw events never stored; daily analytic buckets **purged after 30 days**; all-time totals kept **indefinitely**; A3 (per-link aggregates, not per-click logs) confirmed. | FR-5.1/5.2, NFR-4, A3 |
| **AD-11** | HA / performance claims / **A1** | confirm vs qualify | **A1 confirmed** — adequately provisioned, **Multi-AZ** RDS instance assumed. §9.1 latency budgets and **99.9% availability target stand**. | FR-9.2, NFR-2/3/7 |
| **AD-12** | Platform confirmation / **A2** | AWS Lambda + HTTP API vs alternatives | **Confirmed: AWS Lambda + API Gateway HTTP API inside the VPC**; dual-entrypoint portability pattern maintained. | FR-9.1/9.3, A2 |
| **AD-13** | Account deletion / **A7** | hard-delete cascade vs soft delete | **Confirmed: hard-delete cascade** with standard transactional FK constraints. | FR-1.4, FR-5.3, AC-13 |
| **AD-14** | OAuth providers & email / **Q6, A5** | provider set; verification semantics | **Ship exclusively Google + GitHub adapters**; **standard double opt-in** email verification enforced. | FR-1.1/1.2, AC-01, A5 |
| **AD-15** | QR payload & styling / **Q7** | payload confirm; styling scope | **Payload = short URL**; **`?format=` query parameter** (png\|svg); **styling options out of scope.** | FR-6.1/6.2, AC-10 |

### 11.2 Still open (not covered by the 15 resolutions)

| Item | Nature | Impact | Owner |
|---|---|---|---|
| CAPTCHA **provider vendor** (Q5's vendor half) | Dependency choice — interface/mode resolved by AD-3, vendor never named | FR-2.7 cannot exercise a live challenge until an adapter target is chosen (§10.8) | Human (Michael) |
| FR-3.1 **"delete/disable" wording** (§10.4) | Minor product clarification | Endpoint already satisfies AC-FR-3.1; reversible disable would be additive | Human (Michael) |
| GeoIP **database vendor/license** (§10.9) | Dependency choice for AD-2 Option B | Lambda layer + local file provisioning only | Human/Developer |
| **AM-2** (PRD footer says "draft" while header says "Approved") | Documentation inconsistency, reported not resolved | None on architecture; PRD is immutable to this artifact | Human (Jim flagged originally) |
| **requirements.md §8 markers now stale** | Its `[PENDING …]` flags predate the 2026-10-12 resolutions | Spec artifact should be regenerated to reflect AD-1…AD-15 — **Jim (author) only; this artifact did not modify it** | Jim / Michael |

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
| FR-2.7 (rate limit + CAPTCHA) | §3.4 steps 1/4, §6.6 · **[RESOLVED AD-3: suspicious-mode; AD-4: auth required; AD-7: in-app limiter]** · vendor open §10.8 |
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
| FR-9.1 (serverless) | §1.2, D-1, D-15 · **[RESOLVED AD-12]** |
| FR-9.2 (RDS Postgres) | §4, §9.4, D-4 · **[RESOLVED AD-11: A1 Multi-AZ confirmed]** |
| FR-9.3 (local dev) | §1.2, D-2, D-3, §7 · **[RESOLVED AD-12: dual entrypoint retained]** |
| FR-10.1 (JSON logs) | §8.2 · final |
| FR-10.2 (health) | §3.3 health, §8.5 · final |
| FR-10.3 (metrics) | §8.3 · final |
| FR-10.4 (OTel tracing) | §8.4 · final |
| FR-10.5 (alerting) | §8.5 · final |
| FR-10.6 (lightweight/local tools) | §8.1 · final |
| NFR-1 (latency budgets) | §9.1 — **stand per AD-11**; redirect = 302/no-store per AD-1 |
| NFR-2 (scale) | §4.4, §9.2 · final |
| NFR-3 (availability) | §9.3, §8.5 — **99.9% stands per AD-11** |
| NFR-4 (privacy) | §6.5, D-8/D-14 · **[RESOLVED AD-2, AD-10]** |
| NFR-5 (security) | §6.1, §6.6 · **[RESOLVED AD-3, AD-4, AD-7]** |
| NFR-6 (data lifecycle) | §4.2, §3.7 · **[RESOLVED AD-13, AD-5]** |
| NFR-7 (portability/local) | §1.3, D-2, D-3, §8.1 · **[RESOLVED AD-12]** |
| NFR-8 (observability) | §8.1–8.5 · final |
| NFR-9 (custom domains later) | §10.6 · final |
| AC-01…AC-13 | AC-03 → AD-8/AD-5 · AC-05 → AD-1 · AC-09 → AD-2/AD-9/AD-10 · AC-10 → AD-15 · AC-11 → AD-3/AD-7 · AC-13 → AD-13 — **all formerly gated ACs now have resolved inputs** |
| Readiness review (2026-10-13) | §13 — corrections **c1–c4** applied (FR-2.5, FR-4.2, FR-4.4, FR-5.1, FR-5.2, schema §4.1); escalation **E1** open (cache-immediacy windows) · tickets URL-7/8/11/13/14 + foundation bootstrap ticket |

---

## 13. Readiness Review — Corrections & Escalations (2026-10-13)

> Implementation-readiness review commissioned by Michael (orchestrator). Findings **B1–B4** were evaluated against this design. Corrections **c1–c4** are accepted architecture amendments, incorporated inline in the sections referenced below; this section is the durable audit record. Items requiring a product/human decision are isolated in **§13.3 ESCALATIONS** and were **not** decided by the Architect. No product requirement was invented, altered, or resolved by this review. Traceability updated in §12. Jira touched: new foundation/bootstrap ticket **URL-18** (created — bootstrap-coverage gaps), description/AC updates to **URL-7, URL-8, URL-11, URL-13, URL-14**, Blocks links URL-18 → URL-7/URL-8. Full audit: `specs/url-shortener-api/readiness-audit.md`.

### 13.1 Findings & accepted corrections

| # | Finding (B-numbering from the review brief) | Verdict | Evidence before amendment | Correction (accepted) | Inline amended | Tickets |
|---|---|---|---|---|---|---|
| **c1 (B1)** | SQS standard at-least-once delivery can deliver click events more than once → analytics double-counted | **REAL DEFECT** | old §3.6: batches upserted with no per-event dedup key; old §1.2 message carried no event identity | ULID `eventId` added to the click message (§3.2 step 6, §1.2); `click_event_dedup(event_id PK, created_at)` inserted `ON CONFLICT DO NOTHING` **in the same transaction** as the aggregate upserts → exactly-once *counting effects* on a standard queue (FIFO not required); partial-batch redeliveries and consumer retries dedup on reprocess; dedup rows are bare ULIDs — no link/referrer/country/timestamp payload (privacy-compliant: purged at 7 days ≪ FR-5.2(c) 30-day ceiling; queue retention 48h bounds redelivery) | §1.2, §3.2, §3.6, §3.7, §4.1, D-8, §7, §12 | URL-13 (emit `eventId`), URL-14 (dedup gate + purge), URL-8 (table) |
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
- **Option C — shared cache + invalidation**: an ElastiCache-class Tier-1.5 with mutation-published invalidation (new infra + cost; §10.1 already framed any shared cache as a separate human decision).

Pending this decision, URL-13 implements exactly what AD-1 approved (60s/30s TTLs as specified) plus the c4 in-memory expiry fix; Option C must not be implemented without a new human decision.

Related still-open items unchanged: §10.8 (CAPTCHA vendor), §10.9 (GeoIP vendor/license), §10.4 (FR-3.1 delete/disable wording — interacts with E1(a)), AM-2 and requirements.md stale markers (Jim).

---

*Produced by the Architect; revised 2026-10-12 to incorporate human resolutions AD-1…AD-15; readiness-reviewed 2026-10-13 (§13: corrections c1–c4 accepted and applied inline, escalation E1 open). PRD.md and requirements.md were read but not modified (requirements.md §8 markers are stale pending regeneration by its author, Jim). Jira implementation tickets were created on explicit instruction (2026-10-12): Epic **URL-6** with URL-7…URL-17 in project URL, all assigned to the human project owner with Agent Owner set per squad policy, dependency-linked per §9/§3 implementation order; the 2026-10-13 readiness review added foundation ticket **URL-18** and updated URL-7/8/11/13/14 (authoritative record: `readiness-audit.md`). Implementation of application features is the Developer's responsibility; this artifact defines the architecture and its decision state, not the code.*

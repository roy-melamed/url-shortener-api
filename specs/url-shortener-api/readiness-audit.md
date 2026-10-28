# Implementation Readiness Audit — URL Shortener API

| Field | Value |
|---|---|
| **Artifact** | `specs/url-shortener-api/readiness-audit.md` |
| **Date** | 2026-10-13 |
| **Author** | Dwight Schrute — Architect & Code Reviewer |
| **Requested by** | Michael (orchestrator) — implementation readiness review |
| **Inputs reviewed** | `specs/url-shortener-api/design.md` (revised 2026-10-12), Jira project **URL**, Epic **URL-6**, tickets **URL-7…URL-17** (descriptions/AC as of 2026-10-13) |
| **Ground truth verified** | Project is **greenfield**: no git repository, no package.json, no tsconfig, no docker-compose, no .env.example, no source code |
| **Hard constraints honored** | No developers spawned · no git branches created · no application code written · PRD.md and requirements.md unmodified · all Jira issues remain assigned to **Roy Melamed** (`70121:29771871-918e-4058-959a-76f07cb45530`) · Agent Owner field (`customfield_10043`) preserved (Developer = 10024 on tickets) |
| **Outputs** | design.md §13 (corrections c1–c4 + escalation E1) · new ticket **URL-18** · updated tickets **URL-7, URL-8, URL-11, URL-13, URL-14** · Blocks links URL-18 → URL-7, URL-18 → URL-8 · this audit |

---

## 1. Coverage matrix — 11 bootstrap responsibilities vs URL-7…URL-17

"Initial" = state before this audit. "Final" = after the actions taken (columns: owning ticket(s) + what covers it).

| # | Responsibility | Initial verdict | Evidence (ticket + exact scope/AC line) | Action taken | Final |
|---|---|---|---|---|---|
| 1 | Initialize the application repository and project directory | **MISSING** | No ticket mentions repo/git/directory init. URL-7 scope presumes an existing project ("TypeScript (strict) + Fastify skeleton…") | **Created URL-18** (git init, .gitignore, .editorconfig at /home/roy/projects/ai-squad; PRD/specs untouched) | COVERED — URL-18 |
| 2 | Initialize Node.js, TypeScript and Fastify | **PARTIAL** | URL-7: "TypeScript (strict) + Fastify skeleton with **dual entrypoint**" — Fastify/TS explicit; package.json/tsconfig/npm initialization stated nowhere | Split ownership: URL-18 (package.json + strict tsconfig, Node 22) ; URL-7 keeps the Fastify dual-entrypoint skeleton ("built on the URL-18 baseline" added) | COVERED — URL-18 + URL-7 |
| 3 | Install and configure the necessary dependencies | **MISSING** | Libs named piecemeal across tickets (pg implied URL-8; openid-client implied URL-9; qrcode implied URL-15; pino implied URL-16); no ticket owns installing/pinning a baseline set | **URL-18** owns baseline install/pin (fastify, aws-lambda-fastify, pg, node-pg-migrate, pino, dotenv+zod, qrcode, openid-client, vitest, supertest, eslint, prettier); feature libs stay with owning tickets | COVERED — URL-18 |
| 4 | Define and create the initial project folder structure | **MISSING** | design.md §3.9 defines module boundaries (`auth`, `links`, `analytics`, `qr`, `geo`, `platform`); no ticket creates them | **URL-18** (src/{…}, migrations/, infra/, tests/{unit,integration,contract}; lint rule: domain modules import no cloud SDK) | COVERED — URL-18 |
| 5 | Configure package.json scripts for dev/build/test/run | **PARTIAL** | URL-7 AC: "Local `npm run dev` serves the app…" and pipeline "lint → unit/integration → build" imply scripts; nothing defines them | **URL-18** defines dev/build/start/test/lint/format/typecheck/migrate; **URL-7 improved** with AC "All package.json scripts from the baseline (dev, build, start, test, lint, typecheck) function locally and in CI" | COVERED — URL-18 (defines) + URL-7 (validates in app/CI) |
| 6 | Set up local PostgreSQL using Docker Compose | **COVERED** | URL-7 scope: "docker-compose dev env: PostgreSQL, Jaeger, MailHog, local geo DB file (FR-9.3/NFR-7)" + AC "npm run dev serves the app against compose Postgres" | None (no duplication) | COVERED — URL-7 |
| 7 | Configure database connection settings, environment variables and .env.example | **PARTIAL** | URL-7: "Secrets/config module (env interface identical local vs cloud)"; URL-8: pool config. **`.env.example` and the env-var inventory existed nowhere** | **URL-18** owns `.env.example` + complete env-var inventory; **URL-7 improved** (endpoints/secrets from env + Secrets Manager — **never hardcoded**); **URL-8 improved** (env-specific connection sourcing) | COVERED — URL-18 (contract) + URL-7 + URL-8 |
| 8 | Set up database migrations and the initial schema | **COVERED** | URL-8 scope: "Migrations for all §4.1 tables…" + AC "migrations apply cleanly to local Postgres" | Amended in place with readiness corrections c1 (`click_event_dedup`), c2 (state comment), c3 (`'ZZ'` NOT NULL CHECK) — §4 below | COVERED — URL-8 |
| 9 | Document how to install, run and test the application locally | **MISSING** | No documentation scope in any of URL-7…URL-17 | **URL-18** (README: install, `compose up → migrate → dev`, test per design §7) | COVERED — URL-18 |
| 10 | Configure initial testing, linting and CI infrastructure | **PARTIAL** | URL-7 pipeline explicit ("GitHub Actions: lint → typecheck → … → human approval gate") — CI covered; **lint/test tool configs never established anywhere** | **URL-18** owns tool configs (eslint, prettier, vitest + 90% coverage gate on auth/links per design §7); **URL-7 improved** (CI executes those configs; "no merge without green lint + tests") | COVERED — URL-18 (configs) + URL-7 (pipeline) |
| 11 | Establish AWS RDS connectivity via RDS Proxy — WHERE endpoints/secrets come from (env-specific, never hardcoded) | **PARTIAL** | URL-7: "RDS Proxy config against existing RDS (no DB creation)" + "Secrets Manager"; URL-8: "RDS Proxy-aware endpoint" — the **sourcing rule** (env-specific, never hardcoded, local vs deployed) was not explicit | **URL-8 improved**: explicit bullet — local = compose URL from `.env` (URL-18 template); deployed = RDS Proxy endpoint + Secrets Manager refs at cold start; AC "no DB endpoint/credential literal in committed code/config; deployed connections exclusively via RDS Proxy". **URL-7 improved**: same never-hardcoded rule for the config module | COVERED — URL-8 (primary) + URL-7 |

**Net result:** 4 MISSING + 5 PARTIAL initially → all COVERED after 1 new foundation ticket + 5 ticket improvements. No responsibility is covered by more than one *defining* owner (partials share define/validate roles explicitly).

---

## 2. Tickets updated (before → after)

All five kept **assignee = Roy Melamed** (verified in edit responses) and **Agent Owner = Developer** (field untouched).

### URL-7 — Scaffolding, compose, CDK & CI/CD
- **Before:** assumed a scaffolded project; secrets/config module line had no sourcing rule; no script/lint/test-config ownership.
- **After:** note that the workspace baseline is owned by **URL-18** (which blocks URL-7); secrets bullet → "**every endpoint and secret resolved from environment variables locally and Secrets Manager in cloud — never hardcoded**"; CI bullet → lint → **typecheck** → …, executes URL-18's tooling, "no merge without green lint + tests"; ACs +baseline scripts functional, +no literals committed.

### URL-8 — Schema, migrations & connection layer
- **Before:** §4.1 tables as of 2026-10-12 (nullable `country_code`, no dedup table); no env-sourcing rule.
- **After:** + readiness-review schema updates: **c1** `click_event_dedup(event_id TEXT PK, created_at)` (+privacy-gate coverage); **c3** `country_code CHAR(2) NOT NULL DEFAULT 'ZZ' CHECK (~ '^[A-Z]{2}$')` on `country_buckets_daily`/`country_totals`; **c2** `state` CHECK kept, only `'completed'` written; + env-specific/never-hardcoded connection sourcing bullet; ACs +static check (no endpoint/credential literal; deployed via RDS Proxy only), +dedup semantics testability.

### URL-11 — Link creation (idempotency)
- **Before:** "`Idempotency-Key` state machine (§3.5): in_progress/completed, replay stored response…".
- **After:** rewritten to **c2 single-transaction** semantics: idempotency insert → slug reservation → link insert → response capture in **one ACID transaction**; conflict detected before any `links` write; crash ⇒ clean rollback (no partial row, no stuck record); persisted `in_progress` eliminated; AC +**crash-recovery fault-injection criterion** (kill mid-create → retry same key → exactly one link, original response replayed).

### URL-13 — Redirect service
- **Before:** cache `{destination, state}` with TTLs; GeoIP failure → NULL country; emission `{linkId, referrerHost, countryCode, day}`.
- **After:** cache entries carry `expiresAt`/`cachedAt` + **in-memory expiry on hit (c4)** — expired → 410 immediately; GeoIP failure → **`'ZZ'` sentinel, never NULL (c3)**; emission adds **ULID `eventId` (c1)**; +⚠ **Escalation E1** warning (implement AD-1 TTLs exactly; no shared cache without a new human decision); ACs +expired-from-warm-cache 410, +eventId/no-PII message shape.

### URL-14 — Analytics (aggregator, purge, reads)
- **Before:** "SQS batch ≤100 → GROUP BY upserts…" — no dedup; country reads expose raw codes.
- **After:** +**dedup gate** (`click_event_dedup` `ON CONFLICT DO NOTHING`, duplicates excluded, one transaction per batch — **c1**); orphaned linkIds record dedup before skipping; maintenance +**dedup GC 7 days**; analytics read +`'ZZ'` → `country: null` / label `unknown` (**c3**); ACs +**duplicate-delivery replay test** (same batch → counts once), +sentinel never leaks, +dedup purge.

---

## 3. New tickets created

| Key | Type | Summary | Parent | Assignee | Agent Owner |
|---|---|---|---|---|---|
| **URL-18** (id 10027) | Task | Foundation bootstrap: repository & project init, folder structure, dependency manifest, scripts, env contract & local dev docs | URL-6 | Roy Melamed | Developer (10024) |

**Why no duplicate:** every one of the 11 responsibilities was audited against the *exact* scope/AC text of URL-7…URL-17 (fetched from Jira 2026-10-13). Responsibilities 1/3/4/9 had **no owning text anywhere** — URL-7's "scaffolding" presumes an already-initialized project (verified greenfield). URL-18 owns only the workspace baseline; URL-7 retains app skeleton/compose/CDK/CI and URL-8 retains schema/migrations/pool — the partial responsibilities (2/5/7/10/11) were **improved in place** in their existing tickets rather than duplicated (per audit rule). New Blocks links: **URL-18 blocks URL-7**, **URL-18 blocks URL-8** (foundational work precedes dependents).

---

## 4. Findings B1–B4 (architectural correctness)

Design.md amended inline; **§13** was added as the durable corrections/escalations record with traceability updates in §12. No PRD/requirement was modified; no product question was decided by the Architect.

### B1 — SQS at-least-once delivery double-counts clicks
- **Verdict: REAL DEFECT.** Old §3.6 aggregated batches with no per-event identity; standard-queue redelivery (partial batch failure, consumer retry, DLQ redrive) inflates counts.
- **Correction (c1 — accepted):** ULID **`eventId`** in the click message (§3.2 step 6, §1.2); new table **`click_event_dedup(event_id TEXT PK, created_at)`** inserted `ON CONFLICT DO NOTHING` **in the same transaction** as the aggregate upserts → exactly-once *counting effects* on a standard queue (FIFO not required and not adopted). Dedup rows are bare ULIDs — no link/referrer/country/timestamp payload → not click-event records; purged at **7 days** (inside FR-5.2(c)'s 30-day ceiling; queue retention 48h bounds redelivery). Redirect path still does zero per-click DB writes.
- **design.md sections:** §1.2, §3.2, §3.6, §3.7, §4.1 (table), D-8, §7 (replay test), §12. **Tickets:** URL-13, URL-14, URL-8.

### B2 — Idempotent create lacked transaction boundaries / crash recovery
- **Verdict: REAL DEFECT.** Old §3.5 wrote `in_progress` → link → `completed` as separate statements: a crash between phases could leave a partial link row and a record stuck `in_progress`, blocking same-key replays for up to 24h and, after GC, risking a duplicate link.
- **Correction (c2 — accepted):** **single ACID transaction** covering idempotency insert → slug reservation → link insert → response capture → COMMIT (§3.5); conflict detected at the idempotency insert *before* any `links` write; crash ⇒ automatic rollback ⇒ clean retry (no recovery job); persisted `in_progress` **eliminated** — a racing loser waits on the winner's unique insert (PostgreSQL speculative insertion), rolls back, re-reads, replays the committed response; slug retry loop re-issues the whole transaction.
- **design.md sections:** §3.5 (rewritten), §4.1 (state comment), D-7, §7 (fault-injection test), §12. **Tickets:** URL-11, URL-8.

### B3 — Nullable `country_code` in composite keys (NULLs are not equal)
- **Verdict: REAL DEFECT.** Old §4.1 put nullable `country_code` inside `PRIMARY KEY (link_id, day, country_code)` and `(link_id, country_code)`: NULLs never compare equal, so `ON CONFLICT DO UPDATE` silently misses and every unresolved-country upsert inserts a **new duplicate row**.
- **Correction (c3 — accepted):** sentinel **`'ZZ'`** (ISO 3166-1 user-assigned "unknown") — `country_code CHAR(2) NOT NULL DEFAULT 'ZZ' CHECK (country_code ~ '^[A-Z]{2}$')` on both tables; resolver failure emits `'ZZ'` (§3.2 step 5), never NULL; API surfaces `'ZZ'` as `country: null` with label `unknown` (§4.3); no PII added (code only, AD-2 intact). Migrations remain non-destructive (pre-launch empty tables).
- **design.md sections:** §3.2, §4.1, §4.3, D-14, §12. **Tickets:** URL-8, URL-13, URL-14.

### B4 — Tier-1 cache staleness (stale destination / deleted / expired served as active)
- **Verdict: REAL DEFECT (expired leg) — split treatment.**
  - **Expired served as active until TTL → corrected (c4, accepted):** cache entries carry `expiresAt`; on hit, expiry is evaluated **in memory** → 410 immediately regardless of remaining TTL (§3.2 step 2). Purely technical; no product input needed.
  - **Stale destination on edit (≤60s) → ALREADY HANDLED / NOT A DEFECT:** the documented, AD-1-approved trade-off (D-9/§5.3); `no-store` keeps origin counts accurate — a cache hit never fabricates or drops a click.
  - **Deleted-as-active window (≤60s) + negative-cache creation window (≤30s) → ESCALATED (E1, §5 below):** AC-FR-3.1 implies immediate effect; AD-1 approved unconditional TTLs. This tension is product-visible → **not decided by the Architect**.
- **design.md sections:** §3.2, §13. **Tickets:** URL-13 (+E1 pending).

---

## 5. ESCALATIONS — human input required

### E1 (NEW, from B4) — Redirect cache immediacy windows
- **Conflict:** AD-1 (human, 2026-10-12) approves an unconditional Tier-1 LRU (60s positive / 30s negative); AC-FR-3.1 implies a deleted link stops resolving "as an active link" *immediately*; a newly created slug may 404 for up to 30s.
- **Product-visible legs:** (a) deleted/disabled link may still 302 for ≤60s (incl. account-cascade deletes); (b) new slug may 404 ≤30s (negative cache); (c) edit propagation ≤60s (already accepted under AD-1 — confirm as intended).
- **Options:** **A** accept bounded windows (optionally shorten TTLs, e.g. 15s/10s; document AC tolerance "within cache TTL"); **B** strict immediacy — drop positive/negative state caching (every redirect hits DB; §9.1 miss budget still met; §9.2 loses its main DB-load lever → revisit §10.1 under load); **C** shared cache + mutation-published invalidation (ElastiCache-class; new infra/cost — §10.1 already framed any shared cache as a separate human decision).
- **Interim state:** URL-13 implements exactly what AD-1 approved (60s/30s) + the c4 expiry fix; Option C must not be implemented without a new human decision. **Owner: Michael (human).** Interacts with §10.4 (FR-3.1 "delete/disable" wording).
- **Non-escalations considered:** B1's dedup-token retention (bare ULIDs ≤7d < FR-5.2(c) 30-day ceiling → compliant, no product input); B2/B3 are purely technical.

### Carried over (pre-existing, unchanged by this review)
| Item | Where | Owner |
|---|---|---|
| CAPTCHA provider **vendor** (mode/interface resolved by AD-3) | design §10.8, §11.2 | Human (Michael) |
| GeoIP **database vendor/license** (AD-2 Option B) | design §10.9, §11.2 | Human/Developer |
| FR-3.1 **"delete/disable" wording** | design §10.4, §11.2 — interacts with E1(a) | Human (Michael) |
| **AM-2** PRD footer "draft" vs header "Approved" | design §11.2 — PRD immutable to this artifact | Human |
| **requirements.md §8 stale `[PENDING]` markers** | design header note, §11.2 — regeneration by its author only | Jim / Michael |

---

## 6. Recommended implementation start order (dependency-honoring)

Current Blocks topology (14 links; ↦ = blocks): URL-18 ↦ {URL-7, URL-8}; URL-7 ↦ {URL-8, URL-16}; URL-8 ↦ {URL-9, URL-10}; URL-9 ↦ URL-11; URL-10 ↦ URL-11; URL-11 ↦ {URL-12, URL-13, URL-15}; URL-13 ↦ {URL-14, URL-17}; URL-14 ↦ URL-17.

| Wave | Tickets | Rationale |
|---|---|---|
| **0** | **URL-18** | No blockers; every other ticket needs the workspace baseline (repo, package/tsconfig, scripts, .env.example, tooling configs) |
| **1** | **URL-7** | After URL-18: app skeleton, compose, CDK, CI pipeline |
| **2** | **URL-8** | After URL-18 + URL-7: schema/migrations/connection layer (incl. c1/c2/c3 schema) |
| **3** | **URL-9 ∥ URL-10** (parallel) | After URL-8: auth and rate-limit/CAPTCHA are independent |
| **4** | **URL-11** | After URL-9 + URL-10: create-flow needs auth + gates (c2 transactional create) |
| **5** | **URL-12 ∥ URL-13 ∥ URL-15** (parallel); **URL-16** may start after URL-7 and integrate through waves 3–5 | After URL-11: management, redirect (c1/c3/c4), QR are independent; observability spans all functions |
| **6** | **URL-14** (after URL-13); **URL-17** (after URL-13 + URL-14) | Analytics consumes URL-13's message shape (`eventId`, `'ZZ'`); perf validation is the final gate |
| **Note** | E1 pending decision does **not** block URL-13 (implements AD-1 as approved) | CAPTCHA vendor (§10.8) blocks only a *live* challenge path, not URL-10's interface/mode delivery |

---

*Produced by the Architect (Dwight Schrute), 2026-10-13. PRD.md and requirements.md were read but not modified. No application code, branches, or developers were involved. All Jira issues remain assigned to Roy Melamed; Agent Owner values preserved per squad policy.*

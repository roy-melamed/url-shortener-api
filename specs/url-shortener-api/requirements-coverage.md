# Requirements Coverage Validation — URL Shortener API (Epic URL-6)

| Field | Value |
|---|---|
| **Artifact** | `specs/url-shortener-api/requirements-coverage.md` |
| **Date** | 2026-10-25 |
| **Author** | Jim Halpert — Specification Agent |
| **Requested by** | Michael (orchestrator) — Jira backlog audit, epic URL-6 (requirements-coverage half; Dwight owns ticket-quality half in parallel) |
| **Phase** | **PHASE 1 — ANALYSIS ONLY.** No Jira comments, edits, transitions, or new tickets were made. Jira was read only. |
| **Sources of truth (read-only)** | `PRD.md` (Approved, 2026-10-08, immutable) · `specs/url-shortener-api/requirements.md` (reconciled 2026-10-13) · `specs/url-shortener-api/design.md` (readiness-reviewed 2026-10-13) |
| **Jira snapshot** | cloudId `0c5094a2-d4b5-4b73-96c5-762cc36e5f50` · project `URL` · epic **URL-6** · tickets **URL-7 … URL-18** (12) · all status **To Do**, all parented to URL-6 · descriptions fetched 2026-10-25 · ticket comments: only 2, both on URL-18 (dependency-order notes; no requirement content) |
| **Files modified** | This artifact only. `PRD.md`, `requirements.md`, `design.md` untouched. |

**Ticket legend:** URL-7 scaffolding/CDK/CI · URL-8 schema & migrations · URL-9 accounts/auth · URL-10 rate limit & CAPTCHA · URL-11 link creation · URL-12 link management · URL-13 redirect service · URL-14 analytics · URL-15 QR · URL-16 observability · URL-17 performance & scale · URL-18 foundation bootstrap.

---

## 0. Method & status definitions

Enumerated from `requirements.md`: all `FR-*` incl. sub-IDs (§5), all `NFR-*` (§6), all acceptance criteria (`AC-FR-*`, `AC-NFR-*`, `AC-01…AC-13`), and the decision IDs the document ties to acceptance (`AD-1…AD-15` via §8.0/§7; `D-9` — the only `D-*` ID that appears in `requirements.md`, in §8.5/E1). Coverage was judged from ticket **description scope + Acceptance text** (implemented **and** verified).

| Status | Meaning |
|---|---|
| **COVERED** | ≥1 ticket claims the ID (or its exact content) in scope **and** states an acceptance/verification for it (an equivalent AC in another ticket counts; noted). |
| **PARTIAL** | Implementation is addressed by ≥1 ticket, but verification is missing/incomplete, or an open human decision prevents full verification. |
| **UNCOVERED (GAP)** | No ticket addresses the ID in scope or acceptance. |

---

## 1. Coverage matrix

### 1.1 Functional requirements — FR-* (38)

| ID | Requirement (short) | Ticket(s) | Status | Notes |
|---|---|---|---|---|
| FR-1.1 | Register email/password + Google/GitHub (AD-14) | URL-9 | COVERED | Cites FR-1.1, AC-FR-1.1, AC-01. |
| FR-1.2 | Email verification required before link creation | URL-9, URL-11 | COVERED | URL-9 double opt-in (AD-14); URL-11 enforces the 403 `EMAIL_NOT_VERIFIED` gate on create. |
| FR-1.3 | Dual auth: API keys + JWT | URL-9 | COVERED | Middleware resolves `Bearer <jwt>` vs `Bearer usk_…`; AC-FR-1.3 in cited range. |
| FR-1.4 | Account deletion → links + analytics (hard cascade, AD-13) | URL-9, URL-8 | COVERED | AC-FR-1.4 cited; URL-8 owns the cascade test. |
| FR-2.1 | `POST /links` creates a link from destination URL | URL-11 | COVERED | AC-FR-2.1 cited. E1(b) negative-cache 404 window is an open escalation (URL-13 owns the cache). |
| FR-2.2 | Auto-generated short code, `[a-zA-Z0-9]` | URL-11 | COVERED | 7-char base62 + retry; AC-FR-2.2 within cited range. |
| FR-2.3 | Custom slug 3–50, strict `[a-zA-Z0-9]` (AD-8) | URL-11, URL-8 | COVERED | App validator + DB CHECK both enforce. §8.5 #1 (hyphen conflict) still open — see §3/§6. |
| FR-2.4 | Collision → 409 + 3 availability-checked alternatives; tombstones never released (AD-8/AD-5) | URL-11, URL-8, URL-14 | COVERED | URL-8 acceptance: "no slug is released"; URL-14: tombstone audit. |
| FR-2.5 | `Idempotency-Key` replay, no duplicates | URL-11 | COVERED | Amended c2 single-transaction + crash-injection AC; AC-04 cited. |
| FR-2.6 | Expiration: permanent default, optional at creation, immutable after (AD-6) | URL-11, URL-12 | COVERED | `expiresAt` not settable via PATCH (URL-11/URL-12 agree). |
| FR-2.7 | Abuse prevention: rate limit + CAPTCHA on create; authenticated-only (AD-3/AD-4/AD-7) | URL-10, URL-11 | **PARTIAL** | Interface, `suspicious` mode, dummy adapter + 429 path ship; **live CAPTCHA vendor open (Q5)** — URL-10 explicitly defers the real adapter. Anonymous→401 in URL-11 (AD-4). |
| FR-3.1 | List, retrieve, edit destination, delete/disable own links | URL-12 | **PARTIAL** | Delete-only implemented. Two open human items attach: delete-vs-disable wording (§8.5 #4) and immediacy vs E1 (URL-13's ≤60s deleted-as-active). |
| FR-3.2 | Ownership checks; non-owner → authorization error | URL-12, URL-14, URL-15 | COVERED | SQL predicate `user_id = $principal`; cited by 3 tickets. |
| FR-3.3 | Single-resource only, no bulk endpoints | URL-12 | COVERED | AC-FR-3.3 cited. |
| FR-4.1 | Active → fast redirect, no interstitial, **302 + `no-store`** (AD-1) | URL-13 | COVERED | E1(c) edit-propagation ≤60s to be "confirmed as intended". |
| FR-4.2 | Expired → `410 Gone` JSON body | URL-13 | COVERED | Plus c4 in-memory expiry on warm cache. |
| FR-4.3 | Unknown/deleted → `404 Not Found` JSON body | URL-13 | COVERED | AC-07 cited. |
| FR-4.4 | Increment aggregate click count; no visitor IP/PII | URL-13, URL-14, URL-8 | COVERED | Emission (eventId, no IP) → dedup gate → aggregates; privacy regression tests in URL-13/URL-14. |
| FR-5.1 | Analytics read: total clicks, referrer, country breakdown | URL-14, URL-13 | COVERED | Endpoint in URL-14; transient GeoIP in URL-13 (AD-2). **GeoIP DB vendor/license still open** (§8.5 #3). |
| FR-5.2 | Privacy: no IP/PII, aggregates only, ≤30-day events | URL-13, URL-14, URL-8 | COVERED | CI privacy gate (URL-8), 30-day purge (URL-14), no-IP regression (URL-13). Dedup rows = bare ULIDs @7d (within 30-day ceiling). |
| FR-5.3 | Delete links + associated analytics | URL-12 (implements), URL-8, URL-14 | COVERED | See AC-FR-5.3 note: verification ownership is split (URL-12 implements but omits the AC). |
| FR-6.1 | QR code for the requesting user's own links | URL-15 | COVERED | Ownership check identical to analytics. |
| FR-6.2 | QR as PNG and SVG; payload = short URL; no styling (AD-15) | URL-15 | COVERED | `?format=png|svg`, default png. |
| FR-7.1 | Full REST API: accounts, links, analytics, QR | — (implicit: URL-9/11/12/13/14/15) | **PARTIAL** | **No ticket claims FR-7.1**; no endpoint-inventory/contract verification anywhere. |
| FR-7.2 | All errors JSON with consistent machine-readable shape | URL-7 (+ URL-11 codes) | COVERED | URL-7 scope + AC "conform to §5.1 envelope (404 example)". |
| FR-7.3 | JSON where a body is returned; redirect status for active links | URL-7, URL-13 | COVERED | Verified via AC-05/AC-06/AC-07 (AC-FR-7.3 ID itself not cited). |
| FR-8.1 | Per-user rate limit, baseline 100 req/min per user/key | URL-10 | COVERED | AC-FR-8.1 cited; `user:`/`apikey:` subjects. |
| FR-8.2 | `429` + retry guidance | URL-10 | COVERED | `Retry-After` + `RateLimit-*`; AC-FR-8.2 cited. |
| FR-8.3 | No tiers in MVP (uniform); anonymous/redirect traffic not app-limited (AD-7) | URL-10 | COVERED | Scope states uniform 100 req/min + subject scoping, "No CloudFront/WAF"; ticket cites `FR-8` generically, not `FR-8.3`. |
| FR-9.1 | Serverless deployment | URL-7 | COVERED | CDK: HTTP API + 4 Lambdas (AD-12). |
| FR-9.2 | Data in existing PostgreSQL on AWS RDS (AD-11) | URL-8 | COVERED | RDS Proxy-only deployed connections; no DB created. |
| FR-9.3 | Lightweight, runs against local PostgreSQL (AD-12) | URL-7, URL-18 | COVERED | compose Postgres + dual entrypoint + fresh-checkout AC. |
| FR-10.1 | Structured JSON logging for all requests | URL-16, URL-7 | COVERED | pino scaffold in URL-7, full spec in URL-16. |
| FR-10.2 | Health check endpoint(s) | URL-16, URL-7 | COVERED | `/healthz` + `/readyz`. |
| FR-10.3 | Metrics: request rate, latency, error rate, redirects | URL-16 | COVERED | §8.3 catalog incl. `redirect.requests{result,cache}`. |
| FR-10.4 | OpenTelemetry distributed tracing | URL-16 | COVERED | Cloud: X-Ray/ADOT; local: Jaeger. |
| FR-10.5 | Basic error alerting | URL-16 | **PARTIAL** | Implemented (CloudWatch alarms → SNS) but **no acceptance verifies alerting** — URL-16's only AC is AC-12, which excludes alerting. |
| FR-10.6 | Monitoring lightweight/local-dev friendly; Architect picks tools | URL-16, URL-18 | COVERED | Stated in URL-16 scope; local parity verified indirectly (AC-12, URL-18). |

### 1.2 FR acceptance criteria — AC-FR-* (38)

| ID | AC (short) | Ticket(s) | Status | Notes |
|---|---|---|---|---|
| AC-FR-1.1 | New account created in unverified state | URL-9 | COVERED | Cited explicitly. |
| AC-FR-1.2 | Unverified `POST /links` rejected, no link; verified succeeds | URL-9, URL-11 | COVERED | Cited (range) + gate implemented in URL-11. |
| AC-FR-1.3 | Valid API key / JWT accepted; invalid/missing rejected | URL-9 | COVERED | Cited (range). |
| AC-FR-1.4 | Account delete removes account + links + analytics | URL-9, URL-8 | COVERED | URL-8 cascade test is the concrete verification. |
| AC-FR-2.1 | Create with destination only → short code + short URL | URL-11 | COVERED | E1(b) exception (new slug may 404 ≤30s) is **not verified by any ticket** — escalated. |
| AC-FR-2.2 | Auto code contains only `[a-zA-Z0-9]` | URL-11 | COVERED | Within cited range. |
| AC-FR-2.3 | Valid 3–50 strict slug created; `-` rejected | URL-11, URL-8 | COVERED | Consistent AD-8 application; §8.5 #1 conflict open (see §3 C1). |
| AC-FR-2.4 | Taken slug (incl. expired/deleted) rejected + suggestions | URL-11 | COVERED | 409 + 3 alternatives. |
| AC-FR-2.5 | Same `Idempotency-Key` replay → original result, no duplicate | URL-11 | COVERED | Plus crash-recovery fault-injection AC. |
| AC-FR-2.6 | Permanent default; `expiresAt` immutable after creation | URL-11 | COVERED | Within cited range. |
| AC-FR-2.7 | Rate-limit/CAPTCHA failure blocks create (`429` for rate limit) | URL-10 | COVERED | Content verified by URL-10 acceptance lines (">100 req/min → 429"; "risk-flagged create → CAPTCHA required"); **ID not cited by any ticket**; CAPTCHA leg only with dummy adapter (vendor open). |
| AC-FR-3.1 | Owner edit persists; after delete/disable redirects no longer resolve as active | URL-12 | **PARTIAL** | Cited by URL-12, but URL-13 implements ≤60s deleted-as-active + ≤30s negative cache (E1 open); delete-vs-disable wording open. |
| AC-FR-3.2 | Non-owner modify rejected, no change | URL-12 | COVERED | Cited. |
| AC-FR-3.3 | No endpoint mutates >1 resource per call | URL-12 | COVERED | Cited. |
| AC-FR-4.1 | Active `GET /{shortCode}` → 302, no interstitial | URL-13 | COVERED | Verified via AC-05 (ID not cited). |
| AC-FR-4.2 | Expired → 410 + JSON | URL-13 | COVERED | Verified via AC-06 + warm-cache 410 AC (ID not cited). |
| AC-FR-4.3 | Unknown/deleted → 404 + JSON | URL-13 | COVERED | Verified via AC-07 (ID not cited). |
| AC-FR-4.4 | Redirect increments count; no visitor IP/PII stored | URL-13, URL-14 | COVERED | Message-shape + privacy regression (URL-13), count increments (URL-14). |
| AC-FR-5.1 | Analytics returns total, referrer, country | URL-14 | COVERED | Cited. |
| AC-FR-5.2a | Never store visitor IP/PII; aggregates only | URL-14, URL-13 | COVERED | Cited + privacy regression. |
| AC-FR-5.2b | Click events purged within 30 days | URL-14 | COVERED | Cited; `maintenanceFn` purge >30d. |
| AC-FR-5.3 | Deleting a link deletes its analytics | URL-14 (cites), URL-12 (implements) | **PARTIAL** | **No concrete test stated:** URL-14 cites the AC but its scope only covers orphaned-linkId handling; URL-12 owns the cascade but omits AC-FR-5.3 from its Acceptance list. |
| AC-FR-6.1 | Owner QR encodes the short URL | URL-15 | COVERED | Cited (payload = short URL per AD-15). |
| AC-FR-6.2 | QR endpoint supports PNG and SVG | URL-15 | COVERED | Cited. |
| AC-FR-6.3 | Non-owner QR request → authorization error | URL-15 | COVERED | Cited. |
| AC-FR-7.1 | Endpoints for registration/verification/deletion, link CRUD, analytics reads, QR | — | **UNCOVERED (GAP)** | No ticket claims FR-7.1/AC-FR-7.1; no endpoint-inventory or contract test is stated anywhere. |
| AC-FR-7.2 | Every error uses one consistent JSON error schema | URL-7 | COVERED | Verified by URL-7 acceptance ("§5.1 envelope"); ID not cited. |
| AC-FR-7.3 | 404/410/body-bearing statuses JSON; active → redirect status | URL-7, URL-13 | COVERED | Verified via AC-05/06/07; ID not cited. |
| AC-FR-8.1 | >100 req/min in 1-min window → 429 + retry guidance | URL-10 | COVERED | Cited. |
| AC-FR-8.2 | Within baseline → served normally | URL-10 | COVERED | Cited. |
| AC-FR-9.1 | Runs on serverless, no long-lived server | URL-7 | COVERED | Verified by staging deploy + smoke; ID not cited. |
| AC-FR-9.2 | All persistent data in AWS RDS PostgreSQL | URL-8 | COVERED | Verified by RDS-Proxy-only/static checks; ID not cited. |
| AC-FR-9.3 | Developer can run locally vs local PostgreSQL | URL-7, URL-18 | COVERED | Fresh-checkout AC + compose Postgres. |
| AC-FR-10.1 | Every request produces a structured JSON log entry | URL-16 | COVERED | Verified via AC-12; ID not cited. |
| AC-FR-10.2 | Health endpoint responds when healthy | URL-16, URL-7 | COVERED | Verified via AC-12 + URL-7 `/healthz` AC. |
| AC-FR-10.3 | Metrics for rate, latency, error rate, redirects | URL-16 | COVERED | Verified via AC-12. |
| AC-FR-10.4 | Traces via OpenTelemetry, works in local dev | URL-16 | COVERED | Cited explicitly. |
| AC-FR-10.5 | System raises basic alerts on error conditions | URL-16 (implemented) | **PARTIAL** | Alarms→SNS in scope, but **no acceptance states how to verify** (AC-12 excludes alerting). |

### 1.3 Non-functional requirements — NFR-* (9)

| ID | Requirement (short) | Ticket(s) | Status | Notes |
|---|---|---|---|---|
| NFR-1 | Fast redirects, no interstitial; latency budgets by Architect | URL-13, URL-17 | COVERED | URL-17 runs k6 vs §9.1 budgets (AC-NFR-1). |
| NFR-2 | 10,000+ users, 1,000,000+ links | URL-17, URL-8 | COVERED | Seed 1M links/10k users (AC-NFR-2); URL-8 cites NFR-2 (scale math §4.4). |
| NFR-3 | High availability of redirect path; health checks | URL-17, URL-16, URL-13 | **PARTIAL** | Health checks covered (URL-16); **AC-NFR-3 cited by URL-17 but no availability verification method stated** (its scope = latency, cache hit-rate, connection math). |
| NFR-4 | No visitor IPs/PII; aggregates only; ≤30-day events | URL-13, URL-14, URL-8 | COVERED | CI privacy gate + regression tests + purge. |
| NFR-5 | Rate limit + CAPTCHA; verification gate; ownership; dual auth | URL-9, URL-10, URL-12 | COVERED | Cross-cutting; verified by the component ACs. **Note:** requirements.md defines **no AC-NFR-5**. |
| NFR-6 | Users can delete links + analytics at any time | URL-12, URL-8, URL-9 | COVERED | See AC-NFR-6 (analytics-removal leg lacks a stated test). |
| NFR-7 | Serverless-friendly; RDS Postgres; local-dev lightweight | URL-18, URL-7 | COVERED | Both cite NFR-7. |
| NFR-8 | JSON logs, metrics, health, OTel, alerting (FR-10) | URL-16 | COVERED | Cites NFR-8; AC-12 (alerting leg excluded — see FR-10.5). |
| NFR-9 | Single shared domain now; custom domains designed for v2 | — | **UNCOVERED (GAP)** | No ticket references NFR-9; design §10.6 documents the extension point and no MVP work is intended — needs Michael's confirmation that unimplemented/unverified is acceptable. |

### 1.4 NFR acceptance criteria — AC-NFR-* (5)

| ID | AC (short) | Ticket(s) | Status | Notes |
|---|---|---|---|---|
| AC-NFR-1 | Redirect, no interstitial; latency targets set by Architect | URL-17 | COVERED | Cited; budgets from design §9.1. |
| AC-NFR-2 | Operates at 10k users / 1M links | URL-17 | COVERED | Cited; seed + k6. |
| AC-NFR-3 | Health checks exposed + redirect path meets availability goals (99.9% per AD-11) | URL-17 | **PARTIAL** | Cited, but URL-17's scope states no availability/soak/failover verification — only latency budgets, cache tuning, connection math. |
| AC-NFR-4 | No store holds visitor IP/PII; events ≤30 days | URL-13, URL-14, URL-8 | COVERED | Equivalent verification stated (privacy regression, 30-day purge, schema privacy gate); ID not cited. |
| AC-NFR-6 | User can delete a link + its analytics at any time via API | URL-12, URL-14 | **PARTIAL** | Shares the AC-FR-5.3 gap: no ticket states a link-level analytics-deletion test (URL-8's cascade test is account-level; AC-08 covers deletion but not the analytics leg). ID not cited. |

*(No `AC-NFR-5`, `AC-NFR-7`, `AC-NFR-8`, `AC-NFR-9` exist in requirements.md — see §6 E11.)*

### 1.5 PRD acceptance criteria — AC-01 … AC-13 (13)

| ID | AC (short) | Ticket(s) | Status | Notes |
|---|---|---|---|---|
| AC-01 | Signup & verification flow | URL-9 | COVERED | Cited. |
| AC-02 | Create link, auto alphanumeric code | URL-11 | COVERED | Cited. |
| AC-03 | Custom slug `my-campaign` accepted; existing slug → rejection + suggestions | URL-11 | **PARTIAL** | Ticket cites AC-03 while implementing strict AD-8 charset — the PRD example `my-campaign` (contains `-`) is rejected. Contradiction **C1** (already open as requirements §8.5 #1). |
| AC-04 | Idempotency replay | URL-11 | COVERED | Cited. |
| AC-05 | Active → 301/302, no interstitial | URL-13 | COVERED | Cited; 302 per AD-1. |
| AC-06 | Expired → 410 + JSON | URL-13 | COVERED | Cited. |
| AC-07 | Unknown/deleted → 404 + JSON | URL-13 | COVERED | Cited. |
| AC-08 | Owner edits/deletes; non-owner authorization error | URL-12 | COVERED | Cited; delete/disable wording + E1 immediacy still open (notes on FR-3.1/AC-FR-3.1). |
| AC-09 | Analytics breakdowns; no IP/PII; ≤30-day retention | URL-14 | COVERED | Cited. |
| AC-10 | QR PNG + SVG for own link | URL-15 | COVERED | Cited. |
| AC-11 | >100 req/min → 429 with retry guidance; creation CAPTCHA-protected | URL-10 | **PARTIAL** | Rate-limit leg verified; CAPTCHA leg ships with interface + dummy adapter only — **vendor open (Q5)**, live challenge cannot be verified. |
| AC-12 | Health, JSON logs, metrics (4 domains), local tracing | URL-16 | COVERED | Cited. |
| AC-13 | Account deletion removes links + analytics | URL-9 (impl), URL-8 (cascade test) | COVERED | Content verified by URL-8's cascade test; **AC-13 ID not cited by any ticket**. |

### 1.6 Decision IDs tied to acceptance — AD-1…AD-15, D-9 (16)

| ID | Decision (short) | Ticket(s) | Status | Notes |
|---|---|---|---|---|
| AD-1 | 302 branch + `no-store`, Tier-1 LRU, no CDN | URL-13, URL-17 | COVERED | URL-17 explicitly: "No CDN/edge allowed". |
| AD-2 | Transient request-time GeoIP (Option B), IP never persisted | URL-13 | COVERED | Implementation covered; **GeoIP DB vendor/license open** (§8.5 #3) — provisioning only. |
| AD-3 | Pluggable `CaptchaProvider`, mode `suspicious` | URL-10 | **PARTIAL** | Interface + mode + dummy adapter; **vendor not selected** (design §10.8). |
| AD-4 | `POST /v1/links` requires auth; anonymous → 401 | URL-11 | COVERED | Explicit in scope. |
| AD-5 | Tombstone slugs never released | URL-8, URL-11, URL-14 | COVERED | Cascade/tombstone/audit across three tickets. |
| AD-6 | PATCH = `destinationUrl` only | URL-11, URL-12 | COVERED | Both tickets agree. |
| AD-7 | In-app Postgres sliding window, uniform 100/min, `user:`/`apikey:` only | URL-10 | COVERED | Explicit. |
| AD-8 | Strict `[a-zA-Z0-9]` + DB CHECK; 409 + 3 suggestions | URL-11, URL-8 | COVERED | Applied consistently; underlying AC-03 conflict remains open (C1/E1). |
| AD-9 | Un-capped `BIGINT` totals, no downsampling | URL-8, URL-14 | COVERED | `click_count BIGINT` + totals tables. |
| AD-10 | No raw events; 30-day buckets; totals indefinite | URL-8, URL-14 | COVERED | Explicit. |
| AD-11 | Multi-AZ RDS confirmed; budgets + 99.9% stand | URL-8, URL-17 | COVERED | Capacity/budgets covered; **99.9% availability leg unverifiable as scoped** (see AC-NFR-3). |
| AD-12 | AWS Lambda + API Gateway HTTP API; dual entrypoint | URL-7 | COVERED | Explicit. |
| AD-13 | Hard-delete cascade | URL-9, URL-8 | COVERED | Explicit + cascade test. |
| AD-14 | Google + GitHub only; double opt-in | URL-9 | COVERED | Explicit. |
| AD-15 | QR payload = short URL; `?format=`; no styling | URL-15 | COVERED | Explicit. |
| D-9 | Tier-1 LRU 60s/30s + `no-store`, no Tier-2 CDN (the only `D-*` in requirements.md — §8.5/E1) | URL-13 | COVERED | TTLs implemented exactly as approved; E1 legs (a)/(b) pending human decision. |

---

## 2. STATS

| Group | Total | COVERED | PARTIAL | UNCOVERED (GAP) |
|---|---|---|---|---|
| Functional requirements (FR-*) | 38 | 34 | 4 | 0 |
| FR acceptance criteria (AC-FR-*) | 38 | 34 | 3 | 1 |
| Non-functional requirements (NFR-*) | 9 | 7 | 1 | 1 |
| NFR acceptance criteria (AC-NFR-*) | 5 | 3 | 2 | 0 |
| PRD acceptance criteria (AC-01…AC-13) | 13 | 11 | 2 | 0 |
| Decision IDs tied to acceptance (AD-1…AD-15, D-9) | 16 | 15 | 1 | 0 |
| **TOTAL** | **119** | **104** | **13** | **2** |

**GAP list (verbatim):** `NFR-9`, `AC-FR-7.1`

**PARTIAL list (verbatim):** `FR-2.7`, `FR-3.1`, `FR-7.1`, `FR-10.5`, `AC-FR-3.1`, `AC-FR-5.3`, `AC-FR-10.5`, `NFR-3`, `AC-NFR-3`, `AC-NFR-6`, `AC-03`, `AC-11`, `AD-3`

**Ticket distribution (requirement IDs claimed in scope):** URL-16 (8) · URL-11 (11) · URL-13 (11) · URL-8 (10) · URL-14 (8) · URL-9 (6) · URL-10 (6) · URL-12 (6) · URL-15 (5) · URL-7 (5) · URL-17 (6) · URL-18 (2). No ticket is empty; no requirement is claimed by more than 3 tickets except the cross-cutting ones (FR-3.2, FR-5.2).

---

## 3. CONTRADICTIONS

**C1 — URL-11 vs requirements AC-03 / PRD AC-3 (slug charset).**
URL-11 claims `AC-03` in Acceptance while its scope enforces strict `^[a-zA-Z0-9]{3,50}$` (AD-8) with no hyphens. requirements.md §7 AC-03 records that the PRD's own example slug `my-campaign` contains `-` and would be rejected, flagged **[OPEN §8.5 #1]** (AD-8 of 2026-10-12 vs a prior "allow hyphen" ruling of 2026-10-11). The ticket text implies AC-03 is fully satisfiable as written; under AD-8 only the rejection+suggestions half is. *Status: not resolvable by agents — human decision pending (escalated, §6 E1).*

**C2 — URL-12 vs URL-13 (two tickets, one AC, divergent immediacy readings).**
URL-12 lists `AC-FR-3.1` ("after the owner deletes or disables the link, subsequent redirect requests shall no longer resolve as an active link") with no tolerance stated, while URL-13 implements (and states in scope) a positive cache TTL of 60s — a deleted link may still 302 for ≤60s (incl. account-cascade deletes) and a new slug may 404 for ≤30s, contrary to the literal AC-FR-2.1/AC-FR-3.1 readings. URL-13 labels this escalation **E1 (pending)**; URL-12 does not mention it at all. *Two tickets currently implement incompatible interpretations of the same acceptance criterion until the human rules on E1 (Options A/B/C).*

**C3 — URL-18 vs FR-4.1 / AC-FR-4.1 / AD-1 (redirect status configurability).**
URL-18's `.env.example` contract enumerates a `REDIRECT_STATUS` env var with placeholders only, while requirements FR-4.1/AC-FR-4.1 fix the decided default at **302** (`Cache-Control: no-store`, rationale: accurate origin click counts). design §5.3 keeps `REDIRECT_STATUS` "as config for operational flexibility; product default fixed at 302". *Risk: nothing in ticket text pins the value, so a deployment could set 301, silently violating AC-FR-4.1 and the origin-count rationale. Low severity; needs a wording ruling (§6 E13).*

**C4 — requirements.md vs requirements.md (requirement-internal, pre-existing, already open).**
AC-03's PRD example vs AD-8 strict charset — recorded in requirements §8.5 #1; surfaced here because a ticket (URL-11) has now claimed the AC. *No new contradiction; carried into escalations.*

**Considered and NOT contradictions (checked):** auto-slug base62 ⊂ `[a-zA-Z0-9]` (FR-2.2) ✓ · URL-11's 403 `EMAIL_NOT_VERIFIED` vs AC-FR-1.2's unspecified "error response" ✓ · `expiresAt` immutability consistent across URL-11/URL-12 (AD-6) ✓ · URL-14's 7-day dedup-token purge vs FR-5.2(c) 30-day ceiling (dedup rows are bare ULIDs, not click events) ✓ · URL-13's `'ZZ'` country sentinel surfaced as `country: null` vs FR-5.1 ✓ · URL-10's uniform 100 req/min vs FR-8.3 ✓ · 302 vs PRD's permitted 301/302 ✓.

---

## 4. INVALID REFERENCES

**Requirement/AC IDs cited by tickets that do not exist in requirements.md: NONE.**

Every `FR-*`, `NFR-*`, `AC-*`, and `AD-*` ID appearing in URL-7…URL-18 descriptions was checked against requirements.md — all are valid. Specifically verified:
- Ranges used in tickets — `AC-FR-1.1…AC-FR-1.4` (URL-9), `AC-FR-2.1…AC-FR-2.6` (URL-11) — resolve to real IDs.
- Suffixed ACs — `AC-FR-5.2a/b` (URL-14), `AC-FR-6.3` (URL-15), `AC-FR-10.4` (URL-16), `AC-NFR-1/2/3` (URL-17) — all exist.
- Design IDs cited under "**Design refs:**" (`D-1, D-2, D-3, D-4, D-5, D-6, D-7, D-9, D-10, D-11, D-12, D-15`, `AD-1…AD-15`) are **design.md** IDs, not requirement IDs, and all exist in design.md §2/§11. Note: requirements.md contains only one `D-*` ID (`D-9`, §8.5/E1); tickets cite `D-*` as design refs, which is legitimate.

**Reverse direction — requirement/AC IDs never cited by any ticket** (citation-quality issue, not invalid IDs):
`FR-7.1`, `FR-8.3` (cited only as `FR-8`), `FR-10.5`, `NFR-9`, `AC-FR-2.7`, `AC-FR-4.1`, `AC-FR-4.2`, `AC-FR-4.3`, `AC-FR-7.2`, `AC-FR-7.3`, `AC-FR-9.1`, `AC-FR-9.2`, `AC-FR-10.1`, `AC-FR-10.2`, `AC-FR-10.3`, `AC-FR-10.5`, `AC-NFR-4`, `AC-NFR-6`, `AC-13`.
Most are verified through an equivalent cited AC (see matrix notes); the ones with **no** equivalent verification are handled in §5.

---

## 5. Acceptance criteria in requirements.md with NO stated verification by any ticket

**(a) No ticket even claims them:**
1. **`AC-FR-7.1`** — "The API shall provide endpoints for account registration/verification/deletion, link CRUD, analytics reads, and QR code retrieval." The endpoints are built across URL-9/11/12/13/14/15, but no ticket claims FR-7.1 or states an endpoint-inventory/contract verification. → **GAP.**
2. **`AC-FR-10.5`** — "The system shall raise basic alerts on error conditions." URL-16 implements alarms→SNS, but its only Acceptance is AC-12, which (per PRD §9.12) covers health/logs/metrics/tracing and **excludes alerting**. → Implementation exists; verification statement missing.

**(b) Cited by a ticket, but the ticket states no method to verify:**
3. **`AC-NFR-3`** — cited by URL-17, whose scope verifies latency budgets (§9.1), cache hit-rate, and connection math — no availability/soak/failover verification for the 99.9% goal (AD-11) is described.
4. **`AC-FR-5.3`** — cited by URL-14 (scope covers only orphaned-linkId handling); the ticket that implements link-level analytics cascade (URL-12) omits this AC from its Acceptance list.
5. **`AC-NFR-6`** — same gap as AC-FR-5.3; never cited; AC-08 verifies deletion but not the analytics-removal leg.

**Also noted (implementation without verification statement):** `FR-10.5`/`AC-FR-10.5` (above), and the E1-affected exceptions inside `AC-FR-2.1` (30s negative-cache window) and `AC-FR-3.1` (≤60s deleted-as-active) — no ticket states how those exception windows would be tested pending the human ruling.

---

## 6. ESCALATIONS — human decision required (do NOT self-resolve)

Requirement-level and product ambiguities for **Michael**; no answers invented here. Verbatim, one per line:

- E1 — AM-1 / AC-03 slug-charset conflict (requirements.md §8.5 #1): design AD-8 strict `[a-zA-Z0-9]` (2026-10-12) vs the earlier "allow hyphen" ruling (2026-10-11); under AD-8 the PRD AC-3 example `my-campaign` is rejected — URL-11 claims AC-03 while implementing strict charset.
- E2 — CAPTCHA provider vendor (Q5 vendor half; requirements.md §8.5 #2, design §10.8): URL-10 ships the `CaptchaProvider` interface, `suspicious` mode and a dummy adapter only — AC-11 and the CAPTCHA leg of AC-FR-2.7 cannot be fully verified until a vendor is chosen.
- E3 — GeoIP database vendor/license for AD-2 Option B (requirements.md §8.5 #3, design §10.9): FR-5.1 country-breakdown provisioning — no ticket owns vendor selection (URL-18 only assumes a "local geo DB file").
- E4 — FR-3.1 "delete/disable" wording, delete-only vs reversible disable (requirements.md §8.5 #4, design §10.4): URL-12 implements delete-only; affects FR-3.1, AC-FR-3.1, AC-08.
- E5 — AM-2: PRD header states "Status: Approved" while the footer states "This PRD is a draft" (requirements.md §8.5 #5) — documentation only; PRD remains immutable.
- E6 — E1 redirect cache immediacy windows (requirements.md §8.5 #6, design §13.3): (a) deleted/disabled link may still 302 ≤60s vs AC-FR-3.1; (b) new slug may 404 ≤30s vs AC-FR-2.1; (c) edit propagation ≤60s to confirm as intended — URL-12 and URL-13 currently implement divergent readings (contradiction C2); Options A/B/C await the human ruling, Option C must not be implemented without a new decision.
- E7 — NFR-9 (custom domains deferred to v2) has no owning ticket and no acceptance criteria: confirm that leaving it unimplemented and unverified in MVP is acceptable (design §10.6 documents the extension point only).
- E8 — AC-FR-7.1 (full REST API surface) has no owning ticket and no verification: decide which ticket must own an endpoint-inventory / contract test (candidate owners: URL-7 scaffolding or URL-12 management).
- E9 — AC-FR-10.5 (basic error alerting) is implemented in URL-16's scope but excluded from its only acceptance criterion (AC-12): decide whether to add an alert-verification acceptance criterion to URL-16 (Jira edit = Phase 2).
- E10 — AC-NFR-3 / 99.9% availability (AD-11): URL-17 cites AC-NFR-3 but its scope verifies only latency budgets, cache tuning and connection math — decide what availability verification is required and in which ticket.
- E11 — requirements.md defines acceptance criteria AC-NFR-1…4 and AC-NFR-6 but none for NFR-5, NFR-7, NFR-9 (no AC-NFR-5/7/8/9): confirm whether new ACs are wanted; requirements.md may only be changed by its author under Michael's instruction.
- E12 — AC-FR-5.3 / AC-NFR-6 verification ownership: URL-12 implements "delete link → analytics cascade" but omits both ACs from its Acceptance list, while URL-14 cites AC-FR-5.3 without describing a deletion test — decide which ticket must state the verification (Jira edit = Phase 2).
- E13 — URL-18 lists a `REDIRECT_STATUS` environment variable with placeholders only, while FR-4.1/AC-FR-4.1/AD-1 fix the decided default at 302 (design §5.3 keeps it configurable "for operational flexibility"): confirm whether the knob must be pinned/documented as 302-only to protect AC-FR-4.1 and origin-count accuracy (contradiction C3).

---

## 7. Phase-1 compliance statement

- No Jira comments, edits, transitions, links, or issues were created or modified in this phase (Jira access was read-only: 1 JQL fetch of descriptions, 1 JQL fetch of comments).
- `PRD.md`, `specs/url-shortener-api/requirements.md`, and `specs/url-shortener-api/design.md` were read but not modified.
- No application code, tasks, or design artifacts were produced. This artifact contains requirements-coverage analysis only.
- All coverage verdicts are derived from ticket description/acceptance text as read on 2026-10-25; they are claims about ticket text, not about tested or working software.

*Produced by Jim Halpert, Specification Agent — 2026-10-25. Reported to Michael with total = 119, covered = 104, partial = 13, uncovered = 2 (`NFR-9`, `AC-FR-7.1`), 4 contradictions (C1–C4), and escalations E1–E13.*

---

# PHASE 2 VALIDATION (2026-10-25)

| Field | Value |
|---|---|
| **Author** | Jim Halpert — Specification Agent (requirements-coverage gate) |
| **Requested by** | Michael (orchestrator) — validate the Phase 2 improved backlog before implementation starts |
| **Phase** | **READ-ONLY JIRA.** Zero writes: no comments, no edits, no links, no transitions, no creates. |
| **Inputs** | `ticket-audit.md` read in full (§D.1 human rulings, §E executed, §F reconciliation, §G execution log) · this artifact (Phase 1) re-read · Jira epic URL-6 + all 20 children fetched 2026-10-25 (descriptions, issue links, comments, status/assignee/Agent Owner) |
| **Scope of check** | (1) 119-ID coverage re-derived · (2) Phase 1 PARTIAL resolution · (3) new contradictions / invalid refs · (4) 20-ticket × 5-attribute quality gate · (5) audit trail · (6) source-file integrity |
| **Status definitions** | Same as Phase 1 §0: **COVERED** = ticket claims the ID and states verification · **PARTIAL** = implementation addressed but verification incomplete or blocked by an open human ruling · **UNCOVERED (GAP)** = no ticket addresses it. |

## P2.1 Coverage matrix — re-derived against CURRENT ticket text (URL-7 … URL-26)

### Functional requirements — FR-* (38)

| ID | Requirement (short) | Ticket(s) now | Status | Phase-2 change / note |
|---|---|---|---|---|
| FR-1.1 | Register email/password + Google/GitHub (AD-14) | URL-9 (email/password leg), URL-21 (social leg) | COVERED | Split boundary explicit: URL-9 verifies AC-FR-1.1 email/password leg, URL-21 verifies the social leg. |
| FR-1.2 | Email verification required before link creation | URL-9 (mechanics), URL-11 (403 gate) | COVERED | **F-07 fixed:** circular create-gate AC removed from URL-9; `AC-FR-1.2` now owned by URL-11 with an explicit no-link-created assertion. |
| FR-1.3 | Dual auth: API keys + JWT | URL-22 (middleware), URL-9 (token issuance) | COVERED | Split boundary explicit: issuance in URL-9, validation/resolution in URL-22. |
| FR-1.4 | Account deletion → links + analytics (AD-13) | URL-9, URL-8 | COVERED | Unchanged. |
| FR-2.1 | `POST /links` creates a link | URL-11 | COVERED | E1(b) exception-window test deferred to X-4 (annotated in URL-13). |
| FR-2.2 | Auto-generated `[a-zA-Z0-9]` short code | URL-11 | COVERED | Unchanged. |
| FR-2.3 | Custom slug 3–50, strict `[a-zA-Z0-9]` (AD-8) | URL-11, URL-8 | COVERED | ⚠ **D4 warnings now in both tickets** (X-5): applied as written, no hyphens without a new ruling. |
| FR-2.4 | Collision → 409 + 3 alternatives; tombstones never released | URL-11, URL-8, URL-14 | COVERED | Unchanged; URL-11 now asserts "exactly 3 availability-checked" in Verification. |
| FR-2.5 | `Idempotency-Key` replay, no duplicates | URL-11 | COVERED | Unchanged (c2 single transaction). |
| FR-2.6 | Expiration: permanent default, immutable after creation (AD-6) | URL-11, URL-12 | COVERED | Unchanged. |
| FR-2.7 | Abuse prevention: rate limit + CAPTCHA on create (AD-3/AD-4/AD-7) | URL-10 (interface/mode), URL-11 (gates), **URL-25 (live leg, BLOCKED)** | **PARTIAL** | Ownership gap **closed** (F-03 → URL-25 created) but the **live challenge cannot be implemented or verified until X-1 (CAPTCHA vendor)** — URL-25 description opens with the mandated BLOCKED line. Rate-limit + `suspicious`-mode halves are covered and testable now. |
| FR-3.1 | List, retrieve, edit destination, **delete/disable** own links | URL-12 | **PARTIAL** | ⚠ D4 warnings shipped (X-3: DELETE only, no `disabled_at`; X-4: immediacy tolerance). Behavior for MVP is decided ("keep current behavior"), but the **requirement text itself is still ambiguous (X-3 open)** — a human ruling on delete-vs-disable can still change scope; coverage of "delete/disable" as written cannot be certified. |
| FR-3.2 | Ownership checks; non-owner → authorization error | URL-12 | COVERED | **F-17 fixed:** `403 FORBIDDEN` (non-owner), `401` (unauthenticated) now specified — AC testable. |
| FR-3.3 | Single-resource only, no bulk | URL-12 | COVERED | Unchanged. |
| FR-4.1 | Active → 302 + `no-store`, no interstitial (AD-1) | URL-13, URL-19, URL-18, URL-7 | COVERED | Strengthened: 302 default now pinned in URL-7 (config contract), URL-18 (`.env.example` + validation rule), URL-13 (behavior assertion). |
| FR-4.2 | Expired → `410 Gone` JSON | URL-13 | COVERED | `AC-FR-4.2` now cited (F-09/F-16). |
| FR-4.3 | Unknown/deleted → `404 Not Found` JSON | URL-13 | COVERED | `AC-FR-4.3` now cited. |
| FR-4.4 | Aggregate click count; no visitor IP/PII | URL-13, URL-14, URL-8 | COVERED | **F-09 fixed:** count-increment joint test added to URL-13 + URL-14. |
| FR-5.1 | Analytics: total, referrer, country breakdown | URL-14 (+ URL-13 GeoIP), **URL-26 (provisioning, BLOCKED)** | COVERED | Provisioning ownership gap closed (F-04 → URL-26 created, gated X-2, Relates URL-13). Vendor/license still open — does not block URL-13 (stub-file pattern, per Michael's deviation). |
| FR-5.2 | Privacy: no IP/PII, aggregates, ≤30-day events | URL-8, URL-13, URL-14 | COVERED | Unchanged. |
| FR-5.3 | Delete links + associated analytics | URL-12 (explicit test), URL-14 (orphans), URL-8 | COVERED | **F-25/X-9 fixed:** URL-12 now cites `AC-FR-5.3` + `AC-NFR-6` and states the link-level analytics-deletion test. |
| FR-6.1 | QR code for own links | URL-15 | COVERED | Unchanged. |
| FR-6.2 | QR as PNG and SVG; payload = short URL (AD-15) | URL-15 | COVERED | "never stored" wording added (AD-15/D-12). |
| FR-7.1 | Full REST API: accounts, links, analytics, QR | **URL-23 (contract/OpenAPI)** + URL-9/11/12/13/14/15 | COVERED | **GAP CLOSED:** URL-23 claims FR-7.1 and states the machine-verifiable contract check (F-01/X-13, human D2). |
| FR-7.2 | Consistent JSON error shape | URL-7 (envelope), **URL-23** | COVERED | Contract snapshots now verify the envelope across endpoints. |
| FR-7.3 | JSON bodies where a body is returned; redirect status for active | URL-13, **URL-23** | COVERED | `AC-FR-7.3` explicitly cited by URL-23. |
| FR-8.1 | Per-user rate limit, 100 req/min baseline | URL-10 | COVERED | Unchanged. |
| FR-8.2 | `429` + retry guidance | URL-10 | COVERED | Unchanged. |
| FR-8.3 | No tiers; redirect traffic not app-limited (AD-7) | URL-10 | COVERED | **F-16 fixed:** `FR-8.3` now cited by ID (was cited only as "FR-8"). |
| FR-9.1 | Serverless deployment | URL-19 (CDK), URL-20 (pipeline), URL-7 (pointer) | COVERED | Moved out of URL-7 by the human-approved split (D1); pointer line in URL-7 names URL-19/URL-20. |
| FR-9.2 | Data in existing AWS RDS PostgreSQL (AD-11) | URL-8, URL-19 | COVERED | URL-8 cites `FR-9.2`; URL-19 owns RDS Proxy wiring (no DB creation). |
| FR-9.3 | Local PostgreSQL runnability (AD-12) | URL-7, URL-18 | COVERED | `AC-FR-9.3` now cited in both. |
| FR-10.1 | Structured JSON logging | URL-16, URL-7 | COVERED | Unchanged. |
| FR-10.2 | Health check endpoint(s) | URL-16, URL-7 | COVERED | Unchanged. |
| FR-10.3 | Metrics: rate, latency, error rate, redirects | URL-16 | COVERED | + per-feature metric AC checklist (F-19). |
| FR-10.4 | OpenTelemetry tracing | URL-16 | COVERED | Unchanged. |
| FR-10.5 | Basic error alerting | URL-16 | COVERED | **RESOLVED:** alert-verification AC added (F-10/X-14) — force error in staging → alarm state change + SNS path fires. |
| FR-10.6 | Lightweight / local-dev friendly monitoring | URL-16, URL-18 | COVERED | + 90% coverage gate now in URL-18 (F-21). |

### FR acceptance criteria — AC-FR-* (38)

| ID | AC (short) | Ticket(s) now | Status | Phase-2 change / note |
|---|---|---|---|---|
| AC-FR-1.1 | New account created unverified | URL-9 (+ URL-21 social leg) | COVERED | Cited; social leg allocated to URL-21. |
| AC-FR-1.2 | Unverified `POST /links` rejected, no link; verified succeeds | **URL-11 (owner)**, URL-9 (pointer) | COVERED | **F-07 fixed:** AC moved with an explicit test ("403 + no link row created"). |
| AC-FR-1.3 | Valid API key/JWT accepted; invalid rejected | URL-22 | COVERED | Now cited and verified in the split sibling that owns the middleware. |
| AC-FR-1.4 | Account delete removes account + links + analytics | URL-9, URL-8 | COVERED | URL-8 cascade test remains the verification. |
| AC-FR-2.1 | Create with destination only → short code + URL | URL-11 | COVERED | E1(b) 30s-window assertion explicitly deferred to X-4 (URL-13). |
| AC-FR-2.2 | Auto code only `[a-zA-Z0-9]` | URL-11 | COVERED | Unchanged. |
| AC-FR-2.3 | Valid strict slug created; `-` rejected | URL-11, URL-8 | COVERED | ⚠ Warnings present; behavior pinned by D4 ("keep current behavior"). |
| AC-FR-2.4 | Taken slug rejected + suggestions | URL-11 | COVERED | "exactly 3 availability-checked" added to Verification. |
| AC-FR-2.5 | Same-key replay → original result, no duplicate | URL-11 | COVERED | Unchanged (crash-injection AC). |
| AC-FR-2.6 | Permanent default; `expiresAt` immutable | URL-11 | COVERED | Unchanged. |
| AC-FR-2.7 | Rate-limit/CAPTCHA failure blocks create (`429`) | URL-10, URL-11 (joint), **URL-25 (live leg)** | COVERED | **F-16 fixed:** now cited by ID in URL-10 and URL-11; dummy-adapter test verifies the gate. Live-vendor leg tracked separately by URL-25 (see FR-2.7/AC-11). |
| AC-FR-3.1 | After delete/disable, redirects no longer resolve as active | URL-12 (annotated), URL-13 | **PARTIAL** | C2 **reconciled at text level** (both tickets now defer exception-window tests to X-4, keep AD-1 TTLs, forbid invalidation), but the **"new slug 404 ≤30s / deleted 302 ≤60s" assertions are explicitly "not written yet"** (URL-13) pending the **X-4** ruling → verification incomplete. |
| AC-FR-3.2 | Non-owner modify rejected, no change | URL-12 | COVERED | Now testable: `403 FORBIDDEN` / `401` specified (F-17). |
| AC-FR-3.3 | No endpoint mutates >1 resource | URL-12 | COVERED | Unchanged. |
| AC-FR-4.1 | Active → 302, no interstitial | URL-13 | COVERED | **F-09/F-16 fixed:** `AC-FR-4.1` cited + deployed-default 302/`no-store` assertion. |
| AC-FR-4.2 | Expired → 410 + JSON | URL-13 | COVERED | Now cited by ID. |
| AC-FR-4.3 | Unknown/deleted → 404 + JSON | URL-13 | COVERED | Now cited by ID. |
| AC-FR-4.4 | Redirect increments count; no visitor IP/PII | URL-13, URL-14 | COVERED | Count-increment joint test added (was message-shape only). |
| AC-FR-5.1 | Analytics returns total, referrer, country | URL-14 | COVERED | Unchanged. |
| AC-FR-5.2a | Never store visitor IP/PII | URL-14, URL-13, URL-8 | COVERED | Unchanged. |
| AC-FR-5.2b | Click events purged ≤30 days | URL-14 | COVERED | Unchanged. |
| AC-FR-5.3 | Deleting a link deletes its analytics | **URL-12 (explicit link-level test)**, URL-14 (orphans, annotated) | COVERED | **RESOLVED (F-25/X-9):** URL-12 cites the AC and states the full table-by-table deletion test; URL-14 explicitly scoped to orphaned-linkId handling only. |
| AC-FR-6.1 | Owner QR encodes the short URL | URL-15 | COVERED | Unchanged. |
| AC-FR-6.2 | QR supports PNG and SVG | URL-15 | COVERED | Unchanged. |
| AC-FR-6.3 | Non-owner QR → authorization error | URL-15 | COVERED | Unchanged. |
| AC-FR-7.1 | Endpoints for registration/verification/deletion, link CRUD, analytics, QR | **URL-23** | COVERED | **GAP CLOSED:** OpenAPI generated + validated in CI; every documented endpoint snapshot-tested. |
| AC-FR-7.2 | One consistent JSON error schema | URL-7, **URL-23** | COVERED | Contract snapshots now assert the §5.1 envelope across endpoints (F-01). |
| AC-FR-7.3 | 404/410/body-bearing statuses JSON; active → redirect status | URL-13, **URL-23** | COVERED | Explicitly cited by URL-23. |
| AC-FR-8.1 | >100 req/min → 429 + retry guidance | URL-10 | COVERED | Unchanged. |
| AC-FR-8.2 | Within baseline → served normally | URL-10 | COVERED | Unchanged. |
| AC-FR-9.1 | Runs on serverless, no long-lived server | URL-19 (CDK), URL-20 (deploy) | COVERED | Verified via `cdk synth`/deploy + staging deploy evidence. *Minor citation note: URL-7's pointer names "AC-FR-9.1 → URL-20" but URL-20 cites only `FR-9.1` — equivalent content, ID not repeated (observation, not a gap).* |
| AC-FR-9.2 | All persistent data in AWS RDS PostgreSQL | URL-8 | COVERED | `AC-FR-9.2` now cited (F-16). |
| AC-FR-9.3 | Local run vs local PostgreSQL | URL-7, URL-18 | COVERED | Cited in both. |
| AC-FR-10.1 | Every request → structured JSON log entry | URL-16 | COVERED | Now cited by ID (F-10). |
| AC-FR-10.2 | Health endpoint responds when healthy | URL-16, URL-7 | COVERED | Now cited by ID. |
| AC-FR-10.3 | Metrics for rate, latency, error rate, redirects | URL-16 | COVERED | Now cited; + one-metric-per-family AC. |
| AC-FR-10.4 | OTel traces, works in local dev | URL-16 | COVERED | Unchanged (already cited). |
| AC-FR-10.5 | System raises basic alerts on error conditions | URL-16 | COVERED | **RESOLVED (X-14):** alert-verification AC added — force error → alarm state change + SNS notification path fires. |

### Non-functional requirements — NFR-* (9)

| ID | Requirement (short) | Ticket(s) now | Status | Phase-2 change / note |
|---|---|---|---|---|
| NFR-1 | Fast redirects, no interstitial; latency budgets by Architect | URL-13, URL-17 | COVERED | Unchanged; budgets sourced from design §9.1 (wave baseline). |
| NFR-2 | 10,000+ users, 1,000,000+ links | URL-17, URL-8 | COVERED | Unchanged (1M-link seed + scale math). |
| NFR-3 | High availability of redirect path; health checks | URL-16 (health), URL-17 (latency/cache), **URL-24 (availability/RTO, created)** | **COVERED** | **RESOLVED (F-02/X-8):** availability verification was nobody's scope; **URL-24 created to own RTO + failover/soak verification**, Relates URL-17, cites `AC-NFR-3`/`NFR-3`/`AD-11` 99.9% goal, 6 open questions routed to the human. |
| NFR-4 | No visitor IPs/PII; aggregates only; ≤30-day events | URL-13, URL-14, URL-8 | COVERED | Unchanged (schema privacy gate + purge + regression). |
| NFR-5 | Rate limit + CAPTCHA; verification gate; ownership; dual auth | URL-9, URL-10, URL-11, URL-12, URL-22 | COVERED | Unchanged; cross-cutting, verified by the component ACs. **No `AC-NFR-5` exists.** |
| NFR-6 | Users can delete links + analytics at any time | URL-12 (now states the test), URL-8, URL-9 | COVERED | Analytics-removal leg now stated (see AC-NFR-6). |
| NFR-7 | Serverless-friendly; RDS Postgres; local-dev lightweight | URL-18, URL-7, URL-19 | COVERED | Unchanged; CDK adds the RDS Proxy leg (no DB creation). |
| NFR-8 | JSON logs, metrics, health, OTel, alerting (FR-10) | URL-16 | COVERED | + alert-verification AC (X-14). |
| NFR-9 | Single shared domain now; custom domains designed for v2 | **URL-19** | **COVERED** | **GAP CLOSED (F-11):** URL-19's scope includes the NFR-9 non-goal (`PathRouting` single domain, no `customDomain` props) and an AC asserting no custom-domain resource is created. |

### NFR acceptance criteria — AC-NFR-* (5)

| ID | AC (short) | Ticket(s) now | Status | Phase-2 change / note |
|---|---|---|---|---|
| AC-NFR-1 | Redirect, no interstitial; latency targets set by Architect | URL-17 | COVERED | Unchanged; budgets from design §9.1. |
| AC-NFR-2 | Operates at 10k users / 1M links | URL-17 | COVERED | Unchanged (seed + k6). |
| AC-NFR-3 | Health checks exposed + redirect path meets availability goals (99.9% per AD-11) | **URL-17 (latency/cache/connection math) + URL-24 (availability/RTO/failover)** | **COVERED** | **RESOLVED (F-02/X-8):** ownership split is now explicit and consistent — URL-17 keeps its performance scope and links URL-24; URL-24 owns the availability legs URL-17 never covered. |
| AC-NFR-4 | No store holds visitor IP/PII; events ≤30 days | URL-13, URL-14, URL-8 | COVERED | Unchanged — verified by content (privacy regression, 30-day purge, schema privacy gate); no citation change needed. |
| AC-NFR-6 | User can delete a link + its analytics at any time via API | **URL-12 (explicit link-level test)**, URL-14 (orphans) | **COVERED** | **RESOLVED (F-25/X-9):** URL-12 now cites `AC-NFR-6` and states the full table-by-table deletion assertion. |

*(Still no `AC-NFR-5`, `AC-NFR-7`…`AC-NFR-9` in requirements.md — unchanged from Phase 1 §6 E11.)*

### PRD acceptance criteria — AC-01 … AC-13 (13)

*(Short text quoted from `requirements.md` §… AC table; statuses re-derived from current ticket text.)*

| ID | AC (short) | Ticket(s) now | Status | Phase-2 change / note |
|---|---|---|---|---|
| AC-01 | Signup & verification: register via email/password or Google/GitHub; unverified user errors on link creation; verified succeeds | URL-9 (email/password), **URL-21 (social leg, created)** | COVERED | Social leg was orphaned (F-12/X-12); **URL-21 created** to own Google/GitHub registration + verification, cites `FR-1.1`/`AC-01`/`AD-14`. |
| AC-02 | Create link: authenticated `POST /links` with only a destination returns a short URL with auto-generated alphanumeric code | URL-11 | COVERED | Cited; E1(b) 30s-window assertion deferred to X-4 (URL-13). |
| AC-03 | Custom slug: supplying `my-campaign` (stated as 3–50 alphanumeric chars) gets that slug; existing slug → rejection + suggestions | URL-11 (+ URL-8 CHECK constraint) | **PARTIAL** | **Blocked on open human ruling X-5 (AM-1/AC-03 charset conflict).** URL-11 implements strict `[a-zA-Z0-9]` per AD-8 and carries **2 ⚠ warnings + an explicit `X-5` reference**, so the PRD's own `my-campaign` example would be rejected. Behavior is decided for now ("keep current behavior" / no hyphens), but certification of AC-03 as written cannot happen until Michael rules. ⚠ warnings present → **non-blocking for implementation**. |
| AC-04 | Idempotency: replaying `POST /links` with same `Idempotency-Key` returns original link, no duplicate | URL-11 | COVERED | Cited; crash-injection AC. |
| AC-05 | Redirect: `GET /{shortCode}` for an active link responds **302** (decided default) to destination, no intermediate page | URL-13, URL-7, URL-18 | COVERED | 302 default now pinned in three places (config contract URL-7, env validation URL-18, behavior URL-13). |
| AC-06 | Expired link: responds `410 Gone` with JSON error | URL-13 | COVERED | Cited. |
| AC-07 | Unknown/deleted link: responds `404 Not Found` with JSON error | URL-13 | COVERED | Cited. |
| AC-08 | Edit & delete: owner updates destination and deletes/disables; non-owner receives authorization error | URL-12 | COVERED | Cited + testable now (`403 FORBIDDEN`/`401` added, F-17). *Delete-vs-disable wording still open as X-3 and immediacy tolerance as X-4 — both carry ⚠ warnings and are annotated inside URL-12/URL-13; AC-08's implemented behavior (delete-only) is therefore decided → stays COVERED with the warning.* |
| AC-09 | Analytics: owner retrieves total clicks, referrer and country breakdowns; no visitor IP/PII; events ≤30 days | URL-14 | COVERED | Cited; GeoIP provisioning split out to URL-26 (X-2-gated, non-blocking). |
| AC-10 | QR codes: owner downloads QR for their link in PNG and SVG | URL-15 | COVERED | Cited. |
| AC-11 | Rate limiting: >100 req/min returns `429` with retry guidance; link creation is CAPTCHA-protected | URL-10 (rate-limit + mode), URL-11 (gates), **URL-25 (live vendor leg, BLOCKED)** | **PARTIAL** | Rate-limit leg fully covered (URL-10: **2 ⚠ + `X-1` ref**, `AC-11` cited; joint 429 test with URL-11). CAPTCHA leg ships only as interface + `suspicious` mode + dummy adapter; **live challenge blocked on open human decision X-1 (vendor)** — **URL-25 opens with a literal `BLOCKED — human CAPTCHA vendor decision pending (X-1)` banner** (note: banner text, no ⚠ glyph). ⚠/BLOCKED in place → **non-blocking for implementation**; AC-11 cannot be certified end-to-end until X-1 is ruled. |
| AC-12 | Observability: health check responds; JSON logs emitted; metrics cover request rate, latency, error rate, redirects; tracing works locally | URL-16 | COVERED | Cited; + alert-verification AC (X-14) and 90% coverage gate in URL-18. |
| AC-13 | Account deletion: user deletes account, removing links and associated analytics | URL-9 (impl), URL-8 (cascade test) | COVERED | Content verified by URL-8's cascade test. *Observation (not a gap): the literal `AC-13` ID is still not cited by any ticket — re-checked URL-9 description 2026-10-25; coverage is by content, not by ID.* |

### Decision IDs tied to acceptance — AD-1…AD-15, D-9 (16)

| ID | Decision (short) | Ticket(s) now | Status | Phase-2 change / note |
|---|---|---|---|---|
| AD-1 | 302 branch + `no-store`, Tier-1 LRU, no CDN | URL-13, URL-17 | COVERED | Unchanged; "No CDN/edge allowed" still asserted by URL-17. |
| AD-2 | Transient request-time GeoIP (Option B), IP never persisted | URL-13 (+ URL-26 provisioning) | COVERED | *Vendor/license open as X-2 → provisioning parked in URL-26 (BLOCKED, X-2); behavior/privacy leg covered and testable now (stub-file pattern, per Michael's deviation).* |
| AD-3 | Pluggable `CaptchaProvider`, mode `suspicious` | URL-10 (interface/mode/dummy), **URL-25 (live vendor leg)** | **COVERED** *(with note)* | **UPGRADED from PARTIAL:** design §11.2 states AD-3 is about the *interface + mode*, and the **vendor selection is outside AD-3**; the live leg is now owned by **URL-25** (created, F-03), gated on X-1 with a BLOCKED banner. AD-3's own scope is fully covered → COVERED; the *vendor-dependent* behavior is tracked separately as AC-11/FR-2.7 PARTIAL. |
| AD-4 | `POST /v1/links` requires auth; anonymous → 401 | URL-11, URL-22 | COVERED | Explicit in both. |
| AD-5 | Tombstone slugs never released | URL-8, URL-11, URL-14 | COVERED | Cascade/tombstone/audit across three tickets. |
| AD-6 | PATCH = `destinationUrl` only | URL-11, URL-12 | COVERED | Both tickets agree. |
| AD-7 | In-app Postgres sliding window, uniform 100/min, `user:`/`apikey:` only | URL-10 | COVERED | Explicit. |
| AD-8 | Strict `[a-zA-Z0-9]` + DB CHECK; 409 + 3 suggestions | URL-11, URL-8 | COVERED | Applied consistently in both; underlying AC-03 conflict remains open as X-5 (⚠ present). *⚠ **URL-8 defect note:** its scope bullet containing the CHECK regex `^[a-zA-Z0-9]{3,50}` is corrupted (see P2.6/G1).* |
| AD-9 | Un-capped `BIGINT` totals, no downsampling | URL-8, URL-14 | COVERED | `click_count BIGINT` + totals tables. |
| AD-10 | No raw events; 30-day buckets; totals indefinite | URL-8, URL-14 | COVERED | Explicit. |
| AD-11 | Multi-AZ RDS confirmed; budgets + 99.9% stand | URL-8, URL-17, **URL-24** | COVERED | **99.9% availability leg now verifiable** — URL-24 owns RTO/failover/soak (was unverifiable in Phase 1). |
| AD-12 | AWS Lambda + API Gateway HTTP API; dual entrypoint | URL-7, URL-18 | COVERED | Explicit. |
| AD-13 | Hard-delete cascade | URL-9, URL-8 | COVERED | Explicit + cascade test. |
| AD-14 | Google + GitHub only; double opt-in | URL-9, **URL-21** | COVERED | *Observation: URL-22 lists `AD-14` among its design refs though its scope is auth middleware — the ID **exists** (valid reference), the topic is a loose fit; no coverage impact.* |
| AD-15 | QR payload = short URL, `?format=`, no styling | URL-15 | COVERED | + "never stored" wording. |
| D-9 | Tier-1 LRU 60s/30s + `no-store`, no Tier-2 CDN (only `D-*` in requirements.md) | URL-13 | COVERED | TTLs implemented exactly as approved; E1 legs (a)/(b) parked as X-4 with ⚠ warnings. |

**P2.1 total (all 6 groups): 119 IDs → 114 COVERED · 5 PARTIAL · 0 UNCOVERED.**

| Group | Total | COVERED | PARTIAL | UNCOVERED |
|---|---|---|---|---|
| FR-* | 38 | 36 | 2 | 0 |
| AC-FR-* | 38 | 37 | 1 | 0 |
| NFR-* | 9 | 9 | 0 | 0 |
| AC-NFR-* | 5 | 5 | 0 | 0 |
| AC-01…AC-13 | 13 | 11 | 2 | 0 |
| AD-1…AD-15 + D-9 | 16 | 16 | 0 | 0 |
| **Total** | **119** | **114** | **5** | **0** |

Phase-1 baseline for comparison: 119 → 104 COVERED / 13 PARTIAL / 2 UNCOVERED (`NFR-9`, `AC-FR-7.1`).

## P2.2 Gap closure — the two Phase-1 UNCOVERED IDs

| Phase-1 gap | Closure evidence (current ticket text) | Verdict |
|---|---|---|
| **NFR-9** — "Single shared domain now; custom domains designed for in a later version (v2)" — no ticket referenced it (design §10.6 documents the extension point, no MVP work intended) | **URL-19** (CDK infrastructure) now carries it explicitly: *Requirements:* `NFR-9`; scope includes the single-domain non-goal (no `customDomain` props, single shared host routing); AC asserts **no custom-domain resource is created**. URL-7's design-refs/scope pointers name URL-19 as the owner of the extension point. | **CLOSED → COVERED** |
| **AC-FR-7.1** — "Endpoints for registration/verification/deletion, link CRUD, analytics, QR" — endpoints existed but no contract-level verification was claimed | **URL-23** (API contract, created in Phase 2 from F-01/X-13 human D2) claims `FR-7.1` + `AC-FR-7.1`: OpenAPI generated and validated in CI, every documented endpoint snapshot-tested, contract diff gate. | **CLOSED → COVERED** |

Both Phase-1 gaps are closed. **UNCOVERED count = 0.**

## P2.3 Resolution of the Phase-1 PARTIAL list (13 IDs)

*Legend: **RESOLVED** = now COVERED with a stated verification · **STILL PARTIAL** = still PARTIAL, with the precise reason (an open human ruling is an acceptable reason **only if** the ⚠ warning / BLOCKED banner is present in the owning ticket).*

| Phase-1 PARTIAL ID | Phase-2 status | Precise reason / evidence |
|---|---|---|
| FR-2.7 (rate limit + CAPTCHA on create) | **STILL PARTIAL** | Ownership gap closed (F-03 → **URL-25** created, Relates URL-10, gated X-1) but the **live CAPTCHA leg cannot be implemented or verified until human ruling X-1 (provider vendor)**. Rate-limit + `suspicious`-mode halves are COVERED and testable now. BLOCKED banner present in URL-25 → acceptable partial. |
| FR-3.1 (list/retrieve/edit/delete-disable own links) | **STILL PARTIAL** | ⚠ D4 warnings shipped in URL-12 (X-3 delete-only, no `disabled_at`; X-4 immediacy tolerance). MVP behavior is decided ("keep current behavior"), but **the requirement's own "delete/disable" wording is still an open human ruling (X-3)** — scope can still change → cannot certify. ⚠ present → acceptable partial. |
| FR-7.1 (full REST API) | **RESOLVED → COVERED** | URL-23 (contract/OpenAPI, F-01/X-13) + the split siblings own every endpoint group; machine-verifiable contract check in CI. |
| FR-10.5 (basic error alerting) | **RESOLVED → COVERED** | URL-16 gained the **alert-verification AC** (F-10/X-14): force an error in staging → alarm state changes + SNS notification path fires. |
| AC-FR-3.1 (delete/disable ⇒ not active within 30s/60s) | **STILL PARTIAL** | C2 reconciled **at text level** — URL-12 and URL-13 now agree (both defer the exception-window tests to X-4, both keep design §9.1/AD-1 TTLs, both forbid cache invalidation), **but the assertions "new slug 404 ≤30s / deleted 302 ≤60s" are explicitly "not written yet" in URL-13**, pending the **X-4** cache-immediacy ruling → verification incomplete. ⚠ present in both tickets → acceptable partial. |
| AC-FR-5.3 (deleting a link deletes its analytics) | **RESOLVED → COVERED** | F-25/X-9: **URL-12 now cites `AC-FR-5.3` + `AC-NFR-6`** and states the link-level table-by-table deletion test; URL-14 explicitly scoped to orphaned-`linkId` handling only. |
| AC-FR-10.5 (system raises basic alerts) | **RESOLVED → COVERED** | Alert-verification AC added to URL-16 (X-14). |
| NFR-3 (availability of redirect path + health checks) | **RESOLVED → COVERED** | F-02/X-8: **URL-24 created** as the availability owner (RTO, failover/soak, 99.9% per AD-11), Relates URL-17; URL-16 keeps health checks; URL-17 keeps latency/cache/connection math. |
| AC-NFR-3 (health checks + availability goals) | **RESOLVED → COVERED** | Same split as above; **cross-ticket agreement verified**: URL-17 → URL-24 pointer present, URL-24 → URL-17 link present, no double ownership, no orphan. |
| AC-NFR-6 (delete link + analytics via API) | **RESOLVED → COVERED** | URL-12 cites the ID and states the deletion test (see AC-FR-5.3). |
| AC-03 (custom slug `my-campaign`) | **STILL PARTIAL** | **Open human ruling X-5** (AM-1/AC-03 charset conflict, requirements §8.5 #1). URL-11 carries **2 ⚠ warnings + explicit `X-5`** reference and implements AD-8 strict charset; until Michael rules, PRD AC-03's own example fails by design → certification blocked. ⚠ present → acceptable partial, non-blocking for implementation. |
| AC-11 (429 + CAPTCHA-protected create) | **STILL PARTIAL** | Rate-limit leg COVERED (URL-10: `AC-11` cited, 2 ⚠, joint 429 test with URL-11). CAPTCHA leg = interface + dummy adapter only; **live challenge blocked on X-1**, owned by URL-25 with a literal `BLOCKED — human CAPTCHA vendor decision pending (X-1)` banner (no ⚠ glyph, but banner is explicit). → acceptable partial, non-blocking for implementation. |
| AD-3 (pluggable `CaptchaProvider`, mode `suspicious`) | **RESOLVED → COVERED** *(with note)* | design §11.2: the **vendor is outside AD-3**; AD-3's interface + `suspicious` mode are fully covered by URL-10. The vendor-dependent live leg moved to **URL-25** and is tracked under AC-11/FR-2.7 rather than as an AD-3 gap. |

**Score: 8 of 13 Phase-1 PARTIALs resolved → COVERED; 5 remain PARTIAL, every one of them with an open human ruling named (X-1, X-3, X-4, X-5) and its ⚠/BLOCKED warning in place.**

Remaining PARTIAL set: `FR-2.7`, `FR-3.1`, `AC-FR-3.1`, `AC-03`, `AC-11`.

## P2.4 Quality gate — 20 children × 5 attributes

*Legend: **PASS** = attribute present and adequate · **FAIL** = attribute genuinely absent or defective (one-line reason given). Checked against the live description text of every ticket on 2026-10-25 (read-only).*

| # | Ticket | (a) scope clear | (b) testable ACs | (c) dependencies as issue links | (d) technical refs | (e) verification expectations |
|---|---|---|---|---|---|---|
| 1 | URL-7 Scaffolding: app/CDK/CI spine | PASS | PASS | PASS (5 links, incl. Blocks URL-19) | PASS (§/D-* refs + 10 IDs) | PASS |
| 2 | URL-8 Database schema & migrations | **FAIL** — scope text corrupted: a duplicate `**Design refs:** / **Scope:**` block is spliced into the first bullet, truncating the slug CHECK pattern `^[a-zA-Z0-9]{3,50}` | PASS (Acceptance block with concrete tests: cascade, static credential check, dedup semantics) | PASS (4 issue links) | PASS (14 IDs + § refs) | PASS (test methods stated, though nested under *Acceptance* rather than a *Verification* header) |
| 3 | URL-9 Accounts & authentication | PASS | PASS (`**Acceptance (create-gate AC fixed, F-07):**` block with pass/fail assertions) | PASS (4 links) | PASS | PASS |
| 4 | URL-10 Rate limiting & CAPTCHA | PASS | PASS | PASS (3 links, incl. Blocks URL-25) | PASS (§3.3/§3.4/§6.6, D-10, AD-3/AD-7) | PASS (window math, header assertions, dummy-adapter flow) |
| 5 | URL-11 Link creation | PASS | PASS | PASS (5 links) | PASS (17 IDs) | PASS |
| 6 | URL-12 Link management | PASS | PASS | PASS (3 links) | PASS | PASS |
| 7 | URL-13 Redirect service | PASS | PASS | PASS (4 links, incl. Relates URL-26) | PASS | PASS |
| 8 | URL-14 Analytics pipeline | PASS | PASS | PASS (4 links, incl. Blocks URL-24) | PASS | PASS |
| 9 | URL-15 QR codes | PASS | PASS (AC list + non-owner assertion) | PASS (3 links) | PASS (§5.4, D-12, AD-15) | **FAIL** — no *Verification* section; Acceptance lists assertions only ("both formats downloadable…; non-owner rejected") with no stated test method |
| 10 | URL-16 Observability | PASS | PASS | **FAIL** — verification runs *in staging* (force error → alarm + SNS path) but has no issue link to the staging deployer URL-19 or pipeline URL-20 (links only URL-7, URL-24) | PASS | PASS |
| 11 | URL-17 Performance & scale | PASS | PASS | **FAIL** — k6/cache/connection suite targets the deployed staging env; no link to URL-19/URL-20 (links URL-12/13/14/15/24) | PASS (§9.1–9.4, §10.1–10.3, AD-11, D-9) | PASS |
| 12 | URL-18 Foundation bootstrap | PASS | PASS | PASS (3 links) | PASS | PASS |
| 13 | URL-19 CDK infrastructure (split) | PASS | PASS | PASS (Blocks URL-7, URL-20) | PASS | PASS |
| 14 | URL-20 CI/CD pipeline (split) | PASS | PASS | PASS (link to URL-19) | PASS | PASS |
| 15 | URL-21 Social OAuth (split) | PASS | PASS | PASS (link to URL-9) | PASS | PASS |
| 16 | URL-22 API keys & auth middleware (split) | PASS | PASS | PASS (link to URL-9) | PASS | PASS |
| 17 | URL-23 API contract / OpenAPI | PASS | PASS | **FAIL** — description says "wire the contract suite into **URL-7/URL-20**'s CI" but carries no issue link to URL-20 (links URL-7/12/14/15/18) | PASS | PASS |
| 18 | URL-24 E2E nightly + resilience (availability owner) | PASS | PASS | **FAIL** — "nightly run evidence **on staging**" with no link to URL-19/URL-20 (links URL-14/16/17) | PASS | PASS |
| 19 | URL-25 CAPTCHA vendor adapter | PASS | PASS | **FAIL** — "staging run against the chosen vendor" with no link to URL-19/URL-20 (links only URL-10) | PASS | PASS |
| 20 | URL-26 GeoIP provisioning | PASS | PASS | **FAIL** — "layer test on the **deployed staging stack**" with no link to URL-19/URL-20 (links only URL-13) | PASS | PASS |

**Gate result: 100 cells → 92 PASS, 8 FAIL.**

| Attribute | PASS | FAIL | Failing tickets |
|---|---|---|---|
| (a) scope clear | 19 | 1 | URL-8 (corrupted description text) |
| (b) testable ACs | 20 | 0 | — |
| (c) dependencies as issue links | 14 | 6 | URL-16, URL-17, URL-23, URL-24, URL-25, URL-26 |
| (d) technical refs | 20 | 0 | — |
| (e) verification expectations | 19 | 1 | URL-15 |

**Root causes of the 8 FAILs (all ticket-text/link defects, not requirement gaps):**
- **G1 — URL-8 (a):** the Phase-2 Pass B description edit spliced a duplicated header block mid-bullet; the `^[a-zA-Z0-9]{3,50}` CHECK text is truncated at two places. *Re-fetch confirmed this is in the stored Jira description, not a fetch artifact.*
- **G2 — URL-16/17/23/24/25/26 (c):** six tickets name an environment produced by other tickets (staging from URL-19, CI pipeline URL-20) in their Verification/Scope text but do not carry the corresponding issue link, so Jira cannot surface the ordering.
- **G3 — URL-15 (e):** no Verification section (only assertions); every sibling ticket states a method.

## P2.5 New contradictions & invalid references (Phase-2 edits)

**Invalid requirement/design IDs cited by tickets: NONE.** Every `FR-*`, `NFR-*`, `AC-FR-*`, `AC-NFR-*`, `AC-0x`, `AD-*`, `D-*` token found in the 20 descriptions was matched against `requirements.md` (§4/§5/§7 tables) and `design.md` (§2, §11). Spot-checked ranges: `AC-FR-1.1…1.4`, `AC-FR-2.1…2.7`, `AC-FR-3.1/3.2`, `AC-FR-4.1…4.4`, `AC-FR-5.1/5.2a/5.2b/5.3`, `AC-FR-6.1/6.2/6.3`, `AC-FR-7.1/7.2/7.3`, `AC-FR-9.1/9.2/9.3`, `AC-FR-10.1…10.5`, `AC-NFR-1/2/3/4/6`, `AC-01…AC-13`, `NFR-1…NFR-9`, `AD-1…AD-15`, `D-3/D-4/D-9/D-10/D-12/D-15`, `FR-8.3`, `FR-9.2`, `NFR-2`, `NFR-4` — all resolve. **No new invalid ID reference was introduced by Phase 2.**

**Contradictions — Phase-1 set:**

| ID | Phase-1 contradiction | Phase-2 status |
|---|---|---|
| **C1** | URL-11 claims `AC-03` while enforcing AD-8 strict charset → PRD's `my-campaign` example fails | **STILL OPEN (X-5)** — unchanged; ⚠ warnings now present in URL-11 (2×, explicit `X-5` ref) and URL-8 ("AD-8 DB CHECK stays exactly as written"). No new contradiction, but the conflict is now *flagged in ticket text* rather than silent. |
| **C2** | URL-12 (no tolerance) vs URL-13 (60s cache) — incompatible readings of `AC-FR-3.1` | **RESOLVED AT TEXT LEVEL** — URL-12 and URL-13 now state the same position: exception windows deferred to **X-4**, design §9.1/AD-1 TTLs kept, no cache invalidation. The behavioral assertions remain unwritten pending X-4 (tracked as PARTIAL `AC-FR-3.1`, not as a contradiction). |
| **C3** | URL-18's `REDIRECT_STATUS` placeholders not pinned to the decided 302 | **RESOLVED** — 302 default now pinned in URL-7 (config contract), URL-18 (env validation rule + `.env.example`) and URL-13 (behavior assertion). *Minor residual wording tension:* URL-18 still describes an operational override capability while URL-7/URL-13 say a non-302 value requires a new human decision (X-11 open, wording applied) → **observation, not a contradiction.** |
| **C4** | requirements-internal: PRD AC-03 example vs AD-8 | **UNCHANGED (pre-existing)** — carried as X-5; not introduced or worsened by Phase 2. |

**New contradictions introduced by Phase 2: NONE.** (Checked cross-ticket pairs as instructed: URL-17↔URL-24 `AC-NFR-3` ownership ✓ complementary, no double claim · URL-16's availability role = ongoing measurement, URL-24 = verification, URL-17 = performance ✓ consistent · URL-12 delete-only/cache warnings ↔ URL-13 immediacy text ✓ now aligned · URL-18 `REDIRECT_STATUS` ↔ URL-7 config contract ✓ pinned, residual wording noted above · split boundaries URL-7/19/20 ✓ non-overlapping with URL-7's retained spine, and URL-9/21/22 ✓ email-password vs social vs keys/middleware, no scope duplicated.)

**New *invalid references* (non-existent Jira keys / stale aliases) — 3 classes found (text-level defects, no coverage impact):**
1. **Stale work-order aliases in ticket text:** `NEW-T2` still appears in **URL-17** (5× in the description — "owned by NEW-T2", "NEW-T2 evidence reference") and **URL-16** (1×), plus once in **URL-24's** comment; `NEW-T4` appears in **URL-13** (1×) and **URL-26** (2×). The tickets were created as **URL-24** and **URL-26** — these aliases are not issue keys and will not resolve in Jira. *(URL-17's fallback wording — "if NEW-T2 is not created, URL-17 MUST absorb that verification" — is also stale, since URL-24 exists.)*
2. **Epic URL-6 description is stale:** still says "Pending new children (human-approved, created in audit Pass C): NEW-T1…NEW-T4" though URL-23…URL-26 exist and are linked as children; still lists Phase-1 coverage stats (104/13/2); still lists X-8/X-9/X-13/X-14 under "Open escalations" although §D.1/§G record them as EXECUTED.
3. **Pointer/ID mismatches (equivalent content):** URL-7 says "`AC-FR-9.1` → URL-20" but URL-20 cites only `FR-9.1`; URL-22 lists `AD-14` (valid ID, loose topic fit for middleware scope); literal `AC-13` still not cited by URL-9 (content verified).

None of these three classes changes coverage status; they are Phase-2 text-integrity follow-ups (see G1–G4).

## P2.6 Audit trail & source-file integrity

**Audit trail (read-only counts fetched 2026-10-25):** every Phase-2-modified or Phase-2-created ticket carries at least one comment explaining the change with requirement/design/finding references.

| Ticket | Comments | First comment cites |
|---|---|---|
| URL-7 | 3 | split/unit rationale |
| URL-8 | 1 | "Phase 2 Pass B" + **X-5, F-16** + design § refs |
| URL-9 | 4 | split rationale + F-07 note in body |
| URL-10 | 2 | "Phase 2 Pass B" + **F-23, F-08, F-16, X-1** |
| URL-11 | 1 | "Phase 2 Pass B" + **F-07, F-08, F-20, X-5** |
| URL-12 | 3 | "Phase 2 Pass B" + **X-3, X-4/C2, F-17** |
| URL-13 | 1 | "Phase 2 Pass B" + **F-09, F-16, F-24, X-11** |
| URL-14 | 3 | "Phase 2 Pass B" + **F-23, F-1…** |
| URL-15 | 3 | **F-06** (URL-17 budget-row need) |
| URL-16 | 2 | "Phase 2 Pass B" + **F-19, F-10/X-14** |
| URL-17 | 1 | "Phase 2 Pass B" + **F-05, F-18, F-26/X-8** |
| URL-18 | 3 | wave-order rationale (readiness audit) |
| URL-19 | 2 | pipeline/CDK dependency |
| URL-20 | 1 | "Created by backlog audit split — D1, **finding F-11**" |
| URL-21 | 1 | "Created by backlog audit split — D1, **finding F-12**" |
| URL-22 | 1 | "Created by backlog audit split — D1, **finding F-12**" |
| URL-23 | 3 | "Created by Pass C" + contract/CI rationale |
| URL-24 | 2 | "**Created by Pass C**" + **X-8 / URL-17 evidence** |
| URL-25 | 1 | "Created by backlog audit Pass C — **F-03; escalation X-1 (OPEN)**; human D3" |
| URL-26 | 2 | "Created by Pass C" + **F-04, X-2**; Michael deviation note |

→ **Audit trail: PASS** (20/20 tickets have ≥1 explanatory comment; all 6 new tickets cite their creating finding; comments name requirement/design IDs). Epic URL-6 has 1 comment + refreshed description per §F-22. **Transitions: 0 in Phase 2 (all 20 children remain To Do, Roy Melamed / Agent Owner Developer, parent URL-6) — correct, read-only-adjacent.**

**Source-file integrity (stat + sha256, 2026-10-25):**

| File | mtime | size | sha256 (first 8) | Verdict |
|---|---|---|---|---|
| `PRD.md` | **2026-10-08 16:18:33** | 15047 | `59f623b6` | **UNTOUCHED** (matches Phase-1 record byte-for-byte) |
| `specs/…/requirements.md` | **2026-10-13 10:09:53** | 33811 | `60c9f4a2` | **UNTOUCHED** |
| `specs/…/design.md` | **2026-10-13 10:00:54** | 69192 | `835643f4` | **UNTOUCHED** |
| `specs/…/readiness-audit.md` | **2026-10-13 10:11:13** | 18553 | `86eb2814` | **UNTOUCHED** |
| `specs/…/ticket-audit.md` | 2026-10-25 15:41:04 | 72448 | — | Changed today as expected (Phase-2 record; **read-only for me**) |
| `specs/…/requirements-coverage.md` | 2026-10-25 (this artifact) | — | — | My Phase-2 append — the only spec file I wrote |

*Observation (not a spec source):* `.opencode/agents/{jim,michael,pam,ryan,dwight}.md` show 2026-10-25 mtimes — agent-configuration files touched by the harness/session setup, not PRD/spec content. **No PRD, requirements, design, readiness-audit, or ticket-audit file was modified by me; Jira was never written to in Phase 2.**

---

# FINAL VERDICT

## ✅ READY FOR IMPLEMENTATION

**Declared by:** Jim Halpert (Specification Agent), 2026-10-25 · **Gate:** requirements-coverage for epic **URL-6** · **Basis:** 119/119 requirement IDs accounted for, **0 UNCOVERED**, no new contradictions or invalid requirement IDs, audit trail verified 20/20, source spec files byte-identical (sha256), Jira never written to in this phase.

| Gate criterion | Result |
|---|---|
| 1. Coverage of all 119 IDs | **PASS** — 114 COVERED / 5 PARTIAL / 0 UNCOVERED |
| 2. Phase-1 gaps NFR-9, AC-FR-7.1 | **CLOSED** (URL-19, URL-23) |
| 3. Phase-1 PARTIALs resolved | **8 of 13 resolved**; 5 remain, all blocked on named human rulings with ⚠/BLOCKED text in place |
| 4. New contradictions | **NONE** (C1/X-5 open as before; C2 text-level resolved; C3 resolved; C4 pre-existing) |
| 5. Invalid requirement/design IDs | **NONE** (stale *Jira aliases* only — see G4) |
| 6. Quality gate 20×5 | 92/100 PASS, **8 FAIL** (ticket-text defects, listed as follow-ups) |
| 7. Audit trail | **PASS** — every changed/created ticket has ≥1 comment citing findings + requirement/design refs |
| 8. Source-file integrity | **PASS** — PRD 2026-10-08; requirements/design/readiness 2026-10-13; hashes unchanged |
| 9. Jira writes in Phase 2 | **0** (read-only honored; 0 transitions, all 20 children still To Do) |

### (a) Exact blocking items — ticket-scoped, none require a spec change

| # | Blocker | Blocks what | Clears when |
|---|---|---|---|
| **B1** | **G1 — URL-8 description corruption** (duplicated `Design refs`/`Scope` block spliced mid-bullet; `^[a-zA-Z0-9]{3,50}` CHECK text truncated) | **start of URL-8 only** (wave 1) | Dwight re-writes the affected bullet from design §4.1/AD-8 text; ~5-minute edit + one comment |
| **B2** | **X-5** — AM-1/AC-03 charset conflict (PRD `my-campaign` vs AD-8 strict) | **URL-11 implementation start** (per ticket-audit D4 record: "still blocks URL-11 implementation start") | Michael rules keep-strict vs allow-hyphen; ⚠ warnings already in URL-11 (2×) and URL-8 |
| **B3** | **X-7** — AWS deployment prerequisites (account/region/credentials, Route 53 hosted zone, SES DNS, existing RDS identifier) | **staging deploy = URL-19 → URL-20** (not local dev, not CI, not unit/integration work) | Project owner supplies the checklist values held in URL-19 |

Everything else — URL-18, URL-7, URL-9, URL-10, URL-12, URL-13, URL-14, URL-15, URL-16, URL-21, URL-22, URL-23, URL-24, URL-25 (BLOCKED by design), URL-26 (BLOCKED by design) — may start on the wave order in readiness-audit §6.

### (b) Open human decisions — status and blocking effect

| X | Decision | Status | Blocking? | Warning in ticket text |
|---|---|---|---|---|
| **X-1** | CAPTCHA provider vendor (Q5 vendor half) | OPEN | **Non-blocking** for the epic; blocks **URL-25 only** (created BLOCKED) | ✅ URL-10 `⚠ ×2` + `X-1` ref; URL-25 `BLOCKED — … (X-1)` banner |
| **X-2** | GeoIP database vendor/license | OPEN | **Non-blocking**; blocks **URL-26 only** (created BLOCKED); URL-13 proceeds on the approved stub-file deviation | ✅ URL-26 `BLOCKED` + `Gated on X-2`; deviation recorded in its Dependencies |
| **X-3** | FR-3.1 delete-only vs reversible disable | OPEN | **Non-blocking** (current behavior kept = delete-only) | ✅ ⚠ D4 warnings in URL-12 |
| **X-4** | Cache-immediacy windows (E1: 30s/60s tolerance) | OPEN | **Non-blocking** (design §9.1/AD-1 TTLs kept); exception-window tests deferred → keeps `AC-FR-3.1` PARTIAL | ✅ ⚠ in URL-12 and URL-13, both defer to X-4 |
| **X-5** | AM-1/AC-03 charset conflict | OPEN | **BLOCKING for URL-11 start (B2)**; non-blocking for the rest; keeps `AC-03` PARTIAL | ✅ ⚠ ×2 in URL-11 + `X-5` ref; ⚠ in URL-8 |
| **X-6** | AM-2 — PRD header "Approved" vs footer "draft" (documentation only, PRD immutable) | OPEN | **Non-blocking** (documentation only) | ⚠ n/a — no ticket implements it; tracked in ticket-audit §D |
| **X-7** | AWS deployment prerequisites | OPEN | **BLOCKING for staging deploy (B3)** only | ✅ checklist lives in URL-19; values never invented |
| **X-8** | AC-NFR-3 availability ownership | **EXECUTED** | — | closed by URL-24 creation + URL-17/URL-16 edits |
| **X-9** | AC-FR-5.3 / AC-NFR-6 analytics-deletion test | **EXECUTED** | — | closed by URL-12 test + URL-14 annotation |
| **X-10** | NFR-9: confirm no MVP custom-domain work is acceptable | OPEN (coverage closed regardless) | **Non-blocking** — `NFR-9` is now COVERED via URL-19; X-10 is a confirmation of the no-work reading | ⚠ recorded in ticket-audit §F/§D; URL-19 states the non-goal explicitly |
| **X-11** | `REDIRECT_STATUS` knob vs fixed-302 default (C3) | OPEN, **wording applied** | **Non-blocking** — 302 pinned in URL-7/URL-13/URL-18; residual: URL-18's override phrasing is softer than URL-7's "requires a new human decision" | ✅ approved wording present in URL-7/URL-13/URL-18 |
| **X-12** | Missing ACs in requirements.md (no AC-NFR-5/7/8/9) | **Declined for now (D5)**, standing question | **Non-blocking** — spec files untouched; separate from the Jira work order | n/a |

**Non-blocking certification residuals (expected, documented):** `FR-2.7`, `AC-11` (X-1), `FR-3.1` (X-3), `AC-FR-3.1` (X-4), `AC-03` (X-5) stay **PARTIAL** until those rulings; none prevents coding, and each carries its ⚠/BLOCKED text.

### (c) Quality-gate FAIL cells → recommended follow-up edits for Dwight

| Ref | Cell | Fix | Blocks implementation? |
|---|---|---|---|
| **G1** | URL-8 (a) scope | Repair the spliced duplicate header block; restore `^[a-zA-Z0-9]{3,50}` in both CHECK mentions; add a comment citing this finding | **YES — blocks URL-8 start (B1)** |
| **G2** | URL-16 (c), URL-17 (c), URL-24 (c), URL-25 (c), URL-26 (c) | Add `is blocked by` links to **URL-19** (staging deployer) — their Verification text runs in staging | No — sequencing hygiene; wave order already implies it |
| **G2b** | URL-23 (c) | Add a link to **URL-20** (text already says "wire into URL-7/URL-20's CI") | No — sequencing hygiene |
| **G3** | URL-15 (e) verification | Add a `**Verification:**` line (e.g. "PNG/SVG bytes decode + payload equals the short URL; non-owner → 403, joint with URL-17 p95 row") | No — assertions in Acceptance are already testable |
| **G4** | invalid references | Replace stale aliases: `NEW-T2` → **URL-24** (URL-17 ×5, URL-16 ×1, URL-24 comment ×1), `NEW-T4` → **URL-26** (URL-13 ×1, URL-26 ×2); update epic URL-6 description (children URL-23…URL-26 exist, stats row is stale, X-8/X-9/X-13/X-14 are EXECUTED); align URL-7→URL-20 `AC-FR-9.1` pointer and URL-22's `AD-14` listing | No — text integrity only; no coverage impact |

**Blocking cells: 1 of 100 (G1).** The other 7 are non-blocking ticket-quality nits.

### (d) Verification honesty statement

All verdicts derive from ticket **text** read on 2026-10-25 and from stat/sha256 of files on disk — claims about documentation, not about tested or working software. **Could not verify:** (i) whether the 39 comments / 19 description edits / 16 issue links claimed by ticket-audit §G are *complete* relative to a pre-edit snapshot (I verified presence and content, not byte-diff history); (ii) human intent behind X-1…X-12 (only their recorded status); (iii) anything inside Jira beyond read APIs — no write was attempted, so no write-permission result exists.

---

*Phase 2 validation appended 2026-10-25 by Jim Halpert, Specification Agent. Phase-1 sections above are unchanged. Total = 119 · COVERED = 114 · PARTIAL = 5 (`FR-2.7`, `FR-3.1`, `AC-FR-3.1`, `AC-03`, `AC-11`) · UNCOVERED = 0 · gaps NFR-9 + AC-FR-7.1 CLOSED · contradictions new = 0 · invalid requirement IDs = 0 · gate = 92/100 PASS · verdict = **READY FOR IMPLEMENTATION** with blockers B1 (URL-8 text repair), B2 (X-5 before URL-11), B3 (X-7 before staging deploy).*

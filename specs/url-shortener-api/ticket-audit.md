# Backlog Quality Audit — Epic URL-6 (URL Shortener API MVP)

| Field | Value |
|---|---|
| **Artifact** | `specs/url-shortener-api/ticket-audit.md` |
| **Date** | 2026-10-25 (Phase 1) · **Phase 1b reconciliation with Jim 2026-10-25 — see §F** |
| **Author** | Dwight Schrute — Architect & Code Reviewer |
| **Requested by** | Michael (orchestrator) — Jira backlog quality audit, epic **URL-6** |
| **Phase** | **PHASE 1 / 1b — ANALYSIS ONLY. NO JIRA WRITES:** no comments, no edits, no links, no transitions, no new issues. Phase 2 authorization comes from Michael after the human answers the unified escalations (§D, X-list). |
| **Tickets audited** | **13** — epic URL-6 + 12 children: URL-7, URL-8, URL-9, URL-10, URL-11, URL-12, URL-13, URL-14, URL-15, URL-16, URL-17, URL-18 (each read in full: summary, description, issue links, type, status, comments, Agent Owner) |
| **Sources of truth (read-only)** | `PRD.md` (Approved, 2026-10-08, immutable) · `specs/url-shortener-api/requirements.md` (FR/NFR/AC IDs) · `specs/url-shortener-api/design.md` (D-*, AD-*, §11 resolution log, §13 readiness corrections) · context only: `readiness-audit.md` (2026-10-13) · **reconciled against:** `requirements-coverage.md` (Jim, 2026-10-25) |
| **Findings** | **26** — 0 Critical · 4 High · 14 Medium · 8 Low (merged with Jim — see §F) |
| **Escalations** | **14 unified (X-1…X-14)** (§D), merging Dwight E-1…E-7 with Jim E1…E13 |
| **Planned Jira changes** | §E — single authoritative Phase 2 work order: 13 ticket edit plans + 4 proposed new tickets + 2 new Blocks links + 2 split proposals (pending human approval) |

**Backlog state verified:** all 13 issues are `To Do`, assigned to Roy Melamed (`70121:29771871-…`), Agent Owner (`customfield_10043`) = Developer (10024) on the 12 children and Michael (10020) on the epic. Blocks topology = 14 links and matches `readiness-audit.md` §6 exactly (verified link-by-link). Comments exist only on URL-18 (2, referencing the readiness audit).

---

## A. TRACEABILITY MATRIX

Legend: **ticket(s)** = owning/implementing ticket(s). **GAP** = no ticket owns it (finding ref in parentheses). "Union" = functionally distributed across tickets but no single verification owner. Coverage statuses cross-checked against Jim's 119-ID matrix (`requirements-coverage.md` §1: 104 COVERED / 13 PARTIAL / 2 UNCOVERED) — deltas reconciled in §F.

### A.1 Functional requirements → tickets

| Req ID | Requirement (short) | Ticket(s) | Gap / note |
|---|---|---|---|
| FR-1.1 | Register email+password / Google+GitHub | URL-9 | — |
| FR-1.2 | Email verification gate before link creation | URL-9 (verification), URL-11 (403 gate) | AC split defect → F-07 |
| FR-1.3 | API keys + JWT dual auth | URL-9 | — |
| FR-1.4 | Account deletion w/ links + analytics | URL-9 (endpoint), URL-8 (FK cascades) | — |
| FR-2.1 | `POST /links` creates link | URL-11 | — |
| FR-2.2 | Auto-generated alphanumeric short code | URL-11 (D-5) | — |
| FR-2.3 | Custom slug 3–50 `[a-zA-Z0-9]` | URL-11 (+ URL-8 DB CHECK) | Open charset conflict not flagged → F-20 / X-5 |
| FR-2.4 | Collision → 409 + 3 suggestions; tombstones never released | URL-11 (+ URL-8, URL-14 tombstone audit) | — |
| FR-2.5 | Idempotency-Key | URL-11 (c2 single transaction) | — |
| FR-2.6 | Expiration at creation; permanent default | URL-11 (AD-6) | — |
| FR-2.7 | Rate limiting + CAPTCHA on create | URL-10 (limiter, CaptchaProvider interface/mode), URL-11 (gates in flow) | **Live challenge (post-vendor) has no ticket → G3/F-03/X-1**; Jim: PARTIAL |
| FR-3.1 | List/retrieve/edit/delete-disable | URL-12 | Delete/disable wording open (§10.4) not flagged → F-20 / X-3; E1 immediacy → X-4; Jim: PARTIAL |
| FR-3.2 | Ownership checks | URL-12 (also URL-14, URL-15) | Status code unspecified → F-17 |
| FR-3.3 | Single-resource ops only | URL-12 | — |
| FR-4.1 | Fast 302 redirect, no interstitial | URL-13 | Config knob not pinned → F-24 / X-11 |
| FR-4.2 | Expired → `410` JSON | URL-13 (c4 in-memory expiry) | — |
| FR-4.3 | Unknown/deleted → `404` JSON | URL-13 | — |
| FR-4.4 | Aggregate click count, no IP/PII | URL-13 (emit) + URL-14 (count) | AC citation missing → F-09 |
| FR-5.1 | Total/referrer/country analytics | URL-14 | GeoIP provisioning → G4/F-04/X-2 |
| FR-5.2 | Privacy: no IP/PII, aggregates, 30-day retention | URL-8 (schema gate), URL-13, URL-14 | — |
| FR-5.3 | Delete link + associated analytics | URL-12 (cascade), URL-14 (orphans) | **AC verification ownership split → F-25 / X-9** |
| FR-6.1 | QR for own links | URL-15 | — |
| FR-6.2 | PNG + SVG | URL-15 | — |
| FR-7.1 | Full REST API (accounts, links, analytics, QR) | Union: URL-9, URL-11, URL-12, URL-14, URL-15 | **UNCOVERED (Jim) — contract/OpenAPI verification → G1/F-01/X-13** |
| FR-7.2 | Consistent JSON error shape | URL-7 (envelope) | "every error response" unverified → F-01 |
| FR-7.3 | JSON bodies; redirect status on active | URL-7 + URL-13 | AC citations missing → F-16 |
| FR-8.1 | 100 req/min per user/key | URL-10 | — |
| FR-8.2 | `429` + retry guidance | URL-10 | — |
| FR-8.3 | No tiers; redirect traffic not app-limited | URL-10 | Cited only as "FR-8" → F-16 (Jim §4) |
| FR-9.1 | Serverless deployment | URL-7 (CDK, D-15) | **Route 53 + custom domain not in any ticket → G5/F-15** |
| FR-9.2 | PostgreSQL on existing AWS RDS | URL-8 (+ URL-7 RDS Proxy) | — |
| FR-9.3 | Local Postgres runnability | URL-7 + URL-18 | — |
| FR-10.1 | Structured JSON logging | URL-16 (+ URL-7 scaffold) | — |
| FR-10.2 | Health check endpoint(s) | URL-16 (+ URL-7 `/healthz`) | — |
| FR-10.3 | Metrics (rate, latency, errors, redirects) | URL-16 | — |
| FR-10.4 | OpenTelemetry tracing | URL-16 | — |
| FR-10.5 | Basic error alerting | URL-16 | **No AC verifies alerting (Jim E9) → F-10 / X-14** |
| FR-10.6 | Lightweight / local-dev friendly | URL-16 | **90% coverage gate (§7) absent from ticket text → G6/F-21** |

### A.2 Non-functional requirements → tickets

| NFR | Topic | Ticket(s) | Gap / note |
|---|---|---|---|
| NFR-1 | Redirect latency budgets | URL-17 (+ URL-13) | Budget misstated → F-05 |
| NFR-2 | 10k users / 1M links | URL-17 (+ URL-8 storage, URL-14) | — |
| NFR-3 | Availability / health | URL-17, URL-16, URL-13 | Resilience suite unowned → F-02; **AC-NFR-3 method gap → F-26 / X-8** |
| NFR-4 | Privacy (no IP/PII, 30-day) | URL-8, URL-13, URL-14 | AC-NFR-4 not cited → F-16 |
| NFR-5 | Security (rate limit, CAPTCHA, verification, ownership, auth) | URL-9, URL-10, URL-11, URL-12 | **requirements.md defines no AC-NFR-5 → X-12 (Jim E11)** |
| NFR-6 | Data lifecycle (delete links + analytics) | URL-12, URL-14 | AC-NFR-6 not cited + no link-level test → F-16, F-25 |
| NFR-7 | Portability / local dev | URL-7, URL-18 | **no AC-NFR-7 → X-12** |
| NFR-8 | Observability | URL-16 | — |
| NFR-9 | Single shared domain now; custom domains v2 | **Reconciled position (X-10):** no MVP *implementation* work (design §10.6 — my original "N/A"), **but Jim's UNCOVERED verdict is factually correct today**: no ticket text mentions NFR-9. Coverage closes via the URL-7 edit (F-15): single-shared-domain AC + extension-point doc ref. | Confirmation that unimplemented/unverified-in-MVP is acceptable → **X-10 (Jim E7)** |

### A.3 PRD acceptance criteria (AC-01…AC-13) → tickets

| AC | Topic | Ticket(s) |
|---|---|---|
| AC-01 | Signup & verification | URL-9 (see F-07 for the cross-ticket AC defect) |
| AC-02 | Create link (auto slug) | URL-11 |
| AC-03 | Custom slug + rejection/suggestions | URL-11 (⚠ PRD `my-campaign` example conflicts with AD-8 → **X-5**, Jim C1/C4; annotate AC-03 as "rejection+suggestions half only") |
| AC-04 | Idempotency replay | URL-11 |
| AC-05 | Redirect 302 | URL-13 |
| AC-06 | Expired 410 | URL-13 |
| AC-07 | Unknown/deleted 404 | URL-13 |
| AC-08 | Edit & delete / non-owner error | URL-12 (status code unspecified → F-17; analytics leg missing → F-25) |
| AC-09 | Analytics + privacy + 30-day | URL-14 |
| AC-10 | QR PNG + SVG | URL-15 |
| AC-11 | Rate limit 429 + CAPTCHA | URL-10 (live CAPTCHA path → G3 / X-1; Jim: PARTIAL) |
| AC-12 | Observability | URL-16 (excludes alerting — X-14) |
| AC-13 | Account deletion cascade | URL-9 (+ URL-8 cascades, URL-14 orphan rule); ID not cited → F-16 |
| **All of AC-01…AC-13** | Nightly E2E in staging (design §7) | **GAP → G2/F-02** |

### A.4 EARS acceptance criteria → tickets

| AC ID(s) | Ticket(s) | Note |
|---|---|---|
| AC-FR-1.1, AC-FR-1.3, AC-FR-1.4 | URL-9 | cited |
| AC-FR-1.2 | URL-9 (cited) + URL-11 (should own the create-gate assertion) | F-07 |
| AC-FR-2.1, AC-FR-2.2, AC-FR-2.3, AC-FR-2.4, AC-FR-2.5, AC-FR-2.6 | URL-11 | cited; AC-FR-2.1 exception window pending X-4 |
| AC-FR-2.7 | URL-10 | not cited by URL-11 → F-08 |
| AC-FR-3.1, AC-FR-3.2, AC-FR-3.3 | URL-12 | cited; **AC-FR-3.1 immediacy divergent between URL-12/URL-13 → Jim C2 absorbed into F-20 / X-4** |
| AC-FR-4.1, AC-FR-4.2, AC-FR-4.3, AC-FR-4.4 | URL-13 | **none cited in URL-13's AC list → F-09** |
| AC-FR-5.1, AC-FR-5.2a, AC-FR-5.2b | URL-14 | cited |
| AC-FR-5.3 | URL-14 cites, URL-12 implements | **no concrete link-level test → F-25 / X-9** |
| AC-FR-6.1, AC-FR-6.2, AC-FR-6.3 | URL-15 | cited |
| AC-FR-7.1 | — | **UNCOVERED (Jim) → F-01 / X-13 (NEW-T1)** |
| AC-FR-7.2, AC-FR-7.3 | URL-7 / URL-13 (partial) | verification owner GAP → F-01, F-16 |
| AC-FR-8.1, AC-FR-8.2 | URL-10 | cited |
| AC-FR-9.1, AC-FR-9.2, AC-FR-9.3 | URL-7, URL-8, URL-18 | not cited in AC lists → F-16 |
| AC-FR-10.1 … AC-FR-10.4 | URL-16 | covered via AC-12 → F-16 (citations) |
| AC-FR-10.5 | URL-16 (implemented) | **no verification statement (Jim E9) → F-10 / X-14** |
| AC-NFR-1, AC-NFR-2 | URL-17 | cited |
| AC-NFR-3 | URL-17 cites | **no availability verification method → F-26 / X-8** |
| AC-NFR-4 | URL-8, URL-13, URL-14 | not cited → F-16 |
| AC-NFR-6 | URL-12 | not cited + no link-level test → F-16, F-25 |
| AC-NFR-5 / AC-NFR-7 / AC-NFR-8 / AC-NFR-9 | **do not exist in requirements.md** | **spec gap → X-12 (Jim E11)** |

### A.5 Design decisions → tickets

| Decision | Topic | Ticket(s) | Status in backlog |
|---|---|---|---|
| AD-1 | 302 + `no-store`, Tier-1 only, no CDN | URL-13 (+ URL-17 "no CDN" AC) | ✔ (+ E1/X-4 warning present); **knob unpinned → F-24 / X-11** |
| AD-2 | Transient request-time GeoIP, no edge | URL-13 | ✔ (provisioning → F-04 / X-2) |
| AD-3 | CaptchaProvider, mode `suspicious` | URL-10 | ✔ (+ vendor warning present → X-1) |
| AD-4 | Authenticated create only, anonymous → 401 | URL-11 | ✔ |
| AD-5 | Slugs never released | URL-11, URL-8, URL-14 | ✔ |
| AD-6 | PATCH = `destinationUrl` only | URL-11, URL-12 | ✔ |
| AD-7 | In-app Postgres sliding window, uniform 100/min | URL-10 | ✔ |
| AD-8 | Strict `[a-zA-Z0-9]` + 3 suggestions | URL-11, URL-8 | ⚠ implemented but conflict flag missing → F-20 / X-5 |
| AD-9 | Un-capped BIGINT totals | URL-8, URL-14 | ✔ |
| AD-10 | No raw events; 30-day buckets; permanent totals | URL-14 | ✔ |
| AD-11 | Multi-AZ confirmed; budgets & 99.9% stand | URL-17, URL-8 | ✔ budgets; **99.9% leg unverifiable as scoped → F-26 / X-8** |
| AD-12 | AWS Lambda + HTTP API; dual entrypoint | URL-7 | ✔ |
| AD-13 | Hard-delete cascade | URL-9, URL-8 | ✔ |
| AD-14 | Google + GitHub only; double opt-in | URL-9 | ✔ |
| AD-15 | QR payload = short URL; `?format=`; no styling | URL-15 | ✔ |
| D-1 | 4 functions, Lambda + HTTP API | URL-7 | ✔ |
| D-2 | Fastify/TS dual entrypoint | URL-7, URL-18 | ✔ |
| D-3 | `pg` + parameterized SQL + `node-pg-migrate` | URL-18 (tool pinned), URL-8 (migrations) | ✔ (tool not named in URL-8 → planned edit) |
| D-4 | RDS Proxy for all deployed DB access | URL-7, URL-8 | ✔ |
| D-5 | 7-char base62, retry ≤8 | URL-11 | ✔ |
| D-6 | Tombstone reservations; 409 + 3 suggestions | URL-11 | ✔ |
| D-7 | Idempotency single ACID transaction (c2) | URL-11 (+ URL-8 state comment) | ✔ |
| D-8 | SQS → dedup → buckets + totals (c1) | URL-14 (+ URL-13 emit, URL-8 table) | ✔ |
| D-9 | Tier-1 LRU 60s/30s + `no-store` | URL-13 | ✔ (+ E1 warning → X-4) |
| D-10 | Postgres sliding window, `user:`/`apikey:` | URL-10 | ✔ |
| D-11 | Self-managed auth (argon2id, JWT, hashed keys) | URL-9 | ✔ |
| D-12 | QR on demand, never stored | URL-15 | ✔ |
| D-13 | pino + OTel → ADOT/CloudWatch/X-Ray; Jaeger local | URL-16 | ✔ |
| D-14 | `'ZZ'` sentinel, host-only referrer, BIGINT | URL-14 (+ URL-8, URL-13) | ✔ |
| D-15 | CDK + GitHub Actions, staging → human gate → prod | URL-7 | ✔ (EventBridge scheduler missing → F-14) |
| §7 testing layers (Unit / Integration / Crash / Contract / Privacy / CAPTCHA / Load / E2E / Resilience) | Unit ✔ · Integration ✔ · Crash ✔ URL-11/14 · Privacy partial ✔ · CAPTCHA ✔ URL-10 · Load ✔ URL-17 | **Contract ✗ (F-01/X-13) · E2E ✗ · Resilience + AC-NFR-3 ✗ (F-02, F-26/X-8) · 90% coverage gate ✗ (F-21)** |

### A.6 Reverse map — ticket → requirement / decision IDs covered

| Ticket | Type | Requirements covered | Decisions | ACs cited in ticket |
|---|---|---|---|---|
| URL-6 (epic) | Epic | (container — no implementation scope) | — | none (epic) |
| URL-7 | Task | FR-7.2, FR-9.1, FR-9.3, FR-10.1 (scaffold), NFR-7 | D-1, D-2, D-4, D-15, AD-12 | none cited explicitly (envelope AC only) |
| URL-8 | Task | FR-9.2, FR-1.4 (cascades), FR-5.2 (privacy gate), NFR-2, NFR-4 | D-4, AD-4, AD-5, AD-8, AD-9, AD-10, AD-11, AD-13, c1–c3 | none cited explicitly |
| URL-9 | Story | FR-1.1, FR-1.2, FR-1.3, FR-1.4, NFR-5 | D-11, AD-13, AD-14 | AC-FR-1.1…1.4, AC-01 |
| URL-10 | Task | FR-8.1, FR-8.2, FR-8.3, FR-2.7 | D-10, AD-3, AD-7 | AC-FR-8.1, AC-FR-8.2, AC-11 |
| URL-11 | Story | FR-1.2 (gate), FR-2.1–FR-2.6, FR-2.7 (gates), NFR-5 | D-5, D-6, D-7, AD-4, AD-5, AD-6, AD-8, c2 | AC-FR-2.1…2.6, AC-02, AC-03, AC-04 |
| URL-12 | Story | FR-3.1, FR-3.2, FR-3.3, FR-5.3, NFR-6 | AD-5, AD-6 | AC-FR-3.1…3.3, AC-08 — **missing AC-FR-5.3, AC-NFR-6 (Michael spot-check; Jim E12 → F-25/X-9)** |
| URL-13 | Story | FR-4.1–FR-4.4, NFR-1, NFR-3, NFR-4 | D-9, AD-1, AD-2, c1, c3, c4 | AC-05, AC-06, AC-07 |
| URL-14 | Story | FR-5.1, FR-5.2, FR-5.3, FR-4.4, NFR-4 | D-8, D-14, AD-9, AD-10, AD-5, c1, c3 | AC-FR-5.1, AC-FR-5.2a/b, AC-FR-5.3, AC-09 |
| URL-15 | Story | FR-6.1, FR-6.2, FR-3.2 | D-12, AD-15 | AC-FR-6.1…6.3, AC-10 |
| URL-16 | Task | FR-10.1–FR-10.6, NFR-8, NFR-3 (health) | D-13 | AC-12 only — **missing AC-FR-10.1…10.5 (F-10/X-14)** |
| URL-17 | Task | NFR-1, NFR-2, NFR-3 | AD-11, §10.1–10.3 | AC-NFR-1…3 — **AC-NFR-3 has no method (F-26/X-8)** |
| URL-18 | Task | FR-9.3, NFR-7, FR-10.6 (tooling configs) | D-2, D-3 | none cited explicitly; **exposes `REDIRECT_STATUS` (F-24/X-11)** |
| **GAP (no ticket)** | — | **FR-7.1/7.2/7.3 contract verification (AC-FR-7.1) · FR-2.7 live CAPTCHA challenge · AD-2 GeoIP DB provisioning · FR-9.1 Route 53/custom-domain routing + NFR-9 ticket text · §7 E2E + Resilience suites + AC-NFR-3 method · §7 90% coverage gate · §3.7 EventBridge Scheduler trigger** | — | **Never cited anywhere (Jim §4): FR-7.1, FR-8.3, FR-10.5, NFR-9, AC-FR-2.7, AC-FR-4.1–4.3, AC-FR-7.2/7.3, AC-FR-9.1/9.2, AC-FR-10.1–10.3/10.5, AC-NFR-4, AC-NFR-6, AC-13 → F-16** |

---

## B. FINDINGS TABLE

| ID | Ticket | Category | Sev | What is wrong | Proposed fix | Backed by |
|---|---|---|---|---|---|---|
| **F-01** | BACKLOG | 6. Testing | **High** | No ticket owns the **contract test layer**: Fastify JSON Schemas ↔ generated OpenAPI, snapshots, consumer response validation. URL-7's pipeline runs only "unit/integration"; URL-18 creates `tests/contract/` but no ticket implements it. AC-FR-7.1/7.2/7.3 ("one consistent JSON error schema across **all** endpoints") have no verification owner. **Jim: AC-FR-7.1 UNCOVERED (his E8) — same gap.** | New ticket **NEW-T1** (§E.2) implementing design §7 Contract row; wire into URL-7 CI. **Single-track: Jim E8 = this finding (X-13).** | design §7 (Contract row), §5.1; requirements AC-FR-7.1/7.2/7.3, FR-7.1 |
| **F-02** | BACKLOG | 6. Testing | **High** | No ticket owns **staging E2E (AC-01…AC-13 nightly)** or the **resilience suite** (RDS failover/proxy blip → 5xx + `/readyz` red; DLQ path; aggregator retry). URL-7 CI stops at "migrate → smoke" with "smoke" undefined. **Availability verification ownership is therefore unassigned — see F-26.** | New ticket **NEW-T2** (§E.2), which also becomes the owner of AC-NFR-3 verification (F-26/X-8); define smoke scope in URL-7 as the design §9.6 AC-set smoke. | design §7 (E2E, Resilience rows), §9.6, §8.5; requirements AC-01…AC-13, NFR-3, AC-NFR-3 |
| **F-03** | BACKLOG | 1. Missing req. | Medium | FR-2.7's **live CAPTCHA challenge** has no future ticket: URL-10 correctly ships interface + `suspicious` mode only and says "wire the real adapter once the vendor is chosen" — but nothing tracks that follow-up. AC-11's CAPTCHA leg stays unimplemented indefinitely. | New ticket **NEW-T3** (§E.2), blocked by the human vendor decision (X-1) and by URL-10. | requirements FR-2.7, AC-FR-2.7, AC-11, §8.5#2; design §10.8, §11.2 |
| **F-04** | BACKLOG | 1. Missing req. | Medium | **GeoIP database provisioning** (Lambda layer build + local-dev file) is unowned. URL-7 only mentions a "local geo DB file" inside compose; no ticket provisions the deployed layer, and no vendor/license is chosen. AD-2 Option B cannot ship without it. | New ticket **NEW-T4** (§E.2) gated on escalation X-2 (vendor/license); alternatively extend URL-7 + URL-18 env contract — Michael's call. | design §10.9, §3.9, §1.3, AD-2; requirements §8.5#3 |
| **F-05** | URL-17 | 4. Tech. inconsistency | **High** | Scope states "**redirect warm p95 ≤120ms**" as if it were a single budget. design §9.1 has **three** redirect rows: warm **cache hit p95 ≤60ms**, warm **cache miss p95 ≤120ms**, cold p99 ≤1000ms. As written, a 110ms cache-hit p95 would pass URL-17 while violating the design by ~2×. | Replace the paraphrase with the full §9.1 table and make each row an individually measured AC (including analytics/QR p95 ≤600ms, currently omitted). | design §9.1; requirements NFR-1, AC-NFR-1 |
| **F-06** | URL-17 | 5. Dependencies | **High** | Missing Blocks links: URL-17 validates "authenticated API mutations p95 ≤500ms" and the "Analytics read / QR generation" budget row, but is blocked only by URL-13 + URL-14. **URL-12** (mutations) and **URL-15** (QR) are not blockers, so URL-17 can run early and sign off "all budgets met" with two budget rows never measured. | Add Blocks **URL-12 → URL-17** and **URL-15 → URL-17** (§E.0). | design §9.1 (rows), §7 (Load/perf); requirements AC-NFR-1 |
| **F-07** | URL-9 | 3. Incomplete AC | Medium | AC states "**unverified user gets error on link creation until verified**" — but the create endpoint ships in **URL-11, which is blocked by URL-9**. The AC cannot be verified inside the ticket that cites it (circular). The actual gate code lives in URL-11 (403 `EMAIL_NOT_VERIFIED`), which does not cite AC-FR-1.2 at all. | Split: URL-9 verifies verification endpoint/token/expiry semantics (AC-FR-1.1, AC-FR-1.3, AC-FR-1.4, AC-01); move the create-gate assertion to URL-11 with AC-FR-1.2 + a test. | requirements AC-FR-1.2, FR-1.2; design §3.4 step 3, §6.1; URL-9/URL-11 Blocks topology |
| **F-08** | URL-11 | 3. Incomplete AC | Low | AC list cites AC-FR-2.1…2.6 but omits **AC-FR-2.7** (rate-limit/CAPTCHA failure blocks create), even though the flow includes both gates. Scope also omits two §3.4/§6.4 details: reserved slugs `healthz`/`readyz` rejected, and the success response shape `{id, slug, shortUrl, destinationUrl, createdAt, expiresAt}`. | Add AC-FR-2.7 cross-reference (joint test with URL-10), reserved-word rejection bullet, and response-shape line. | requirements AC-FR-2.7, FR-2.7; design §3.4 step 9, §6.4 |
| **F-09** | URL-13 | 3. Incomplete AC | Low | AC list cites only AC-05/06/07 — **AC-FR-4.1…AC-FR-4.4 are not cited**, and no AC asserts the *count actually increments* on a served redirect (the AC list only checks message shape). Count correctness is the product-visible half of FR-4.4. | Cite AC-FR-4.1/4.2/4.4; add joint test with URL-14: one redirect → +1 in `links.click_count` after aggregation; keep AC-06/07 + c4. | requirements FR-4.4, AC-FR-4.1/4.2/4.4; design §3.2 steps 4–6 |
| **F-10** | URL-16 | 3. Incomplete AC | Medium | Acceptance is one line ("AC-12 — health responds, JSON logs emitted, metrics cover all four domains, tracing works in local dev" — *Michael's spot-check confirms verbatim*). **AC-FR-10.1…AC-FR-10.5 are uncited**, and **AC-12 excludes alerting** although FR-10.5 alarms are in scope: **no acceptance verifies alerting (Jim E9)**; no log-shape assertion (no `clientIp`) in CI, no metric-presence checks, no alarm-config check. | Add AC-FR-10.1…10.5 citations + explicit tests: alert-verification AC (force error → alarm state change / SNS path tested in staging), log-shape assertion (CI), one emitted metric per §8.3 family, alarm set matches §8.5, `/readyz` fails when DB unreachable. **Single-track: Jim E9 = this finding (X-14).** | requirements AC-FR-10.1…10.5, FR-10.5; design §7 (Privacy regression row), §8.2–8.5 |
| **F-11** | URL-7 | 7. Sizing | Medium | **Too big.** One ticket = (a) dual-entrypoint app skeleton + error envelope + pino scaffold, (b) docker-compose dev env, (c) full CDK: API GW HTTP API + routes, 4 Lambdas in VPC, SQS+DLQ, Secrets Manager, RDS Proxy, reserved concurrency, (d) secrets/config module, (e) end-to-end CI/CD with human approval gate. Three independently verifiable units with different review surfaces (app code vs IaC vs pipeline). | **Proposed split (pending human approval — §E.3):** URL-7a app skeleton + compose + config module; URL-7b CDK infra (incl. Route 53 per F-15, Scheduler per F-14); URL-7c CI/CD pipeline. | design §1.3, §3.1, §6.3, §9.6, D-1/D-2/D-15; readiness-audit §1#2/5/6/10 |
| **F-12** | URL-9 | 7. Sizing | Medium | **Too big.** Combines: password auth + rotating refresh with reuse detection, double opt-in email (SES + SMTP/MailHog), Google **and** GitHub OAuth (code + PKCE), API-key CRUD + hashing, auth middleware, and account hard-delete cascade — four separable review units behind one AC line. | **Proposed split (pending human approval — §E.3):** URL-9a identity + sessions + email verification; URL-9b social OAuth (Google+GitHub); URL-9c API keys + auth middleware; deletion rides URL-9a. If kept whole, add per-area AC checklist. | design §3.3, §3.8, §6.1, D-11, AD-13/AD-14; requirements FR-1.1–1.4 |
| **F-13** | URL-14 | 7. Sizing | Low | Borderline: aggregator + **five** maintenance jobs (bucket purge, dedup GC, idempotency GC, rate-limit hygiene, tombstone audit) + the analytics read API. Cohesive by data ownership, but maintenance jobs are schedule/infra-shaped, not analytics-shaped. | Acceptable to keep (single owner, no duplication). If schedule pressure appears, split maintenanceFn jobs into a follow-up; do **not** move jobs into URL-8 (schema ≠ job logic). | design §3.6, §3.7, §4.3 |
| **F-14** | BACKLOG | 5. Dependencies | Medium | **`maintenanceFn` scheduling (EventBridge Scheduler)** appears in no infra ticket. URL-7's CDK bullet lists API GW, 4 Lambdas, SQS+DLQ, Secrets, RDS Proxy, concurrency — no scheduler rule/trigger. URL-10 and URL-14 define *what* the jobs do but neither deploys the trigger; local parity (how jobs run locally) is undefined. | Add EventBridge Scheduler (daily/hourly cadences per §3.7) + local invocation path (npm script / cron) to URL-7 scope, cross-referenced from URL-14. | design §3.7, §1.2 (maintenanceFn), D-15 |
| **F-15** | BACKLOG | 1. Missing req. | Medium | **Route 53 + custom domain** (single shared domain) is in no ticket's scope. design §3.1 requires Route 53 + API Gateway HTTP API on one custom domain; URL-7 lists routes but never mentions DNS/domain mapping. **No ticket mentions NFR-9 at all (Jim: UNCOVERED).** Without the URL-7 edit the redirect URL `GET /{shortCode}` has no public origin in staging/prod, and NFR-9 stays uncovered. | Add to URL-7 (or 7b if split): hosted zone/custom-domain mapping + cert; **+NFR-9 line and AC: single shared domain only, no per-user/custom-domain configuration (design §10.6 extension point documented)** — this closes Jim's NFR-9 coverage gap (X-10). | design §3.1, §1.2, §10.6; requirements FR-9.1, NFR-9 |
| **F-16** | BACKLOG | 3. Incomplete AC | Low | AC citations missing from every ticket's acceptance list: **AC-FR-4.1–4.4** (URL-13), **AC-FR-7.1–7.3** (URL-7/13), **AC-FR-9.1–9.3** (URL-7/8/18), **AC-FR-10.1–10.5** (URL-16), **AC-NFR-4** (URL-8/13/14), **AC-NFR-6** (URL-12), **AC-13**, **AC-FR-2.7**, **FR-8.3** (cited only as "FR-8"). **Extended per Jim §4 never-cited list:** FR-7.1, FR-10.5, NFR-9, AC-FR-4.1–4.3, AC-FR-7.2/7.3, AC-FR-9.1/9.2, AC-FR-10.1–10.3/10.5. Implementations mostly exist; the *verification hooks* are unreferenced. | Apply the per-ticket citation edits in §E (mechanical, no scope change). | requirements §7 traceability table; design §12; requirements-coverage §4 |
| **F-17** | URL-12 | 3. Incomplete AC | Low | "non-owner → authorization error" leaves the status/code open — design §5.2 specifies **403** for non-owner (`FORBIDDEN`). Non-testable as written ("authorization error" could be 401/403/404). | Specify `403 FORBIDDEN` (and 401 for unauthenticated) in scope + AC; test both. | design §5.2, §5.1 code list; requirements AC-FR-3.2, AC-08 |
| **F-18** | URL-17 | 2. Vague scope | Medium | "Seed 1M links / 10k users **locally or staging**" — environment left open, though design §7 assigns load/perf to **k6 in staging** (seeded 1M-link DB). "Locally" cannot exercise Lambda/RDS Proxy/concurrency math at all (§9.4), so the choice materially changes what the ticket proves. | Fix environment = staging (design §7); define seed script ownership (URL-17 owns `tests/load/seed`, reusing URL-8 migrations). | design §7 (Load/perf row), §9.1, §9.4; requirements NFR-1, NFR-2 |
| **F-19** | URL-16 | 5. Dependencies | Low | URL-16 is blocked only by URL-7, yet its metrics catalog includes counters emitted by later waves (`redirect.requests{result,cache}` — URL-13, `captcha.*` — URL-10, `geo.*` — URL-13, `links.created` — URL-11). The ticket gives no integration plan, so instrumentation can be forgotten and silently shipped absent. | Add a scope note: instrument the shared logging/metrics/tracing spine immediately (URL-7 wave); register per-feature metric hooks as an AC checklist keyed by §8.3 metric names; no new Blocks links needed (readiness-audit §6 already schedules it across waves 1–5). | design §8.3, §8.4; readiness-audit §6 |
| **F-20** | URL-11, URL-12, URL-8 | 4. Tech. inconsistency | Medium | **Open human decisions implemented silently — no ⚠ open-flag note on the dependent tickets** (unlike URL-10's vendor warning and URL-13's E1 warning): (a) URL-11/URL-8 enforce AD-8 strict charset while **requirements §8.5#1 flags the unresolved AM-1 conflict** (PRD AC-3's own example `my-campaign` would be rejected) — *Jim C1/C4*; (b) URL-12 implements hard `DELETE` while **FR-3.1 "delete/disable" wording is still open** (§10.4) — *Jim E4*; (c) **URL-12 lists AC-FR-3.1 with no tolerance while URL-13 implements ≤60s deleted-as-active / ≤30s negative cache — the two tickets hold divergent readings of one AC, and URL-12 never mentions E1 — *Jim C2 (absorbed)***. Risk: a developer "fixes" the hyphen rejection, adds a disable endpoint, or adds cache invalidation without authority. | Add ⚠ open-decision notes: URL-11 + URL-8 ("AD-8 as written — no hyphens without a new human ruling" — X-5); URL-12 ("delete-only per §10.4 — no `disabled_at`" — X-3; "AC-FR-3.1 immediacy subject to X-4 — the ≤60s/≤30s windows are URL-13's documented behavior; no cache invalidation") and defer exception-window tests to the X-4 ruling. | requirements §8.5#1/#4/#6; design §10.4, §11.2, AD-8, §13.3; requirements-coverage C1/C2, E4 |
| **F-21** | URL-18 | 6. Testing | Medium | The readiness audit records that URL-18 owns "**vitest + 90% line-coverage gate on auth/links** (design §7)" — but the actual URL-18 text only pins `vitest` and defines a `test` script with a "placeholder suite". **No ticket contains the coverage gate**, so design §7's only quantitative test bar can silently disappear. | Add to URL-18: vitest coverage config with thresholds (90% lines on `src/auth`, `src/links` once those modules exist; placeholder-tolerant until then) + `npm run test:coverage`; referenced by URL-7 CI. | design §7 (Unit row); readiness-audit §1#10 (claim vs actual) |
| **F-22** | URL-6 | 2. Vague scope | Low | Epic description predates the readiness review and this audit: no reference to `readiness-audit.md`, no mention of **URL-18** or the 12-child wave order, no pointers to design §13 (c1–c4) / §13.3 (E1). The epic is the squad's entry point. | Refresh epic description: add readiness-audit.md + the two Phase-1 artifacts as sources, list the 12 children + wave order (readiness-audit §6), note open escalations (X-list). | readiness-audit §6; design §13 header |
| **F-23** | URL-10, URL-14 | 4. Tech. inconsistency | Low | **Duplicate ownership** of the rate-limit hygiene job: URL-10 scope says "Hygiene job: delete expired window rows (design §3.7)"; URL-14's maintenanceFn list *also* includes "rate-limit hygiene". Two tickets can implement or test the same job differently. | Assign: **URL-14 owns all `maintenanceFn` jobs incl. scheduling & registration**; URL-10 owns limiter SQL/logic only and hands the purge to URL-14. One-line edit in each ticket. | design §3.7 (job table), §3.6/§6.6 |
| **F-24** | URL-18 | 4. Tech. inconsistency | **Medium** | **`REDIRECT_STATUS` env knob vs the decided 302 default (Jim C3/E13).** URL-18's `.env.example` contract enumerates `REDIRECT_STATUS` with a placeholder only; nothing in any ticket pins the value, while FR-4.1/AC-FR-4.1/AD-1 fix the product default at **302 + `no-store`** with the rationale "accurate origin click counts" (design §5.3 keeps the knob "for operational flexibility; product default fixed at 302"). A deployment could set `301` and silently violate AC-FR-4.1 and the origin-count guarantee. **Severity Medium (not Low):** the failure mode is silent, product-visible (click-count accuracy), and contradicts a human-resolved decision (AD-1); the fix is cheap but spans three tickets. *Michael's spot-check confirms the knob exists in URL-18 and design.md line 435 keeps it configurable.* | Edit **URL-18**: document `REDIRECT_STATUS` as "default **302** — fixed by AD-1/AC-FR-4.1; changing requires a new human decision" + config validation rule. Edit **URL-7** (config module): same contract rule, never-hardcoded. Edit **URL-13**: AC asserting the deployed default behaves as 302 + `no-store` (integration test). Wording ruling → X-11. | requirements FR-4.1, AC-FR-4.1; design §5.3, §3.2 step 4, AD-1; requirements-coverage C3/E13 |
| **F-25** | URL-12, URL-14 | 3. Incomplete AC | Medium | **AC-FR-5.3 / AC-NFR-6 verification ownership is split and nowhere stated (Jim E12; Michael's spot-check confirms URL-12's Acceptance is literally "AC-FR-3.1, AC-FR-3.2, AC-FR-3.3, AC-08").** URL-12 *implements* the link-level analytics cascade but cites neither AC and states no test; URL-14 *cites* AC-FR-5.3 but its scope covers only orphaned-linkId handling; URL-8's cascade test is **account-level**, not link-level. AC-08 covers deletion but not the analytics-removal leg. | URL-12: cite **both** AC-FR-5.3 and AC-NFR-6 and add the explicit test — `DELETE /v1/links/{id}` → link row **and** its `click_buckets_daily`/`referrer_buckets_daily`/`country_buckets_daily`/`referrer_totals`/`country_totals` rows are all gone. URL-14 keeps only the orphaned-linkId test and cross-references URL-12. | requirements FR-5.3, AC-FR-5.3, NFR-6, AC-NFR-6; design §4.2; requirements-coverage §5#4/#5, E12 |
| **F-26** | URL-17 | 6. Testing | Medium | **AC-NFR-3 / 99.9% availability has no verification method (Jim E10).** URL-17 cites AC-NFR-3 but its scope verifies only latency budgets, cache hit-rate and connection math — no availability, soak or failover verification; AD-11's human-confirmed 99.9% monthly target (§9.1/§9.3) is unverifiable as scoped. | **Ownership assigned (§E):** **NEW-T2 owns AC-NFR-3 verification** — RDS failover/proxy-blip fault injection → 5xx + `/readyz` red, DLQ drain path, aggregator retry, alarm→SNS firing, and a bounded staging availability report vs the 99.9% target. URL-17's AC-NFR-3 is satisfied by referencing NEW-T2's evidence; **if NEW-T2 is not created, URL-17 MUST absorb this verification before claiming AC-NFR-3.** URL-16 supplies the ongoing measurement (uptime probe on `/readyz`, 5xx-rate alarm vs budget). Confirmation of this method → X-8. | requirements NFR-3, AC-NFR-3; design §7 (Resilience row), §9.3, §8.5, AD-11; requirements-coverage §5#3, E10 |

**Category tally:** (1) missing requirements — F-03, F-04, F-15 · (2) vague descriptions — F-18, F-22 · (3) incomplete AC — F-07, F-08, F-09, F-10, F-16, F-17, F-25 · (4) technical inconsistencies — F-05, F-20, F-23, F-24 · (5) dependencies — F-06, F-14, F-19 · (6) testing — F-01, F-02, F-21, F-26 · (7) sizing — F-11, F-12, F-13. **Total 26 = 4 High + 14 Medium + 8 Low, 0 Critical.**

---

## C. PER-TICKET VERDICT

| Ticket | Verdict | Sizing rationale |
|---|---|---|
| **URL-6** (epic) | **Needs edits** | Container only — no sizing issue. Description refresh needed (F-22): missing readiness-audit.md, both Phase-1 artifacts, URL-18, wave order, X-list. |
| **URL-7** | **Too big** (also needs edits) | 5 separable deliverables (app skeleton / compose / CDK-infra / config-secrets / CI-CD) spanning application code, IaC and pipeline — the largest ticket in the backlog by review surface (F-11). Split candidate (§E.3, pending human approval); also needs Route 53 + NFR-9 line (F-15/X-10), EventBridge Scheduler (F-14), REDIRECT_STATUS contract rule (F-24), smoke definition (F-02). |
| **URL-8** | **Ready** (minor edits) | Well-scoped, single responsibility (schema + migrations + pool), c1–c3 corrections correctly incorporated, ACs testable. Minor: cite AC-FR-9.2/NFR-2/NFR-4 + name `node-pg-migrate` (D-3); add AD-8 conflict warning (F-20/X-5). |
| **URL-9** | **Too big** (also needs edits) | 4 separable units behind one AC line (F-12); plus the circular create-gate AC (F-07). Split or add a per-area AC checklist. |
| **URL-10** | **Ready** (minor edits) | Scope precise (subject keys, window math, risk inputs, dummy adapter for CI), open vendor decision correctly flagged (X-1), ACs testable. Minor: add AC-FR-2.7 + FR-8.3 citations, hygiene-job ownership handoff (F-23). |
| **URL-11** | **Needs edits** | Core story, upper size bound but cohesive (one create flow, one transaction) — acceptable. Edits: AC-FR-2.7 ref, reserved slugs, response shape (F-08), ⚠ charset conflict (F-20/X-5), create-gate AC moved here (F-07). |
| **URL-12** | **Needs edits** | Right-sized (4 endpoints, one concern). Edits: `403 FORBIDDEN` (F-17), **cite AC-FR-5.3 + AC-NFR-6 with the explicit link-level analytics-deletion test (F-25/X-9)**, ⚠ delete/disable + **⚠ E1/AC-FR-3.1 divergence note (F-20/X-3, X-4)**, Blocks → URL-17 (F-06). |
| **URL-13** | **Needs edits** | Right-sized and the best-written ticket (c1/c3/c4 + E1 warning all present). Edits: cite AC-FR-4.1–4.4 + count-increment test (F-09), defer exception-window tests to X-4, assert deployed `REDIRECT_STATUS` default behaves as 302 (F-24). |
| **URL-14** | **Needs edits** (borderline size) | Three concerns (aggregator / maintenanceFn / read API) — cohesive under data ownership, keep unless schedule pressure (F-13). Edits: hygiene-job ownership (F-23), AC-NFR-4 citation, cross-ref AC-FR-5.3 test → URL-12 (F-25). |
| **URL-15** | **Ready** (one dependency edit) | Smallest feature ticket — but a complete, independently shippable FR-6 unit with 3 testable ACs. **Not a merge candidate.** Only change: +Blocks URL-15 → URL-17 (F-06). |
| **URL-16** | **Needs edits** | Scope complete against §8 but acceptance is one line (F-10): add AC-FR-10.1–10.5 + alert-verification AC (X-14) + verification expectations + cross-wave instrumentation note (F-19) + availability-measurement role (F-26). Not too big: cross-cutting by nature, one instrumentation spine. |
| **URL-17** | **Needs edits** | Right-sized validation ticket, but currently *unverifiable/incorrect*: wrong budget paraphrase (F-05), ambiguous environment (F-18), missing blockers (F-06), **AC-NFR-3 with no method (F-26/X-8)**. Fix before any work starts — this ticket is the release gate. |
| **URL-18** | **Needs edits** | Right-sized foundation ticket, correct precedence (blocks 7 & 8). Edits: **pin/document `REDIRECT_STATUS` = 302 (F-24/X-11)**, add the 90% coverage gate (F-21), cite AC-FR-9.3, add 302-default test. |

**No ticket is "Too small".** The two smallest (URL-15 QR, URL-18 foundation) each map to a distinct requirement cluster (FR-6 / FR-9.3+NFR-7) with independent ACs and independent blockers; merging them into neighbours would recreate the coverage gaps the 2026-10-13 readiness review just closed.

---

## D. UNIFIED ESCALATIONS — X-list (for the human; NOT resolved by any agent)

> **Stable numbering — quotable.** Merges Dwight's original E-1…E-7 with Jim's original E1…E13 (Jim's C1–C4 contradictions map into X-4/X-5/X-11 as noted). "Blocks Phase 2" = whether the Phase 2 Jira write for the named ticket(s) cannot be finalized without this answer.

| ID | Topic | Dwight orig. | Jim orig. | Owner | Blocks Phase 2? |
|---|---|---|---|---|---|
| **X-1** | CAPTCHA provider **vendor** (Q5 vendor half): interface/`suspicious` mode ship per AD-3; no vendor named → FR-2.7/AC-11 live challenge unverifiable | E-1 | E2 | Human (Michael) | **Partial** — blocks creating NEW-T3 only; no other edit waits |
| **X-2** | GeoIP database **vendor/license** for AD-2 Option B (Lambda layer + local file) | E-2 | E3 | Human/Developer | **Partial** — blocks creating NEW-T4 only (or the URL-7 alternative) |
| **X-3** | FR-3.1 **"delete/disable" wording**: delete-only vs reversible disable (`disabled_at`) | E-3 | E4 | Human (Michael) | **Partial** — URL-12 warning edit can ship; URL-12's *final* AC wording (delete-only vs disable endpoint) waits |
| **X-4** | **E1 redirect cache-immediacy windows** (design §13.3): (a) deleted link may 302 ≤60s vs AC-FR-3.1; (b) new slug may 404 ≤30s vs AC-FR-2.1; (c) edit propagation ≤60s confirm; Options A/B/C; **Jim's C2 = URL-12/URL-13 divergent readings of AC-FR-3.1** | E-4 | E6 (+ C2) | Human (Michael) | **Yes** — final AC tolerance wording for URL-12/URL-13 and resolution of C2; Option C must not be implemented |
| **X-5** | **AM-1 / AC-03 slug-charset conflict**: AD-8 strict `[a-zA-Z0-9]` (2026-10-12) vs earlier "allow hyphen" ruling (2026-10-11); under AD-8 PRD AC-3 example `my-campaign` is rejected; URL-11 claims AC-03 | E-5 | E1 (+ C1, C4) | Human (Michael) | **No for Phase 2 edits** (⚠ warning ships in URL-11/URL-8 regardless); **blocks URL-11 implementation start** |
| **X-6** | **AM-2** — PRD header "Approved" vs footer "draft" (documentation only; PRD immutable) | E-6 | E5 | Human | **No** |
| **X-7** | **AWS deployment prerequisites** unspecified in approved docs: account/region/credentials for GitHub Actions, Route 53 hosted zone (single shared domain), SES domain/DNS verification, existing RDS instance identifier | E-7 | — (not raised by Jim) | Human (Michael) / ops | **No for Phase 2 edits**; **blocks URL-7 execution/staging deploy** |
| **X-8** | **AC-NFR-3 / 99.9% availability verification ownership & method** (AD-11): URL-17 cited the AC with no method. *Phase-1b position: owner = NEW-T2 (fault injection + bounded availability report), URL-16 = ongoing measurement, URL-17 references evidence or absorbs if NEW-T2 declined* | (new: F-26) | E10 | Human (Michael) confirms the method; Dwight assigned ownership | **No** — ownership stated unambiguously in §E; confirmation of sufficiency requested |
| **X-9** | **AC-FR-5.3 / AC-NFR-6 verification ownership**: URL-12 implements but cites neither; URL-14 cites without a test. *Phase-1b position: URL-12 cites both + states the link-level analytics-deletion test* | (new: F-25) | E12 | Michael confirms; edit assigned to URL-12 | **No** — edit content decided in §E |
| **X-10** | **NFR-9 coverage**: Jim = UNCOVERED (no ticket mentions it); Dwight = "N/A per design §10.6". *Reconciled (§F): both true — no MVP implementation work is intended, but coverage text is absent; URL-7 edit closes it.* Confirm that leaving custom domains unimplemented and unverified in MVP is acceptable | (E-7 adjacent; F-15) | E7 | Human (Michael) | **No** — URL-7 edit closes the coverage; confirmation of the no-MVP-work reading requested |
| **X-11** | **`REDIRECT_STATUS` knob vs fixed-302 default** (Jim C3): env var in URL-18 with placeholder only; AC-FR-4.1/AD-1 fix 302. Confirm the knob must be pinned/documented as 302-only (new decision needed to ever change it) | (new: F-24) | E13 (+ C3) | Human (Michael) wording ruling | **Partial** — URL-18/URL-7/URL-13 edit wording |
| **X-12** | **Missing ACs in requirements.md**: no AC-NFR-5, AC-NFR-7, AC-NFR-8, AC-NFR-9 exist (verified by Michael's spot-check). Confirm whether new ACs are wanted — requirements.md may only be changed by its author (jim) under Michael's instruction | (new) | E11 | Human (Michael) + jim (author) | **No** — spec change independent of the Jira work order |
| **X-13** | **AC-FR-7.1 owner**: no owning ticket/verification. *Phase-1b position: NEW-T1 (contract/OpenAPI) owns it — no double-tracking* | F-01 | E8 | Michael approves NEW-T1 in Phase 2 | **Partial** — blocks creating NEW-T1 |
| **X-14** | **AC-FR-10.5 verification**: implemented in URL-16 scope but excluded from its only AC (AC-12). *Phase-1b position: URL-16 gains an alert-verification AC — no double-tracking* | F-10 | E9 | Resolved in Phase 1b; Michael approves in Phase 2 | **No** |

**Carried over unchanged (awareness, not an escalation):** `requirements.md` §8 stale `[PENDING]` markers — regeneration is jim's (author's) task under Michael's instruction *(design §11.2, header note)*.

### D.1 Human rulings (2026-10-25) and per-X outcomes — recorded at Phase 2 execution

| Decision | Ruling (human) | Outcome |
|---|---|---|
| **D1 — sizing** | "Split both into sub-tickets." | **EXECUTED (Pass A):** URL-7 → unit (a) + **URL-19** (CDK) + **URL-20** (CI/CD); URL-9 → unit (a) + **URL-21** (OAuth) + **URL-22** (API keys/middleware). |
| **D2 — NEW-T1 + NEW-T2** | "Create both now." | **EXECUTED (Pass C):** created as **URL-23** and **URL-24**; X-8 ownership accepted as assigned — **URL-24 (NEW-T2) owns AC-NFR-3**. |
| **D3 — NEW-T3 + NEW-T4** | "Create now, marked blocked." | **EXECUTED (Pass C):** created as **URL-25** and **URL-26**, each description opening with the mandated BLOCKED line; no vendor named. |
| **D4 — open product decisions** | "Add warning open-decision notes, keep current behavior." | **Warnings shipped** (URL-8, URL-11, URL-12); **X-3 / X-4 / X-5 remain OPEN product questions** — DELETE-only, AD-1 TTLs (no Option C, no invalidation), AD-8 charset as written. |
| **D5 — requirements.md** | "No changes now." | **X-12 declined for now** — spec files untouched; stands as a standing question for jim/Michael. |
| **D6 — AWS prerequisites** | Human provides inputs before staging deploy. | **X-7 OPEN, action on the project owner** — checklist lives in **URL-19**; values never invented. |
| **D7 — REDIRECT_STATUS** | Document "default = 302 (design §5.3, AC-FR-4.1); changing requires a new human decision". | **Wording applied** in URL-7 / URL-13 / URL-18; **X-11 question stays OPEN** — this restates approved design, it does not resolve the knob question. |
| **X-6, X-10** | No answer | **OPEN and unanswered** — no action taken beyond wording that restates design (PRD untouched; NFR-9 coverage closed only by the URL-7/URL-19 text). |

Per-X outcome index: **X-1 OPEN** (vendor unchosen; URL-25 created blocked) · **X-2 OPEN** (vendor unchosen; URL-26 created blocked) · **X-3 OPEN** (warning shipped, D4) · **X-4 OPEN** (warning shipped, exception tests deferred, D4) · **X-5 OPEN** (warnings shipped in URL-8/URL-11, D4; still blocks URL-11 implementation start) · **X-6 OPEN** · **X-7 OPEN** (checklist in URL-19, D6) · **X-8 EXECUTED** (URL-24 owns AC-NFR-3; URL-17 fallback wording; URL-16 measurement) · **X-9 EXECUTED** (URL-12 cites AC-FR-5.3 + AC-NFR-6 with link-level test; URL-14 annotated) · **X-10 OPEN** · **X-11 wording applied, OPEN** · **X-12 declined for now (D5)** · **X-13 EXECUTED** (URL-23 created) · **X-14 EXECUTED** (URL-16 alert-verification AC added).

---

## E. PHASE 2 WORK ORDER (single authoritative plan — **EXECUTED 2026-10-25, Passes A/B/C — see §G**)

> **Authorization gate:** every action below executes only in Phase 2, after Michael's explicit go-ahead (which follows the human's answers to §D). **Splits (§E.3) require separate explicit human approval.** Nothing here reopens AD-1…AD-15; nothing edits PRD.md, requirements.md, design.md, readiness-audit.md, or requirements-coverage.md.
>
> **STATUS 2026-10-25 — EXECUTED:** Michael authorized Phase 2 after the human's D1–D7 answers; §E.0, §E.1, §E.2 and §E.3 all executed and verified (Passes A/B/C). Write counts, verifications and deviations are in **§G**.

### E.0 Dependency (Blocks) changes to add

| Link to add | Why |
|---|---|
| **URL-12 → URL-17** | URL-17 validates the "authenticated API mutations p95 ≤500ms" budget row — needs URL-12's endpoints (F-06) |
| **URL-15 → URL-17** | URL-17 validates the "Analytics read / QR generation p95 ≤600ms" row — needs URL-15's QR endpoint (F-06) |

Existing 14 Blocks links: **verified correct, unchanged** (matches readiness-audit §6). New-ticket links are listed in §E.2.

### E.1 Per-ticket edits (exact)

**URL-6 (Epic)**
- *Scope/description:* add `readiness-audit.md`, `ticket-audit.md`, `requirements-coverage.md` as sources; list 12 children + wave order (readiness-audit §6); reference design §13 (c1–c4) and §13.3 + the X-list (§D).
- *AC / Deps / Verification:* n/a (epic container). Refs: design §13, §13.3. *(F-22)*

**URL-7**
- *Scope:* +Route 53 / custom-domain mapping for the single shared domain (§3.1) *(F-15)*; +**NFR-9 line: single shared domain only — no per-user/custom-domain configuration; extension point documented per design §10.6** *(X-10)*; +EventBridge Scheduler triggers for `maintenanceFn` (daily/hourly per §3.7) + local job invocation path *(F-14)*; +config contract rule for **`REDIRECT_STATUS` default = 302, changing it requires a new human decision** *(F-24/X-11)*; +define "smoke" = AC-set smoke per §9.6 *(F-02)*.
- *Acceptance (testable):* +AC-FR-9.1, AC-FR-9.3 citations; +AC "single shared domain only; no custom-domain/per-user domain config exists (NFR-9)"; +AC "no CloudFront/CDN resources synthesized (AD-1/AD-2/AD-7)"; +AC "scheduler rules exist for all §3.7 jobs".
- *Dependencies:* unchanged — blocked by URL-18; blocks URL-8, URL-16. **Split proposal pending (§E.3).**
- *Technical refs:* §3.1, §3.7, §5.3, §6.3, §9.6, §10.6; D-1, D-2, D-4, D-15; AD-12.
- *Verification:* `cdk synth` shows domain config + scheduler rules and no CDN resources; approval gate honored (existing AC).

**URL-8**
- *Scope:* unchanged. +⚠ note: AD-8 DB CHECK is authoritative-as-written — hyphen acceptance requires a new human ruling *(X-5)*.
- *Acceptance:* +AC-FR-9.2, NFR-2, NFR-4 citations.
- *Dependencies:* unchanged (blocked by URL-7, URL-18; blocks URL-9, URL-10).
- *Technical refs:* +migration tool `node-pg-migrate` (D-3, pinned by URL-18); §4.1, §9.4, §6.5.
- *Verification:* existing (migrations, cascade, no-literal static check, dedup semantics) — unchanged.

**URL-9**
- *Scope:* unchanged (split proposal pending §E.3).
- *Acceptance:* **replace the create-gate AC** (F-07) — here: (i) verification email issues a single-use, expiring token; double opt-in semantics per AD-14; (ii) `email_verified_at` set on success; (iii) keep AC-FR-1.1/1.3/1.4, AC-01. The `403 EMAIL_NOT_VERIFIED`-on-create assertion moves to **URL-11 with AC-FR-1.2**.
- *Dependencies:* unchanged (blocked by URL-8; blocks URL-11).
- *Technical refs:* §3.3, §3.8, §6.1; D-11; AD-13, AD-14.
- *Verification:* unit/integration per §7 — argon2id hashing, refresh reuse-detection revokes token family, API-key constant-time verify + plaintext-once, OAuth flows against fake providers; account-cascade test lives in URL-8.

**URL-10**
- *Scope:* +ownership line: rate-limit hygiene *job* is registered/executed by URL-14's `maintenanceFn`; URL-10 owns the SQL + window-row schema only *(F-23)*.
- *Acceptance:* +cite **AC-FR-2.7** (joint test with URL-11) and **FR-8.3** *(F-08, F-16)*.
- *Dependencies:* unchanged (blocked by URL-8; blocks URL-11).
- *Technical refs:* §3.3 chain, §3.4 step 4, §6.6; D-10; AD-3, AD-7; open-vendor warning (X-1) already present — keep verbatim.
- *Verification:* sliding-window math unit tests (weighted 1-min window, boundary/2×-burst cases); `RateLimit-*` + `Retry-After` header assertions; dummy adapter: risk-flagged create challenged, clean create unchallenged.

**URL-11**
- *Scope:* +reserved slugs `healthz`/`readyz` rejected (§6.4); +success response shape `{id, slug, shortUrl, destinationUrl, createdAt, expiresAt}` (§3.4 step 9); +⚠ note: **AD-8 strict charset applied as written — PRD AC-3's `my-campaign` would be rejected; open conflict, do not accept hyphens without a new human ruling** *(F-08, F-20/X-5)*.
- *Acceptance:* +**AC-FR-1.2** (create gate: unverified → 403, verified → success, no link created — moved from URL-9, F-07); +**AC-FR-2.7** cross-reference (gates tested jointly with URL-10); annotate **AC-03** as "rejection + 3-suggestions half verifiable now; `my-campaign` acceptance pending X-5"; keep AC-FR-2.1…2.6, AC-02, AC-04.
- *Dependencies:* unchanged (blocked by URL-9, URL-10; blocks URL-12, URL-13, URL-15).
- *Technical refs:* §3.4, §3.5 (c2), §6.4; D-5, D-6, D-7; AD-4, AD-5, AD-6, AD-8.
- *Verification:* existing crash-injection + concurrent-race ACs; +collision → 409 with **exactly 3 availability-checked** suggestions; +reserved-word rejection; +gate test (with URL-10's limiter/CAPTCHA stubs).

**URL-12**
- *Scope:* +⚠ note: **FR-3.1 delete/disable wording open (§10.4) — implement `DELETE` only; no `disabled_at` until the human decides** *(X-3)*; +⚠ note: **AC-FR-3.1 immediacy is subject to X-4 — a deleted link may still resolve ≤60s per URL-13's AD-1-approved cache; do not add cache invalidation; exception-window tests deferred to the X-4 ruling** *(F-20, Jim C2, X-4)*.
- *Acceptance:* specify **`403 FORBIDDEN`** for non-owner, `401` unauthenticated *(F-17)*; +cite **AC-FR-5.3 and AC-NFR-6** with the explicit test: **`DELETE /v1/links/{id}` → link row AND all its `click_buckets_daily` / `referrer_buckets_daily` / `country_buckets_daily` / `referrer_totals` / `country_totals` rows removed (link-level; distinct from URL-8's account-level cascade)** *(F-25/X-9)*; +AC-NFR-6 citation *(F-16)*; keep AC-FR-3.1/3.2/3.3, AC-08.
- *Dependencies:* **+Blocks URL-12 → URL-17** *(F-06)*; blocked by URL-11 (unchanged).
- *Technical refs:* §3.3, §4.2, §5.1, §5.2; AD-5, AD-6; §10.4 (X-3), §13.3 (X-4).
- *Verification:* ownership-predicate tests (non-owner read/update/delete → 403, no change); cursor pagination `pageSize≤100`; no bulk routes (AC-FR-3.3); **link-level analytics-removal test (above)**.

**URL-13**
- *Scope:* unchanged (E1 warning already present — keep verbatim, reference it as X-4); +note: exception-window tests (new slug 404 ≤30s; deleted-as-active ≤60s) are **deferred to the X-4 ruling**; +note: deployed config default must behave as **302 + `no-store`** *(F-24/X-11)*.
- *Acceptance:* +cite **AC-FR-4.1, AC-FR-4.2, AC-FR-4.3, AC-FR-4.4** *(F-09/F-16)*; +AC: "one served redirect → aggregate count increments exactly once after aggregation (joint test with URL-14)"; keep AC-05/06/07 + warm-cache 410 AC.
- *Dependencies:* unchanged (blocked by URL-11; blocks URL-14, URL-17). *Note: NEW-T4 (X-2), if created, blocks the GeoIP layer provisioning feeding this ticket.*
- *Technical refs:* §3.2 (c1/c3/c4), §5.3; D-9; AD-1, AD-2; §13.3 E1.
- *Verification:* existing ACs + count-increment joint test + privacy regression (no visitor IP in DB/logs/queue) + 302/`no-store` assertion.

**URL-14**
- *Scope:* +ownership: **`maintenanceFn` owns ALL §3.7 jobs (incl. rate-limit hygiene + tombstone audit)**; receives the hygiene purge from URL-10 *(F-23)*.
- *Acceptance:* +cite **AC-NFR-4** *(F-16)*; AC-FR-5.3 stays cited but is **annotated: link-level deletion test lives in URL-12 (X-9); this ticket verifies only orphaned-linkId handling (dedup row recorded, aggregates skipped + metric)** *(F-25)*.
- *Dependencies:* unchanged (blocked by URL-13; blocks URL-17).
- *Technical refs:* §3.6 (c1), §3.7, §4.1, §4.3; D-8, D-14; AD-9, AD-10, AD-5; c3.
- *Verification:* duplicate-SQS-batch replay → counts once; 30-day bucket purge; 7-day dedup GC; 24h idempotency GC; `'ZZ'` never leaks as a country code; `?from&to` >30d rejected; orphan test.

**URL-15**
- *Scope / Acceptance / Refs:* **no changes (Ready)**; optional one-liner "payload = short URL, never stored (AD-15/D-12)".
- *Dependencies:* **+Blocks URL-15 → URL-17** *(F-06)*.

**URL-16**
- *Scope:* +instrumentation plan: shared spine (logs/metrics/traces) lands with URL-7; per-feature metric hooks (`redirect.requests{result,cache}`, `captcha.*`, `geo.*`, `links.created`, `ratelimit.rejected`) are an AC checklist keyed to §8.3 names, filled across waves 3–5 *(F-19)*; +availability-measurement role: uptime probe on `/readyz` + 5xx-rate alarm vs the 99.9% budget, feeding NEW-T2's evidence *(F-26/X-8)*.
- *Acceptance:* +cite **AC-FR-10.1…AC-FR-10.5** *(F-10)*; +**alert-verification AC: force an error condition in staging (e.g., `/readyz` failure or 5xx burst) → alarm state changes and the SNS notification path fires** *(X-14)*; +AC "log-shape assertion in CI: no `clientIp`, no credentials in any log line (§8.2) — **this ticket owns the gate**"; +AC "one emitted metric verified per §8.3 family"; +AC "alarm set matches the §8.5 list (7 alarms)".
- *Dependencies:* unchanged (blocked by URL-7).
- *Technical refs:* §8.1–§8.5; D-13; §7 privacy-regression row.
- *Verification:* as listed above; `/readyz` red when DB unreachable (joint with URL-7/URL-8).

**URL-17**
- *Scope:* **full design §9.1 table replaces the paraphrase** — redirect warm **hit** p95 ≤60ms / warm **miss** p95 ≤120ms / cold p99 ≤1000ms; authenticated mutations p95 ≤500ms; analytics+QR p95 ≤600ms; DB sub-budget ≤20ms p95 *(F-05)*; **environment = staging (k6, seeded 1M links / 10k users); seed script owned by this ticket (`tests/load/seed`, reusing URL-8 migrations)** *(F-18)*.
- *Acceptance:* each §9.1 row measured and reported individually; levers applied + evidence recorded if a row misses; no CDN/edge introduced (AD-1/AD-2/AD-7); **AC-NFR-3: availability verification is owned by NEW-T2 (failover/proxy-blip → 5xx + `/readyz` red, DLQ path, aggregator retry, alarm firing, bounded availability report vs 99.9%) — this ticket satisfies AC-NFR-3 by referencing NEW-T2's evidence; if NEW-T2 is not created, URL-17 MUST absorb that verification before claiming AC-NFR-3** *(F-26/X-8)*.
- *Dependencies:* **+blocked by URL-12, URL-15** *(F-06)*; keeps blocked by URL-13, URL-14.
- *Technical refs:* §9.1–§9.4, §10.1–§10.3; AD-11; D-9/AD-1.
- *Verification:* k6 reports per budget row; cache hit-rate measurement; reserved-concurrency vs proxy `max_connections` headroom + 80% alarm check; NEW-T2 evidence reference (or absorbed suite).

**URL-18**
- *Scope:* **`REDIRECT_STATUS` in `.env.example` documented as "default 302 — fixed by AD-1/AC-FR-4.1; changing requires a new human decision", plus a config-validation rule that warns/blocks non-302 without an explicit override flag** *(F-24/X-11)*; +coverage gate: vitest thresholds — **90% line coverage on `src/auth` and `src/links`** (design §7) + `npm run test:coverage`, referenced by URL-7 CI *(F-21)*.
- *Acceptance:* +cite **AC-FR-9.3** *(F-16)*; +AC "default config yields 302 + `Cache-Control: no-store` on redirect (integration test)"; +AC "coverage thresholds enforced in `npm test`".
- *Dependencies:* unchanged (blocks URL-7, URL-8).
- *Technical refs:* §1.3, §3.9, §5.3, §6.2, §7; FR-4.1/AC-FR-4.1/AD-1; readiness-audit §1 (coverage-gate claim).
- *Verification:* fresh-checkout AC (existing); `.env.example` completeness (existing); +302-default test; +coverage-threshold run.

### E.2 New tickets to create in Phase 2 (all require Michael's approval)

| ID | Summary | Parent | Uncovered requirement | Proposed Blocks links | Gate |
|---|---|---|---|---|---|
| **NEW-T1** | Contract testing: OpenAPI generation & schema snapshots | URL-6 | **FR-7.1, AC-FR-7.1/7.2/7.3**; design §7 Contract row *(F-01, X-13)* | blocked by URL-12, URL-14, URL-15; relates URL-7 (CI), URL-18 (`tests/contract/`) | Michael approves creation |
| **NEW-T2** | E2E (AC-01…AC-13) nightly + resilience & availability staging suite | URL-6 | design §7 E2E + Resilience rows, §9.6; AC-01…AC-13; **NFR-3 / AC-NFR-3 (owner ticket)** *(F-02, F-26, X-8)* | blocked by URL-14, URL-16; relates URL-17 (evidence reference) | Michael approves creation + confirms X-8 method |
| **NEW-T3** | CAPTCHA vendor adapter (live challenge) | URL-6 | **FR-2.7 live leg, AC-FR-2.7, AC-11**; design §10.8 *(F-03, X-1)* | blocked by X-1 answer + URL-10 | **Human names vendor first (X-1)** |
| **NEW-T4** | GeoIP database provisioning: Lambda layer + local file | URL-6 | **AD-2 Option B provisioning, FR-5.1**; design §10.9, §3.9 *(F-04, X-2)* | blocked by X-2 answer; blocks URL-13 (country-resolution layer) — alternative: fold into URL-7 + URL-18 env contract | **Human picks vendor/license first (X-2)** |

**EXECUTED 2026-10-25 (Pass C):** NEW-T1 → **URL-23** · NEW-T2 → **URL-24** · NEW-T3 → **URL-25** · NEW-T4 → **URL-26** — all created under parent URL-6, status To Do, assignee Roy Melamed, Agent Owner = Developer, one evidence comment each (IDs 10068–10071), no vendor named.
**Link outcome:** URL-23 blocked by URL-12/URL-14/URL-15 + Relates URL-7/URL-18 · URL-24 blocked by URL-14/URL-16 + Relates URL-17 · URL-25 blocked by URL-10 · URL-26 **Relates URL-13 — deviation from this table's "blocks URL-13", decided by Michael 2026-10-25** (rationale in §G; the human may override by adding a Blocks link).

### E.3 Split proposals — RECOMMENDATION ONLY, EXPLICITLY PENDING HUMAN APPROVAL

- **URL-7 → 7a** (app skeleton + compose + config module) / **7b** (CDK infra: API GW + routes + 4 Lambdas + VPC + SQS/DLQ + Secrets + RDS Proxy + **Route 53 domain** + **EventBridge Scheduler** + concurrency) / **7c** (CI/CD pipeline with approval gate) *(F-11)*.
- **URL-9 → 9a** (identity + sessions + double opt-in email) / **9b** (social OAuth: Google + GitHub, PKCE) / **9c** (API keys + auth middleware); account deletion rides 9a *(F-12)*.
- **If the human declines:** both tickets proceed as-is with the §E.1 edits (per-area AC checklists added instead).

#### E.3 execution log — Phase 2 Pass A (2026-10-25, human-approved D1: "Split both into sub-tickets.")

- CREATED 2026-10-25: URL-19 — Scaffolding: CDK infrastructure (IaC) — split from URL-7 (human-approved split)
- CREATED 2026-10-25: URL-20 — Scaffolding: CI/CD pipeline with approval gate — split from URL-7 (human-approved split)
- CREATED 2026-10-25: URL-21 — Accounts: social OAuth (Google/GitHub, PKCE) — split from URL-9 (human-approved split)
- CREATED 2026-10-25: URL-22 — Accounts: API keys & auth middleware — split from URL-9 (human-approved split)

Execution evidence (all verified by re-fetch 2026-10-25):
- All four: type Task (URL-19/URL-20) / Story (URL-21/URL-22), parent **URL-6**, status **To Do** (no transitions), assignee **Roy Melamed**, Agent Owner (customfield_10043) = **Developer (10024)**.
- URL-7 and URL-9 trimmed to unit (a); every unit-(a) requirement/design ref preserved; split line added to each; moved-out inventory recorded in each description.
- New Blocks links: URL-7 → URL-19; URL-19 → URL-20; URL-9 → URL-21; URL-9 → URL-22. Existing 14 links untouched (URL-18→URL-7, URL-7→URL-8, URL-7→URL-16, URL-8→URL-9, URL-9→URL-11 all intact).
- **Deviation from Pass A instruction (justified):** instruction proposed URL-21 (9b) blocks URL-22 (9c); replaced with **URL-9 → URL-22 (parallel)** because URL-22 (API keys + auth middleware) has no predecessor among the siblings — it builds only on unit (a) identity/sessions, and no interface or data flows from social OAuth to API-key middleware (audit category 5: no false dependencies). Michael's instruction explicitly permitted this adjustment with justification.
- Comments: URL-7 #10037, URL-9 #10038, URL-19 #10039, URL-20 #10040, URL-21 #10041, URL-22 #10042.
- Not done in this pass (Passes B/C): NEW-T1…NEW-T4, §E.1 per-ticket edits, URL-6 description refresh.
- **Final state confirmed after Pass C (2026-10-25):** all four split siblings remain parent URL-6, To Do, assignee Roy Melamed, Agent Owner Developer; their Blocks chain URL-7 → URL-19 → URL-20 and URL-9 → {URL-21, URL-22} intact. The §E.3 split proposals above are **EXECUTED** (keys: URL-19, URL-20, URL-21, URL-22).

### E.4 Explicitly NOT in the Phase 2 work order

- No edits to PRD.md, requirements.md, design.md, readiness-audit.md, requirements-coverage.md (requirement changes → X-12, author = jim under Michael's instruction).
- No reopening of AD-1…AD-15; no implementation ticket for NFR-9 custom domains (design §10.6 — pending X-10 confirmation).
- No CDN/edge, no shared cache/invalidation (Option C) without a new human decision (AD-1, X-4).
- No transitions, no assignee/Agent-Owner changes (all stay Roy Melamed / Developer per squad policy).

---

## F. PHASE 1 RECONCILIATION WITH JIM (Phase 1b — 2026-10-25)

| Field | Value |
|---|---|
| **Date** | 2026-10-25 |
| **Input** | `specs/url-shortener-api/requirements-coverage.md` (jim) — **read in full** (7 sections: method, 119-ID coverage matrix, stats, contradictions C1–C4, invalid references, escalations E1–E13, compliance statement) |
| **Michael's verified spot-checks relied upon** | (1) URL-12 Acceptance = literally "AC-FR-3.1, AC-FR-3.2, AC-FR-3.3, AC-08" (no AC-FR-5.3/AC-NFR-6) → F-25/X-9; (2) URL-18 contains `REDIRECT_STATUS`, design.md line 435 keeps it configurable with default 302 → F-24/X-11; (3) URL-16 Acceptance = literally the AC-12 line while scope includes FR-10.5 alarms → F-10/X-14; (4) requirements.md has only AC-NFR-1/2/3/4/6 (no AC-NFR-5/7/8/9) → X-12 |
| **Files touched** | This artifact only. PRD.md, requirements.md, design.md, readiness-audit.md, requirements-coverage.md **unmodified**. |

### F.1 What changed in ticket-audit.md

1. **Findings added from Jim (23 → 26):**
   - **F-24 (new)** — `REDIRECT_STATUS` vs fixed-302 default (Jim C3/E13); planned edits for URL-18 (primary), URL-7 (config contract) and URL-13 (behavior assertion) — the knob appears **only in URL-18's ticket text** among the 13 descriptions, so URL-18 is the edit anchor.
   - **F-25 (new)** — AC-FR-5.3 / AC-NFR-6 verification ownership (Jim E12); URL-12 plan extended to cite **both** IDs **and** state the explicit link-level "delete link → its analytics rows removed" test (URL-14 keeps only orphan handling).
   - **F-26 (new)** — AC-NFR-3 / 99.9% availability verification (Jim E10); **ownership assigned unambiguously: NEW-T2 owns it**, URL-16 supplies ongoing measurement, URL-17 references the evidence or absorbs it if NEW-T2 is declined — written into F-02's fix, URL-17's plan and NEW-T2's expectations.
   - **F-16 extended** with Jim §4's never-cited list (FR-7.1, FR-8.3, FR-10.5, NFR-9, AC-FR-2.7, AC-FR-4.1–4.3, AC-FR-7.2/7.3, AC-FR-9.1/9.2, AC-FR-10.1–10.3/10.5, AC-NFR-4, AC-NFR-6, AC-13).
   - **F-20 expanded** to absorb Jim's **C2** (URL-12 vs URL-13 divergent AC-FR-3.1 readings; URL-12 never mentions E1) alongside the charset (C1/C4) and delete/disable (E4) flag-omissions — one finding, one fix pattern (⚠ open-decision notes).
2. **NFR-9 reconciled (Jim E7 vs my A.2 "N/A"):** **Adopted position — both verdicts are true at different layers.** design §10.6 genuinely requires *no MVP implementation work* for custom domains (my original reading); Jim's **UNCOVERED** is factually correct as a *coverage* verdict because **no ticket text mentions NFR-9**. Resolution: the **URL-7 edit (F-15)** adds the single-shared-domain scope + AC + extension-point doc reference, closing the coverage gap without a new implementation ticket; the *confirmation* that unimplemented/unverified-in-MVP is acceptable is escalated as **X-10**. My matrix row (§A.2) now carries both positions.
3. **Alignment confirmed — no double-tracking:**
   - **Jim E8 (AC-FR-7.1 owner)** = my **F-01** → resolved by proposed **NEW-T1** (tracked once, as X-13).
   - **Jim E9 (AC-FR-10.5 verification)** = my **F-10** → resolved by the **URL-16 edit** (tracked once, as X-14).
   - Jim C1/C4 → my F-20 / X-5 · Jim C2 → my F-20 / X-4 · Jim C3 → my F-24 / X-11 · Jim E1/E4/E5/E6 ↔ my E-5/E-3/E-6/E-4 (same items) · Jim E2/E3 ↔ my E-1/E-2 · Jim E12/E10/E11/E7/E8/E9 → F-25/F-26/new/X-12/X-10/F-01/F-10 as mapped in §D.
   - Jim's PARTIAL verdicts I had not used verbatim (FR-2.7, FR-3.1, FR-7.1, FR-10.5, AC-FR-3.1, AC-FR-5.3, AC-FR-10.5, NFR-3, AC-NFR-3, AC-NFR-6, AC-03, AC-11, AD-3) are all reflected in §A status notes.
4. **Escalations unified:** §D replaced by the **X-list (X-1…X-14)**, each row mapping my original E-x and Jim's original E-n (plus which of Jim's C1–C4 ride along), owner, and Phase-2 blocking status. Jim's E11 (missing AC-NFR-5/7/9 → **X-12**) added as an escalation per Michael's instruction — a requirements.md change only the human can authorize (author = jim).
5. **§E rewritten** as the single authoritative Phase 2 work order: per ticket → exact scope / testable AC / dependencies (2 new Blocks links) / technical refs / verification expectations; new-ticket list (NEW-T1…NEW-T4) with gates; splits explicitly pending human approval (§E.3); explicit non-goals (§E.4).
6. **§A / §C updated:** NFR-9 row reconciled; URL-12/URL-16/URL-17/URL-18 verdict rationales extended with the new findings; GAP rows now cross-reference Jim's 2 UNCOVERED IDs.

### F.2 Final counts (post-merge)

| Metric | Value |
|---|---|
| Tickets audited | **13** (epic + 12 children) |
| **Findings total** | **26** (Phase 1: 23 → Phase 1b: +3 from Jim; 0 net removed) |
| — Critical | **0** |
| — High | **4** (F-01, F-02, F-05, F-06) |
| — Medium | **14** (F-03, F-04, F-07, F-10, F-11, F-12, F-14, F-15, F-18, F-20, F-21, **F-24, F-25, F-26**) |
| — Low | **8** (F-08, F-09, F-13, F-16, F-17, F-19, F-22, F-23) |
| By category | missing req. 3 · vague 2 · incomplete AC 7 · tech. inconsistency 4 · dependencies 3 · testing 4 · sizing 3 |
| **Escalations (unified)** | **14** (X-1…X-14) = Dwight 7 + Jim 13 merged, 6 of them overlapping pairs; 3 Jim-only (X-8, X-9, X-12), 1 Dwight-only (X-7) |
| Phase 2 work order | 13 tickets to edit · 4 new tickets proposed · 2 Blocks links to add · 2 splits pending human approval |
| Jim's coverage stats (adopted, not re-derived) | 119 IDs · 104 COVERED · 13 PARTIAL · 2 UNCOVERED (`NFR-9`, `AC-FR-7.1`) · contradictions C1–C4 |

### F.3 Phase 1b compliance statement

- **NO JIRA WRITES PERFORMED** in Phase 1 or Phase 1b: no comments, no edits, no issue links, no transitions, no new issues. Jira access was read-only.
- `PRD.md`, `requirements.md`, `design.md`, `readiness-audit.md` and `requirements-coverage.md` were read but **not modified**.
- No product/architectural decision was invented: 14 open items are escalated verbatim in §D for the human; AD-1…AD-15 remain as recorded.
- All verdicts are claims about ticket *text* as read on 2026-10-25, not about tested or working software.

---

## G. PHASE 2 EXECUTION LOG (2026-10-25)

| Pass | Scope | Writes | Verification |
|---|---|---|---|
| **A** — splits | URL-7 / URL-9 → unit (a) + siblings | 4 creates (**URL-19, URL-20, URL-21, URL-22**) · 6 description edits (URL-7, URL-9 + 4 sibling split-note patches) · 4 Blocks links · 6 issue comments + 4 link comments | ✓ re-fetch: parent URL-6, To Do, Roy Melamed, Agent Owner Developer; original 14 links intact |
| **B** — §E.1 edits | 13 issues (URL-6…URL-18) | 13 description edits · 13 evidence comments (10043–10049, 10052–10057) · 2 Blocks links (URL-12→URL-17, URL-15→URL-17) + 2 link comments | ✓ re-fetch of all 13: expected new text present; status/assignee/Agent Owner unchanged |
| **C** — new tickets + record | §E.2 creation + this artifact | 4 creates (**URL-23, URL-24, URL-25, URL-26**) · 4 evidence comments (10068–10071) · 6 Blocks + 4 Relates links + 10 link comments · §D/§E/§G updates here | ✓ re-fetch of all 4 + epic child count = 20 (URL-7…URL-26) |

**Totals: 8 issue creates · 19 description edits · 39 comments (23 evidence + 16 link annotations) · 16 issue links · 0 transitions · 0 deletions · 0 assignee or Agent-Owner changes.** *(These counts cover the audit pass only. **Post-audit correction, 2026-10-26:** one issue-link deletion was subsequently performed outside this pass — reversed link 10066 removed via `DELETE /rest/api/3/issueLink/10066` → 204, plus comment 10095. Still no issue deletions, no transitions, no assignee/Agent-Owner changes.)*

**Deviations from the written work order (all recorded, none hidden):**

1. **Pass A — URL-21 ↛ URL-22:** instruction proposed 9b blocks 9c; replaced with URL-9 → URL-22 (parallel) because URL-22 has no predecessor among the siblings (no interface/data flows OAuth → API-key middleware). **Approved by Michael as justified.**
2. **Pass B — §E.1 items skipped as already covered by Pass A:** URL-7's Route 53 / NFR-9 line / EventBridge Scheduler / AWS-prereqs checklist (→ URL-19) and smoke + approval gate + AC-FR-9.1 (→ URL-20) — replaced by a pointer line; URL-9's API-key/OAuth verification items and AC-FR-1.3/social AC legs (→ URL-22/URL-21); §E.1's "keep AC-FR-1.3" for URL-9 overridden by the approved split. Nothing else was inapplicable.
3. **Pass C — NEW-T4 link type:** §E.2 said NEW-T4 blocks URL-13; created as **Relates URL-13** on **Michael's explicit call (2026-10-25)**: URL-13 builds behind the GeoIP provider interface with a local/stub file exactly as URL-10 ships a dummy CaptchaProvider — blocking the core redirect story on an unresolved vendor would stall the MVP. **The human may override by adding a Blocks link (URL-26 → URL-13).** Recorded in URL-26's description and comment, in §E.2, and here.

**Still OPEN after Phase 2 (no agent may close):** X-1, X-2 (vendors unchosen — URL-25/URL-26 created and BLOCKED) · X-3, X-4, X-5 (product questions — warnings only, current behavior kept) · X-6, X-10 (unanswered) · X-7 (prerequisites owed by the project owner) · X-11 (wording applied, knob question open) · X-12 (declined for now). Executed/closed-by-write: X-8, X-9, X-13, X-14.

**Compliance:** status never transitioned (all issues To Do); assignee always Roy Melamed; Agent Owner untouched (URL-6 = Michael, children = Developer 10024); `PRD.md`, `requirements.md`, `design.md`, `readiness-audit.md`, `requirements-coverage.md` unmodified; no code written; no product decision invented.

### Pass E (2026-10-26) — link-direction correction, dependency scan, provenance

* **Link-direction correction (Task 1) — RESOLVED 2026-10-26:** the reversed link **10066** (URL-23 blocks URL-20) created in Pass D was an ordering inversion; the correct link **10067** (URL-20 blocks URL-23) was created 2026-10-26 and both dependency lines corrected (URL-20: "predecessor: URL-19; downstream consumer: URL-23"; URL-23: "…and URL-20 (the CI pipeline this suite wires into)"). **10066 has now been deleted programmatically** — `GET` → `200`, `DELETE /rest/api/3/issueLink/10066` → `204 No Content`, re-read → `404` "No issue link with id '10066' exists."; independent MCP re-read confirms 10066 absent from both issues and 10067 intact (URL-20 = 2 links: blocked by URL-19, blocks URL-23; URL-23 = 6 links). Contradictory Blocks directions resolved (URL-20 comment **10095**). **Correction — the original blocker claim in this line was a misdiagnosis:** it stated raw REST returned 404 "You do not have permission to link issues in this project" and that **manual deletion in the Jira UI is required**. Byte-identical 404s come back for a valid token, a bogus token, and *no* auth header at all, so that response was Jira's **unauthenticated** answer rather than a permission denial — the stored MCP credential is audience-bound to `mcp.atlassian.com` and rejected by `api.atlassian.com`, so REST was simply never authenticated during Pass E. The MCP limitation itself was real and still holds (`createIssueLink` / `getIssueLinkTypes` only, no delete tool), but it never implied UI-only deletion: the operation was always possible over REST with a project-member Jira Cloud API token (Basic auth), which is how it was completed. The superseded claim persists in URL-20 comment **10093**.
* **Task 2 dependency-direction scan (text vs links, all 20 children):** one inversion found (above, **since resolved — link 10066 deleted 2026-10-26**); **URL-13 fixed** — its Dependencies note claimed URL-26 "if created, blocks…" while the actual link is Relates per the Michael-approved §E.2 deviation (comment 10094). **Reported, not changed:** text/link omissions where dependency lines omit existing links — URL-12/URL-14/URL-15 do not name their URL-23 blockers, and URL-16/URL-17/URL-24/URL-25/URL-26 do not name their URL-19 staging blocker (all documented in those tickets' link comments). Every other Blocks/Relates pair matches its ticket text.
* **Provenance:** comment **10092** on epic URL-6 records that all Jira comments on URL-7…URL-26 dated 2026-10-25/2026-10-26 (67 total) were authored by dwight for this human-approved audit (work order §E/§G); comments dated before 2026-10-25 predate the attribution convention; jim performed read-only validation and wrote no Jira comments; ryan and pam have written none.
* **Attribution convention in force** from 2026-10-26: every dwight Jira comment begins with the exact first line `[dwight] Software Architect and Code Reviewer — <date>` (defined in `.opencode/agents/*.md`).

---

*Produced by the Architect (Dwight), 2026-10-25 — Phase 1 analysis, Phase 1b reconciliation with jim's `requirements-coverage.md`, and **Phase 2 execution (Passes A/B/C) recorded in §E and §G**. §D carries the human's D1–D7 rulings with per-X outcomes. The §D X-list remains the standing record of open product questions.*

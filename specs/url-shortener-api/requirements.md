# Requirements Specification: URL Shortener API

| Field | Value |
|---|---|
| **Artifact** | `specs/url-shortener-api/requirements.md` |
| **Status** | **Reconciled** with `design.md` §11 (AD-1…AD-15) — residual open flags only (§8.5) |
| **Date** | 2026-10-11 (created) · reconciled 2026-10-13 vs design.md §11 (human decisions 2026-10-12) |
| **Author** | Jim Halpert — Specification Agent |
| **Source of truth** | `/home/roy/projects/ai-squad/PRD.md` — *Product Requirements Document: URL Shortener API*, Status: **Approved**, dated 2026-10-08 (immutable; not modified by this artifact) |
| **Next hand-off** | Architect (Dwight) → `specs/url-shortener-api/design.md` |
| **Blocked on** | No requirement blocked: Q1–Q4, Q6–Q10, A1–A7, AM-1/AM-3/AM-4/AM-5 all resolved via design.md §11. **Still open (§8.5):** Q5 CAPTCHA provider vendor · GeoIP DB vendor/license · FR-3.1 delete/disable wording · AM-2 · AM-1/AC-03 charset conflict · cache-immediacy windows (design escalation E1) |

---

## 1. Purpose

This document translates the approved PRD into clear, complete, testable software requirements for the URL Shortener API. It is the requirements input for architectural design. It does **not** make product decisions, choose technology, or design system architecture.

## 2. How to read this document

- **Requirement IDs are stable.** Functional requirements retain the PRD's IDs (`FR-1.1` … `FR-10.6`); non-functional requirements are `NFR-1` … `NFR-9`; PRD acceptance criteria are `AC-01` … `AC-13`. IDs will not be renumbered in later revisions.
- **Acceptance criteria use EARS-style wording** where practical (When / If / While … shall).
- **Decision markers:** earlier revisions used `[PENDING Qn]`, `[PENDING A-n]` and `[AM-n]` to flag unresolved items. All such markers were **cleared on 2026-10-13** when this artifact was reconciled against `design.md` §11 (resolution log AD-1…AD-15, human decision-maker, 2026-10-12); each conversion is recorded in §8.0 with its source AD-ref. **`[OPEN §8.5]`** marks a residual item that still awaits a human.
- **Still-open items live in §8.1 (Q5 provider vendor) and §8.5** and remain visible until a human resolves them.
- No requirement below invents scope beyond the PRD. Where the PRD is silent or contradictory, the gap is recorded in §8 rather than resolved.

## 3. Scope

### 3.1 In scope (MVP) — per PRD §8

- Email/password registration plus Google and GitHub social login; email verification.
- Dual authentication: API keys **and** JWT access tokens.
- Link create (auto-generated and custom slug), read, edit destination, delete/disable.
- Collision rejection with suggested alternatives.
- `Idempotency-Key` support on link creation.
- Optional expiration; permanent by default.
- Redirects: 301/302 for active links, `410 Gone` for expired, `404 Not Found` for unknown/deleted — JSON bodies where a body is returned; no interstitial page.
- Basic analytics: total clicks, referrer breakdown, country breakdown; 30-day individual-event retention; no visitor IP/PII.
- QR code generation in PNG and SVG.
- Per-user rate limiting (baseline 100 requests/minute) plus CAPTCHA on link creation.
- Single-resource endpoints only (no bulk operations).
- Serverless deployment, PostgreSQL on existing AWS RDS, structured JSON logging, health checks, metrics, OpenTelemetry tracing, basic alerting.

### 3.2 Out of scope (v2+) — per PRD §4 Non-Goals and §8

- Frontend / any UI.
- Custom or branded domains; per-user subdomains.
- Teams, roles, organizations, SSO/SAML.
- Monetization, paid tiers, subscriptions.
- Bulk operations.
- Webhooks / event streaming / notifications (clients poll).
- Interstitial or preview redirect pages.
- GDPR/CCPA compliance workflows (export/erasure request tooling).
- DMCA/takedown tooling.
- Link claiming/reclaiming of expired or deleted slugs (first-come-first-served in MVP — Q1 resolved: never released, design §11 AD-5).
- CDN / edge caching / CloudFront configuration — no content-delivery network in MVP; redirects are served directly from the serverless application (edge/CDN caching may be considered in a later version). *(Human scope ruling; enforced by design §11 AD-1/AD-2/AD-7.)*
- Architecture decisions (frameworks, infrastructure specifics beyond serverless + PostgreSQL) — left to the Architect.

## 4. Cross-cutting constraints (summary)

| Area | Constraint (source) |
|---|---|
| **Auth** | Dual auth: API keys (Bearer) + JWT (FR-1.3). Email verification required before any link creation (FR-1.2). All link creation is authenticated — no anonymous `POST /links` (design §11 AD-4). Per-user ownership checks on all mutations (FR-3.2, NFR-5). |
| **Redirects** | Fast redirect, direct, no intermediate page (FR-4.1). Default **302 + `Cache-Control: no-store`** (design §11 AD-1 — Q8 resolved). `410 Gone` expired (FR-4.2), `404 Not Found` unknown/deleted (FR-4.3), JSON error bodies (FR-7.2/7.3). **No CDN/edge layer in front** (AD-1/AD-2/AD-7). |
| **Analytics / privacy** | No visitor IPs or PII stored; aggregate counts only; individual click events purged within 30 days (FR-5.2, NFR-4). Country breakdown via transient request-time GeoIP — IP never persisted or logged (design §11 AD-2 — Q4 resolved). |
| **QR codes** | Generated for the requesting user's own links; PNG and SVG output (FR-6). Payload = short URL, `?format=png|svg`, no styling options (design §11 AD-15 — Q7 resolved). |
| **Rate limiting / abuse** | 100 requests/minute per user/key baseline — **uniform, no tiers in MVP** (design §11 AD-7 — Q3/A4 resolved); `429` + retry guidance (FR-8); anonymous redirect traffic not application-rate-limited (AM-4 closed by AD-7). CAPTCHA on creation (FR-2.7): mode `suspicious`, pluggable provider (design §11 AD-3) — **provider vendor still open [OPEN §8.5]**. |
| **Observability** | Structured JSON logs for all requests, health checks, metrics (request rate, latency, error rate, redirects), OpenTelemetry tracing, basic error alerting; lightweight and local-dev friendly; tool choice belongs to the Architect (FR-10). |
| **Platform** | Serverless deployment — AWS Lambda + API Gateway HTTP API confirmed (design §11 AD-12 — A2 confirmed); data in existing PostgreSQL on AWS RDS (FR-9), Multi-AZ confirmed (design §11 AD-11 — A1 confirmed). |

---

## 5. Functional Requirements

### FR-1: Accounts & Authentication

| ID | Requirement |
|---|---|
| FR-1.1 | Users **shall** be able to register with email + password, or via social login (Google, GitHub). Social provider set: Google + GitHub exclusively (design §11 AD-14 — Q6 resolved). |
| FR-1.2 | Email verification **shall** be required before creating links. An unverified user attempting link creation **shall** receive an error and no link **shall** be created. |
| FR-1.3 | The API **shall** authenticate using both: **API keys** (Bearer tokens) for server-to-server use, and **JWT access tokens** for user sessions. |
| FR-1.4 | Users **shall** be able to delete their own account along with their links and associated analytics. Deletion is immediate and irreversible in MVP — confirmed: hard-delete cascade (design §11 AD-13 — A7 confirmed). |

**Acceptance criteria (EARS):**

- **AC-FR-1.1:** When a new user submits registration with email/password or via Google/GitHub, the system shall create an account in an unverified state.
- **AC-FR-1.2:** If an authenticated but unverified user attempts `POST /links`, the system shall reject the request with an error response and create no link; when the user's email is verified, the same request shall succeed.
- **AC-FR-1.3:** While presenting a valid API key, an API request shall be authenticated; while presenting a valid JWT, a user-session request shall be authenticated; invalid or missing credentials shall be rejected.
- **AC-FR-1.4:** When a user deletes their account, the system shall remove the account, all links owned by it, and their associated analytics.

### FR-2: Link Creation

| ID | Requirement |
|---|---|
| FR-2.1 | `POST /links` **shall** create a link from a supplied destination URL. |
| FR-2.2 | By default, the short code **shall** be auto-generated, alphanumeric, drawn from `[a-zA-Z0-9]`. |
| FR-2.3 | Users **may** supply a custom slug of **3–50 characters** matching **strict charset `[a-zA-Z0-9]`** (alphanumeric only; no hyphens) — resolved per design §11 **AD-8** (human, 2026-10-12). ⚠ **Conflict flagged [OPEN §8.5]:** this artifact previously recorded the opposite human ruling for AM-1 ("allow hyphen", 2026-10-11) before the file was externally reverted; AD-8 is applied here as the later recorded decision — Michael to confirm. |
| FR-2.4 | **Collision handling:** if a custom slug is already taken, the system **shall** reject the request (HTTP 409) and suggest **3 availability-checked alternatives** (design §11 AD-8 — AM-5 resolved). Slugs from expired or deleted links are treated as taken and are **never released** in MVP (design §11 AD-5 — Q1 resolved). |
| FR-2.5 | **Idempotency:** creation requests **may** include an `Idempotency-Key` header; retries with the same key **shall** return the original result without creating duplicates. |
| FR-2.6 | **Expiration:** links **shall** be permanent by default; the user **may** optionally set an expiration at creation. Expiration is **not editable after creation** this phase (design §11 AD-6 — Q2 resolved). |
| FR-2.7 | **Abuse prevention:** link creation **shall** be protected by rate limiting and CAPTCHA. Trigger resolved: CAPTCHA challenges only risk-triggered ("suspicious") creates via a pluggable provider (design §11 AD-3 — Q5 trigger half resolved); creation is authenticated-only, no anonymous `POST /links` (design §11 AD-4 — Q10/A6 resolved). Provider vendor still open **[OPEN §8.5]**. |

**Acceptance criteria (EARS):**

- **AC-FR-2.1:** When an authorized caller sends `POST /links` with only a destination URL, the system shall create a link and return a short code and full short URL. *(A newly created slug may 404 for up to the negative-cache window: **[OPEN §8.5]** — design escalation E1(b).)*
- **AC-FR-2.2:** When no custom slug is supplied, the system shall generate an auto short code containing only `[a-zA-Z0-9]`.
- **AC-FR-2.3:** When an authorized caller supplies a valid 3–50 character custom slug matching strict `^[a-zA-Z0-9]{3,50}$` (AD-8) that is not taken, the system shall create the link with that slug; a slug containing `-` is rejected (conflict flag **[OPEN §8.5]**).
- **AC-FR-2.4:** If a requested custom slug is already taken — including one belonging to an expired or deleted link — the system shall reject the request and return suggested available alternatives.
- **AC-FR-2.5:** When a `POST /links` request is replayed with the same `Idempotency-Key`, the system shall return the original result and shall not create a duplicate link.
- **AC-FR-2.6:** When no expiration is supplied, the link shall be permanent; when an expiration is supplied, the system shall treat the link as expired after that time; `expiresAt` is immutable after creation (AD-6).
- **AC-FR-2.7:** While rate-limit or CAPTCHA checks fail, the system shall block link creation with the applicable error (`429` for rate limiting, per FR-8.2).

### FR-3: Link Management

| ID | Requirement |
|---|---|
| FR-3.1 | Authenticated users **shall** be able to list, retrieve, **edit the destination URL**, and **delete/disable** their own links. *(Wording — delete-only vs reversible disable — **[OPEN §8.5]**: design §11.2/§10.4, owner Michael.)* |
| FR-3.2 | Users **shall** only be able to view/modify links they own; non-owners **shall** receive an authorization error. |
| FR-3.3 | Single-resource operations only — **no bulk endpoints** in MVP. |

**Acceptance criteria (EARS):**

- **AC-FR-3.1:** When a link owner sends an update to a link's destination URL, the system shall persist the new destination; when the owner deletes or disables the link, subsequent redirect requests shall no longer resolve as an active link. *(Immediacy vs the design's redirect-cache windows: **[OPEN §8.5]** — design escalation E1.)*
- **AC-FR-3.2:** If an authenticated user attempts to modify a link they do not own, the system shall reject the request with an authorization error and make no change.
- **AC-FR-3.3:** The API shall expose no endpoint that creates, updates, or deletes more than one resource in a single call.

### FR-4: Redirects

| ID | Requirement |
|---|---|
| FR-4.1 | Active links **shall** respond with a fast redirect to the destination, with **no intermediate page**. The default status is **`302 Found` (temporary)** with `Cache-Control: no-store` — resolved per design §11 **AD-1** (human, 2026-10-12; first recorded in this artifact 2026-10-11). Rationale: accurate origin click counts; destination edits propagate per FR-3.1. (PRD FR-4.1 permits 301/302; 302 is the decided default.) |
| FR-4.2 | Expired links **shall** respond `410 Gone` with a JSON error body. |
| FR-4.3 | Unknown or deleted links **shall** respond `404 Not Found` with a JSON error body. |
| FR-4.4 | Every redirect response **shall** increment an aggregate click count. **No visitor IP or PII shall be stored.** |

**Acceptance criteria (EARS):**

- **AC-FR-4.1:** When a visitor requests `GET /{shortCode}` for an active link, the system shall respond with a **302** redirect (default per AD-1) pointing to the destination, without an intermediate page.
- **AC-FR-4.2:** When a visitor requests an expired link, the system shall respond `410 Gone` with a JSON error body.
- **AC-FR-4.3:** When a visitor requests an unknown or deleted short code, the system shall respond `404 Not Found` with a JSON error body.
- **AC-FR-4.4:** When a redirect is served, the system shall increment the link's aggregate click count and shall not store the visitor's IP address or any other visitor PII.

### FR-5: Analytics

| ID | Requirement |
|---|---|
| FR-5.1 | Link owners **shall** be able to read **total clicks**, **referrer breakdown**, and **country breakdown** for their links. Per-link aggregates (counts grouped by referrer host and country), not per-click logs — confirmed (design §11 AD-10 — A3 confirmed). |
| FR-5.2 | **Privacy constraints:** (a) do **not** store visitor IP addresses or other personally identifiable visitor data; (b) store **aggregate click counts**; (c) do **not** retain individual click events beyond **30 days**. |
| FR-5.3 | Users **shall** be able to delete their links and the associated analytics. |

Sub-decisions (all resolved via design §11): country detection = transient request-time in-process GeoIP, in-memory only, IP never persisted (AD-2 — Q4); click-count precision = un-capped `BIGINT` totals, no downsampling or caps (AD-9 — Q9); aggregation/retention = no raw click events ever stored, daily buckets purged ≤ 30 days, all-time totals kept indefinitely (AD-10 — AM-3/A3).

**Acceptance criteria (EARS):**

- **AC-FR-5.1:** When a link owner requests analytics for their link, the system shall return total clicks, a referrer breakdown, and a country breakdown.
- **AC-FR-5.2a:** While the system operates, it shall not store visitor IP addresses or other visitor PII; only aggregate counts shall be retained.
- **AC-FR-5.2b:** Individual click events older than 30 days shall be purged (or rolled up and the raw event discarded) within the 30-day retention window.
- **AC-FR-5.3:** When a user deletes a link, its associated analytics shall be deleted with it.

### FR-6: QR Codes

| ID | Requirement |
|---|---|
| FR-6.1 | The API **shall** generate a QR code for any of the requesting user's own links (ownership enforced per FR-3.2). |
| FR-6.2 | QR codes **shall** be downloadable as **PNG** and **SVG**. Payload = short URL, selected via `?format=png|svg`; **no styling options** (design §11 AD-15 — Q7 resolved). |

**Acceptance criteria (EARS):**

- **AC-FR-6.1:** When a link owner requests a QR code for their link, the system shall return a QR code encoding that link's short URL (payload confirmed — AD-15).
- **AC-FR-6.2:** The QR endpoint shall support output in both PNG and SVG formats.
- **AC-FR-6.3:** If a non-owner requests a QR code for another user's link, the system shall reject with an authorization error.

### FR-7: API Surface & Behavior

| ID | Requirement |
|---|---|
| FR-7.1 | The system **shall** expose a full REST API covering accounts, links, analytics, and QR codes. |
| FR-7.2 | All error responses **shall** be JSON with a consistent, machine-readable error shape. |
| FR-7.3 | All responses **shall** be machine-readable JSON where a body is returned; redirect status codes **shall** be used for active links (bodies on `404`/`410` per FR-4.2/4.3). |

**Acceptance criteria (EARS):**

- **AC-FR-7.1:** The API shall provide endpoints for account registration/verification/deletion, link CRUD, analytics reads, and QR code retrieval.
- **AC-FR-7.2:** Every error response shall use one consistent JSON error schema across all endpoints.
- **AC-FR-7.3:** Responses for `404`, `410`, and other body-bearing statuses shall be JSON; active-link responses shall use a redirect status code.

### FR-8: Rate Limiting

| ID | Requirement |
|---|---|
| FR-8.1 | Per-user rate limits **shall** be applied, baseline **100 requests/minute** per user/key. |
| FR-8.2 | Rate-limited requests **shall** return a standard `429 Too Many Requests` response with retry guidance (e.g., retry-after hint). |
| FR-8.3 | Tiering: **none in MVP** — the baseline is uniform at 100 requests/minute for all users (design §11 AD-7 — Q3 closed for MVP, A4 confirmed; a subject-policy extension point is retained for any future tier). Anonymous/redirect traffic is **not** application-rate-limited (AM-4 closed by AD-7). |

**Acceptance criteria (EARS):**

- **AC-FR-8.1:** While a user or key exceeds 100 requests in a one-minute window, subsequent requests shall receive `429 Too Many Requests` including retry guidance.
- **AC-FR-8.2:** When request rate is within the baseline, the system shall serve requests normally.

### FR-9: Deployment & Platform

| ID | Requirement |
|---|---|
| FR-9.1 | The application **shall** be deployed as a **serverless** application. |
| FR-9.2 | Data **shall** be stored in the existing **PostgreSQL database on AWS RDS** (adequately provisioned, externally managed — confirmed: Multi-AZ; design §11 AD-11, A1 confirmed). |
| FR-9.3 | The solution **shall** be lightweight enough to run against a local PostgreSQL for development (NFR-8). Serverless platform confirmed: **AWS Lambda + API Gateway HTTP API**, dual local-entrypoint portability retained (design §11 AD-12 — A2 confirmed). |

**Acceptance criteria (EARS):**

- **AC-FR-9.1:** The service shall run on a serverless platform with no long-lived server dependency.
- **AC-FR-9.2:** All persistent data (accounts, links, aggregates) shall reside in the AWS RDS PostgreSQL instance.
- **AC-FR-9.3:** A developer shall be able to run the application locally against a local PostgreSQL instance.

### FR-10: Observability

| ID | Requirement |
|---|---|
| FR-10.1 | **Structured JSON logging** shall be emitted for all requests. |
| FR-10.2 | **Health check endpoint(s)** shall be exposed. |
 FR-10.3 | **Metrics** shall cover request rates, response latency, error rates, and URL redirects. |
| FR-10.4 | **Distributed tracing** via OpenTelemetry shall be provided where useful. |
| FR-10.5 | **Basic error alerting** shall be configured. |
| FR-10.6 | Monitoring **shall** remain lightweight and suitable for local development; the Architect selects the specific tools. |

**Acceptance criteria (EARS):**

- **AC-FR-10.1:** Every request shall produce a structured JSON log entry.
- **AC-FR-10.2:** A health check endpoint shall respond successfully when the service is healthy.
- **AC-FR-10.3:** Metrics shall be available for request rate, response latency, error rate, and redirect volume.
- **AC-FR-10.4:** Distributed traces shall be emitted via OpenTelemetry and shall work in local development.
- **AC-FR-10.5:** The system shall raise basic alerts on error conditions.

---

## 6. Non-Functional Requirements

| ID | Category | Requirement (from PRD §7) |
|---|---|---|
| NFR-1 | Performance | Redirects must be fast: immediate 301/302, no interstitial. Latency budgets to be **defined by the Architect**. |
| NFR-2 | Scale | Must support **10,000+ users** and **1,000,000+ links**. |
| NFR-3 | Availability | High availability for the redirect path; health checks exposed. |
| NFR-4 | Privacy | No visitor IPs or PII stored; aggregate counts only; individual click events purged within **30 days**. |
| NFR-5 | Security | Rate limiting + CAPTCHA on creation; email verification before link creation; per-user ownership checks; API key/JWT auth. |
| NFR-6 | Data lifecycle | Users can delete their links and associated analytics at any time. |
| NFR-7 | Portability | Serverless-friendly; works against existing AWS RDS PostgreSQL; lightweight enough for local development. |
| NFR-8 | Observability | JSON logs, metrics, health checks, OpenTelemetry tracing, basic alerting (see FR-10). |
| NFR-9 | Extensibility | Single shared domain now; custom domains designed for in a later version (v2). |

**Acceptance criteria (EARS):**

- **AC-NFR-1:** When a visitor requests an active short link, the system shall respond with a redirect and no interstitial page; latency targets shall be set by the Architect during design.
- **AC-NFR-2:** The system shall operate at 10,000+ users and 1,000,000+ links without requirement changes.
- **AC-NFR-3:** Health checks shall be exposed and the redirect path shall meet the availability goals set during design.
- **AC-NFR-4:** No data store shall contain visitor IP addresses or visitor PII; individual click events shall not survive beyond 30 days.
- **AC-NFR-6:** A user shall be able to delete a link and its analytics at any time via the API.

---

## 7. Acceptance Criteria Traceability (PRD §9)

| AC ID | PRD acceptance criterion (condensed) | Mapped requirements |
|---|---|---|
| AC-01 | Signup & verification: register via email/password or Google/GitHub; unverified user gets an error on link creation; verified user succeeds | FR-1.1, FR-1.2, NFR-5 · resolved AD-14 |
| AC-02 | Create link: authenticated `POST /links` with only a destination returns a short URL with auto-generated alphanumeric code | FR-2.1, FR-2.2 |
| AC-03 | Custom slug: supplying `my-campaign` (stated as 3–50 alphanumeric chars) gets that slug; an existing slug returns rejection + suggestions | FR-2.3, FR-2.4 — strict charset `[a-zA-Z0-9]` per AD-8, AD-5: **PRD's `my-campaign` example contains `-` and would be rejected — conflict [OPEN §8.5]** |
| AC-04 | Idempotency: replaying `POST /links` with same `Idempotency-Key` returns original link, no duplicate | FR-2.5 |
| AC-05 | Redirect: `GET /{shortCode}` for an active link responds **302** (decided default) to destination, no intermediate page | FR-4.1 · resolved AD-1 |
| AC-06 | Expired link: responds `410 Gone` with JSON error | FR-4.2, FR-7.2 |
| AC-07 | Unknown/deleted link: responds `404 Not Found` with JSON error | FR-4.3, FR-7.2 |
| AC-08 | Edit & delete: owner updates destination and deletes/disables; non-owner receives authorization error | FR-3.1, FR-3.2 · delete/disable wording [OPEN §8.5] |
| AC-09 | Analytics: owner retrieves total clicks, referrer and country breakdowns; no visitor IP/PII stored; events not retained beyond 30 days | FR-5.1, FR-5.2, NFR-4 · resolved AD-2, AD-9, AD-10 |
| AC-10 | QR codes: owner downloads QR for their link in PNG and SVG | FR-6.1, FR-6.2 · resolved AD-15 |
| AC-11 | Rate limiting: >100 req/min returns `429` with retry guidance; link creation is CAPTCHA-protected | FR-8.1, FR-8.2, FR-2.7 · resolved AD-7 (uniform baseline); CAPTCHA mode AD-3 — provider vendor [OPEN §8.5] |
| AC-12 | Observability: health check responds; JSON logs emitted; metrics cover request rate, latency, error rate, redirects; tracing works locally | FR-10.1–10.4, NFR-8 |
| AC-13 | Account deletion: user deletes account, removing links and associated analytics | FR-1.4, FR-5.3, NFR-6 · resolved AD-13 |

---

## 8. Product Decisions — Resolved & Unresolved

> **Open items stay visible until a human resolves them; resolved items are recorded here with their source.** Reconciled 2026-10-13 against `design.md` §11 (resolution log AD-1…AD-15, human decision-maker, 2026-10-12) and the PRD. Earlier `[PENDING Qn]` / `[PENDING A-n]` / `[AM-n]` markers have been converted to the resolutions below.
>
> **Artifact-state note:** this file was found externally reverted to its 2026-10-11 original (mtime 2026-10-12 16:08), losing the 2026-10-11 §8.0 records for Q8/Q10/AM-1 and the §3.2 CDN scope bullet. Q8 and Q10 are re-recorded below (outcomes match design §11 AD-1/AD-4); the AM-1 outcome **does not** match design §11 AD-8 and is flagged in §8.5.

### 8.0 Resolved decisions (recorded — do not re-open without a new human ruling)

| ID | Topic | Resolution (human) | Source | Affected requirements |
|---|---|---|---|---|
| Q1 | Slug reclamation | Tombstones **never released** in MVP; slugs locked first-come-first-served permanently | design §11 AD-5 (2026-10-12) | FR-2.4, AC-03 |
| Q2 | Expiration editing | PATCH = `destinationUrl` only; `expiresAt` immutable after creation this phase | design §11 AD-6 | FR-2.6, FR-3.1 |
| Q3 | Rate-limit tiers | Uniform 100 req/min for MVP — no tiers; subject-policy extension retained for later | design §11 AD-7 | FR-8.1–8.3, AC-11 |
| Q4 | Country detection | Option B: transient request-time in-process GeoIP; IP never persisted or logged | design §11 AD-2 | FR-5.1/5.2, AC-09 |
| Q6 | Social login scope | Google + GitHub exclusively | design §11 AD-14 | FR-1.1, AC-01 |
| Q7 | QR payload & styling | Payload = short URL; `?format=png|svg`; no styling options | design §11 AD-15 | FR-6.1/6.2, AC-10 |
| Q8 | Redirect default | **302 temporary** + `Cache-Control: no-store`; Tier-2 CDN not included | design §11 AD-1; also first recorded in this artifact 2026-10-11 | FR-4.1, AC-05 |
| Q9 | Click-count precision | Un-capped `BIGINT` totals; no downsampling or maintenance caps | design §11 AD-9 | FR-5.1/5.2, AC-09 |
| Q10 | Anonymous link creation | **Account required** — authenticated `POST /links` only; anonymous → 401 | design §11 AD-4; also first recorded in this artifact 2026-10-11 | FR-1.2, FR-2.7, A6 |
| A1 | RDS capacity/management | Confirmed — adequately provisioned, Multi-AZ | design §11 AD-11 | FR-9.2, NFR-2/3 |
| A2 | Platform left to Architect | Confirmed — AWS Lambda + API Gateway HTTP API | design §11 AD-12 | FR-9.1, FR-9.3 |
| A3 | Analytics = per-link aggregates | Confirmed — aggregates, not per-click logs | design §11 AD-10 | FR-5.1, FR-5.2 |
| A4 | Uniform 100 req/min | Confirmed | design §11 AD-7 | FR-8.1, FR-8.3 |
| A5 | Double opt-in verification | Confirmed — standard double opt-in; no deliverability SLA | design §11 AD-14 | FR-1.2 |
| A6 | CAPTCHA/rate-limit if anonymous allowed | **Moot** — anonymous creation forbidden (AD-4); controls apply to the authenticated create path | design §11 AD-4 | FR-2.7 |
| A7 | Account deletion immediate/irreversible | Confirmed — hard-delete cascade via transactional FK constraints | design §11 AD-13 | FR-1.4, FR-5.3, AC-13 |
| AM-1 | Slug charset contradiction (PRD FR-2.3 vs AC-3 example) | **Strict `[a-zA-Z0-9]`** — no hyphens; enforced in app validator and DB CHECK | design §11 AD-8 | FR-2.3, FR-2.4, AC-03 — ⚠ **conflict [OPEN §8.5]** |
| AM-3 | Aggregation vs. retention mechanics | Conservative reading: no raw events ever stored; daily buckets purged ≤ 30 days; all-time totals kept indefinitely | design §11 AD-10 | FR-5.1, FR-5.2, NFR-4 |
| AM-4 | Anonymous/redirect rate limiting | Closed — application rate limiting scoped to `user:`/`apikey:` subjects only; anonymous redirect traffic not app-limited | design §11 AD-7 | FR-8.1, FR-4 |
| AM-5 | Slug suggestions unspecified | HTTP 409 + **3 availability-checked alternatives** in the response body | design §11 AD-8 | FR-2.4 |

*(Q5 is only **partly** resolved — trigger mode via AD-3; the provider vendor remains open: §8.1 and §8.5.)*

### 8.1 Open Questions (from PRD §10 — only Q5 remains, narrowed)

| # | Question | Status / impact | Dependent requirements |
|---|---|---|---|
| Q5 | **CAPTCHA provider & trigger:** Which CAPTCHA, and is it required on every create or only when suspicious? | **Trigger RESOLVED** — pluggable `CaptchaProvider`, mode `suspicious` (design §11 AD-3). **Provider vendor still OPEN** (design §10.8/§11.2, owner Michael) | FR-2.7, AC-FR-2.7, AC-11 |

*Q1–Q4 and Q6–Q10 are resolved — see §8.0.*

### 8.2 Assumptions (A1–A7) — all confirmed

All seven assumptions are **confirmed or moot** per design §11: A1 → AD-11, A2 → AD-12, A3 → AD-10, A4 → AD-7, A5 → AD-14, A6 → AD-4 (moot), A7 → AD-13 (full texts in PRD §10; decisions in §8.0). **None remain open.**

### 8.3 Requirement → open decision dependency index

*All former [PENDING …] dependencies were cleared by the 2026-10-13 reconciliation (see §8.0). Only these remain:*

| Requirement | Depends on (still open) |
|---|---|
| FR-2.7 (live CAPTCHA challenge) | Q5 provider vendor — design §10.8 / §11.2 |
| FR-5.1 (country-breakdown provisioning) | GeoIP database vendor/license — design §10.9 / §11.2 (requirement text final; AD-2 Option B stands) |
| FR-3.1 / AC-FR-3.1 (delete vs disable wording) | design §10.4 / §11.2 (Michael) |
| AC-FR-3.1 / AC-FR-2.1 (delete & create resolution immediacy) | design escalation **E1** (§13.3): 60s deleted-as-active, 30s negative-cache — open; edit-propagation ≤60s already AD-1-accepted, confirm as intended |
| FR-2.3 / FR-2.4 / AC-03 (slug charset) | AD-8 applied — ⚠ conflict with the 2026-10-11 "allow hyphen" record: §8.5 |
| (documentation only) | AM-2 — PRD header/footer status |

### 8.4 Additional ambiguities found during specification (NOT in PRD — do not resolve here; for Michael)

These were identified while writing this specification and are **not** part of the approved PRD. **AM-1, AM-3, AM-4, AM-5 are resolved — see §8.0.** Still open:

| ID | Issue | Impact |
|---|---|---|
| AM-2 | **PRD status inconsistency:** header states `Status: Approved`, while the footer states "This PRD is a draft. It requires explicit human approval before any implementation begins." | Documentation only. Per Michael's instruction this specification treats the PRD as approved and immutable; flagging for the record. Kept open by design §11.2. |

### 8.5 Still open after reconciliation (2026-10-13) — awaiting human input

| # | Item | Source | Affects | Owner |
|---|---|---|---|---|
| 1 | ⚠ **AM-1 / AC-03 charset conflict:** design §11 AD-8 (strict `[a-zA-Z0-9]`, 2026-10-12) contradicts the earlier human ruling recorded in this artifact on 2026-10-11 ("allow hyphen", `[a-zA-Z0-9-]`), which was lost when requirements.md was externally reverted (mtime 2026-10-12 16:08). AD-8 is applied here as the later recorded decision. Under AD-8, PRD AC-3's example slug `my-campaign` (contains `-`) is rejected — the PRD-internal contradiction persists. | design §11 AD-8 vs. prior §8.0 record; PRD FR-2.3 vs. PRD AC-3 | FR-2.3, FR-2.4, AC-03 | Human (Michael) |
| 2 | **CAPTCHA provider vendor** (Q5's vendor half) — the `CaptchaProvider` interface and `suspicious` mode ship regardless, but no vendor is named | design §10.8, §11.2 | FR-2.7 live challenge | Human (Michael) |
| 3 | **GeoIP database vendor/license** for AD-2 Option B (layer/local-file provisioning only) | design §10.9, §11.2 | FR-5.1 country breakdown provisioning | Human/Developer |
| 4 | **FR-3.1 "delete/disable" wording** — delete-only vs reversible disable (endpoint already satisfies AC-FR-3.1; a reversible disable would be additive) | design §10.4, §11.2 | FR-3.1, AC-FR-3.1, AC-08 | Human (Michael) |
| 5 | **AM-2** — PRD header says "Approved", footer says "draft" | §8.4; design §11.2 | Documentation only | Human |
| 6 | **E1 — Redirect cache immediacy windows (design escalation §13.3 — open; "AC semantics must be confirmed"):** three product-visible legs against this artifact's ACs: **(a)** a deleted/disabled link (incl. account-cascade deletes) may still 302 for up to **60s** — vs AC-FR-3.1 "subsequent redirect requests shall no longer resolve"; **(b)** a newly created slug may 404 for up to **30s** (negative cache) — vs AC-FR-2.1; **(c)** destination edits propagate in ≤60s — already accepted under AD-1/D-9, to "confirm as intended". Design offers Options A/B/C (accept bounded windows / strict immediacy / shared cache + invalidation); pending the human decision, design implements AD-1's 60s/30s TTLs (Option C must not be implemented without a new human decision). | design.md §13.3 (readiness review 2026-10-13) + §12 readiness row | AC-FR-3.1, AC-FR-2.1, FR-3.1, FR-2.1, FR-4.1 | Human (Michael) |

---

## 9. Artifact boundaries

This artifact contains requirements only. Per my role: no architecture, no `design.md`, no `tasks.md`, no implementation code, no tickets, no changes to the PRD. **Resolved (2026-10-13, sourced from design.md §11 AD-1…AD-15, human 2026-10-12):** Q1–Q4, Q6–Q10, A1–A7, AM-1, AM-3, AM-4, AM-5. **Still open and reported to Michael (§8.5):** the AM-1/AC-03 charset conflict, the Q5 CAPTCHA provider vendor, the GeoIP database vendor/license, the FR-3.1 delete/disable wording, AM-2, and the cache-immediacy windows escalation (design E1).

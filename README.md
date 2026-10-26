# URL Shortener API

A privacy-first URL shortener delivered as an **API + database only** — no frontend.
Accounts with dual authentication (API keys + JWT), link CRUD with auto-generated and
custom slugs, idempotent creation, fast anonymous redirects (302 / 410 / 404),
aggregate-only analytics, QR codes, per-user rate limiting, risk-triggered CAPTCHA —
deployed serverless (AWS Lambda + API Gateway HTTP API) against the existing
PostgreSQL on AWS RDS.

- Product source of truth: [`PRD.md`](./PRD.md) (Approved, 2026-10-08 — immutable)
- Requirements: [`specs/url-shortener-api/requirements.md`](./specs/url-shortener-api/requirements.md)
- Architecture: [`specs/url-shortener-api/design.md`](./specs/url-shortener-api/design.md)

> **Repository state:** this foundation baseline (URL-18) provides the repo, tooling,
> config contract, and module boundaries. The Fastify app entrypoint (`src/index.ts`),
> the docker-compose stack, the CDK infrastructure, and the first DB migrations land
> with the follow-up tickets **URL-7** (scaffolding) and **URL-8** (schema &
> migrations) — commands below that depend on them are noted as such.

## Prerequisites

- **Node.js 22 LTS** (or newer; `engines.node` enforces `>=22`) and npm
- **Docker + Docker Compose** (for the local PostgreSQL / Jaeger / MailHog stack — URL-7)

## Install

```bash
npm install
```

## Configure the environment

```bash
cp .env.example .env   # then edit as needed
```

`.env.example` enumerates every environment variable with placeholders only.
**Endpoints and secrets are environment-specific and never hardcoded** (design §6.2,
§9.4): locally they come from the gitignored `.env`; in the cloud they are injected at
deploy time via Secrets Manager / CDK outputs. Never commit real credentials.

Note the `REDIRECT_STATUS` contract: **default 302 — fixed by AD-1/AC-FR-4.1;
changing it requires a new human decision.** Config validation blocks any non-302
value unless the explicit override flag `REDIRECT_STATUS_ALLOW_NON_DEFAULT=true` is
set (and it warns loudly even then).

## Run locally (FR-9.3 / NFR-7)

```bash
docker compose up -d   # local PostgreSQL (+ Jaeger, MailHog) — stack provided by URL-7
npm run migrate        # apply DB migrations — first migrations provided by URL-8
npm run dev            # local dev server (src/index.ts entrypoint — provided by URL-7)
```

The same Fastify application runs locally as a plain Node HTTP server and, in AWS,
behind API Gateway via the Lambda adapter — no cloud emulation needed for development.

## Test

```bash
npm test              # vitest with coverage — includes the coverage gate below
npm run test:coverage # same as npm test (explicit alias)
npm run typecheck     # tsc --noEmit (strict)
npm run lint          # eslint (includes the portability-seam rule)
npm run format        # prettier --write
```

**Coverage gate (design §7):** `npm test` enforces **90% line coverage on
`src/auth` and `src/links`** — the run fails when the thresholds are unmet. URL-7's
CI executes the same commands; no merge without green lint + tests.

**Portability seam (FR-9.3, design §3.9):** ESLint fails any domain module
(`src/{auth,links,analytics,qr,geo}`) that imports a Lambda/API Gateway adapter or a
cloud provider SDK directly. Cloud adapters belong in the entrypoint/platform layer;
domain code stays portable and unit-testable without cloud emulation.

## Build & start (production-shape)

```bash
npm run build   # tsc → dist/
npm start       # node dist/index.js
```

## Repository layout

```
src/
  auth/        # accounts, sessions, API keys, OAuth        (design §3.9 module)
  links/       # link CRUD, slug handling                   (design §3.9 module)
  analytics/   # read-only aggregate analytics              (design §3.9 module)
  qr/          # on-demand PNG/SVG QR codes                  (design §3.9 module)
  geo/         # transient request-time GeoIP (IP never persisted — AD-2)
  platform/    # shared platform layer: config contract, redirect response
migrations/    # node-pg-migrate migrations                 (URL-8 owns content)
infra/         # AWS CDK infrastructure                     (URL-7 owns content)
tests/
  unit/        # vitest unit tests
  integration/ # vitest integration tests (real HTTP via supertest)
  contract/    # OpenAPI/schema contract tests               (URL-23 owns content)
```

Domain modules import nothing from Lambda/API Gateway or cloud SDKs (enforced by
`npm run lint`); only the platform/entrypoint layer may touch cloud adapters.

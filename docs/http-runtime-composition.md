# Shared HTTP runtime composition

This is URL-11's corrective runtime wiring, not a change to link-domain behavior
or acceptance. Pam's [post-merge FAIL](https://github.com/roy-melamed/url-shortener-api/pull/30#issuecomment-7037629757)
tested `85f1716ff7666a825019197f69f539bb75cbc966`: the shipped entrypoints used
bare `buildApp({config})`, so POST /v1/links was absent even though explicitly
wired component fixtures passed. The original report/history is preserved.

## Actual shipped composition

`src/index.ts` and the Lambda HTTP factory `src/functions/http.ts` both call
`buildRuntimeApp()` from `src/platform/http-runtime.ts`. It returns `{app, config}`
so the local listener uses the same validated port/config without a second load.
The Lambda API/redirect wrappers and legacy `src/lambda.ts` all use that factory.
There is no test-only branch or production fallback to the bare app.

The composition constructs the actual `PostgresApiKeyStore`, `ApiKeys`,
`BearerAuthentication`, `PostgresLinkCreationStore` and `LinkCreation`, and injects
the existing module-owned `processRequestLimiter`. The existing route enforces
validation → trusted auth → limiter → verified owner → domain writes unchanged.
Canonical subject vs owner userId, idempotency, slug charset and all domain SQL
remain unchanged. Existing key-management routes are registered by the already
shipped bearer-auth contract; account issuance/refresh/mail wiring is not expanded.

The service owns one lazy pool per runtime/app, using existing DATABASE_URL,
DB_POOL_MAX, timeout and TLS settings through `createPool`. Pool construction,
health and anonymous/invalid-JWT requests do **not** connect to PostgreSQL.
Authenticated access needs the real database; there is no memory fallback.
`app.close()` ends the pool, including local SIGTERM/SIGINT shutdown. Idle pool
errors are logged as a fixed message without driver/SQL/credential details.

## Required owner-injected settings

Alongside the existing database configuration, both entrypoint families require:

| Setting              | Contract                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------- |
| `PUBLIC_BASE_URL`    | HTTP(S) root origin; no credentials/path/query/fragment. Never inferred from Host/Forwarded.              |
| `JWT_PUBLIC_KEY_PEM` | Owner-supplied RSA **public** PEM matching the existing URL-9 issuer; private PEM is explicitly rejected. |
| `JWT_ISSUER`         | Exact issuer expected from URL-9.                                                                         |
| `JWT_AUDIENCE`       | Exact expected audience.                                                                                  |
| `JWT_KEY_ID`         | Exact approved key ID, matching JWT kid.                                                                  |

There are **no defaults** for trust/origin, no generated runtime signing keys,
private-key requirement, signing capability, external provider or secret lookup.
Local dotenv can load quoted multiline public PEM from the existing ignored
`.env`; Lambda reads injected environment only. `.env.example` contains names
and empty placeholders, not actual keys/targets. Operators must supply these
values through their approved configuration path before starting a release.
Nothing in this change configures or deploys a live environment.

Missing/invalid settings fail before pool construction/listening with a fixed
ConfigError listing required setting names, never their values or parse causes.
This intentionally replaces a misleading healthy-but-route-less process, not
an optional route flag. Invalid/missing database configuration retains existing
loadConfig behavior. Boot does not certify database reachability/readiness.

`JoseAccessTokenVerifier` exposes URL-9's **same** strict verification algorithm
without requiring a private key. `JoseAccessTokens` retains its constructor and
issue contract, inherits that shared verifier and still requires the private
key for issuance. RS256 signature, typ/kid/issuer/audience, sub/iat/exp/jti,
900-second lifetime, no future issuance and expiration checks are unchanged.
No refresh behavior, key rotation policy or authentication fallback is added.

## Regression evidence and boundaries

- A real child boots `src/index.ts` with disposable owner-public-key settings,
  returns health200 and anonymous POST401 (not404), retains strict X-5 rejection,
  and shuts down. A missing-key child fails before listening.
- Actual legacy/API/redirect Lambda entrypoint imports receive API Gateway POST
  events and return correlated401 through the same production composition.
- Unit checks cover fail-fast/redacted configuration, public-only verification,
  pool laziness/close lifecycle and generic idle error logging.
- Three guarded PostgreSQL cases invoke `buildRuntimeApp` itself with only
  environment configuration, not injected fake services. Both JWT and API-key
  paths exercise real creation/replay and shared-process100/101 across two runtime
  builds; unverified/auth/input negatives have no domain writes. They reuse the
  existing migrated loopback account_auth_test schema fixture. If unavailable
  locally they are CI-only/unexecuted locally, not passed by assertion.

Exact commands, exits, counts and fresh CI/test-merge evidence are in the fix PR.
These are corrective premerge checks, not Pam's post-merge retest or ticket PASS.
X-5 remains unresolved: `my-campaign` is rejected and full AC-03 is not claimed
accepted. AC-FR-2.8 remains absent. No CAPTCHA, social OAuth, global quota,
infrastructure, deployment, Jira mutation or acceptance change is included.
Process quota still does not span workers/instances/restarts. Reverting wiring
would reintroduce the missing-route defect, not be an equivalent safe release.

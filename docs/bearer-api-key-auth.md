# API-key management and trusted bearer authentication

URL-22 implements active FR-1.3 / AC-FR-1.3, design D-11, §§3.3, 5.1, 6.1,
using the approved 2026-11-15 amendment. OAuth is deferred. URL-9 owns token
issuance/refresh; URL-11 owns link creation and its email-verification gate.
This change adds neither those endpoints nor rate-limiter behavior/infrastructure.

## Existing contracts and injection

Base main `57fec3f77d40e802f38ddb1bd42fa1640899de35` contains:

- URL-9 `AccessTokens.verify(token, now): Promise<string>` and
  `JoseAccessTokens`, using injected owner RSA keys, issuer/audience/key ID.
  It checks RS256 signature, typ/kid, issuer/audience, UUID sub/jti, integer iat/exp,
  exact 900-second lifetime, no future issuance and expiry. URL-22 reuses this
  verifier, not an independent JWT implementation or a token decoder.
- URL-8 `users` and `api_keys`, including unique `key_prefix`, SHA-256 `key_hash`,
  owner FK cascade and usage/revocation timestamps. No migration is necessary.
- URL-9's requirement that consumers look up an existing user after verifying a
  JWT, so a deleted account cannot keep authorizing requests by signature alone.

Explicit application construction follows URL-9's dependency-injection pattern:

```ts
const apiKeys = new ApiKeys(new PostgresApiKeyStore(pool));
const authentication = new BearerAuthentication({
  apiKeys,
  accessTokens, // the SAME URL-9 verifier/key configuration used by issuance
});
const app = buildApp({
  config,
  accounts, // existing URL-9 service, unchanged
  bearerAuth: { authentication, apiKeys },
});
```

Use the same `apiKeys` instance for the resolver and routes. These URL-shortener
service objects live with the application/pool; no global secret state, timer,
background process or pool is created. The caller owns pool lifecycle. Local
fixtures inject a test store and generated disposable RSA keys. Default local/
Lambda entrypoints still have no account/verifier/key/pool defaults: do not infer
deployment activation or silently discover owner secrets. Like existing account
routes, key routes are registered only with explicit dependencies.

## Management HTTP contract

All three operations require **JWT**, not an API key:

| Operation                      | Input                                                                        | Response                                                 |
| ------------------------------ | ---------------------------------------------------------------------------- | -------------------------------------------------------- |
| `POST /v1/auth/api-keys`       | `{ "name": "local client" }`, nonblank ≤128 chars, no owner/extra properties | 201 metadata plus `key` plaintext **once**               |
| `GET /v1/auth/api-keys`        | none                                                                         | 200 `{ "keys": [metadata] }`, only JWT owner's keys      |
| `DELETE /v1/auth/api-keys/:id` | canonical lowercase UUID                                                     | 204; repeat by owner remains 204; unknown/foreign ID 404 |

Metadata is an explicit allowlist: `id`, `name`, `keyPrefix`, `createdAt`,
`lastUsedAt`, `revokedAt`. Listing includes revoked metadata for owner visibility;
it never returns the hash or full key. No plaintext retrieval operation exists.
Responses, including management errors, have `Cache-Control: no-store` and
`Pragma: no-cache`. Error bodies use the existing correlated JSON envelope.

Keys are `usk_<8 lowercase hex chars>_<43 base64url chars>`: a random 4-byte
lookup prefix plus independent random 32-byte secret, with canonical unpadded
base64url encoding. Only SHA-256 of the **full key** and the unique prefix are
stored. Prefix collision retries are capped at five; other persistence failures
are redacted 503s. Plaintext is returned only after successful persistence; an
uncertain commit/lost response may leave an inaccessible key, not a plaintext
recovery channel. User-supplied names are trimmed and cannot select ownership.

## Protected-route contract and ordering

Future routes opt in with `preHandler: authentication.authenticate`, after any
Fastify schema validation and before protected handler/database work. Key
management uses `authentication.requireJwt` followed by body/ID service validation.
Authentication always completes before the handler. Unprotected health/account
routes are not globally forced through auth.

`authentication.principal(request)` returns a frozen server-owned context held in
a private WeakMap, never a client-selected request decoration/header:

- JWT: `{ kind: 'user', userId, subject: 'user:<canonical UUID>' }`.
- API key: `{ kind: 'apikey', userId, keyId, subject: 'apikey:<key UUID>' }`.

Use **`userId` for ownership** and **`subject` for namespaced rate limiting**. Key
subjects use the key row ID, never owner ID, prefix, plaintext or a JWT claim
chosen without verification. Same-owner keys have distinct subjects. Requests
cannot change identity through `x-user-id`, `x-principal` or test-only headers.
Context is absent until verification succeeds and cleared before reauthentication.

Only one Authorization field is accepted. Parse case-insensitive Bearer scheme,
one space, one bounded non-whitespace/non-comma credential; dispatch `usk_` keys
to the key verifier, otherwise delegate to URL-9. There is no fallback from failed
API-key verification to JWT or vice versa. Key management rejects API keys before
any key usage mutation. Missing/invalid/malformed/expired JWT, forged/unknown/
revoked key and missing account all yield 401 `UNAUTHENTICATED` with generic
`Invalid credentials.` and requestId, never credential material. Existing JWT
signature/claims/lifetime tests remain intact.

The API-key verifier uses prefix lookup and `timingSafeEqual` on fixed-length
SHA-256 buffers (URL-9's existing `tokenHashMatches` helper). Unknown prefixes use
a dummy digest comparison. Parsing and database lookup are **not** claimed to be
constant-time; only secret digest equality is. Canonical IDs are checked before
publishing context. Usage is conditionally updated only while unrevoked and the
owner exists, rechecking a revocation/account-deletion race after lookup. A
revocation affects subsequent authentications; already-authorized in-flight work
is not retroactively cancelled. API keys have no expiry column/policy in the
approved schema; no new expiration product behavior is invented.

## Boundaries, reversal and verification

No link route, create verification gate, CAPTCHA, OAuth, limiter wiring/global
quota, secret backend, cloud resource, runtime deployment or Jira mutation is
included. URL-10's quotas remain process-local; workers/instances/restarts are
not a global quota. Reversal removes opt-in registration/dependencies without a
schema migration; existing key records remain hashed and revocable.

Names describe purpose and URL-shortener ownership; no legacy identifier is
renamed and no checker exception is added. Tests cover real URL-9 signed JWTs,
CRUD ownership/disclosure, digest persistence, credential failures, ordering and
trusted principal mapping; unit tests check redacted parameterized SQL and races.
Disposable PostgreSQL tests use the existing guarded loopback
`TEST_ACCOUNT_DATABASE_URL` / `account_auth_test` fixture with a unique schema.
They are skipped—not passed—when unavailable. Actual commands/results and fresh
CI are recorded in the implementation PR, not represented as post-merge QA.

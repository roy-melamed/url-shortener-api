# Authenticated transactional link creation — URL-11

Implements `POST /v1/links` under approved Product Owner Alternative A and the
2026-11-15 MVP amendment. Read before coding, without altering the source:

- `specs/url-shortener-api/amendments/2026-11-20-url10-url11-acceptance-boundary.md`
- `specs/url-shortener-api/url10-url11-acceptance-boundary-architecture-review-2026-11-20.md`

These two artifacts were available in the squad workspace, not yet on base main
`09ea58d65c2f0e4019485550658f04a4c151eb91`. They allocate component acceptance
to URL-10 and real creation/integration acceptance to URL-11. The dispatch records
URL-9 Approved, Pam's revised URL-10 component PASS at Evidence Review, and
URL-22 merged full-ticket QA PASS at Evidence Review. Evidence Review is **not
human Approved**; no approval is inferred, replayed or performed here. Native
edges 10003/10004 remain unchanged. Michael supplied a read-only export of the
reconciled URL-11 description and cross-checked requirements: **AC-FR-2.8 is not
present**, so no new criterion is invented.

## Composition and safe lifecycle order

```ts
const apiKeys = new ApiKeys(new PostgresApiKeyStore(pool));
const authentication = new BearerAuthentication({ apiKeys, accessTokens });
const links = new LinkCreation({
  store: new PostgresLinkCreationStore(pool),
  publicBaseUrl: configuredPublicOrigin,
});
const app = buildApp({
  config,
  accounts, // unchanged URL-9 account/session service
  bearerAuth: { authentication, apiKeys },
  links,
});
```

The URL-shortener service owns the injected service/pool lifetimes. No new pool,
secret discovery, connection target, schema or default deployment activation is
introduced. Existing entrypoints, like the account/key units, require explicit
owner-provided composition before exposing these routes. Missing trusted auth
with a supplied links service is a construction error, never anonymous creation.
The public origin is trusted configuration, not Host/Forwarded headers.

One module-cached `processRequestLimiter` is shared by default across app builds
and future routes in the same process. An explicit `requestLimiter` override is
for a caller-owned shared instance/test clock, never construction per request or
per route. The existing URL-10 algorithm is unchanged. **Workers, containers,
hosts and restarted processes have independent/reset quotas: this is not a
global cross-process ceiling.** Existing component memory/capacity limits remain.

Route flow:

1. JSON parsing, 16 KiB body bound, strict body/URL/slug/date/header validation.
   Unknown properties (including owner overrides), non-HTTP(S), >2048-character
   URLs, malformed dates/slugs/keys and duplicate Idempotency-Key fields fail
   without authentication/quota/domain work. The literal strict slug regex is
   `^[a-zA-Z0-9]{3,50}$`; terminal whitespace is additionally rejected.
2. URL-22 `authentication.authenticate` verifies JWT/API key and existing owner.
   No client identity headers are consumed. Missing/invalid credentials yield 401
   `UNAUTHENTICATED`; token validation uses the unchanged URL-9 verifier.
3. URL-10 `enforceRequestLimit` consumes trusted `principal.subject`. First 100
   accepted attempts within the exact rolling minute operate normally, 101st
   gives correlated 429 `RATE_LIMITED`, Retry-After and RateLimit-* headers.
4. Read-only verified-account gate uses trusted **`principal.userId`**, not key ID
   or quota subject. Unverified users and key owners get 403 EMAIL_NOT_VERIFIED.
5. The links service revalidates inputs, canonical principal mapping and owner
   verification independently of HTTP; inside the transaction it rechecks the
   owner under FOR SHARE before any write. URL-9 account deletion/verification
   uses FOR UPDATE, preserving user-before-child lock ordering. Handler/domain
   writes occur only after all gates; service calls are a trusted internal auth
   boundary, not an alternate public authentication mechanism.

Valid-shape authenticated attempts consume quota before verification/business
rejections and replays, as specified; invalid credentials do not. Rate-limit
denials never invoke the service transaction. API-key usage timestamps are owned
by authentication, not link-domain mutation. All negative no-write claims concern
links, reservations and idempotency records, not auth usage/quota bookkeeping.

## Slugs, validation and response

Auto slugs use seven independent `crypto.randomInt(62)` selections (unbiased
base62, approximately 41.7 bits), retrying **the whole transaction at most eight
times** on collision. Never use Math.random or truncate/modulo biased bytes.
Custom slugs are 3–50 alphanumeric characters. Existing reservation rows remain
taken regardless of link deletion, expiry or `released_at`; no release/delete
operation is added. Exact reserved words `healthz`/`readyz` yield 409.

Custom/reserved collisions return correlated 409 CONFLICT and
`error.suggestions` with exactly three unique, availability-checked seven-char
alternatives. Suggestions are not reserved and may race subsequent callers.
Search is capped at 24 candidates; exhaustion returns fixed 503, never unchecked
or duplicate suggestions. Rejected collision transactions roll back all records.

**X-5 remains unresolved:** the PRD `my-campaign` example conflicts with strict
AD-8. It is rejected; no hyphen acceptance or resolution is claimed. This is
retained residual product ambiguity, not permission to weaken the regex.

`expiresAt` is optional/null (permanent) or a valid timezone-qualified ISO date.
New links require future expiry. A committed matching idempotent result remains
replayable after its link expires, while the idempotency record is live; that
temporal check is made after trusted gates/lookup without writes. Other past
expiry creates reject before opening a write transaction. No PATCH is introduced;
future management owns enforcement of immutable expiration there.

201 body: `{id, slug, shortUrl, destinationUrl, createdAt, expiresAt}` with ISO
dates/null expiry. Ownership is stored as verified userId, not echoed as a
client-selectable field. JSON errors retain the existing envelope/requestId;
only optional suggestions and explicit retry metadata extend it. All create
responses/errors have Cache-Control no-store. RateLimit-Reset is delta seconds
until the earliest counted request expires, not Unix time or full budget reset.

## Idempotency and atomicity

Optional Idempotency-Key: 1–255 visible ASCII characters, no whitespace, bounded
and unique per received header. Scope is `(principal.subject, key)`; distinct API
keys and their owner's JWT have independent idempotency namespaces. Hash is
SHA-256 of canonical JSON of destinationUrl, slug/null, normalized expiry/null;
JSON property order and equivalent expiry offsets do not create false mismatch.

After gates, one READ COMMITTED transaction:

1. Lock/read verified owner.
2. For a key, delete only that principal/key's expired record and claim via
   unique INSERT ON CONFLICT DO NOTHING. TTL is exactly 24 hours from request
   time. The uncommitted row uses `completed`, never `in_progress`.
3. Reserve slug; insert link with trusted owner; capture full response/status201
   in the same idempotency row; COMMIT. No incomplete snapshot is committed.

A racing loser waits on PostgreSQL's unique insert, rolls back before any link
write and re-reads the committed result; hash mismatch is 409
IDEMPOTENCY_PAYLOAD_MISMATCH. Claim lock wait is bounded at 100ms; actual busy or
unavailable/incomplete snapshot yields 409 IDEMPOTENCY_IN_PROGRESS with Retry-After
1, never a fake successful replay. Initial and replay response shapes/field order
are identical despite JSONB ordering. Current quota headers are not replayed as
old counter values. Expired key reuse can create a new link; old reservations
remain. TTL visibility/reuse is enforced here; bulk expired-record GC remains the
existing maintenance owner's responsibility, not a new scheduler.

Any failure before commit rolls back idempotency, reservation and link together.
Connection loss/SIGKILL causes PostgreSQL to roll back the disconnected transaction.
Rollback failures discard the connection. SQL is parameterized; driver failures
are redacted 503s. A lost COMMIT response is inherently uncertain: retry with the
same key resolves a committed snapshot or rolls back/retries cleanly; no-key
requests have no exactly-once guarantee. No new recovery service is introduced.

## Verification and non-claims

| Criteria                             | Evidence                                                                                                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-FR-1.2, FR-3.2                    | Real JWT/key owner mapping, unverified/no-write gates at route and service, locked recheck, owner-override negatives                                              |
| AC-FR-2.1/2.2/2.6, AC-02             | Real POST, seven-char slugs, response/origin, URL/expiry checks, permanent default                                                                                |
| AC-FR-2.3/2.4, AC-03 verifiable half | Strict custom regex, tombstones/reserved409, three checked suggestions, bounded retry; X-5 open                                                                   |
| AC-FR-2.5, AC-04, readiness c2       | Single-transaction SQL ordering, concurrent replay, mismatch, real contention, 24h reuse, rollback fault injection and actual child-handler SIGKILL before commit |
| AC-FR-2.7, AC-FR-8.1/8.2             | Real POST + unchanged URL-9/22 auth + unchanged URL-10 limiter; first100/101 for both namespaces, correlated429/headers/no writes and expiry recovery             |

In-memory route/domain fixtures always run. PostgreSQL cases register inside the
existing guarded URL-9 `TEST_ACCOUNT_DATABASE_URL` disposable schema fixture,
including both credential types' real100/101 and child-process kill/retry.
The child accepts only the dedicated loopback test database/fixture schema and
kills only itself; it opens no public listener or production connection. No
protected container, volume or data is touched. When fixtures are unavailable,
these tests are **unexecuted/skipped**, not passed. Actual commands, coverage,
counts, exits and exact-head/test-merge CI evidence are in the PR.

No CAPTCHA/interface/challenge/risk-mode, social OAuth, global quota, endpoint
outside URL-11, new infrastructure/secret/provider, deployment, Jira transition,
human acceptance or post-merge QA is performed. Existing spec/history artifacts
remain untouched. New names are purpose-based, service-owned, and require no
naming-checker exception or runtime rename. Reversal removes opt-in route/service
registration; existing tables/records/tombstones remain and need no migration.

# Principal request limiter — URL-10 partial implementation

Implements the approved 2026-11-15 MVP FR-8 boundary only. URL-10 remains
**partially implemented**: no authenticated production route uses it yet, and
integrated create-flow acceptance is not claimed. No CAPTCHA, challenge,
provider mode, social login, URL-11 endpoint or infrastructure is added.

## Contract and integration

The URL-shortener service owns `InProcessRequestLimiter`; its lifetime is one
application process. Create **one shared instance per process**, not per request
or route. After trusted authentication resolves a canonical lowercase UUID
`user:<id>` or `apikey:<id>`, call `consume(principal)` synchronously before
protected handler work, or use `enforceRequestLimit` in a Fastify `preHandler`.
Never derive a principal from an unverified client header. The HTTP fixture's
`x-test-principal` transport is test-only, not authentication.

Exactly 100 requests may be accepted in `(now - 60,000ms, now]`. The 100th is
accepted; the 101st is rejected. Expiry is inclusive at age 60,000ms, with no
wall-minute reset/boundary burst. Rejected attempts do not consume memory or
extend lockout. Both namespace and UUID identify a quota: a user and API key
with the same UUID have independent budgets. Future integration must choose the
authenticated principal consistently, not allow a client to alternate identities.

The adapter emits `RateLimit-Limit: 100`, post-consumption `RateLimit-Remaining`,
and `RateLimit-Reset` as **ceil-rounded delta seconds until the earliest counted
request expires**, not a Unix timestamp or time until the entire budget refills.
On rejection it emits the same positive seconds in `Retry-After` and throws
`AppError(429, 'RATE_LIMITED', ...)`, using the existing correlated JSON envelope.
Authenticated responses are `Cache-Control: no-store`; no identity or another
principal's counters are included. `null` bypasses this limiter; it does **not**
authorize a request. Authentication/rejection stays with future auth integration.
Anonymous/redirect traffic is outside this component's enforcement scope.

## Bounded state, clocks and failure behavior

- Maximum 10,000 principals and 100 accepted timestamps per principal (one million
  timestamps). A smaller positive integer capacity is supported, never a larger
  one. The threshold/window are fixed, not configurable tiers.
- Never evict live state: at capacity a new principal gets a fixed 503 `INTERNAL`,
  not a false 429, while existing principals retain their budgets. This is an
  availability tradeoff; traffic from many valid identities can exhaust capacity.
- Own-key expiry occurs on consumption. Traffic-driven global sweeps occur when
  at least one second has elapsed since the previous sweep and on capacity
  pressure. `prune()` explicitly removes idle expired state. Without traffic or
  prune, expired state can remain allocated but never exceeds the hard bounds;
  the component owns no timer. Global sweeps cost O(principals × 100), and can
  cause event-loop latency at capacity; this is not a distributed/DoS defense.
- A trusted injectable elapsed-millisecond clock defaults to `performance.now()`;
  equal times are valid. Nonfinite, negative, backward, excessively large or
  throwing clocks fail closed with fixed 503, without resetting counters or
  leaking clock errors. Wall-clock changes do not affect the default clock.
- Aggregate diagnostic counts reveal no identities; they include retained expired
  state until cleanup. They are not exposed through an HTTP endpoint.

## Deployment limits and reversibility

Consumption is atomic only within one synchronous JavaScript event loop. Each
worker, container, Lambda instance or host has independent state; two instances
can each allow 100/minute for the same principal. Restarts/recreation reset quota.
This cannot claim a global 100/minute ceiling for multi-instance deployment.
Tests explicitly demonstrate independent instances/restarts. Shared enforcement
would require separately approved work, not new infrastructure here.

There is no production wiring or runtime/config change to roll back. Future
integration can remove the opt-in adapter and process-owned instance without a
data migration; doing so removes enforcement and must not be called equivalent.

## Verification scope

`tests/unit/request-limiter.test.ts` covers threshold, staggered rolling boundaries,
rounding, denial memory/lockout, identity isolation, capacity/no eviction, expiry,
clocks, default cardinality bounds and independent instance state.
`tests/unit/request-limit-hook.test.ts` uses the real application error handler
with test-only routes to check 429/header/envelope/privacy and 503 behavior.
These are component checks, not authenticated create-flow acceptance or QA PASS.
Actual command results and CI evidence are recorded in the implementation PR.

New names describe their purpose; no resource is created, renamed or retargeted,
and no naming-policy exception/checker change is required.

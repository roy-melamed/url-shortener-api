# Local HTTP request-completion logging

This implements only the authorized partial local logging correction. It does
not satisfy whole-ticket URL-16 acceptance or activate any operational system.
The old AWS PR #22 and historical evidence remain unchanged.

## Canonical record

The existing local/Lambda `buildApp` factory emits one record in `onResponse` for
each completed HTTP request, including validation, authentication, unmatched,
limited and unexpected-error responses. Fields:

- `timestamp`: UTC ISO timestamp; `level`: Pino info (`30`).
- `requestId`: caller correlation only, never authentication. Exactly one
  `x-request-id`, 1–128 ASCII letters/digits/underscore/hyphen, is accepted.
  Missing, malformed, comma-combined or duplicate fields generate a ULID shared
  with the error envelope. Addresses/URLs are not accepted correlation syntax.
- `route`: registered route template, never the raw path, parameters or query;
  `unmatched` for404. `method`, actual response `status`, and finite nonnegative
  `durationMs` (invalid clock results normalize to0).
- `principal`: `{type: "user", id: userId}` or `{type: "apikey", id: keyId}`
  only from the existing bearer authenticator's established private request
  context. Otherwise `{type: "anonymous", id: null}`. Headers, correlation,
  token decoding and response bodies cannot establish logging identity. Routes
  without that context (including account issuance) remain anonymous; this
  correction does not change their authentication behavior.
- `outcome.http`: `success`, `client_error`, or `server_error`, derived solely
  from actual status. No redirect/cache/country/CAPTCHA outcome is invented.
- `traceId`: always `null`. No tracing integration or inbound trace propagation.
- Optional `errorCode`: mapped existing machine code, never an exception,
  message, stack, cause, SQL detail or validation payload.

Completion uses an independent info channel on the same protected destination,
so diagnostic `LOG_LEVEL=warn`, `error` or `silent` cannot suppress it. Diagnostic
level filtering remains effective. Privacy-safe diagnostics project only bounded
correlation, known shutdown signals/ports and fixed legacy credential-redaction
markers. Only known fixed startup/shutdown messages survive; arbitrary text,
interpolation, objects, nested secrets and errors are dropped/replaced with
`diagnostic`. Root and descendant child bindings use the same projection. Child
options cannot introduce serializers, hooks, mixins or level overrides.

Use `createLogger` for injected destinations; arbitrary prebuilt Pino loggers
are rejected at app construction rather than silently bypassing the privacy and
completion guarantees. No domain/authentication/persistence algorithm changes.

## Failure boundary

A failed write is attempted once, dropped, and counted, with no retry, queue,
raw fallback, console error, or change to the HTTP result. Serialization/projection
failures are also contained. A per-destination in-memory counter is inspectable
with `logEmissionFailureCount(logger)` and shared by children/loggers using that
destination; it saturates at `Number.MAX_SAFE_INTEGER`. Asynchronous stream error
notifications are observed without inspecting/logging their payload; only one
listener is registered per destination. The counter counts failure notifications,
not durable delivery receipts. A sink returning `false` activates a drop-on-backpressure
hold: later records are counted and discarded, not buffered/retried, until that
sink emits `drain`. The sink owns its already-accepted buffer; the application
adds no pending-record queue. No durable spool, retention guarantee or backend
delivery claim is made. This synchronous local seam cannot impose a timeout on
an arbitrary user-supplied blocking sink.

`/healthz` and its dependency-free liveness behavior are unchanged. No `/readyz`,
metrics, OTel dependency, backend, alert/recipient, cloud resource, service,
deployment or live operational acceptance is included. Those obligations remain
BLOCKED under their own approval/access requirements, not waived by these tests.

## Verification

`tests/integration/request-completion.test.ts` covers exactly one canonical record
for200/400/401/404/429/500 at all four diagnostic levels; trusted JWT/API-key and
anonymous attribution; forged identity/trace headers; invalid/duplicate request
IDs; nested/child/body/header/query/error privacy; and one failed emission per
request with unchanged responses and no stdout/stderr fallback.
`tests/unit/logger.test.ts` covers projected diagnostics/children, throwing getters,
invalid duration/fields, synchronous/asynchronous sink failures, shared counters
and listener bounds. Existing auth/error/runtime regressions remain required.

Exact commit, commands, exits, coverage, remaining skips and review/CI evidence
belong in the correction PR. Premerge tests are not Pam's merged-main QA or full
URL-16 PASS.

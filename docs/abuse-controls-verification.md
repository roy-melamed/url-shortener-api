# Sliding-window rate limiting and suspicious CAPTCHA

Owner: URL-shortener engineering. Tracking: URL-10. Developer evidence, not QA
acceptance or production readiness. Approved scope: PRD AC-11, requirements
FR-8.1–8.3 / AC-FR-8.1–8.2 and FR-2.7, design §§3.3/3.4/4.1/5.1/6.6,
AD-3/AD-7. URL-8 is Approved; URL-11 and URL-25 consume these seams. No approved
PRD/requirements/design or existing migrations were rewritten.

## Implementation contract and choices

### PostgreSQL limiter

`src/abuse/rate-limit.ts` reuses the existing URL-8 `rate_limit_windows` schema:
`(subject, window_start)` primary key with `prev_count` and `curr_count`. No new
migration is needed. Only canonical `user:<lowercase UUID>` and
`apikey:<lowercase UUID>` subjects are accepted; never bearer-token contents,
email, IP, anonymous identity or user-supplied request headers. User/key namespaces
have independent uniform 100-request budgets; there are no tiers or Redis limiter.

One minute is 60,000 ms. Admission requires:

```text
previousCount * (60000 - elapsedMs) + (currentCount + 1) * 60000 <= 100 * 60000
```

Integer arithmetic avoids floating-point boundary mistakes. This is the approved
two-bucket **weighted estimate**, not a per-request exact sliding log. The 101st
request in an empty minute is rejected; a minute rollover does not reset the
previous burst. Denials do not increment admitted-request counters or indefinitely
extend the lockout. Invalid/corrupted count state fails closed.

Each consume operation acquires a dedicated pooled client, begins explicit READ
COMMITTED, takes a transaction advisory lock keyed by subject, reads **DB wall
clock after the lock**, upserts the current bucket using the immediately preceding
bucket's committed count, conditionally increments and commits. Transaction-start
`now()`/application clocks would charge queued requests to stale minutes; they are
not used. The subject lock serializes same-subject requests across workers and
minute boundaries; hash collisions add contention only, never shared counters.
All subjects/window parameters are bound SQL values. All participating admission
writers must use this protocol. Failed queries/state/commit roll back; acquisition
and DB errors become fixed redacted 503 errors, and a failed rollback discards the
connection. No automatic retry after uncertain commit is claimed.

`RateLimit-Limit=100`; remaining is floored weighted residual capacity **after**
admission; reset is conservative seconds until the full budget recovers without
further admissions (up to 120 seconds, not a false reset at minute rollover).
Denials add `Retry-After`, ceiling-rounded seconds until one new request fits if
no further admissions occur. At 100 admissions at minute start this is 61 seconds;
at the next minute boundary with previous=100 it is 1 second.

`PURGE_EXPIRED_WINDOWS_SQL` is a **handoff**, retaining current/previous minute
rows and deleting older rows. It is not scheduled or registered here. URL-14 owns
maintenance registration/execution. No production purge or database change was
performed. SQL hygiene execution is tested only in the disposable test schema.

### HTTP integration boundary

`buildApp` accepts an optional injected limiter and trusted authenticated-subject
resolver. The preHandler hook covers `/v1` and `/v1/*` after Fastify validation;
health/redirect/other prefixes are excluded. Auth owns the principal/401 behavior;
null subjects get no anonymous/IP counter. Hook responses use existing error
envelopes and headers, with no raw DB/identity/token detail in errors.

**No authentication or link creation is invented.** Until URL-22 supplies the
trusted auth resolver, default application construction does not instantiate a
pool/limiter or claim globally active authenticated enforcement. URL-11 must wire
the create service and email/risk gates in the approved order. HTTP integration
tests use explicit stub routes and trusted fixture identities, not product CRUD.

### CAPTCHA seam

`src/abuse/captcha.ts` exports `CaptchaProvider`, `RiskInputs`, `RiskThresholds`,
`enforceCaptcha` and an always-rejecting unwired dummy adapter. Only mode
`suspicious` is supported. Only approved signals are evaluated: account age, prior
failures, recent creation velocity and optional API-key age. Thresholds are
required injected policy, not invented production defaults. Ages below minima
and counts at/above maxima flag risk; null key age means a user/JWT subject.
Callers must derive authoritative risk inputs, never trust client-supplied ages or
failure/velocity counts.

Clean requests pass without calling the provider, even if an irrelevant token is
supplied. Suspicious missing tokens produce 403 `CAPTCHA_REQUIRED`; malformed,
oversized (>4096 characters), rejected or provider-error tokens produce fixed
403 `CAPTCHA_INVALID`. Provider errors/tokens/risk details are not propagated.
The dummy rejects all tokens; accepting fake providers exist only in tests.
**X-1 remains open.** No vendor, credentials, remote client, challenge acquisition,
production threshold values or automatic permissive fallback is selected.
URL-25 owns a later approved live adapter and its operational timeout contract.

## AC trace and executable evidence

| Acceptance requirement                                            | Test evidence                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-FR-8.1 / AC-11, weighted 100/min, no fixed-window double burst | `tests/unit/rate-limit.test.ts`: counts 0–100, exact/near minute boundaries, half-window weighting, retry/reset math, malformed state and namespace validation. Real PG suite: 160 concurrent requests admit exactly 100.                                                                                                        |
| AC-FR-8.2 / FR-8.3, normal traffic and uniform subjects           | Unit/HTTP tests: normal 200, decreasing remaining, no Retry-After on allowed responses, independent user/key state; no anonymous/redirect limiter.                                                                                                                                                                               |
| FR-8.2 / 429 contract                                             | `tests/integration/abuse-http.test.ts`: 100 requests succeed; 101st returns 429 `RATE_LIMITED`, correlated error envelope and all four retry/rate headers.                                                                                                                                                                       |
| Transaction safety / failure privacy                              | Unit query-order/parameter assertions; rollback/commit/acquire/corrupt-row/missing-update faults; real PG concurrent admission, independent subjects, fresh limiter instance, idle recovery, raw DB-clock query and rollback.                                                                                                    |
| AC-FR-2.7 / AD-3                                                  | `tests/unit/captcha.test.ts`: 116 cases covering four risk signals, boundaries, clean/no-provider calls, dummy rejection, malformed inputs/mode/token/provider results and redacted errors. HTTP create-contract stub verifies clean pass, risk challenge/rejection and successful fake verification without actual link writes. |
| Hygiene handoff without URL-14 ownership                          | Exported SQL only; real PG test verifies only current/previous buckets survive. Existing maintenance registry remains unchanged.                                                                                                                                                                                                 |

## Actual local verification (2026-11-11)

Isolated `/tmp/opencode/sliding-window-captcha`, branch
`feature/sliding-window-captcha`, based on main
`01962f8a25cd141d99c669cece4811b8a059ce0b`. PR description identifies the exact
submitted head and subsequent CI results.

| Command                                    | Exit / actual result                                                                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci`                                   | 0; no dependency/lockfile change                                                                                                         |
| `npm run format:check`                     | 0                                                                                                                                        |
| `npm run lint`                             | 0                                                                                                                                        |
| `npm run check:naming`                     | 0                                                                                                                                        |
| `npm run typecheck`                        | 0                                                                                                                                        |
| targeted abuse tests with coverage (below) | 0; before the extra HTTP contract test: 144 passed; after addition: 145 tests in focused/full suites; five real PG tests skipped locally |
| `npm run test:coverage` final              | 0; **2,491 passed / 15 skipped**, 25 files passed / 2 skipped                                                                            |
| `npm run check:watcher-offline`            | 0                                                                                                                                        |
| `npm run test:watcher-offline`             | 0; 58 unchanged tests                                                                                                                    |
| `npm run build`                            | 0                                                                                                                                        |
| `git diff --check`                         | 0                                                                                                                                        |

```sh
npx vitest run tests/unit/rate-limit.test.ts tests/unit/captcha.test.ts \
  tests/integration/abuse-http.test.ts tests/integration/rate-limit-postgres.test.ts \
  --coverage --coverage.include=src/abuse/**
```

Focused coverage before the syntax-only constructor correction was statements,
functions and lines **100%**, branches **98.9%**; this is reported separately from
the unchanged application auth/links coverage gates. Full final suite also reports
abuse lines/statements/functions 100%, branches 98.9%. No threshold is lowered.

The initial full suite exposed a real Node native type-stripping incompatibility:
TypeScript constructor parameter-property syntax passed Vitest/build but broke
the unchanged dev-entrypoint smoke. Replaced it with an explicit field/assignment;
the original smoke and complete checks then passed unchanged. Initial full-suite
exit 1 is not hidden; no runtime flag, existing test or quality gate was weakened.

## Real PostgreSQL verification boundary and CI

Local `docker ps` exits **1**, socket permission denied; no local PostgreSQL
server/client executable is available. No credentials/access escalation requested,
and no existing VM database is used. Thus the five SQL/locking tests are explicitly
**unexecuted locally**, not passed by mocks. Ten older DB tests also retain their
existing skip behavior. This is distinct from the local unit/HTTP successes.

CI adds a job-scoped disposable **PostgreSQL 16 Alpine service** with no protected
credentials, loopback-only port mapping and readiness check. Only `npm test` gets
`TEST_RATE_LIMIT_DATABASE_URL`; all existing quality steps remain. The new suite
requires that explicit URL to name loopback `rate_limit_test`, creates a random
isolated schema, and drops only that schema at teardown. It never resets public
schema or uses existing production databases. Test-only transport replacement of
the SQL clock expression gives deterministic boundary tests; one test also runs
the **unmodified production DB-clock query**. All locking/SQL/transactions execute
against real PG when this CI service is available. CI success/counts must be
checked and linked in GitHub, not inferred from local skips or service YAML.

No service/production deployment, auth feature, link CRUD, real vendor, threshold
approval, maintenance registration, watcher/Jira automation, shared policy/spec
or existing resource/connection/volume identifier change is included. Live CAPTCHA
verification remains the explicit vendor dependency, not a claim of this PR.

## PR #19 rework — resolved-route admission scope (2026-11-12)

[Dwight's submitted FAIL review](https://github.com/roy-melamed/url-shortener-api/pull/19#pullrequestreview-5872460422)
reviewed exact head `2004f1bab8a6af2c2fb5be3e67007fead2b9ff34`. Its green
CI does not waive the blocking P1: Fastify resolves encoded static route segments,
but the hook checked the raw URL prefix. An authenticated `/%76%31/probe` or
`/v%31/probe` could reach the registered `/v1/probe` handler without admission.

The before-fix local regression run on 2026-11-11 exited **1**: two cases returned
200 rather than 429 (`/%76%31/probe`, with and without a query); five other HTTP
tests passed. Dwight's independent reproduction additionally showed `/v%31/probe`
returning 200 with zero limiter calls. These are synthetic application injections,
not evidence of exploitation of a deployed system.

Inspected the interrupted working correction before editing. It scopes using
`request.routeOptions.url`, the identity of the route Fastify actually resolved,
not raw-prefix interpretation or a second ad-hoc URL decoder. Missing route scope
and health/redirect/`/v10` remain outside this hook. Existing trusted resolver,
canonical subjects, transaction/math, CAPTCHA/provider and maintenance boundaries
are unchanged. Initial targeted validation of the three pending regressions
passed **148 tests**, exit **0**.

Retained all three requested aliases and added the second prefix spelling from
the actual review. All four cases now assert 429 `RATE_LIMITED`, all required
retry/rate headers, exactly one limiter call with the trusted subject, and zero
handler calls:

- `/%76%31/probe`
- `/%76%31/probe?fixture=1`
- `/v1/%70robe`
- `/v%31/probe`

After strengthening tests, targeted tests ran first and passed; then all complete
checks were rerun. Commands and actual exits in the same isolated worktree:

| Command                                                                                                        | Exit/result                                                   |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `npx vitest run tests/unit/rate-limit.test.ts tests/unit/captcha.test.ts tests/integration/abuse-http.test.ts` | 0; **149 passed**, 3 files                                    |
| `npm ci`                                                                                                       | 0                                                             |
| `npm run format:check`                                                                                         | 0                                                             |
| `npm run lint`                                                                                                 | 0                                                             |
| `npm run check:naming`                                                                                         | 0                                                             |
| `npm run typecheck`                                                                                            | 0                                                             |
| `npm run test:coverage`                                                                                        | 0; **2,495 passed / 15 skipped**, 25 files passed / 2 skipped |
| `npm run check:watcher-offline`                                                                                | 0                                                             |
| `npm run test:watcher-offline`                                                                                 | 0; **58 passed**                                              |
| `npm run build`                                                                                                | 0                                                             |
| `git diff --check`                                                                                             | 0                                                             |

Local PostgreSQL access remains unavailable; the five SQL tests remain explicitly
unexecuted locally, alongside ten older DB tests. The PR description links fresh
CI for the corrected head and records whether those five tests actually execute.
This section supersedes earlier local counts only for this rework; historical
head results above remain historical. No original test, quality gate, vendor,
auth/creation contract, workflow or configuration was weakened or changed to fix
the bypass. New code commits invalidate prior review; exact-head re-review and
actual successful current CI are required. Ryan does not merge or claim QA PASS.

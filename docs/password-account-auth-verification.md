# Password account authentication — implementation and verification

Owner: URL-shortener engineering. Tracking: URL-9 (email/password unit only).
Developer evidence, not merged-code QA or production authorization.

## Approved scope and dependency decision

Read approved PRD, requirements FR-1.1/FR-1.2 verification mechanics/FR-1.4,
design §§3.3/3.8/4.1/5.2/6.1 and AD-13/AD-14, and current URL-9 scope. URL-8 is
Approved; its [merged-SHA QA PASS](https://github.com/roy-melamed/url-shortener-api/pull/5#issuecomment-6499368149)
tested `0124f8b69571836e89aa0beaceffa23ddcf00e47`. Existing identity/link/analytics
migrations are reused unchanged. No Approved issue or historical approval is
modified. This worktree is independent of URL-10's unmerged branch; URL-10 is not
a prerequisite of this assigned unit.

Social OAuth remains URL-21; API keys/general JWT-versus-key middleware remain
URL-22. The unverified-create gate, create behavior and link idempotency remain
URL-11. No OAuth/CAPTCHA/email provider or credentials are selected, and no
production database, cloud, service, configuration or deployment is changed.

## Implemented API and dependency boundaries

`PasswordAccounts` is a transactional service with explicit store, password,
session-signing and verification-mail dependencies. `buildApp({config, accounts})`
registers its real HTTP handlers. No credential, signing key, mail transport or
database is guessed when those dependencies are absent: the existing default
scaffold remains unchanged until configured by an authorized composition root.
This is explicit dependency injection, not an unauthenticated fake provider or
automatic production setup. Tests construct the actual routes/services/adapters.

| Endpoint                       | Contract                                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `POST /v1/users`               | `{email,password}` → 201 `{id,email,emailVerified:false}`; no hash/token in registration response              |
| `POST /v1/auth/sessions`       | `{email,password}` → access/refresh tokens, `tokenType:Bearer`, `expiresIn:900`                                |
| `POST /v1/auth/tokens/refresh` | `{token}` → rotated refresh and new access token; invalid/reused/expired token → 401                           |
| `POST /v1/auth/emails/verify`  | `{token}` → 204; invalid/expired/used token → 401                                                              |
| `DELETE /v1/me`                | This unit's signed session JWT → 204 after owner-only hard delete; missing/invalid/deleted-owner session → 401 |

All responses on these resolved routes, including encoded aliases, use no-store /
no-cache headers. Error responses use the existing correlated JSON envelope.
No global authentication resolver or API-key route is implemented. DELETE uses
its strictly verified session subject, never a supplied user ID. Unverified users
may log in; only URL-11 may impose the approved creation gate.

### Passwords and session JWTs

- Argon2id, random salts, 64 MiB memory, three iterations, parallelism one and
  32-byte hash. Passwords are not normalized or truncated. Registration requires
  12–128 characters; login accepts bounded nonempty existing credentials.
  Malformed UTF-16 that would be replaced on UTF-8 conversion is rejected.
  Email validation and lowercase normalization match the existing CITEXT identity.
- Unknown/social-only accounts use a random dummy argon2 verification path.
  Generic credential errors avoid revealing whether an email/password matched.
  This is not a claim of perfectly indistinguishable network timing or tested
  production brute-force/load protection.
- Injected RSA keys, explicit issuer/audience/key ID, RS256/typ JWT pinned on
  verification. `sub`, `iat`, `exp`, `jti`, issuer/audience are required; exact
  900-second lifetime, future-issued/expired/tampered/wrong-algorithm/issuer/
  audience/key-ID tokens rejected. No embedded keys, bootstrap secret, environment
  reader or production key generation. Keys in tests are ephemeral only.
- Exact-pinned libraries added: argon2 0.45.2, jose 6.2.17, nodemailer 10.5.0 and
  development typings. Existing npm advisories are not silently fixed. Key custody,
  overlap/rotation and real signing/mail configuration remain operational work,
  not authorization granted by a dependency or successful test.

### Refresh rotation, replay and atomicity

Email/refresh tokens use CSPRNG 32-byte secrets plus a UUID lookup ID and distinct
kind prefix. Only SHA-256 of the full token is persisted, never plaintext. Strict
canonical parsing and constant-time digest comparison precede acceptance.

Login creates a family; rotation revokes the presented token and inserts a new
token in that same family, retaining its absolute expiry (not an endless sliding
session). Valid reuse of a revoked token revokes **the entire refresh family**.
That revocation commits before returning 401; throwing inside the transaction
would incorrectly roll it back. Forged token secrets do not revoke another
session. Concurrent reuse permits at most one rotation and then revokes the
successor family. Already issued access JWTs expire normally after 15 minutes;
there is no invented access-token blacklist or claim of immediate JWT revocation.

PostgreSQL READ COMMITTED transactions lock the owning user row and then re-read
token state. Rotation, confirmation and deletion use the same lock order to avoid
token-first deadlocks and stale replay decisions. Failures roll back and return
fixed errors without driver messages, SQL parameters or provider causes. Failed
rollback disposes the client. No implicit retry after uncertain commit is claimed.

### Email double opt-in

Registration inserts an unverified account and hashed verification token. Only
one successful unexpired, matching-purpose confirmation consumes it and sets
`email_verified_at`; concurrent replay has one winner. Expiry is exclusive at
the boundary. Positive token lifetimes are mandatory injected policy, not hidden
production defaults (tests use short synthetic lifetimes).

The injected mail send is bounded by the adapter while registration is open;
provider failure rolls back account/token creation and permits retry. A message
sent before a failed/uncertain commit can be unusable; it never verifies a user
by itself. This is not durable exactly-once email delivery or an outbox. No
resend/reset-password/provider feature is invented.

Local SMTP uses explicit MailHog-only targets, no credentials or remote fallback,
with timeouts and logging/file/URL access disabled. Generic SMTP and historical
SES seams accept a supplied transport; no SDK credential discovery or live
provider is wired. Active Oracle email selection remains the existing owner's
provider under AD-17; the SES seam does not revert that architecture.

The API-only email gives the verification endpoint plus JSON POST instructions,
token and expiry. It does not invent a frontend or a state-changing GET link, and
does not put tokens in query strings. Credentials/tokens are absent from normal
request logs; the intended recipient mail message and login/refresh response are
the explicit plaintext delivery boundaries.

### Hard delete

The service deletes only the JWT owner's `users` row after locking it. Existing
FK cascades remove identity children, keys, links and their five aggregate tables.
Other accounts and permanent slug reservations remain. Subsequent session-based
DELETE and refresh for the deleted owner fail. Consumers implemented by URL-22
must still resolve an existing account, not authorize resources from a signature
alone after account deletion. No FK, slug-release rule or migration was altered.

## Acceptance trace

| Assigned criterion                        | Meaningful test evidence                                                                                                                                                           |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-FR-1.1 / AC-01 password leg            | Actual argon2id salt/hash/verify tests; register/login HTTP tests; invalid/social-only/unknown credentials, case-insensitive identity and duplicate rollback                       |
| JWT/session mechanics                     | Real RSA/JWT issue/claims/expiry/tamper/algorithm/issuer/audience tests; HTTP signed-owner deletion and no-store assertions                                                        |
| Rotating hashed refresh + reuse detection | Service tests for successor rotation, absolute expiry, forged token, concurrent replay, committed family revocation and signing-failure rollback; real PostgreSQL concurrency test |
| AD-14 verification mechanics              | Hashed single-use expiring email tokens, wrong kind/purpose/secret, expired/equality/used/concurrent cases; local SMTP and fake SES contract; real MailHog confirmation test       |
| AC-FR-1.4 / AD-13                         | HTTP ownership negative test; real PostgreSQL test against unchanged URL-8 migrations confirms all identity/link/aggregate cascades, preserved other account and retained slug     |
| Privacy/error handling                    | Request logs omit password, verification/refresh/access tokens; fixed DB/provider errors; response DTO omits hashes; bounded input validation and cache headers                    |
| Scope exclusions                          | HTTP checks confirm no API-key or link-creation endpoint appears; no social adapter, creation gate or credential selection                                                         |

## Local executed checks (2026-11-12)

Branch `feature/password-account-auth`, isolated `/tmp/opencode/password-account-auth`,
base main `01962f8a25cd141d99c669cece4811b8a059ce0b`. Only URL-9 was transitioned
using discovered transition 21, with In Progress / Roy / Developer readback before
implementation. The PR identifies its exact head, fresh CI and durable results.

| Command                               | Exit / actual result                                                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `npm ci`                              | 0; exact lockfile install                                                                                                    |
| `npm run format:check`                | 0                                                                                                                            |
| `npm run lint`                        | 0                                                                                                                            |
| `npm run check:naming`                | 0                                                                                                                            |
| `npm run typecheck`                   | 0                                                                                                                            |
| targeted auth/mail/HTTP suite (below) | 0; **119 passed / 6 real-service tests skipped**                                                                             |
| `npm run test:coverage`               | 0; **2,465 passed / 16 skipped**, 27 files passed / 2 skipped; auth lines/functions 100%, statements 99.52%, branches 99.28% |
| `npm run check:watcher-offline`       | 0                                                                                                                            |
| `npm run test:watcher-offline`        | 0; 58 unchanged tests                                                                                                        |
| `npm run build`                       | 0                                                                                                                            |
| `git diff --check`                    | 0                                                                                                                            |

```sh
npx vitest run tests/unit/auth-crypto.test.ts tests/unit/auth-postgres-store.test.ts \
  tests/unit/password-accounts.test.ts tests/unit/verification-mail.test.ts \
  tests/integration/password-account-http.test.ts \
  tests/integration/password-account-postgres.test.ts
```

Initial verification found and corrected a mock tuple typing error and an unused
boolean initialization reported by lint. An initial subset-only coverage command
exited 1 because unrelated links source was not exercised; its 116 tests passed
but it was not counted as a successful coverage gate. Full final coverage runs
the unchanged whole-repository thresholds and passes them; no gate/configuration
was lowered. Existing native dev-entrypoint smoke remains passing.

## Real-service verification limit and CI

Local Docker inventory exits **1**, socket permission denied. No local database,
Docker privilege escalation or production credentials are used. Six new real
service cases (five PG, one MailHog) are **unexecuted locally**, alongside the ten
existing optional DB cases. No mock result is represented as a real database or
email delivery result.

CI adds ephemeral PostgreSQL 16 and existing MailHog test images, loopback-only
ports, explicit `account_auth_test` database and test-only environment settings.
The PG suite checks the loopback/name before use, creates its own random schema,
applies **the existing migrations** there and removes only that schema. It never
resets public or uses an existing host database. The SMTP case uses a unique
synthetic recipient and no production provider credentials. Existing quality
steps/permissions/thresholds remain; this workflow does not deploy. Actual fresh
CI execution/counts must be recorded in the PR rather than inferred from YAML.

URL-11 jointly verifies the create gate; URL-21 owns social OAuth and URL-22 owns
API keys/general auth middleware. Production key/mail setup, provider availability,
deployment and operational acceptance are not claimed. Ryan never merges or
posts final Jira acceptance evidence; Dwight reviews the exact head and Pam
alone tests the actual merged SHA for acceptance.

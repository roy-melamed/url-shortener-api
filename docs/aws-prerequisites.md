# AWS prerequisites — URL-19 (owner-supplied, never invented)

**Nothing in this repository deploys on its own.** `npm run cdk:synth` produces a
CloudFormation template offline; every value below is a template **parameter
without a default**, so `cdk deploy` cannot complete until the project owner
supplies them (URL-19 ticket · backlog-audit X-7/D6 · design §1.2 "existing
account"). Never commit real values here or anywhere in the repo — the whole
point of the parameter list is that the values live outside git.

## The checklist

| #   | Parameter               | What the owner supplies                                                                         | Why it exists                                                                                     |
| --- | ----------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1   | _(deploy environment)_  | AWS account + region + credentials (in GitHub Actions for URL-20, or locally)                   | The stack is environment-agnostic on purpose — account/region are never in code                   |
| 2   | `HostedZoneId`          | Route 53 hosted-zone **ID** of the zone that already serves the shared domain                   | Route 53 alias + ACM DNS validation (design §3.1)                                                 |
| 3   | `HostedZoneName`        | Route 53 hosted-zone **name** (apex, e.g. `example.com`)                                        | Builds the single shared FQDN                                                                     |
| 4   | `DomainLabel`           | Label of the **single shared** subdomain (e.g. `go` → `go.example.com`)                         | NFR-9: exactly one shared domain; no per-user/custom-domain configuration exists                  |
| 5   | `RdsInstanceIdentifier` | Identifier of the **existing** RDS PostgreSQL instance                                          | RDS Proxy target group (FR-9.2, D-4) — the stack creates **no database**                          |
| 6   | `RdsPort`               | Listener port of that instance (e.g. `5432`)                                                    | Proxy↔DB ingress rules and the deployed `DATABASE_URL` (design §6.3)                              |
| 7   | `RdsSecurityGroupId`    | Security-group id attached to that instance                                                     | The stack adds **one ingress rule** (proxy SG → DB port) so the proxy can reach it                |
| 8   | `DatabaseName`          | Logical database name the application uses                                                      | Second half of the deployed `DATABASE_URL`                                                        |
| 9   | `DbSecretArn`           | Secrets Manager secret ARN with the DB `username`/`password` (optionally `dbname`)              | RDS Proxy authenticates with this same secret (design §6.2); injected into the Lambdas            |
| 10  | `JwtSecretArn`          | Secrets Manager secret ARN holding the JWT signing key (design §6.2)                            | Injected as `SECRET_ARN_JWT`                                                                      |
| 11  | `OAuthSecretArn`        | Secrets Manager secret ARN holding the Google/GitHub OAuth clients (AD-14)                      | Injected as `SECRET_ARN_OAUTH`                                                                    |
| 12  | `CaptchaSecretArn`      | Secrets Manager secret ARN holding the CAPTCHA secret (AD-3; provider vendor still open, §10.8) | Injected as `SECRET_ARN_CAPTCHA`                                                                  |
| 13  | _(SES, owner-side)_     | SES domain/DNS verification for the sending domain                                              | The stack deliberately creates **no SES resources**; email (§3.8) needs the domain verified first |

## Owner decisions to confirm before staging (not code)

- **Reachability of the existing RDS.** The stack creates its own VPC (private
  subnets, NAT, the four §6.3 endpoints) so that "NAT + VPC endpoints" are
  declarable without account lookups. The existing RDS instance lives in some
  VPC of the owner's; confirm it is reachable from this stack's VPC (same VPC,
  peering, or a network path the owner approves). The stack refuses to invent
  that topology. See `infra/lib/url-shortener-stack.ts`.
- **Account limits.** The two entry functions reserve 500 / 200 concurrent
  executions (design §9.4) — the account needs ≥700 unreserved concurrency
  available, or a limit increase.
- **Single NAT gateway.** One NAT is used for the OAuth/SES/CAPTCHA egress paths
  (§3.9), which are off the redirect hot path. Raise `natGateways: 2` if the
  availability review wants AZ-redundant egress.

## How the owner supplies them

```bash
# Synthesis needs none of them (offline, no credentials):
npm run cdk:synth

# A deploy is blocked until every parameter is supplied:
npx cdk deploy UrlShortenerApi \
  --parameters HostedZoneId=... \
  --parameters HostedZoneName=... \
  --parameters DomainLabel=... \
  --parameters RdsInstanceIdentifier=... \
  --parameters RdsPort=5432 \
  --parameters RdsSecurityGroupId=... \
  --parameters DatabaseName=... \
  --parameters DbSecretArn=... \
  --parameters JwtSecretArn=... \
  --parameters OAuthSecretArn=... \
  --parameters CaptchaSecretArn=...
```

The four `*SecretArn` parameters are `NoEcho`. Values are resolved at deploy
time by CloudFormation (`{{resolve:secretsmanager:…}}` inside `DATABASE_URL`),
so no endpoint or credential is ever committed — the URL-19 acceptance rule.

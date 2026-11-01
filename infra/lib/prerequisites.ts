/**
 * Owner-provided AWS prerequisites — URL-19 (backlog-audit X-7 / D6).
 *
 * Every value below is an input the **project owner** must supply before a
 * staging deploy can succeed. None of them is invented, defaulted or
 * hardcoded here (URL-19 ticket scope, design §1.2 "existing account"):
 *
 *  - they are plain CloudFormation **parameters with no default**, so
 *    `cdk synth` succeeds offline while `cdk deploy` cannot complete until the
 *    owner supplies them, and
 *  - the synthesized template lists them in its `Parameters` section, which is
 *    the machine-readable form of the ticket's prerequisite checklist.
 *
 * The full checklist, with the exact `--parameters` invocation, lives in
 * `docs/aws-prerequisites.md`.
 */
import { CfnParameter } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

export interface PrerequisiteValues {
  /** Route 53 hosted-zone **ID** for the single shared domain (NFR-9). */
  readonly hostedZoneId: string;
  /** Route 53 hosted-zone **name** (apex of the shared domain's zone). */
  readonly hostedZoneName: string;
  /**
   * Label of the single shared subdomain, relative to the hosted zone
   * (e.g. `go` in `go.example.com`). NFR-9: exactly one shared domain; there is
   * no per-user/custom-domain configuration anywhere in this stack.
   */
  readonly domainLabel: string;
  /** Identifier of the **existing** RDS PostgreSQL instance (never created). */
  readonly rdsInstanceIdentifier: string;
  /** Listener port of the existing RDS PostgreSQL instance. */
  readonly rdsPort: string;
  /** Security-group id attached to the existing RDS instance (the stack opens its DB port to the proxy). */
  readonly rdsSecurityGroupId: string;
  /** Logical database name inside the existing instance (used to build the deployed `DATABASE_URL`). */
  readonly databaseName: string;
  /** Secrets Manager secret ARN holding the DB `username`/`password` (RDS Proxy authenticates with it). */
  readonly dbSecretArn: string;
  /** Secrets Manager secret ARN holding the JWT signing key (design §6.2). */
  readonly jwtSecretArn: string;
  /** Secrets Manager secret ARN holding the Google/GitHub OAuth clients (AD-14). */
  readonly oauthSecretArn: string;
  /** Secrets Manager secret ARN holding the CAPTCHA provider secret (AD-3; vendor open — §10.8). */
  readonly captchaSecretArn: string;
}

/**
 * The eleven deploy-time prerequisites, as CDK `CfnParameter`s without
 * defaults. Passing a default here would be inventing an owner value, so none
 * is provided — a missing parameter is a *visible* deploy blocker.
 */
export class Prerequisites implements PrerequisiteValues {
  readonly hostedZoneId: string;
  readonly hostedZoneName: string;
  readonly domainLabel: string;
  readonly rdsInstanceIdentifier: string;
  readonly rdsPort: string;
  readonly rdsSecurityGroupId: string;
  readonly databaseName: string;
  readonly dbSecretArn: string;
  readonly jwtSecretArn: string;
  readonly oauthSecretArn: string;
  readonly captchaSecretArn: string;

  constructor(scope: Construct) {
    const stringParam = (id: string, description: string, noEcho = false): string =>
      new CfnParameter(scope, id, { type: 'String', description, noEcho }).valueAsString;

    this.hostedZoneId = stringParam(
      'HostedZoneId',
      'Route 53 hosted zone ID that already serves the single shared domain (NFR-9). Owner-provided; never invented.',
    );
    this.hostedZoneName = stringParam(
      'HostedZoneName',
      'Route 53 hosted-zone name, e.g. example.com. Owner-provided; never invented.',
    );
    this.domainLabel = stringParam(
      'DomainLabel',
      'Label of the single shared subdomain relative to HostedZoneName, e.g. go. Exactly one shared domain (NFR-9); no per-user domains exist.',
    );
    this.rdsInstanceIdentifier = stringParam(
      'RdsInstanceIdentifier',
      'Identifier of the EXISTING RDS PostgreSQL instance (FR-9.2 / AD-11). Referenced by the RDS Proxy; this stack never creates a database.',
    );
    this.rdsPort = stringParam(
      'RdsPort',
      'Listener port of the existing RDS PostgreSQL instance, e.g. 5432.',
    );
    this.rdsSecurityGroupId = stringParam(
      'RdsSecurityGroupId',
      'Security-group id attached to the existing RDS instance; the stack adds one ingress rule for the RDS Proxy.',
    );
    this.databaseName = stringParam(
      'DatabaseName',
      'Logical database name on the existing RDS instance used by the application.',
    );
    this.dbSecretArn = stringParam(
      'DbSecretArn',
      'Secrets Manager secret ARN with the DB username/password (and optionally dbname). RDS Proxy authenticates with this same secret (design §6.2).',
      true,
    );
    this.jwtSecretArn = stringParam(
      'JwtSecretArn',
      'Secrets Manager secret ARN holding the JWT signing key (design §6.2).',
      true,
    );
    this.oauthSecretArn = stringParam(
      'OAuthSecretArn',
      'Secrets Manager secret ARN holding the Google/GitHub OAuth client credentials (AD-14).',
      true,
    );
    this.captchaSecretArn = stringParam(
      'CaptchaSecretArn',
      'Secrets Manager secret ARN holding the CAPTCHA provider secret (AD-3; provider vendor still open, §10.8).',
      true,
    );
  }
}

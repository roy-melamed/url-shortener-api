/**
 * URL Shortener API — AWS stack (URL-19, CDK infrastructure / IaC).
 *
 * Implements design §1.2/§1.3/§3.1/§3.7/§6.3/§9.4/§9.5 and decisions D-1, D-4,
 * D-15, AD-1, AD-2, AD-7, AD-12. Deliberately **synthesizable offline** and
 * **not deployable until the owner supplies the prerequisites**
 * (`infra/lib/prerequisites.ts`, `docs/aws-prerequisites.md`): account, region
 * and every product value come from the deploy environment or CloudFormation
 * parameters — nothing is invented or hardcoded.
 *
 * What this stack creates (URL-19 acceptance):
 *  - API Gateway **HTTP API** with the design §3.1 route table — static
 *    `/healthz` + `/readyz` → `apiFn`, `ANY /v1/{proxy+}` → `apiFn`,
 *    `GET`/`HEAD /{slug}` → `redirectFn`, `$default` → JSON 404 envelope;
 *  - four Lambdas (`redirectFn`, `apiFn`, `aggregatorFn`, `maintenanceFn`)
 *    in private subnets, with reserved concurrency on the two entry functions
 *    (design §9.4);
 *  - SQS click queue + DLQ → `aggregatorFn` (batch ≤ 100, D-8/§3.6);
 *  - **RDS Proxy** against the owner-provided EXISTING RDS instance — the
 *    stack creates no database (FR-9.2, D-4, §9.4);
 *  - Secrets Manager references (DB/JWT/OAuth/CAPTCHA) injected as ARN env
 *    values — no secret literal anywhere (design §6.2);
 *  - NAT + the four §6.3 VPC endpoints (SQS, Secrets Manager, CloudWatch Logs,
 *    X-Ray);
 *  - Route 53 alias + **one shared custom domain** (NFR-9 — no per-user or
 *    custom-domain configuration exists);
 *  - EventBridge Scheduler rules for all five design §3.7 jobs, plus the
 *    documented local invocation path (`npm run job:maintenance`).
 *
 * What this stack deliberately does NOT create (AD-1/AD-2/AD-7):
 *  - no CloudFront/CDN/edge distribution, no WAF, no Tier-2 cache;
 *  - no per-user/custom domain;
 *  - no RDS instance/cluster, no SES resources (SES DNS verification is an
 *    owner-side prerequisite), no hosted zone (owner-provided).
 */
import { CfnOutput, Duration, Fn, Names, Stack, Token, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as schedulerTargets from 'aws-cdk-lib/aws-scheduler-targets';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { MAINTENANCE_JOBS } from '../../src/functions/maintenance.ts';
import { Prerequisites } from './prerequisites.ts';

/** Design §3.7 job cadences — rate-limit hygiene runs hourly, the rest daily. */
const HOURLY_JOBS = new Set<string>(['rate-limit-hygiene']);

/** SQS redrive threshold before a click event is parked in the DLQ (§3.6). */
const DLQ_MAX_RECEIVE_COUNT = 5;

/** AWS guidance: a Lambda/SQS visibility timeout should be ≥ 6× the consumer timeout. */
const AGGREGATOR_TIMEOUT_SECONDS = 60;

export class UrlShortenerStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // ---------------------------------------------------------------- network
    // Design §6.3: private subnets for the functions and the proxy, NAT for the
    // OAuth/SES/CAPTCHA egress paths (§3.9), and the four required VPC
    // endpoints. The VPC is stack-owned so that "NAT + VPC endpoints" (URL-19
    // scope) are declarable without any account lookup at synth time — see
    // `docs/aws-prerequisites.md` for the owner check that the EXISTING RDS is
    // reachable from this VPC before a staging deploy.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      // One NAT gateway: egress is only needed by OAuth/SES/CAPTCHA (§3.9),
      // which are off the redirect hot path (§3.2/§9.3). Raising this to two is
      // a one-line change if the availability review wants AZ-redundant egress.
      natGateways: 1,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });

    // Design §6.3/§3.9: SQS, Secrets Manager, CloudWatch and X-Ray — the exact
    // four endpoints the design names. §3.9 calls the SQS one a *gateway*
    // endpoint, but the pinned CDK (aws-cdk-lib 2.275) exposes SQS only as an
    // interface endpoint (its gateway catalogue keeps S3/DynamoDB). The
    // design's actual requirement — private reachability from the functions
    // without leaving the VPC — is preserved either way, and this is the
    // supported form of the same construct.
    vpc.addInterfaceEndpoint('SqsEndpoint', { service: ec2.InterfaceVpcEndpointAwsService.SQS });
    vpc.addInterfaceEndpoint('SecretsManagerEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
    });
    vpc.addInterfaceEndpoint('CloudWatchLogsEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
    });
    vpc.addInterfaceEndpoint('XRayEndpoint', { service: ec2.InterfaceVpcEndpointAwsService.XRAY });

    // ----------------------------------------------------------- async pipeline
    // Design D-8/§3.6: standard queue (best-effort, non-blocking) + DLQ.
    // 48h retention bounds the redelivery horizon the §3.6 dedup gate reasons
    // about; the dedup rows themselves are purged at 7 days (§13-c1).
    const clickDlq = new sqs.Queue(this, 'ClickDlq', {
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });
    const clickQueue = new sqs.Queue(this, 'ClickQueue', {
      retentionPeriod: Duration.hours(48),
      visibilityTimeout: Duration.seconds(6 * AGGREGATOR_TIMEOUT_SECONDS),
      enforceSSL: true,
      deadLetterQueue: { queue: clickDlq, maxReceiveCount: DLQ_MAX_RECEIVE_COUNT },
    });

    // ------------------------------------------------------ existing data tier
    // FR-9.2 / AD-11: the PostgreSQL instance ALREADY exists and is managed
    // externally. The stack imports it and puts an RDS Proxy in front of it
    // (D-4, design §9.4) — it never creates `AWS::RDS::DBInstance`/`DBCluster`.
    const prerequisites = new Prerequisites(this);
    const dbSecret = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'DbSecret',
      prerequisites.dbSecretArn,
    );

    const dbPort = Token.asNumber(prerequisites.rdsPort);
    const existingDbSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      'ExistingDbSecurityGroup',
      prerequisites.rdsSecurityGroupId,
    );

    const proxySecurityGroup = new ec2.SecurityGroup(this, 'DbProxySecurityGroup', {
      vpc,
      description: 'RDS Proxy: accepts PostgreSQL from the application subnets',
      allowAllOutbound: true,
    });
    proxySecurityGroup.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(dbPort),
      'Application subnets to RDS Proxy (design 6.3)',
    );
    existingDbSecurityGroup.addIngressRule(
      proxySecurityGroup,
      ec2.Port.tcp(dbPort),
      'RDS Proxy to existing RDS PostgreSQL (design 9.4)',
    );

    // The proxy role reads the same DB secret the application uses (§6.2).
    const proxyRole = new iam.Role(this, 'DbProxyRole', {
      assumedBy: new iam.ServicePrincipal('rds.amazonaws.com'),
      description: 'RDS Proxy to Secrets Manager (DB credentials)',
    });
    dbSecret.grantRead(proxyRole);

    // NOTE (L1 on purpose): the L2 `DatabaseProxy` derives the engine family
    // from an `IInstanceEngine`, which forces a concrete PostgreSQL *version*
    // object — inventing a version for an owner-provided existing instance.
    // `AWS::RDS::DBProxy.EngineFamily` is a fixed enum, and "PostgreSQL" is not
    // an invented value (FR-9.2 pins the engine), so the L1 is the honest
    // mapping here. The target group references the existing instance by
    // identifier — no database is created anywhere in this stack.
    const dbProxy = new rds.CfnDBProxy(this, 'DbProxy', {
      dbProxyName: Names.uniqueResourceName(this, { maxLength: 54 }),
      engineFamily: 'POSTGRESQL',
      requireTls: true,
      roleArn: proxyRole.roleArn,
      vpcSubnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds,
      vpcSecurityGroupIds: [proxySecurityGroup.securityGroupId],
      auth: [
        {
          authScheme: 'SECRETS',
          iamAuth: 'DISABLED',
          secretArn: prerequisites.dbSecretArn,
        },
      ],
    });

    // Pool sizing is §9.4's job; the proxy multiplexes the per-container pools
    // (max 2) of every function onto far fewer DB connections.
    new rds.CfnDBProxyTargetGroup(this, 'DbProxyTargetGroup', {
      targetGroupName: 'default',
      dbProxyName: dbProxy.ref,
      dbInstanceIdentifiers: [prerequisites.rdsInstanceIdentifier],
      connectionPoolConfigurationInfo: {
        connectionBorrowTimeout: 30,
        maxConnectionsPercent: 100,
      },
    });

    // --------------------------------------------------------------- functions
    // D-1: four functions. `redirectFn` and `apiFn` are the two independent
    // entry points (NFR-3 bulk radius of failure); reserved concurrency caps
    // come straight from design §9.4 (500 / 200). `aggregatorFn`/`maintenanceFn`
    // are left uncapped on purpose: §9.4 sets no number for them, and leaving
    // them on the unreserved account concurrency is what keeps them runnable.
    const commonEnvironment: Record<string, string> = {
      NODE_ENV: 'production',
      // Design §9.4: tiny per-container pool; the proxy does the multiplexing.
      DB_POOL_MAX: '2',
      DB_STATEMENT_TIMEOUT_MS: '5000',
      DB_IDLE_TIMEOUT_MS: '10000',
      // Design §6.3: TLS required to Postgres.
      DB_SSL_MODE: 'verify-full',
      // Deployed DB access always goes through the proxy (D-4).
      RDS_PROXY_ENDPOINT: dbProxy.attrEndpoint,
      // Secrets are referenced by ARN only — never a literal (design §6.2).
      SECRET_ARN_DB: prerequisites.dbSecretArn,
      SECRET_ARN_JWT: prerequisites.jwtSecretArn,
      SECRET_ARN_OAUTH: prerequisites.oauthSecretArn,
      SECRET_ARN_CAPTCHA: prerequisites.captchaSecretArn,
      // Built from the proxy endpoint + the DB secret at deploy time, so no
      // endpoint or credential is ever committed (URL-19 acceptance).
      DATABASE_URL: Fn.join('', [
        'postgres://',
        dbSecret.secretValueFromJson('username').unsafeUnwrap(),
        ':',
        dbSecret.secretValueFromJson('password').unsafeUnwrap(),
        '@',
        dbProxy.attrEndpoint,
        ':',
        prerequisites.rdsPort,
        '/',
        prerequisites.databaseName,
      ]),
    };

    const commonFunctionProps = {
      runtime: lambda.Runtime.NODEJS_22_X,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      environment: commonEnvironment,
      // Design D-13/§6.3: X-Ray traces; the X-Ray VPC endpoint above keeps
      // traces flowing from the private subnets.
      tracing: lambda.Tracing.ACTIVE,
      bundling: { target: 'node22', sourceMap: true },
    };

    const redirectFn = new NodejsFunction(this, 'RedirectFn', {
      ...commonFunctionProps,
      entry: 'src/functions/redirect.ts',
      handler: 'handler',
      description: 'GET/HEAD /{slug} — redirect service (design 3.2; 302 + no-store per AD-1)',
      memorySize: 1024,
      timeout: Duration.seconds(10),
      reservedConcurrentExecutions: 500,
      environment: {
        ...commonEnvironment,
        // Only the stack knows the queue URL; URL-13's best-effort click
        // emission (design §3.2 step 6) consumes it.
        CLICK_QUEUE_URL: clickQueue.queueUrl,
      },
    });
    redirectFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sqs:SendMessage'],
        resources: [clickQueue.queueArn],
      }),
    );

    const apiFn = new NodejsFunction(this, 'ApiFn', {
      ...commonFunctionProps,
      entry: 'src/functions/api.ts',
      handler: 'handler',
      description:
        'Management API — /v1/*, /healthz, /readyz and the JSON 404 default (design 3.1)',
      memorySize: 512,
      timeout: Duration.seconds(30),
      reservedConcurrentExecutions: 200,
    });

    const aggregatorFn = new NodejsFunction(this, 'AggregatorFn', {
      ...commonFunctionProps,
      entry: 'src/functions/aggregator.ts',
      handler: 'handler',
      description: 'Click aggregation consumer (design 3.6; job logic owned by URL-14)',
      memorySize: 512,
      timeout: Duration.seconds(AGGREGATOR_TIMEOUT_SECONDS),
    });

    const maintenanceFn = new NodejsFunction(this, 'MaintenanceFn', {
      ...commonFunctionProps,
      entry: 'src/functions/maintenance.ts',
      handler: 'handler',
      description: 'Scheduled maintenance jobs (design 3.7; job logic owned by URL-14)',
      memorySize: 256,
      timeout: Duration.seconds(300),
    });

    // Design §3.6: batch ≤ 100, whole-batch redelivery with the eventId dedup
    // gate providing exactly-once effects — `reportBatchItemFailures` stays off.
    // AWS caps windowless SQS batches at 10 messages, so the design's ≤100
    // batch needs a small batching window; 5s is an engineering default
    // (aggregator latency is user-invisible — the redirect path only enqueues).
    aggregatorFn.addEventSource(
      new SqsEventSource(clickQueue, {
        batchSize: 100,
        maxBatchingWindow: Duration.seconds(5),
        enabled: true,
      }),
    );

    // ---------------------------------------------------------- edge / routing
    // Design §3.1: Route 53 → API Gateway HTTP API on ONE shared custom domain
    // (NFR-9). No CloudFront/CDN/edge anywhere (AD-1, AD-2, AD-7).
    const sharedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'SharedZone', {
      hostedZoneId: prerequisites.hostedZoneId,
      zoneName: prerequisites.hostedZoneName,
    });
    // The single shared domain is <DomainLabel>.<HostedZoneName> (NFR-9).
    const sharedDomainName = Fn.join('.', [
      prerequisites.domainLabel,
      prerequisites.hostedZoneName,
    ]);
    const sharedCertificate = new acm.Certificate(this, 'SharedDomainCertificate', {
      domainName: sharedDomainName,
      validation: acm.CertificateValidation.fromDns(sharedZone),
    });
    const sharedDomain = new apigwv2.DomainName(this, 'SharedDomain', {
      domainName: sharedDomainName,
      certificate: sharedCertificate,
      endpointType: apigwv2.EndpointType.REGIONAL,
    });

    const apiIntegration = new HttpLambdaIntegration('ApiIntegration', apiFn);
    const redirectIntegration = new HttpLambdaIntegration('RedirectIntegration', redirectFn);

    const api = new apigwv2.HttpApi(this, 'HttpApi', {
      // `$default` → apiFn: anything that is not an explicit route below gets
      // the §5.1 JSON 404 envelope (design §3.1 "/* otherwise").
      defaultIntegration: apiIntegration,
      defaultDomainMapping: { domainName: sharedDomain },
      description: 'URL Shortener API (design 3.1) — no CDN/edge in front (AD-1/AD-2/AD-7)',
    });

    // Static paths first: both the gateway and Fastify's router give static
    // routes precedence over `/{slug}` (design §3.1), so `/healthz` and
    // `/readyz` can never be shadowed by a slug with the same name — those
    // strings are additionally rejected at slug-creation time (§3.1/§6.4).
    api.addRoutes({
      path: '/healthz',
      methods: [apigwv2.HttpMethod.GET],
      integration: apiIntegration,
    });
    api.addRoutes({
      path: '/readyz',
      methods: [apigwv2.HttpMethod.GET],
      integration: apiIntegration,
    });
    // Design writes `/v1/*`; `{proxy+}` is API Gateway's greedy path variable.
    api.addRoutes({
      path: '/v1/{proxy+}',
      methods: [apigwv2.HttpMethod.ANY],
      integration: apiIntegration,
    });
    // Single-segment `{slug}` can never collide with multi-segment `/v1/...`
    // (design §3.1) — and it is a *different* function, so the redirect hot
    // path scales independently of the management API.
    api.addRoutes({
      path: '/{slug}',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.HEAD],
      integration: redirectIntegration,
    });

    new route53.ARecord(this, 'SharedDomainAlias', {
      zone: sharedZone,
      recordName: prerequisites.domainLabel,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.ApiGatewayv2DomainProperties(
          sharedDomain.regionalDomainName,
          sharedDomain.regionalHostedZoneId,
        ),
      ),
    });

    // ------------------------------------------------------------- scheduling
    // Design §3.7 / backlog-audit F-14: one EventBridge Scheduler rule per
    // maintenance job; each injects the job id the handler dispatches on. The
    // local parity path is `npm run job:maintenance -- <job-id>` (FR-9.3/NFR-7).
    const scheduleGroup = new scheduler.ScheduleGroup(this, 'MaintenanceScheduleGroup');
    for (const job of MAINTENANCE_JOBS) {
      const cadence = HOURLY_JOBS.has(job) ? Duration.hours(1) : Duration.days(1);
      new scheduler.Schedule(this, `Maintenance-${job}`, {
        scheduleGroup,
        schedule: scheduler.ScheduleExpression.rate(cadence),
        description: `maintenanceFn · design 3.7 job "${job}" (URL-19 wiring; logic owned by URL-14)`,
        target: new schedulerTargets.LambdaInvoke(maintenanceFn, {
          input: scheduler.ScheduleTargetInput.fromObject({ job }),
        }),
      });
    }

    // ---------------------------------------------------------------- outputs
    new CfnOutput(this, 'HttpApiUrl', {
      value: api.apiEndpoint,
      description: 'Default execute-api endpoint of the HTTP API',
    });
    new CfnOutput(this, 'SharedDomainName', {
      value: sharedDomainName,
      description: 'The single shared custom domain (NFR-9 — exactly one; no per-user domains)',
    });
    new CfnOutput(this, 'DbProxyEndpoint', {
      value: dbProxy.attrEndpoint,
      description: 'RDS Proxy endpoint every deployed DB connection uses (D-4)',
    });
    new CfnOutput(this, 'ClickQueueUrl', {
      value: clickQueue.queueUrl,
      description: 'SQS click-event queue consumed by aggregatorFn (D-8)',
    });
    new CfnOutput(this, 'ClickDlqUrl', {
      value: clickDlq.queueUrl,
      description: 'DLQ for exhausted aggregator retries (design 3.6/8.5)',
    });
    new CfnOutput(this, 'MaintenanceScheduleGroupArn', {
      value: scheduleGroup.scheduleGroupArn,
      description: 'EventBridge Scheduler group holding the five design 3.7 jobs',
    });
    new CfnOutput(this, 'VpcId', {
      value: vpc.vpcId,
      description: 'Stack-owned VPC; the existing RDS must be reachable from it (prerequisite).',
    });
  }
}

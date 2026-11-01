/**
 * URL-19 synthesis acceptance — the CDK stack is asserted against the ticket's
 * acceptance criteria and the design sections it implements (§1.2, §1.3, §3.1,
 * §3.7, §6.3, §9.4, §9.5, §10.6; decisions D-1, D-4, D-8, D-15, AD-1, AD-2,
 * AD-7, AD-12).
 *
 * These assertions run inside `npm test` (offline synthesis — no credentials,
 * no lookups, no product values), so the existing CI quality gate proves the
 * IaC invariants on every PR.
 */
import { describe, expect, it } from 'vitest';
import { Match } from 'aws-cdk-lib/assertions';
import {
  MAINTENANCE_JOBS,
  type SynthResource,
  applicationLambdas,
  synthesizedStack,
} from './synthesized-stack.ts';

const { template, json, serialized } = synthesizedStack();
const lambdas = applicationLambdas(json);

const props = (resource: SynthResource): Record<string, unknown> => resource.Properties ?? {};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

/** First element of a `Fn::GetAtt` pair (the logical id being read). */
const getAttFirst = (value: unknown): string => {
  const getAtt = record(value)['Fn::GetAtt'];
  return Array.isArray(getAtt) ? String(getAtt[0]) : '';
};

const resourcesByType = (type: string): Array<[string, SynthResource]> =>
  Object.entries(json.Resources).filter(([, resource]) => resource.Type === type);

/** Route logical id → integration logical id → Lambda logical id. */
function routeTargets(): Map<string, string> {
  const integrationToLambda = new Map<string, string>();
  for (const [logicalId, resource] of resourcesByType('AWS::ApiGatewayV2::Integration')) {
    const uri = getAttFirst(props(resource).IntegrationUri);
    integrationToLambda.set(logicalId, String(uri));
  }

  const targets = new Map<string, string>();
  for (const [, resource] of resourcesByType('AWS::ApiGatewayV2::Route')) {
    const routeProps = props(resource);
    const join = record(routeProps.Target)['Fn::Join'];
    const parts = Array.isArray(join) ? (join[1] as unknown[]) : [];
    const integrationId = String(record(parts[1]).Ref);
    targets.set(String(routeProps.RouteKey), integrationToLambda.get(integrationId) ?? '');
  }
  return targets;
}

describe('URL-19 · API Gateway HTTP API route table (design §3.1, NFR-9, AD-1/AD-2/AD-7)', () => {
  const targets = routeTargets();

  it('declares exactly the six §3.1 routes — static health routes, /v1, {slug} and the JSON-404 default', () => {
    expect([...targets.keys()].sort()).toEqual(
      [
        '$default',
        'ANY /v1/{proxy+}',
        'GET /healthz',
        'GET /readyz',
        'GET /{slug}',
        'HEAD /{slug}',
      ].sort(),
    );
  });

  it('routes the static /healthz and /readyz paths to apiFn (design §3.1 precedence)', () => {
    expect(targets.get('GET /healthz')).toMatch(/^ApiFn[A-F0-9]+$/);
    expect(targets.get('GET /readyz')).toMatch(/^ApiFn[A-F0-9]+$/);
  });

  it('routes /v1/* and the $default 404 envelope to apiFn, and GET/HEAD /{slug} to redirectFn', () => {
    expect(targets.get('ANY /v1/{proxy+}')).toMatch(/^ApiFn[A-F0-9]+$/);
    expect(targets.get('$default')).toMatch(/^ApiFn[A-F0-9]+$/);
    expect(targets.get('GET /{slug}')).toMatch(/^RedirectFn[A-F0-9]+$/);
    expect(targets.get('HEAD /{slug}')).toMatch(/^RedirectFn[A-F0-9]+$/);
  });

  it('uses a single shared custom domain and never creates a hosted zone (NFR-9)', () => {
    template.resourceCountIs('AWS::ApiGatewayV2::DomainName', 1);
    template.resourceCountIs('AWS::ApiGatewayV2::ApiMapping', 1);
    // The zone is owner-provided (a CloudFormation parameter) — the stack must
    // not create or look one up.
    template.resourceCountIs('AWS::Route53::HostedZone', 0);
  });
});

describe('URL-19 · four Lambdas in private subnets with §9.4 concurrency caps (D-1)', () => {
  it('creates exactly the four application functions', () => {
    const allFunctions = resourcesByType('AWS::Lambda::Function');
    expect(allFunctions).toHaveLength(4);
    expect(lambdas).toHaveLength(4);
    expect(lambdas.map(([logicalId]) => logicalId)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^AggregatorFn[A-F0-9]+$/),
        expect.stringMatching(/^ApiFn[A-F0-9]+$/),
        expect.stringMatching(/^MaintenanceFn[A-F0-9]+$/),
        expect.stringMatching(/^RedirectFn[A-F0-9]+$/),
      ]),
    );
  });

  it('attaches every application function to the VPC private subnets (design §6.3)', () => {
    for (const [logicalId, resource] of lambdas) {
      const vpcConfig = record(props(resource).VpcConfig);
      expect(vpcConfig.SubnetIds, `${logicalId} must run in private subnets`).toBeDefined();
      expect(vpcConfig.SecurityGroupIds, `${logicalId} must carry a security group`).toBeDefined();
      expect(vpcConfig.SubnetIds as unknown[]).not.toHaveLength(0);
    }
  });

  it('applies the design §9.4 reserved-concurrency caps (redirectFn 500 / apiFn 200)', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      ReservedConcurrentExecutions: 500,
      MemorySize: 1024,
      Runtime: 'nodejs22.x',
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      ReservedConcurrentExecutions: 200,
      MemorySize: 512,
      Runtime: 'nodejs22.x',
    });
    // §9.4 sets no cap for the consumer/job functions, so they stay on the
    // unreserved account concurrency.
    for (const [logicalId, resource] of lambdas) {
      if (logicalId.startsWith('RedirectFn') || logicalId.startsWith('ApiFn')) continue;
      expect(props(resource).ReservedConcurrentExecutions, `${logicalId}`).toBeUndefined();
    }
  });

  it('wires the §9.4 per-container pool and §6.3 TLS into every function environment', () => {
    for (const [logicalId, resource] of lambdas) {
      const environment = record(record(props(resource).Environment).Variables);
      expect(environment.DB_POOL_MAX, logicalId).toBe('2');
      expect(environment.DB_STATEMENT_TIMEOUT_MS, logicalId).toBe('5000');
      expect(environment.DB_IDLE_TIMEOUT_MS, logicalId).toBe('10000');
      expect(environment.DB_SSL_MODE, logicalId).toBe('verify-full');
    }
  });

  it('sends every deployed DB connection through the RDS Proxy (D-4)', () => {
    for (const [logicalId, resource] of lambdas) {
      const environment = record(record(props(resource).Environment).Variables);
      expect(environment.RDS_PROXY_ENDPOINT, logicalId).toEqual(
        expect.objectContaining({ 'Fn::GetAtt': expect.any(Array) }),
      );
    }
  });
});

describe('URL-19 · RDS Proxy against the EXISTING RDS — no database is created (FR-9.2, D-4)', () => {
  it('creates one RDS Proxy and one target group, and zero RDS instances/clusters', () => {
    template.resourceCountIs('AWS::RDS::DBProxy', 1);
    template.resourceCountIs('AWS::RDS::DBProxyTargetGroup', 1);
    template.resourceCountIs('AWS::RDS::DBInstance', 0);
    template.resourceCountIs('AWS::RDS::DBCluster', 0);
  });

  it('targets the owner-provided instance identifier with TLS required', () => {
    template.hasResourceProperties('AWS::RDS::DBProxy', {
      EngineFamily: 'POSTGRESQL',
      RequireTLS: true,
    });
    template.hasResourceProperties('AWS::RDS::DBProxyTargetGroup', {
      TargetGroupName: 'default',
      DBInstanceIdentifiers: [{ Ref: 'RdsInstanceIdentifier' }],
    });
  });

  it('authenticates the proxy with the owner-provided Secrets Manager secret (design §6.2)', () => {
    template.hasResourceProperties('AWS::RDS::DBProxy', {
      Auth: [{ AuthScheme: 'SECRETS', IAMAuth: 'DISABLED', SecretArn: { Ref: 'DbSecretArn' } }],
    });
  });
});

describe('URL-19 · SQS + DLQ wiring (D-8, design §3.6)', () => {
  it('creates exactly the click queue and its DLQ', () => {
    template.resourceCountIs('AWS::SQS::Queue', 2);
  });

  it('uses the §3.6 48h retention, a ≥6×-timeout visibility window and a DLQ redrive policy', () => {
    const queues = resourcesByType('AWS::SQS::Queue');
    const clickQueue = queues.find(([logicalId]) => /^ClickQueue/.test(logicalId));
    const dlq = queues.find(([logicalId]) => /^ClickDlq/.test(logicalId));
    expect(clickQueue, 'click queue').toBeDefined();
    expect(dlq, 'DLQ').toBeDefined();

    const clickQueueProps = props(clickQueue?.[1] as SynthResource);
    expect(clickQueueProps.MessageRetentionPeriod).toBe(48 * 60 * 60);
    expect(clickQueueProps.VisibilityTimeout).toBe(6 * 60);

    const redrive = record(clickQueueProps.RedrivePolicy);
    expect(redrive.maxReceiveCount).toBe(5);
    expect(getAttFirst(redrive.deadLetterTargetArn)).toMatch(/^ClickDlq/);
  });

  it('grants redirectFn only sqs:SendMessage on the click queue (best-effort emission, §3.2)', () => {
    const statements = resourcesByType('AWS::IAM::Policy').flatMap(([, resource]) => {
      const document = record(props(resource).PolicyDocument);
      const raw = document.Statement;
      return Array.isArray(raw) ? raw : [];
    });
    const sendStatements = statements.filter(
      (statement) => record(statement).Action === 'sqs:SendMessage',
    );
    expect(sendStatements).toHaveLength(1);
    const resource = record(record(sendStatements[0]).Resource);
    // The producer may only SendMessage, and only to the click queue.
    expect(record(sendStatements[0]).Action).toBe('sqs:SendMessage');
    expect(JSON.stringify(resource)).toContain('ClickQueue');
  });

  it('feeds aggregatorFn in §3.6 batches of ≤100 with whole-batch redelivery', () => {
    const mappings = resourcesByType('AWS::Lambda::EventSourceMapping');
    expect(mappings).toHaveLength(1);
    const mapping = props(mappings[0]?.[1] as SynthResource);
    expect(mapping.BatchSize).toBe(100);
    expect(mapping.MaximumBatchingWindowInSeconds).toBe(5);
    expect(String(record(mapping.FunctionName).Ref)).toMatch(/^AggregatorFn[A-F0-9]+$/);
    expect(getAttFirst(mapping.EventSourceArn)).toMatch(/^ClickQueue/);
    // Whole-batch redelivery + the eventId dedup gate (§13-c1) is the design;
    // partial-batch reporting would change that contract.
    expect(serialized).not.toContain('FunctionResponseTypes');
  });
});

describe('URL-19 · EventBridge Scheduler for every design §3.7 job (F-14)', () => {
  it('creates one schedule per §3.7 job in a dedicated schedule group', () => {
    template.resourceCountIs('AWS::Scheduler::Schedule', MAINTENANCE_JOBS.length);
    template.resourceCountIs('AWS::Scheduler::ScheduleGroup', 1);
  });

  it('injects the job id the maintenanceFn handler dispatches on', () => {
    const schedules = resourcesByType('AWS::Scheduler::Schedule').map(
      ([, resource]) => record(props(resource).Target).Input,
    );
    expect(schedules.sort()).toEqual(MAINTENANCE_JOBS.map((job) => JSON.stringify({ job })).sort());
  });

  it('runs four jobs daily and rate-limit hygiene hourly (design §3.7 cadences)', () => {
    const cadences = resourcesByType('AWS::Scheduler::Schedule').map(([logicalId, resource]) => ({
      hourly: logicalId.toLowerCase().includes('ratelimithygiene'),
      expression: String(props(resource).ScheduleExpression),
    }));
    expect(cadences.filter(({ hourly }) => hourly)).toEqual([
      { hourly: true, expression: 'rate(1 hour)' },
    ]);
    expect(cadences.filter(({ hourly }) => !hourly)).toHaveLength(4);
    expect(cadences.filter(({ hourly }) => !hourly).map(({ expression }) => expression)).toEqual([
      'rate(1 day)',
      'rate(1 day)',
      'rate(1 day)',
      'rate(1 day)',
    ]);
  });

  it('targets maintenanceFn through an assume-role for the scheduler service', () => {
    const schedules = resourcesByType('AWS::Scheduler::Schedule');
    for (const [, resource] of schedules) {
      const target = record(props(resource).Target);
      expect(getAttFirst(target.Arn)).toMatch(/^MaintenanceFn[A-F0-9]+$/);
    }
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [
          Match.objectLike({
            Principal: { Service: 'scheduler.amazonaws.com' },
          }),
        ],
      },
    });
  });
});

describe('URL-19 · networking per design §6.3 — NAT and the four required VPC endpoints', () => {
  it('creates one NAT gateway and the four §6.3 endpoints (SQS, Secrets Manager, CloudWatch, X-Ray)', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 1);
    template.resourceCountIs('AWS::EC2::VPCEndpoint', 4);
    // Service names are region tokens, so match on the rendered string.
    const serviceNames = resourcesByType('AWS::EC2::VPCEndpoint').map(([, resource]) =>
      JSON.stringify(props(resource).ServiceName),
    );
    expect(serviceNames.filter((name) => name.includes('.sqs'))).toHaveLength(1);
    expect(serviceNames.filter((name) => name.includes('.secretsmanager'))).toHaveLength(1);
    expect(serviceNames.filter((name) => name.includes('.logs'))).toHaveLength(1);
    expect(serviceNames.filter((name) => name.includes('.xray'))).toHaveLength(1);
  });

  it('opens the DB port from the proxy to the owner-provided DB security group only', () => {
    const ingress = resourcesByType('AWS::EC2::SecurityGroupIngress').map(([, resource]) =>
      props(resource),
    );
    expect(ingress).toHaveLength(2);
    // One rule lands on the owner's DB security group (the proxy is the source);
    // the other opens the proxy itself to the application subnets.
    expect(ingress.map((rule) => rule.GroupId)).toContainEqual({ Ref: 'RdsSecurityGroupId' });
    expect(ingress.map((rule) => rule.GroupId)).toContainEqual({
      'Fn::GetAtt': [expect.stringMatching(/^DbProxySecurityGroup/), 'GroupId'],
    });
    for (const rule of ingress) {
      expect(rule.IpProtocol).toBe('tcp');
      expect(rule.FromPort).toEqual({ Ref: 'RdsPort' });
      expect(rule.ToPort).toEqual({ Ref: 'RdsPort' });
    }
  });
});

describe('URL-19 · owner prerequisites block deployment, not synthesis (X-7 / D6)', () => {
  it('declares every owner input as a parameter without a default', () => {
    const ownerParameters = [
      'HostedZoneId',
      'HostedZoneName',
      'DomainLabel',
      'RdsInstanceIdentifier',
      'RdsPort',
      'RdsSecurityGroupId',
      'DatabaseName',
      'DbSecretArn',
      'JwtSecretArn',
      'OAuthSecretArn',
      'CaptchaSecretArn',
    ];
    const parameters = json.Parameters ?? {};
    for (const name of ownerParameters) {
      expect(parameters[name], `${name} must be an owner-provided parameter`).toBeDefined();
      expect(
        parameters[name]?.Default,
        `${name} must have no default — a default would invent an owner value`,
      ).toBeUndefined();
    }
    // Exactly the owner inputs, plus the CDK bootstrap parameter.
    expect(Object.keys(parameters).sort()).toEqual([...ownerParameters, 'BootstrapVersion'].sort());
  });

  it('keeps the secret-ARN parameters out of plain view (NoEcho)', () => {
    for (const name of ['DbSecretArn', 'JwtSecretArn', 'OAuthSecretArn', 'CaptchaSecretArn']) {
      template.hasParameter(name, { NoEcho: true });
    }
  });

  it('composes DATABASE_URL at deploy time from Secrets Manager + the proxy — never a literal', () => {
    for (const [logicalId, resource] of lambdas) {
      const environment = record(record(props(resource).Environment).Variables);
      const databaseUrl = environment.DATABASE_URL;
      expect(Object.keys(record(databaseUrl)), `${logicalId} DATABASE_URL`).toEqual(['Fn::Join']);

      const parts = (record(databaseUrl)['Fn::Join'] as unknown[])[1] as unknown[];
      const rendered = parts.map((part) => JSON.stringify(part)).join('');
      expect(rendered, `${logicalId} DATABASE_URL starts at postgres://`).toContain(
        'postgres://{{resolve:secretsmanager:',
      );
      expect(rendered, `${logicalId} DATABASE_URL credential source`).toContain('DbSecretArn');
      expect(rendered, `${logicalId} DATABASE_URL host is the proxy`).toContain('DbProxy');
      expect(rendered, `${logicalId} DATABASE_URL port`).toContain('RdsPort');
      expect(rendered, `${logicalId} DATABASE_URL database`).toContain('DatabaseName');
      // No bare hostnames, ports or credentials may survive into the template.
      expect(rendered).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
      expect(rendered).not.toContain('.amazonaws.com');
    }
  });
});

/** Invoked ONLY after release-control authorization in a protected environment.
 * No bootstrap, force deploy, direct Lambda update, DB down or resource deletion.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  parseTarget,
  targetDigest,
  assertAssemblyStack,
  assertPreparedChangeSet,
  targets,
  type ReleaseTarget,
  type Target,
} from './release-policy.ts';
import { verifiedManifest } from './release-control.ts';
const execute = promisify(execFile);
export type Program = (file: string, args: string[], cwd?: string) => Promise<string>;
const program: Program = async (file, args, cwd) => {
  try {
    return (
      await execute(file, args, {
        cwd,
        env: process.env,
        timeout: 15 * 60000,
        maxBuffer: 32 * 1024 * 1024,
      })
    ).stdout;
  } catch {
    throw new Error('Release operation failed; no raw command/driver output is logged.');
  }
};
export function releasePlan(
  config: ReleaseTarget,
  operation: string,
  changeSet: string,
): { stage: string; file: string; args: string[] }[] {
  if (!['release', 'rollback'].includes(operation) || !/^[A-Za-z0-9-]+$/.test(changeSet))
    throw new Error('Invalid release plan.');
  if (
    operation === 'rollback' &&
    !/^https:\/\/\S+$/.test(config.rollbackCompatibilityEvidence ?? '')
  )
    throw new Error('Rollback requires reviewed forward-schema compatibility evidence.');
  return [
    {
      stage: 'prepare',
      file: 'npx',
      args: [
        '--no-install',
        'cdk',
        'deploy',
        'UrlShortenerApi',
        '--app',
        'release-payload/cdk.out',
        '--method',
        'prepare-change-set',
        '--change-set-name',
        changeSet,
        // Replaces the interactive CDK IAM prompt ONLY after the explicit protected
        // environment authorization. GitHub human approval is never disabled.
        '--require-approval',
        'never',
        ...Object.entries(config.parameters).flatMap(([key, value]) => [
          '--parameters',
          `${key}=${value}`,
        ]),
      ],
    },
    ...(operation === 'release'
      ? [
          {
            stage: 'migrate',
            file: 'npx',
            args: [
              '--no-install',
              'node-pg-migrate',
              'up',
              '--migrations-dir',
              'release-payload/migrations',
              '--migration-file-language',
              'ts',
              '--check-order',
            ],
          },
        ]
      : []),
    {
      stage: 'traffic',
      file: 'aws',
      args: [
        'cloudformation',
        'execute-change-set',
        '--stack-name',
        config.stack,
        '--change-set-name',
        changeSet,
      ],
    },
    {
      stage: 'wait',
      file: 'aws',
      args: ['cloudformation', 'wait', 'stack-update-complete', '--stack-name', config.stack],
    },
  ];
}
export async function executeOrderedPlan(
  plan: ReturnType<typeof releasePlan>,
  run: Program,
): Promise<void> {
  for (const step of plan) await run(step.file, step.args);
}
export function fileInventory(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(root).sort()) {
    const full = join(root, name);
    const stat = lstatSync(full);
    if (!stat.isFile()) throw new Error('Lambda bundle must contain regular flat files only.');
    files[name] = createHash('sha256').update(readFileSync(full)).digest('hex');
  }
  return files;
}
async function verifyRunningCode(config: ReleaseTarget, run: Program): Promise<void> {
  const template = JSON.parse(
    readFileSync('release-payload/cdk.out/UrlShortenerApi.template.json', 'utf8'),
  ) as { Resources: Record<string, { Type: string; Properties?: { Code?: { S3Key?: string } } }> };
  const functions = Object.entries(template.Resources).filter(
    ([, value]) => value.Type === 'AWS::Lambda::Function',
  );
  if (functions.length !== 4)
    throw new Error('Frozen stack must contain the four reviewed application functions.');
  const resources = JSON.parse(
    await run('aws', ['cloudformation', 'list-stack-resources', '--stack-name', config.stack]),
  ) as {
    StackResourceSummaries: {
      ResourceType: string;
      LogicalResourceId: string;
      PhysicalResourceId: string;
    }[];
  };
  for (const [logicalId, value] of functions) {
    const hash = value.Properties?.Code?.S3Key?.match(/^([a-f0-9]{64})\.zip$/)?.[1];
    const name = resources.StackResourceSummaries.find(
      (r) => r.ResourceType === 'AWS::Lambda::Function' && r.LogicalResourceId === logicalId,
    )?.PhysicalResourceId;
    if (!hash || !name)
      throw new Error('Actual Lambda resource or reviewed code asset is unavailable.');
    const asset = `asset.${hash}`;
    const expected = fileInventory(resolve('release-payload/cdk.out', asset));
    const actual = JSON.parse(
      await run('aws', ['lambda', 'get-function', '--function-name', name]),
    ) as {
      Configuration: { State: string; LastUpdateStatus: string; CodeSha256: string };
      Code: { Location: string };
    };
    if (
      actual.Configuration.State !== 'Active' ||
      actual.Configuration.LastUpdateStatus !== 'Successful'
    )
      throw new Error('Running function is not active at a successful revision.');
    const url = new URL(actual.Code.Location);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.amazonaws.com'))
      throw new Error('Invalid signed code download origin.');
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Running artifact download unavailable.');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (
      bytes.length > 32 * 1024 * 1024 ||
      createHash('sha256').update(bytes).digest('base64') !== actual.Configuration.CodeSha256
    )
      throw new Error('Running code digest mismatch.');
    const directory = resolve('release-verification', randomUUID());
    mkdirSync(directory, { recursive: true });
    const { writeFileSync } = await import('node:fs');
    const archive = join(directory, 'code.zip');
    writeFileSync(archive, bytes);
    const entries = (await run('unzip', ['-Z1', archive])).trim().split('\n').sort();
    if (JSON.stringify(entries) !== JSON.stringify(Object.keys(expected).sort()))
      throw new Error('Running artifact file set differs from the reviewed bundle.');
    const extracted = join(directory, 'files');
    mkdirSync(extracted);
    await run('unzip', ['-q', archive, '-d', extracted]);
    if (JSON.stringify(fileInventory(extracted)) !== JSON.stringify(expected))
      throw new Error('Running Lambda bytes differ from the immutable artifact.');
  }
}
export async function observabilitySmoke(
  config: ReleaseTarget,
  run: Program,
  fetcher: typeof fetch = fetch,
  observation: { requestId: string; start: string } = {
    requestId: randomUUID(),
    start: new Date(Date.now() - 10000).toISOString(),
  },
): Promise<void> {
  const { requestId, start } = observation;
  for (const path of ['/healthz', '/readyz']) {
    const result = await fetcher(new URL(path, config.origin), {
      headers: { 'x-request-id': requestId },
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (result.status !== 200) throw new Error('AC smoke health/readiness failed.');
    await result.body?.cancel();
  }
  const logs = JSON.parse(
    await run('aws', [
      'logs',
      'filter-log-events',
      '--log-group-name',
      config.logGroup,
      '--start-time',
      String(Date.parse(start)),
      '--filter-pattern',
      JSON.stringify(requestId),
    ]),
  ) as { events?: { message: string }[] };
  const lines = (logs.events ?? []).flatMap((event) => {
    try {
      return [JSON.parse(event.message) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
  const log = lines.find(
    (line) => line.requestId === requestId && line.status === 200 && line.route === '/readyz',
  );
  const fields = [
    'timestamp',
    'level',
    'requestId',
    'traceId',
    'route',
    'method',
    'status',
    'durationMs',
    'principal',
    'outcome',
    'errorCode',
    'msg',
  ];
  if (
    !log ||
    !/^[a-f0-9]{32}$/.test(String(log.traceId)) ||
    /^0+$/.test(String(log.traceId)) ||
    typeof log.durationMs !== 'number' ||
    !Number.isFinite(log.durationMs) ||
    log.durationMs < 0 ||
    typeof log.level !== 'number' ||
    log.method !== 'GET' ||
    !Number.isFinite(Date.parse(String(log.timestamp))) ||
    !log.principal ||
    !log.outcome ||
    Object.keys(log).some((key) => !fields.includes(key)) ||
    /"(?:clientIp|ip|authorization|password|cookie|token)"\s*:|\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(
      JSON.stringify(log),
    )
  )
    throw new Error('AC smoke structured privacy-safe correlated log unavailable.');
  const metric = JSON.parse(
    await run('aws', [
      'cloudwatch',
      'get-metric-statistics',
      '--namespace',
      config.metricNamespace,
      '--metric-name',
      config.metricName,
      '--dimensions',
      JSON.stringify(config.metricDimensions),
      '--start-time',
      start,
      '--end-time',
      new Date(Date.now() + 1000).toISOString(),
      '--period',
      '60',
      '--statistics',
      'Sum',
    ]),
  ) as { Datapoints?: { Sum: number }[] };
  if (!metric.Datapoints?.some((point) => point.Sum > 0))
    throw new Error('AC smoke emitted request metric unavailable.');
  const id = String(log.traceId);
  const xrayId = `1-${id.slice(0, 8)}-${id.slice(8)}`;
  const traces = JSON.parse(
    await run('aws', ['xray', 'batch-get-traces', '--trace-ids', xrayId]),
  ) as { Traces?: { Id: string; Segments?: unknown[] }[] };
  if (!traces.Traces?.some((t) => t.Id === xrayId && t.Segments?.length))
    throw new Error('AC smoke correlated distributed trace unavailable.');
}
export async function executeRelease(target: Target, run: Program = program): Promise<void> {
  if (
    !targets.includes(target) ||
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.GITHUB_REF !== 'refs/heads/main' ||
    process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
  )
    throw new Error('Deployment is allowed only in the authorized workflow.');
  const config = parseTarget(process.env.RELEASE_TARGET),
    digest = targetDigest(config),
    manifest = verifiedManifest();
  const authorization = JSON.parse(readFileSync('.release-authorization.json', 'utf8')) as {
    target: string;
    digest: string;
    run: string;
    workflowSha: string;
    payloadSha256: string;
  };
  if (
    authorization.target !== target ||
    authorization.digest !== digest ||
    process.env.EXPECTED_TARGET_DIGEST !== digest ||
    authorization.run !== process.env.GITHUB_RUN_ID ||
    authorization.workflowSha !== process.env.GITHUB_SHA ||
    authorization.payloadSha256 !== manifest.payloadSha256
  )
    throw new Error('Exact artifact/target authorization binding is invalid.');
  if (!process.env.DATABASE_URL && process.env.OPERATION !== 'rollback')
    throw new Error('Protected migration credentials/network access are unavailable.');
  if (process.env.OPERATION === 'release') {
    const database = new URL(process.env.DATABASE_URL!);
    if (
      !['postgres:', 'postgresql:'].includes(database.protocol) ||
      database.searchParams.get('sslmode') !== 'verify-full' ||
      database.searchParams.getAll('sslmode').length !== 1 ||
      database.searchParams.has('ssl')
    )
      throw new Error(
        'Migration requires an explicitly supplied verify-full TLS database connection.',
      );
  }
  const identity = JSON.parse(await run('aws', ['sts', 'get-caller-identity'])) as {
    Account: string;
  };
  if (identity.Account !== config.account || process.env.AWS_REGION !== config.region)
    throw new Error('AWS account/region differs from approved target.');
  if (process.env.OPERATION === 'release') {
    const database = new URL(process.env.DATABASE_URL!);
    const instances = JSON.parse(
      await run('aws', [
        'rds',
        'describe-db-instances',
        '--db-instance-identifier',
        config.parameters.RdsInstanceIdentifier!,
      ]),
    ) as { DBInstances: { Endpoint: { Address: string; Port: number } }[] };
    const endpoint = instances.DBInstances[0]?.Endpoint;
    if (
      !endpoint ||
      database.hostname !== endpoint.Address ||
      Number(database.port || '5432') !== endpoint.Port ||
      decodeURIComponent(database.pathname.slice(1)) !== config.parameters.DatabaseName ||
      String(endpoint.Port) !== config.parameters.RdsPort
    )
      throw new Error('Migration connection is not the approved existing RDS target.');
  }
  const paths = (await run('tar', ['-tzf', 'release-candidate/payload.tgz'])).trim().split('\n');
  if (
    paths.some(
      (p) =>
        p.startsWith('/') ||
        p.split('/').includes('..') ||
        !/^(cdk.out|dist|migrations|package.json|package-lock.json)(\/|$)/.test(p),
    )
  )
    throw new Error('Unsafe release archive.');
  const listing = await run('tar', ['-tvzf', 'release-candidate/payload.tgz']);
  if (listing.split('\n').some((line) => line && !['-', 'd'].includes(line[0]!)))
    throw new Error('Release archive links are forbidden.');
  mkdirSync('release-payload');
  await run('tar', [
    '-xzf',
    'release-candidate/payload.tgz',
    '-C',
    'release-payload',
    '--no-same-owner',
    '--no-same-permissions',
  ]);
  assertAssemblyStack(
    JSON.parse(readFileSync('release-payload/cdk.out/manifest.json', 'utf8')),
    config.stack,
  );
  const plan = releasePlan(
    config,
    process.env.OPERATION ?? '',
    `release-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
  );
  // Determine create/update only from the prepared change set, not error text.
  let waiter: string | undefined;
  for (const step of plan) {
    if (step.stage === 'wait') {
      if (!waiter) throw new Error('Unknown change set type.');
      await run('aws', ['cloudformation', 'wait', waiter, '--stack-name', config.stack]);
    } else {
      await run(step.file, step.args);
      if (step.stage === 'prepare') {
        const change: unknown = JSON.parse(
          await run('aws', [
            'cloudformation',
            'describe-change-set',
            '--stack-name',
            config.stack,
            '--change-set-name',
            plan[0]!.args[plan[0]!.args.indexOf('--change-set-name') + 1]!,
          ]),
        );
        assertPreparedChangeSet(change);
        const stack = JSON.parse(
          await run('aws', ['cloudformation', 'describe-stacks', '--stack-name', config.stack]),
        ) as { Stacks: { StackStatus: string }[] };
        const status = stack.Stacks[0]?.StackStatus;
        waiter =
          status === 'REVIEW_IN_PROGRESS'
            ? 'stack-create-complete'
            : ['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE'].includes(
                  status ?? '',
                )
              ? 'stack-update-complete'
              : undefined;
        if (!waiter) throw new Error('Stack is not in a safe prepare state.');
      }
    }
  }
  await verifyRunningCode(config, run);
  let smokePassed = false;
  const observation = {
    requestId: randomUUID(),
    start: new Date(Date.now() - 10000).toISOString(),
  };
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      await observabilitySmoke(config, run, fetch, observation);
      smokePassed = true;
      break;
    } catch {
      if (attempt < 11) await delay(10000);
    }
  }
  if (!smokePassed) throw new Error('Staging/production AC smoke remains unverified.');
  await verifyRunningCode(config, run);
  console.log(
    JSON.stringify({
      outcome: 'verified',
      target,
      sourceSha: manifest.sourceSha,
      payloadSha256: manifest.payloadSha256,
      targetDigest: digest,
    }),
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  executeRelease(process.argv[2] as Target).catch(() => {
    console.error(
      'Release stopped: authorization, migration, target operation or running-release evidence failed. Do not mark deployed.',
    );
    process.exitCode = 1;
  });
}

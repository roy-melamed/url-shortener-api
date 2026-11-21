/** Release control plane only. No import-time network, credential or deploy action. */
import { createHash } from 'node:crypto';
export const targets = ['staging', 'production'] as const;
export type Target = (typeof targets)[number];
export interface ReleaseTarget {
  account: string;
  region: string;
  roleArn: string;
  stack: string;
  runnerLabel: string;
  parameters: Record<string, string>;
  origin: string;
  logGroup: string;
  metricNamespace: string;
  metricName: string;
  metricDimensions: { Name: string; Value: string }[];
  rollbackCompatibilityEvidence?: string;
}
export const parameterNames = [
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
export function parseTarget(raw: string | undefined): ReleaseTarget {
  let value: ReleaseTarget;
  try {
    value = JSON.parse(raw ?? '') as ReleaseTarget;
  } catch {
    throw new Error('Owner-provided release target is unavailable.');
  }
  const fields = [
    'account',
    'region',
    'roleArn',
    'stack',
    'runnerLabel',
    'parameters',
    'origin',
    'logGroup',
    'metricNamespace',
    'metricName',
    'metricDimensions',
    'rollbackCompatibilityEvidence',
  ];
  if (value && Object.keys(value).some((key) => !fields.includes(key)))
    throw new Error('Unknown release target field.');
  // Parse the owner-supplied ARN components instead of embedding an ARN literal.
  const role = typeof value?.roleArn === 'string' ? value.roleArn.split(':') : [];
  if (
    !value ||
    !/^\d{12}$/.test(value.account) ||
    !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(value.region) ||
    role.length !== 6 ||
    role[0] !== 'arn' ||
    role[1] !== 'aws' ||
    role[2] !== 'iam' ||
    role[3] !== '' ||
    role[4] !== value.account ||
    !/^role\/[A-Za-z0-9_+=,.@/-]+$/.test(role[5] ?? '') ||
    !/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(value.stack) ||
    !/^[a-z][a-z0-9-]{2,62}$/.test(value.runnerLabel ?? '') ||
    ['self-hosted', 'linux', 'ubuntu-latest'].includes(value.runnerLabel) ||
    !value.parameters ||
    parameterNames.some(
      (key) =>
        typeof value.parameters[key] !== 'string' ||
        !value.parameters[key] ||
        /[\r\n]/.test(value.parameters[key]!),
    ) ||
    Object.keys(value.parameters).some((key) => !parameterNames.includes(key)) ||
    !value.logGroup ||
    !value.metricNamespace ||
    value.metricName !== 'http.server.requests' ||
    !Array.isArray(value.metricDimensions) ||
    value.metricDimensions.some((d) => !d.Name || !d.Value)
  )
    throw new Error('Invalid or incomplete release target.');
  let url: URL;
  try {
    url = new URL(value.origin);
  } catch {
    throw new Error('Invalid release origin.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('Invalid release origin.');
  if (
    url.hostname !==
    `${value.parameters.DomainLabel}.${value.parameters.HostedZoneName}`.toLowerCase()
  )
    throw new Error('Release origin differs from the reviewed domain parameters.');
  return value;
}
export function targetDigest(value: ReleaseTarget): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, canonical(x)]),
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
export function assertAssemblyStack(input: unknown, stack: string): void {
  const assembly = input as {
    artifacts?: Record<
      string,
      { type?: string; properties?: { stackName?: string; templateFile?: string } }
    >;
  };
  const artifact = assembly.artifacts?.UrlShortenerApi;
  // CDK omits stackName when it equals the artifact ID; preserve that schema
  // default rather than rewriting the frozen infrastructure's stack identity.
  if (
    artifact?.type !== 'aws:cloudformation:stack' ||
    artifact.properties?.templateFile !== 'UrlShortenerApi.template.json' ||
    (artifact.properties.stackName ?? 'UrlShortenerApi') !== stack
  )
    throw new Error('Frozen CDK assembly target differs from approved stack.');
}
export function assertPreparedChangeSet(input: unknown): void {
  const change = input as {
    Status?: string;
    ExecutionStatus?: string;
    NextToken?: string;
    Changes?: { ResourceChange?: { Action?: string; Replacement?: string } }[];
  };
  if (
    change.Status !== 'CREATE_COMPLETE' ||
    change.ExecutionStatus !== 'AVAILABLE' ||
    change.NextToken ||
    !Array.isArray(change.Changes) ||
    change.Changes.some(
      (item) =>
        item.ResourceChange?.Action === 'Remove' ||
        ['True', 'Conditional'].includes(item.ResourceChange?.Replacement ?? ''),
    )
  )
    throw new Error(
      'Change set is incomplete, nonexecutable or destructive; migration/traffic change blocked.',
    );
}
export function assertReleaseContext(env: NodeJS.ProcessEnv): void {
  if (
    env.GITHUB_ACTIONS !== 'true' ||
    env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    env.GITHUB_REF !== 'refs/heads/main' ||
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') ||
    env.EXPECTED_SHA !== env.GITHUB_SHA
  )
    throw new Error('Release requires an explicit exact-main workflow dispatch.');
}
export function assertProtectedEnvironment(value: unknown): void {
  const e = value as {
    protection_rules?: {
      type?: string;
      prevent_self_review?: boolean;
      reviewers?: { type?: string }[];
    }[];
    deployment_branch_policy?: { protected_branches?: boolean; custom_branch_policies?: boolean };
  };
  const approval = e?.protection_rules?.find((rule) => rule.type === 'required_reviewers');
  if (
    !approval?.prevent_self_review ||
    !approval.reviewers?.some((reviewer) => reviewer.type === 'User') ||
    e.deployment_branch_policy?.protected_branches !== true ||
    e.deployment_branch_policy.custom_branch_policies !== false
  )
    throw new Error(
      'Existing environment must require a human reviewer, prevent self-review, and restrict protected branches.',
    );
}
export function assertPreviousArtifact(artifact: unknown, run: unknown, repository: string): void {
  const a = artifact as {
    expired?: boolean;
    name?: string;
    workflow_run?: { id?: number; head_sha?: string; head_branch?: string };
    digest?: string;
  };
  const r = run as {
    id?: number;
    conclusion?: string;
    status?: string;
    path?: string;
    event?: string;
    head_branch?: string;
    head_sha?: string;
    repository?: { full_name?: string };
  };
  if (
    a.expired !== false ||
    a.name !== 'release-candidate' ||
    !/^sha256:[a-f0-9]{64}$/.test(a.digest ?? '') ||
    a.workflow_run?.id !== r.id ||
    a.workflow_run?.head_sha !== r.head_sha ||
    r.repository?.full_name !== repository ||
    r.path !== '.github/workflows/release.yml' ||
    r.head_branch !== 'main' ||
    r.event !== 'workflow_dispatch' ||
    r.status !== 'completed' ||
    r.conclusion !== 'success'
  )
    throw new Error(
      'Rollback requires an immutable artifact from a successful same-repository main release.',
    );
}

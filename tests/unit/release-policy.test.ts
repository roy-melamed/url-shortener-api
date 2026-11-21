import { describe, expect, it } from 'vitest';
import {
  assertPreviousArtifact,
  assertAssemblyStack,
  assertPreparedChangeSet,
  assertProtectedEnvironment,
  assertReleaseContext,
  parameterNames,
  parseTarget,
  targetDigest,
  type ReleaseTarget,
} from '../../scripts/release-policy.ts';
import {
  payloadManifest,
  assertArchiveDigest,
  assertArchiveEntries,
} from '../../scripts/release-control.ts';

export function targetFixture(): ReleaseTarget {
  return {
    account: '123456789012',
    region: 'us-east-1',
    roleArn: 'arn:aws:iam::123456789012:role/fixture-release',
    stack: 'UrlShortenerApi',
    runnerLabel: 'fixture-private',
    parameters: {
      ...Object.fromEntries(parameterNames.map((name) => [name, 'fixture'])),
      DomainLabel: 'stage',
      HostedZoneName: 'example.invalid',
    },
    origin: 'https://stage.example.invalid',
    logGroup: '/fixture/logs',
    metricNamespace: 'Fixture',
    metricName: 'http.server.requests',
    metricDimensions: [{ Name: 'route', Value: '/readyz' }],
  };
}
describe('gated release policy, no cloud operations', () => {
  it('blocks resource removals/replacements and uninspected change-set pages before migrations', () => {
    const safe = {
      Status: 'CREATE_COMPLETE',
      ExecutionStatus: 'AVAILABLE',
      Changes: [
        { ResourceChange: { Action: 'Add' } },
        { ResourceChange: { Action: 'Modify', Replacement: 'False' } },
      ],
    };
    expect(() => assertPreparedChangeSet(safe)).not.toThrow();
    for (const change of [
      { ...safe, Status: 'FAILED' },
      { ...safe, NextToken: 'uninspected-page' },
      { ...safe, Changes: [{ ResourceChange: { Action: 'Remove' } }] },
      { ...safe, Changes: [{ ResourceChange: { Replacement: 'True' } }] },
      { ...safe, Changes: [{ ResourceChange: { Replacement: 'Conditional' } }] },
    ])
      expect(() => assertPreparedChangeSet(change)).toThrow();
  });
  it('honors the frozen assembly default stack name and rejects another template/target', () => {
    const assembly = {
      artifacts: {
        UrlShortenerApi: {
          type: 'aws:cloudformation:stack',
          properties: { templateFile: 'UrlShortenerApi.template.json' },
        },
      },
    };
    expect(() => assertAssemblyStack(assembly, 'UrlShortenerApi')).not.toThrow();
    expect(() => assertAssemblyStack(assembly, 'another-stack')).toThrow();
    expect(() => assertAssemblyStack({}, 'UrlShortenerApi')).toThrow();
  });
  it('rejects substituted archives and extra/traversing extraction entries', () => {
    const bytes = Buffer.from('immutable zip fixture');
    expect(() =>
      assertArchiveDigest(
        bytes,
        'sha256:' + payloadManifest(bytes, 'a'.repeat(40), '42').payloadSha256,
      ),
    ).not.toThrow();
    expect(() => assertArchiveDigest(bytes, 'sha256:' + '0'.repeat(64))).toThrow('digest mismatch');
    expect(() => assertArchiveEntries(['payload.tgz', 'manifest.json'])).not.toThrow();
    for (const entries of [
      ['manifest.json', 'payload.tgz', 'extra'],
      ['../manifest.json', 'payload.tgz'],
      ['/manifest.json', 'payload.tgz'],
      [],
    ])
      expect(() => assertArchiveEntries(entries)).toThrow();
  });
  it('requires complete owner inputs and never invents target/secret values', () => {
    const target = targetFixture();
    expect(parseTarget(JSON.stringify(target))).toEqual(target);
    for (const raw of [
      undefined,
      '{}',
      'private-invalid',
      JSON.stringify({ ...target, account: 'wrong' }),
      JSON.stringify({ ...target, roleArn: 'arn:aws:iam::000000000000:role/other' }),
      JSON.stringify({ ...target, parameters: {} }),
      JSON.stringify({ ...target, origin: 'http://stage.example.invalid' }),
      JSON.stringify({ ...target, origin: 'https://user:password@stage.example.invalid' }),
      JSON.stringify({ ...target, metricName: 'unrelated.metric' }),
      JSON.stringify({ ...target, origin: 'https://production.example.invalid' }),
    ])
      expect(() => parseTarget(raw)).toThrow();
    expect(targetDigest(target)).toBe(
      targetDigest({
        ...target,
        parameters: Object.fromEntries(Object.entries(target.parameters).reverse()),
      }),
    );
    expect(targetDigest({ ...target, region: 'us-west-2' })).not.toBe(targetDigest(target));
  });
  it('requires exact main dispatch, not PR, push, arbitrary ref or a bare flag', () => {
    const env = {
      GITHUB_ACTIONS: 'true',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_SHA: 'a'.repeat(40),
      EXPECTED_SHA: 'a'.repeat(40),
    };
    expect(() => assertReleaseContext(env)).not.toThrow();
    for (const override of [
      { GITHUB_ACTIONS: 'false' },
      { GITHUB_EVENT_NAME: 'pull_request' },
      { GITHUB_EVENT_NAME: 'push' },
      { GITHUB_REF: 'refs/tags/fixture' },
      { EXPECTED_SHA: 'b'.repeat(40) },
    ])
      expect(() => assertReleaseContext({ ...env, ...override })).toThrow();
  });
  it('fails closed for absent protection, self-review, team-only or unrestricted branches', () => {
    const policy = {
      protection_rules: [
        { type: 'required_reviewers', prevent_self_review: true, reviewers: [{ type: 'User' }] },
      ],
      deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
    };
    expect(() => assertProtectedEnvironment(policy)).not.toThrow();
    for (const input of [
      undefined,
      {},
      { ...policy, protection_rules: [] },
      {
        ...policy,
        protection_rules: [
          { type: 'required_reviewers', prevent_self_review: false, reviewers: [{ type: 'User' }] },
        ],
      },
      {
        ...policy,
        protection_rules: [
          { type: 'required_reviewers', prevent_self_review: true, reviewers: [{ type: 'Team' }] },
        ],
      },
      {
        ...policy,
        deployment_branch_policy: { protected_branches: false, custom_branch_policies: false },
      },
    ])
      expect(() => assertProtectedEnvironment(input)).toThrow();
  });
  it('requires successful immutable same-repo main release provenance for rollback', () => {
    const artifact = {
      expired: false,
      name: 'release-candidate',
      digest: 'sha256:' + 'c'.repeat(64),
      workflow_run: { id: 42, head_sha: 'a'.repeat(40) },
    };
    const run = {
      id: 42,
      status: 'completed',
      conclusion: 'success',
      path: '.github/workflows/release.yml',
      head_branch: 'main',
      head_sha: 'a'.repeat(40),
      event: 'workflow_dispatch',
      repository: { full_name: 'fixture/service' },
    };
    expect(() => assertPreviousArtifact(artifact, run, 'fixture/service')).not.toThrow();
    for (const change of [
      { conclusion: 'failure' },
      { status: 'in_progress' },
      { path: '.github/workflows/ci.yml' },
      { head_branch: 'untrusted' },
      { head_sha: 'b'.repeat(40) },
      { repository: { full_name: 'fork/service' } },
    ])
      expect(() =>
        assertPreviousArtifact(artifact, { ...run, ...change }, 'fixture/service'),
      ).toThrow();
    expect(() =>
      assertPreviousArtifact({ ...artifact, expired: true }, run, 'fixture/service'),
    ).toThrow();
    expect(() =>
      assertPreviousArtifact({ ...artifact, digest: undefined }, run, 'fixture/service'),
    ).toThrow();
  });
  it('binds immutable payload bytes, source SHA and source run', () => {
    const manifest = payloadManifest(Buffer.from('reviewed artifact'), 'a'.repeat(40), '42');
    expect(manifest).toMatchObject({
      sourceSha: 'a'.repeat(40),
      sourceRun: '42',
      payloadSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(
      payloadManifest(Buffer.from('changed artifact'), 'a'.repeat(40), '42').payloadSha256,
    ).not.toBe(manifest.payloadSha256);
    expect(() => payloadManifest(Buffer.from(''), 'not-a-sha', '42')).toThrow();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  lstatSync: vi.fn().mockReturnValue({ isFile: () => true }),
  appendFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
}));
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { releaseControl, verifiedManifest } from '../../scripts/release-control.ts';
import { parameterNames, targetDigest, type ReleaseTarget } from '../../scripts/release-policy.ts';
const payload = Buffer.from('immutable reviewed fixture');
const sha = 'a'.repeat(40);
const manifest = {
  sourceSha: sha,
  sourceRun: '42',
  payloadSha256: createHash('sha256').update(payload).digest('hex'),
};
const config: ReleaseTarget = {
  account: '123456789012',
  region: 'us-east-1',
  roleArn: 'arn:aws:iam::123456789012:role/fixture',
  stack: 'UrlShortenerApi',
  runnerLabel: 'fixture-private',
  parameters: {
    ...Object.fromEntries(parameterNames.map((k) => [k, 'fixture'])),
    DomainLabel: 'stage',
    HostedZoneName: 'example.invalid',
  },
  origin: 'https://stage.example.invalid',
  logGroup: 'fixture',
  metricNamespace: 'Fixture',
  metricName: 'http.server.requests',
  metricDimensions: [],
};
const protection = {
  id: 7,
  protection_rules: [
    {
      type: 'required_reviewers',
      prevent_self_review: true,
      reviewers: [{ type: 'User', reviewer: { id: 123, type: 'User' } }],
    },
  ],
  deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
};
describe('release control authorization evidence', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('GITHUB_EVENT_NAME', 'workflow_dispatch');
    vi.stubEnv('GITHUB_REF', 'refs/heads/main');
    vi.stubEnv('GITHUB_SHA', sha);
    vi.stubEnv('EXPECTED_SHA', sha);
    vi.stubEnv('GITHUB_RUN_ID', '42');
    vi.stubEnv('GITHUB_RUN_ATTEMPT', '1');
    vi.stubEnv('ARTIFACT_SOURCE_SHA', sha);
    vi.stubEnv('ARTIFACT_SOURCE_RUN', '42');
    vi.stubEnv('GITHUB_REPOSITORY', 'fixture/service');
    vi.stubEnv('GITHUB_OUTPUT', 'fixture-output');
    vi.stubEnv('GITHUB_STEP_SUMMARY', 'fixture-summary');
    vi.stubEnv('RELEASE_TARGET', JSON.stringify(config));
    vi.stubEnv('EXPECTED_TARGET_DIGEST', targetDigest(config));
    vi.mocked(readFileSync).mockImplementation((path) =>
      String(path).endsWith('manifest.json') ? JSON.stringify(manifest) : payload,
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });
  it('does not replay prior run approvals after candidate regeneration', async () => {
    vi.stubEnv('GITHUB_RUN_ATTEMPT', '2');
    const api = vi.fn();
    await expect(releaseControl(['preflight'], api)).rejects.toThrow('replayed approvals');
    expect(api).not.toHaveBeenCalled();
  });
  it('authorizes only actual matching environment review evidence and binds payload/target/run', async () => {
    const api = vi
      .fn()
      .mockResolvedValueOnce(protection)
      .mockResolvedValueOnce([
        { state: 'approved', user: { id: 123, type: 'User' }, environments: [{ id: 7 }] },
      ]);
    await releaseControl(['authorize', 'production'], api);
    expect(api.mock.calls[1]?.[0]).toBe('actions/runs/42/approvals');
    expect(writeFileSync).toHaveBeenCalledWith(
      '.release-authorization.json',
      JSON.stringify({
        target: 'production',
        digest: targetDigest(config),
        run: '42',
        workflowSha: sha,
        payloadSha256: manifest.payloadSha256,
      }),
    );
    expect(appendFileSync).toHaveBeenCalledWith(
      'fixture-output',
      expect.stringContaining('role_arn='),
    );
  });
  it('rejects unavailable, rejected, bot, other reviewer and other environment approvals', async () => {
    for (const review of [
      [],
      [{ state: 'rejected', user: { id: 123, type: 'User' }, environments: [{ id: 7 }] }],
      [{ state: 'approved', user: { id: 123, type: 'Bot' }, environments: [{ id: 7 }] }],
      [{ state: 'approved', user: { id: 999, type: 'User' }, environments: [{ id: 7 }] }],
      [{ state: 'approved', user: { id: 123, type: 'User' }, environments: [{ id: 8 }] }],
    ]) {
      const api = vi.fn().mockResolvedValueOnce(protection).mockResolvedValueOnce(review);
      await expect(releaseControl(['authorize', 'production'], api)).rejects.toThrow(
        'human approval',
      );
    }
    expect(writeFileSync).not.toHaveBeenCalled();
  });
  it('rejects changed targets or changed immutable payload before credential outputs', async () => {
    vi.stubEnv('EXPECTED_TARGET_DIGEST', 'changed');
    const api = vi.fn();
    await expect(releaseControl(['authorize', 'production'], api)).rejects.toThrow(
      'Target changed',
    );
    expect(api).not.toHaveBeenCalled();
    vi.mocked(readFileSync).mockImplementation((path) =>
      String(path).endsWith('manifest.json') ? JSON.stringify(manifest) : Buffer.from('tampered'),
    );
    expect(() => verifiedManifest()).toThrow('digest mismatch');
    expect(writeFileSync).not.toHaveBeenCalled();
  });
  it('fails before environment references when owner configuration or read access is missing', async () => {
    const api = vi.fn();
    vi.stubEnv('RELEASE_STAGING_TARGET', '');
    await expect(releaseControl(['preflight'], api)).rejects.toThrow('unavailable');
    expect(api).not.toHaveBeenCalled();
    vi.stubEnv('RELEASE_STAGING_TARGET', JSON.stringify(config));
    const prod = {
      ...config,
      account: '999999999999',
      roleArn: 'arn:aws:iam::999999999999:role/fixture',
      origin: 'https://prod.example.invalid',
      parameters: { ...config.parameters, DomainLabel: 'prod' },
    };
    vi.stubEnv('RELEASE_PRODUCTION_TARGET', JSON.stringify(prod));
    api.mockRejectedValue(new Error('permission unavailable'));
    await expect(releaseControl(['preflight'], api)).rejects.toThrow('permission unavailable');
  });
  it('validates both existing environment policies and main protection', async () => {
    vi.stubEnv('RELEASE_STAGING_TARGET', JSON.stringify(config));
    vi.stubEnv(
      'RELEASE_PRODUCTION_TARGET',
      JSON.stringify({
        ...config,
        origin: 'https://prod.example.invalid',
        parameters: { ...config.parameters, DomainLabel: 'prod' },
        region: 'us-west-2',
      }),
    );
    const api = vi
      .fn()
      .mockResolvedValueOnce(protection)
      .mockResolvedValueOnce(protection)
      .mockResolvedValueOnce({ protected: true });
    await releaseControl(['preflight'], api);
    expect(api.mock.calls.map((call) => call[0])).toEqual([
      'environments/staging',
      'environments/production',
      'branches/main',
    ]);
    expect(appendFileSync).toHaveBeenCalledWith(
      'fixture-output',
      expect.stringContaining('staging_digest='),
    );
    expect(appendFileSync).toHaveBeenCalledWith(
      'fixture-output',
      expect.stringContaining('production_digest='),
    );
  });
});

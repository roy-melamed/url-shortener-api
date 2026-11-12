import { describe, expect, it, vi } from 'vitest';
import {
  executeOrderedPlan,
  executeRelease,
  observabilitySmoke,
  releasePlan,
} from '../../scripts/release-execute.ts';
import { type ReleaseTarget } from '../../scripts/release-policy.ts';
const fixture: ReleaseTarget = {
  account: '123456789012',
  region: 'us-east-1',
  roleArn: 'arn:aws:iam::123456789012:role/fixture',
  stack: 'UrlShortenerApi',
  runnerLabel: 'fixture-private',
  parameters: {},
  origin: 'https://stage.example.invalid',
  logGroup: 'fixture',
  metricNamespace: 'Fixture',
  metricName: 'http.server.requests',
  metricDimensions: [],
};
describe('release ordering and AC smoke failure paths', () => {
  it('prepares but does not switch traffic before forward migrations complete', async () => {
    const plan = releasePlan(fixture, 'release', 'release-fixture');
    expect(plan.map((step) => step.stage)).toEqual(['prepare', 'migrate', 'traffic', 'wait']);
    expect(plan[0]?.args).toContain('prepare-change-set');
    expect(plan[1]?.args).toContain('up');
    expect(plan[1]?.args).toContain('--check-order');
    expect(plan.some((step) => step.args.includes('down'))).toBe(false);
    const run = vi.fn().mockResolvedValue('');
    await executeOrderedPlan(plan, run);
    expect(run.mock.calls.map((call) => call[1])).toEqual(plan.map((step) => step.args));
  });
  it('never executes traffic switch after preparation or migration failure', async () => {
    const plan = releasePlan(fixture, 'release', 'release-fixture');
    for (const failure of [0, 1]) {
      let step = 0;
      const run = vi.fn(async () => {
        if (step++ === failure) throw new Error('fixture failure');
        return '';
      });
      await expect(executeOrderedPlan(plan, run)).rejects.toThrow('fixture failure');
      expect(run).toHaveBeenCalledTimes(failure + 1);
    }
  });
  it('rollback redeploys previous assembly without DB down/up and requires compatibility evidence', () => {
    expect(() => releasePlan(fixture, 'rollback', 'release-fixture')).toThrow(
      'compatibility evidence',
    );
    const plan = releasePlan(
      { ...fixture, rollbackCompatibilityEvidence: 'https://evidence.example.invalid/approved' },
      'rollback',
      'release-fixture',
    );
    expect(plan.map((step) => step.stage)).toEqual(['prepare', 'traffic', 'wait']);
    expect(plan.some((step) => step.args.includes('node-pg-migrate'))).toBe(false);
    expect(() => releasePlan(fixture, 'unknown', 'release-fixture')).toThrow();
  });
  it('cannot run a deployment from the local developer session', async () => {
    vi.stubEnv('GITHUB_ACTIONS', 'false');
    const run = vi.fn();
    await expect(executeRelease('staging', run)).rejects.toThrow('authorized workflow');
    expect(run).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
  it('requires real healthy HTTP plus correlated safe log, metric and trace data, not fixture booleans', async () => {
    const requestId = 'fixture-request';
    const traceId = 'a'.repeat(32);
    const log = {
      timestamp: new Date().toISOString(),
      level: 30,
      requestId,
      traceId,
      route: '/readyz',
      method: 'GET',
      status: 200,
      durationMs: 1,
      principal: { type: 'anonymous', id: null },
      outcome: {},
    };
    const fetcher = vi.fn().mockImplementation(async () => new Response('{}', { status: 200 }));
    const data = [
      JSON.stringify({ events: [{ message: JSON.stringify(log) }] }),
      JSON.stringify({ Datapoints: [{ Sum: 1 }] }),
      JSON.stringify({
        Traces: [{ Id: `1-${traceId.slice(0, 8)}-${traceId.slice(8)}`, Segments: [{}] }],
      }),
    ];
    const run = vi.fn();
    for (const value of data) run.mockResolvedValueOnce(value);
    await observabilitySmoke(fixture, run, fetcher, { requestId, start: new Date().toISOString() });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledTimes(3);
    const failures = [
      JSON.stringify({ events: [] }),
      JSON.stringify({
        events: [{ message: JSON.stringify({ ...log, clientIp: '198.51.100.1' }) }],
      }),
      JSON.stringify({
        events: [{ message: JSON.stringify({ ...log, traceId: '0'.repeat(32) }) }],
      }),
    ];
    for (const bad of failures)
      await expect(
        observabilitySmoke(fixture, vi.fn().mockResolvedValue(bad), fetcher, {
          requestId,
          start: new Date().toISOString(),
        }),
      ).rejects.toThrow();
    await expect(
      observabilitySmoke(
        fixture,
        vi.fn(),
        vi.fn().mockResolvedValue(new Response('', { status: 503 })),
      ),
    ).rejects.toThrow('health/readiness');
    const noMetric = vi
      .fn()
      .mockResolvedValueOnce(data[0])
      .mockResolvedValueOnce(JSON.stringify({ Datapoints: [] }));
    await expect(
      observabilitySmoke(fixture, noMetric, fetcher, {
        requestId,
        start: new Date().toISOString(),
      }),
    ).rejects.toThrow('metric');
    const noTrace = vi
      .fn()
      .mockResolvedValueOnce(data[0])
      .mockResolvedValueOnce(data[1])
      .mockResolvedValueOnce('{}');
    await expect(
      observabilitySmoke(fixture, noTrace, fetcher, { requestId, start: new Date().toISOString() }),
    ).rejects.toThrow('trace');
  });
});

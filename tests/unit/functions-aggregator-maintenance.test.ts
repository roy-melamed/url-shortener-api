/**
 * URL-19 handler wiring — the two non-HTTP entrypoints the CDK stack deploys.
 *
 * Job *logic* belongs to URL-14 (design §3.6 aggregation, §3.7 maintenance);
 * what URL-19 owns — and what is asserted here — is the contract the stack
 * wires against: the §3.7 job registry shared by the scheduler rules and the
 * local runner, and the fail-loud behaviour that keeps a not-yet-implemented
 * consumer visible instead of silently dropping or skipping work.
 */
import { describe, expect, it } from 'vitest';
import {
  AGGREGATOR_NOT_IMPLEMENTED_MESSAGE,
  handler as aggregatorHandler,
} from '../../src/functions/aggregator.ts';
import {
  MAINTENANCE_JOBS,
  handler as maintenanceHandler,
  isMaintenanceJob,
} from '../../src/functions/maintenance.ts';

describe('aggregatorFn entrypoint (design §3.6 — wiring by URL-19, logic by URL-14)', () => {
  it('never silently drops a batch: the stub rejects so SQS retries then parks it in the DLQ', async () => {
    await expect(aggregatorHandler({ Records: [] })).rejects.toThrow(
      AGGREGATOR_NOT_IMPLEMENTED_MESSAGE,
    );
  });

  it('names the owning ticket and the design section so the failure is actionable', () => {
    expect(AGGREGATOR_NOT_IMPLEMENTED_MESSAGE).toContain('URL-14');
    expect(AGGREGATOR_NOT_IMPLEMENTED_MESSAGE).toContain('§3.6');
  });
});

describe('maintenanceFn entrypoint (design §3.7 — scheduling by URL-19, logic by URL-14)', () => {
  it('pins exactly the five design §3.7 jobs', () => {
    expect([...MAINTENANCE_JOBS]).toEqual([
      'idempotency-gc',
      'dedup-gc',
      'aggregate-purge',
      'rate-limit-hygiene',
      'tombstone-audit',
    ]);
  });

  it('validates the job id — an unknown job fails loudly, never a silent no-op', async () => {
    await expect(maintenanceHandler({ job: 'not-a-job' })).rejects.toThrow(
      /unknown job "not-a-job"/,
    );
    await expect(maintenanceHandler({ job: 'not-a-job' })).rejects.toThrow(/idempotency-gc/);
  });

  it('fails loudly for a known job whose runner is not registered yet (URL-14)', async () => {
    await expect(maintenanceHandler({ job: 'dedup-gc' })).rejects.toThrow(
      /job "dedup-gc" has no runner yet/,
    );
  });

  it('exposes the registry guard the local invocation path relies on', () => {
    expect(isMaintenanceJob('rate-limit-hygiene')).toBe(true);
    expect(isMaintenanceJob('RateLimitHygiene')).toBe(false);
    expect(isMaintenanceJob(undefined)).toBe(false);
  });
});

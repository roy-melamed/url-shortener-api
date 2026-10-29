/**
 * `maintenanceFn` entrypoint — URL-19 (CDK infrastructure / wiring only).
 *
 * The URL-19 stack registers one EventBridge Scheduler rule per design §3.7 job
 * (4 daily + 1 hourly) and documents the local invocation path; the job
 * *logic* — what each purge/audit actually executes — is owned by URL-14
 * (backlog-audit F-13/F-23: URL-14 owns all `maintenanceFn` jobs).
 *
 * This file therefore owns two things that belong to the infrastructure ticket:
 *  1. the **job registry contract** — the single source of truth for the §3.7
 *     job ids, shared by the scheduler rules, the handler and the local runner
 *     (`npm run job:maintenance -- <job-id>`), and
 *  2. a **fail-loud dispatch seam** — an unknown or not-yet-registered job
 *     rejects instead of silently no-op'ing, so a misconfigured schedule is
 *     visible in logs/alarms rather than a quiet no-op.
 *
 * @see infra/lib/url-shortener-stack.ts for the scheduler rules.
 * @see scripts/run-maintenance-job.ts for the local invocation path.
 */

/** The five design §3.7 maintenance jobs. */
export const MAINTENANCE_JOBS = [
  'idempotency-gc',
  'dedup-gc',
  'aggregate-purge',
  'rate-limit-hygiene',
  'tombstone-audit',
] as const;

export type MaintenanceJob = (typeof MAINTENANCE_JOBS)[number];

/** Payload contract shared by the EventBridge Scheduler rules and local runs. */
export interface MaintenanceEvent {
  job: MaintenanceJob | string;
}

/** A single §3.7 job implementation (URL-14 registers the five runners). */
export type MaintenanceJobRunner = (event: MaintenanceEvent) => Promise<void>;

/**
 * Job registry — empty until URL-14 lands the §3.7 runners. Keeping the seam
 * here (rather than in the stack) means adding a job is a code change in one
 * place, and the scheduler rule id in the stack is derived from {@link MAINTENANCE_JOBS}.
 */
const runners: Partial<Record<MaintenanceJob, MaintenanceJobRunner>> = {
  // URL-14: idempotency-gc, dedup-gc, aggregate-purge, rate-limit-hygiene,
  // tombstone-audit — one runner per design §3.7 row.
};

export function isMaintenanceJob(value: unknown): value is MaintenanceJob {
  return typeof value === 'string' && (MAINTENANCE_JOBS as readonly string[]).includes(value);
}

/**
 * EventBridge Scheduler (and local-runner) entrypoint.
 *
 * @param event `{ job: <§3.7 job id> }` — injected by the stack's schedule
 *   target input, or by `scripts/run-maintenance-job.ts` locally.
 * @throws on an unknown job id, and on a known job whose runner has not been
 *   registered yet (URL-14) — never a silent no-op.
 */
export async function handler(event: MaintenanceEvent): Promise<void> {
  const job = event?.job;
  if (!isMaintenanceJob(job)) {
    throw new Error(
      `maintenanceFn: unknown job "${String(job)}". Known design §3.7 jobs: ${MAINTENANCE_JOBS.join(', ')}.`,
    );
  }
  const run = runners[job];
  if (!run) {
    throw new Error(
      `maintenanceFn: job "${job}" has no runner yet — the §3.7 job logic is owned by URL-14. ` +
        'URL-19 shipped the EventBridge Scheduler rules and the local invocation path only.',
    );
  }
  await run(event);
}

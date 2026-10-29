/**
 * Local `maintenanceFn` invocation path — URL-19 (backlog-audit F-14).
 *
 * Design §3.7 schedules five maintenance jobs in the cloud; FR-9.3/NFR-7
 * require the *same* code to run locally without Lambda/API Gateway emulation.
 * This runner is the documented local parity path: it loads the gitignored
 * `.env` (design §6.2) exactly like `src/index.ts`, then invokes the very same
 * `maintenanceFn` handler the EventBridge Scheduler rules invoke.
 *
 * Usage:
 *   npm run job:maintenance -- <job-id>
 *   npm run job:maintenance -- list
 *
 * with `<job-id>` one of design §3.7's jobs (`idempotency-gc`, `dedup-gc`,
 * `aggregate-purge`, `rate-limit-hygiene`, `tombstone-audit`).
 *
 * Local cron parity (same five jobs, no cloud involved):
 *   0 3 * * *   cd <repo> && npm run job:maintenance -- idempotency-gc
 *   0 3 * * *   cd <repo> && npm run job:maintenance -- dedup-gc
 *   0 3 * * *   cd <repo> && npm run job:maintenance -- aggregate-purge
 *   * * * * *   cd <repo> && npm run job:maintenance -- rate-limit-hygiene
 *   0 4 * * *   cd <repo> && npm run job:maintenance -- tombstone-audit
 *
 * The job *logic* is owned by URL-14; until a runner is registered the handler
 * rejects with a precise message (fail loud, never a silent no-op).
 */
import 'dotenv/config';
import { MAINTENANCE_JOBS, handler } from '../src/functions/maintenance.ts';

async function main(): Promise<void> {
  const job = process.argv[2];
  if (job === undefined || job === '' || job === 'list') {
    process.stdout.write(`available jobs (design §3.7): ${MAINTENANCE_JOBS.join(', ')}\n`);
    process.exit(job === undefined || job === '' ? 2 : 0);
  }

  // Same payload shape the EventBridge Scheduler rules inject (design §3.7).
  await handler({ job });
  process.stdout.write(`job "${job}" completed\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

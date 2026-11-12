import type { Pool, PoolClient } from 'pg';
import type { AppConfig } from './config.ts';
import { createPool } from './db.ts';

export type ReadinessCheck = () => Promise<boolean>;

/** Same configured pool/proxy seam as application data access. Never discloses
 * host, credentials or driver errors. The dedicated client has bounded acquire
 * and query timeouts; failures dispose it instead of returning a broken session. */
export function databaseReadiness(pool: Pick<Pool, 'connect'>): ReadinessCheck {
  return async () => {
    let client: PoolClient | undefined;
    let failed = false;
    try {
      client = await pool.connect();
      const query = { text: 'SELECT 1 AS ready', query_timeout: 1000 };
      const result = await client.query(query);
      return result.rows[0]?.ready === 1;
    } catch {
      failed = true;
      return false;
    } finally {
      client?.release(failed ? new Error('Readiness unavailable.') : undefined);
    }
  };
}

export function createReadiness(config: AppConfig): {
  check: ReadinessCheck;
  close: () => Promise<void>;
} {
  const pool = createPool(config);
  // pg discards broken idle clients before emitting this event. Avoid an
  // unhandled EventEmitter error; the next readiness query reports DB state.
  pool.on('error', () => {});
  return { check: databaseReadiness(pool), close: () => pool.end() };
}

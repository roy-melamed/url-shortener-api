/**
 * PostgreSQL connection layer — URL-8 (design §9.4, D-3/D-4).
 *
 * One pool abstraction is the seam between environments (design §9.4):
 *  - local dev connects DIRECTLY to the docker-compose Postgres;
 *  - deployed connects through AWS RDS Proxy (which multiplexes many Lambda
 *    invocations onto fewer DB connections and authenticates via Secrets
 *    Manager). The app only ever sees `config.database.url` — the RDS Proxy
 *    endpoint is injected there at deploy time; nothing is hardcoded here.
 *
 * Pool posture (design §9.4): intentionally tiny per-container pool
 * (`max` = 2, default from config) because hundreds of concurrent Lambdas each
 * hold a small pool and RDS Proxy multiplexes them; a large per-container pool
 * would exhaust RDS `max_connections`. `statement_timeout` (5s) and
 * `idleTimeoutMillis` (10s) bound runaway queries and idle churn. TLS is driven
 * by `DB_SSL_MODE` (`verify-full` in the cloud, per design §6.3).
 *
 * Everything here resolves from the validated {@link AppConfig}; no endpoint or
 * credential literal is committed (readiness-review bootstrap responsibility).
 */
import type { ConnectionOptions } from 'node:tls';
import { Pool, type PoolConfig } from 'pg';
import type { AppConfig } from './config.ts';

type SslMode = AppConfig['database']['sslMode'];

/**
 * Map the declarative `DB_SSL_MODE` to a `pg` SSL option (design §6.3).
 *
 * - `disable`      → no TLS (local compose Postgres).
 * - `require`      → encrypt, do not verify the cert chain/hostname.
 * - `verify-full`  → encrypt AND verify cert + hostname (cloud default; RDS
 *                    Proxy presents a cert signed by the RDS CA, which the
 *                    runtime trusts via the system/CA bundle).
 */
export function sslFromSslMode(mode: SslMode): ConnectionOptions | false {
  switch (mode) {
    case 'disable':
      return false;
    case 'require':
      return { rejectUnauthorized: false };
    case 'verify-full':
      return { rejectUnauthorized: true };
  }
}

/**
 * Build the `pg.Pool` options from validated config (design §9.4).
 *
 * Pure and injectable — unit-testable without opening a connection.
 */
export function buildPoolConfig(config: AppConfig): PoolConfig {
  const { url, poolMax, statementTimeoutMs, idleTimeoutMs, sslMode } = config.database;
  return {
    connectionString: url,
    max: poolMax,
    statement_timeout: statementTimeoutMs,
    idleTimeoutMillis: idleTimeoutMs,
    ssl: sslFromSslMode(sslMode),
    // Surface the workload for observability / RDS Proxy connection tagging.
    application_name: `url-shortener-api (${config.nodeEnv})`,
  };
}

/** Create a `pg.Pool` from validated config. Caller owns closing it. */
export function createPool(config: AppConfig): Pool {
  return new Pool(buildPoolConfig(config));
}

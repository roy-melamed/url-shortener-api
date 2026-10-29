import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/platform/config.ts';
import { buildPoolConfig, createPool, sslFromSslMode } from '../../src/platform/db.ts';

/**
 * Connection layer (design §9.4) — URL-8.
 *
 * `buildPoolConfig` is pure, so pool posture (tiny max, statement/idle
 * timeouts, TLS mode) is asserted without opening a connection.
 */

const baseEnv = { DATABASE_URL: 'postgres://user:pass@localhost:5432/urlshortener' };

describe('sslFromSslMode (design §6.3)', () => {
  it('maps disable → false', () => {
    expect(sslFromSslMode('disable')).toBe(false);
  });
  it('maps require → encrypt without verification', () => {
    expect(sslFromSslMode('require')).toEqual({ rejectUnauthorized: false });
  });
  it('maps verify-full → encrypt with cert + hostname verification', () => {
    expect(sslFromSslMode('verify-full')).toEqual({ rejectUnauthorized: true });
  });
});

describe('buildPoolConfig (design §9.4)', () => {
  it('builds a tiny per-container pool from config (max 2, 5s/10s timeouts)', () => {
    const cfg = loadConfig(baseEnv);
    const poolCfg = buildPoolConfig(cfg);
    expect(poolCfg.connectionString).toBe(baseEnv.DATABASE_URL);
    expect(poolCfg.max).toBe(2);
    expect(poolCfg.statement_timeout).toBe(5_000);
    expect(poolCfg.idleTimeoutMillis).toBe(10_000);
    expect(poolCfg.ssl).toBe(false);
  });

  it('honours an overridden pool size + TLS mode', () => {
    const cfg = loadConfig({ ...baseEnv, DB_POOL_MAX: '5', DB_SSL_MODE: 'verify-full' });
    const poolCfg = buildPoolConfig(cfg);
    expect(poolCfg.max).toBe(5);
    expect(poolCfg.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('sets an application_name for observability / proxy tagging', () => {
    const cfg = loadConfig(baseEnv);
    expect(buildPoolConfig(cfg).application_name).toContain('url-shortener-api');
  });

  it('never hardcodes the endpoint — it comes from config', () => {
    const custom = 'postgres://u:p@rds-proxy.internal:5432/db';
    const poolCfg = buildPoolConfig(loadConfig({ ...baseEnv, DATABASE_URL: custom }));
    expect(poolCfg.connectionString).toBe(custom);
  });
});

describe('createPool', () => {
  it('returns a pg Pool configured from config (no connection opened)', () => {
    const pool = createPool(loadConfig(baseEnv));
    expect(pool).toBeTruthy();
    expect(typeof pool.connect).toBe('function');
    expect(typeof pool.end).toBe('function');
  });
});

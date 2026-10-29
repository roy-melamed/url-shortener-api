import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/platform/config.ts';

const baseEnv = { DATABASE_URL: 'postgres://user:pass@localhost:5432/urlshortener' };

describe('loadConfig', () => {
  it('produces a working local config from minimal env (AC-FR-9.3 baseline)', () => {
    const config = loadConfig(baseEnv);
    expect(config.nodeEnv).toBe('development');
    expect(config.port).toBe(3000);
    expect(config.database.url).toBe(baseEnv.DATABASE_URL);
    // design §9.4: tiny per-container pool by default
    expect(config.database.poolMax).toBe(2);
    expect(config.database.statementTimeoutMs).toBe(5_000);
    expect(config.database.idleTimeoutMs).toBe(10_000);
    expect(config.captchaMode).toBe('suspicious');
  });

  it('defaults REDIRECT_STATUS to 302 (AD-1 / AC-FR-4.1)', () => {
    expect(loadConfig(baseEnv).redirectStatus).toBe(302);
  });

  it('requires DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });

  it('exposes a GEO_DB_PATH contract defaulting to empty (URL-7 compose)', () => {
    expect(loadConfig(baseEnv).geoDbPath).toBe('');
    expect(loadConfig({ ...baseEnv, GEO_DB_PATH: './data/geo/geo.db' }).geoDbPath).toBe(
      './data/geo/geo.db',
    );
  });

  it('rejects REDIRECT_STATUS values other than 301/302 outright', () => {
    expect(() => loadConfig({ ...baseEnv, REDIRECT_STATUS: '200' })).toThrow(ConfigError);
  });

  describe('REDIRECT_STATUS guard (F-24/X-11, D7 wording)', () => {
    it('blocks a non-302 value without the explicit override flag', () => {
      expect(() => loadConfig({ ...baseEnv, REDIRECT_STATUS: '301' })).toThrow(ConfigError);
      expect(() => loadConfig({ ...baseEnv, REDIRECT_STATUS: '301' })).toThrow(
        /fixed at\s+302 by AD-1\/AC-FR-4.1/,
      );
    });

    it('allows a non-302 value only with the override flag, and warns loudly', () => {
      const warnings: string[] = [];
      const config = loadConfig(
        { ...baseEnv, REDIRECT_STATUS: '301', REDIRECT_STATUS_ALLOW_NON_DEFAULT: 'true' },
        { warn: (message) => warnings.push(message) },
      );
      expect(config.redirectStatus).toBe(301);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/deviates from the fixed AD-1 default/);
    });

    it('does not warn for the default 302', () => {
      const warnings: string[] = [];
      loadConfig(baseEnv, { warn: (message) => warnings.push(message) });
      expect(warnings).toHaveLength(0);
    });
  });
});

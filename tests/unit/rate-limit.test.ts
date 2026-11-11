import { describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import {
  decideRateLimit,
  PostgresRateLimiter,
  READ_WINDOW_SQL,
  PURGE_EXPIRED_WINDOWS_SQL,
} from '../../src/abuse/rate-limit.ts';

const subject = 'user:00000000-0000-4000-8000-000000000001';
const start = new Date('2026-01-01T00:00:00Z');

describe('weighted sliding window (AC-FR-8.1/8.2, AD-7)', () => {
  it('admits exactly 100 at an empty minute, not the 101st', () => {
    for (let count = 0; count < 100; count++) {
      expect(
        decideRateLimit({ elapsedMs: 0, previousCount: 0, currentCount: count }),
      ).toMatchObject({ allowed: true, remaining: 99 - count, retryAfterSeconds: 0 });
    }
    expect(decideRateLimit({ elapsedMs: 0, previousCount: 0, currentCount: 100 })).toMatchObject({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 61,
    });
  });
  it('does not allow a fixed-window double burst across the minute boundary', () => {
    expect(decideRateLimit({ elapsedMs: 0, previousCount: 100, currentCount: 0 }).allowed).toBe(
      false,
    );
    expect(decideRateLimit({ elapsedMs: 599, previousCount: 100, currentCount: 0 }).allowed).toBe(
      false,
    );
    expect(decideRateLimit({ elapsedMs: 600, previousCount: 100, currentCount: 0 }).allowed).toBe(
      true,
    );
    expect(
      decideRateLimit({ elapsedMs: 30_000, previousCount: 100, currentCount: 49 }).allowed,
    ).toBe(true);
    expect(
      decideRateLimit({ elapsedMs: 30_000, previousCount: 100, currentCount: 50 }),
    ).toMatchObject({ allowed: false, retryAfterSeconds: 1 });
    expect(
      decideRateLimit({ elapsedMs: 59_999, previousCount: 100, currentCount: 99 }).allowed,
    ).toBe(false);
  });
  it('provides conservative full-reset seconds and excludes denied attempts', () => {
    expect(
      decideRateLimit({ elapsedMs: 30_000, previousCount: 0, currentCount: 0 }).resetAfterSeconds,
    ).toBe(90);
    expect(
      decideRateLimit({ elapsedMs: 59_999, previousCount: 0, currentCount: 100 }).retryAfterSeconds,
    ).toBe(1);
    const state = { elapsedMs: 400, previousCount: 100, currentCount: 0 };
    expect(decideRateLimit(state)).toEqual(decideRateLimit(state));
    expect(state.currentCount).toBe(0);
  });
  it.each([-1, NaN, Infinity, 0.5, 100_000])('rejects malformed state value %s', (bad) => {
    for (const field of ['elapsedMs', 'previousCount', 'currentCount']) {
      expect(() =>
        decideRateLimit({ elapsedMs: 0, previousCount: 0, currentCount: 0, [field]: bad }),
      ).toThrow('Rate limit state unavailable.');
    }
  });
  it('rejects a noncanonical elapsed minute and uses integer admission near boundaries', () => {
    expect(() =>
      decideRateLimit({ elapsedMs: 60_000, previousCount: 0, currentCount: 0 }),
    ).toThrow();
    for (let elapsedMs = 0; elapsedMs < 60_000; elapsedMs += 137) {
      const result = decideRateLimit({ elapsedMs, previousCount: 100, currentCount: 99 });
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    }
  });
});

function fixture(
  options: {
    denied?: boolean;
    missing?: boolean;
    invalidTime?: boolean;
    invalidCount?: boolean;
    fail?: string;
    failRollback?: boolean;
    missingUpdate?: boolean;
  } = {},
) {
  const query = vi.fn(async (sql: string) => {
    if (sql === options.fail || (sql === 'ROLLBACK' && options.failRollback))
      throw new Error('private-db-error');
    if (sql === READ_WINDOW_SQL)
      return {
        rows: options.missing
          ? []
          : [
              {
                window_start: options.invalidTime ? 'invalid' : start,
                prev_count: options.invalidCount ? -1 : 0,
                curr_count: options.denied ? 100 : 0,
                elapsed_ms: 0,
              },
            ],
      };
    return { rowCount: options.missingUpdate ? 0 : 1, rows: [] };
  });
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }) as unknown as PoolClient);
  return {
    limiter: new PostgresRateLimiter({ connect } as unknown as Pick<Pool, 'connect'>),
    query,
    release,
    connect,
  };
}

describe('PostgreSQL admission transaction', () => {
  it('serializes subject before DB clock/read, parameterizes identity, commits admission', async () => {
    const f = fixture();
    expect((await f.limiter.consume(subject)).allowed).toBe(true);
    expect(f.query.mock.calls.map((c) => c[0])).toEqual([
      'BEGIN ISOLATION LEVEL READ COMMITTED',
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      READ_WINDOW_SQL,
      expect.stringContaining('UPDATE rate_limit_windows'),
      'COMMIT',
    ]);
    expect(f.query.mock.calls[1]).toEqual([
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [subject],
    ]);
    expect(f.release).toHaveBeenCalledWith(undefined);
    expect(READ_WINDOW_SQL).toContain('clock_timestamp()');
    expect(PURGE_EXPIRED_WINDOWS_SQL).toContain("interval '1 minute'");
  });
  it('commits a denial without incrementing a counter', async () => {
    const f = fixture({ denied: true });
    expect((await f.limiter.consume(subject)).allowed).toBe(false);
    expect(f.query.mock.calls.some((c) => c[0].startsWith('UPDATE'))).toBe(false);
    expect(f.query).toHaveBeenLastCalledWith('COMMIT');
  });
  it.each([
    'anonymous',
    'apikey:raw-token',
    'user:email@example.invalid',
    'ip:127.0.0.1',
    '',
    'user:00000000-0000-4000-8000-00000000000A',
  ])('rejects noncanonical subject %s before connecting', async (bad) => {
    const f = fixture();
    await expect(f.limiter.consume(bad)).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
    expect(f.connect).not.toHaveBeenCalled();
  });
  it.each([
    { fail: 'BEGIN ISOLATION LEVEL READ COMMITTED' },
    { fail: READ_WINDOW_SQL },
    { fail: 'COMMIT' },
    { missing: true },
    { invalidTime: true },
    { invalidCount: true },
    { missingUpdate: true },
  ])('rolls back and redacts storage failure %#', async (options) => {
    const f = fixture(options);
    await expect(f.limiter.consume(subject)).rejects.toMatchObject({
      statusCode: 503,
      message: 'Rate limiter unavailable.',
    });
    expect(f.query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(f.release).toHaveBeenCalledOnce();
  });
  it('discards broken clients after failed rollback; redacts acquisition errors', async () => {
    const f = fixture({ fail: READ_WINDOW_SQL, failRollback: true });
    await expect(f.limiter.consume(subject)).rejects.toThrow('Rate limiter unavailable.');
    expect(f.release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    const limiter = new PostgresRateLimiter({
      connect: vi.fn().mockRejectedValue(new Error('secret-database-url')),
    } as unknown as Pick<Pool, 'connect'>);
    await expect(limiter.consume(subject)).rejects.toThrow('Rate limiter unavailable.');
  });
});

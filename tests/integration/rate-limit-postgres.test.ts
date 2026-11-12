/** Real PG16 SQL/locking tests. Only explicitly named loopback disposable test DB. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import {
  PostgresRateLimiter,
  READ_WINDOW_SQL,
  PURGE_EXPIRED_WINDOWS_SQL,
} from '../../src/abuse/rate-limit.ts';

const testUrl = process.env.TEST_RATE_LIMIT_DATABASE_URL;
const suite = testUrl ? describe : describe.skip;
const subject = 'user:00000000-0000-4000-8000-000000000001';
const other = 'apikey:00000000-0000-4000-8000-000000000001';
const minute = Date.parse('2026-01-01T00:00:00Z');
let now = minute;
let pool: Pool;
let admin: Pool;
const schema = `rate_limit_fixture_${randomUUID().replaceAll('-', '')}`;

/** Change ONLY the DB clock expression in the test transport, not SQL/locks. */
function fixedClockPool(): Pick<Pool, 'connect'> {
  const connect = async () => {
    const client = await pool.connect();
    return new Proxy(client, {
      get(target, key) {
        if (key === 'query')
          return (sql: string, values?: unknown[]) =>
            sql === READ_WINDOW_SQL
              ? target.query(
                  sql.replace('clock_timestamp()', 'to_timestamp($2::double precision / 1000)'),
                  [...(values ?? []), now],
                )
              : target.query(sql, values);
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as PoolClient;
  };
  return { connect } as unknown as Pick<Pool, 'connect'>;
}

suite('PostgreSQL weighted windows and concurrent admission', () => {
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (url.hostname !== '127.0.0.1' || url.pathname !== '/rate_limit_test') {
      throw new Error('Dedicated loopback rate_limit_test database required');
    }
    admin = new Pool({ connectionString: testUrl, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: testUrl, max: 12, options: `-c search_path=${schema}` });
    // Existing URL-8 schema unchanged; no production migration or public-schema reset.
    await pool.query(`CREATE TABLE rate_limit_windows (
      subject text NOT NULL, window_start timestamptz NOT NULL,
      prev_count integer NOT NULL DEFAULT 0, curr_count integer NOT NULL DEFAULT 0,
      PRIMARY KEY(subject, window_start))`);
  });
  beforeEach(async () => {
    now = minute;
    await pool.query('TRUNCATE rate_limit_windows');
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });
  it('admits exactly 100 of 160 simultaneous requests, denies without counter inflation', async () => {
    const limiter = new PostgresRateLimiter(fixedClockPool());
    const results = await Promise.all(Array.from({ length: 160 }, () => limiter.consume(subject)));
    expect(results.filter((r) => r.allowed)).toHaveLength(100);
    expect(results.filter((r) => !r.allowed)).toHaveLength(60);
    expect((await pool.query('SELECT curr_count FROM rate_limit_windows')).rows).toEqual([
      { curr_count: 100 },
    ]);
  });
  it('weights previous minutes, prevents 2x boundary burst and survives new limiter instances', async () => {
    const limiter = new PostgresRateLimiter(fixedClockPool());
    for (let i = 0; i < 100; i++) await limiter.consume(subject);
    now += 60_000;
    expect((await new PostgresRateLimiter(fixedClockPool()).consume(subject)).allowed).toBe(false);
    now += 600;
    expect((await limiter.consume(subject)).allowed).toBe(true);
    expect((await limiter.consume(subject)).allowed).toBe(false);
    now = minute + 120_000;
    expect((await limiter.consume(subject)).allowed).toBe(true);
    const rows = (
      await pool.query(
        'SELECT prev_count, curr_count FROM rate_limit_windows ORDER BY window_start',
      )
    ).rows;
    expect(rows).toEqual([
      { prev_count: 0, curr_count: 100 },
      { prev_count: 100, curr_count: 1 },
      { prev_count: 1, curr_count: 1 },
    ]);
  });
  it('isolates user/key namespaces and recovers after idle minutes', async () => {
    const limiter = new PostgresRateLimiter(fixedClockPool());
    for (let i = 0; i < 100; i++) await limiter.consume(subject);
    expect((await limiter.consume(other)).remaining).toBe(99);
    now += 180_000;
    expect((await limiter.consume(subject)).remaining).toBe(99);
  });
  it('executes the unmodified DB-clock query and fail-closes/rolls back corrupt rows', async () => {
    expect((await new PostgresRateLimiter(pool).consume(subject)).allowed).toBe(true);
    await pool.query('TRUNCATE rate_limit_windows');
    await pool.query('INSERT INTO rate_limit_windows VALUES($1, $2, 0, -1)', [
      subject,
      new Date(minute),
    ]);
    await expect(new PostgresRateLimiter(fixedClockPool()).consume(subject)).rejects.toMatchObject({
      statusCode: 503,
    });
    expect((await pool.query('SELECT curr_count FROM rate_limit_windows')).rows).toEqual([
      { curr_count: -1 },
    ]);
  });
  it('SQL hygiene handoff retains current/previous buckets and touches no other tables', async () => {
    await pool.query(
      `INSERT INTO rate_limit_windows
      SELECT $1, date_trunc('minute', clock_timestamp()) - n * interval '1 minute', 0, 1
      FROM generate_series(0, 3) n`,
      [subject],
    );
    const result = await pool.query(PURGE_EXPIRED_WINDOWS_SQL);
    expect(result.rowCount).toBe(2);
    expect(
      (await pool.query('SELECT count(*)::integer AS count FROM rate_limit_windows')).rows[0].count,
    ).toBe(2);
  });
});

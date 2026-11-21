import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildRuntimeApp } from '../../src/platform/http-runtime.ts';
import { runtimeFixtureEnvironment, runtimeFixtureTokens } from './http-runtime-environment.ts';

/** Uses the existing guarded/migrated PostgreSQL fixture, no alternate app wiring. */
export function registerHttpRuntimePostgresCases(getPool: () => Pool): void {
  describe('shipped runtime composition against disposable PostgreSQL', () => {
    const apps: FastifyInstance[] = [];
    beforeEach(async () => {
      await getPool().query('TRUNCATE idempotency_records');
    });
    afterEach(async () => {
      await Promise.all(apps.splice(0).map((app) => app.close()));
    });
    async function fixture(verified = true) {
      const pool = getPool(),
        owner = randomUUID(),
        now = new Date();
      const database = new URL(process.env.TEST_ACCOUNT_DATABASE_URL!);
      const schema = (await pool.query('SELECT current_schema() AS schema')).rows[0]
        .schema as string;
      if (
        database.hostname !== '127.0.0.1' ||
        database.pathname !== '/account_auth_test' ||
        !/^account_fixture_[0-9a-f]+$/.test(schema)
      )
        throw new Error('Dedicated runtime PostgreSQL fixture required.');
      database.searchParams.set('options', `-c search_path=${schema},public`);
      await pool.query('INSERT INTO users (id,email,email_verified_at) VALUES ($1,$2,$3)', [
        owner,
        `${owner}@example.invalid`,
        verified ? now : null,
      ]);
      const environment = runtimeFixtureEnvironment({ DATABASE_URL: database.toString() });
      const { app } = buildRuntimeApp(environment);
      apps.push(app);
      const jwt = await runtimeFixtureTokens.issue(owner, now);
      const headers = { authorization: `Bearer ${jwt}` };
      // The runtime also composes its existing JWT-only key-management dependency.
      const keyResponse = await app.inject({
        method: 'POST',
        url: '/v1/auth/api-keys',
        headers,
        payload: { name: 'runtime-fixture' },
      });
      expect(keyResponse.statusCode).toBe(201);
      const key = keyResponse.json().key as string;
      const post = (token: string, idempotency: string) =>
        app.inject({
          method: 'POST',
          url: '/v1/links',
          payload: { destinationUrl: 'https://destination.example.invalid/' },
          headers: {
            authorization: `Bearer ${token}`,
            'idempotency-key': idempotency,
            'x-request-id': 'runtime-postgres',
          },
        });
      const sizes = async () =>
        (
          await pool.query(
            'SELECT (SELECT count(*)::int FROM links) AS links, (SELECT count(*)::int FROM slug_reservations) AS reservations, (SELECT count(*)::int FROM idempotency_records) AS records',
          )
        ).rows[0];
      return { app, environment, jwt, key, owner, post, sizes, pool };
    }
    it.each(['jwt', 'apikey'] as const)(
      'uses real runtime %s auth/persistence and a shared process quota across runtime builds',
      async (kind) => {
        const f = await fixture(),
          token = kind === 'jwt' ? f.jwt : f.key;
        const first = await f.post(token, 'request-0');
        expect(first.statusCode).toBe(201);
        expect(first.json()).toMatchObject({
          shortUrl: `https://short.example.invalid/${first.json().slug}`,
          destinationUrl: 'https://destination.example.invalid/',
          expiresAt: null,
        });
        // Replay consumes another request but performs no duplicate domain write.
        expect((await f.post(token, 'request-0')).json()).toEqual(first.json());
        for (let i = 2; i < 100; i++)
          expect((await f.post(token, `request-${i}`)).statusCode).toBe(201);
        const before = await f.sizes();
        expect(before).toEqual({ links: 99, reservations: 99, records: 99 });
        const { app: second } = buildRuntimeApp(f.environment);
        apps.push(second);
        const denied = await second.inject({
          method: 'POST',
          url: '/v1/links',
          payload: { destinationUrl: 'https://denied.invalid/' },
          headers: {
            authorization: `Bearer ${token}`,
            'idempotency-key': 'denied',
            'x-request-id': 'runtime-denied',
          },
        });
        expect(denied.statusCode).toBe(429);
        expect(denied.json().error).toMatchObject({
          code: 'RATE_LIMITED',
          requestId: 'runtime-denied',
        });
        expect(denied.headers['ratelimit-limit']).toBe('100');
        expect(denied.headers['ratelimit-remaining']).toBe('0');
        expect(Number(denied.headers['retry-after'])).toBeGreaterThan(0);
        expect(await f.sizes()).toEqual(before);
        expect((await f.pool.query('SELECT DISTINCT user_id FROM links')).rows).toEqual([
          { user_id: f.owner },
        ]);
      },
      20_000,
    );
    it('preserves validation/auth/verified-owner gates with no link-domain writes in actual runtime composition', async () => {
      const f = await fixture(false);
      for (const token of [f.jwt, f.key])
        expect((await f.post(token, 'unverified')).statusCode).toBe(403);
      expect((await f.post('invalid', 'invalid')).statusCode).toBe(401);
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: '/v1/links',
            payload: { destinationUrl: 'https://destination.invalid/' },
          })
        ).statusCode,
      ).toBe(401);
      for (const payload of [
        { destinationUrl: 'https://destination.invalid/', userId: randomUUID() },
        { destinationUrl: 'https://destination.invalid/', slug: 'my-campaign' },
      ])
        expect(
          (
            await f.app.inject({
              method: 'POST',
              url: '/v1/links',
              payload,
              headers: { authorization: `Bearer ${f.jwt}` },
            })
          ).statusCode,
        ).toBe(400);
      expect(await f.sizes()).toEqual({ links: 0, reservations: 0, records: 0 });
    });
  });
}

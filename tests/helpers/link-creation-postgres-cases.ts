import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.ts';
import { loadConfig } from '../../src/platform/config.ts';
import { ApiKeys } from '../../src/auth/api-keys.ts';
import { JoseAccessTokens } from '../../src/auth/crypto.ts';
import { BearerAuthentication } from '../../src/auth/bearer-auth.ts';
import { PostgresApiKeyStore } from '../../src/auth/postgres-api-key-store.ts';
import { LinkCreation } from '../../src/links/create.ts';
import { PostgresLinkCreationStore } from '../../src/links/postgres-create-store.ts';
import { InProcessRequestLimiter } from '../../src/platform/request-limiter.ts';

/** Registered inside URL-9's existing guarded/migrated disposable PostgreSQL suite. */
export function registerLinkCreationPostgresCases(getPool: () => Pool): void {
  describe('real PostgreSQL authenticated create integration and failure recovery', () => {
    const apps: FastifyInstance[] = [];
    beforeEach(async () => {
      await getPool().query('TRUNCATE idempotency_records');
    });
    afterEach(async () => {
      await Promise.all(apps.splice(0).map((app) => app.close()));
    });
    async function fixture(verified = true) {
      const pool = getPool(),
        owner = randomUUID();
      let now = new Date('2026-11-20T12:00:00Z');
      await pool.query('INSERT INTO users (id, email, email_verified_at) VALUES ($1, $2, $3)', [
        owner,
        `${owner}@example.invalid`,
        verified ? now : null,
      ]);
      const apiKeys = new ApiKeys(new PostgresApiKeyStore(pool));
      const tokens = new JoseAccessTokens({
        ...generateKeyPairSync('rsa', { modulusLength: 2048 }),
        issuer: 'postgres-create-fixture',
        audience: 'postgres-create-fixture',
        kid: 'postgres-create-fixture',
      });
      const authentication = new BearerAuthentication({
        apiKeys,
        accessTokens: tokens,
        now: () => now,
      });
      const store = new PostgresLinkCreationStore(pool);
      const links = new LinkCreation({
        store,
        publicBaseUrl: 'https://short.example.invalid',
        now: () => now,
      });
      const limiter = new InProcessRequestLimiter({ now: () => 0 });
      const app = buildApp({
        config: loadConfig({ DATABASE_URL: 'fixture-only', LOG_LEVEL: 'silent' }),
        links,
        bearerAuth: { authentication, apiKeys },
        requestLimiter: limiter,
      });
      apps.push(app);
      const jwt = await tokens.issue(owner, now),
        key = await apiKeys.create(owner, { name: 'postgres-fixture' }, now);
      const post = (
        token = jwt,
        body = { destinationUrl: 'https://destination.example.invalid/' },
        idempotency = 'fixture-key',
      ) =>
        app.inject({
          method: 'POST',
          url: '/v1/links',
          payload: body,
          headers: {
            authorization: `Bearer ${token}`,
            'idempotency-key': idempotency,
            'x-request-id': 'postgres-create-request',
          },
        });
      const sizes = async () =>
        (
          await pool.query(
            'SELECT (SELECT count(*)::int FROM links) AS links, (SELECT count(*)::int FROM slug_reservations) AS reservations, (SELECT count(*)::int FROM idempotency_records) AS records',
          )
        ).rows[0];
      return {
        pool,
        app,
        owner,
        jwt,
        key,
        post,
        sizes,
        links,
        store,
        advance: (ms: number) => {
          now = new Date(now.getTime() + ms);
        },
      };
    }
    it.each(['jwt', 'apikey'] as const)(
      'proves real %s first 100/101 limiter boundary and no denied domain writes',
      async (kind) => {
        const f = await fixture();
        const token = kind === 'jwt' ? f.jwt : f.key.key;
        for (let i = 0; i < 100; i++)
          expect(
            (
              await f.post(
                token,
                { destinationUrl: 'https://destination.example.invalid/' },
                `request-${i}`,
              )
            ).statusCode,
          ).toBe(201);
        const before = await f.sizes();
        expect(before).toEqual({ links: 100, reservations: 100, records: 100 });
        const response = await f.post(
          token,
          { destinationUrl: 'https://denied.example.invalid/' },
          'denied',
        );
        expect(response.statusCode).toBe(429);
        expect(response.json().error).toMatchObject({
          code: 'RATE_LIMITED',
          requestId: 'postgres-create-request',
        });
        expect(response.headers).toMatchObject({
          'retry-after': '60',
          'ratelimit-limit': '100',
          'ratelimit-remaining': '0',
          'ratelimit-reset': '60',
        });
        expect(await f.sizes()).toEqual(before);
        expect((await f.pool.query('SELECT DISTINCT user_id FROM links')).rows).toEqual([
          { user_id: f.owner },
        ]);
      },
      20_000,
    );
    it('replays concurrent requests once, rejects hash mismatch, and preserves deleted-link tombstones', async () => {
      const f = await fixture();
      const raced = await Promise.all(Array.from({ length: 6 }, () => f.post()));
      // Under a loaded CI event loop a legitimate >100ms winner may produce
      // the specified in-flight result. Verify it, then replay after the batch.
      const responses = await Promise.all(
        raced.map(async (response) => {
          if (response.statusCode !== 409) return response;
          expect(response.json().error.code).toBe('IDEMPOTENCY_IN_PROGRESS');
          expect(response.headers['retry-after']).toBe('1');
          return f.post();
        }),
      );
      expect(responses.every((response) => response.statusCode === 201)).toBe(true);
      expect(new Set(responses.map((response) => response.body)).size).toBe(1);
      expect(await f.sizes()).toEqual({ links: 1, reservations: 1, records: 1 });
      const mismatch = await f.post(f.jwt, { destinationUrl: 'https://different.invalid/' });
      expect(mismatch.statusCode).toBe(409);
      expect(mismatch.json().error.code).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');
      const result = responses[0]!.json();
      await f.pool.query('DELETE FROM links WHERE id = $1', [result.id]);
      expect((await f.post()).json()).toEqual(result);
      const collision = await f.app.inject({
        method: 'POST',
        url: '/v1/links',
        payload: { destinationUrl: 'https://destination.invalid/', slug: result.slug },
        headers: { authorization: `Bearer ${f.jwt}`, 'idempotency-key': 'tombstone-collision' },
      });
      expect(collision.statusCode).toBe(409);
      expect(collision.json().error.suggestions).toHaveLength(3);
      for (const candidate of collision.json().error.suggestions)
        expect(await f.store.available(candidate)).toBe(true);
      expect(await f.sizes()).toEqual({ links: 0, reservations: 1, records: 1 });
    });
    it('returns bounded real lock-contention retry and cleanly creates after winner rollback', async () => {
      const f = await fixture(),
        blocker = await f.pool.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          "INSERT INTO idempotency_records (principal,key,request_hash,state,expires_at) VALUES ($1,'fixture-key','pending','completed',$2)",
          [`user:${f.owner}`, new Date('2026-11-21T12:00:00Z')],
        );
        const response = await f.post();
        expect(response.statusCode).toBe(409);
        expect(response.json().error.code).toBe('IDEMPOTENCY_IN_PROGRESS');
        expect(response.headers['retry-after']).toBe('1');
        expect(await f.sizes()).toEqual({ links: 0, reservations: 0, records: 0 });
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
      }
      expect((await f.post()).statusCode).toBe(201);
      expect(await f.sizes()).toEqual({ links: 1, reservations: 1, records: 1 });
    });
    it('rolls back an actual SIGKILL mid-handler and retries/replays with no orphan or stuck record', async () => {
      const f = await fixture();
      const schema = (await f.pool.query('SELECT current_schema() AS schema')).rows[0]
        .schema as string;
      const outcome = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
        checkpoint: boolean;
      }>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            '--experimental-strip-types',
            'tests/helpers/link-create-crash-child.ts',
            schema,
            f.owner,
          ],
          {
            cwd: process.cwd(),
            env: process.env,
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 10_000,
          },
        );
        let output = '';
        child.stdout!.on('data', (chunk: Buffer) => {
          output = (output + chunk.toString()).slice(-4096);
        });
        child.once('error', reject);
        child.once('close', (code, signal) =>
          resolve({ code, signal, checkpoint: output.includes('LINK_INSERTED_BEFORE_COMMIT') }),
        );
      });
      expect(outcome.signal).toBe('SIGKILL');
      expect(outcome.checkpoint).toBe(true);
      expect(await f.sizes()).toEqual({ links: 0, reservations: 0, records: 0 });
      const result = await f.post(
        f.jwt,
        { destinationUrl: 'https://destination.example.invalid/crash' },
        'crash-key',
      );
      expect(result.statusCode).toBe(201);
      expect(
        (
          await f.post(
            f.jwt,
            { destinationUrl: 'https://destination.example.invalid/crash' },
            'crash-key',
          )
        ).json(),
      ).toEqual(result.json());
      expect(await f.sizes()).toEqual({ links: 1, reservations: 1, records: 1 });
    }, 15_000);
    it('rejects unverified, malformed, unauthenticated and owner-override requests without domain writes', async () => {
      const f = await fixture(false);
      for (const token of [f.jwt, f.key.key]) expect((await f.post(token)).statusCode).toBe(403);
      expect((await f.post('invalid')).statusCode).toBe(401);
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: '/v1/links',
            payload: { destinationUrl: 'https://destination.invalid' },
          })
        ).statusCode,
      ).toBe(401);
      for (const body of [
        { destinationUrl: 'javascript:bad' },
        { destinationUrl: 'https://destination.invalid', userId: randomUUID() },
        { destinationUrl: 'https://destination.invalid', slug: 'my-campaign' },
      ])
        expect(
          (
            await f.app.inject({
              method: 'POST',
              url: '/v1/links',
              payload: body,
              headers: { authorization: `Bearer ${f.jwt}` },
            })
          ).statusCode,
        ).toBe(400);
      expect(await f.sizes()).toEqual({ links: 0, reservations: 0, records: 0 });
    });
    it('reuses an expired idempotency key at exactly 24h without altering old reservations', async () => {
      const f = await fixture();
      const context = { kind: 'user', userId: f.owner, subject: `user:${f.owner}` } as const;
      const input = { destinationUrl: 'https://destination.invalid' };
      const first = await f.links.create(context, input, 'ttl');
      f.advance(86_400_000);
      const next = await f.links.create(context, input, 'ttl');
      expect(next.id).not.toBe(first.id);
      expect(await f.sizes()).toEqual({ links: 2, reservations: 2, records: 1 });
    });
  });
}

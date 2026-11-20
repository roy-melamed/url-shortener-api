import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.ts';
import { loadConfig } from '../../src/platform/config.ts';
import { JoseAccessTokens } from '../../src/auth/crypto.ts';
import { ApiKeys } from '../../src/auth/api-keys.ts';
import { BearerAuthentication } from '../../src/auth/bearer-auth.ts';
import { InProcessRequestLimiter } from '../../src/platform/request-limiter.ts';
import { LinkCreation, IdempotencyBusy } from '../../src/links/create.ts';
import { MemoryApiKeyStore } from '../helpers/api-key-memory-store.ts';
import { MemoryLinkCreationStore } from '../helpers/link-creation-memory-store.ts';

const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const tokens = new JoseAccessTokens({
  ...rsa,
  issuer: 'create-fixture',
  audience: 'create-api',
  kid: 'create-key',
});
const config = loadConfig({ DATABASE_URL: 'fixture-only', LOG_LEVEL: 'silent' });
const input = { destinationUrl: 'https://destination.example.invalid/path' };
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function fixture(defaultLimiter = false) {
  let elapsed = 0;
  const wall = new Date('2026-11-20T12:00:00Z');
  const store = new MemoryLinkCreationStore();
  store.owners.set(owner, true);
  store.owners.set(other, true);
  const authStore = new MemoryApiKeyStore();
  authStore.users.add(owner);
  authStore.users.add(other);
  const apiKeys = new ApiKeys(authStore);
  const auth = new BearerAuthentication({ apiKeys, accessTokens: tokens, now: () => wall });
  const links = new LinkCreation({
    store,
    publicBaseUrl: 'https://short.example.invalid',
    now: () => new Date(wall.getTime() + elapsed),
  });
  const limiter = new InProcessRequestLimiter({ now: () => elapsed });
  const options = {
    config,
    links,
    bearerAuth: { authentication: auth, apiKeys },
    ...(defaultLimiter ? {} : { requestLimiter: limiter }),
  };
  const app = buildApp(options);
  apps.push(app);
  const jwt = await tokens.issue(owner, wall),
    otherJwt = await tokens.issue(other, wall);
  const key = await apiKeys.create(owner, { name: 'create-test' }, wall);
  const post = (token: string | null = jwt, payload: unknown = input, idempotency?: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/links',
      payload: payload as object,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(idempotency === undefined ? {} : { 'idempotency-key': idempotency }),
        'x-request-id': 'create-request',
      },
    });
  const sizes = () => [store.links.size, store.reservations.size, store.records.size];
  return {
    app,
    options,
    store,
    authStore,
    apiKeys,
    auth,
    links,
    limiter,
    jwt,
    otherJwt,
    key,
    post,
    sizes,
    advance: (ms: number) => {
      elapsed += ms;
    },
  };
}

describe('real authenticated POST /v1/links composition', () => {
  it('leaves health traffic unauthenticated and outside creation quota', async () => {
    const f = await fixture();
    const response = await f.app.inject({ url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['ratelimit-limit']).toBeUndefined();
    expect(f.limiter.trackedPrincipalCount).toBe(0);
    expect(f.sizes()).toEqual([0, 0, 0]);
  });
  it('rejects expired JWTs, revoked keys and deleted owners in the real route without writes', async () => {
    const f = await fixture();
    const expired = await tokens.issue(owner, new Date('2026-11-20T11:45:00Z'));
    expect((await f.post(expired, input, 'expired')).statusCode).toBe(401);
    await f.authStore.revoke(owner, f.key.id, new Date());
    expect((await f.post(f.key.key, input, 'revoked')).statusCode).toBe(401);
    f.authStore.users.delete(owner);
    expect((await f.post(f.jwt, input, 'deleted')).statusCode).toBe(401);
    expect(f.limiter.trackedPrincipalCount).toBe(0);
    expect(f.sizes()).toEqual([0, 0, 0]);
  });
  it('rejects duplicate idempotency headers and oversized bodies before authentication or writes', async () => {
    const f = await fixture();
    const response = await f.app.inject({
      method: 'POST',
      url: '/v1/links',
      payload: input,
      headers: {
        authorization: `Bearer ${f.jwt}`,
        'idempotency-key': ['one', 'two'] as unknown as string,
      },
    });
    expect(response.statusCode).toBe(400);
    const oversized = await f.app.inject({
      method: 'POST',
      url: '/v1/links',
      payload: { destinationUrl: 'x'.repeat(20_000) },
    });
    expect(oversized.statusCode).toBe(413);
    expect(f.sizes()).toEqual([0, 0, 0]);
    expect(f.limiter.trackedPrincipalCount).toBe(0);
  });
  it.each(['jwt', 'apikey'] as const)(
    'allows first 100 %s creates, denies 101st with no mutation, recovers at boundary',
    async (kind) => {
      const f = await fixture();
      const token = kind === 'jwt' ? f.jwt : f.key.key;
      for (let i = 0; i < 100; i++) {
        const response = await f.post(token, input, `request-${i}`);
        expect(response.statusCode).toBe(201);
        expect(response.headers['ratelimit-limit']).toBe('100');
        expect(response.headers['ratelimit-remaining']).toBe(String(99 - i));
        expect(response.json().slug).toMatch(/^[a-zA-Z0-9]{7}$/);
      }
      const snapshot = f.sizes();
      const denied = await f.post(token, input, 'denied-request');
      expect(denied.statusCode).toBe(429);
      expect(denied.json()).toEqual({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests. Retry after 60 seconds.',
          requestId: 'create-request',
        },
      });
      expect(denied.headers).toMatchObject({
        'retry-after': '60',
        'ratelimit-limit': '100',
        'ratelimit-remaining': '0',
        'ratelimit-reset': '60',
        'cache-control': 'no-store',
      });
      expect(f.sizes()).toEqual(snapshot);
      expect(
        [...f.store.records.values()].every(
          (record) => record.state === 'completed' && record.body !== null,
        ),
      ).toBe(true);
      f.advance(60_000);
      expect((await f.post(token, input, 'recovered-request')).statusCode).toBe(201);
    },
  );

  it('uses verified owner for writes and distinct quota subjects, never identity or Host headers', async () => {
    const f = await fixture();
    const secondKey = await f.apiKeys.create(owner, { name: 'second' }, new Date());
    for (let i = 0; i < 100; i++) await f.post(f.key.key, input, 'same-request');
    expect((await f.post(f.key.key)).statusCode).toBe(429);
    expect((await f.post(f.jwt)).headers['ratelimit-remaining']).toBe('99');
    expect((await f.post(secondKey.key)).headers['ratelimit-remaining']).toBe('99');
    expect((await f.post(f.otherJwt)).headers['ratelimit-remaining']).toBe('99');
    const response = await f.app.inject({
      method: 'POST',
      url: '/v1/links',
      payload: input,
      headers: {
        authorization: `Bearer ${f.jwt}`,
        host: 'attacker.invalid',
        'x-user-id': other,
        'x-principal': `user:${other}`,
        'x-test-principal': `user:${other}`,
        'x-forwarded-host': 'attacker.invalid',
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().shortUrl).toBe(`https://short.example.invalid/${response.json().slug}`);
    expect(f.store.links.get(response.json().id)!.userId).toBe(owner);
    const forged = await f.post(f.jwt, { ...input, userId: other });
    expect(forged.statusCode).toBe(400);
    const before = f.sizes();
    expect((await f.post(null)).statusCode).toBe(401);
    expect(f.sizes()).toEqual(before);
  });

  it('orders validation -> auth -> limiter -> verification -> domain writes', async () => {
    const f = await fixture();
    const events: string[] = [];
    vi.spyOn(f.limiter, 'consume').mockImplementationOnce(() => {
      events.push('limit');
      return {
        allowed: true,
        limit: 100,
        remaining: 99,
        retryAfterSeconds: 0,
        resetAfterSeconds: 60,
      };
    });
    const verify = f.store.verifiedOwner.bind(f.store);
    vi.spyOn(f.store, 'verifiedOwner').mockImplementation(async (id) => {
      events.push('verify');
      return verify(id);
    });
    const tx = f.store.transaction.bind(f.store);
    vi.spyOn(f.store, 'transaction').mockImplementation(async (work) => {
      events.push('transaction');
      return tx(work);
    });
    expect((await f.post(null, { destinationUrl: 'javascript:alert(1)' })).statusCode).toBe(400);
    expect((await f.post('invalid')).statusCode).toBe(401);
    expect(events).toEqual([]);
    expect((await f.post()).statusCode).toBe(201);
    expect(events[0]).toBe('limit');
    expect(events.indexOf('transaction')).toBeGreaterThan(events.indexOf('verify'));
  });

  it.each(['jwt', 'apikey'] as const)(
    'rejects unverified %s and enforces verification again at service boundary',
    async (kind) => {
      const f = await fixture();
      f.store.owners.set(owner, false);
      const response = await f.post(kind === 'jwt' ? f.jwt : f.key.key, input, 'never-claimed');
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('EMAIL_NOT_VERIFIED');
      expect(f.sizes()).toEqual([0, 0, 0]);
      expect(f.store.transactions).toBe(0);
      await expect(
        f.links.create({ kind: 'user', userId: owner, subject: `user:${owner}` }, input, 'direct'),
      ).rejects.toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
      expect(f.sizes()).toEqual([0, 0, 0]);
    },
  );

  it.each([null, 'bad', 'usk_bad'])(
    'rejects absent/invalid credentials %s without consumption or writes',
    async (token) => {
      const f = await fixture();
      expect((await f.post(token, input, 'unauthorized')).statusCode).toBe(401);
      expect(f.sizes()).toEqual([0, 0, 0]);
      expect(f.limiter.trackedPrincipalCount).toBe(0);
    },
  );

  it.each([
    {},
    { ...input, destinationUrl: 'data:text/plain,hello' },
    { ...input, destinationUrl: 'javascript:alert(1)' },
    { ...input, destinationUrl: 'https://' },
    { ...input, destinationUrl: 'x'.repeat(2049) },
    { ...input, slug: 'my-campaign' },
    { ...input, slug: 'ab' },
    { ...input, slug: 'a'.repeat(51) },
    { ...input, expiresAt: '2026-02-30T12:00:00Z' },
    { ...input, expiresAt: 'tomorrow' },
    { ...input, owner: other },
  ])('validates input %# without any domain mutation', async (payload) => {
    const f = await fixture();
    expect((await f.post(f.jwt, payload, 'invalid')).statusCode).toBe(400);
    expect(f.sizes()).toEqual([0, 0, 0]);
    expect(f.limiter.trackedPrincipalCount).toBe(0);
  });

  it('rejects past expiry and malformed idempotency headers, preserves response shape and custom slug', async () => {
    const f = await fixture();
    expect(
      (await f.post(f.jwt, { ...input, expiresAt: '2025-01-01T00:00:00Z' }, 'past')).statusCode,
    ).toBe(400);
    for (const key of ['', 'x'.repeat(256), 'contains space'])
      expect((await f.post(f.jwt, input, key)).statusCode).toBe(400);
    expect(f.sizes()).toEqual([0, 0, 0]);
    const response = await f.post(f.jwt, {
      ...input,
      slug: 'Custom123',
      expiresAt: '2026-11-21T12:00:00Z',
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      id: expect.any(String),
      slug: 'Custom123',
      shortUrl: 'https://short.example.invalid/Custom123',
      destinationUrl: input.destinationUrl,
      createdAt: '2026-11-20T12:00:00.000Z',
      expiresAt: '2026-11-21T12:00:00.000Z',
    });
  });

  it.each(['healthz', 'readyz', 'Taken123'])(
    'rejects reserved/tombstoned slug %s with exactly three checked suggestions and no new records',
    async (slug) => {
      const f = await fixture();
      f.store.reservations.add('Taken123');
      const before = f.sizes();
      const response = await f.post(f.jwt, { ...input, slug }, 'collision');
      expect(response.statusCode).toBe(409);
      const suggestions = response.json().error.suggestions;
      expect(suggestions).toHaveLength(3);
      expect(new Set(suggestions).size).toBe(3);
      for (const candidate of suggestions) expect(await f.store.available(candidate)).toBe(true);
      expect(f.sizes()).toEqual(before);
      expect(response.json().error.requestId).toBe('create-request');
    },
  );

  it('replays concurrent requests exactly, distinguishes payload mismatch and namespaces idempotency', async () => {
    const f = await fixture();
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => f.post(f.jwt, input, 'concurrent')),
    );
    expect(responses.every((response) => response.statusCode === 201)).toBe(true);
    expect(new Set(responses.map((response) => response.body)).size).toBe(1);
    expect(f.sizes()).toEqual([1, 1, 1]);
    const mismatch = await f.post(
      f.jwt,
      { destinationUrl: 'https://different.example.invalid/' },
      'concurrent',
    );
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error.code).toBe('IDEMPOTENCY_PAYLOAD_MISMATCH');
    expect(f.sizes()).toEqual([1, 1, 1]);
    expect((await f.post(f.key.key, input, 'concurrent')).statusCode).toBe(201);
    expect(f.sizes()).toEqual([2, 2, 2]);
  });

  it('supplies bounded in-flight retry guidance without domain mutation', async () => {
    const f = await fixture();
    vi.spyOn(f.store, 'transaction').mockRejectedValue(new IdempotencyBusy());
    const response = await f.post(f.jwt, input, 'busy');
    expect(response.statusCode).toBe(409);
    expect(response.headers['retry-after']).toBe('1');
    expect(response.json().error.code).toBe('IDEMPOTENCY_IN_PROGRESS');
    expect(f.sizes()).toEqual([0, 0, 0]);
  });

  it('shares the default process limiter across application construction, never per route/request', async () => {
    const f = await fixture(true);
    // A unique authenticated test owner avoids coupling with other quota tests.
    const id = randomUUID();
    f.authStore.users.add(id);
    f.store.owners.set(id, true);
    const jwt = await tokens.issue(id, new Date('2026-11-20T12:00:00Z'));
    const second = buildApp(f.options);
    apps.push(second);
    for (let i = 0; i < 100; i++)
      expect((await f.post(jwt, input, 'one-link')).statusCode).toBe(201);
    expect(
      (
        await second.inject({
          method: 'POST',
          url: '/v1/links',
          payload: input,
          headers: { authorization: `Bearer ${jwt}` },
        })
      ).statusCode,
    ).toBe(429);
    expect(f.sizes()).toEqual([1, 1, 1]);
  });
});

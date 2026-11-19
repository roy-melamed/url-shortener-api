import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.ts';
import { loadConfig } from '../../src/platform/config.ts';
import { createLogger } from '../../src/platform/logger.ts';
import { JoseAccessTokens } from '../../src/auth/crypto.ts';
import { ApiKeys } from '../../src/auth/api-keys.ts';
import { BearerAuthentication } from '../../src/auth/bearer-auth.ts';
import { MemoryApiKeyStore } from '../helpers/api-key-memory-store.ts';

const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const tokens = new JoseAccessTokens({
  ...keys,
  issuer: 'fixture-issuer',
  audience: 'fixture-audience',
  kid: 'fixture-kid',
});
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function fixture(chunks?: string[]) {
  let now = new Date('2026-11-19T12:00:00Z');
  const store = new MemoryApiKeyStore();
  store.users.add(owner);
  store.users.add(other);
  const apiKeys = new ApiKeys(store);
  const authentication = new BearerAuthentication({
    apiKeys,
    accessTokens: tokens,
    now: () => now,
  });
  const config = loadConfig({
    DATABASE_URL: 'fixture-only',
    LOG_LEVEL: chunks ? 'info' : 'silent',
  });
  const app = buildApp({
    config,
    ...(chunks
      ? {
          logger: createLogger(config, {
            destination: {
              write: (chunk: string) => {
                chunks.push(chunk);
              },
            },
          }),
        }
      : {}),
    bearerAuth: { authentication, apiKeys },
  });
  apps.push(app);
  const handler = vi.fn();
  app.get('/protected-fixture', { preHandler: authentication.authenticate }, async (request) => {
    handler();
    return authentication.principal(request);
  });
  const jwt = await tokens.issue(owner, now);
  const otherJwt = await tokens.issue(other, now);
  const headers = (token = jwt) => ({
    authorization: `Bearer ${token}`,
    'x-request-id': 'bearer-test',
  });
  const create = async (token = jwt, name = 'local key') =>
    app.inject({
      method: 'POST',
      url: '/v1/auth/api-keys',
      headers: headers(token),
      payload: { name },
    });
  return {
    app,
    store,
    apiKeys,
    authentication,
    jwt,
    otherJwt,
    headers,
    create,
    handler,
    now: () => now,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

describe('URL-9 JWT and API-key route authentication', () => {
  it('keeps raw keys, hashes and JWTs out of request/error logs', async () => {
    const chunks: string[] = [];
    const f = await fixture(chunks);
    const key = (await f.create()).json();
    const hash = f.store.keys.get(key.id)!.keyHash;
    await f.app.inject({ url: '/protected-fixture', headers: f.headers(key.key) });
    await f.app.inject({
      method: 'DELETE',
      url: `/v1/auth/api-keys/${key.id}`,
      headers: f.headers(),
    });
    await f.app.inject({ url: '/protected-fixture', headers: f.headers(key.key) });
    vi.spyOn(f.store, 'list').mockRejectedValue(new Error('fixture failure'));
    await f.app.inject({ url: '/v1/auth/api-keys', headers: f.headers() });
    const log = chunks.join('');
    expect(log).toContain('request completed');
    for (const secret of [key.key, hash, f.jwt]) expect(log).not.toContain(secret);
  });

  it('rejects anonymous key management without writes', async () => {
    const f = await fixture();
    for (const method of ['GET', 'POST', 'DELETE'] as const) {
      const response = await f.app.inject({
        method,
        url: method === 'DELETE' ? `/v1/auth/api-keys/${owner}` : '/v1/auth/api-keys',
        ...(method === 'POST' ? { payload: { name: 'anonymous' } } : {}),
      });
      expect(response.statusCode).toBe(401);
      expect(response.headers['cache-control']).toBe('no-store');
    }
    expect(f.store.keys.size).toBe(0);
  });
  it('creates with real URL-9 JWT, stores only hash, lists metadata and revokes owner-scoped key', async () => {
    const f = await fixture();
    const response = await f.create();
    expect(response.statusCode).toBe(201);
    expect(response.headers).toMatchObject({ 'cache-control': 'no-store', pragma: 'no-cache' });
    const created = response.json();
    expect(created.key).toMatch(/^usk_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
    const stored = f.store.keys.get(created.id)!;
    expect(stored.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(created.key);
    expect(created).not.toHaveProperty('keyHash');
    expect(created).not.toHaveProperty('userId');
    const list = await f.app.inject({ url: '/v1/auth/api-keys', headers: f.headers() });
    expect(list.json().keys).toHaveLength(1);
    expect(list.body).not.toContain(created.key);
    expect(list.body).not.toContain(stored.keyHash);
    expect(list.json().keys[0]).not.toHaveProperty('key');
    const foreignList = await f.app.inject({
      url: '/v1/auth/api-keys',
      headers: f.headers(f.otherJwt),
    });
    expect(foreignList.json()).toEqual({ keys: [] });
    const forbidden = await f.app.inject({
      method: 'DELETE',
      url: `/v1/auth/api-keys/${created.id}`,
      headers: f.headers(f.otherJwt),
    });
    expect(forbidden.statusCode).toBe(404);
    expect(stored.revokedAt).toBeNull();
    const revoke = () =>
      f.app.inject({
        method: 'DELETE',
        url: `/v1/auth/api-keys/${created.id}`,
        headers: f.headers(),
      });
    expect((await revoke()).statusCode).toBe(204);
    expect((await revoke()).statusCode).toBe(204);
    expect(stored.revokedAt).toEqual(f.now());
    expect(
      (await f.app.inject({ url: '/protected-fixture', headers: f.headers(created.key) }))
        .statusCode,
    ).toBe(401);
  });

  it('maps verified identities before handler work and ignores client identity selectors', async () => {
    const f = await fixture();
    const first = (await f.create()).json();
    const second = (await f.create()).json();
    const inject = (token: string) =>
      f.app.inject({
        url: '/protected-fixture',
        headers: {
          ...f.headers(token),
          'x-user-id': other,
          'x-principal': `user:${other}`,
          'x-test-principal': `apikey:${second.id}`,
        },
      });
    expect((await inject(f.jwt)).json()).toEqual({
      kind: 'user',
      userId: owner,
      subject: `user:${owner}`,
    });
    expect((await inject(first.key)).json()).toEqual({
      kind: 'apikey',
      userId: owner,
      keyId: first.id,
      subject: `apikey:${first.id}`,
    });
    expect((await inject(second.key)).json().subject).toBe(`apikey:${second.id}`);
    expect((await inject(f.otherJwt)).json().subject).toBe(`user:${other}`);
    expect((await inject(f.jwt)).json().subject).toBe(`user:${owner}`);
    expect(f.store.keys.get(first.id)!.lastUsedAt).toEqual(f.now());
    expect(f.handler).toHaveBeenCalledTimes(5);
  });

  it('requires JWT for all management operations, never allowing an API key to mint/revoke keys', async () => {
    const f = await fixture();
    const key = (await f.create()).json();
    expect((await f.create(key.key)).statusCode).toBe(401);
    for (const method of ['GET', 'DELETE'] as const) {
      const response = await f.app.inject({
        method,
        url: method === 'GET' ? '/v1/auth/api-keys' : `/v1/auth/api-keys/${key.id}`,
        headers: f.headers(key.key),
      });
      expect(response.statusCode).toBe(401);
      expect(response.headers['cache-control']).toBe('no-store');
    }
    expect(f.store.keys.size).toBe(1);
  });

  it.each([
    undefined,
    '',
    'Basic abc',
    'Bearer',
    'Bearer ',
    'Bearer a b',
    'Bearer a,b',
    'Bearer\tabc',
    'Bearer usk_bad',
    'Bearer nonsense',
    `Bearer ${'x'.repeat(8200)}`,
  ])('rejects missing/malformed credential %s before protected work', async (authorization) => {
    const f = await fixture();
    const response = await f.app.inject({
      url: '/protected-fixture',
      headers: {
        ...(authorization === undefined ? {} : { authorization }),
        'x-user-id': owner,
        'x-request-id': 'bearer-test',
      },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: { code: 'UNAUTHENTICATED', message: 'Invalid credentials.', requestId: 'bearer-test' },
    });
    expect(f.handler).not.toHaveBeenCalled();
  });

  it('rejects duplicate Authorization fields rather than choosing an identity', async () => {
    const f = await fixture();
    const response = await f.app.inject({
      url: '/protected-fixture',
      headers: { authorization: [`Bearer ${f.jwt}`, `Bearer ${f.otherJwt}`] as unknown as string },
    });
    expect(response.statusCode).toBe(401);
    expect(f.handler).not.toHaveBeenCalled();
  });

  it('rejects expired, tampered and deleted-owner JWTs', async () => {
    const f = await fixture();
    const tampered = f.jwt.slice(0, -10) + 'xxxxxxxxxx';
    expect(
      (await f.app.inject({ url: '/protected-fixture', headers: f.headers(tampered) })).statusCode,
    ).toBe(401);
    f.advance(900_000);
    expect(
      (await f.app.inject({ url: '/protected-fixture', headers: f.headers() })).statusCode,
    ).toBe(401);
    const fresh = await tokens.issue(owner, f.now());
    f.store.users.delete(owner);
    expect(
      (await f.app.inject({ url: '/protected-fixture', headers: f.headers(fresh) })).statusCode,
    ).toBe(401);
    expect(f.handler).not.toHaveBeenCalled();
  });

  it.each(['sub', 'iat', 'jti'])(
    'rejects signed JWT without required %s through the URL-9 verifier',
    async (missing) => {
      const f = await fixture();
      const seconds = Math.floor(f.now().getTime() / 1000);
      const payload: Record<string, unknown> = {
        sub: owner,
        iat: seconds,
        exp: seconds + 900,
        jti: randomUUID(),
        iss: 'fixture-issuer',
        aud: 'fixture-audience',
      };
      delete payload[missing];
      const jwt = await new SignJWT(payload)
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: 'fixture-kid' })
        .sign(keys.privateKey);
      expect(
        (await f.app.inject({ url: '/protected-fixture', headers: f.headers(jwt) })).statusCode,
      ).toBe(401);
      expect(f.handler).not.toHaveBeenCalled();
    },
  );

  it('rejects forged, unknown, noncanonical and deleted-owner API keys without leaking them', async () => {
    const f = await fixture();
    const key = (await f.create()).json();
    const candidates = [
      key.key.slice(0, 13) + 'A'.repeat(43),
      'usk_00000000_' + 'B'.repeat(42) + 'A',
      key.key + '=',
      key.key.slice(0, -1) + '!',
    ];
    for (const candidate of candidates) {
      const response = await f.app.inject({
        url: '/protected-fixture',
        headers: f.headers(candidate),
      });
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain(candidate);
    }
    f.store.users.delete(owner);
    expect(
      (await f.app.inject({ url: '/protected-fixture', headers: f.headers(key.key) })).statusCode,
    ).toBe(401);
    expect(f.handler).not.toHaveBeenCalled();
  });

  it('validates management bodies/ids only for JWT owners and never accepts owner overrides', async () => {
    const f = await fixture();
    for (const payload of [
      {},
      { name: '' },
      { name: ' '.repeat(3) },
      { name: 'x'.repeat(129) },
      { name: 'key', userId: other },
    ]) {
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: '/v1/auth/api-keys',
            headers: f.headers(),
            payload,
          })
        ).statusCode,
      ).toBe(400);
    }
    expect(
      (
        await f.app.inject({
          method: 'DELETE',
          url: '/v1/auth/api-keys/not-a-uuid',
          headers: f.headers(),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await f.app.inject({
          method: 'DELETE',
          url: `/v1/auth/api-keys/${randomUUID()}`,
          headers: f.headers(),
        })
      ).statusCode,
    ).toBe(404);
    expect(f.store.keys.size).toBe(0);
  });
});

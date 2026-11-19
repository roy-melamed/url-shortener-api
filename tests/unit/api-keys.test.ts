import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ApiKeys, isCanonicalUuid } from '../../src/auth/api-keys.ts';
import { BearerAuthentication } from '../../src/auth/bearer-auth.ts';
import { MemoryApiKeyStore } from '../helpers/api-key-memory-store.ts';
import type { FastifyRequest } from 'fastify';

const userId = '11111111-1111-4111-8111-111111111111';
const now = new Date('2026-11-19T12:00:00Z');
function setup() {
  const store = new MemoryApiKeyStore();
  store.users.add(userId);
  const keys = new ApiKeys(store);
  return { keys, store };
}
function request(token = 'fixture-jwt') {
  return {
    headers: { authorization: `Bearer ${token}` },
    raw: { rawHeaders: ['Authorization', `Bearer ${token}`] },
  } as FastifyRequest;
}

describe('API-key service', () => {
  it.each([undefined, 1, userId + '\n', 'AAAAAAAA-1111-4111-8111-111111111111', 'invalid'])(
    'does not canonicalize untrusted or malformed UUIDs %#',
    (value) => {
      expect(isCanonicalUuid(value)).toBe(false);
    },
  );
  it('hashes the full random key, exposes raw material only once and uses metadata allowlists', async () => {
    const { keys, store } = setup();
    const created = await keys.create(userId, { name: ' local ' }, now);
    const stored = store.keys.get(created.id)!;
    expect(stored.name).toBe('local');
    expect(stored.keyHash).toBe(createHash('sha256').update(created.key).digest('hex'));
    expect(Buffer.from(created.key.split('_').slice(2).join('_'), 'base64url')).toHaveLength(32);
    const verified = await keys.verify(created.key, now);
    expect(verified.id).toBe(created.id);
    expect(await keys.list(userId)).toEqual([
      {
        id: created.id,
        name: 'local',
        keyPrefix: stored.keyPrefix,
        createdAt: now,
        lastUsedAt: now,
        revokedAt: null,
      },
    ]);
    expect(JSON.stringify(await keys.list(userId))).not.toContain(created.key);
  });

  it('retries prefix collisions within a fixed bound without disclosing unpersisted keys', async () => {
    const { keys, store } = setup();
    const insert = vi.spyOn(store, 'insert').mockResolvedValue(false);
    await expect(keys.create(userId, { name: 'collision' }, now)).rejects.toMatchObject({
      statusCode: 503,
      message: 'API key service unavailable.',
    });
    expect(insert).toHaveBeenCalledTimes(5);
    insert.mockRestore();
    const first = vi.spyOn(store, 'insert').mockResolvedValueOnce(false);
    expect((await keys.create(userId, { name: 'recovered' }, now)).key).toMatch(/^usk_/);
    expect(first).toHaveBeenCalledTimes(2);
  });

  it.each([null, undefined, [], 'secret-input', { name: 1 }, { name: 'ok', owner: userId }])(
    'rejects invalid input %#',
    async (input) => {
      const { keys } = setup();
      await expect(keys.create(userId, input, now)).rejects.toMatchObject({ statusCode: 400 });
    },
  );

  it('rejects noncanonical secret encoding and unknown prefix before any usage write', async () => {
    const { keys, store } = setup();
    const use = vi.spyOn(store, 'use');
    for (const token of [
      'usk_00000000_' + 'A'.repeat(42) + 'B',
      'usk_00000000_' + 'A'.repeat(43),
    ]) {
      await expect(keys.verify(token, now)).rejects.toMatchObject({ statusCode: 401 });
    }
    expect(use).not.toHaveBeenCalled();
  });

  it('rechecks revocation after lookup and refuses malformed stored principal identifiers', async () => {
    const { keys, store } = setup();
    const created = await keys.create(userId, { name: 'race' }, now);
    vi.spyOn(store, 'use').mockResolvedValue(false);
    await expect(keys.verify(created.key, now)).rejects.toMatchObject({ statusCode: 401 });
    store.keys.get(created.id)!.id = 'bad';
    await expect(keys.verify(created.key, now)).rejects.toMatchObject({ statusCode: 401 });
    store.keys.get(created.id)!.id = created.id;
    store.keys.get(created.id)!.userId = 'bad';
    await expect(keys.verify(created.key, now)).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe('trusted bearer context', () => {
  it('freezes server-derived context, clears it on failed reauthentication and fails closed before resolution', async () => {
    const { keys } = setup();
    const auth = new BearerAuthentication({
      apiKeys: keys,
      accessTokens: { verify: async () => userId },
      now: () => now,
    });
    const req = request();
    expect(() => auth.principal(req)).toThrow('Invalid credentials.');
    await auth.authenticate(req);
    expect(Object.isFrozen(auth.principal(req))).toBe(true);
    req.headers.authorization = undefined;
    await expect(auth.authenticate(req)).rejects.toMatchObject({ statusCode: 401 });
    expect(() => auth.principal(req)).toThrow('Invalid credentials.');
  });

  it('fails closed for malformed verifier subjects and bad/throwing clocks', async () => {
    const { keys } = setup();
    const auth = new BearerAuthentication({
      apiKeys: keys,
      accessTokens: { verify: async () => 'INVALID' },
    });
    await expect(auth.authenticate(request())).rejects.toMatchObject({ statusCode: 401 });
    for (const clock of [
      () => new Date(NaN),
      () => {
        throw new Error('private-clock');
      },
    ]) {
      const auth = new BearerAuthentication({
        apiKeys: keys,
        accessTokens: { verify: async () => userId },
        now: clock,
      });
      await expect(auth.authenticate(request())).rejects.toMatchObject({
        statusCode: 503,
        message: 'Authentication unavailable.',
      });
    }
  });
});

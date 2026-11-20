import { describe, expect, it, vi } from 'vitest';
import { LinkCreation, generateSlug } from '../../src/links/create.ts';
import type { AuthenticatedPrincipal } from '../../src/auth/bearer-auth.ts';
import { MemoryLinkCreationStore } from '../helpers/link-creation-memory-store.ts';
import { buildApp } from '../../src/app.ts';
import { loadConfig } from '../../src/platform/config.ts';

const id = '11111111-1111-4111-8111-111111111111';
const principal = { kind: 'user', userId: id, subject: `user:${id}` } as const;
const input = { destinationUrl: 'https://destination.example.invalid/' };
function fixture(slug?: () => string) {
  let time = new Date('2026-11-20T12:00:00Z');
  const store = new MemoryLinkCreationStore();
  store.owners.set(id, true);
  const service = new LinkCreation({
    store,
    publicBaseUrl: 'https://short.example.invalid',
    now: () => time,
    slug,
  });
  return {
    store,
    service,
    advance: (ms: number) => {
      time = new Date(time.getTime() + ms);
    },
  };
}

describe('transactional link creation service', () => {
  it('uses the default wall clock without altering optional expiry and rejects terminal newline identities/keys', async () => {
    const f = fixture();
    const service = new LinkCreation({ store: f.store, publicBaseUrl: 'https://short.invalid' });
    expect((await service.create(principal, { ...input, expiresAt: null })).expiresAt).toBeNull();
    for (const body of [
      { ...input, slug: 'abcdefg\n' },
      { destinationUrl: 'https://exam\nple.invalid/' },
    ])
      expect(() => service.validate(body)).toThrow('Invalid link input.');
    for (const key of [123, ['duplicate'], 'terminal\n'])
      expect(() => service.validate(input, key)).toThrow('Invalid link input.');
  });
  it('uses unbiased cryptographic seven-character base62 generation', () => {
    const slugs = Array.from({ length: 200 }, generateSlug);
    expect(slugs.every((slug) => /^[a-zA-Z0-9]{7}$/.test(slug))).toBe(true);
    expect(new Set(slugs).size).toBe(200);
  });
  it.each(['reserve', 'insert', 'complete'] as const)(
    'rolls back injected failure after %s and cleanly retries/replays same key',
    async (fault) => {
      const f = fixture();
      f.store.fault = fault;
      await expect(f.service.create(principal, input, 'crash')).rejects.toThrow('Injected');
      expect([f.store.links.size, f.store.reservations.size, f.store.records.size]).toEqual([
        0, 0, 0,
      ]);
      f.store.fault = undefined;
      const result = await f.service.create(principal, input, 'crash');
      expect(await f.service.create(principal, input, 'crash')).toEqual(result);
      expect([f.store.links.size, f.store.reservations.size, f.store.records.size]).toEqual([
        1, 1, 1,
      ]);
    },
  );
  it('retries whole transaction on auto collision, with no orphaned idempotency or reservation state', async () => {
    const slug = vi.fn().mockReturnValueOnce('Taken12').mockReturnValue('NewOne1');
    const f = fixture(slug);
    f.store.reservations.add('Taken12');
    expect((await f.service.create(principal, input, 'retry')).slug).toBe('NewOne1');
    expect(f.store.transactions).toBe(2);
    expect(f.store.records.size).toBe(1);
    expect(f.store.links.size).toBe(1);
  });
  it('bounds automatic collision retries at eight and leaves no new state', async () => {
    const slug = vi.fn(() => 'Taken12');
    const f = fixture(slug);
    f.store.reservations.add('Taken12');
    await expect(f.service.create(principal, input, 'exhausted')).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(slug).toHaveBeenCalledTimes(8);
    expect(f.store.records.size).toBe(0);
    expect(f.store.links.size).toBe(0);
  });
  it('skips reserved automatic candidates and checks exactly three unique available alternatives', async () => {
    const next = vi
      .fn()
      .mockReturnValueOnce('healthz')
      .mockReturnValueOnce('NewOne1')
      .mockReturnValueOnce('Taken12')
      .mockReturnValueOnce('NewOne1')
      .mockReturnValueOnce('NewTwo2')
      .mockReturnValue('NewThr3');
    const f = fixture(next);
    expect((await f.service.create(principal, input)).slug).toBe('NewOne1');
    f.store.reservations.add('Taken12');
    next
      .mockReset()
      .mockReturnValueOnce('Taken12')
      .mockReturnValueOnce('NewTwo2')
      .mockReturnValueOnce('NewTwo2')
      .mockReturnValueOnce('NewThr3')
      .mockReturnValue('NewFor4');
    await expect(f.service.create(principal, { ...input, slug: 'Taken12' })).rejects.toMatchObject({
      suggestions: ['NewTwo2', 'NewThr3', 'NewFor4'],
    });
  });
  it('bounds suggestion search rather than returning unavailable or duplicate alternatives', async () => {
    const next = vi.fn(() => 'Taken12');
    const f = fixture(next);
    f.store.reservations.add('Taken12');
    await expect(
      f.service.create(principal, { ...input, slug: 'Taken12' }, 'collision'),
    ).rejects.toMatchObject({ statusCode: 503, message: 'Link suggestions unavailable.' });
    expect(next).toHaveBeenCalledTimes(24);
    expect(f.store.records.size).toBe(0);
  });
  it('expires idempotency after exactly 24h and scopes it by namespaced subject', async () => {
    const f = fixture();
    const first = await f.service.create(principal, input, 'ttl');
    f.advance(86_399_999);
    expect(await f.service.create(principal, input, 'ttl')).toEqual(first);
    f.advance(1);
    const second = await f.service.create(principal, input, 'ttl');
    expect(second.id).not.toBe(first.id);
    expect(f.store.links.size).toBe(2);
    expect(f.store.records.size).toBe(1);
  });
  it('replays an expired link snapshot within idempotency TTL, but rejects new past expiry without mutation', async () => {
    const f = fixture();
    const body = { ...input, expiresAt: '2026-11-20T12:00:01Z' };
    const original = await f.service.create(principal, body, 'expiry');
    f.advance(1_000);
    expect(await f.service.create(principal, body, 'expiry')).toEqual(original);
    await expect(f.service.create(principal, body, 'new')).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(
      f.service.create(
        principal,
        { ...body, destinationUrl: 'https://different.invalid' },
        'expiry',
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_PAYLOAD_MISMATCH' });
    expect(f.store.links.size).toBe(1);
  });
  it('handles legacy/incomplete or disappeared snapshots as in-flight, never as success', async () => {
    const f = fixture();
    await f.service.create(principal, input, 'incomplete');
    const record = f.store.records.get(`${principal.subject}|incomplete`)!;
    record.state = 'in_progress';
    await expect(f.service.create(principal, input, 'incomplete')).rejects.toMatchObject({
      code: 'IDEMPOTENCY_IN_PROGRESS',
    });
    record.state = 'completed';
    record.status = null;
    await expect(f.service.create(principal, input, 'incomplete')).rejects.toMatchObject({
      code: 'IDEMPOTENCY_IN_PROGRESS',
    });
    record.status = 201;
    record.body = null;
    await expect(f.service.create(principal, input, 'incomplete')).rejects.toMatchObject({
      code: 'IDEMPOTENCY_IN_PROGRESS',
    });
    vi.spyOn(f.store, 'replay').mockResolvedValue(null);
    await expect(f.service.create(principal, input, 'incomplete')).rejects.toMatchObject({
      code: 'IDEMPOTENCY_IN_PROGRESS',
    });
  });
  it('rejects deleted/unverified owners including a verification change at transaction entry', async () => {
    const f = fixture();
    f.store.owners.delete(id);
    await expect(f.service.create(principal, input)).rejects.toMatchObject({ statusCode: 401 });
    f.store.owners.set(id, true);
    vi.spyOn(f.store, 'verifiedOwner').mockResolvedValueOnce(true).mockResolvedValue(false);
    await expect(f.service.create(principal, input, 'race')).rejects.toMatchObject({
      code: 'EMAIL_NOT_VERIFIED',
    });
    expect(f.store.records.size).toBe(0);
  });
  it.each([
    { ...principal, userId: 'bad' },
    { ...principal, subject: `user:22222222-2222-4222-8222-222222222222` },
    { kind: 'apikey', userId: id, subject: `apikey:${id}`, keyId: 'bad' },
    { kind: 'apikey', userId: id, subject: `user:${id}`, keyId: id },
  ])('rejects inconsistent canonical context %#', async (context) => {
    const f = fixture();
    await expect(f.service.create(context as AuthenticatedPrincipal, input)).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(f.store.transactions).toBe(0);
  });
  it('rejects invalid clock, entropy and origin injection and missing trusted authentication composition', async () => {
    const f = fixture(() => 'bad!');
    await expect(f.service.create(principal, input)).rejects.toMatchObject({ statusCode: 503 });
    for (const now of [
      () => new Date(NaN),
      () => {
        throw new Error('private clock');
      },
    ])
      await expect(
        new LinkCreation({ store: f.store, publicBaseUrl: 'https://short.invalid', now }).create(
          principal,
          input,
        ),
      ).rejects.toMatchObject({ statusCode: 503 });
    for (const publicBaseUrl of [
      'ftp://short.invalid',
      'https://user:password@short.invalid',
      'https://short.invalid/path',
      'https://short.invalid?query',
      'https://short.invalid#hash',
    ])
      expect(() => new LinkCreation({ store: f.store, publicBaseUrl })).toThrow(
        'Invalid public link origin.',
      );
    expect(() =>
      buildApp({ config: loadConfig({ DATABASE_URL: 'fixture-only' }), links: f.service }),
    ).toThrow('Link creation requires trusted bearer authentication.');
  });
});

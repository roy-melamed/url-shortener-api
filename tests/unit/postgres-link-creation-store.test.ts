import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { PostgresLinkCreationStore } from '../../src/links/postgres-create-store.ts';
import { IdempotencyBusy, ReplayConflict, SlugCollision } from '../../src/links/create.ts';
import { AppError } from '../../src/platform/errors.ts';

const now = new Date('2026-11-20T12:00:00Z');
const claim = {
  subject: 'user:fixture',
  key: 'fixture-key',
  hash: 'fixture-hash',
  now,
  expiresAt: new Date(now.getTime() + 86_400_000),
};
const response = {
  id: 'link-id',
  slug: 'Fixture1',
  shortUrl: 'https://short.invalid/Fixture1',
  destinationUrl: 'https://destination.invalid',
  createdAt: now.toISOString(),
  expiresAt: null,
};
function fixture() {
  const query = vi
    .fn()
    .mockResolvedValue({ rows: [{ id: 'link-id', email_verified_at: now }], rowCount: 1 });
  const poolQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  const release = vi.fn();
  const connect = vi.fn().mockResolvedValue({ query, release } as unknown as PoolClient);
  const store = new PostgresLinkCreationStore({ connect, query: poolQuery } as unknown as Pick<
    Pool,
    'connect' | 'query'
  >);
  return { store, query, poolQuery, release, connect };
}
describe('PostgreSQL transactional link adapter', () => {
  it('performs parameterized ordered writes in exactly one transaction, only completed state', async () => {
    const f = fixture();
    await f.store.transaction(async (tx) => {
      expect(await tx.verifiedOwner('owner')).toBe(true);
      expect(await tx.claim(claim)).toBe(true);
      expect(await tx.reserve('Fixture1')).toBe(true);
      expect(await tx.insert('owner', 'Fixture1', response.destinationUrl, null, now)).toEqual({
        id: 'link-id',
        email_verified_at: now,
      });
      await tx.complete(claim.subject, claim.key, response);
    });
    const statements = f.query.mock.calls.map((call) => call[0]);
    expect(statements[0]).toBe('BEGIN ISOLATION LEVEL READ COMMITTED');
    expect(statements[1]).toContain('FOR SHARE');
    expect(
      statements.findIndex((sql) => sql.startsWith('INSERT INTO idempotency_records')),
    ).toBeLessThan(statements.findIndex((sql) => sql.startsWith('INSERT INTO slug_reservations')));
    expect(statements.at(-1)).toBe('COMMIT');
    expect(statements.join('\n')).not.toContain('in_progress');
    expect(f.query.mock.calls.find((call) => call[0].startsWith('INSERT INTO links'))![1]).toEqual([
      'owner',
      'Fixture1',
      response.destinationUrl,
      null,
      now,
    ]);
    expect(f.release).toHaveBeenCalledExactlyOnceWith(undefined);
  });
  it('returns availability, verified/unverified/missing owners and durable response snapshots', async () => {
    const f = fixture();
    expect(await f.store.available('Fixture1')).toBe(true);
    f.poolQuery.mockResolvedValue({ rows: [{ email_verified_at: null }], rowCount: 1 });
    expect(await f.store.verifiedOwner('owner')).toBe(false);
    expect(await f.store.available('taken')).toBe(false);
    f.poolQuery.mockResolvedValue({ rows: [{ email_verified_at: now }], rowCount: 1 });
    expect(await f.store.verifiedOwner('owner')).toBe(true);
    f.poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    expect(await f.store.verifiedOwner('missing')).toBeNull();
    expect(await f.store.replay(claim.subject, claim.key, now)).toBeNull();
    f.poolQuery.mockResolvedValue({
      rows: [{ hash: claim.hash, state: 'completed', status: 201, body: response }],
    });
    expect(await f.store.replay(claim.subject, claim.key, now)).toMatchObject({ body: response });
    expect(f.poolQuery.mock.lastCall![1]).toEqual([claim.subject, claim.key, now]);
  });
  it.each([
    new ReplayConflict(),
    new SlugCollision(),
    new IdempotencyBusy(),
    new AppError(403, 'EMAIL_NOT_VERIFIED', 'gate'),
  ])('rolls back before propagating typed service signals %#', async (error) => {
    const f = fixture();
    await expect(
      f.store.transaction(async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(f.query.mock.lastCall![0]).toBe('ROLLBACK');
    expect(f.release).toHaveBeenCalledTimes(1);
  });
  it('maps real claim lock timeout to retryable conflict and redacts other driver failures', async () => {
    const f = fixture();
    f.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('INSERT INTO idempotency_records'))
        throw { code: '55P03', detail: 'private sql' };
      return { rows: [], rowCount: 0 };
    });
    await expect(f.store.transaction((tx) => tx.claim(claim))).rejects.toMatchObject({
      code: 'IDEMPOTENCY_IN_PROGRESS',
      retryAfterSeconds: 1,
    });
    f.query.mockImplementation(async (sql: string) => {
      if (sql === 'COMMIT') throw new Error('private commit');
      return { rows: [], rowCount: 0 };
    });
    await expect(f.store.transaction(async () => 'result')).rejects.toMatchObject({
      statusCode: 503,
      message: 'Link store unavailable.',
    });
  });
  it('handles conflict/no-write outcomes and refuses incomplete driver writes', async () => {
    const f = fixture();
    f.query.mockResolvedValue({ rows: [], rowCount: 0 });
    await f.store.transaction(async (tx) => {
      expect(await tx.claim(claim)).toBe(false);
      expect(await tx.reserve('taken')).toBe(false);
      expect(await tx.verifiedOwner('missing')).toBeNull();
    });
    await expect(
      f.store.transaction((tx) =>
        tx.insert('owner', 'Fixture1', response.destinationUrl, null, now),
      ),
    ).rejects.toMatchObject({ statusCode: 503 });
    await expect(
      f.store.transaction((tx) => tx.complete(claim.subject, claim.key, response)),
    ).rejects.toMatchObject({ statusCode: 503 });
  });
  it('discards connections when rollback fails; connect/BEGIN/claim/read errors are redacted', async () => {
    const f = fixture();
    f.query.mockRejectedValue(new Error('private driver'));
    await expect(f.store.transaction((tx) => tx.claim(claim))).rejects.toMatchObject({
      message: 'Link store unavailable.',
    });
    expect(f.release.mock.lastCall![0]).toBeInstanceOf(Error);
    f.connect.mockRejectedValue(new Error('private connect'));
    await expect(f.store.transaction(async () => null)).rejects.toMatchObject({ statusCode: 503 });
    f.poolQuery.mockRejectedValue(new Error('private read'));
    for (const work of [
      () => f.store.verifiedOwner('owner'),
      () => f.store.available('slug'),
      () => f.store.replay(claim.subject, claim.key, now),
    ])
      await expect(work()).rejects.toMatchObject({ message: 'Link store unavailable.' });
    const g = fixture();
    g.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith('DELETE FROM')) throw new Error('private claim');
      return { rows: [], rowCount: 0 };
    });
    await expect(g.store.transaction((tx) => tx.claim(claim))).rejects.toMatchObject({
      statusCode: 503,
    });
  });
});

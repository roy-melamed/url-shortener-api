import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { PostgresApiKeyStore } from '../../src/auth/postgres-api-key-store.ts';
import type { ApiKeyRecord } from '../../src/auth/api-keys.ts';

const now = new Date('2026-11-19T12:00:00Z');
const record: ApiKeyRecord = {
  id: 'key-id',
  userId: 'owner-id',
  name: 'fixture',
  keyPrefix: 'aabbccdd',
  keyHash: 'a'.repeat(64),
  createdAt: now,
  lastUsedAt: null,
  revokedAt: null,
};
function fixture() {
  const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [record] });
  const store = new PostgresApiKeyStore({ query } as unknown as Pick<Pool, 'query'>);
  return { query, store };
}

describe('PostgreSQL API-key adapter', () => {
  it('is lazy and parameterizes all owner, prefix, revocation and usage operations', async () => {
    const { query, store } = fixture();
    expect(query).not.toHaveBeenCalled();
    expect(await store.accountExists(record.userId)).toBe(true);
    expect(query.mock.lastCall).toEqual(['SELECT id FROM users WHERE id = $1', [record.userId]]);
    expect(await store.insert(record)).toBe(true);
    expect(query.mock.lastCall![0]).toContain('ON CONFLICT (key_prefix) DO NOTHING');
    expect(query.mock.lastCall![1]).toEqual([
      record.id,
      record.userId,
      record.name,
      record.keyPrefix,
      record.keyHash,
      now,
    ]);
    expect(await store.list(record.userId)).toEqual([record]);
    expect(query.mock.lastCall![0]).toContain('WHERE user_id = $1 ORDER BY');
    expect(query.mock.lastCall![1]).toEqual([record.userId]);
    expect(await store.byPrefix(record.keyPrefix)).toEqual(record);
    expect(query.mock.lastCall![1]).toEqual([record.keyPrefix]);
    expect(await store.revoke(record.userId, record.id, now)).toBe(true);
    expect(query.mock.lastCall![0]).toContain('WHERE user_id = $1 AND id = $2');
    expect(query.mock.lastCall![1]).toEqual([record.userId, record.id, now]);
    expect(await store.use(record.id, now)).toBe(true);
    expect(query.mock.lastCall![0]).toContain('revoked_at IS NULL AND EXISTS (SELECT 1 FROM users');
    expect(query.mock.lastCall![1]).toEqual([record.id, now]);
  });

  it('returns absence/collision outcomes distinctly from store errors', async () => {
    const { store, query } = fixture();
    query.mockResolvedValue({ rowCount: 0, rows: [] });
    expect(await store.accountExists('absent')).toBe(false);
    expect(await store.insert(record)).toBe(false);
    expect(await store.list('absent')).toEqual([]);
    expect(await store.byPrefix('absent')).toBeNull();
    expect(await store.revoke('absent', 'id', now)).toBe(false);
    expect(await store.use('absent', now)).toBe(false);
  });

  it.each([new Error('SQL/private credential'), { code: '23503', detail: 'private FK' }, null])(
    'redacts every operation failure %#',
    async (error) => {
      const { store, query } = fixture();
      query.mockRejectedValue(error);
      for (const work of [
        () => store.accountExists('id'),
        () => store.insert(record),
        () => store.list('id'),
        () => store.byPrefix('secret'),
        () => store.revoke('owner', 'id', now),
        () => store.use('id', now),
      ]) {
        await expect(work()).rejects.toMatchObject({
          statusCode: 503,
          code: 'INTERNAL',
          message: 'API key store unavailable.',
        });
      }
    },
  );
});

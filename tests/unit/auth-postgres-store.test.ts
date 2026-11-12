import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { PostgresAccountStore } from '../../src/auth/postgres-store.ts';
import type {
  AccountTransaction,
  EmailTokenRecord,
  RefreshRecord,
} from '../../src/auth/contracts.ts';
import { AppError } from '../../src/platform/errors.ts';

const now = new Date('2026-11-12T12:00:00Z');
const user = {
  id: 'user-id',
  email: 'Example@domain.test',
  passwordHash: 'hash',
  emailVerifiedAt: now,
};
const emailToken: EmailTokenRecord = {
  id: 'email-id',
  userId: user.id,
  tokenHash: 'email-hash',
  purpose: 'verify',
  expiresAt: now,
  usedAt: null,
};
const refresh: RefreshRecord = {
  id: 'refresh-id',
  userId: user.id,
  tokenHash: 'refresh-hash',
  familyId: 'family-id',
  expiresAt: now,
  revokedAt: null,
};
const accountColumns =
  'id, email, password_hash AS "passwordHash", email_verified_at AS "emailVerifiedAt"';

function setup() {
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
  const release = vi.fn();
  const client = { query, release };
  const connect = vi.fn().mockResolvedValue(client as unknown as PoolClient);
  const poolQuery = vi.fn();
  const store = new PostgresAccountStore({ connect, query: poolQuery } as unknown as Pick<
    Pool,
    'connect' | 'query'
  >);
  return { store, query, release, connect, poolQuery };
}

const unavailable = { statusCode: 503, code: 'INTERNAL', message: 'Account store unavailable.' };

describe('PostgresAccountStore credentials', () => {
  it('is lazy and parameterizes CITEXT lookup, projecting only contract fields', async () => {
    const { store, poolQuery, connect } = setup();
    expect(connect).not.toHaveBeenCalled();
    expect(poolQuery).not.toHaveBeenCalled();
    poolQuery.mockResolvedValue({ rows: [{ ...user, privateField: 'not exposed' }] });
    expect(await store.credentials(user.email)).toEqual(user);
    expect(poolQuery).toHaveBeenCalledExactlyOnceWith(
      `SELECT ${accountColumns} FROM users WHERE email = $1`,
      [user.email],
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it('returns null for unknown accounts and retains nullable social-account fields', async () => {
    const { store, poolQuery } = setup();
    poolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ ...user, passwordHash: null, emailVerifiedAt: null }] });
    expect(await store.credentials('missing')).toBeNull();
    expect(await store.credentials(user.email)).toEqual({
      ...user,
      passwordHash: null,
      emailVerifiedAt: null,
    });
  });

  it.each([new Error('secret SQL'), null, undefined, 'private', 5, {}, { code: '08006' }])(
    'redacts raw credential failure %#',
    async (error) => {
      const { store, poolQuery } = setup();
      poolQuery.mockRejectedValue(error);
      await expect(store.credentials(user.email)).rejects.toMatchObject(unavailable);
    },
  );

  it('maps unique violations and safely handles hostile error properties', async () => {
    const { store, poolQuery } = setup();
    poolQuery.mockRejectedValueOnce({ code: '23505', detail: 'private' }).mockRejectedValueOnce({
      get code() {
        throw new Error('private');
      },
    });
    await expect(store.credentials(user.email)).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
      message: 'Account already exists.',
    });
    await expect(store.credentials(user.email)).rejects.toMatchObject(unavailable);
  });
});

describe('PostgresAccountStore transaction SQL', () => {
  it('uses one dedicated client, returns callback value, commits and releases', async () => {
    const { store, query, connect, poolQuery, release } = setup();
    const value = { done: true };
    expect(await store.transaction(async () => value)).toBe(value);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(query.mock.calls).toEqual([['BEGIN ISOLATION LEVEL READ COMMITTED'], ['COMMIT']]);
    expect(poolQuery).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it('creates accounts with database UUID defaults and locks users with aliased columns', async () => {
    const { store, query } = setup();
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ ...user, extra: true }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [user] })
      .mockResolvedValueOnce({ rows: [] });
    await store.transaction(async (tx) => {
      expect(await tx.createAccount(user.email, user.passwordHash)).toEqual(user);
      expect(await tx.lockAccount(user.id)).toEqual(user);
      expect(await tx.lockAccount('absent')).toBeNull();
    });
    expect(query.mock.calls.slice(1, 4)).toEqual([
      [
        `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING ${accountColumns}`,
        [user.email, user.passwordHash],
      ],
      [`SELECT ${accountColumns} FROM users WHERE id = $1 FOR UPDATE`, [user.id]],
      [`SELECT ${accountColumns} FROM users WHERE id = $1 FOR UPDATE`, ['absent']],
    ]);
  });

  it('reads token records with every alias, no token row locks, and null for missing records', async () => {
    const { store, query } = setup();
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [emailToken] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [refresh] })
      .mockResolvedValueOnce({ rows: [] });
    await store.transaction(async (tx) => {
      expect(await tx.emailToken(emailToken.id)).toEqual(emailToken);
      expect(await tx.emailToken('absent')).toBeNull();
      expect(await tx.refreshToken(refresh.id)).toEqual(refresh);
      expect(await tx.refreshToken('absent')).toBeNull();
    });
    const emailSql =
      'SELECT id, user_id AS "userId", token_hash AS "tokenHash", purpose, expires_at AS "expiresAt", used_at AS "usedAt" FROM email_tokens WHERE id = $1';
    const refreshSql =
      'SELECT id, user_id AS "userId", token_hash AS "tokenHash", family_id AS "familyId", expires_at AS "expiresAt", revoked_at AS "revokedAt" FROM refresh_tokens WHERE id = $1';
    expect(query.mock.calls.slice(1, 5)).toEqual([
      [emailSql, [emailToken.id]],
      [emailSql, ['absent']],
      [refreshSql, [refresh.id]],
      [refreshSql, ['absent']],
    ]);
  });

  it.each([null, now])('passes nullable token timestamps unchanged: %s', async (timestamp) => {
    const { store, query } = setup();
    await store.transaction(async (tx) => {
      await tx.insertEmailToken({ ...emailToken, usedAt: timestamp });
      await tx.insertRefresh({ ...refresh, revokedAt: timestamp });
    });
    expect(query.mock.calls.slice(1, 3)).toEqual([
      [
        'INSERT INTO email_tokens (id, user_id, token_hash, purpose, expires_at, used_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [emailToken.id, user.id, emailToken.tokenHash, emailToken.purpose, now, timestamp],
      ],
      [
        'INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at, revoked_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [refresh.id, user.id, refresh.tokenHash, refresh.familyId, now, timestamp],
      ],
    ]);
  });

  it('parameterizes all updates, preserves original verification/revocation time and deletes only users', async () => {
    const { store, query } = setup();
    await store.transaction(async (tx) => {
      await tx.useEmailToken(emailToken.id, now);
      await tx.verifyEmail(user.id, now);
      await tx.revokeRefresh(refresh.id, now);
      await tx.revokeFamily(refresh.familyId, now);
      await tx.deleteAccount(user.id);
    });
    expect(query.mock.calls.slice(1, -1)).toEqual([
      ['UPDATE email_tokens SET used_at = $2 WHERE id = $1', [emailToken.id, now]],
      [
        'UPDATE users SET email_verified_at = coalesce(email_verified_at, $2) WHERE id = $1',
        [user.id, now],
      ],
      [
        'UPDATE refresh_tokens SET revoked_at = coalesce(revoked_at, $2) WHERE id = $1',
        [refresh.id, now],
      ],
      [
        'UPDATE refresh_tokens SET revoked_at = coalesce(revoked_at, $2) WHERE family_id = $1',
        [refresh.familyId, now],
      ],
      ['DELETE FROM users WHERE id = $1', [user.id]],
    ]);
  });

  it('allows family revocation matching zero or multiple members', async () => {
    const { store, query } = setup();
    query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 3 });
    await store.transaction(async (tx) => {
      await tx.revokeFamily(refresh.familyId, now);
      await tx.revokeFamily(refresh.familyId, now);
    });
    expect(query).toHaveBeenLastCalledWith('COMMIT');
  });
});

const writes: [string, (tx: AccountTransaction) => Promise<unknown>][] = [
  ['createAccount', (tx) => tx.createAccount(user.email, user.passwordHash)],
  ['insertEmailToken', (tx) => tx.insertEmailToken(emailToken)],
  ['useEmailToken', (tx) => tx.useEmailToken(emailToken.id, now)],
  ['verifyEmail', (tx) => tx.verifyEmail(user.id, now)],
  ['insertRefresh', (tx) => tx.insertRefresh(refresh)],
  ['revokeRefresh', (tx) => tx.revokeRefresh(refresh.id, now)],
  ['deleteAccount', (tx) => tx.deleteAccount(user.id)],
];

describe('PostgresAccountStore failures', () => {
  it.each(writes)('rejects unexpected row counts for %s', async (_name, write) => {
    for (const rowCount of [0, null, 2]) {
      const { store, query, release } = setup();
      query.mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [user], rowCount });
      await expect(store.transaction(write)).rejects.toMatchObject(unavailable);
      expect(query).toHaveBeenLastCalledWith('ROLLBACK');
      expect(release).toHaveBeenCalledExactlyOnceWith(undefined);
    }
  });

  it('rejects a missing created account even when rowCount claims success', async () => {
    const { store, query } = setup();
    query.mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await expect(
      store.transaction((tx) => tx.createAccount(user.email, user.passwordHash)),
    ).rejects.toMatchObject(unavailable);
  });

  it.each([
    new Error('private connection'),
    { code: '23505' },
    new AppError(409, 'CONFLICT', 'private'),
  ])('always redacts acquisition failure %# without work or release', async (error) => {
    const { store, connect, query, release } = setup();
    connect.mockRejectedValue(error);
    const work = vi.fn();
    await expect(store.transaction(work)).rejects.toMatchObject(unavailable);
    expect(work).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it.each(['begin', 'work', 'commit'])('rolls back and redacts %s failures', async (phase) => {
    const { store, query, release } = setup();
    const error = new Error('SQL password token');
    if (phase === 'begin') query.mockRejectedValueOnce(error);
    if (phase === 'commit') query.mockResolvedValueOnce({}).mockRejectedValueOnce(error);
    const work = vi.fn(async () => {
      if (phase === 'work') throw error;
    });
    await expect(store.transaction(work)).rejects.toMatchObject(unavailable);
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(work).toHaveBeenCalledTimes(phase === 'begin' ? 0 : 1);
    expect(release).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it('maps database uniqueness failures and preserves domain AppError identity', async () => {
    const { store, query } = setup();
    query
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce({ code: '23505', detail: 'private email' });
    await expect(
      store.transaction((tx) => tx.createAccount(user.email, user.passwordHash)),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
      message: 'Account already exists.',
    });
    const domainError = new AppError(401, 'UNAUTHENTICATED', 'Authentication required.');
    await expect(
      store.transaction(async () => {
        throw domainError;
      }),
    ).rejects.toBe(domainError);
  });

  it('destroys the client with a fixed error after rollback failure, preserving the original AppError', async () => {
    const { store, query, release } = setup();
    query.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('private rollback failure'));
    const domainError = new AppError(403, 'FORBIDDEN', 'Forbidden.');
    await expect(
      store.transaction(async () => {
        throw domainError;
      }),
    ).rejects.toBe(domainError);
    expect(release).toHaveBeenCalledExactlyOnceWith(new Error('Account store unavailable.'));
    expect(release.mock.calls[0]?.[0]).not.toHaveProperty('cause');
    expect(query.mock.calls).toEqual([['BEGIN ISOLATION LEVEL READ COMMITTED'], ['ROLLBACK']]);
  });
});

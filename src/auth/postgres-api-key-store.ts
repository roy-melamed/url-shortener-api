import type { Pool } from 'pg';
import { AppError } from '../platform/errors.ts';
import type { ApiKeyRecord, ApiKeyStore } from './api-keys.ts';

const columns =
  'id, user_id AS "userId", name, key_prefix AS "keyPrefix", key_hash AS "keyHash", created_at AS "createdAt", last_used_at AS "lastUsedAt", revoked_at AS "revokedAt"';

/** Parameterized queries against the existing schema. Driver errors stay private. */
export class PostgresApiKeyStore implements ApiKeyStore {
  private readonly pool: Pick<Pool, 'query'>;
  constructor(pool: Pick<Pool, 'query'>) {
    this.pool = pool;
  }

  private async safe<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch {
      throw new AppError(503, 'INTERNAL', 'API key store unavailable.');
    }
  }

  accountExists(userId: string): Promise<boolean> {
    return this.safe(
      async () =>
        (await this.pool.query('SELECT id FROM users WHERE id = $1', [userId])).rowCount === 1,
    );
  }

  insert(record: ApiKeyRecord): Promise<boolean> {
    return this.safe(async () => {
      const result = await this.pool.query(
        'INSERT INTO api_keys (id, user_id, name, key_prefix, key_hash, created_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (key_prefix) DO NOTHING RETURNING id',
        [record.id, record.userId, record.name, record.keyPrefix, record.keyHash, record.createdAt],
      );
      return result.rowCount === 1;
    });
  }

  list(userId: string): Promise<ApiKeyRecord[]> {
    return this.safe(
      async () =>
        (
          await this.pool.query<ApiKeyRecord>(
            `SELECT ${columns} FROM api_keys WHERE user_id = $1 ORDER BY created_at, id`,
            [userId],
          )
        ).rows,
    );
  }

  revoke(userId: string, id: string, now: Date): Promise<boolean> {
    return this.safe(
      async () =>
        (
          await this.pool.query(
            'UPDATE api_keys SET revoked_at = coalesce(revoked_at, $3) WHERE user_id = $1 AND id = $2 RETURNING id',
            [userId, id, now],
          )
        ).rowCount === 1,
    );
  }

  byPrefix(prefix: string): Promise<ApiKeyRecord | null> {
    return this.safe(
      async () =>
        (
          await this.pool.query<ApiKeyRecord>(
            `SELECT ${columns} FROM api_keys WHERE key_prefix = $1`,
            [prefix],
          )
        ).rows[0] ?? null,
    );
  }

  use(id: string, now: Date): Promise<boolean> {
    return this.safe(
      async () =>
        (
          await this.pool.query(
            'UPDATE api_keys SET last_used_at = $2 WHERE id = $1 AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM users WHERE users.id = api_keys.user_id) RETURNING id',
            [id, now],
          )
        ).rowCount === 1,
    );
  }
}

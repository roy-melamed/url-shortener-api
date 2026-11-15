import type { Pool, PoolClient } from 'pg';
import { AppError } from '../platform/errors.ts';
import type {
  Account,
  AccountStore,
  AccountTransaction,
  EmailTokenRecord,
  RefreshRecord,
} from './contracts.ts';

const accountColumns =
  'id, email, password_hash AS "passwordHash", email_verified_at AS "emailVerifiedAt"';
const unavailableMessage = 'Account store unavailable.';

function unavailable(): AppError {
  return new AppError(503, 'INTERNAL', unavailableMessage);
}

/** Never retain database messages, SQL, parameters or driver error causes. */
function redactError(error: unknown): AppError {
  try {
    if (error instanceof AppError) return error;
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
      return new AppError(409, 'CONFLICT', 'Account already exists.');
    }
  } catch {
    // Even a malformed thrown object's property access must remain redacted.
  }
  return unavailable();
}

function account(row: Account | undefined): Account | null {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.passwordHash,
    emailVerifiedAt: row.emailVerifiedAt,
  };
}

class PostgresAccountTransaction implements AccountTransaction {
  private readonly client: PoolClient;

  constructor(client: PoolClient) {
    this.client = client;
  }

  private async write(sql: string, parameters: unknown[]): Promise<void> {
    const result = await this.client.query(sql, parameters);
    if (result.rowCount !== 1) throw unavailable();
  }

  async createAccount(email: string, passwordHash: string): Promise<Account> {
    const result = await this.client.query<Account>(
      `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING ${accountColumns}`,
      [email, passwordHash],
    );
    const created = account(result.rows[0]);
    if (result.rowCount !== 1 || !created) throw unavailable();
    return created;
  }

  async lockAccount(id: string): Promise<Account | null> {
    const result = await this.client.query<Account>(
      `SELECT ${accountColumns} FROM users WHERE id = $1 FOR UPDATE`,
      [id],
    );
    return account(result.rows[0]);
  }

  async insertEmailToken(record: EmailTokenRecord): Promise<void> {
    await this.write(
      'INSERT INTO email_tokens (id, user_id, token_hash, purpose, expires_at, used_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [record.id, record.userId, record.tokenHash, record.purpose, record.expiresAt, record.usedAt],
    );
  }

  async emailToken(id: string): Promise<EmailTokenRecord | null> {
    // The service locks the owning user and re-reads; a token lock here can deadlock.
    const result = await this.client.query<EmailTokenRecord>(
      'SELECT id, user_id AS "userId", token_hash AS "tokenHash", purpose, expires_at AS "expiresAt", used_at AS "usedAt" FROM email_tokens WHERE id = $1',
      [id],
    );
    return result.rows[0] ?? null;
  }

  async useEmailToken(id: string, now: Date): Promise<void> {
    await this.write('UPDATE email_tokens SET used_at = $2 WHERE id = $1', [id, now]);
  }

  async verifyEmail(userId: string, now: Date): Promise<void> {
    await this.write(
      'UPDATE users SET email_verified_at = coalesce(email_verified_at, $2) WHERE id = $1',
      [userId, now],
    );
  }

  async insertRefresh(record: RefreshRecord): Promise<void> {
    await this.write(
      'INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at, revoked_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [
        record.id,
        record.userId,
        record.tokenHash,
        record.familyId,
        record.expiresAt,
        record.revokedAt,
      ],
    );
  }

  async refreshToken(id: string): Promise<RefreshRecord | null> {
    const result = await this.client.query<RefreshRecord>(
      'SELECT id, user_id AS "userId", token_hash AS "tokenHash", family_id AS "familyId", expires_at AS "expiresAt", revoked_at AS "revokedAt" FROM refresh_tokens WHERE id = $1',
      [id],
    );
    return result.rows[0] ?? null;
  }

  async revokeRefresh(id: string, now: Date): Promise<void> {
    await this.write(
      'UPDATE refresh_tokens SET revoked_at = coalesce(revoked_at, $2) WHERE id = $1',
      [id, now],
    );
  }

  async revokeFamily(familyId: string, now: Date): Promise<void> {
    await this.client.query(
      'UPDATE refresh_tokens SET revoked_at = coalesce(revoked_at, $2) WHERE family_id = $1',
      [familyId, now],
    );
  }

  async deleteAccount(userId: string): Promise<void> {
    // Existing foreign-key cascades own child cleanup; never touch retained slugs.
    await this.write('DELETE FROM users WHERE id = $1', [userId]);
  }
}

export class PostgresAccountStore implements AccountStore {
  private readonly pool: Pick<Pool, 'connect' | 'query'>;

  constructor(pool: Pick<Pool, 'connect' | 'query'>) {
    this.pool = pool;
  }

  async credentials(email: string): Promise<Account | null> {
    try {
      const result = await this.pool.query<Account>(
        `SELECT ${accountColumns} FROM users WHERE email = $1`,
        [email],
      );
      return account(result.rows[0]);
    } catch (error) {
      throw redactError(error);
    }
  }

  async transaction<T>(work: (tx: AccountTransaction) => Promise<T>): Promise<T> {
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch {
      throw unavailable();
    }
    let releaseError: Error | undefined;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const result = await work(new PostgresAccountTransaction(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        releaseError = new Error(unavailableMessage);
      }
      throw redactError(error);
    } finally {
      client.release(releaseError);
    }
  }
}

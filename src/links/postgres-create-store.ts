import type { Pool, PoolClient } from 'pg';
import { AppError } from '../platform/errors.ts';
import {
  IdempotencyBusy,
  ReplayConflict,
  SlugCollision,
  type CreationClaim,
  type CreatedLink,
  type CreationReplay,
  type LinkCreationStore,
  type LinkCreationTransaction,
} from './create.ts';

const unavailable = () => new AppError(503, 'INTERNAL', 'Link store unavailable.');
async function verified(
  query: Pick<Pool, 'query'> | PoolClient,
  userId: string,
  lock: boolean,
): Promise<boolean | null> {
  const result = await query.query<{ email_verified_at: Date | null }>(
    `SELECT email_verified_at FROM users WHERE id = $1${lock ? ' FOR SHARE' : ''}`,
    [userId],
  );
  return result.rows[0] ? result.rows[0].email_verified_at !== null : null;
}
class PostgresCreationTransaction implements LinkCreationTransaction {
  private readonly client: PoolClient;
  constructor(client: PoolClient) {
    this.client = client;
  }
  verifiedOwner(userId: string) {
    return verified(this.client, userId, true);
  }
  async claim(claim: CreationClaim): Promise<boolean> {
    try {
      await this.client.query("SET LOCAL lock_timeout = '100ms'");
      await this.client.query(
        'DELETE FROM idempotency_records WHERE principal = $1 AND key = $2 AND expires_at <= $3',
        [claim.subject, claim.key, claim.now],
      );
      const result = await this.client.query(
        "INSERT INTO idempotency_records (principal, key, request_hash, state, created_at, expires_at) VALUES ($1, $2, $3, 'completed', $4, $5) ON CONFLICT (principal, key) DO NOTHING RETURNING id",
        [claim.subject, claim.key, claim.hash, claim.now, claim.expiresAt],
      );
      await this.client.query("SET LOCAL lock_timeout = '0'");
      return result.rowCount === 1;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '55P03')
        throw new IdempotencyBusy();
      throw error;
    }
  }
  async reserve(slug: string): Promise<boolean> {
    return (
      (
        await this.client.query(
          'INSERT INTO slug_reservations (slug) VALUES ($1) ON CONFLICT (slug) DO NOTHING RETURNING slug',
          [slug],
        )
      ).rowCount === 1
    );
  }
  async insert(
    userId: string,
    slug: string,
    destinationUrl: string,
    expiresAt: Date | null,
    now: Date,
  ): Promise<{ id: string }> {
    const result = await this.client.query<{ id: string }>(
      'INSERT INTO links (user_id, slug, destination_url, expires_at, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5) RETURNING id',
      [userId, slug, destinationUrl, expiresAt, now],
    );
    if (result.rowCount !== 1 || !result.rows[0]) throw unavailable();
    return result.rows[0];
  }
  async complete(subject: string, key: string, response: CreatedLink): Promise<void> {
    const result = await this.client.query(
      "UPDATE idempotency_records SET response_status = 201, response_body = $3, link_id = $4 WHERE principal = $1 AND key = $2 AND state = 'completed'",
      [subject, key, JSON.stringify(response), response.id],
    );
    if (result.rowCount !== 1) throw unavailable();
  }
}
export class PostgresLinkCreationStore implements LinkCreationStore {
  private readonly pool: Pick<Pool, 'connect' | 'query'>;
  constructor(pool: Pick<Pool, 'connect' | 'query'>) {
    this.pool = pool;
  }
  async verifiedOwner(userId: string) {
    try {
      return await verified(this.pool, userId, false);
    } catch {
      throw unavailable();
    }
  }
  async available(slug: string): Promise<boolean> {
    try {
      return (
        (await this.pool.query('SELECT slug FROM slug_reservations WHERE slug = $1', [slug])).rows
          .length === 0
      );
    } catch {
      throw unavailable();
    }
  }
  async replay(subject: string, key: string, now: Date): Promise<CreationReplay | null> {
    try {
      return (
        (
          await this.pool.query<CreationReplay>(
            'SELECT request_hash AS hash, state, response_status AS status, response_body AS body FROM idempotency_records WHERE principal = $1 AND key = $2 AND expires_at > $3',
            [subject, key, now],
          )
        ).rows[0] ?? null
      );
    } catch {
      throw unavailable();
    }
  }
  async transaction<T>(work: (tx: LinkCreationTransaction) => Promise<T>): Promise<T> {
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch {
      throw unavailable();
    }
    let discard: Error | undefined;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const result = await work(new PostgresCreationTransaction(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        discard = unavailable();
      }
      if (
        error instanceof AppError ||
        error instanceof ReplayConflict ||
        error instanceof SlugCollision
      )
        throw error;
      throw unavailable();
    } finally {
      client.release(discard);
    }
  }
}

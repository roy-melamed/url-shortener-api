/** FR-8 / AD-7: weighted one-minute counters, uniform user/key admission. */
import type { Pool, PoolClient } from 'pg';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../platform/errors.ts';

export const WINDOW_MS = 60_000;
export const REQUEST_LIMIT = 100;
const SUBJECT = /^(user|apikey):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface WindowState {
  elapsedMs: number;
  previousCount: number;
  currentCount: number;
}
export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
  resetAfterSeconds: number;
}

/** Integer-weighted admission avoids floating point errors at exact boundaries. */
export function decideRateLimit(state: WindowState): RateLimitDecision {
  const { elapsedMs, previousCount, currentCount } = state;
  if (
    !Number.isInteger(elapsedMs) ||
    elapsedMs < 0 ||
    elapsedMs >= WINDOW_MS ||
    !Number.isInteger(previousCount) ||
    previousCount < 0 ||
    previousCount > REQUEST_LIMIT ||
    !Number.isInteger(currentCount) ||
    currentCount < 0 ||
    currentCount > REQUEST_LIMIT
  ) {
    throw new AppError(503, 'INTERNAL', 'Rate limit state unavailable.');
  }
  const weighted = previousCount * (WINDOW_MS - elapsedMs) + currentCount * WINDOW_MS;
  const allowed = weighted + WINDOW_MS <= REQUEST_LIMIT * WINDOW_MS;
  const after = weighted + (allowed ? WINDOW_MS : 0);
  // Earliest admission of ONE request with no intervening traffic. If current
  // count is 100, it must decay in the next window before another can fit.
  const waitMs = allowed
    ? 0
    : currentCount >= REQUEST_LIMIT
      ? WINDOW_MS - elapsedMs + Math.ceil(WINDOW_MS / currentCount)
      : Math.ceil((weighted + WINDOW_MS - REQUEST_LIMIT * WINDOW_MS) / previousCount);
  return {
    allowed,
    remaining: Math.max(0, Math.floor((REQUEST_LIMIT * WINDOW_MS - after) / WINDOW_MS)),
    retryAfterSeconds: Math.ceil(waitMs / 1000),
    // Full budget recovery assumes no more admissions, not just a minute rollover.
    resetAfterSeconds: Math.ceil(
      ((currentCount + (allowed ? 1 : 0) > 0 ? 2 : 1) * WINDOW_MS - elapsedMs) / 1000,
    ),
  };
}

export interface RateLimiter {
  consume(subject: string): Promise<RateLimitDecision>;
}

// All times originate from the DB AFTER subject serialization; transaction-start
// now() or app clocks can charge requests to a stale minute while waiting on locks.
export const READ_WINDOW_SQL = `
WITH clock AS MATERIALIZED (
  SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS ms
), bucket AS (
  SELECT ms, to_timestamp((ms / 60000) * 60) AS start FROM clock
), counts AS (
  SELECT w.start, (w.ms % 60000)::integer AS elapsed_ms,
         coalesce(p.curr_count, 0) AS previous_count
  FROM bucket w LEFT JOIN rate_limit_windows p
    ON p.subject = $1 AND p.window_start = w.start - interval '1 minute'
), current AS (
  INSERT INTO rate_limit_windows(subject, window_start, prev_count, curr_count)
  SELECT $1, start, previous_count, 0 FROM counts
  ON CONFLICT (subject, window_start) DO UPDATE SET prev_count = EXCLUDED.prev_count
  RETURNING window_start, prev_count, curr_count
)
SELECT c.window_start, c.prev_count, c.curr_count, n.elapsed_ms
FROM current c CROSS JOIN counts n`;

/** SQL handoff only. URL-14 owns registration/scheduling/execution of hygiene. */
export const PURGE_EXPIRED_WINDOWS_SQL = `DELETE FROM rate_limit_windows
WHERE window_start < date_trunc('minute', clock_timestamp()) - interval '1 minute'`;

export class PostgresRateLimiter implements RateLimiter {
  private readonly pool: Pick<Pool, 'connect'>;

  constructor(pool: Pick<Pool, 'connect'>) {
    this.pool = pool;
  }

  async consume(subject: string): Promise<RateLimitDecision> {
    if (typeof subject !== 'string' || !SUBJECT.test(subject)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Invalid rate limit subject.');
    }
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch {
      throw new AppError(503, 'INTERNAL', 'Rate limiter unavailable.');
    }
    let broken = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      // Hash collisions serialize unrelated subjects, never merge their counts.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [subject]);
      const result = await client.query<{
        window_start: Date;
        prev_count: number;
        curr_count: number;
        elapsed_ms: number;
      }>(READ_WINDOW_SQL, [subject]);
      const row = result.rows[0];
      if (
        !row ||
        !(row.window_start instanceof Date) ||
        !Number.isFinite(row.window_start.getTime())
      ) {
        throw new Error('invalid-window');
      }
      const decision = decideRateLimit({
        elapsedMs: row.elapsed_ms,
        previousCount: row.prev_count,
        currentCount: row.curr_count,
      });
      if (decision.allowed) {
        const update = await client.query(
          `UPDATE rate_limit_windows SET curr_count = curr_count + 1
          WHERE subject = $1 AND window_start = $2`,
          [subject, row.window_start],
        );
        if (update.rowCount !== 1) throw new Error('missing-window');
      }
      await client.query('COMMIT');
      return decision;
    } catch {
      try {
        await client.query('ROLLBACK');
      } catch {
        broken = true;
      }
      throw new AppError(503, 'INTERNAL', 'Rate limiter unavailable.');
    } finally {
      client.release(broken ? new Error('rate-limit-connection-unusable') : undefined);
    }
  }
}

/** Inject authenticated subjects from auth, NEVER from request headers/body/IP. */
export function createRateLimitHook(
  limiter: RateLimiter,
  authenticatedSubject: (request: FastifyRequest) => string | null,
) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const pathname = request.url.split('?')[0] ?? '';
    if (pathname !== '/v1' && !pathname.startsWith('/v1/')) return;
    const subject = authenticatedSubject(request);
    if (subject === null) return; // authentication owns 401; no IP/anonymous counter.
    const result = await limiter.consume(subject);
    reply.header('RateLimit-Limit', String(REQUEST_LIMIT));
    reply.header('RateLimit-Remaining', String(result.remaining));
    reply.header('RateLimit-Reset', String(result.resetAfterSeconds));
    if (!result.allowed) {
      reply.header('Retry-After', String(result.retryAfterSeconds));
      throw new AppError(429, 'RATE_LIMITED', 'Request rate limit exceeded.');
    }
  };
}

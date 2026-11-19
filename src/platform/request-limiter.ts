/**
 * In-process bounded request limiter — URL-10 active MVP scope only.
 *
 * Owner: URL-shortener service. Lifecycle: one process instance; callers dispose
 * it with the process. URL-22 resolves authentication and supplies a principal;
 * URL-11 later applies this reusable boundary to protected routes. This module
 * does not parse credentials, create accounts, or implement CAPTCHA.
 *
 * Enforcement is an exact rolling 60-second window per authenticated principal.
 * It is intentionally process-local: separate processes, containers, or hosts do
 * not share counters. A deployment therefore cannot claim a global 100/minute
 * ceiling without separately approved shared state. No database, cache, queue,
 * or other infrastructure is introduced.
 */
import { AppError } from './errors.ts';

const WINDOW_MS = 60_000;
const LIMIT = 100;
const MAX_PRINCIPALS = 10_000;
const CLEANUP_INTERVAL_MS = 1_000;

export type RateLimitPrincipal = `user:${string}` | `apikey:${string}`;

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  /** Seconds until the oldest counted request leaves the window. */
  readonly retryAfterSeconds: number;
  /** Delta seconds until the earliest counted request expires (not Unix time). */
  readonly resetAfterSeconds: number;
}

export interface RequestLimiterOptions {
  /** Trusted elapsed-millisecond clock; defaults to monotonic performance.now. */
  now?: () => number;
  maxPrincipals?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isRateLimitPrincipal(value: unknown): value is RateLimitPrincipal {
  if (typeof value !== 'string' || value.length > 43) return false;
  const separator = value.indexOf(':');
  if (separator < 1) return false;
  const kind = value.slice(0, separator);
  const id = value.slice(separator + 1);
  return (kind === 'user' || kind === 'apikey') && UUID.test(id);
}

/**
 * Synchronous consumption is atomic within one JS event loop. Never evict a live
 * principal to make room: that would reset its quota. At capacity, reject NEW
 * principals with 503 instead of fabricating a 429 or growing state indefinitely.
 * Expiry is lazy: own-key cleanup on every consumption, a global sweep on active
 * traffic at least one second apart (or at capacity), and explicit prune() for
 * idle lifecycle cleanup. Idle retained state is still bounded; no timer opens.
 */
export class InProcessRequestLimiter {
  private readonly now: () => number;
  private readonly maxPrincipals: number;
  private readonly hits = new Map<RateLimitPrincipal, number[]>();
  private lastTime = 0;
  private lastSweep = 0;

  constructor(options: RequestLimiterOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.maxPrincipals = options.maxPrincipals ?? MAX_PRINCIPALS;
    if (
      typeof this.now !== 'function' ||
      !Number.isSafeInteger(this.maxPrincipals) ||
      this.maxPrincipals < 1 ||
      this.maxPrincipals > MAX_PRINCIPALS
    ) {
      throw new Error('Invalid request limiter configuration.');
    }
  }

  /** Consume one request or return the rejection decision without consuming. */
  consume(principal: RateLimitPrincipal): RateLimitDecision {
    if (!isRateLimitPrincipal(principal)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Invalid rate-limit principal.');
    }
    const at = this.clock();
    if (at - this.lastSweep >= CLEANUP_INTERVAL_MS) this.sweep(at);
    const current = this.expire(principal, at);
    if (current.length >= LIMIT) {
      const seconds = this.resetSeconds(current, at);
      return {
        allowed: false,
        limit: LIMIT,
        remaining: 0,
        retryAfterSeconds: seconds,
        resetAfterSeconds: seconds,
      };
    }
    if (!this.hits.has(principal) && this.hits.size >= this.maxPrincipals) {
      this.sweep(at);
      if (this.hits.size >= this.maxPrincipals) {
        throw new AppError(503, 'INTERNAL', 'Request limiter unavailable.');
      }
    }
    current.push(at);
    this.hits.set(principal, current);
    return {
      allowed: true,
      limit: LIMIT,
      remaining: LIMIT - current.length,
      retryAfterSeconds: 0,
      resetAfterSeconds: this.resetSeconds(current, at),
    };
  }

  /** Aggregate diagnostics only; never expose other principals or timestamps. */
  get trackedPrincipalCount(): number {
    return this.hits.size;
  }

  get storedRequestCount(): number {
    let count = 0;
    for (const stamps of this.hits.values()) count += stamps.length;
    return count;
  }

  /** Explicit idle cleanup without accepting caller-supplied timestamps. */
  prune(): void {
    this.sweep(this.clock());
  }

  private sweep(at: number): void {
    for (const principal of this.hits.keys()) this.expire(principal, at);
    this.lastSweep = at;
  }

  private expire(principal: RateLimitPrincipal, at: number): number[] {
    const current = this.hits.get(principal) ?? [];
    const live = current.filter((stamp) => at - stamp < WINDOW_MS);
    if (live.length === 0) this.hits.delete(principal);
    else this.hits.set(principal, live);
    return live;
  }

  private resetSeconds(stamps: number[], at: number): number {
    return Math.max(1, Math.ceil((WINDOW_MS - (at - stamps[0]!)) / 1_000));
  }

  private clock(): number {
    let time: number;
    try {
      time = this.now();
    } catch {
      throw new AppError(503, 'INTERNAL', 'Request limiter unavailable.');
    }
    if (
      !Number.isFinite(time) ||
      time < this.lastTime ||
      time > Number.MAX_SAFE_INTEGER - WINDOW_MS
    ) {
      throw new AppError(503, 'INTERNAL', 'Request limiter unavailable.');
    }
    this.lastTime = time;
    return time;
  }
}

export const REQUEST_LIMIT_PER_MINUTE = LIMIT;
export const REQUEST_LIMIT_WINDOW_MS = WINDOW_MS;

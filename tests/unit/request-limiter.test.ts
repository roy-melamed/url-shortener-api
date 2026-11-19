import { describe, expect, it } from 'vitest';
import {
  InProcessRequestLimiter,
  isRateLimitPrincipal,
  type RateLimitPrincipal,
} from '../../src/platform/request-limiter.ts';

const user = 'user:11111111-1111-4111-8111-111111111111' as const;
const other = 'user:22222222-2222-4222-8222-222222222222' as const;
const key = 'apikey:11111111-1111-4111-8111-111111111111' as const;
function fill(limiter: InProcessRequestLimiter, principal: RateLimitPrincipal = user) {
  for (let i = 0; i < 100; i++)
    expect(limiter.consume(principal)).toMatchObject({
      allowed: true,
      limit: 100,
      remaining: 99 - i,
    });
}

describe('bounded rolling request limiter', () => {
  it('allows exactly 100 and denies without growing state or extending lockout', () => {
    let now = 0;
    const limiter = new InProcessRequestLimiter({ now: () => now });
    fill(limiter);
    for (let i = 0; i < 1_000; i++)
      expect(limiter.consume(user)).toEqual({
        allowed: false,
        limit: 100,
        remaining: 0,
        retryAfterSeconds: 60,
        resetAfterSeconds: 60,
      });
    expect(limiter.storedRequestCount).toBe(100);
    now = 59_999;
    expect(limiter.consume(user).retryAfterSeconds).toBe(1);
    now = 60_000;
    expect(limiter.consume(user)).toMatchObject({ allowed: true, remaining: 99 });
    expect(limiter.storedRequestCount).toBe(1);
  });

  it('uses an exact rolling window, not a wall-minute reset or full-window reset', () => {
    let now = 59_000;
    const limiter = new InProcessRequestLimiter({ now: () => now });
    limiter.consume(user);
    now = 60_000;
    for (let i = 0; i < 99; i++) limiter.consume(user);
    expect(limiter.consume(user)).toMatchObject({ allowed: false, retryAfterSeconds: 59 });
    now = 119_000;
    expect(limiter.consume(user)).toMatchObject({
      allowed: true,
      remaining: 0,
      resetAfterSeconds: 1,
    });
    expect(limiter.consume(user)).toMatchObject({ allowed: false, retryAfterSeconds: 1 });
    now = 120_000;
    expect(limiter.consume(user)).toMatchObject({ allowed: true, remaining: 98 });
  });

  it('isolates users and same-UUID API keys without exposing identities', () => {
    const limiter = new InProcessRequestLimiter({ now: () => 0 });
    fill(limiter);
    expect(limiter.consume(other).remaining).toBe(99);
    expect(limiter.consume(key).remaining).toBe(99);
    expect(limiter.consume(user).allowed).toBe(false);
    expect(JSON.stringify(limiter.consume(other))).not.toContain('22222222');
    expect(limiter.trackedPrincipalCount).toBe(3);
  });

  it('never evicts live quota at capacity and accepts new subjects only after expiry', () => {
    let now = 0;
    const limiter = new InProcessRequestLimiter({ now: () => now, maxPrincipals: 1 });
    fill(limiter);
    expect(() => limiter.consume(other)).toThrow('Request limiter unavailable.');
    expect(limiter.consume(user).allowed).toBe(false);
    expect(limiter.trackedPrincipalCount).toBe(1);
    now = 60_000;
    expect(limiter.consume(other).allowed).toBe(true);
    expect(limiter.trackedPrincipalCount).toBe(1);
    now = 120_000;
    limiter.prune();
    expect(limiter.trackedPrincipalCount).toBe(0);
    expect(limiter.storedRequestCount).toBe(0);
  });

  it('reclaims expired capacity even between periodic sweeps', () => {
    let now = 0;
    const limiter = new InProcessRequestLimiter({ now: () => now, maxPrincipals: 1 });
    limiter.consume(user);
    now = 59_999;
    limiter.prune();
    now = 60_000;
    expect(limiter.consume(other).remaining).toBe(99);
    expect(limiter.trackedPrincipalCount).toBe(1);
  });

  it('sweeps idle expired subjects on traffic and explicit cleanup', () => {
    let now = 0;
    const limiter = new InProcessRequestLimiter({ now: () => now });
    limiter.consume(user);
    now = 30_000;
    limiter.consume(other);
    now = 60_000;
    limiter.consume(key);
    expect(limiter.trackedPrincipalCount).toBe(2);
    expect(limiter.storedRequestCount).toBe(2);
    now = 90_000;
    limiter.prune();
    expect(limiter.trackedPrincipalCount).toBe(1);
  });

  it('enforces the default 10,000-principal bound without state eviction', () => {
    const limiter = new InProcessRequestLimiter({ now: () => 0 });
    for (let i = 0; i < 10_000; i++)
      limiter.consume(`user:${i.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`);
    expect(limiter.trackedPrincipalCount).toBe(10_000);
    expect(limiter.storedRequestCount).toBe(10_000);
    expect(() => limiter.consume(other)).toThrow('Request limiter unavailable.');
  });

  it.each([
    undefined,
    null,
    1,
    '',
    'user:bad',
    'anonymous:11111111-1111-4111-8111-111111111111',
    'USER:11111111-1111-4111-8111-111111111111',
    'user:AAAAAAAA-1111-4111-8111-111111111111',
    'user:' + 'x'.repeat(100),
  ])('rejects malformed principal %s without storage', (value) => {
    const limiter = new InProcessRequestLimiter();
    expect(isRateLimitPrincipal(value)).toBe(false);
    expect(() => limiter.consume(value as RateLimitPrincipal)).toThrow(
      'Invalid rate-limit principal.',
    );
    expect(limiter.trackedPrincipalCount).toBe(0);
  });

  it.each([0, -1, 1.5, NaN, Infinity, 10_001])(
    'rejects invalid principal capacity %s',
    (maxPrincipals) => {
      expect(() => new InProcessRequestLimiter({ maxPrincipals })).toThrow(
        'Invalid request limiter configuration.',
      );
    },
  );

  it.each([NaN, Infinity, -1, Number.MAX_SAFE_INTEGER])(
    'fails closed on invalid clock %s without mutation',
    (time) => {
      const limiter = new InProcessRequestLimiter({ now: () => time });
      expect(() => limiter.consume(user)).toThrow('Request limiter unavailable.');
      expect(() => limiter.prune()).toThrow('Request limiter unavailable.');
      expect(limiter.storedRequestCount).toBe(0);
    },
  );

  it('rejects backward and throwing clocks, preserving quota until clock recovery', () => {
    let now = 100;
    const limiter = new InProcessRequestLimiter({ now: () => now });
    fill(limiter);
    now = 99;
    expect(() => limiter.consume(user)).toThrow('Request limiter unavailable.');
    now = 100;
    expect(limiter.consume(user).allowed).toBe(false);
    const broken = new InProcessRequestLimiter({
      now: () => {
        throw new Error('private clock detail');
      },
    });
    expect(() => broken.consume(user)).toThrow('Request limiter unavailable.');
    expect(() => new InProcessRequestLimiter({ now: 1 as unknown as () => number })).toThrow(
      'Invalid request limiter configuration.',
    );
  });

  it('has independent process-instance state and loses quota on recreation', () => {
    const first = new InProcessRequestLimiter();
    fill(first);
    expect(first.consume(user).allowed).toBe(false);
    expect(new InProcessRequestLimiter().consume(user).remaining).toBe(99);
  });
});

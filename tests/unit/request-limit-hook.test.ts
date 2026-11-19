import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.ts';
import { loadConfig } from '../../src/platform/config.ts';
import { enforceRequestLimit } from '../../src/platform/request-limit-hook.ts';
import {
  InProcessRequestLimiter,
  type RateLimitPrincipal,
} from '../../src/platform/request-limiter.ts';

const user = 'user:11111111-1111-4111-8111-111111111111';
const other = 'user:22222222-2222-4222-8222-222222222222';
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

// Test-only transport, NOT authentication; production has no such header/route.
function fixture(limiter: InProcessRequestLimiter) {
  const app = buildApp({
    config: loadConfig({ DATABASE_URL: 'fixture-only', LOG_LEVEL: 'silent' }),
  });
  apps.push(app);
  app.get(
    '/limiter-fixture',
    {
      preHandler: async (request, reply) => {
        enforceRequestLimit(request, reply, {
          limiter,
          principal: (request) =>
            (request.headers['x-test-principal'] ?? null) as RateLimitPrincipal | null,
        });
      },
    },
    async () => ({ ok: true }),
  );
  return (principal?: string) =>
    app.inject({
      method: 'GET',
      url: '/limiter-fixture',
      headers: {
        ...(principal ? { 'x-test-principal': principal } : {}),
        'x-request-id': 'limiter-test',
      },
    });
}

describe('principal limiter Fastify adapter', () => {
  it('returns private quota headers and correlated 429 with Retry-After, recovering at boundary', async () => {
    let now = 0;
    const inject = fixture(new InProcessRequestLimiter({ now: () => now }));
    const first = await inject(user);
    expect(first.statusCode).toBe(200);
    expect(first.headers).toMatchObject({
      'ratelimit-limit': '100',
      'ratelimit-remaining': '99',
      'ratelimit-reset': '60',
      'cache-control': 'no-store',
    });
    expect(first.headers['retry-after']).toBeUndefined();
    for (let i = 1; i < 100; i++) expect((await inject(user)).statusCode).toBe(200);
    now = 59_001;
    const rejected = await inject(user);
    expect(rejected.statusCode).toBe(429);
    expect(rejected.headers).toMatchObject({
      'ratelimit-limit': '100',
      'ratelimit-remaining': '0',
      'ratelimit-reset': '1',
      'retry-after': '1',
      'cache-control': 'no-store',
    });
    expect(rejected.json()).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests. Retry after 1 seconds.',
        requestId: 'limiter-test',
      },
    });
    expect(rejected.body).not.toContain(user);
    const isolated = await inject(other);
    expect(isolated.headers['ratelimit-remaining']).toBe('99');
    now = 60_000;
    const recovered = await inject(user);
    expect(recovered.statusCode).toBe(200);
    expect(recovered.headers['ratelimit-remaining']).toBe('99');
    expect(recovered.headers['retry-after']).toBeUndefined();
  });

  it('bypasses unresolved principals without storing state or claiming authentication', async () => {
    const limiter = new InProcessRequestLimiter();
    const inject = fixture(limiter);
    for (let i = 0; i < 101; i++) {
      const response = await inject();
      expect(response.statusCode).toBe(200);
      expect(response.headers['ratelimit-limit']).toBeUndefined();
    }
    expect(limiter.trackedPrincipalCount).toBe(0);
  });

  it('rejects malformed resolved principals without echoing input', async () => {
    const response = await fixture(new InProcessRequestLimiter())('private-invalid-principal');
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    expect(response.body).not.toContain('private-invalid-principal');
  });

  it('distinguishes capacity failure from quota 429 without leakage', async () => {
    const limiter = new InProcessRequestLimiter({ maxPrincipals: 1, now: () => 0 });
    const inject = fixture(limiter);
    await inject(user);
    const response = await inject(other);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: {
        code: 'INTERNAL',
        message: 'Request limiter unavailable.',
        requestId: 'limiter-test',
      },
    });
    expect(response.headers['retry-after']).toBeUndefined();
    expect(response.body).not.toContain(user);
    expect(response.body).not.toContain(other);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { loadConfig } from '../../src/platform/config.ts';
import { decideRateLimit } from '../../src/abuse/rate-limit.ts';
import type { RateLimiter } from '../../src/abuse/rate-limit.ts';
import { enforceCaptcha, type CaptchaProvider } from '../../src/abuse/captcha.ts';

const subject = 'apikey:00000000-0000-4000-8000-000000000001';
const config = loadConfig({ DATABASE_URL: 'fixture-only', LOG_LEVEL: 'silent' });
describe('HTTP seam only (not URL-11 implementation)', () => {
  it.each(['/%76%31/probe', '/%76%31/probe?fixture=1', '/v1/%70robe', '/v%31/probe'])(
    'cannot bypass resolved API-route limiting with encoded alias %s',
    async (url) => {
      const consume = vi.fn(async () =>
        decideRateLimit({ elapsedMs: 0, previousCount: 0, currentCount: 100 }),
      );
      const handler = vi.fn(async () => ({ stub: true }));
      const app = buildApp({
        config,
        rateLimit: { limiter: { consume }, authenticatedSubject: () => subject },
      });
      app.get('/v1/probe', handler);
      try {
        const result = await app.inject(url);
        expect(result.statusCode).toBe(429);
        expect(result.json().error.code).toBe('RATE_LIMITED');
        expect(result.headers['ratelimit-limit']).toBe('100');
        expect(result.headers['ratelimit-remaining']).toBe('0');
        expect(result.headers['ratelimit-reset']).toBe('120');
        expect(result.headers['retry-after']).toBe('61');
        expect(consume).toHaveBeenCalledOnce();
        expect(consume).toHaveBeenCalledWith(subject);
        expect(handler).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );
  it('creation-contract stub challenges only suspicious inputs and never writes on rejection', async () => {
    let suspicious = false;
    const verify = vi.fn(async (token: string) => token === 'fixture-valid');
    const provider: CaptchaProvider = { verify };
    const writes = vi.fn();
    const app = buildApp({ config });
    app.post('/v1/create-contract', async (request) => {
      await enforceCaptcha({
        mode: 'suspicious',
        provider,
        risk: {
          accountAgeMs: suspicious ? 0 : 2000,
          priorFailures: 0,
          creationsInLastMinute: 0,
          apiKeyAgeMs: null,
        },
        thresholds: {
          minAccountAgeMs: 1000,
          maxPriorFailures: 2,
          maxCreationsPerMinute: 5,
          minApiKeyAgeMs: 1000,
        },
        token: (request.body as { captchaToken?: string })?.captchaToken,
      });
      writes(); // Contract sentinel only: no actual link creation/DB write.
      return { stub: true };
    });
    try {
      expect(
        (await app.inject({ method: 'POST', url: '/v1/create-contract', payload: {} })).statusCode,
      ).toBe(200);
      expect(verify).not.toHaveBeenCalled();
      suspicious = true;
      const required = await app.inject({
        method: 'POST',
        url: '/v1/create-contract',
        payload: {},
      });
      expect(required.statusCode).toBe(403);
      expect(required.json().error.code).toBe('CAPTCHA_REQUIRED');
      const invalid = await app.inject({
        method: 'POST',
        url: '/v1/create-contract',
        payload: { captchaToken: 'private-invalid' },
      });
      expect(invalid.statusCode).toBe(403);
      expect(invalid.json().error.code).toBe('CAPTCHA_INVALID');
      expect(invalid.body).not.toContain('private-invalid');
      expect(writes).toHaveBeenCalledOnce();
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/create-contract',
            payload: { captchaToken: 'fixture-valid' },
          })
        ).statusCode,
      ).toBe(200);
      expect(writes).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });
  it('100 succeeds, 101 returns 429 envelope and retry/rate headers; other routes uncounted', async () => {
    let count = 0;
    const consume = vi.fn(async () => {
      const result = decideRateLimit({ elapsedMs: 0, previousCount: 0, currentCount: count });
      if (result.allowed) count++;
      return result;
    });
    const app = buildApp({
      config,
      rateLimit: { limiter: { consume }, authenticatedSubject: () => subject },
    });
    app.get('/v1/probe', async () => ({ stub: true }));
    try {
      for (let i = 0; i < 100; i++) {
        const response = await app.inject('/v1/probe');
        expect(response.statusCode).toBe(200);
        expect(response.headers['ratelimit-limit']).toBe('100');
        expect(response.headers['ratelimit-remaining']).toBe(String(99 - i));
        expect(response.headers['ratelimit-reset']).toBe('120');
        expect(response.headers).not.toHaveProperty('retry-after');
      }
      const denied = await app.inject({
        url: '/v1/probe',
        headers: { 'x-request-id': 'fixture-id' },
      });
      expect(denied.statusCode).toBe(429);
      expect(denied.headers['retry-after']).toBe('61');
      expect(denied.headers['ratelimit-remaining']).toBe('0');
      expect(denied.json()).toEqual({
        error: {
          code: 'RATE_LIMITED',
          message: 'Request rate limit exceeded.',
          requestId: 'fixture-id',
        },
      });
      for (const url of ['/healthz', '/slug', '/v10/probe']) await app.inject(url);
      expect(consume).toHaveBeenCalledTimes(101);
      expect(consume).toHaveBeenCalledWith(subject);
    } finally {
      await app.close();
    }
  });
  it('does not invent anonymous/IP subjects, and ignores spoofed client identity', async () => {
    const consume = vi.fn();
    const app = buildApp({
      config,
      rateLimit: { limiter: { consume }, authenticatedSubject: () => null },
    });
    app.get('/v1', async () => ({ stub: true }));
    try {
      const result = await app.inject({ url: '/v1?x=1', headers: { 'x-subject': subject } });
      expect(result.statusCode).toBe(200); // Authentication belongs to URL-22, not this stub.
      expect(result.headers).not.toHaveProperty('ratelimit-limit');
      expect(consume).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('fails closed on limiter failure without leaking SQL or identity', async () => {
    const limiter: RateLimiter = {
      consume: async () => {
        throw new Error('private-db-marker');
      },
    };
    const app = buildApp({ config, rateLimit: { limiter, authenticatedSubject: () => subject } });
    app.get('/v1/probe', async () => ({ stub: true }));
    try {
      const result = await app.inject('/v1/probe');
      expect(result.statusCode).toBe(500);
      expect(result.body).not.toContain('private-db-marker');
      expect(result.body).not.toContain(subject);
    } finally {
      await app.close();
    }
  });
});

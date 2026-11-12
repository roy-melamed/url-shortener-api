import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { loadConfig } from '../../src/platform/config.ts';
import { createLogger } from '../../src/platform/logger.ts';
const config = loadConfig({ DATABASE_URL: 'fixture', NODE_ENV: 'test' });

describe('observability shared HTTP spine and CI log privacy gate', () => {
  it('health is independent, readiness green/red/throw is minimal and uncached', async () => {
    const readiness = vi.fn().mockResolvedValue(true);
    const app = buildApp({ config: { ...config, logLevel: 'silent' }, readiness });
    try {
      expect((await app.inject('/healthz')).statusCode).toBe(200);
      expect(readiness).not.toHaveBeenCalled();
      expect((await app.inject('/readyz')).json()).toEqual({ status: 'ok' });
      readiness.mockResolvedValue(false);
      const red = await app.inject('/readyz');
      expect(red.statusCode).toBe(503);
      expect(red.json()).toEqual({ status: 'unavailable' });
      expect(red.headers['cache-control']).toBe('no-store');
      readiness.mockRejectedValue(new Error('postgres://private:password@host'));
      expect((await app.inject('/readyz')).json()).toEqual({ status: 'unavailable' });
    } finally {
      await app.close();
    }
  });
  it('every response including errors has one safe complete JSON line, never raw request data', async () => {
    const chunks: string[] = [];
    const logger = createLogger(config, {
      destination: {
        write: (chunk) => {
          chunks.push(chunk);
        },
      },
    });
    const app = buildApp({ config, logger, readiness: async () => false });
    app.post('/fixture/:id', async () => {
      throw new Error('private-token 198.51.100.32 https://secret.invalid/?password=leak');
    });
    try {
      await app.inject({
        method: 'POST',
        url: '/fixture/private-id?token=query-private',
        headers: {
          authorization: 'Bearer credential-private',
          cookie: 'session=cookie-private',
          'x-forwarded-for': '198.51.100.32',
          'x-request-id': '198.51.100.32',
        },
        payload: { password: 'body-private' },
      });
      await app.inject('/unknown-secret?password=unknown-private');
      await app.inject('/readyz');
      const lines = chunks.map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(lines).toHaveLength(3);
      for (const line of lines) {
        expect(line).toMatchObject({
          level: 30,
          timestamp: expect.any(String),
          requestId: expect.any(String),
          traceId: expect.stringMatching(/^[a-f0-9]{32}$/),
          method: expect.any(String),
          status: expect.any(Number),
          durationMs: expect.any(Number),
          principal: { type: 'anonymous', id: null },
          outcome: {},
        });
        expect(line).not.toHaveProperty('clientIp');
        expect(line).not.toHaveProperty('req');
        expect(line).not.toHaveProperty('err');
      }
      expect(lines[0]).toMatchObject({ route: '/fixture/:id', errorCode: 'INTERNAL', status: 500 });
      expect(lines[1]?.route).toBe('unmatched');
      for (const secret of [
        '198.51.100.32',
        'credential-private',
        'cookie-private',
        'body-private',
        'query-private',
        'private-token',
        'unknown-private',
        'unknown-secret',
        'private-id',
      ])
        expect(chunks.join('')).not.toContain(secret);
    } finally {
      await app.close();
    }
  });
  it('drops raw/nested objects even when a caller accidentally logs them', () => {
    const chunks: string[] = [];
    const logger = createLogger(config, {
      destination: {
        write: (chunk) => {
          chunks.push(chunk);
        },
      },
    });
    logger.info(
      {
        req: { ip: '198.51.100.4', headers: { cookie: 'private' } },
        clientIp: '198.51.100.4',
        err: new Error('password private'),
        password: 'private',
        accessToken: 'private',
        authorization: 'private',
      },
      'fixture',
    );
    expect(chunks.join('')).not.toContain('private');
    expect(chunks.join('')).not.toContain('198.51.100.4');
    expect(chunks.join('')).not.toContain('clientIp');
    expect(JSON.parse(chunks[0]!)).toMatchObject({
      password: '[Redacted]',
      accessToken: '[Redacted]',
      authorization: '[Redacted]',
    });
    logger
      .child({ clientIp: '198.51.100.4', req: { token: 'private' } })
      .warn('listener http://localhost:3000 and 198.51.100.4');
    expect(chunks.join('')).not.toContain('198.51.100.4');
    expect(chunks.join('')).not.toContain('private');
  });
});

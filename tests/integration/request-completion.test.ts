import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.ts';
import { loadConfig } from '../../src/platform/config.ts';
import { createLogger, logEmissionFailureCount } from '../../src/platform/logger.ts';
import { AppError } from '../../src/platform/errors.ts';
import { ApiKeys } from '../../src/auth/api-keys.ts';
import { BearerAuthentication } from '../../src/auth/bearer-auth.ts';
import { JoseAccessTokens } from '../../src/auth/crypto.ts';
import { MemoryApiKeyStore } from '../helpers/api-key-memory-store.ts';

const owner = '11111111-1111-4111-8111-111111111111';
const forged = '22222222-2222-4222-8222-222222222222';
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
const tokens = new JoseAccessTokens({
  ...generateKeyPairSync('rsa', { modulusLength: 2048 }),
  issuer: 'fixture',
  audience: 'fixture',
  kid: 'fixture',
});

async function fixture(level = 'info', fail = false) {
  const lines: string[] = [];
  let attempts = 0;
  const config = loadConfig({ DATABASE_URL: 'fixture-only', LOG_LEVEL: level });
  const logger = createLogger(config, {
    destination: {
      write(chunk: string) {
        attempts++;
        if (fail) throw new Error('PRIVATE sink exception with token and 198.51.100.4');
        lines.push(chunk);
      },
    },
  });
  const store = new MemoryApiKeyStore();
  store.users.add(owner);
  const apiKeys = new ApiKeys(store);
  const authentication = new BearerAuthentication({ apiKeys, accessTokens: tokens });
  const app = buildApp({ config, logger, bearerAuth: { authentication, apiKeys } });
  apps.push(app);
  app.get('/authenticated', { preHandler: authentication.authenticate }, async () => ({
    ok: true,
  }));
  app.post(
    '/validate',
    { schema: { body: { type: 'object', required: ['requiredValue'] } } },
    async () => ({ ok: true }),
  );
  app.get('/limited', async () => {
    throw new AppError(429, 'RATE_LIMITED', 'Limited.', undefined, { retryAfterSeconds: 60 });
  });
  app.get('/boom', async () => {
    throw new Error(
      'PRIVATE exception password cookie token https://private.invalid/?secret=x 198.51.100.4',
    );
  });
  return {
    app,
    logger,
    lines,
    store,
    apiKeys,
    attempts: () => attempts,
    records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('local canonical request completion (partial logging scope only)', () => {
  it.each(['info', 'warn', 'error', 'silent'])(
    'emits exactly one canonical record for each required result at diagnostic %s',
    async (level) => {
      const f = await fixture(level);
      const cases = [
        { url: '/healthz', status: 200, error: undefined },
        {
          url: '/validate',
          method: 'POST' as const,
          payload: {},
          status: 400,
          error: 'VALIDATION_ERROR',
        },
        { url: '/authenticated', status: 401, error: 'UNAUTHENTICATED' },
        { url: '/missing?private=value', status: 404, error: 'NOT_FOUND' },
        { url: '/limited', status: 429, error: 'RATE_LIMITED' },
        { url: '/boom', status: 500, error: 'INTERNAL' },
      ];
      for (const item of cases) {
        const before = f.records().length;
        const response = await f.app.inject({
          ...item,
          headers: { 'x-request-id': 'caller-correlation' },
        });
        expect(response.statusCode).toBe(item.status);
        const records = f.records().slice(before);
        expect(records).toHaveLength(1);
        const record = records[0]!;
        expect(record).toMatchObject({
          level: 30,
          msg: 'request completed',
          requestId: 'caller-correlation',
          traceId: null,
          method: item.method ?? 'GET',
          status: item.status,
          principal: { type: 'anonymous', id: null },
          outcome: {
            http:
              item.status >= 500 ? 'server_error' : item.status >= 400 ? 'client_error' : 'success',
          },
        });
        expect(record.errorCode).toBe(item.error);
        expect(Number.isFinite(record.durationMs)).toBe(true);
        expect(record.durationMs).toBeGreaterThanOrEqual(0);
        expect(new Date(record.timestamp as string).toISOString()).toBe(record.timestamp);
        expect(record.route).toBe(item.status === 404 ? 'unmatched' : item.url);
        expect(Object.keys(record).sort()).toEqual(
          [
            'timestamp',
            'level',
            'msg',
            'requestId',
            'traceId',
            'route',
            'method',
            'status',
            'durationMs',
            'principal',
            'outcome',
            ...(item.error ? ['errorCode'] : []),
          ].sort(),
        );
        if (item.status === 429) expect(response.headers['retry-after']).toBe('60');
        if (item.status === 500)
          expect(response.json().error.message).toBe('Internal server error.');
      }
      expect(f.lines.join('')).not.toContain('PRIVATE');
      expect(f.lines.join('')).not.toContain('private=value');
    },
  );

  it('uses only established JWT/API-key context, never correlation, identity or trace headers', async () => {
    const f = await fixture();
    const jwt = await tokens.issue(owner, new Date());
    const key = await f.apiKeys.create(owner, { name: 'fixture' }, new Date());
    const forgedHeaders = {
      'x-request-id': forged,
      'x-user-id': forged,
      'x-principal-id': forged,
      'x-principal-type': 'user',
      'x-trace-id': 'f'.repeat(32),
      traceparent: '00-' + 'f'.repeat(32) + '-' + 'e'.repeat(16) + '-01',
      cookie: 'PRIVATE-cookie',
    };
    for (const [token, principal] of [
      [jwt, { type: 'user', id: owner }],
      [key.key, { type: 'apikey', id: key.id }],
    ] as const) {
      const response = await f.app.inject({
        url: '/authenticated',
        headers: { ...forgedHeaders, authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      expect(f.records().at(-1)).toMatchObject({ requestId: forged, traceId: null, principal });
    }
    for (const url of ['/healthz', '/authenticated']) {
      await f.app.inject({
        url,
        headers: { ...forgedHeaders, authorization: 'Bearer PRIVATE-token' },
      });
      expect(f.records().at(-1)).toMatchObject({
        principal: { type: 'anonymous', id: null },
        traceId: null,
      });
    }
    for (const secret of [jwt, key.key, 'PRIVATE-cookie', 'PRIVATE-token', 'f'.repeat(32)])
      expect(f.lines.join('')).not.toContain(secret);
  });

  it.each([
    '',
    'a'.repeat(129),
    'bad,id',
    'https://private.invalid/?secret=x',
    '198.51.100.4',
    ['first', 'second'],
  ])('replaces malformed or duplicate correlation %# with a ULID', async (id) => {
    const f = await fixture();
    const response = await f.app.inject({ url: '/missing', headers: { 'x-request-id': id } });
    const generated = response.json().error.requestId;
    expect(generated).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(f.records()).toHaveLength(1);
    expect(f.records()[0]!.requestId).toBe(generated);
    expect(generated).not.toBe(id);
  });

  it('discards nested/body/header/child/error secrets including failure paths', async () => {
    const f = await fixture();
    const secret = 'PRIVATE-password-token-cookie-destination-query-198.51.100.4';
    f.app.post('/privacy/:id', async (request, reply) => {
      request.log
        .child({ nested: { secret }, req: request, err: new Error(secret) })
        .child({ password: secret })
        .error({ body: request.body, res: reply }, secret);
      reply.header('set-cookie', secret);
      throw Object.assign(new Error(secret), {
        cause: { password: secret },
        destination: `https://private.invalid/?${secret}`,
      });
    });
    const response = await f.app.inject({
      method: 'POST',
      url: `/privacy/${secret}?${secret}`,
      payload: {
        password: secret,
        nested: { token: secret },
        destinationUrl: `https://private.invalid/?${secret}`,
      },
      headers: {
        authorization: `Bearer ${secret}`,
        cookie: secret,
        'x-forwarded-for': '198.51.100.4',
      },
    });
    expect(response.statusCode).toBe(500);
    const canonical = f.records().filter((record) => record.msg === 'request completed');
    expect(canonical).toHaveLength(1);
    expect(canonical[0]).toMatchObject({ route: '/privacy/:id', errorCode: 'INTERNAL' });
    for (const value of [secret, '198.51.100.4', 'private.invalid', 'stack', 'destinationUrl'])
      expect(f.lines.join('')).not.toContain(value);
  });

  it('drops each failed emission once without affecting responses or exposing fallback data', async () => {
    const f = await fixture('silent', true);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      for (const [url, status] of [
        ['/healthz', 200],
        ['/authenticated', 401],
        ['/missing', 404],
        ['/limited', 429],
        ['/boom', 500],
      ] as const) {
        const response = await f.app.inject({ url });
        expect(response.statusCode).toBe(status);
        if (status === 200) expect(response.json()).toEqual({ status: 'ok' });
      }
      const invalid = await f.app.inject({ method: 'POST', url: '/validate', payload: {} });
      expect(invalid.statusCode).toBe(400);
      expect(f.attempts()).toBe(6);
      expect(logEmissionFailureCount(f.logger)).toBe(6);
      expect(f.lines).toEqual([]);
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});

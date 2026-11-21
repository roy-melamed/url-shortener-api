import { describe, expect, it } from 'vitest';
import type { Context } from 'aws-lambda';
import { runtimeFixtureEnvironment } from '../helpers/http-runtime-environment.ts';

/**
 * URL-7 dual-entrypoint acceptance (AD-12, design §1.3/§2 D-2): the SAME
 * `buildApp` instance is wrapped by `aws-lambda-fastify` and served through an
 * API Gateway (HTTP API v2) handler. Env is injected before the dynamic import
 * (mirrors deploy-time injection, design §6.2); `loadConfig()` reads it.
 */
Object.assign(process.env, runtimeFixtureEnvironment());

const { handler } = await import('../../src/lambda.ts');
const { handler: apiHandler } = await import('../../src/functions/api.ts');
const { handler: redirectHandler } = await import('../../src/functions/redirect.ts');

function v2Event(path: string, requestId: string) {
  return {
    version: '2.0',
    rawPath: path,
    rawQueryString: '',
    headers: {},
    requestContext: {
      accountId: 'local',
      apiId: 'local',
      domainName: 'local',
      http: {
        method: 'GET',
        path,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'vitest',
      },
      requestId,
      routeKey: `GET ${path}`,
      stage: '$default',
      time: 'now',
      timeEpoch: 0,
    },
    isBase64Encoded: false,
  };
}

const context = {} as unknown as Context;

describe('lambda entrypoint (aws-lambda-fastify, AD-12)', () => {
  it.each([
    ['legacy', handler],
    ['api', apiHandler],
    ['redirect', redirectHandler],
  ] as const)(
    'routes anonymous POST through the actual %s Lambda composition to correlated401, not404',
    async (_name, entrypoint) => {
      const event = v2Event('/v1/links', 'runtime-lambda-create');
      const result = await entrypoint(
        {
          ...event,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ destinationUrl: 'https://destination.example.invalid/' }),
          requestContext: {
            ...event.requestContext,
            http: { ...event.requestContext.http, method: 'POST' },
            routeKey: 'POST /v1/links',
          },
        },
        context,
      );
      expect(result.statusCode).toBe(401);
      expect(JSON.parse(result.body)).toEqual({
        error: {
          code: 'UNAUTHENTICATED',
          message: 'Invalid credentials.',
          requestId: 'runtime-lambda-create',
        },
      });
    },
  );
  it('serves /healthz through an API Gateway v2 event', async () => {
    const result = await handler(v2Event('/healthz', 'req-1'), context);
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ status: 'ok' });
    expect(result.isBase64Encoded).toBe(false);
  });

  it('returns the §5.1 envelope with the API Gateway requestId for a 404', async () => {
    const result = await handler(v2Event('/missing', 'req-2'), context);
    expect(result.statusCode).toBe(404);
    const body = JSON.parse(result.body);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.requestId).toBe('req-2');
  });
});

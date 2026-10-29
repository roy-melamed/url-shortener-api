import { describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { loadConfig } from '../../src/platform/config.js';
import { createLogger } from '../../src/platform/logger.js';
import { buildApp } from '../../src/app.js';
import { AppError } from '../../src/platform/errors.js';
import type { FastifyInstance } from 'fastify';

/**
 * URL-7 scaffolding acceptance (design §5.1, §8.2, FR-7.2/FR-9.3/FR-10.1):
 *  - `/healthz` liveness responds (AC-FR-9.3);
 *  - every error (incl. 404) uses the consistent §5.1 envelope with requestId;
 *  - requestId honors `x-request-id`, else a ULID;
 *  - ONE structured JSON log line per request with a `requestId` field.
 */

const config = loadConfig({
  DATABASE_URL: 'postgres://user:pass@localhost:5432/urlshortener',
  NODE_ENV: 'test',
});

class MemoryDestination {
  readonly chunks: string[] = [];
  write(chunk: string): void {
    this.chunks.push(chunk);
  }
  get lines(): string[] {
    return this.chunks.join('').split('\n').filter(Boolean);
  }
  parsed(): Record<string, unknown>[] {
    return this.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

function makeApp(): { app: FastifyInstance; destination: MemoryDestination } {
  const destination = new MemoryDestination();
  const app = buildApp({ config, logger: createLogger(config, { destination }) });
  return { app, destination };
}

describe('buildApp (dual-entrypoint skeleton, AD-12)', () => {
  it('serves /healthz liveness with no dependency checks (AC-FR-9.3)', async () => {
    const { app } = makeApp();
    await app.ready();
    const response = await supertest(app.server).get('/healthz');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body).toEqual({ status: 'ok' });
    await app.close();
  });

  it('returns the §5.1 JSON envelope for an unmatched route (404)', async () => {
    const { app } = makeApp();
    await app.ready();
    const response = await supertest(app.server).get('/definitely-missing');
    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(typeof response.body.error.message).toBe('string');
    expect(typeof response.body.error.requestId).toBe('string');
    expect(response.body.error.requestId.length).toBeGreaterThan(0);
    await app.close();
  });

  it('honors an inbound x-request-id header as the requestId', async () => {
    const { app, destination } = makeApp();
    app.get('/echo-id', async (request) => ({ requestId: request.id }));
    await app.ready();
    const response = await supertest(app.server)
      .get('/echo-id')
      .set('x-request-id', 'gw-correlation-123');
    expect(response.body.requestId).toBe('gw-correlation-123');
    await app.close();
    expect(destination.parsed()[0]).toMatchObject({ requestId: 'gw-correlation-123' });
  });

  it('generates a ULID requestId when no header is supplied', async () => {
    const { app } = makeApp();
    app.get('/echo-id', async (request) => ({ requestId: request.id }));
    await app.ready();
    const response = await supertest(app.server).get('/echo-id');
    expect(response.body.requestId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    await app.close();
  });

  it('wraps AppError into the envelope with its code, status and details', async () => {
    const { app } = makeApp();
    app.get('/conflict', async () => {
      throw new AppError(409, 'CONFLICT', 'Slug taken.', [{ field: 'slug', issue: 'taken' }]);
    });
    await app.ready();
    const response = await supertest(app.server).get('/conflict');
    expect(response.status).toBe(409);
    expect(response.body.error).toMatchObject({
      code: 'CONFLICT',
      message: 'Slug taken.',
      details: [{ field: 'slug', issue: 'taken' }],
    });
    expect(typeof response.body.error.requestId).toBe('string');
    await app.close();
  });

  it('maps schema validation failures to 400 VALIDATION_ERROR', async () => {
    const { app } = makeApp();
    app.post(
      '/validate',
      {
        schema: {
          body: {
            type: 'object',
            required: ['destinationUrl'],
            properties: { destinationUrl: { type: 'string' } },
          },
        },
      },
      async () => ({ ok: true }),
    );
    await app.ready();
    const response = await supertest(app.server).post('/validate').send({});
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(response.body.error.details)).toBe(true);
    expect(response.body.error.details[0].field).toBe('body');
    expect(response.body.error.details[0].issue).toContain('destinationUrl');
    await app.close();
  });

  it('collapses unexpected errors to a safe INTERNAL envelope (no stack leak)', async () => {
    const { app } = makeApp();
    app.get('/boom', async () => {
      throw new Error('sensitive internal detail with a stack');
    });
    await app.ready();
    const response = await supertest(app.server).get('/boom');
    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('INTERNAL');
    expect(response.body.error.message).toBe('Internal server error.');
    expect(JSON.stringify(response.body)).not.toContain('sensitive');
    expect(JSON.stringify(response.body)).not.toContain('stack');
    await app.close();
  });

  it('emits exactly one structured log line per request with requestId (FR-10.1/§8.2)', async () => {
    const { app, destination } = makeApp();
    await app.ready();
    await supertest(app.server).get('/healthz');

    const lines = destination.parsed();
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line).toMatchObject({
      route: '/healthz',
      method: 'GET',
      status: 200,
      msg: 'request completed',
    });
    expect(typeof line.requestId).toBe('string');
    expect(typeof line.durationMs).toBe('number');
    await app.close();
  });
});

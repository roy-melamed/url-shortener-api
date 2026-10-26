import Fastify from 'fastify';
import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/platform/config.js';
import { redirectResponse } from '../../src/platform/redirect.js';

/**
 * URL-18 acceptance: "Default config yields 302 + Cache-Control: no-store on a
 * redirect (integration test)." Pins AD-1 / AC-FR-4.1 — the default (and
 * decided) redirect posture: 302 Found with `Cache-Control: no-store`, so
 * every repeat visit reaches origin and aggregate click counts stay accurate
 * (FR-4.4). The full redirect flow lands with the redirect/app tickets.
 */
describe('default-config redirect (AD-1 / AC-FR-4.1)', () => {
  it('serves 302 + Cache-Control: no-store + Location for an active link', async () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://user:pass@localhost:5432/urlshortener',
    });

    const app = Fastify();
    // Minimal redirect route driven by the validated config — the redirect
    // handler implementation belongs to the redirect/app tickets.
    app.get('/:slug', (_request, reply) => {
      const response = redirectResponse('https://example.com/some-destination', config);
      return reply.status(response.statusCode).headers(response.headers).send();
    });
    await app.ready();

    const response = await supertest(app.server).get('/abc1234');

    expect(response.status).toBe(302);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.location).toBe('https://example.com/some-destination');

    await app.close();
  });
});

import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, it, expect } from 'vitest';
const execute = promisify(execFile);

describe('native-runtime OTLP export and context propagation', () => {
  it('boots actual SDK before HTTP/pg, transports metrics and safe linked traces', async () => {
    const requests: { path: string; body: Buffer }[] = [];
    const forwarding: Promise<void>[] = [];
    const collector = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        requests.push({ path: req.url!, body });
        if (process.env.TEST_OBSERVABILITY_JAEGER === 'true' && req.url === '/v1/traces') {
          forwarding.push(
            fetch('http://127.0.0.1:4318/v1/traces', {
              method: 'POST',
              body,
              headers: { 'content-type': req.headers['content-type']! },
            }).then(async (result) => {
              if (!result.ok) throw new Error(`Jaeger OTLP rejected fixture: ${result.status}`);
            }),
          );
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve));
    const address = collector.address();
    if (!address || typeof address === 'string') throw new Error('Missing collector listener');
    try {
      const { stdout } = await execute(
        process.execPath,
        [
          '--experimental-strip-types',
          '--disable-warning=ExperimentalWarning',
          'tests/fixtures/observability-smoke.ts',
        ],
        {
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            TEST_TELEMETRY_ENDPOINT: `http://127.0.0.1:${address.port}`,
            TEST_OBSERVABILITY_DATABASE_URL: process.env.TEST_OBSERVABILITY_DATABASE_URL,
          },
          timeout: 30000,
        },
      );
      const output = JSON.parse(stdout.trim()) as {
        logs: { route: string; traceId: string; status: number }[];
        linked: boolean;
      };
      expect(output.linked).toBe(true);
      const completions = output.logs.filter((line) => line.route);
      expect(completions).toHaveLength(3);
      expect(completions[0]).toMatchObject({
        route: '/healthz',
        traceId: 'a'.repeat(32),
        status: 200,
      });
      for (const line of completions) expect(line.traceId).not.toBe('0'.repeat(32));
      expect(requests.map((request) => request.path)).toContain('/v1/metrics');
      expect(requests.map((request) => request.path)).toContain('/v1/traces');
      const metrics = Buffer.concat(
        requests.filter((request) => request.path === '/v1/metrics').map((request) => request.body),
      ).toString();
      for (const metric of ['http.server.requests', 'http.server.errors', 'http.server.duration'])
        expect(metrics).toContain(metric);
      const traces = Buffer.concat(
        requests.filter((request) => request.path === '/v1/traces').map((request) => request.body),
      ).toString();
      for (const name of [
        'http.request',
        'queue.send',
        'click.aggregate',
        'geo.lookup',
        'db.query',
      ])
        expect(traces).toContain(name);
      expect(traces).not.toMatch(
        /198\.51\.100|private-password|db\.statement|clientIp|url\.full|server\.address/,
      );
      expect(stdout).not.toMatch(/private-password|198\.51\.100/);
      await Promise.all(forwarding);
      if (process.env.TEST_OBSERVABILITY_JAEGER === 'true') {
        let found = false;
        for (let attempt = 0; attempt < 30; attempt++) {
          const response = await fetch(`http://127.0.0.1:16686/api/traces/${'a'.repeat(32)}`);
          const result = (await response.json()) as {
            data?: { spans: { operationName: string }[] }[];
          };
          if (
            result.data?.some((item) =>
              item.spans.some((span) => span.operationName === 'http.request'),
            )
          ) {
            found = true;
            break;
          }
          await delay(200);
        }
        expect(found, 'actual fixture trace retrievable from dockerized Jaeger').toBe(true);
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        collector.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 45000);
});

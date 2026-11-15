/** Disposable native-runtime fixture, never imported by production entrypoints. */
import { context, trace } from '@opentelemetry/api';
import {
  startTelemetry,
  createObservability,
  injectQueueContext,
  queueSpanLink,
} from '../../src/platform/telemetry.ts';
const runtime = startTelemetry({
  nodeEnv: 'test',
  otlpEndpoint: process.env.TEST_TELEMETRY_ENDPOINT,
});
const { buildApp } = await import('../../src/app.ts');
const { loadConfig } = await import('../../src/platform/config.ts');
const { createLogger } = await import('../../src/platform/logger.ts');
const databaseUrl = process.env.TEST_OBSERVABILITY_DATABASE_URL;
if (databaseUrl) {
  const target = new URL(databaseUrl);
  if (target.hostname !== '127.0.0.1' || target.pathname !== '/observability_test')
    throw new Error('Disposable loopback observability_test database required');
}
const config = loadConfig({ DATABASE_URL: databaseUrl ?? 'fixture-only', NODE_ENV: 'test' });
const lines: string[] = [];
const observe = createObservability();
const app = buildApp({
  config,
  observability: observe,
  readiness: databaseUrl ? undefined : async () => false,
  logger: createLogger(config, {
    destination: {
      write: (chunk) => {
        lines.push(chunk);
      },
    },
  }),
});
app.get('/fixture-error', async () => {
  throw new Error('private-password 198.51.100.6');
});
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture listener');
  const base = `http://127.0.0.1:${address.port}`;
  await fetch(`${base}/healthz`, {
    headers: {
      traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`,
      authorization: 'Bearer private-password',
    },
  });
  const ready = await fetch(`${base}/readyz`);
  if (ready.status !== (databaseUrl ? 200 : 503))
    throw new Error('Unexpected readiness fixture result');
  await fetch(`${base}/fixture-error`);
  let carrier: Record<string, string> = {};
  await observe.trace('queue.send', async () => {
    carrier = injectQueueContext();
  });
  const link = queueSpanLink(carrier);
  await observe.trace(
    'click.aggregate',
    async () => {
      await observe.geoLookup(async () => 'GB');
    },
    link ? [link] : [],
  );
  if (!databaseUrl)
    await observe.trace('db.query', async () => {
      const span = trace.getSpan(context.active());
      span?.setAttribute('db.statement', 'private-password 198.51.100.6');
    });
  await app.close();
  await runtime.shutdown();
  console.log(
    JSON.stringify({
      logs: lines.map((line) => JSON.parse(line) as unknown),
      linked: Boolean(link),
    }),
  );
} catch (error) {
  await app.close();
  await runtime.shutdown();
  throw error;
}

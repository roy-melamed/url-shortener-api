import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { context, trace, SpanStatusCode, createTraceState } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { MetricReader, MeterProvider } from '@opentelemetry/sdk-metrics';
import {
  createObservability,
  createPrivacySpanProcessor,
  createTelemetry,
  queueSpanLink,
  telemetryAttributes,
  validateTelemetryEndpoint,
} from '../../src/platform/telemetry.ts';

class ManualReader extends MetricReader {
  protected async onShutdown() {}
  protected async onForceFlush() {}
}

describe('privacy-first OTel metrics and trace spine', () => {
  it('defines local 100% traces and AWS error/10% tail policies with metric destinations', () => {
    const local = readFileSync('deploy/observability/local-collector.yaml', 'utf8');
    expect(local).toContain('otlphttp/jaeger:');
    expect(local).toContain('prometheus:');
    expect(local).not.toContain('tail_sampling');
    const aws = readFileSync('deploy/observability/aws-collector.yaml', 'utf8');
    expect(aws).toContain('sampling_percentage: 10');
    expect(aws).toContain('status_codes: [ERROR]');
    expect(aws).toContain('processors: [tail_sampling, batch]');
    expect(aws).toContain('exporters: [awsxray]');
    expect(aws).toContain('exporters: [awsemf]');
  });
  it('emits actual collected data for every metric family, bounded labels and histogram', async () => {
    const reader = new ManualReader();
    const provider = new MeterProvider({ readers: [reader] });
    const observe = createObservability({ meter: provider.getMeter('fixture') });
    observe.request({ route: '/healthz', method: 'GET', status: 503, durationMs: 12.5 });
    observe.request({
      route: '/private?token=secret',
      method: 'private',
      status: 200,
      durationMs: 1,
    });
    observe.redirect('active', 'hit');
    observe.linkCreated('custom');
    observe.authFailure('anon_create_rejected');
    observe.rateLimitRejected('apikey');
    observe.captchaChallenged();
    observe.captchaFailed();
    observe.geoResolved();
    observe.geoMiss();
    observe.clickEnqueued();
    observe.clickFailed();
    observe.queueDepth(3);
    observe.dlqDepth(1);
    observe.idempotencyReplay();
    const data = await reader.collect();
    expect(data.errors).toEqual([]);
    const metrics = data.resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics);
    expect(metrics.map((metric) => metric.descriptor.name).sort()).toEqual(
      [
        'http.server.requests',
        'http.server.errors',
        'http.server.duration',
        'redirect.requests',
        'links.created',
        'auth.failures',
        'ratelimit.rejected',
        'captcha.challenged',
        'captcha.failed',
        'geo.resolved',
        'geo.miss',
        'click.messages.enqueued',
        'click.messages.failed',
        'sqs.depth',
        'dlq.depth',
        'idempotency.replays',
      ].sort(),
    );
    expect(
      metrics.find((metric) => metric.descriptor.name === 'http.server.duration')?.dataPoints[0]
        ?.value,
    ).toMatchObject({ count: 1, sum: 12.5 });
    expect(JSON.stringify(data)).not.toMatch(/secret|private/);
    expect(JSON.stringify(data)).toContain('anon_create_rejected');
    for (const measurement of [NaN, Infinity, -1]) {
      expect(() => observe.queueDepth(measurement)).toThrow('Invalid telemetry measurement');
      expect(() => observe.dlqDepth(measurement)).toThrow();
      expect(() =>
        observe.request({ method: 'GET', route: '/healthz', status: 200, durationMs: measurement }),
      ).toThrow();
    }
    await provider.shutdown();
  });
  it('exports actual spans without raw names, SQL, IP, exception text, link attributes or resource secrets', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new TracerProvider({
      spanProcessors: [createPrivacySpanProcessor(new SimpleSpanProcessor({ exporter }))],
    });
    const tracer = provider.getTracer('private-scope');
    const span = tracer.startSpan('postgres://private@198.51.100.5', {
      attributes: {
        'db.statement': 'private SQL',
        clientIp: '198.51.100.5',
        'http.route': '/healthz',
        status: 503,
      },
      links: [
        {
          context: { traceId: '1'.repeat(32), spanId: '2'.repeat(16), traceFlags: 1 },
          attributes: { password: 'private' },
        },
      ],
    });
    span.recordException(new Error('private exception'));
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'private' });
    span.end();
    await provider.forceFlush();
    const [record] = exporter.getFinishedSpans();
    expect(record).toMatchObject({
      name: 'dependency.operation',
      attributes: { 'http.route': '/healthz', status: 503 },
      status: { code: SpanStatusCode.ERROR },
      events: [],
    });
    expect(record?.links[0]?.attributes).toBeUndefined();
    expect(record?.resource.attributes).toEqual({ 'service.name': 'url-shortener-api' });
    expect(JSON.stringify(record)).not.toMatch(/private|198\.51/);
    await provider.shutdown();
  });
  it('records complete successful and error traces for collector-side tail sampling', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new TracerProvider({
      spanProcessors: [createPrivacySpanProcessor(new SimpleSpanProcessor({ exporter }))],
      idGenerator: { generateTraceId: () => 'f'.repeat(32), generateSpanId: () => 'a'.repeat(16) },
    });
    const tracer = provider.getTracer('fixture');
    tracer.startSpan('http.request').end();
    const error = tracer.startSpan('http.request');
    error.setStatus({ code: SpanStatusCode.ERROR });
    error.end();
    const retained = tracer.startSpan(
      'http.request',
      {},
      trace.setSpanContext(context.active(), {
        traceId: '0'.repeat(31) + '1',
        spanId: 'b'.repeat(16),
        traceFlags: 1,
        traceState: createTraceState('vendor=private'),
      }),
    );
    retained.end();
    await provider.forceFlush();
    expect(exporter.getFinishedSpans()).toHaveLength(3);
    await provider.shutdown();
  });
  it('validates endpoints with no credentials and bounded attribute keys/values', async () => {
    expect(validateTelemetryEndpoint({ nodeEnv: 'test' })).toBeUndefined();
    expect(
      validateTelemetryEndpoint({ nodeEnv: 'test', otlpEndpoint: 'http://localhost:14318' }),
    ).toBe('http://localhost:14318');
    expect(
      validateTelemetryEndpoint({
        nodeEnv: 'production',
        otlpEndpoint: 'https://collector.example.invalid',
      }),
    ).toBe('https://collector.example.invalid');
    for (const endpoint of [
      'not-url',
      'file:///private',
      'http://user:password@localhost:4318',
      'http://localhost:4318?secret=1',
      'http://localhost:4318/#private',
      'http://elsewhere.invalid',
      'http://localhost:4318/path',
    ])
      expect(() => validateTelemetryEndpoint({ nodeEnv: 'test', otlpEndpoint: endpoint })).toThrow(
        'Invalid telemetry endpoint',
      );
    const disabled = createTelemetry({ nodeEnv: 'test' });
    expect(disabled.enabled).toBe(false);
    disabled.start();
    disabled.start();
    await disabled.shutdown();
    expect(
      telemetryAttributes({
        clientIp: 'private',
        route: '/arbitrary',
        method: 'bad',
        status: -1,
        country: 'GB',
        token: 'private',
      }),
    ).toEqual({});
    expect(
      queueSpanLink({ traceparent: '00-' + '0'.repeat(32) + '-' + '0'.repeat(16) + '-01' }),
    ).toBeUndefined();
    expect(queueSpanLink({ traceparent: 'private' })).toBeUndefined();
    expect(queueSpanLink({})).toBeUndefined();
    expect(
      queueSpanLink({
        traceparent: `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`,
        baggage: 'private',
      }),
    ).toEqual({
      context: { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1, isRemote: true },
    });
  });
});

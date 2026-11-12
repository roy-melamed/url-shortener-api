/** Privacy-first OTel spine (design §8). Importing this module never starts an SDK.
 * Bootstrap: startTelemetry(config), THEN dynamically import the app/pg/queue client.
 * Request integration: trace('http.request', () => handler()); request({...}) on response.
 * Use route templates, never request URLs. Feature owners call metrics only on real events.
 */
import { context, metrics, propagation, trace, SpanStatusCode } from '@opentelemetry/api';
import type { Attributes, Link, Meter, Span, SpanContext, Tracer } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { AlwaysOnSampler, BatchSpanProcessor } from '@opentelemetry/sdk-trace';
import type { ReadableSpan, SpanProcessor, SpanExporter } from '@opentelemetry/sdk-trace';
import { PeriodicExportingMetricReader, type IMetricReader } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { AwsInstrumentation } from '@opentelemetry/instrumentation-aws-sdk';
import { isIP } from 'node:net';
import { AWSXRayIdGenerator } from '@opentelemetry/id-generator-aws-xray';

export const telemetryRoutes = [
  '/healthz',
  '/readyz',
  '/v1/links',
  '/v1/links/:id',
  '/v1/links/:id/analytics',
  '/v1/links/:id/qr',
  '/:slug',
  '/v1/users',
  '/v1/me',
  '/v1/auth/sessions',
  '/v1/auth/tokens/refresh',
  '/v1/auth/emails/verify',
  '/v1/auth/api-keys',
  '/v1/auth/api-keys/:id',
  '/v1/auth/oauth/:provider/callback',
  'other',
] as const;
const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'other'] as const;
const reasons = [
  'invalid_credentials',
  'missing_credentials',
  'expired',
  'forbidden',
  'anon_create_rejected',
  'other',
] as const;
export type TelemetryOperation =
  'http.request' | 'geo.lookup' | 'queue.send' | 'queue.receive' | 'click.aggregate' | 'db.query';
const operations: readonly TelemetryOperation[] = [
  'http.request',
  'geo.lookup',
  'queue.send',
  'queue.receive',
  'click.aggregate',
  'db.query',
];
const scope = 'url-shortener-observability';
const resource = resourceFromAttributes({ 'service.name': 'url-shortener-api' });

function finite<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return values.includes(value as T) ? (value as T) : fallback;
}
function nonnegative(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error('Invalid telemetry measurement');
  return value;
}

/** Finite value AND key filtering, also used for automatic instrumentation metrics. */
export function telemetryAttributes(input: Attributes): Attributes {
  const result: Attributes = {};
  const allowed: Record<string, readonly string[]> = {
    route: telemetryRoutes,
    'http.route': telemetryRoutes,
    method: methods,
    'http.request.method': methods,
    result: ['active', 'expired', 'unknown'],
    cache: ['hit', 'miss'],
    kind: ['random', 'custom'],
    reason: reasons,
    subject_type: ['user', 'apikey'],
  };
  for (const [key, values] of Object.entries(allowed)) {
    if (typeof input[key] === 'string' && values.includes(input[key])) result[key] = input[key];
  }
  for (const key of ['status', 'http.status_code', 'http.response.status_code']) {
    const value = input[key];
    if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599)
      result[key] = value;
  }
  return result;
}

function safeSpanContext(value: SpanContext): SpanContext {
  return {
    traceId: value.traceId,
    spanId: value.spanId,
    traceFlags: value.traceFlags,
    isRemote: value.isRemote,
  };
}

/** Export-boundary protection: discard URL/SQL/body/header/error text, raw names,
 * resource detector output, event payloads, link attributes and instrumentation metadata.
 * Record all spans: AWS collector tail sampling retains whole error traces plus
 * 10% of other traces. Head sampling cannot recover an error discovered later.
 * Local collector retains 100%. Both collectors must receive complete traces.
 */
export function createPrivacySpanProcessor(downstream: SpanProcessor): SpanProcessor {
  return {
    onStart() {},
    onEnd(span) {
      const safe: ReadableSpan = {
        kind: span.kind,
        startTime: span.startTime,
        endTime: span.endTime,
        duration: span.duration,
        ended: span.ended,
        parentSpanContext: span.parentSpanContext
          ? safeSpanContext(span.parentSpanContext)
          : undefined,
        droppedAttributesCount: span.droppedAttributesCount,
        droppedEventsCount: span.droppedEventsCount,
        droppedLinksCount: span.droppedLinksCount,
        spanContext: () => safeSpanContext(span.spanContext()),
        name: operations.includes(span.name as TelemetryOperation)
          ? span.name
          : 'dependency.operation',
        attributes: telemetryAttributes(span.attributes),
        status: { code: span.status.code },
        events: [],
        links: span.links.map(({ context: linked }) => ({ context: safeSpanContext(linked) })),
        resource,
        instrumentationScope: { name: scope },
      };
      downstream.onEnd(safe);
    },
    forceFlush: () => downstream.forceFlush(),
    shutdown: () => downstream.shutdown(),
  };
}

export function createObservability(dependencies: { meter?: Meter; tracer?: Tracer } = {}) {
  const meter = dependencies.meter ?? metrics.getMeter(scope);
  const tracer = dependencies.tracer ?? trace.getTracer(scope);
  const counters = Object.fromEntries(
    [
      'http.server.requests',
      'http.server.errors',
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
      'idempotency.replays',
    ].map((name) => [name, meter.createCounter(name)]),
  );
  const duration = meter.createHistogram('http.server.duration', { unit: 'ms' });
  const queue = meter.createGauge('sqs.depth');
  const dlq = meter.createGauge('dlq.depth');
  const count = (name: string, attributes: Attributes = {}) =>
    counters[name]!.add(1, telemetryAttributes(attributes));
  async function traced<T>(
    name: TelemetryOperation,
    callback: () => T | Promise<T>,
    links: readonly Link[] = [],
  ): Promise<T> {
    return tracer.startActiveSpan(
      finite(name, operations, 'http.request'),
      {
        links: links.map(({ context: linked }) => ({ context: safeSpanContext(linked) })),
      },
      async (span) => {
        try {
          return await callback();
        } catch (error) {
          // Exception messages/stacks may contain SQL, credentials or IPs: never collect them.
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }
  return {
    request(input: { method: string; route: string; status: number; durationMs: number }) {
      const elapsed = nonnegative(input.durationMs);
      const labels = telemetryAttributes({
        method: finite(input.method, methods, 'other'),
        route: finite(input.route, telemetryRoutes, 'other'),
        status: input.status,
      });
      count('http.server.requests', labels);
      duration.record(elapsed, labels);
      if (input.status >= 500 && input.status <= 599) count('http.server.errors', labels);
      const span = trace.getActiveSpan();
      span?.setAttributes(labels);
      if (input.status >= 500 && input.status <= 599)
        span?.setStatus({ code: SpanStatusCode.ERROR });
    },
    redirect(result: 'active' | 'expired' | 'unknown', cache: 'hit' | 'miss') {
      count('redirect.requests', { result, cache });
    },
    linkCreated(kind: 'random' | 'custom') {
      count('links.created', { kind });
    },
    authFailure(reason: (typeof reasons)[number]) {
      count('auth.failures', { reason });
    },
    rateLimitRejected(subjectType: 'user' | 'apikey') {
      count('ratelimit.rejected', { subject_type: subjectType });
    },
    captchaChallenged() {
      count('captcha.challenged');
    },
    captchaFailed() {
      count('captcha.failed');
    },
    geoResolved() {
      count('geo.resolved');
    },
    geoMiss() {
      count('geo.miss');
    },
    clickEnqueued() {
      count('click.messages.enqueued');
    },
    clickFailed() {
      count('click.messages.failed');
    },
    queueDepth(depth: number) {
      queue.record(nonnegative(depth));
    },
    dlqDepth(depth: number) {
      dlq.record(nonnegative(depth));
    },
    idempotencyReplay() {
      count('idempotency.replays');
    },
    trace: traced,
    /** Closure owns lookup input; raw IP is deliberately not an argument here. */
    geoLookup<T>(callback: () => T | Promise<T>) {
      return traced('geo.lookup', callback);
    },
  };
}
export type Observability = ReturnType<typeof createObservability>;

/** W3C context only; no baggage, application payload, queue names or message IDs.
 * Queue owner maps this carrier to SQS message attributes (or Redis fields).
 */
export function injectQueueContext(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return Object.fromEntries(Object.entries(carrier).filter(([key]) => key === 'traceparent'));
}
export function queueSpanLink(carrier: Record<string, string>): Link | undefined {
  // Only traceparent: tracestate and baggage may contain arbitrary user-controlled text.
  const value = carrier.traceparent;
  if (!value || !/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/.test(value)) return undefined;
  const linked: SpanContext = {
    traceId: value.slice(3, 35),
    spanId: value.slice(36, 52),
    traceFlags: Number.parseInt(value.slice(53), 16),
    isRemote: true,
  };
  return trace.isSpanContextValid(linked) ? { context: linked } : undefined;
}

export interface TelemetryConfig {
  nodeEnv: string;
  otlpEndpoint?: string;
}
export function validateTelemetryEndpoint(config: TelemetryConfig): string | undefined {
  if (!config.otlpEndpoint) return undefined;
  let url: URL;
  try {
    url = new URL(config.otlpEndpoint);
  } catch {
    throw new Error('Invalid telemetry endpoint');
  }
  const loopback =
    ['localhost', '[::1]'].includes(url.hostname) ||
    (isIP(url.hostname) === 4 && url.hostname.split('.')[0] === '127');
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '') ||
    (config.nodeEnv !== 'production' && !loopback)
  ) {
    throw new Error(
      'Invalid telemetry endpoint: use an origin without credentials; local requires loopback',
    );
  }
  return url.origin;
}

/** Construction is side-effect-free wrt SDK registration/network; call start explicitly.
 * Local Jaeger accepts traces; metrics also require an OTLP collector (see example).
 * No endpoint (including tests) => disabled, regardless of ambient OTEL exporter envvars.
 */
export function createTelemetry(
  config: TelemetryConfig,
  dependencies: { spanExporter?: SpanExporter; metricReader?: IMetricReader } = {},
) {
  const endpoint = validateTelemetryEndpoint(config);
  let sdk: NodeSDK | undefined;
  return {
    enabled: endpoint !== undefined,
    start() {
      if (!endpoint || sdk) return;
      // Hooks suppress SQL/body payload attributes before final export filtering.
      const suppressStatement = (span: Span) => {
        span.setAttribute('db.statement', '[suppressed]');
        span.setAttribute('db.query.text', '[suppressed]');
        span.updateName('db.query');
      };
      sdk = new NodeSDK({
        autoDetectResources: false,
        resource,
        resourceDetectors: [],
        logRecordProcessors: [],
        sampler: new AlwaysOnSampler(),
        idGenerator: config.nodeEnv === 'production' ? new AWSXRayIdGenerator() : undefined,
        spanProcessors: [
          createPrivacySpanProcessor(
            new BatchSpanProcessor({
              exporter:
                dependencies.spanExporter ??
                new OTLPTraceExporter({ url: `${endpoint}/v1/traces`, headers: {} }),
              exportTimeoutMillis: 3000,
            }),
          ),
        ],
        metricReaders: [
          dependencies.metricReader ??
            new PeriodicExportingMetricReader({
              exporter: new OTLPMetricExporter({
                url: `${endpoint}/v1/metrics`,
                headers: {},
                timeoutMillis: 3000,
              }),
              exportIntervalMillis: 60000,
              exportTimeoutMillis: 5000,
            }),
        ],
        views: [{ instrumentName: '*', attributesProcessors: [{ process: telemetryAttributes }] }],
        instrumentations: [
          // Fastify owns incoming server spans so logs, metrics and spans use
          // the same template route and never collect source IP or raw URLs.
          new HttpInstrumentation({
            disableIncomingRequestInstrumentation: true,
            headersToSpanAttributes: {},
            enableSyntheticSourceDetection: false,
          }),
          new PgInstrumentation({
            enhancedDatabaseReporting: false,
            addSqlCommenterCommentToQueries: false,
            enableTraceContextPropagation: false,
            requestHook: suppressStatement,
            responseHook: suppressStatement,
            connectionHook: suppressStatement,
          }),
          new AwsInstrumentation({
            suppressInternalInstrumentation: true,
            sqsExtractContextPropagationFromPayload: false,
            dynamoDBStatementSerializer: () => undefined,
          }),
        ],
      });
      sdk.start();
    },
    async shutdown() {
      await sdk?.shutdown();
    },
  };
}
export function startTelemetry(config: TelemetryConfig) {
  const telemetry = createTelemetry(config);
  telemetry.start();
  return telemetry;
}

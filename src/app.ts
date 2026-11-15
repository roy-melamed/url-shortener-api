/**
 * Fastify application factory — URL-7 (scaffolding).
 *
 * `buildApp` is the single, entrypoint-agnostic app used by BOTH runtimes
 * (dual-entrypoint, AD-12 / design §1.3, §2 D-2):
 *  - local:  `src/index.ts`   → `app.listen(...)`
 *  - Lambda: `src/lambda.ts`  → `aws-lambda-fastify(app)`
 *
 * Responsibilities landed here (design §5.1, §8.2):
 *  - consistent JSON error envelope carrying `requestId` on every error incl. 404;
 *  - `requestId` plumbing: honor a caller/API-Gateway `x-request-id` header,
 *    fall back to a generated ULID;
 *  - ONE structured JSON log line per request (FR-10.1 / §8.2) with a
 *    `requestId` field;
 *  - liveness endpoint `/healthz` (FR-10.2).
 *
 * Platform/entrypoint layer — may reference adapters; domain modules stay clean
 * (portability seam, design §3.9). No cloud SDK is imported here.
 */
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyError,
  type FastifyBaseLogger,
} from 'fastify';
import type { AppConfig } from './platform/config.ts';
import { createLogger, type AppLogger } from './platform/logger.ts';
import { ulid } from './platform/ulid.ts';
import { createReadiness, type ReadinessCheck } from './platform/readiness.ts';
import { context, trace, SpanKind, SpanStatusCode, type Span } from '@opentelemetry/api';
import { createObservability, queueSpanLink, type Observability } from './platform/telemetry.ts';
import { requestObservation } from './platform/request-observation.ts';
import {
  AppError,
  buildErrorEnvelope,
  codeForStatus,
  type ErrorDetail,
} from './platform/errors.ts';

export interface BuildAppOptions {
  config: AppConfig;
  /** Pre-built logger (tests / custom destinations). Defaults to config-driven. */
  logger?: AppLogger;
  readiness?: ReadinessCheck;
  observability?: Observability;
}

interface MappedError {
  statusCode: number;
  code: ReturnType<typeof codeForStatus>;
  message: string;
  details?: ErrorDetail[];
}

/**
 * Map any thrown value to the §5.1 error contract. Unknown/5xx errors are
 * collapsed to a safe `INTERNAL` message (no stack leakage — design §6.4);
 * only the safe error code is logged correlated by `requestId` (raw error
 * messages/stacks can contain credentials, SQL parameters or IPs).
 */
function mapError(error: unknown): MappedError {
  if (error instanceof AppError) {
    return {
      statusCode: error.statusCode,
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }

  const err = error as Partial<FastifyError>;

  // Fastify JSON-Schema validation failure → 400 VALIDATION_ERROR.
  if (Array.isArray(err.validation)) {
    const context = err.validationContext ?? 'body';
    const details: ErrorDetail[] = err.validation.map((issue) => ({
      field: issue.instancePath ? `${context}${issue.instancePath}` : context,
      issue: issue.message ?? 'is invalid',
    }));
    return {
      statusCode: 400,
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed.',
      details,
    };
  }

  const status = typeof err.statusCode === 'number' ? err.statusCode : 500;
  if (status >= 400 && status < 500) {
    return {
      statusCode: status,
      code: codeForStatus(status),
      message: err.message ?? 'Request could not be completed.',
    };
  }
  return { statusCode: 500, code: 'INTERNAL', message: 'Internal server error.' };
}

/**
 * Build the Fastify instance.
 *
 * @param options Configuration and optional logger.
 * @returns A ready-to-wire {@link FastifyInstance} (not yet `listen`/`ready`).
 */
export function buildApp({
  config,
  logger,
  readiness,
  observability = createObservability(),
}: BuildAppOptions): FastifyInstance {
  // Typed as FastifyBaseLogger so the instance keeps Fastify's default logger
  // generic (the pino AppLogger is structurally assignable to it).
  const baseLogger: FastifyBaseLogger = logger ?? createLogger(config);
  // Fastify 5: configure request-logging via a LogController instance instead of
  // the deprecated top-level `disableRequestLogging` (FSTDEP023). Binding the
  // request id under the `requestId` label (design §8.2) gives ONE canonical
  // correlation field — Fastify's default `reqId` label is not emitted.
  const logController = new LogController({
    disableRequestLogging: true, // we emit a single onResponse line (§8.2)
    requestIdLogLabel: 'requestId',
  });
  const app = Fastify({
    loggerInstance: baseLogger,
    logController,
    // Honor an API-Gateway/caller-provided correlation id when present; a
    // ULID is generated otherwise. Client-supplied ids are safe as correlation
    // ids only after a bounded identifier check; do not echo addresses/URLs.
    requestIdHeader: false,
    genReqId: (request) => {
      const id = request.headers['x-request-id'];
      return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id) ? id : ulid();
    },
  });
  const spans = new WeakMap<object, Span>();
  const errors = new WeakMap<object, string>();
  app.addHook('onRequest', (request, _reply, done) => {
    const parent = queueSpanLink({ traceparent: String(request.headers.traceparent ?? '') });
    const parentContext = parent
      ? trace.setSpanContext(context.active(), parent.context)
      : context.active();
    const span = trace
      .getTracer('url-shortener')
      .startSpan('http.request', { kind: SpanKind.SERVER }, parentContext);
    spans.set(request, span);
    context.with(trace.setSpan(context.active(), span), done);
  });

  // ONE structured JSON log line per request (FR-10.1, design §8.2). The
  // `requestId` field is already bound on `request.log` via requestIdLogLabel.
  app.addHook('onResponse', async (request, reply) => {
    const span = spans.get(request);
    const route = request.routeOptions?.url ?? 'unmatched';
    span?.setAttributes({
      'http.request.method': request.method,
      'http.route': route,
      'http.response.status_code': reply.statusCode,
    });
    if (reply.statusCode >= 500) span?.setStatus({ code: SpanStatusCode.ERROR });
    observability.request({
      method: request.method,
      route,
      status: reply.statusCode,
      durationMs: reply.elapsedTime,
    });
    request.log.info(
      {
        route: request.routeOptions?.url ?? 'unmatched',
        method: request.method,
        status: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime * 1000) / 1000,
        traceId: span?.spanContext().traceId ?? '00000000000000000000000000000000',
        ...requestObservation(request),
        ...(errors.has(request) ? { errorCode: errors.get(request) } : {}),
      },
      'request completed',
    );
    span?.end();
  });

  // Consistent error envelope (FR-7.2, design §5.1).
  app.setErrorHandler((error, request, reply) => {
    const mapped = mapError(error);
    errors.set(request, mapped.code);
    reply
      .status(mapped.statusCode)
      .send(buildErrorEnvelope(mapped.code, mapped.message, request.id, mapped.details));
  });

  // JSON 404 envelope for unmatched routes (design §3.1, §5.1).
  app.setNotFoundHandler((request, reply) => {
    errors.set(request, 'NOT_FOUND');
    reply
      .status(404)
      .send(
        buildErrorEnvelope(
          'NOT_FOUND',
          `Route ${request.method} ${request.url} not found.`,
          request.id,
        ),
      );
  });

  // Liveness — no dependency checks (FR-10.2, design §3.3/§8.5). Readiness
  // Readiness separately checks the configured direct/proxy DB seam.
  app.get('/healthz', async () => ({ status: 'ok' }));
  const dependency = readiness
    ? { check: readiness, close: async () => {} }
    : createReadiness(config);
  app.addHook('onClose', async () => dependency.close());
  app.get('/readyz', async (_request, reply) => {
    let ready = false;
    try {
      ready = await dependency.check();
    } catch {
      /* minimal redacted response */
    }
    reply.header('Cache-Control', 'no-store');
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ok' : 'unavailable' });
  });

  return app;
}

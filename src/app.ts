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
  type FastifyRequest,
  type FastifyReply,
} from 'fastify';
import type { AppConfig } from './platform/config.ts';
import {
  createLogger,
  requestCompletionEmitter,
  type AppLogger,
  type RequestCompletion,
} from './platform/logger.ts';
import { ulid } from './platform/ulid.ts';
import { registerPasswordAccountRoutes } from './auth/routes.ts';
import type { PasswordAccounts } from './auth/accounts.ts';
import { ApiKeys } from './auth/api-keys.ts';
import { BearerAuthentication } from './auth/bearer-auth.ts';
import { registerApiKeyRoutes } from './auth/api-key-routes.ts';
import type { LinkCreation } from './links/create.ts';
import { registerLinkCreation } from './links/routes.ts';
import type { InProcessRequestLimiter } from './platform/request-limiter.ts';
import { processRequestLimiter } from './platform/process-request-limiter.ts';
import {
  AppError,
  buildErrorEnvelope,
  codeForStatus,
  type ErrorDetail,
} from './platform/errors.ts';

export interface BuildAppOptions {
  config: AppConfig;
  /** Privacy-protected createLogger instance (tests/custom destinations). */
  logger?: AppLogger;
  /** Explicit account dependencies; no production key/mail/pool defaults. */
  accounts?: PasswordAccounts;
  /** Explicit shared URL-9 verifier/store injection; no secret discovery. */
  bearerAuth?: { authentication: BearerAuthentication; apiKeys: ApiKeys };
  links?: LinkCreation;
  /** Explicit process-owned shared override for tests/custom composition. */
  requestLimiter?: InProcessRequestLimiter;
}

interface MappedError {
  statusCode: number;
  code: ReturnType<typeof codeForStatus>;
  message: string;
  details?: ErrorDetail[];
  suggestions?: string[];
  retryAfterSeconds?: number;
}

/**
 * Map any thrown value to the §5.1 error contract. Unknown/5xx errors are
 * collapsed to a safe `INTERNAL` message (no stack leakage — design §6.4);
 * only the mapped code is included in the single completion record.
 */
function mapError(error: unknown): MappedError {
  if (error instanceof AppError) {
    return {
      statusCode: error.statusCode,
      code: error.code,
      message: error.message,
      details: error.details,
      suggestions: error.suggestions,
      retryAfterSeconds: error.retryAfterSeconds,
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
  accounts,
  bearerAuth,
  links,
  requestLimiter = processRequestLimiter,
}: BuildAppOptions): FastifyInstance {
  if (links && !bearerAuth)
    throw new Error('Link creation requires trusted bearer authentication.');
  // Typed as FastifyBaseLogger so the instance keeps Fastify's default logger
  // generic (the pino AppLogger is structurally assignable to it).
  const baseLogger: FastifyBaseLogger = logger ?? createLogger(config);
  const emitCompletion = requestCompletionEmitter(baseLogger as AppLogger);
  const errors = new WeakMap<object, MappedError['code']>();
  const completed = new WeakSet<object>();
  const complete = (
    request: FastifyRequest,
    reply: FastifyReply,
    durationMs = reply.elapsedTime,
  ) => {
    if (completed.has(request)) return;
    completed.add(request);
    let principal: RequestCompletion['principal'] = { type: 'anonymous', id: null };
    if (bearerAuth) {
      try {
        const trusted = bearerAuth.authentication.principal(request);
        principal = {
          type: trusted.kind,
          id: trusted.kind === 'apikey' ? trusted.keyId : trusted.userId,
        };
      } catch {
        // No established authentication context: headers cannot supply identity.
      }
    }
    emitCompletion({
      requestId: request.id,
      route: request.routeOptions?.url ?? 'unmatched',
      method: request.method,
      status: reply.statusCode,
      durationMs: Math.round(durationMs * 1000) / 1000,
      principal,
      ...(errors.has(request) ? { errorCode: errors.get(request) } : {}),
    });
  };
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
    // Correlation only, never identity. Reject duplicates, commas and oversized ids.
    requestIdHeader: false,
    genReqId: (request) => {
      const id = request.headers['x-request-id'];
      const count = request.rawHeaders.filter(
        (value, index) => index % 2 === 0 && value.toLowerCase() === 'x-request-id',
      ).length;
      return count === 1 && typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id)
        ? id
        : ulid();
    },
    // Router rejections occur before normal hooks. Preserve their existing wire
    // response while observing finish via the same exactly-once completion gate.
    frameworkErrors(error, request, reply) {
      const started = performance.now();
      const rejected =
        error.code === 'FST_ERR_BAD_URL' || error.code === 'FST_ERR_MAX_PARAM_LENGTH';
      const status = rejected ? (error.code === 'FST_ERR_BAD_URL' ? 400 : 414) : 500;
      errors.set(request, codeForStatus(status));
      reply.raw.once('finish', () => complete(request, reply, performance.now() - started));
      const body = JSON.stringify(
        rejected
          ? { error: 'Bad Request', code: error.code, message: error.message, statusCode: status }
          : {
              error: 'Internal Server Error',
              message: 'Unexpected error from async constraint',
              statusCode: 500,
            },
      );
      reply.raw.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      });
      reply.raw.end(body);
    },
  });

  // ONE canonical completion, independent of diagnostic level/child bindings.
  app.addHook('onResponse', async (request, reply) => {
    complete(request, reply);
  });

  // Consistent error envelope (FR-7.2, design §5.1).
  app.setErrorHandler((error, request, reply) => {
    const mapped = mapError(error);
    if (mapped.retryAfterSeconds !== undefined)
      reply.header('Retry-After', String(mapped.retryAfterSeconds));
    errors.set(request, mapped.code);
    reply
      .status(mapped.statusCode)
      .send(
        buildErrorEnvelope(
          mapped.code,
          mapped.message,
          request.id,
          mapped.details,
          mapped.suggestions,
        ),
      );
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
  // (`/readyz`, DB `SELECT 1`) lands with the DB pool ticket.
  app.get('/healthz', async () => ({ status: 'ok' }));

  if (accounts) registerPasswordAccountRoutes(app, accounts);
  if (bearerAuth) registerApiKeyRoutes(app, bearerAuth.authentication, bearerAuth.apiKeys);
  if (links && bearerAuth)
    registerLinkCreation(app, links, bearerAuth.authentication, requestLimiter);

  return app;
}

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
  type FastifyInstance,
  type FastifyError,
  type FastifyBaseLogger,
} from 'fastify';
import type { AppConfig } from './platform/config.js';
import { createLogger, type AppLogger } from './platform/logger.js';
import { ulid } from './platform/ulid.js';
import {
  AppError,
  buildErrorEnvelope,
  codeForStatus,
  type ErrorDetail,
} from './platform/errors.js';

export interface BuildAppOptions {
  config: AppConfig;
  /** Pre-built logger (tests / custom destinations). Defaults to config-driven. */
  logger?: AppLogger;
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
 * the full error is still logged correlated by `requestId`.
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
export function buildApp({ config, logger }: BuildAppOptions): FastifyInstance {
  // Typed as FastifyBaseLogger so the instance keeps Fastify's default logger
  // generic (the pino AppLogger is structurally assignable to it).
  const baseLogger: FastifyBaseLogger = logger ?? createLogger(config);
  const app = Fastify({
    loggerInstance: baseLogger,
    // We emit exactly one structured line per request in `onResponse`
    // (design §8.2) rather than Fastify's default req/res pair.
    disableRequestLogging: true,
    // Honor an API-Gateway/caller-provided correlation id when present; a
    // ULID is generated otherwise. Client-supplied ids are safe as correlation
    // ids because pino JSON-encodes values (no log injection — design §8.2).
    requestIdHeader: 'x-request-id',
    genReqId: () => ulid(),
  });

  // ONE structured JSON log line per request (FR-10.1, design §8.2).
  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        requestId: request.id,
        route: request.routeOptions?.url ?? 'unmatched',
        method: request.method,
        status: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime * 1000) / 1000,
      },
      'request completed',
    );
  });

  // Consistent error envelope (FR-7.2, design §5.1).
  app.setErrorHandler((error, request, reply) => {
    const mapped = mapError(error);
    if (mapped.statusCode >= 500) {
      request.log.error({ err: error, requestId: request.id }, 'unhandled error');
    }
    reply
      .status(mapped.statusCode)
      .send(buildErrorEnvelope(mapped.code, mapped.message, request.id, mapped.details));
  });

  // JSON 404 envelope for unmatched routes (design §3.1, §5.1).
  app.setNotFoundHandler((request, reply) => {
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

  return app;
}

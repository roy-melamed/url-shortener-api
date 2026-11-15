/**
 * Structured logging scaffold — URL-7 (scaffolding).
 *
 * FR-10.1 / design §8.2: pino emits structured JSON to stdout → CloudWatch in
 * AWS, stdout locally (NFR-8). One instrumentation path for cloud and local.
 *
 * The redact list keeps credentials out of logs (design §6.2/§8.2): the
 * `authorization` header and `set-cookie` response header are censored on every
 * line. Platform-only (no cloud SDK imports, design §3.9).
 */
import {
  pino,
  type Logger,
  type DestinationStream,
  type Bindings,
  type ChildLoggerOptions,
} from 'pino';
import type { AppConfig } from './config.ts';

export type AppLogger = Logger;

/** Paths censored on every log line (design §8.2: no credentials in logs). */
export const REDACT_PATHS = [
  'authorization',
  'set-cookie',
  '*.authorization',
  '*.set-cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  'password',
  'token',
  'refreshToken',
  'accessToken',
  'cookie',
];

/** Defence in depth: discard raw request/response/error objects, rather than
 * enumerate every possible header, IP spelling, SQL error or nested secret. */
const logFields = new Set([
  'requestId',
  'traceId',
  'route',
  'method',
  'status',
  'durationMs',
  'principal',
  'outcome',
  'errorCode',
  'signal',
  'port',
  ...REDACT_PATHS.filter((p) => !p.includes('.')),
]);
function safeFields(value: Record<string, unknown>): Record<string, unknown> {
  const safe = Object.fromEntries(
    Object.entries(value ?? {}).filter(([key]) => logFields.has(key)),
  );
  if (safe.principal) {
    const principal = safe.principal as { type?: unknown; id?: unknown };
    safe.principal =
      (principal.type === 'user' || principal.type === 'apikey') &&
      typeof principal.id === 'string' &&
      /^[0-9a-f-]{36}$/.test(principal.id)
        ? { type: principal.type, id: principal.id }
        : { type: 'anonymous', id: null };
  }
  if (safe.outcome) {
    const outcome = safe.outcome as Record<string, unknown>;
    safe.outcome = Object.fromEntries(
      Object.entries(outcome).filter(
        ([key, value]) =>
          (key === 'redirect' && ['active', 'expired', 'unknown'].includes(String(value))) ||
          (key === 'cache' && ['hit', 'miss'].includes(String(value))) ||
          (key === 'country' && ['resolved', 'none'].includes(String(value))),
      ),
    );
  }
  return safe;
}

function safeText(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, '[Redacted]')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '[Redacted]')
    .replace(/\[[0-9a-f:]+\](?::\d+)?/gi, '[Redacted]')
    .replace(/Bearer\s+\S+/gi, '[Redacted]');
}

export interface CreateLoggerOptions {
  /** Log destination (default stdout). Injectable for tests. */
  destination?: DestinationStream;
}

/** Pino intentionally resets its bindings formatter on child creation. Filter
 * before child serialization as well; otherwise a child binding bypasses log(). */
function protectChildren<Levels extends string>(
  logger: Logger<Levels>,
  rawChild: AppLogger['child'],
): Logger<Levels> {
  Object.defineProperty(logger, 'child', {
    configurable: true,
    value(bindings: Bindings, options?: ChildLoggerOptions<string>) {
      // Reflect preserves the original Pino implementation and its custom-level
      // options; only the structured bindings input is projected.
      const child = Reflect.apply(rawChild, logger, [
        safeFields(bindings),
        options,
      ]) as Logger<string>;
      return protectChildren(child, rawChild);
    },
  });
  return logger;
}

/**
 * Create the application logger from validated config.
 *
 * @param config Validated application configuration (`logLevel` drives level).
 * @param options Optional destination override (tests).
 */
export function createLogger(config: AppConfig, options: CreateLoggerOptions = {}): AppLogger {
  const logger = pino(
    {
      level: config.logLevel,
      timestamp: () => `,"timestamp":${JSON.stringify(new Date().toISOString())}`,
      base: undefined,
      hooks: {
        logMethod(args, method) {
          // Fastify startup messages can contain listen addresses; application
          // message templates are trusted, but redact addresses in string args.
          method.apply(
            this,
            args.map((arg) => (typeof arg === 'string' ? safeText(arg) : arg)) as typeof args,
          );
        },
      },
      formatters: { log: safeFields, bindings: safeFields },
      redact: { paths: REDACT_PATHS, censor: '[Redacted]' },
    },
    options.destination,
  );
  return protectChildren(logger, logger.child);
}

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
import { pino, type Logger, type DestinationStream } from 'pino';
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
];

export interface CreateLoggerOptions {
  /** Log destination (default stdout). Injectable for tests. */
  destination?: DestinationStream;
}

/**
 * Create the application logger from validated config.
 *
 * @param config Validated application configuration (`logLevel` drives level).
 * @param options Optional destination override (tests).
 */
export function createLogger(config: AppConfig, options: CreateLoggerOptions = {}): AppLogger {
  return pino(
    {
      level: config.logLevel,
      redact: { paths: REDACT_PATHS, censor: '[Redacted]' },
    },
    options.destination,
  );
}

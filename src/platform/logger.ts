/** Local structured logging. No request bodies, raw errors or free-text diagnostics. */
import { pino, type Logger, type DestinationStream } from 'pino';
import type { AppConfig } from './config.ts';
import { ERROR_CODES, type ErrorCode } from './errors.ts';

export type AppLogger = Logger;
export const REDACT_PATHS = ['authorization', 'set-cookie'];

export interface RequestCompletion {
  requestId: string;
  route: string;
  method: string;
  status: number;
  durationMs: number;
  principal: { type: 'user' | 'apikey'; id: string } | { type: 'anonymous'; id: null };
  errorCode?: ErrorCode;
}

interface LogState {
  readonly failures: number;
  failed: () => void;
  emit: (record: RequestCompletion) => void;
}
const states = new WeakMap<AppLogger, LogState>();
const sinks = new WeakMap<
  DestinationStream,
  { failures: number; destination: DestinationStream }
>();
const identifier = /^[a-zA-Z0-9_-]{1,128}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const messages = new Set([
  'shutting down',
  'error during shutdown',
  'server listening',
  'failed to start server',
  'Database connection unavailable.',
]);

/** Project, never recursively serialize caller objects (including child bindings). */
function diagnosticFields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  const { requestId, signal, port } = input;
  if (typeof requestId === 'string' && identifier.test(requestId)) output.requestId = requestId;
  if (signal === 'SIGINT' || signal === 'SIGTERM') output.signal = signal;
  if (typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535)
    output.port = port;
  for (const key of REDACT_PATHS) if (Object.hasOwn(input, key)) output[key] = '[Redacted]';
  return output;
}

/** Child options cannot replace serializers/hooks or introduce unsafe mixins. */
function protectChildren(
  logger: AppLogger,
  state: LogState,
  rawChild = logger.child,
  rawSetBindings = logger.setBindings,
): AppLogger {
  states.set(logger, state);
  logger.setBindings = function (bindings) {
    try {
      Reflect.apply(rawSetBindings, this, [diagnosticFields(bindings)]);
    } catch {
      state.failed();
    }
  };
  Object.defineProperty(logger, 'child', {
    configurable: true,
    value(this: AppLogger, bindings: Record<string, unknown>) {
      let safe: Record<string, unknown>;
      try {
        safe = diagnosticFields(bindings);
      } catch {
        state.failed();
        safe = {};
      }
      const child = Reflect.apply(rawChild, this, [safe]) as AppLogger;
      return protectChildren(child, state, rawChild, rawSetBindings);
    },
  });
  return logger;
}

export interface CreateLoggerOptions {
  /** Synchronous write seam; failed writes are dropped, never retried or echoed. */
  destination?: DestinationStream;
}

export function createLogger(config: AppConfig, options: CreateLoggerOptions = {}): AppLogger {
  const target = options.destination ?? process.stdout;
  let sink = sinks.get(target);
  if (!sink) {
    sink = { failures: 0, destination: { write() {} } };
    const current = sink;
    const failWrite = () => {
      current.failures = Math.min(Number.MAX_SAFE_INTEGER, current.failures + 1);
    };
    let backpressured = false;
    if ('on' in target && typeof target.on === 'function') {
      target.on('error', failWrite);
      target.on('drain', () => {
        backpressured = false;
      });
    }
    current.destination = {
      write(chunk: string) {
        if (backpressured) {
          failWrite();
          return;
        }
        try {
          // Pino metadata-aware destinations (including multistream) require these
          // fields on their own receiver. Only already-projected log data reaches it.
          if (Reflect.get(target, Symbol.for('pino.metadata')) === true) {
            for (const key of ['lastLevel', 'lastTime', 'lastMsg', 'lastObj', 'lastLogger'])
              Reflect.set(target, key, Reflect.get(current.destination, key));
          }
          const accepted: unknown = target.write(chunk);
          if (accepted === false) backpressured = true;
        } catch {
          failWrite();
        }
      },
    };
    if (Reflect.get(target, Symbol.for('pino.metadata')) === true)
      Object.defineProperty(current.destination, Symbol.for('pino.metadata'), { value: true });
    const flush = Reflect.get(target, 'flush');
    if (typeof flush === 'function')
      Object.defineProperty(current.destination, 'flush', {
        value(callback?: (error?: Error) => void) {
          let completed = false;
          const done = (error?: unknown) => {
            if (completed) return;
            completed = true;
            if (error) failWrite();
            callback?.(error ? new Error('Log emission failed.') : undefined);
          };
          try {
            Reflect.apply(flush, target, [done]);
          } catch {
            if (completed) failWrite();
            else done(true);
          }
        },
      });
    const flushSync = Reflect.get(target, 'flushSync');
    if (typeof flushSync === 'function')
      Object.defineProperty(current.destination, 'flushSync', {
        value() {
          try {
            Reflect.apply(flushSync, target, []);
          } catch {
            failWrite();
          }
        },
      });
    sinks.set(target, current);
  }
  const current = sink;
  const failed = () => {
    current.failures = Math.min(Number.MAX_SAFE_INTEGER, current.failures + 1);
  };
  const state: LogState = {
    get failures() {
      return current.failures;
    },
    failed,
    emit: () => {},
  };
  const destination = current.destination;
  const common = {
    base: undefined,
    timestamp: () => `,"timestamp":${JSON.stringify(new Date().toISOString())}`,
  };
  // Independent channel: diagnostic verbosity must never suppress completion records.
  // Never bind request.log children here: identity and route come from trusted context.
  const completion = pino({ ...common, level: 'info' }, destination);
  state.emit = (record) => {
    try {
      const principal = record.principal;
      completion.info(
        {
          requestId: identifier.test(record.requestId) ? record.requestId : 'invalid',
          traceId: null,
          route: /^\/[a-zA-Z0-9/_:.*-]{0,200}$/.test(record.route) ? record.route : 'unmatched',
          method: /^[A-Z]{1,20}$/.test(record.method) ? record.method : 'UNKNOWN',
          status: record.status,
          durationMs:
            Number.isFinite(record.durationMs) && record.durationMs >= 0 ? record.durationMs : 0,
          principal:
            (principal.type === 'user' || principal.type === 'apikey') && uuid.test(principal.id)
              ? { type: principal.type, id: principal.id }
              : { type: 'anonymous', id: null },
          outcome: {
            http:
              record.status >= 500
                ? 'server_error'
                : record.status >= 400
                  ? 'client_error'
                  : 'success',
          },
          ...(record.errorCode && ERROR_CODES.includes(record.errorCode)
            ? { errorCode: record.errorCode }
            : {}),
        },
        'request completed',
      );
    } catch {
      failed();
    }
  };
  const logger = pino(
    {
      ...common,
      level: config.logLevel,
      hooks: {
        logMethod(args, method) {
          try {
            const message = typeof args[0] === 'string' ? args[0] : args[1];
            method.call(
              this,
              diagnosticFields(args[0]),
              typeof message === 'string' && messages.has(message) ? message : 'diagnostic',
            );
          } catch {
            failed();
          }
        },
      },
    },
    destination,
  );
  return protectChildren(logger, state);
}

/** Bind once at construction; reject an unprotected arbitrary logger explicitly. */
export function requestCompletionEmitter(logger: AppLogger): (record: RequestCompletion) => void {
  const state = states.get(logger);
  if (!state) throw new Error('HTTP logging requires createLogger.');
  return state.emit;
}

/** Saturating local per-destination failure count, shared by children; no endpoint. */
export function logEmissionFailureCount(logger: AppLogger): number {
  return states.get(logger)?.failures ?? 0;
}

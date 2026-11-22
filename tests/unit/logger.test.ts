import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/platform/config.ts';
import {
  createLogger,
  logEmissionFailureCount,
  requestCompletionEmitter,
} from '../../src/platform/logger.ts';
import { EventEmitter } from 'node:events';
import { pino } from 'pino';

const baseEnv = { DATABASE_URL: 'postgres://user:pass@localhost:5432/urlshortener' };

class MemoryDestination {
  readonly chunks: string[] = [];
  write(chunk: string): void {
    this.chunks.push(chunk);
  }
  get text(): string {
    return this.chunks.join('');
  }
  parsedLines(): Record<string, unknown>[] {
    return this.text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

describe('createLogger (FR-10.1, design §8.2)', () => {
  it('emits structured JSON to the injected destination', () => {
    const destination = new MemoryDestination();
    const logger = createLogger(loadConfig(baseEnv), { destination });
    logger.info({ requestId: 'abc' }, 'hello');
    const [line] = destination.parsedLines();
    expect(line).toMatchObject({ requestId: 'abc', msg: 'diagnostic' });
    expect(typeof line!.timestamp).toBe('string');
  });

  it('redacts the authorization header and set-cookie (design §6.2/§8.2)', () => {
    const destination = new MemoryDestination();
    const logger = createLogger(loadConfig(baseEnv), { destination });
    logger.info({ authorization: 'Bearer secret-token' }, 'req');
    logger.info({ 'set-cookie': 'session=abc' }, 'res');
    const [authLine, cookieLine] = destination.parsedLines();
    expect(authLine).toMatchObject({ authorization: '[Redacted]' });
    expect(cookieLine).toMatchObject({ 'set-cookie': '[Redacted]' });
    expect(destination.text).not.toContain('secret-token');
  });

  it('honours the configured log level', () => {
    const destination = new MemoryDestination();
    const logger = createLogger(loadConfig({ ...baseEnv, LOG_LEVEL: 'warn' }), { destination });
    logger.info('ignored');
    expect(destination.parsedLines()).toHaveLength(0);
    logger.warn('kept');
    expect(destination.parsedLines()).toHaveLength(1);
  });

  it('projects nested objects, child bindings, interpolation and errors without free text', () => {
    const destination = new MemoryDestination();
    const logger = createLogger(loadConfig(baseEnv), { destination });
    const secret =
      'PRIVATE-password-token-cookie-198.51.100.22-https://private.invalid/?secret=value';
    const data = {
      req: { headers: { authorization: secret } },
      nested: { password: secret },
      err: new Error(secret),
      principal: { type: 'user', id: secret },
      traceId: secret,
      route: secret,
    };
    logger.info(data, secret);
    logger.error(new Error(secret));
    logger.warn('%s', secret);
    const child = logger.child(data, { serializers: { secret: () => secret } });
    logger.setBindings(data);
    child.setBindings({ nested: { secret }, token: secret });
    child.child({ secret }).error({ secret }, secret);
    const throwing = {
      get requestId(): string {
        throw new Error(secret);
      },
    };
    logger.info(throwing);
    expect(logEmissionFailureCount(logger)).toBe(1);
    expect(destination.text).not.toContain(secret);
    for (const line of destination.parsedLines()) {
      expect(Object.keys(line).sort()).toEqual(['level', 'msg', 'timestamp']);
      expect(line.msg).toBe('diagnostic');
    }
  });

  it('uses a bounded failure path with no fallback or retry and shares counts with children', () => {
    let attempts = 0;
    const logger = createLogger(loadConfig(baseEnv), {
      destination: {
        write() {
          attempts++;
          throw new Error('PRIVATE sink failure');
        },
      },
    });
    expect(() => logger.error({ err: new Error('PRIVATE') }, 'PRIVATE')).not.toThrow();
    const child = logger.child({ requestId: 'safe' });
    expect(() => child.warn('PRIVATE')).not.toThrow();
    expect(attempts).toBe(2);
    expect(logEmissionFailureCount(logger)).toBe(2);
    expect(logEmissionFailureCount(child)).toBe(2);
  });

  it('observes asynchronous stream errors without accumulating listeners or serializing errors', () => {
    class Sink extends EventEmitter {
      write() {}
    }
    const sink = new Sink();
    const first = createLogger(loadConfig(baseEnv), { destination: sink });
    const second = createLogger(loadConfig(baseEnv), { destination: sink });
    expect(sink.listenerCount('error')).toBe(1);
    sink.emit('error', new Error('PRIVATE async sink failure'));
    expect(logEmissionFailureCount(first)).toBe(1);
    expect(logEmissionFailureCount(second)).toBe(1);
  });

  it('bounds invalid durations and refuses an unprotected custom logger', () => {
    const destination = new MemoryDestination();
    const logger = createLogger(loadConfig(baseEnv), { destination });
    const emit = requestCompletionEmitter(logger);
    for (const durationMs of [NaN, Infinity, -1])
      emit({
        requestId: 'safe',
        route: 'unmatched',
        method: 'GET',
        status: 200,
        durationMs,
        principal: { type: 'anonymous', id: null },
      });
    expect(destination.parsedLines().map((line) => line.durationMs)).toEqual([0, 0, 0]);
    expect(() => requestCompletionEmitter(pino({ enabled: false }))).toThrow(
      'HTTP logging requires createLogger.',
    );
  });

  it('projects invalid canonical fields and child getters without exposing them', () => {
    const destination = new MemoryDestination();
    const logger = createLogger(loadConfig(baseEnv), { destination });
    logger.info({ signal: 'SIGTERM', port: 8080 }, 'shutting down');
    expect(destination.parsedLines()[0]).toMatchObject({
      signal: 'SIGTERM',
      port: 8080,
      msg: 'shutting down',
    });
    const child = logger.child({
      get requestId(): string {
        throw new Error('PRIVATE child');
      },
    });
    child.info('PRIVATE');
    expect(logEmissionFailureCount(logger)).toBe(1);
    requestCompletionEmitter(logger)({
      requestId: 'PRIVATE.invalid',
      route: '/?PRIVATE',
      method: 'PRIVATE.invalid',
      status: 200,
      durationMs: 1,
      principal: { type: 'user', id: 'PRIVATE.invalid' },
    });
    expect(destination.parsedLines().at(-1)).toMatchObject({
      requestId: 'invalid',
      route: 'unmatched',
      method: 'UNKNOWN',
      principal: { type: 'anonymous', id: null },
    });
    expect(destination.text).not.toContain('PRIVATE');
  });

  it('snapshots projected diagnostic values once rather than serializing changing getters', () => {
    const destination = new MemoryDestination();
    const logger = createLogger(loadConfig(baseEnv), { destination });
    let reads = 0;
    logger.info({
      get requestId() {
        return ++reads === 1 ? 'safe' : { password: 'PRIVATE' };
      },
    });
    expect(reads).toBe(1);
    expect(destination.parsedLines()[0]).toMatchObject({ requestId: 'safe' });
    expect(destination.text).not.toContain('PRIVATE');
  });

  it('keeps nested child binding changes local without changing the parent', () => {
    const destination = new MemoryDestination();
    const logger = createLogger(loadConfig(baseEnv), { destination });
    const child = logger.child({ requestId: 'first' });
    const nested = child.child({ requestId: 'nested' });
    nested.setBindings({ requestId: 'updated', password: 'PRIVATE' });
    logger.info('diagnostic');
    child.info('diagnostic');
    nested.info('diagnostic');
    expect(destination.parsedLines().map((line) => line.requestId)).toEqual([
      undefined,
      'first',
      'updated',
    ]);
    expect(destination.text).not.toContain('PRIVATE');
  });

  it('contains binding and completion projection failures without a raw fallback', () => {
    const destination = new MemoryDestination();
    const logger = createLogger(loadConfig(baseEnv), { destination });
    logger.setBindings({
      get requestId(): never {
        throw new Error('PRIVATE bindings');
      },
    });
    expect(() =>
      requestCompletionEmitter(logger)({
        requestId: 'safe',
        route: '/safe',
        method: 'GET',
        status: 200,
        durationMs: 1,
        get principal(): never {
          throw new Error('PRIVATE completion');
        },
      }),
    ).not.toThrow();
    expect(logEmissionFailureCount(logger)).toBe(2);
    expect(destination.text).toBe('');
  });

  it('drops rather than queues behind sink backpressure and resumes only after drain', () => {
    class Sink extends EventEmitter {
      writes = 0;
      write() {
        this.writes++;
        return false;
      }
    }
    const sink = new Sink();
    const logger = createLogger(loadConfig(baseEnv), { destination: sink });
    logger.info('diagnostic');
    for (let i = 0; i < 100; i++) logger.info('diagnostic');
    expect(sink.writes).toBe(1);
    expect(logEmissionFailureCount(logger)).toBe(100);
    sink.emit('drain');
    logger.info('diagnostic');
    expect(sink.writes).toBe(2);
    expect(logEmissionFailureCount(logger)).toBe(100);
    expect(sink.listenerCount('drain')).toBe(1);
  });
});

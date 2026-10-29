import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/platform/config.ts';
import { createLogger } from '../../src/platform/logger.ts';

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
    expect(line).toMatchObject({ requestId: 'abc', msg: 'hello' });
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
});

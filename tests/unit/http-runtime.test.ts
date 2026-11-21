import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRuntimeApp } from '../../src/platform/http-runtime.ts';
import { JoseAccessTokenVerifier } from '../../src/auth/crypto.ts';
import {
  runtimeFixtureEnvironment,
  runtimeFixtureTokens,
} from '../helpers/http-runtime-environment.ts';

afterEach(() => {
  vi.restoreAllMocks();
});
describe('production HTTP runtime composition', () => {
  it('registers real routes with lazy real persistence, no anonymous DB access, and owned pool shutdown', async () => {
    const query = vi.spyOn(Pool.prototype, 'query'),
      connect = vi.spyOn(Pool.prototype, 'connect'),
      end = vi.spyOn(Pool.prototype, 'end');
    const { app, config } = buildRuntimeApp(runtimeFixtureEnvironment());
    try {
      expect(config.nodeEnv).toBe('test');
      const response = await app.inject({
        method: 'POST',
        url: '/v1/links',
        payload: { destinationUrl: 'https://destination.invalid/' },
        headers: { 'x-request-id': 'runtime-unit' },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().error).toMatchObject({
        code: 'UNAUTHENTICATED',
        requestId: 'runtime-unit',
      });
      expect((await app.inject({ url: '/healthz' })).statusCode).toBe(200);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/links',
            payload: { destinationUrl: 'https://destination.invalid/' },
            headers: { authorization: 'Bearer forged', 'x-user-id': 'forged-user' },
          })
        ).statusCode,
      ).toBe(401);
      expect(query).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
      expect(end).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
    expect(end).toHaveBeenCalledTimes(1);
  });
  it('redacts idle pool failures instead of logging driver/credential details', async () => {
    const on = vi.spyOn(Pool.prototype, 'on');
    const { app } = buildRuntimeApp(runtimeFixtureEnvironment());
    try {
      const log = vi.spyOn(app.log, 'error');
      const callback = on.mock.calls.find((call) => call[0] === 'error')![1] as (
        error: Error,
      ) => void;
      callback(new Error('private SQL/password'));
      expect(log).toHaveBeenCalledExactlyOnceWith('Database connection unavailable.');
    } finally {
      await app.close();
    }
  });
  it.each(['PUBLIC_BASE_URL', 'JWT_PUBLIC_KEY_PEM', 'JWT_ISSUER', 'JWT_AUDIENCE', 'JWT_KEY_ID'])(
    'fails closed before creating a pool if %s is missing',
    (name) => {
      const environment = runtimeFixtureEnvironment();
      delete environment[name];
      const connect = vi.spyOn(Pool.prototype, 'connect');
      expect(() => buildRuntimeApp(environment)).toThrow('Invalid HTTP runtime configuration');
      expect(connect).not.toHaveBeenCalled();
    },
  );
  it.each([
    'ftp://short.invalid',
    'https://user:private@short.invalid',
    'https://short.invalid/path',
    'https://short.invalid?query',
    'https://short.invalid#hash',
    'not-a-url',
  ])('rejects invalid origin without echoing configuration %#', (PUBLIC_BASE_URL) => {
    expect(() => buildRuntimeApp(runtimeFixtureEnvironment({ PUBLIC_BASE_URL }))).toThrow(
      'Invalid HTTP runtime configuration',
    );
  });
  it('rejects malformed, non-RSA and private PEM with fixed configuration errors', () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    for (const key of [
      'PRIVATE_VALUE_NOT_A_KEY',
      ec.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      ec.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    ]) {
      expect(() => buildRuntimeApp(runtimeFixtureEnvironment({ JWT_PUBLIC_KEY_PEM: key }))).toThrow(
        'Invalid HTTP runtime configuration',
      );
    }
  });
  it('reuses strict URL-9 verification without granting the runtime signing capability', async () => {
    const env = runtimeFixtureEnvironment();
    const verifier = new JoseAccessTokenVerifier({
      publicKey: createPublicKey(env.JWT_PUBLIC_KEY_PEM!),
      issuer: env.JWT_ISSUER!,
      audience: env.JWT_AUDIENCE!,
      kid: env.JWT_KEY_ID!,
    });
    const id = '11111111-1111-4111-8111-111111111111',
      now = new Date();
    const token = await runtimeFixtureTokens.issue(id, now);
    expect(await verifier.verify(token, now)).toBe(id);
    expect(verifier).not.toHaveProperty('issue');
    await expect(verifier.verify(token, new Date(now.getTime() + 900_000))).rejects.toMatchObject({
      statusCode: 401,
    });
    await expect(verifier.verify(token.slice(0, -10) + 'xxxxxxxxxx', now)).rejects.toMatchObject({
      statusCode: 401,
    });
  });
});

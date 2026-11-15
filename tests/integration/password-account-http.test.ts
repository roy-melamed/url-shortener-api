import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { loadConfig } from '../../src/platform/config.ts';
import { PasswordAccounts } from '../../src/auth/accounts.ts';
import { JoseAccessTokens } from '../../src/auth/crypto.ts';
import { MemoryAccountStore } from '../helpers/account-memory-store.ts';
import type { VerificationMessage } from '../../src/auth/contracts.ts';
import { createLogger } from '../../src/platform/logger.ts';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const config = loadConfig({ DATABASE_URL: 'fixture-only', LOG_LEVEL: 'silent' });
function fixture() {
  const store = new MemoryAccountStore();
  const messages: VerificationMessage[] = [];
  const accessTokens = new JoseAccessTokens({
    ...keys,
    issuer: 'fixture-issuer',
    audience: 'fixture-api',
    kid: 'fixture-key',
  });
  const accounts = new PasswordAccounts({
    store,
    accessTokens,
    passwords: {
      hash: async (value) => `fixture-hash:${value}`,
      verify: async (value, hash) => hash === `fixture-hash:${value}`,
    },
    mailer: {
      sendVerification: async (message) => {
        messages.push(message);
      },
    },
    emailTokenTtlMs: 60_000,
    refreshTokenTtlMs: 120_000,
  });
  return { app: buildApp({ config, accounts }), store, messages, accounts };
}
const input = { email: 'person@example.invalid', password: 'fixture-password-long' };
describe('password-account HTTP endpoints (no social/key/creation middleware)', () => {
  it('delete uses the signed owner, never a client-supplied other account ID', async () => {
    const f = fixture();
    try {
      const owner = await f.accounts.register(input);
      const other = await f.accounts.register({ ...input, email: 'other@example.invalid' });
      const session = await f.accounts.login(input);
      const deleted = await f.app.inject({
        method: 'DELETE',
        url: '/v1/me',
        payload: { userId: other.id },
        headers: { authorization: `Bearer ${session.accessToken}` },
      });
      expect(deleted.statusCode).toBe(204);
      expect(f.store.accounts.has(owner.id)).toBe(false);
      expect(f.store.accounts.has(other.id)).toBe(true);
    } finally {
      await f.app.close();
    }
  });
  it('request logs omit passwords, verification/refresh tokens and session authorization', async () => {
    const f = fixture();
    const chunks: string[] = [];
    const loggingConfig = loadConfig({ DATABASE_URL: 'fixture-only', LOG_LEVEL: 'info' });
    const app = buildApp({
      config: loggingConfig,
      accounts: f.accounts,
      logger: createLogger(loggingConfig, {
        destination: {
          write: (chunk: string) => {
            chunks.push(chunk);
          },
        },
      }),
    });
    try {
      await app.inject({ method: 'POST', url: '/v1/users', payload: input });
      const session = await f.accounts.login(input);
      await app.inject({
        method: 'POST',
        url: '/v1/auth/emails/verify',
        payload: { token: f.messages[0]!.token },
      });
      await app.inject({
        method: 'POST',
        url: '/v1/auth/tokens/refresh',
        payload: { token: session.refreshToken },
      });
      await app.inject({
        method: 'DELETE',
        url: '/v1/me',
        headers: { authorization: `Bearer ${session.accessToken}` },
      });
      const log = chunks.join('');
      expect(log).toContain('request completed');
      for (const secret of [
        input.password,
        f.messages[0]!.token,
        session.refreshToken,
        session.accessToken,
      ])
        expect(log).not.toContain(secret);
    } finally {
      await app.close();
      await f.app.close();
    }
  });
  it('register -> confirm -> login -> rotate -> replay -> delete, with real signed session JWT', async () => {
    const f = fixture();
    try {
      const created = await f.app.inject({ method: 'POST', url: '/v1/users', payload: input });
      expect(created.statusCode).toBe(201);
      expect(created.json().emailVerified).toBe(false);
      expect(created.body).not.toContain(input.password);
      expect(created.body).not.toContain('passwordHash');
      const confirmed = await f.app.inject({
        method: 'POST',
        url: '/v1/auth/emails/verify',
        payload: { token: f.messages[0]!.token },
      });
      expect(confirmed.statusCode).toBe(204);
      expect(confirmed.body).toBe('');
      const login = await f.app.inject({
        method: 'POST',
        url: '/v1/auth/sessions',
        payload: input,
      });
      expect(login.statusCode).toBe(200);
      expect(login.headers['cache-control']).toBe('no-store');
      expect(login.headers.pragma).toBe('no-cache');
      expect(login.json().expiresIn).toBe(900);
      const refresh = await f.app.inject({
        method: 'POST',
        url: '/v1/auth/tokens/refresh',
        payload: { token: login.json().refreshToken },
      });
      expect(refresh.statusCode).toBe(200);
      expect(refresh.json().refreshToken).not.toBe(login.json().refreshToken);
      const replay = await f.app.inject({
        method: 'POST',
        url: '/v1/auth/tokens/refresh',
        payload: { token: login.json().refreshToken },
      });
      expect(replay.statusCode).toBe(401);
      const successor = await f.app.inject({
        method: 'POST',
        url: '/v1/auth/tokens/refresh',
        payload: { token: refresh.json().refreshToken },
      });
      expect(successor.statusCode).toBe(401);
      const deleted = await f.app.inject({
        method: 'DELETE',
        url: '/v1/me',
        headers: { authorization: `Bearer ${login.json().accessToken}` },
      });
      expect(deleted.statusCode).toBe(204);
      expect(f.store.accounts.size).toBe(0);
      expect(
        (
          await f.app.inject({
            method: 'DELETE',
            url: '/v1/me',
            headers: { authorization: `Bearer ${login.json().accessToken}` },
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      await f.app.close();
    }
  });
  it('rejects wrong/missing/malformed data and tokens without changing other accounts', async () => {
    const f = fixture();
    try {
      for (const payload of [
        {},
        { email: 'invalid', password: input.password },
        { ...input, password: 'short' },
      ]) {
        expect((await f.app.inject({ method: 'POST', url: '/v1/users', payload })).statusCode).toBe(
          400,
        );
      }
      await f.app.inject({ method: 'POST', url: '/v1/users', payload: input });
      expect(
        (await f.app.inject({ method: 'POST', url: '/v1/users', payload: input })).statusCode,
      ).toBe(409);
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: '/v1/auth/sessions',
            payload: { ...input, password: 'wrong' },
          })
        ).statusCode,
      ).toBe(401);
      for (const url of ['/v1/auth/tokens/refresh', '/v1/auth/emails/verify']) {
        expect((await f.app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(400);
        const result = await f.app.inject({
          method: 'POST',
          url,
          payload: { token: 'private-invalid' },
          headers: { 'x-request-id': 'fixture-id' },
        });
        expect(result.statusCode).toBe(401);
        expect(result.json().error.requestId).toBe('fixture-id');
        expect(result.body).not.toContain('private-invalid');
      }
      for (const authorization of [
        undefined,
        'Basic private',
        'Bearer invalid',
        'Bearer ' + 'x'.repeat(8200),
      ]) {
        const result = await f.app.inject({
          method: 'DELETE',
          url: '/v1/me',
          headers: authorization ? { authorization } : {},
        });
        expect(result.statusCode).toBe(401);
      }
      expect(f.store.accounts.size).toBe(1);
      expect((await f.app.inject('/v1/auth/api-keys')).statusCode).toBe(404);
      expect(
        (await f.app.inject({ method: 'POST', url: '/v1/links', payload: {} })).statusCode,
      ).toBe(404);
    } finally {
      await f.app.close();
    }
  });
  it('encoded auth endpoint aliases retain no-store; provider failure is redacted', async () => {
    const f = fixture();
    vi.spyOn(f.accounts, 'register').mockRejectedValue(new Error('private-provider-details'));
    try {
      const response = await f.app.inject({ method: 'POST', url: '/%76%31/users', payload: input });
      expect(response.statusCode).toBe(500);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).not.toContain('private-provider-details');
    } finally {
      await f.app.close();
    }
  });
});

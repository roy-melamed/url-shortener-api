import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { decodeJwt, decodeProtectedHeader, SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ArgonPasswords,
  JoseAccessTokens,
  newOpaqueToken,
  parseOpaqueToken,
  tokenHashMatches,
} from '../../src/auth/crypto.ts';
import type { AccessTokenOptions } from '../../src/auth/crypto.ts';
import { AppError } from '../../src/platform/errors.ts';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const options: AccessTokenOptions = {
  ...keys,
  issuer: 'https://session.test',
  audience: 'password-account',
  kid: 'ephemeral-test-key',
};
const now = new Date('2026-01-01T00:00:00.000Z');
const issuedAt = now.getTime() / 1000;
const userId = randomUUID();
const sessions = new JoseAccessTokens(options);

afterEach(() => vi.restoreAllMocks());

describe('ArgonPasswords', () => {
  it('uses real argon2id, the approved costs, random salts and a 32-byte hash', async () => {
    const passwords = new ArgonPasswords();
    const first = await passwords.hash('ephemeral password fixture');
    const second = await passwords.hash('ephemeral password fixture');
    expect(first).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    expect(Buffer.from(first.split('$')[5]!, 'base64')).toHaveLength(32);
    expect(first.split('$')[4]).not.toBe(second.split('$')[4]);
    expect(await argon2.verify(first, 'ephemeral password fixture')).toBe(true);
    expect(await passwords.verify('ephemeral password fixture', first)).toBe(true);
    expect(await passwords.verify('wrong fixture', first)).toBe(false);
    expect(await passwords.verify('secret not echoed', 'malformed hash')).toBe(false);
  });

  it('actually verifies a cached per-instance, randomly generated dummy for missing hashes', async () => {
    const verify = vi.spyOn(argon2, 'verify');
    const hash = vi.spyOn(argon2, 'hash');
    const passwords = new ArgonPasswords();
    expect(await passwords.verify('unknown account fixture', null)).toBe(false);
    expect(await passwords.verify('social account fixture', null)).toBe(false);
    expect(hash).toHaveBeenCalledTimes(1);
    expect(Buffer.isBuffer(hash.mock.calls[0]![0])).toBe(true);
    expect(hash.mock.calls[0]![0]).toHaveLength(32);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(verify.mock.calls[0]![0]).toBe(verify.mock.calls[1]![0]);
    await new ArgonPasswords().verify('another fixture', null);
    expect(verify.mock.calls[2]![0]).not.toBe(verify.mock.calls[0]![0]);
    verify.mockResolvedValueOnce(true);
    expect(await passwords.verify('even an accidental match', null)).toBe(false);
  });
});

async function signed(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
  omitted: string[] = [],
): Promise<string> {
  const payload: Record<string, unknown> = {
    sub: userId,
    jti: randomUUID(),
    iat: issuedAt,
    exp: issuedAt + 900,
    iss: options.issuer,
    aud: options.audience,
    ...claims,
  };
  for (const name of omitted) delete payload[name];
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: options.kid, ...header })
    .sign(keys.privateKey);
}

async function expectInvalidSession(token: unknown, date = now): Promise<void> {
  const error = await sessions.verify(token as string, date).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(AppError);
  expect(error).toMatchObject({
    statusCode: 401,
    code: 'UNAUTHENTICATED',
    message: 'Invalid session.',
  });
  expect(error).not.toHaveProperty('cause');
}

describe('JoseAccessTokens', () => {
  it('issues real RS256 signatures with exact claims, UUID IDs and a 15-minute lifetime', async () => {
    const token = await sessions.issue(userId, now);
    expect(decodeProtectedHeader(token)).toEqual({ alg: 'RS256', typ: 'JWT', kid: options.kid });
    expect(decodeJwt(token)).toMatchObject({
      sub: userId,
      iss: options.issuer,
      aud: options.audience,
      iat: issuedAt,
      exp: issuedAt + 900,
    });
    expect(decodeJwt(token).jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(decodeJwt(await sessions.issue(userId, now)).jti).not.toBe(decodeJwt(token).jti);
    expect(await sessions.verify(token, now)).toBe(userId);
    expect(await sessions.verify(token, new Date(now.getTime() + 899999))).toBe(userId);
    await expectInvalidSession(token, new Date(now.getTime() + 900000));
    await expectInvalidSession(token, new Date(now.getTime() - 1000));
    await expectInvalidSession(token, new Date(NaN));
  });

  it.each([null, 1, '', 'not.a.jwt', 'a'.repeat(8193), ' leading-space'])(
    'rejects malformed token %#',
    async (token) => {
      await expectInvalidSession(token);
    },
  );

  it.each([
    { iss: 'wrong issuer' },
    { aud: 'wrong audience' },
    { sub: 'not-uuid' },
    { sub: userId.toUpperCase() },
    { sub: `${userId}\n` },
    { jti: 'not-uuid' },
    { iat: issuedAt + 1, exp: issuedAt + 901 },
    { exp: issuedAt + 899 },
    { iat: issuedAt - 0.5, exp: issuedAt + 899.5 },
    { iat: 'date' },
    { exp: 'date' },
    { nbf: issuedAt + 10 },
  ])('rejects invalid signed claims %#', async (claims) => {
    await expectInvalidSession(await signed(claims));
  });

  it.each(['sub', 'iat', 'exp', 'jti', 'iss', 'aud'])('requires %s', async (claim) => {
    await expectInvalidSession(await signed({}, {}, [claim]));
  });

  it.each([{ typ: 'at+jwt' }, { typ: 'jwt' }, { kid: 'wrong' }, { alg: 'RS512' }])(
    'pins headers %#',
    async (header) => {
      await expectInvalidSession(await signed({}, header));
    },
  );

  it('rejects tampering, foreign signatures and unsigned/HS256 tokens', async () => {
    const token = await sessions.issue(userId, now);
    const parts = token.split('.');
    parts[1] = Buffer.from(JSON.stringify({ ...decodeJwt(token), sub: randomUUID() })).toString(
      'base64url',
    );
    await expectInvalidSession(parts.join('.'));
    const foreignKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await expectInvalidSession(
      await new JoseAccessTokens({ ...options, ...foreignKeys }).issue(userId, now),
    );
    await expectInvalidSession(`${parts[0]}.${parts[1]}.`);
    await expectInvalidSession(
      await new SignJWT({ sub: userId })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .sign(Buffer.alloc(32, 1)),
    );
  });

  it.each([
    null,
    { privateKey: null },
    { privateKey: keys.publicKey },
    { privateKey: generateKeyPairSync('ed25519').privateKey },
    { publicKey: null },
    { publicKey: keys.privateKey },
    { publicKey: generateKeyPairSync('ed25519').publicKey },
    { issuer: '' },
    { audience: ' ' },
    { kid: undefined },
  ])('rejects invalid configuration without key/error contents %#', (override) => {
    expect(
      () =>
        new JoseAccessTokens(
          (override === null ? null : { ...options, ...override }) as AccessTokenOptions,
        ),
    ).toThrow('Invalid session configuration.');
  });

  it('rejects invalid issuance inputs and sanitizes signing errors', async () => {
    for (const id of ['invalid', userId.toUpperCase(), `${userId}\n`]) {
      await expect(sessions.issue(id, now)).rejects.toThrow('Session issuance unavailable.');
    }
    await expect(sessions.issue(userId, new Date(NaN))).rejects.toThrow(
      'Session issuance unavailable.',
    );
    const weakKeys = generateKeyPairSync('rsa', { modulusLength: 1024 });
    await expect(
      new JoseAccessTokens({ ...options, ...weakKeys }).issue(userId, now),
    ).rejects.toThrow('Session issuance unavailable.');
  });
});

describe('opaque account tokens', () => {
  it.each(['email', 'refresh'] as const)(
    'creates and exactly parses high-entropy %s tokens',
    (kind) => {
      const first = newOpaqueToken(kind);
      const second = newOpaqueToken(kind);
      expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(first.raw).toMatch(new RegExp(`^${kind}\\.${first.id}\\.[A-Za-z0-9_-]{43}$`));
      expect(Buffer.from(first.raw.split('.')[2]!, 'base64url')).toHaveLength(32);
      expect(first.raw).not.toBe(second.raw);
      expect(first.id).not.toBe(second.id);
      expect(first.hash).toBe(createHash('sha256').update(first.raw).digest('hex'));
      expect(parseOpaqueToken(first.raw, kind)).toEqual({ id: first.id, hash: first.hash });
      expect(tokenHashMatches(first.hash, second.hash)).toBe(false);
      expect(tokenHashMatches(first.hash, first.hash)).toBe(true);
    },
  );

  it('rejects malformed, cross-kind and noncanonical tokens without exposing inputs', () => {
    const { raw } = newOpaqueToken('email');
    const bad = [
      null,
      5,
      {},
      '',
      `${raw}\n`,
      ` ${raw}`,
      `${raw}.extra`,
      raw.toUpperCase(),
      raw.replace(/\.[^.]+$/, `.${'!'.repeat(43)}`),
      raw.replace(/\.[^.]+$/, `.${'A'.repeat(42)}B`),
      raw.replace(/\.[^.]+$/, '.short'),
      `email.${'a'.repeat(36)}.${'A'.repeat(43)}`,
    ];
    // A valid token of the other purpose must not cross the purpose boundary.
    bad.push(newOpaqueToken('refresh').raw);
    for (const candidate of bad) {
      try {
        parseOpaqueToken(candidate, 'email');
        expect.fail('Malformed token accepted');
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect(error).toMatchObject({
          statusCode: 401,
          code: 'UNAUTHENTICATED',
          message: 'Invalid token.',
        });
        expect(error).not.toHaveProperty('cause');
      }
    }
  });

  it.each([
    null,
    undefined,
    5,
    '',
    'a'.repeat(63),
    'a'.repeat(65),
    'g'.repeat(64),
    'A'.repeat(64),
    `${'a'.repeat(64)}\n`,
  ])('returns false for invalid digest inputs %# without throwing', (invalid) => {
    expect(tokenHashMatches(invalid as string, 'a'.repeat(64))).toBe(false);
    expect(tokenHashMatches('a'.repeat(64), invalid as string)).toBe(false);
  });
});

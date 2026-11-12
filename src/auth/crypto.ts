import { createHash, KeyObject, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';
import { SignJWT, jwtVerify } from 'jose';
import { AppError } from '../platform/errors.ts';
import type { AccessTokens, PasswordHasher } from './contracts.ts';

const passwordOptions = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
} as const;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hashPattern = /^[0-9a-f]{64}$/;
const accessLifetimeSeconds = 900;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && value.length === 36 && uuidPattern.test(value);
}

export class ArgonPasswords implements PasswordHasher {
  private dummyHash?: Promise<string>;

  async hash(password: string): Promise<string> {
    return argon2.hash(password, passwordOptions);
  }

  async verify(password: string, encoded: string | null): Promise<boolean> {
    try {
      // One unknown, random password per instance; never a fixed known dummy password.
      const hash =
        encoded ?? (await (this.dummyHash ??= argon2.hash(randomBytes(32), passwordOptions)));
      const matches = await argon2.verify(hash, password);
      return encoded !== null && matches;
    } catch {
      return false;
    }
  }
}

export interface AccessTokenOptions {
  privateKey: KeyObject;
  publicKey: KeyObject;
  issuer: string;
  audience: string;
  kid: string;
}

export class JoseAccessTokens implements AccessTokens {
  private readonly options: AccessTokenOptions;

  constructor(options: AccessTokenOptions) {
    if (
      !options ||
      !(options.privateKey instanceof KeyObject) ||
      options.privateKey.type !== 'private' ||
      options.privateKey.asymmetricKeyType !== 'rsa' ||
      !(options.publicKey instanceof KeyObject) ||
      options.publicKey.type !== 'public' ||
      options.publicKey.asymmetricKeyType !== 'rsa' ||
      ![options.issuer, options.audience, options.kid].every(
        (value) => typeof value === 'string' && value.trim().length > 0,
      )
    ) {
      throw new Error('Invalid session configuration.');
    }
    this.options = { ...options };
  }

  async issue(userId: string, now: Date): Promise<string> {
    try {
      const issuedAt = Math.floor(now.getTime() / 1000);
      if (!isUuid(userId) || !Number.isSafeInteger(issuedAt)) throw new Error();
      return await new SignJWT({})
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: this.options.kid })
        .setSubject(userId)
        .setIssuer(this.options.issuer)
        .setAudience(this.options.audience)
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + accessLifetimeSeconds)
        .setJti(randomUUID())
        .sign(this.options.privateKey);
    } catch {
      throw new Error('Session issuance unavailable.');
    }
  }

  async verify(token: string, now: Date): Promise<string> {
    try {
      if (typeof token !== 'string' || token.length === 0 || token.length > 8192) throw new Error();
      const currentTime = Math.floor(now.getTime() / 1000);
      if (!Number.isSafeInteger(currentTime)) throw new Error();
      const { payload, protectedHeader } = await jwtVerify(token, this.options.publicKey, {
        algorithms: ['RS256'],
        issuer: this.options.issuer,
        audience: this.options.audience,
        typ: 'JWT',
        requiredClaims: ['sub', 'iat', 'exp', 'jti', 'iss', 'aud'],
        currentDate: now,
      });
      if (
        protectedHeader.typ !== 'JWT' ||
        protectedHeader.kid !== this.options.kid ||
        !isUuid(payload.sub) ||
        !isUuid(payload.jti) ||
        !Number.isSafeInteger(payload.iat) ||
        !Number.isSafeInteger(payload.exp) ||
        payload.exp! - payload.iat! !== accessLifetimeSeconds ||
        payload.iat! > currentTime
      )
        throw new Error();
      return payload.sub;
    } catch {
      throw new AppError(401, 'UNAUTHENTICATED', 'Invalid session.');
    }
  }
}

type OpaqueTokenKind = 'email' | 'refresh';

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function newOpaqueToken(kind: OpaqueTokenKind): { id: string; raw: string; hash: string } {
  const id = randomUUID();
  const raw = `${kind}.${id}.${randomBytes(32).toString('base64url')}`;
  return { id, raw, hash: hashToken(raw) };
}

export function parseOpaqueToken(
  raw: unknown,
  kind: OpaqueTokenKind,
): { id: string; hash: string } {
  if (typeof raw === 'string' && raw.length === kind.length + 81) {
    const [prefix, id, secret] = raw.split('.');
    if (
      prefix === kind &&
      isUuid(id) &&
      typeof secret === 'string' &&
      /^[A-Za-z0-9_-]{43}$/.test(secret) &&
      Buffer.from(secret, 'base64url').toString('base64url') === secret
    )
      return { id, hash: hashToken(raw) };
  }
  throw new AppError(401, 'UNAUTHENTICATED', 'Invalid token.');
}

export function tokenHashMatches(expected: string, actual: string): boolean {
  if (
    ![expected, actual].every(
      (value) => typeof value === 'string' && value.length === 64 && hashPattern.test(value),
    )
  )
    return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'));
}

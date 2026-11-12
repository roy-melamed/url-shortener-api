import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../platform/errors.ts';
import type {
  Account,
  AccountStore,
  AccessTokens,
  PasswordHasher,
  VerificationMailer,
} from './contracts.ts';
import { newOpaqueToken, parseOpaqueToken, tokenHashMatches } from './crypto.ts';

const credentialsSchema = z
  .object({
    email: z
      .email()
      .max(254)
      .transform((value) => value.toLowerCase()),
    password: z
      .string()
      .min(1)
      .max(128)
      .refine((value) => Buffer.from(value, 'utf8').toString('utf8') === value),
  })
  .strict();
export interface AccountOptions {
  store: AccountStore;
  passwords: PasswordHasher;
  accessTokens: AccessTokens;
  mailer: VerificationMailer;
  emailTokenTtlMs: number;
  refreshTokenTtlMs: number;
  now?: () => Date;
}
const unauthenticated = () => new AppError(401, 'UNAUTHENTICATED', 'Invalid credentials.');
const publicAccount = (account: Account) => ({
  id: account.id,
  email: account.email,
  emailVerified: account.emailVerifiedAt !== null,
});

/** Account/password unit. No link gate, API key resolver or OAuth provider. */
export class PasswordAccounts {
  private readonly options: AccountOptions;
  constructor(options: AccountOptions) {
    for (const duration of [options.emailTokenTtlMs, options.refreshTokenTtlMs]) {
      if (!Number.isSafeInteger(duration) || duration <= 0 || duration > 365 * 86_400_000)
        throw new Error('Invalid account token lifetime.');
    }
    this.options = options;
  }

  private now(): Date {
    const now = this.options.now?.() ?? new Date();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
      throw new AppError(503, 'INTERNAL', 'Account service unavailable.');
    return now;
  }

  private credentials(input: unknown, registration = false) {
    const result = credentialsSchema.safeParse(input);
    if (!result.success || (registration && result.data.password.length < 12)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Invalid account input.');
    }
    return result.data;
  }

  async register(input: unknown) {
    const { email, password } = this.credentials(input, true);
    let encoded: string;
    try {
      encoded = await this.options.passwords.hash(password);
    } catch {
      throw new AppError(503, 'INTERNAL', 'Account service unavailable.');
    }
    const token = newOpaqueToken('email');
    return this.options.store.transaction(async (tx) => {
      const account = await tx.createAccount(email, encoded);
      const now = this.now();
      const expiresAt = new Date(now.getTime() + this.options.emailTokenTtlMs);
      await tx.insertEmailToken({
        id: token.id,
        userId: account.id,
        tokenHash: token.hash,
        purpose: 'verify_email',
        expiresAt,
        usedAt: null,
      });
      // Bounded adapter failure rolls back registration/token. A mail sent before
      // an uncertain commit may be unusable; it never grants a verified account.
      try {
        await this.options.mailer.sendVerification({
          email: account.email,
          token: token.raw,
          expiresAt,
        });
      } catch {
        throw new AppError(503, 'INTERNAL', 'Verification delivery unavailable.');
      }
      return publicAccount(account);
    });
  }

  async login(input: unknown) {
    const { email, password } = this.credentials(input);
    const observed = await this.options.store.credentials(email);
    let valid: boolean;
    try {
      valid = await this.options.passwords.verify(password, observed?.passwordHash ?? null);
    } catch {
      throw new AppError(503, 'INTERNAL', 'Account service unavailable.');
    }
    if (!valid || !observed) throw unauthenticated();
    return this.options.store.transaction(async (tx) => {
      const account = await tx.lockAccount(observed.id);
      if (!account || account.passwordHash !== observed.passwordHash) throw unauthenticated();
      const now = this.now();
      const refresh = newOpaqueToken('refresh');
      const accessToken = await this.issueAccess(account.id, now);
      await tx.insertRefresh({
        id: refresh.id,
        userId: account.id,
        tokenHash: refresh.hash,
        familyId: randomUUID(),
        expiresAt: new Date(now.getTime() + this.options.refreshTokenTtlMs),
        revokedAt: null,
      });
      return { accessToken, refreshToken: refresh.raw, tokenType: 'Bearer', expiresIn: 900 };
    });
  }

  private async issueAccess(userId: string, now: Date): Promise<string> {
    try {
      return await this.options.accessTokens.issue(userId, now);
    } catch {
      throw new AppError(503, 'INTERNAL', 'Session service unavailable.');
    }
  }

  async refresh(raw: unknown) {
    const token = parseOpaqueToken(raw, 'refresh');
    const result = await this.options.store.transaction(async (tx) => {
      const observed = await tx.refreshToken(token.id);
      if (!observed || !(await tx.lockAccount(observed.userId))) throw unauthenticated();
      // Re-read after locking the USER row. All rotations/deletions/verifications
      // serialize in the same order, including concurrent reuse of an old token.
      const old = await tx.refreshToken(token.id);
      if (!old || !tokenHashMatches(token.hash, old.tokenHash)) throw unauthenticated();
      const now = this.now();
      if (old.revokedAt) {
        await tx.revokeFamily(old.familyId, now);
        return null; // Commit family revocation BEFORE returning the 401.
      }
      if (old.expiresAt <= now) throw unauthenticated();
      const next = newOpaqueToken('refresh');
      const accessToken = await this.issueAccess(old.userId, now);
      await tx.revokeRefresh(old.id, now);
      await tx.insertRefresh({
        id: next.id,
        userId: old.userId,
        tokenHash: next.hash,
        familyId: old.familyId,
        expiresAt: old.expiresAt,
        revokedAt: null,
      });
      return { accessToken, refreshToken: next.raw, tokenType: 'Bearer', expiresIn: 900 };
    });
    if (!result) throw unauthenticated();
    return result;
  }

  async verifyEmail(raw: unknown): Promise<void> {
    const token = parseOpaqueToken(raw, 'email');
    await this.options.store.transaction(async (tx) => {
      const observed = await tx.emailToken(token.id);
      if (!observed || !(await tx.lockAccount(observed.userId))) throw unauthenticated();
      const current = await tx.emailToken(token.id);
      const now = this.now();
      if (
        !current ||
        current.purpose !== 'verify_email' ||
        current.usedAt ||
        current.expiresAt <= now ||
        !tokenHashMatches(token.hash, current.tokenHash)
      )
        throw unauthenticated();
      await tx.useEmailToken(current.id, now);
      await tx.verifyEmail(current.userId, now);
    });
  }

  async deleteMe(accessToken: string): Promise<void> {
    const userId = await this.options.accessTokens.verify(accessToken, this.now());
    await this.options.store.transaction(async (tx) => {
      if (!(await tx.lockAccount(userId))) throw unauthenticated();
      // Existing FK cascades delete owned links/analytics and identity children.
      // Slug reservations have no user FK and MUST remain reserved (AD-5).
      await tx.deleteAccount(userId);
    });
  }
}

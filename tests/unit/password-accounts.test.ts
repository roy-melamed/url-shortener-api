import { describe, expect, it, vi } from 'vitest';
import { PasswordAccounts } from '../../src/auth/accounts.ts';
import { newOpaqueToken } from '../../src/auth/crypto.ts';
import { MemoryAccountStore } from '../helpers/account-memory-store.ts';
import type { VerificationMessage } from '../../src/auth/contracts.ts';

const input = { email: 'Person@Example.invalid', password: 'fixture-password-long' };
function fixture() {
  const store = new MemoryAccountStore();
  const sent: VerificationMessage[] = [];
  const hash = vi.fn(async (password: string) => `fixture-hash:${password}`);
  const verify = vi.fn(
    async (password: string, encoded: string | null) => encoded === `fixture-hash:${password}`,
  );
  const issue = vi.fn(async (id: string) => `fixture-session:${id}`);
  const verifySession = vi.fn(async (token: string) => {
    if (!token.startsWith('fixture-session:')) throw new Error('invalid-fixture');
    return token.slice('fixture-session:'.length);
  });
  const send = vi.fn(async (message: VerificationMessage) => {
    sent.push(message);
  });
  const clock = { now: new Date('2026-01-01T00:00:00Z') };
  const options = {
    store,
    passwords: { hash, verify },
    accessTokens: { issue, verify: verifySession },
    mailer: { sendVerification: send },
    emailTokenTtlMs: 60_000,
    refreshTokenTtlMs: 120_000,
    now: () => clock.now,
  };
  return {
    store,
    sent,
    hash,
    verify,
    issue,
    verifySession,
    send,
    clock,
    options,
    service: new PasswordAccounts(options),
  };
}

describe('password accounts and verification mechanics (URL-9 only)', () => {
  it('registers an unverified normalized account with only hashed single-use email token at rest', async () => {
    const f = fixture();
    const result = await f.service.register(input);
    expect(result).toEqual({
      id: expect.any(String),
      email: 'person@example.invalid',
      emailVerified: false,
    });
    expect(result).not.toHaveProperty('passwordHash');
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]?.token).toMatch(/^email\./);
    expect([...f.store.emails.values()][0]).toMatchObject({
      purpose: 'verify_email',
      usedAt: null,
      expiresAt: new Date('2026-01-01T00:01:00Z'),
    });
    expect(JSON.stringify([...f.store.emails.values()])).not.toContain(f.sent[0]!.token);
    await f.service.verifyEmail(f.sent[0]!.token);
    expect(f.store.accounts.get(result.id)?.emailVerifiedAt).toEqual(f.clock.now);
    expect([...f.store.emails.values()][0]?.usedAt).toEqual(f.clock.now);
    await expect(f.service.verifyEmail(f.sent[0]!.token)).rejects.toMatchObject({
      statusCode: 401,
    });
  });
  it('rejected email, delivery/commit/hash failure never verifies or leaves partial registration', async () => {
    const f = fixture();
    await f.service.register(input);
    await expect(
      f.service.register({ ...input, email: 'person@example.invalid' }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(f.sent).toHaveLength(1);
    for (const kind of ['mail', 'commit', 'hash'] as const) {
      const g = fixture();
      if (kind === 'mail') g.send.mockRejectedValue(new Error('private-provider-token'));
      if (kind === 'commit') g.store.failCommit = true;
      if (kind === 'hash') g.hash.mockRejectedValue(new Error('private-password'));
      await expect(g.service.register(input)).rejects.toMatchObject({ statusCode: 503 });
      expect(g.store.accounts.size).toBe(0);
      expect(g.store.emails.size).toBe(0);
    }
  });
  it.each([
    {},
    null,
    { ...input, password: 'short' },
    { ...input, email: 'bad' },
    { ...input, password: 'x'.repeat(129) },
    { ...input, password: 'x'.repeat(12) + '\ud800' },
    { ...input, role: 'admin' },
  ])('rejects malformed registration %#', async (bad) => {
    const f = fixture();
    await expect(f.service.register(bad)).rejects.toMatchObject({ statusCode: 400 });
    expect(f.hash).not.toHaveBeenCalled();
  });
  it('allows one confirmation under concurrent replay, and neither expired nor wrong-purpose/wrong-secret tokens', async () => {
    const f = fixture();
    await f.service.register(input);
    const token = f.sent[0]!.token;
    const confirmed = await Promise.allSettled([
      f.service.verifyEmail(token),
      f.service.verifyEmail(token),
    ]);
    expect(confirmed.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const variant of [
      'expired',
      'purpose',
      'hash',
      'missing-account',
      'missing-token',
    ] as const) {
      const g = fixture();
      const account = await g.service.register(input);
      const row = [...g.store.emails.values()][0]!;
      if (variant === 'expired') g.clock.now = row.expiresAt;
      if (variant === 'purpose') row.purpose = 'unrelated';
      if (variant === 'hash') row.tokenHash = '00'.repeat(32);
      if (variant === 'missing-account') g.store.accounts.delete(account.id);
      if (variant === 'missing-token') g.store.emails.clear();
      await expect(g.service.verifyEmail(g.sent[0]!.token)).rejects.toMatchObject({
        statusCode: 401,
      });
      expect(g.store.accounts.get(account.id)?.emailVerifiedAt ?? null).toBeNull();
    }
    await expect(f.service.verifyEmail(newOpaqueToken('refresh').raw)).rejects.toMatchObject({
      statusCode: 401,
    });
  });
  it('login checks credentials uniformly for unknown/wrong/social-only accounts; no email-create gate', async () => {
    const f = fixture();
    await expect(f.service.login(input)).rejects.toMatchObject({ statusCode: 401 });
    expect(f.verify).toHaveBeenLastCalledWith(input.password, null);
    const user = await f.service.register(input);
    await expect(f.service.login({ ...input, password: 'wrong' })).rejects.toMatchObject({
      statusCode: 401,
    });
    const login = await f.service.login(input);
    expect(login).toMatchObject({
      accessToken: `fixture-session:${user.id}`,
      refreshToken: expect.stringMatching(/^refresh\./),
      expiresIn: 900,
      tokenType: 'Bearer',
    });
    expect(f.store.accounts.get(user.id)?.emailVerifiedAt).toBeNull();
    f.store.accounts.get(user.id)!.passwordHash = null;
    await expect(f.service.login(input)).rejects.toMatchObject({ statusCode: 401 });
    f.verify.mockRejectedValue(new Error('private'));
    await expect(f.service.login(input)).rejects.toMatchObject({ statusCode: 503 });
    await expect(f.service.login({ email: 'bad' })).rejects.toMatchObject({ statusCode: 400 });
  });
  it('rotation keeps the absolute family expiry; authentic reuse commits revocation before returning 401', async () => {
    const f = fixture();
    await f.service.register(input);
    const first = await f.service.login(input);
    const old = [...f.store.refresh.values()][0]!;
    f.clock.now = new Date(f.clock.now.getTime() + 10_000);
    const second = await f.service.refresh(first.refreshToken);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    const rows = [...f.store.refresh.values()];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.revokedAt).not.toBeNull();
    expect(rows[1]?.familyId).toBe(old.familyId);
    expect(rows[1]?.expiresAt).toEqual(old.expiresAt);
    await expect(f.service.refresh(first.refreshToken)).rejects.toMatchObject({ statusCode: 401 });
    expect([...f.store.refresh.values()].every((r) => r.revokedAt !== null)).toBe(true);
    await expect(f.service.refresh(second.refreshToken)).rejects.toMatchObject({ statusCode: 401 });
  });
  it('concurrent rotation detects replay and invalidates its successor', async () => {
    const f = fixture();
    await f.service.register(input);
    const session = await f.service.login(input);
    const result = await Promise.allSettled([
      f.service.refresh(session.refreshToken),
      f.service.refresh(session.refreshToken),
    ]);
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect([...f.store.refresh.values()].every((r) => r.revokedAt !== null)).toBe(true);
  });
  it('forged/expired/unknown refresh does not revoke a legitimate family or mint a session', async () => {
    const f = fixture();
    await f.service.register(input);
    const session = await f.service.login(input);
    const forged =
      session.refreshToken.slice(0, -1) + (session.refreshToken.endsWith('A') ? 'B' : 'A');
    await expect(f.service.refresh(forged)).rejects.toMatchObject({ statusCode: 401 });
    expect([...f.store.refresh.values()][0]?.revokedAt).toBeNull();
    await expect(f.service.refresh(newOpaqueToken('refresh').raw)).rejects.toMatchObject({
      statusCode: 401,
    });
    f.clock.now = [...f.store.refresh.values()][0]!.expiresAt;
    await expect(f.service.refresh(session.refreshToken)).rejects.toMatchObject({
      statusCode: 401,
    });
    await expect(f.service.refresh('private-invalid')).rejects.toMatchObject({ statusCode: 401 });
  });
  it('signing failure rolls back session creation/rotation; deletion invalidates further sessions', async () => {
    const f = fixture();
    const user = await f.service.register(input);
    f.issue.mockRejectedValueOnce(new Error('private-key'));
    await expect(f.service.login(input)).rejects.toMatchObject({ statusCode: 503 });
    expect(f.store.refresh.size).toBe(0);
    const session = await f.service.login(input);
    f.issue.mockRejectedValueOnce(new Error('private-key'));
    await expect(f.service.refresh(session.refreshToken)).rejects.toMatchObject({
      statusCode: 503,
    });
    expect([...f.store.refresh.values()][0]?.revokedAt).toBeNull();
    await f.service.deleteMe(session.accessToken);
    expect(f.store.accounts.has(user.id)).toBe(false);
    expect(f.store.refresh.size).toBe(0);
    expect(f.store.emails.size).toBe(0);
    await expect(f.service.deleteMe(session.accessToken)).rejects.toMatchObject({
      statusCode: 401,
    });
    await expect(f.service.refresh(session.refreshToken)).rejects.toMatchObject({
      statusCode: 401,
    });
  });
  it('validates mandatory lifetimes and runtime clock without selecting production defaults', async () => {
    const f = fixture();
    for (const value of [0, -1, NaN, Infinity, 0.5, 366 * 86_400_000]) {
      expect(() => new PasswordAccounts({ ...f.options, emailTokenTtlMs: value })).toThrow(
        'Invalid account token lifetime.',
      );
      expect(() => new PasswordAccounts({ ...f.options, refreshTokenTtlMs: value })).toThrow();
    }
    const noClock = new PasswordAccounts({ ...f.options, now: undefined });
    await noClock.register(input);
    const g = fixture();
    g.clock.now = new Date(NaN);
    await expect(g.service.register(input)).rejects.toMatchObject({ statusCode: 503 });
  });
});

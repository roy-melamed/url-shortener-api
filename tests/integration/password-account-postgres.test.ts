import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { runner } from 'node-pg-migrate';
import { PasswordAccounts } from '../../src/auth/accounts.ts';
import { ArgonPasswords, JoseAccessTokens } from '../../src/auth/crypto.ts';
import { PostgresAccountStore } from '../../src/auth/postgres-store.ts';
import { createMailHogMailer } from '../../src/platform/verification-mail.ts';
import type { VerificationMessage } from '../../src/auth/contracts.ts';

const databaseUrl = process.env.TEST_ACCOUNT_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const schema = `account_fixture_${randomUUID().replaceAll('-', '')}`;
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
let pool: Pool;
let admin: Pool;
let service: PasswordAccounts;
let now: Date;
let messages: VerificationMessage[];
const input = { email: 'fixture@example.invalid', password: 'fixture-password-long' };

suite('real PostgreSQL account transactions and URL-8 cascade contract', () => {
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (url.hostname !== '127.0.0.1' || url.pathname !== '/account_auth_test')
      throw new Error('Dedicated loopback account_auth_test database required');
    admin = new Pool({ connectionString: databaseUrl, max: 1 });
    await runner({
      databaseUrl: { connectionString: databaseUrl, options: `-c search_path=${schema},public` },
      dir: 'migrations',
      direction: 'up',
      noLock: true,
      schema,
      createSchema: true,
      migrationsSchema: schema,
      migrationsTable: 'pgmigrations',
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    pool = new Pool({
      connectionString: databaseUrl,
      max: 8,
      options: `-c search_path=${schema},public`,
    });
  }, 30_000);
  beforeEach(async () => {
    await pool.query('TRUNCATE users, slug_reservations CASCADE');
    messages = [];
    now = new Date('2026-01-01T00:00:00Z');
    service = new PasswordAccounts({
      store: new PostgresAccountStore(pool),
      passwords: new ArgonPasswords(),
      accessTokens: new JoseAccessTokens({
        ...keys,
        issuer: 'fixture-issuer',
        audience: 'fixture-api',
        kid: 'fixture-key',
      }),
      mailer: {
        sendVerification: async (message) => {
          messages.push(message);
        },
      },
      emailTokenTtlMs: 60_000,
      refreshTokenTtlMs: 120_000,
      now: () => now,
    });
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  it('real argon2id registration/CITEXT login and single-use verification, hashed token storage', async () => {
    const account = await service.register(input);
    const row = (
      await pool.query('SELECT password_hash, email_verified_at FROM users WHERE id=$1', [
        account.id,
      ])
    ).rows[0];
    expect(row.password_hash).toMatch(/^\$argon2id\$/);
    expect(row.email_verified_at).toBeNull();
    expect((await service.login({ ...input, email: 'FIXTURE@EXAMPLE.INVALID' })).expiresIn).toBe(
      900,
    );
    expect((await pool.query('SELECT token_hash FROM email_tokens')).rows[0].token_hash).not.toBe(
      messages[0]!.token,
    );
    await service.verifyEmail(messages[0]!.token);
    await expect(service.verifyEmail(messages[0]!.token)).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(
      (await pool.query('SELECT email_verified_at FROM users')).rows[0].email_verified_at,
    ).toEqual(now);
  });
  it('concurrent duplicate registration creates one account/token and sends one confirmation', async () => {
    const results = await Promise.allSettled([
      service.register(input),
      service.register({ ...input, email: input.email.toUpperCase() }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(messages).toHaveLength(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(1);
  });
  it('concurrent refresh replay commits family revocation and rejects the successor', async () => {
    await service.register(input);
    const session = await service.login(input);
    const results = await Promise.allSettled([
      service.refresh(session.refreshToken),
      service.refresh(session.refreshToken),
    ]);
    const accepted = results.find((r) => r.status === 'fulfilled');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (await pool.query('SELECT count(*)::int AS n FROM refresh_tokens WHERE revoked_at IS NULL'))
        .rows[0].n,
    ).toBe(0);
    if (accepted?.status !== 'fulfilled') throw new Error('Missing fixture successor');
    await expect(service.refresh(accepted.value.refreshToken)).rejects.toMatchObject({
      statusCode: 401,
    });
  });
  it('concurrent confirmation has exactly one success; expiry is enforced at equality', async () => {
    await service.register(input);
    const results = await Promise.allSettled([
      service.verifyEmail(messages[0]!.token),
      service.verifyEmail(messages[0]!.token),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    await pool.query('TRUNCATE users CASCADE');
    messages = [];
    await service.register(input);
    now = messages[0]!.expiresAt;
    await expect(service.verifyEmail(messages[0]!.token)).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(
      (await pool.query('SELECT email_verified_at FROM users')).rows[0].email_verified_at,
    ).toBeNull();
  });
  it('hard deletion removes owned identities/links/all five aggregates; preserves slug and other account', async () => {
    const account = await service.register(input);
    const session = await service.login(input);
    const other = await service.register({ ...input, email: 'other@example.invalid' });
    await pool.query("INSERT INTO slug_reservations(slug) VALUES('retainFixture')");
    const link = (
      await pool.query(
        "INSERT INTO links(user_id,slug,destination_url) VALUES($1,'retainFixture','https://fixture.invalid') RETURNING id",
        [account.id],
      )
    ).rows[0].id;
    await pool.query('INSERT INTO click_buckets_daily VALUES($1,CURRENT_DATE,1)', [link]);
    await pool.query(
      "INSERT INTO referrer_buckets_daily VALUES($1,CURRENT_DATE,'fixture.invalid',1)",
      [link],
    );
    await pool.query("INSERT INTO country_buckets_daily VALUES($1,CURRENT_DATE,'ZZ',1)", [link]);
    await pool.query("INSERT INTO referrer_totals VALUES($1,'fixture.invalid',1)", [link]);
    await pool.query("INSERT INTO country_totals VALUES($1,'ZZ',1)", [link]);
    await pool.query("INSERT INTO auth_identities VALUES($1,'google','fixture-subject')", [
      account.id,
    ]);
    await pool.query(
      "INSERT INTO api_keys(user_id,name,key_prefix,key_hash) VALUES($1,'fixture','fixture1','fixture-hash')",
      [account.id],
    );
    await service.deleteMe(session.accessToken);
    for (const table of [
      'links',
      'click_buckets_daily',
      'referrer_buckets_daily',
      'country_buckets_daily',
      'referrer_totals',
      'country_totals',
      'auth_identities',
      'api_keys',
      'refresh_tokens',
    ]) {
      expect((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(0);
    }
    expect((await pool.query('SELECT user_id FROM email_tokens')).rows).toEqual([
      { user_id: other.id },
    ]);
    expect((await pool.query('SELECT id FROM users')).rows).toEqual([{ id: other.id }]);
    expect((await pool.query('SELECT released_at FROM slug_reservations')).rows).toEqual([
      { released_at: null },
    ]);
  });
});

const mailSuite = process.env.TEST_ACCOUNT_MAILHOG === 'true' ? describe : describe.skip;
mailSuite('real local MailHog adapter (ephemeral CI service only)', () => {
  it('sends a single-use verification instruction through SMTP without production credentials', async () => {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        response = await fetch('http://127.0.0.1:8025/api/v2/messages');
        if (response.ok) break;
      } catch {
        /* service starting */
      }
      await delay(250);
    }
    expect(response?.ok).toBe(true);
    const recipient = `fixture-${randomUUID()}@example.invalid`;
    const storeMessages: VerificationMessage[] = [];
    const { MemoryAccountStore } = await import('../helpers/account-memory-store.ts');
    const mailer = createMailHogMailer({
      host: '127.0.0.1',
      port: 1025,
      from: 'sender@example.invalid',
      verificationEndpoint: 'http://localhost/v1/auth/emails/verify',
    });
    const app = new PasswordAccounts({
      store: new MemoryAccountStore(),
      passwords: new ArgonPasswords(),
      accessTokens: new JoseAccessTokens({
        ...keys,
        issuer: 'fixture-issuer',
        audience: 'fixture-api',
        kid: 'fixture-key',
      }),
      mailer: {
        sendVerification: async (message) => {
          storeMessages.push(message);
          await mailer.sendVerification(message);
        },
      },
      emailTokenTtlMs: 60_000,
      refreshTokenTtlMs: 120_000,
    });
    const user = await app.register({ ...input, email: recipient });
    expect(user.emailVerified).toBe(false);
    const data = (await (await fetch('http://127.0.0.1:8025/api/v2/messages')).json()) as {
      items: { Content: { Headers: { To: string[] }; Body: string } }[];
    };
    const sent = data.items.find((item) => item.Content.Headers.To.includes(recipient));
    expect(sent).toBeDefined();
    expect(sent!.Content.Body.replace(/=\r?\n/g, '')).toContain(storeMessages[0]!.token);
    await app.verifyEmail(storeMessages[0]!.token);
    await expect(app.verifyEmail(storeMessages[0]!.token)).rejects.toMatchObject({
      statusCode: 401,
    });
  }, 15_000);
});

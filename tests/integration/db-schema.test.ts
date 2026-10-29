import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { runner } from 'node-pg-migrate';

/**
 * Live-DB acceptance — URL-8 (design §4.1, §13, AD-5/AD-8/AD-9, FR-9.2/NFR-4).
 *
 * Runs only when TEST_DATABASE_URL is provided (a dedicated, disposable
 * Postgres — e.g. the URL-7 compose stack). Without it the suite is SKIPPED so
 * `npm test` stays green in CI (which has no DB service); the DB-free schema
 * contract + privacy gate in tests/unit cover the same invariants statically.
 *
 * beforeAll drops the public schema (clean slate) and applies all migrations via
 * the real node-pg-migrate runner — proving migrations apply cleanly to a real
 * Postgres.
 */

const testUrl = process.env.TEST_DATABASE_URL;
const describeDb = testUrl ? describe : describe.skip;

let client: Client;

async function q(text: string, params?: unknown[]) {
  return client.query(text, params);
}

describeDb('schema against live Postgres (TEST_DATABASE_URL set)', () => {
  beforeAll(async () => {
    client = new Client({ connectionString: testUrl });
    await client.connect();
    // Clean slate on the dedicated test DB.
    await q('DROP SCHEMA public CASCADE');
    await q('CREATE SCHEMA public');
    // Apply every migration through the real runner.
    await runner({
      databaseUrl: testUrl as string,
      dir: 'migrations',
      direction: 'up',
      noLock: true,
      createSchema: false,
      migrationsTable: 'pgmigrations',
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
  });

  afterAll(async () => {
    await client?.end();
  });

  it('creates every §4.1 table', async () => {
    const { rows } = await q(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const tables = new Set(rows.map((r: { table_name: string }) => r.table_name));
    for (const t of [
      'users',
      'auth_identities',
      'email_tokens',
      'refresh_tokens',
      'api_keys',
      'slug_reservations',
      'links',
      'idempotency_records',
      'rate_limit_windows',
      'click_buckets_daily',
      'referrer_buckets_daily',
      'country_buckets_daily',
      'referrer_totals',
      'country_totals',
      'click_event_dedup',
    ]) {
      expect(tables.has(t), `missing table ${t}`).toBe(true);
    }
  });

  it('has no IP/user-agent-like column in the live schema (§6.5)', async () => {
    const { rows } = await q(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public'`,
    );
    const forbidden =
      /^(ip|ip_.*|.*_ip|.*_ip_.*|ipaddress|ip_?addr.*|user_?agent|.*_user_?agent|.*_ua|ua|remote_?addr.*|x_?forwarded_?for)$/i;
    const offenders = rows
      .filter((r: { column_name: string }) => forbidden.test(r.column_name.toLowerCase()))
      .map((r: { table_name: string; column_name: string }) => `${r.table_name}.${r.column_name}`);
    expect(offenders).toEqual([]);
  });

  it('keeps click_event_dedup to exactly event_id + created_at (§13-c1)', async () => {
    const { rows } = await q(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'click_event_dedup'`,
    );
    const cols = rows.map((r: { column_name: string }) => r.column_name).sort();
    expect(cols).toEqual(['created_at', 'event_id']);
  });

  it('rejects a hyphenated slug — AD-8 CHECK is NOT relaxed', async () => {
    await expect(
      q(`INSERT INTO slug_reservations (slug) VALUES ('my-campaign')`),
    ).rejects.toMatchObject({ code: '23514' }); // check_violation
  });

  it('accepts a strict alphanumeric slug and rejects out-of-range lengths', async () => {
    await expect(q(`INSERT INTO slug_reservations (slug) VALUES ('abc123')`)).resolves.toBeTruthy();
    // too short (<3)
    await expect(q(`INSERT INTO slug_reservations (slug) VALUES ('ab')`)).rejects.toMatchObject({
      code: '23514',
    });
    // too long (>50) — the 51-char value is built in JS and passed as a param.
    const longSlug = 'a'.padEnd(51, 'a');
    await expect(
      q(`INSERT INTO slug_reservations (slug) VALUES ($1)`, [longSlug]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('defaults country_code to ZZ and rejects non-^[A-Z]{2}$ (§13-c3)', async () => {
    // Insert a real user+link to attach a country row (FK target).
    const u = await q(`INSERT INTO users (email) VALUES ('cc@example.com') RETURNING id`);
    const userId = u.rows[0].id;
    const s = await q(`INSERT INTO slug_reservations (slug) VALUES ('cctest') RETURNING slug`);
    const l = await q(
      `INSERT INTO links (user_id, slug, destination_url) VALUES ($1, $2, 'https://x.com') RETURNING id`,
      [userId, s.rows[0].slug],
    );
    const linkId = l.rows[0].id;
    // Omitting country_code → 'ZZ' sentinel.
    const ins = await q(
      `INSERT INTO country_totals (link_id, count) VALUES ($1, 5) RETURNING country_code`,
      [linkId],
    );
    expect(ins.rows[0].country_code).toBe('ZZ');
    // Lowercase rejected by CHECK (2 chars → reaches the regex CHECK).
    await expect(
      q(`INSERT INTO country_totals (link_id, country_code, count) VALUES ($1, 'us', 1)`, [linkId]),
    ).rejects.toMatchObject({ code: '23514' });
    // A 3-char code is rejected by the char(2) width constraint before the CHECK.
    await expect(
      q(`INSERT INTO country_totals (link_id, country_code, count) VALUES ($1, 'USA', 1)`, [linkId]),
    ).rejects.toMatchObject({ code: '22001' }); // string_data_right_truncation
  });

  it('enforces idempotency_records UNIQUE (principal, key)', async () => {
    const ins = `INSERT INTO idempotency_records (principal, key, request_hash, state, expires_at)
                 VALUES ('user:1', 'k1', 'h', 'completed', now() + interval '1 day')`;
    await expect(q(ins)).resolves.toBeTruthy();
    await expect(q(ins)).rejects.toMatchObject({ code: '23505' }); // unique_violation
  });

  it('dedups click_event_dedup on repeated event_id (§13-c1)', async () => {
    // ON CONFLICT DO NOTHING → same event_id twice yields one row.
    await q(`INSERT INTO click_event_dedup (event_id) VALUES ('01EVENTDUP') ON CONFLICT DO NOTHING`);
    await q(`INSERT INTO click_event_dedup (event_id) VALUES ('01EVENTDUP') ON CONFLICT DO NOTHING`);
    const { rows } = await q(`SELECT count(*)::int AS n FROM click_event_dedup WHERE event_id = '01EVENTDUP'`);
    expect(rows[0].n).toBe(1);
    // A plain INSERT of the same id is rejected by the PK.
    await expect(q(`INSERT INTO click_event_dedup (event_id) VALUES ('01EVENTDUP')`)).rejects.toMatchObject({
      code: '23505',
    });
  });

  it('deleting a user cascades links + all analytics but does NOT release the slug (AD-5/AD-13)', async () => {
    const u = await q(`INSERT INTO users (email) VALUES ('cascade@example.com') RETURNING id`);
    const userId = u.rows[0].id as string;
    const slug = 'cascadeslug';
    await q(`INSERT INTO slug_reservations (slug) VALUES ($1)`, [slug]);
    const l = await q(
      `INSERT INTO links (user_id, slug, destination_url) VALUES ($1, $2, 'https://cascade.test') RETURNING id`,
      [userId, slug],
    );
    const linkId = l.rows[0].id as string;
    // Seed every analytics table for this link.
    await q(`INSERT INTO click_buckets_daily (link_id, day, count) VALUES ($1, '2026-10-29', 3)`, [linkId]);
    await q(
      `INSERT INTO referrer_buckets_daily (link_id, day, referrer_host, count) VALUES ($1, '2026-10-29', 'example.com', 3)`,
      [linkId],
    );
    await q(`INSERT INTO country_buckets_daily (link_id, day, country_code, count) VALUES ($1, '2026-10-29', 'US', 3)`, [linkId]);
    await q(`INSERT INTO referrer_totals (link_id, referrer_host, count) VALUES ($1, 'example.com', 3)`, [linkId]);
    await q(`INSERT INTO country_totals (link_id, country_code, count) VALUES ($1, 'US', 3)`, [linkId]);
    await q(`INSERT INTO click_event_dedup (event_id) VALUES ('01CASCADEEVT')`);

    // Delete the account.
    await q(`DELETE FROM users WHERE id = $1`, [userId]);

    // Links gone.
    const links = await q(`SELECT count(*)::int AS n FROM links WHERE user_id = $1`, [userId]);
    expect(links.rows[0].n).toBe(0);
    // All analytics rows gone (cascade through links).
    for (const t of [
      'click_buckets_daily',
      'referrer_buckets_daily',
      'country_buckets_daily',
      'referrer_totals',
      'country_totals',
    ]) {
      const r = await q(`SELECT count(*)::int AS n FROM ${t} WHERE link_id = $1`, [linkId]);
      expect(r.rows[0].n, `${t} should be cascade-deleted`).toBe(0);
    }
    // Slug reservation NOT released (AD-5).
    const slugRow = await q(`SELECT count(*)::int AS n FROM slug_reservations WHERE slug = $1`, [slug]);
    expect(slugRow.rows[0].n).toBe(1);
    // Dedup row survives (bare token, no FK — purged at 7 days, not on delete).
    const dedup = await q(`SELECT count(*)::int AS n FROM click_event_dedup WHERE event_id = '01CASCADEEVT'`);
    expect(dedup.rows[0].n).toBe(1);
  });

  it('links.user_id is NOT NULL (AD-4: anonymous create forbidden)', async () => {
    await expect(
      q(`INSERT INTO links (user_id, slug, destination_url) VALUES (NULL, 'nonullslug', 'https://x.com')`),
    ).rejects.toMatchObject({ code: '23502' }); // not_null_violation
  });
});

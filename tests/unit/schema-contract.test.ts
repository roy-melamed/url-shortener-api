import { describe, expect, it } from 'vitest';
import { recordAll } from '../helpers/schema-recorder.ts';
import { up as identityUp } from '../../migrations/1793270000001-identity-tables.ts';
import { up as slugsUp } from '../../migrations/1793270000002-slugs-links.ts';
import { up as idemUp } from '../../migrations/1793270000003-idempotency-rate-limit.ts';
import { up as analyticsUp } from '../../migrations/1793270000004-analytics-tables.ts';
import { up as dedupUp } from '../../migrations/1793270000005-click-event-dedup.ts';
import type { RecordedColumn } from '../helpers/schema-recorder.ts';

/**
 * Schema contract (DB-free) — design §4.1 + §13 corrections + hard decisions.
 *
 * Records the real migrations via a mock MigrationBuilder and pins every
 * invariant URL-8 must hold. The live-DB acceptance suite mirrors these against
 * a real Postgres when one is available.
 */

const schema = recordAll([identityUp, slugsUp, idemUp, analyticsUp, dedupUp]);

function col(table: string, name: string): RecordedColumn {
  const t = schema.tables.get(table);
  if (!t) throw new Error(`missing table ${table}`);
  const c = t.columns.find((x) => x.name === name);
  if (!c) throw new Error(`missing column ${table}.${name}`);
  return c;
}

function funcDefault(c: RecordedColumn): string | undefined {
  const d = c.default as { __func?: string } | undefined;
  return d && typeof d === 'object' ? d.__func : undefined;
}

describe('schema contract (design §4.1)', () => {
  it('users.email is CITEXT UNIQUE NOT NULL; password_hash nullable (social-only)', () => {
    expect(col('users', 'email').type).toBe('citext');
    expect(col('users', 'email').unique).toBe(true);
    expect(col('users', 'email').notNull).toBe(true);
    expect(col('users', 'password_hash').notNull).toBeFalsy();
    expect(schema.extensions).toContain('citext');
  });

  it('auth_identities cascades on user delete and is unique (provider, subject)', () => {
    expect(col('auth_identities', 'user_id').onDelete).toBe('CASCADE');
    expect(col('auth_identities', 'user_id').references).toBe('users');
    const cons = schema.tables.get('auth_identities')!.constraints!;
    expect(cons.unique).toEqual([['provider', 'provider_subject']]);
  });

  it('keeps the AD-8 slug CHECK exactly as written — alphanumeric only, no hyphens', () => {
    expect(col('slug_reservations', 'slug').check).toBe("slug ~ '^[a-zA-Z0-9]{3,50}$'");
    expect(col('slug_reservations', 'slug').primaryKey).toBe(true);
  });

  it('links.user_id NOT NULL + cascade (AD-4/AD-13); click_count BIGINT default 0 (AD-9)', () => {
    expect(col('links', 'user_id').notNull).toBe(true);
    expect(col('links', 'user_id').onDelete).toBe('CASCADE');
    expect(col('links', 'destination_url').notNull).toBe(true);
    expect(col('links', 'click_count').type).toBe('bigint');
    expect(col('links', 'click_count').notNull).toBe(true);
    // link slug references reservation with NO ON DELETE → slug never released (AD-5)
    const slug = col('links', 'slug');
    expect(slug.references).toBe('slug_reservations');
    expect(slug.onDelete).toBeUndefined();
  });

  it('creates the links_slug_uk unique index and links_user_idx index', () => {
    const byName = (n: string) => schema.indexes.find((i) => (i.options as { name?: string })?.name === n);
    expect(byName('links_slug_uk')).toBeTruthy();
    expect((byName('links_slug_uk')!.options as { unique?: boolean }).unique).toBe(true);
    expect(byName('links_user_idx')).toBeTruthy();
  });

  it('idempotency_records is unique (principal, key); state CHECK retained (§13-c2)', () => {
    const cons = schema.tables.get('idempotency_records')!.constraints!;
    expect(cons.unique).toEqual([['principal', 'key']]);
    expect(col('idempotency_records', 'state').check).toBe("state IN ('in_progress','completed')");
    // §13-c2: link_id has no FK — durable response snapshot must survive link delete.
    expect(col('idempotency_records', 'link_id').references).toBeUndefined();
    expect(col('idempotency_records', 'expires_at').notNull).toBe(true);
  });

  it('rate_limit_windows is keyed (subject, window_start) with counts default 0', () => {
    const cons = schema.tables.get('rate_limit_windows')!.constraints!;
    expect(cons.primaryKey).toEqual(['subject', 'window_start']);
    expect(col('rate_limit_windows', 'prev_count').default).toBe(0);
    expect(col('rate_limit_windows', 'curr_count').default).toBe(0);
  });

  it('country_code is CHAR(2) NOT NULL DEFAULT ZZ with ^[A-Z]{2}$ CHECK (§13-c3)', () => {
    for (const t of ['country_buckets_daily', 'country_totals']) {
      const c = col(t, 'country_code');
      expect(c.type).toBe('char(2)');
      expect(c.notNull).toBe(true);
      expect(funcDefault(c)).toBe(`'ZZ'`);
      expect(c.check).toBe("country_code ~ '^[A-Z]{2}$'");
    }
  });

  it('every analytics table cascades on link delete (FR-5.3/AD-13)', () => {
    for (const t of [
      'click_buckets_daily',
      'referrer_buckets_daily',
      'country_buckets_daily',
      'referrer_totals',
      'country_totals',
    ]) {
      expect(col(t, 'link_id').onDelete).toBe('CASCADE');
      expect(col(t, 'link_id').references).toBe('links');
      expect(col(t, 'count').type).toBe('bigint');
    }
  });

  it('analytics tables use composite primary keys (no NULL keys)', () => {
    expect(schema.tables.get('click_buckets_daily')!.constraints!.primaryKey).toEqual(['link_id', 'day']);
    expect(schema.tables.get('referrer_buckets_daily')!.constraints!.primaryKey).toEqual([
      'link_id',
      'day',
      'referrer_host',
    ]);
    expect(schema.tables.get('country_buckets_daily')!.constraints!.primaryKey).toEqual([
      'link_id',
      'day',
      'country_code',
    ]);
    expect(schema.tables.get('referrer_totals')!.constraints!.primaryKey).toEqual(['link_id', 'referrer_host']);
    expect(schema.tables.get('country_totals')!.constraints!.primaryKey).toEqual(['link_id', 'country_code']);
  });

  it('click_event_dedup is bare event_id PK + created_at (§13-c1)', () => {
    expect(col('click_event_dedup', 'event_id').primaryKey).toBe(true);
    expect(col('click_event_dedup', 'event_id').type).toBe('text');
    expect(funcDefault(col('click_event_dedup', 'created_at'))).toBe('now()');
  });

  it('identity child tables cascade on user delete', () => {
    for (const t of ['email_tokens', 'refresh_tokens', 'api_keys']) {
      expect(col(t, 'user_id').onDelete).toBe('CASCADE');
    }
    expect(col('api_keys', 'key_prefix').unique).toBe(true);
    expect(col('api_keys', 'key_hash').notNull).toBe(true);
  });
});

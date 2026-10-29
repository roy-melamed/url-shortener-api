import { describe, expect, it } from 'vitest';
import { recordAll } from '../helpers/schema-recorder.ts';
import { up as identityUp } from '../../migrations/1793270000001-identity-tables.ts';
import { up as slugsUp } from '../../migrations/1793270000002-slugs-links.ts';
import { up as idemUp } from '../../migrations/1793270000003-idempotency-rate-limit.ts';
import { up as analyticsUp } from '../../migrations/1793270000004-analytics-tables.ts';
import { up as dedupUp } from '../../migrations/1793270000005-click-event-dedup.ts';

/**
 * CI privacy gate — design §6.5, URL-8 acceptance.
 *
 * Runs with NO database (records the real migrations via the mock pgm), so it
 * is enforced on every `npm test` / CI run. Fails the build if any table grows
 * a visitor-IP-like or user-agent-like column, per FR-5.2 / NFR-4 (no visitor
 * PII stored) and the §6.5 schema-review gate.
 */

const schema = recordAll([identityUp, slugsUp, idemUp, analyticsUp, dedupUp]);

// Privacy: identifiers that would store visitor IP or user-agent data.
// Token/exact matching — NOT raw substring — because legitimate columns such as
// `principal` contain the substring "ip" and must not trip the gate.
const FORBIDDEN_NAME =
  /^(ip|ip_.*|.*_ip|.*_ip_.*|ipaddress|ip_?addr.*|.*_ip_?addr.*|user_?agent|.*_user_?agent|.*_ua|ua|remote_?addr.*|x_?forwarded_?for|.*_forwarded_?for)$/i;
const FORBIDDEN_SUBSTRINGS = ['useragent', 'user_agent', 'ipaddress', 'ip_address'];

function isPrivacyForbidden(columnName: string): boolean {
  const n = columnName.toLowerCase();
  if (FORBIDDEN_NAME.test(n)) return true;
  return FORBIDDEN_SUBSTRINGS.some((s) => n.includes(s));
}

describe('CI privacy gate (design §6.5 — no visitor IP / user-agent columns)', () => {
  it('records every §4.1 table', () => {
    const expected = [
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
    ];
    for (const t of expected) expect(schema.tables.has(t), `missing table ${t}`).toBe(true);
  });

  it('has no IP- or user-agent-like column in ANY table', () => {
    const offenders: string[] = [];
    for (const [table, rec] of schema.tables) {
      for (const col of rec.columns) {
        if (isPrivacyForbidden(col.name)) offenders.push(`${table}.${col.name}`);
      }
    }
    expect(offenders, `privacy-violating columns: ${offenders.join(', ')}`).toEqual([]);
  });

  it('keeps click_event_dedup to a bare ULID + created_at only (§13-c1)', () => {
    const dedup = schema.tables.get('click_event_dedup')!;
    const cols = dedup.columns.map((c) => c.name).sort();
    expect(cols).toEqual(['created_at', 'event_id']);
    expect(dedup.columns.find((c) => c.name === 'event_id')!.primaryKey).toBe(true);
    expect(dedup.columns.find((c) => c.name === 'event_id')!.type).toBe('text');
  });

  it('stores referrer as host only and country as a code — no raw URL/IP columns', () => {
    // The analytics tables carry only host + 2-letter country + counts.
    for (const t of ['referrer_buckets_daily', 'referrer_totals']) {
      expect(schema.tables.get(t)!.columns.some((c) => c.name === 'referrer_host')).toBe(true);
    }
    for (const t of ['country_buckets_daily', 'country_totals']) {
      expect(schema.tables.get(t)!.columns.some((c) => c.name === 'country_code')).toBe(true);
    }
  });
});

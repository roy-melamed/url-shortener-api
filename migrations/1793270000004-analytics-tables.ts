import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * Analytics aggregates — design §4.1, §4.3 (FR-5, AD-2, AD-9, AD-10, §13-c3).
 *
 * Aggregate-only: NO raw click-event rows are ever stored (AD-10). Daily
 * buckets are working data purged at 30 days; all-time totals are permanent
 * and un-capped BIGINT (AD-9). Every table cascades on link delete (FR-5.3).
 *
 * §13-c3 correction: `country_code` is `CHAR(2) NOT NULL DEFAULT 'ZZ'` with a
 * `^[A-Z]{2}$` CHECK on BOTH country tables. The `'ZZ'` sentinel is the ISO
 * 3166-1 user-assigned "unknown" bucket, so it is never NULL — NULLs are not
 * equal, which would break `ON CONFLICT` upserts and silently duplicate rows.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.createTable(
    'click_buckets_daily',
    {
      link_id: { type: 'uuid', notNull: true, references: 'links', onDelete: 'CASCADE' },
      day: { type: 'date', notNull: true },
      count: { type: 'bigint', notNull: true },
    },
    { constraints: { primaryKey: ['link_id', 'day'] } },
  );

  pgm.createTable(
    'referrer_buckets_daily',
    {
      link_id: { type: 'uuid', notNull: true, references: 'links', onDelete: 'CASCADE' },
      day: { type: 'date', notNull: true },
      referrer_host: { type: 'text', notNull: true }, // host only, lowercased (§6.5)
      count: { type: 'bigint', notNull: true },
    },
    { constraints: { primaryKey: ['link_id', 'day', 'referrer_host'] } },
  );

  pgm.createTable(
    'country_buckets_daily',
    {
      link_id: { type: 'uuid', notNull: true, references: 'links', onDelete: 'CASCADE' },
      day: { type: 'date', notNull: true },
      country_code: {
        type: 'char(2)',
        notNull: true,
        // `pgm.func` yields a PgLiteral that is NOT string-escaped, so the
        // default persists as the clean `'ZZ'` sentinel (§13-c3).
        default: pgm.func(`'ZZ'`), // §13-c3 unknown sentinel — never NULL
        check: "country_code ~ '^[A-Z]{2}$'", // §13-c3
      },
      count: { type: 'bigint', notNull: true },
    },
    { constraints: { primaryKey: ['link_id', 'day', 'country_code'] } },
  );

  // All-time rollups: permanent, un-capped BIGINT (AD-9/AD-10).
  pgm.createTable(
    'referrer_totals',
    {
      link_id: { type: 'uuid', notNull: true, references: 'links', onDelete: 'CASCADE' },
      referrer_host: { type: 'text', notNull: true },
      count: { type: 'bigint', notNull: true },
    },
    { constraints: { primaryKey: ['link_id', 'referrer_host'] } },
  );

  pgm.createTable(
    'country_totals',
    {
      link_id: { type: 'uuid', notNull: true, references: 'links', onDelete: 'CASCADE' },
      country_code: {
        type: 'char(2)',
        notNull: true,
        // `pgm.func` yields a PgLiteral that is NOT string-escaped, so the
        // default persists as the clean `'ZZ'` sentinel (§13-c3).
        default: pgm.func(`'ZZ'`), // §13-c3 unknown sentinel — never NULL
        check: "country_code ~ '^[A-Z]{2}$'", // §13-c3
      },
      count: { type: 'bigint', notNull: true },
    },
    { constraints: { primaryKey: ['link_id', 'country_code'] } },
  );
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropTable('country_totals', { ifExists: true });
  pgm.dropTable('referrer_totals', { ifExists: true });
  pgm.dropTable('country_buckets_daily', { ifExists: true });
  pgm.dropTable('referrer_buckets_daily', { ifExists: true });
  pgm.dropTable('click_buckets_daily', { ifExists: true });
}

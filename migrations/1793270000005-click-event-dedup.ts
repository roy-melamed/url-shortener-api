import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * Click event dedup — design §4.1, §3.6 (FR-4.4, NFR-4, §13-c1).
 *
 * §13-c1 correction: SQS standard at-least-once delivery can deliver a click
 * more than once. `event_id` is the bare ULID emitted at click time and serves
 * as the PRIMARY KEY; the aggregator inserts `ON CONFLICT (event_id) DO NOTHING`
 * in the same transaction as the aggregate upserts → exactly-once counting
 * effects without a FIFO queue.
 *
 * Privacy (§6.5): the row holds ONLY the bare ULID token + `created_at` — no
 * link/referrer/country/IP/payload — so it is not a click-event record. Rows
 * are purged at 7 days by maintenanceFn (well under the FR-5.2(c) 30-day
 * ceiling). The CI privacy gate asserts this table never grows extra columns.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.createTable('click_event_dedup', {
    event_id: { type: 'text', primaryKey: true }, // bare ULID token only
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropTable('click_event_dedup', { ifExists: true });
}

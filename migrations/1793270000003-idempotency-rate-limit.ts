import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * Idempotency & rate limiting — design §4.1, §3.5 (FR-2.5, FR-8, AD-7, §13-c2).
 *
 * `idempotency_records` is scoped by `UNIQUE (principal, key)`. Per §13-c2 the
 * create runs in a SINGLE ACID transaction and only ever persists
 * `state = 'completed'`; the `in_progress` value is eliminated. The
 * `state IN (...)` CHECK is RETAINED for forward compatibility (design §4.1)
 * but the application writes only 'completed'. `link_id` intentionally has NO
 * foreign key (design sketch): the row is a durable response snapshot, so a
 * deleted link must not cascade-delete the record (a replay must still return
 * the stored response) nor be blocked by it.
 *
 * `rate_limit_windows` backs the AD-7 in-app sliding window (subjects
 * `user:`/`apikey:`), keyed by `(subject, window_start)`.
 */
export function up(pgm: MigrationBuilder): void {
  pgm.createTable(
    'idempotency_records',
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      principal: { type: 'text', notNull: true }, // 'user:<uuid>' | 'apikey:<uuid>'
      key: { type: 'text', notNull: true },
      request_hash: { type: 'text', notNull: true },
      state: {
        type: 'text',
        notNull: true,
        check: "state IN ('in_progress','completed')", // §13-c2: only 'completed' written
      },
      response_status: { type: 'integer' },
      response_body: { type: 'jsonb' },
      link_id: { type: 'uuid' }, // no FK by design — durable response snapshot
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      expires_at: { type: 'timestamptz', notNull: true },
    },
    { constraints: { unique: [['principal', 'key']] } },
  );

  pgm.createTable(
    'rate_limit_windows',
    {
      subject: { type: 'text', notNull: true }, // 'user:<uuid>' | 'apikey:<uuid>'
      window_start: { type: 'timestamptz', notNull: true },
      prev_count: { type: 'integer', notNull: true, default: 0 },
      curr_count: { type: 'integer', notNull: true, default: 0 },
    },
    { constraints: { primaryKey: ['subject', 'window_start'] } },
  );
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropTable('rate_limit_windows', { ifExists: true });
  pgm.dropTable('idempotency_records', { ifExists: true });
}

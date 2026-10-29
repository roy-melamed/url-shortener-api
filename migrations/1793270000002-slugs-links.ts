import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * Slugs & links — design §4.1 (FR-2.x, FR-3.x, AD-4, AD-5, AD-8, AD-9).
 *
 * `slug_reservations.slug` carries the strict AD-8 CHECK `^[a-zA-Z0-9]{3,50}$`
 * (alphanumeric only, NO hyphens) — a hard human decision (X-5/D4). It is kept
 * EXACTLY as written; the PRD AC-3 `my-campaign` example would be rejected and
 * that contradiction is tracked for a new human ruling, not silently relaxed
 * here. `released_at` is retained as a future extension point but is never set
 * in MVP (AD-5: slugs locked FCFS permanently).
 *
 * `links.user_id` is NOT NULL (AD-4: anonymous create forbidden) and cascades
 * on user delete (AD-13). `links.slug` references the reservation with no
 * ON DELETE, so deleting a link never releases its slug (AD-5).
 */
export function up(pgm: MigrationBuilder): void {
  pgm.createTable('slug_reservations', {
    slug: {
      type: 'text',
      primaryKey: true,
      check: "slug ~ '^[a-zA-Z0-9]{3,50}$'", // AD-8 strict charset — DO NOT RELAX
    },
    reserved_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    released_at: { type: 'timestamptz' }, // ALWAYS NULL in MVP (AD-5)
  });

  pgm.createTable('links', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: {
      type: 'uuid',
      notNull: true, // AD-4: anonymous create forbidden
      references: 'users',
      onDelete: 'CASCADE', // AD-13: hard-delete cascade
    },
    slug: { type: 'text', notNull: true, references: 'slug_reservations' }, // no ON DELETE → slug stays reserved (AD-5)
    destination_url: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    expires_at: { type: 'timestamptz' }, // NULL = permanent (FR-2.6)
    click_count: { type: 'bigint', notNull: true, default: 0 }, // un-capped all-time total (AD-9)
  });

  pgm.createIndex('links', 'slug', { name: 'links_slug_uk', unique: true });
  pgm.createIndex(
    'links',
    [
      { name: 'user_id' },
      { name: 'created_at', sort: 'DESC' },
    ],
    { name: 'links_user_idx' },
  );
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropTable('links', { ifExists: true });
  pgm.dropTable('slug_reservations', { ifExists: true });
}

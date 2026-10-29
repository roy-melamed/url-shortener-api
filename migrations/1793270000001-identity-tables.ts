import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * Identity tables — design §4.1 (FR-1.x, AD-13, AD-14).
 *
 * `users.email` is CITEXT (case-insensitive) so registration/login/verification
 * treat `Foo@x.com` and `foo@x.com` as one account. `password_hash` is nullable
 * because social-only accounts (Google/GitHub, AD-14) have no password.
 * `auth_identities` is Google/GitHub only (AD-14). Every child table cascades
 * on user delete (AD-13 hard-delete cascade).
 */
export function up(pgm: MigrationBuilder): void {
  pgm.createExtension('citext', { ifNotExists: true });

  pgm.createTable('users', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    email: { type: 'citext', notNull: true, unique: true },
    password_hash: { type: 'text' }, // NULL = social-only account (AD-14)
    email_verified_at: { type: 'timestamptz' }, // double opt-in (AD-14)
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createTable(
    'auth_identities',
    {
      user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
      provider: { type: 'text', notNull: true }, // 'google' | 'github' (AD-14)
      provider_subject: { type: 'text', notNull: true },
    },
    { constraints: { unique: [['provider', 'provider_subject']] } },
  );

  pgm.createTable('email_tokens', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    purpose: { type: 'text', notNull: true },
    token_hash: { type: 'text', notNull: true },
    expires_at: { type: 'timestamptz', notNull: true },
    used_at: { type: 'timestamptz' },
  });

  pgm.createTable('refresh_tokens', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    token_hash: { type: 'text', notNull: true },
    family_id: { type: 'uuid', notNull: true },
    expires_at: { type: 'timestamptz', notNull: true },
    revoked_at: { type: 'timestamptz' },
  });

  pgm.createTable('api_keys', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    key_prefix: { type: 'text', notNull: true, unique: true }, // clear, O(1) lookup
    key_hash: { type: 'text', notNull: true }, // SHA-256 of full key
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    last_used_at: { type: 'timestamptz' },
    revoked_at: { type: 'timestamptz' },
  });
}

export function down(pgm: MigrationBuilder): void {
  pgm.dropTable('api_keys', { ifExists: true });
  pgm.dropTable('refresh_tokens', { ifExists: true });
  pgm.dropTable('email_tokens', { ifExists: true });
  pgm.dropTable('auth_identities', { ifExists: true });
  pgm.dropTable('users', { ifExists: true });
  pgm.dropExtension('citext', { ifExists: true });
}

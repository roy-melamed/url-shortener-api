/** Disposable test child: kill ONLY THIS PROCESS after uncommitted link insert. */
import { Pool } from 'pg';
import { generateKeyPairSync } from 'node:crypto';
import { buildApp } from '../../src/app.ts';
import { loadConfig } from '../../src/platform/config.ts';
import { ApiKeys } from '../../src/auth/api-keys.ts';
import { JoseAccessTokens } from '../../src/auth/crypto.ts';
import { PostgresApiKeyStore } from '../../src/auth/postgres-api-key-store.ts';
import { BearerAuthentication } from '../../src/auth/bearer-auth.ts';
import { LinkCreation, type LinkCreationStore } from '../../src/links/create.ts';
import { PostgresLinkCreationStore } from '../../src/links/postgres-create-store.ts';

const url = new URL(process.env.TEST_ACCOUNT_DATABASE_URL!);
const [schema, userId] = process.argv.slice(2);
if (
  url.hostname !== '127.0.0.1' ||
  url.pathname !== '/account_auth_test' ||
  !/^account_fixture_[0-9a-f]+$/.test(schema ?? '') ||
  !/^[0-9a-f-]{36}$/.test(userId ?? '')
)
  throw new Error('Disposable crash fixture required.');
const pool = new Pool({
  connectionString: url.toString(),
  max: 2,
  options: `-c search_path=${schema},public`,
});
const store = new PostgresLinkCreationStore(pool);
const crashing: LinkCreationStore = {
  verifiedOwner: (id) => store.verifiedOwner(id),
  available: (slug) => store.available(slug),
  replay: (subject, key, now) => store.replay(subject, key, now),
  transaction: (work) =>
    store.transaction((tx) =>
      work({
        verifiedOwner: (id) => tx.verifiedOwner(id),
        claim: (claim) => tx.claim(claim),
        reserve: (slug) => tx.reserve(slug),
        complete: (subject, key, response) => tx.complete(subject, key, response),
        insert: async (...args) => {
          const result = await tx.insert(...args);
          await new Promise<void>((resolve) => {
            process.stdout.write('LINK_INSERTED_BEFORE_COMMIT\n', () => resolve());
          });
          process.kill(process.pid, 'SIGKILL');
          return result;
        },
      }),
    ),
};
const now = new Date('2026-11-20T12:00:00Z');
const apiKeys = new ApiKeys(new PostgresApiKeyStore(pool));
const accessTokens = new JoseAccessTokens({
  ...generateKeyPairSync('rsa', { modulusLength: 2048 }),
  issuer: 'crash-fixture',
  audience: 'crash-fixture',
  kid: 'crash-fixture',
});
const authentication = new BearerAuthentication({ apiKeys, accessTokens, now: () => now });
const app = buildApp({
  config: loadConfig({ DATABASE_URL: 'fixture-only', LOG_LEVEL: 'silent' }),
  links: new LinkCreation({
    store: crashing,
    publicBaseUrl: 'https://short.example.invalid',
    now: () => now,
  }),
  bearerAuth: { authentication, apiKeys },
});
await app.inject({
  method: 'POST',
  url: '/v1/links',
  payload: { destinationUrl: 'https://destination.example.invalid/crash' },
  headers: {
    authorization: `Bearer ${await accessTokens.issue(userId!, now)}`,
    'idempotency-key': 'crash-key',
  },
});
await app.close();
await pool.end();
throw new Error('Crash injection did not run.');

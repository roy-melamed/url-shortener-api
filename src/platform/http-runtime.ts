import { createPublicKey } from 'node:crypto';
import { buildApp } from '../app.ts';
import { ApiKeys } from '../auth/api-keys.ts';
import { BearerAuthentication } from '../auth/bearer-auth.ts';
import { JoseAccessTokenVerifier } from '../auth/crypto.ts';
import { PostgresApiKeyStore } from '../auth/postgres-api-key-store.ts';
import { LinkCreation } from '../links/create.ts';
import { PostgresLinkCreationStore } from '../links/postgres-create-store.ts';
import { ConfigError, loadConfig } from './config.ts';
import { createPool } from './db.ts';
import { processRequestLimiter } from './process-request-limiter.ts';

/** Production composition root shared by local and Lambda entrypoints.
 * All targets/trust settings come from explicit environment injection. No
 * generated/fallback keys, signing capability, provider discovery or test stores.
 */
export function buildRuntimeApp(environment: NodeJS.ProcessEnv = process.env) {
  const config = loadConfig(environment);
  let verifier: JoseAccessTokenVerifier;
  let origin: string;
  try {
    for (const name of [
      'PUBLIC_BASE_URL',
      'JWT_PUBLIC_KEY_PEM',
      'JWT_ISSUER',
      'JWT_AUDIENCE',
      'JWT_KEY_ID',
    ]) {
      if (typeof environment[name] !== 'string' || !environment[name]!.trim()) throw new Error();
    }
    // Do not accidentally accept a private PEM and derive its public half.
    if (environment.JWT_PUBLIC_KEY_PEM!.includes('PRIVATE KEY')) throw new Error();
    verifier = new JoseAccessTokenVerifier({
      publicKey: createPublicKey(environment.JWT_PUBLIC_KEY_PEM!),
      issuer: environment.JWT_ISSUER!,
      audience: environment.JWT_AUDIENCE!,
      kid: environment.JWT_KEY_ID!,
    });
    const url = new URL(environment.PUBLIC_BASE_URL!);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error();
    origin = url.origin;
  } catch {
    throw new ConfigError(
      'Invalid HTTP runtime configuration: require PUBLIC_BASE_URL and JWT_PUBLIC_KEY_PEM/JWT_ISSUER/JWT_AUDIENCE/JWT_KEY_ID.',
    );
  }
  // pg.Pool is lazy: boot/health/anonymous401 open no database connection.
  const pool = createPool(config);
  const apiKeys = new ApiKeys(new PostgresApiKeyStore(pool));
  const authentication = new BearerAuthentication({ apiKeys, accessTokens: verifier });
  const links = new LinkCreation({
    store: new PostgresLinkCreationStore(pool),
    publicBaseUrl: origin,
  });
  const app = buildApp({
    config,
    bearerAuth: { authentication, apiKeys },
    links,
    requestLimiter: processRequestLimiter,
  });
  pool.on('error', () => {
    app.log.error('Database connection unavailable.');
  });
  app.addHook('onClose', async () => {
    await pool.end();
  });
  return { app, config };
}

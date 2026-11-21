import { generateKeyPairSync } from 'node:crypto';
import { JoseAccessTokens } from '../../src/auth/crypto.ts';

// Test-only, ephemeral issuer. Production runtime never generates/signs keys.
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const runtimeFixtureTokens = new JoseAccessTokens({
  ...keys,
  issuer: 'runtime-fixture',
  audience: 'runtime-fixture',
  kid: 'runtime-fixture',
});
export function runtimeFixtureEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    // No DB should be contacted for boot/health/anonymous/invalid-JWT probes.
    DATABASE_URL: 'postgres://fixture@127.0.0.1:1/runtime_fixture',
    PUBLIC_BASE_URL: 'https://short.example.invalid',
    JWT_PUBLIC_KEY_PEM: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    JWT_ISSUER: 'runtime-fixture',
    JWT_AUDIENCE: 'runtime-fixture',
    JWT_KEY_ID: 'runtime-fixture',
    ...overrides,
  };
}

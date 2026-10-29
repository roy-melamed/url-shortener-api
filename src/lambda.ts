/**
 * AWS Lambda entrypoint — URL-7 (scaffolding).
 *
 * Wraps the SAME `buildApp` instance with `aws-lambda-fastify` (AD-12 /
 * design §1.3, §2 D-2): API Gateway (HTTP API v2) invokes this handler, and
 * the adapter bridges API-Gateway events to Fastify via `app.inject`.
 *
 * Env here is injected at deploy time (Secrets Manager / CDK outputs, design
 * §6.2) — `loadConfig()` reads `process.env`, so the env interface is identical
 * to local where values come from a gitignored `.env`. No dotenv here: the
 * cloud reads only injected env. `app.ready()` runs once at cold start to
 * amortize routing/setup across invocations.
 *
 * Entrypoint/platform layer — the only place `aws-lambda-fastify` may be
 * imported (portability seam, design §3.9).
 */
import awsLambdaFastify from 'aws-lambda-fastify';
import { loadConfig } from './platform/config.ts';
import { buildApp } from './app.ts';

const config = loadConfig();
const app = buildApp({ config });

// Warm routing/table once per cold start.
await app.ready();

/** API Gateway (HTTP API v2) → Fastify handler. */
export const handler = awsLambdaFastify(app);

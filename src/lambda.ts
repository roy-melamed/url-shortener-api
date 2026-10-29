/**
 * AWS Lambda entrypoint — URL-7 (scaffolding), re-pointed by URL-19.
 *
 * Wraps the SAME `buildApp` instance with `aws-lambda-fastify` (AD-12 /
 * design §1.3, §2 D-2): API Gateway (HTTP API v2) invokes this handler, and
 * the adapter bridges API-Gateway events to Fastify via `app.inject`.
 *
 * URL-19 note: the construction moved into `createHttpHandler()`
 * (`src/functions/http.ts`) because the CDK stack now deploys the HTTP surface
 * as two separate functions — `apiFn` (`src/functions/api.ts`) and `redirectFn`
 * (`src/functions/redirect.ts`) — which must share ONE handler implementation.
 * Behaviour is unchanged: env is injected at deploy time (Secrets Manager / CDK
 * outputs, design §6.2), `loadConfig()` reads `process.env`, and the app is
 * warmed once per cold start. No dotenv here: the cloud reads only injected env.
 *
 * Entrypoint/platform layer — the only place `aws-lambda-fastify` may be
 * imported (portability seam, design §3.9).
 */
import { createHttpHandler } from './functions/http.ts';

export const handler = createHttpHandler();

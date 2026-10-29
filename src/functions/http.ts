/**
 * Shared HTTP handler factory — URL-19 (CDK infrastructure).
 *
 * `redirectFn` and `apiFn` are two independent Lambda *deployments* (separate
 * scaling units and failure domains, design §1.2/§2 D-1) that run the SAME
 * Fastify application (dual entrypoint, AD-12 / design §1.3, §2 D-2). Routing
 * between them happens at API Gateway (design §3.1); this factory is the one
 * place the HTTP handler is constructed, so the two functions cannot diverge.
 *
 * Cold-start warm-up: `app.ready()` is kicked off when the container module is
 * loaded and awaited before the first event is served — identical to URL-7's
 * `await app.ready()` at module scope, minus the *top-level await*. The CDK
 * bundles are emitted as CommonJS (esbuild, `format: 'cjs'`), and top-level
 * await cannot be emitted into a CommonJS bundle, so the warm-up is expressed
 * as a stored promise instead.
 *
 * Platform/entrypoint layer — the only place `aws-lambda-fastify` may be
 * imported outside `src/lambda.ts` (portability seam, design §3.9). Env here is
 * injected at deploy time (Secrets Manager / CDK outputs, design §6.2); the
 * local runtime never uses this factory (it uses `src/index.ts` + `listen`).
 */
import awsLambdaFastify, { type PromiseHandler } from 'aws-lambda-fastify';
import { loadConfig } from '../platform/config.ts';
import { buildApp } from '../app.ts';

/**
 * Build the API Gateway (HTTP API v2) → Fastify handler.
 *
 * @throws {ConfigError} at construction time (cold start) when the injected
 *   environment is invalid — e.g. a deployed function that did not receive its
 *   `DATABASE_URL`/secret ARNs from the stack.
 */
export function createHttpHandler(): PromiseHandler {
  const app = buildApp({ config: loadConfig() });
  const bridge = awsLambdaFastify(app);
  // Warm routing/table once per cold start (URL-7 semantics, preserved).
  const ready = app.ready();

  return async (event, context) => {
    await ready;
    return bridge(event, context);
  };
}

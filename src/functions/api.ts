/**
 * `apiFn` entrypoint — URL-19 (CDK infrastructure).
 *
 * Serves the management surface at API Gateway: the static health routes
 * (`GET /healthz`, `GET /readyz`), everything under `/v1/*`, and the `$default`
 * JSON-404 route (design §3.1). Static paths take precedence over the
 * `{slug}` path-parameter route, both at the gateway and inside Fastify's
 * router, so `/healthz` can never be shadowed by a slug.
 *
 * Business routes land with their owning tickets (URL-12 `/v1` CRUD, URL-13
 * redirect path, URL-16 `/readyz`); until then the app answers with the §5.1
 * JSON 404 envelope.
 *
 * @see src/functions/redirect.ts for the independent redirect function.
 */
import { createHttpHandler } from './http.ts';

export const handler = createHttpHandler();

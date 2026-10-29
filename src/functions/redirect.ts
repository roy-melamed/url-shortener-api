/**
 * `redirectFn` entrypoint — URL-19 (CDK infrastructure).
 *
 * Serves the public redirect surface: `GET`/`HEAD /{slug}` (design §3.1/§3.2).
 * It is a separate Lambda deployment from `apiFn` so the hot redirect path gets
 * an independent scaling unit and bulk radius of failure (NFR-3, design §2
 * D-1) — both run the same Fastify app (`createHttpHandler`).
 *
 * Redirect behaviour (Tier-1 LRU, 302 + `Cache-Control: no-store`, transient
 * GeoIP, best-effort SQS emission) lands with URL-13; until then unmatched
 * paths answer with the §5.1 JSON 404 envelope.
 *
 * @see src/functions/api.ts for the management API function.
 */
import { createHttpHandler } from './http.ts';

export const handler = createHttpHandler();

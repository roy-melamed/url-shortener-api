/**
 * Config-driven redirect response — URL-18 (foundation bootstrap).
 *
 * The redirect status and caching posture are product decisions fixed by
 * AD-1 / AC-FR-4.1: **302 Found** with `Cache-Control: no-store` (accurate
 * origin click counts, FR-4.4). This helper is the single place where the
 * validated config value becomes an HTTP response, so the default-config
 * integration test pins the behavior from day one.
 *
 * Scope note: the full redirect flow (slug lookup, 410/404, Tier-1 LRU cache,
 * GeoIP, click emission — design §3.2) belongs to the redirect/app tickets;
 * this foundation-level helper will be absorbed by that implementation.
 */
import type { AppConfig } from './config.js';

export interface RedirectResponse {
  statusCode: 301 | 302;
  headers: Record<string, string>;
}

/**
 * Build the redirect response for an active link.
 *
 * @param destination Validated destination URL (http/https, ≤2048 chars —
 *   enforced by the create-flow validator in the links module).
 * @param config Validated application configuration.
 */
export function redirectResponse(destination: string, config: AppConfig): RedirectResponse {
  return {
    statusCode: config.redirectStatus,
    headers: {
      location: destination,
      // AD-1: 302s are not browser-cacheable; no-store keeps every repeat
      // visit reaching origin so aggregate click counts stay accurate.
      'cache-control': 'no-store',
    },
  };
}

/**
 * Domain module: geo — transient request-time GeoIP resolution (design §3.2,
 * AD-2 Option B: the source IP never leaves memory; only a country code is
 * emitted).
 *
 * Placeholder created by URL-18 (foundation bootstrap) so the module boundary
 * from design §3.9 exists from day one. Real implementation belongs to the
 * redirect/geo feature tickets.
 */
export const MODULE_NAME = 'geo';

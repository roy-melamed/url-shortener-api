/**
 * ULID generator — URL-7 (scaffolding).
 *
 * Used as the `genReqId` fallback when no `x-request-id` header is supplied
 * (design §5.1, §8.2: request IDs correlate the structured log line with the
 * error envelope). A ULID is a 26-character Crockford base32 string: a 48-bit
 * millisecond timestamp followed by 80 bits of CSPRNG randomness — sortable by
 * creation time and effectively collision-free for correlation IDs.
 *
 * Dependency-free so it runs identically on Lambda and locally (NFR-7).
 */
import { randomBytes } from 'node:crypto';

/** Crockford base32 alphabet (excludes I, L, O, U). */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;

/**
 * Generate a ULID.
 *
 * @param now Milliseconds since epoch (injectable for tests; default `Date.now()`).
 * @returns A 26-character Crockford base32 ULID.
 */
export function ulid(now: number = Date.now()): string {
  let time = '';
  let remaining = Math.max(0, Math.floor(now));
  for (let i = 0; i < TIME_CHARS; i += 1) {
    time = ENCODING[remaining % 32] + time;
    remaining = Math.floor(remaining / 32);
  }

  // Each random byte is 0–255; 256 = 8 × 32, so `% 32` stays uniform.
  const bytes = randomBytes(RANDOM_CHARS);
  let random = '';
  for (let i = 0; i < RANDOM_CHARS; i += 1) {
    random += ENCODING[(bytes[i] ?? 0) % 32];
  }

  return time + random;
}

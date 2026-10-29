import { describe, expect, it } from 'vitest';
import { ulid } from '../../src/platform/ulid.ts';

describe('ulid (requestId fallback, design §5.1/§8.2)', () => {
  it('generates a 26-character Crockford base32 id', () => {
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('sorts lexicographically by creation time', () => {
    const early = ulid(1_000_000);
    const late = ulid(2_000_000);
    expect(early < late).toBe(true);
  });

  it('is unique across many calls', () => {
    const ids = new Set(Array.from({ length: 1_000 }, () => ulid()));
    expect(ids.size).toBe(1_000);
  });
});

import { describe, expect, it } from 'vitest';
import {
  requestObservation,
  setRequestObservation,
  type RequestObservation,
} from '../../src/platform/request-observation.ts';
describe('feature-owner request observation extension', () => {
  it('defaults anonymous and records only bounded feature outcomes with a token-free principal', () => {
    const request = {};
    expect(requestObservation(request)).toEqual({
      principal: { type: 'anonymous', id: null },
      outcome: {},
    });
    setRequestObservation(request, {
      principal: { type: 'user', id: '12345678-1234-4123-8123-123456789abc' },
      outcome: { redirect: 'active', cache: 'hit', country: 'resolved' },
    });
    expect(requestObservation(request).outcome.cache).toBe('hit');
    for (const invalid of [
      { principal: { type: 'user', id: 'Bearer private' }, outcome: {} },
      { principal: { type: 'anonymous', id: 'private' }, outcome: {} },
      { principal: { type: 'admin', id: null }, outcome: {} },
      { principal: { type: 'anonymous', id: null }, outcome: { clientIp: '198.51.100.1' } },
      { principal: { type: 'anonymous', id: null }, outcome: { cache: 'private' } },
    ])
      expect(() => setRequestObservation({}, invalid as RequestObservation)).toThrow(
        'Invalid request observation',
      );
  });
});

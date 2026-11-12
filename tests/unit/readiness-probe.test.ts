import { describe, expect, it, vi } from 'vitest';
import { probeReadiness, runReadinessProbe } from '../../scripts/probe-readiness.ts';
describe('opt-in readiness observations, not availability history', () => {
  it('records success/failure without retaining URLs, errors or payloads', async () => {
    const fake = vi.fn().mockResolvedValue(new Response('private', { status: 200 }));
    expect(await probeReadiness('http://localhost/readyz', fake)).toMatchObject({
      healthy: true,
      timestamp: expect.any(String),
      durationMs: expect.any(Number),
    });
    fake.mockResolvedValue(new Response('private', { status: 503 }));
    expect((await probeReadiness('http://localhost/readyz', fake)).healthy).toBe(false);
    fake.mockRejectedValue(new Error('secret URL'));
    expect(JSON.stringify(await probeReadiness('private', fake))).not.toContain('private');
  });
  it('rejects invalid or unauthorized remote probes before any network request', async () => {
    for (const args of [
      [],
      ['not-url'],
      ['https://example.invalid/readyz'],
      ['http://localhost/wrong'],
      ['http://localhost/readyz?token=secret'],
      ['http://user:password@localhost/readyz'],
      ['http://localhost/readyz', '0'],
      ['http://localhost/readyz', '1', '0'],
    ])
      expect(await runReadinessProbe(args)).toBe(2);
  });
});

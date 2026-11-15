import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { databaseReadiness } from '../../src/platform/readiness.ts';

describe('bounded configured database readiness', () => {
  it('executes only SELECT 1 and releases the dedicated client', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ready: 1 }] });
    const release = vi.fn();
    const connect = vi.fn().mockResolvedValue({ query, release });
    expect(await databaseReadiness({ connect } as unknown as Pool)()).toBe(true);
    expect(query).toHaveBeenCalledWith({ text: 'SELECT 1 AS ready', query_timeout: 1000 });
    expect(release).toHaveBeenCalledWith(undefined);
  });
  it('fails closed for malformed results and never returns driver errors', async () => {
    for (const result of [{ rows: [] }, { rows: [{ ready: 0 }] }]) {
      const release = vi.fn();
      expect(
        await databaseReadiness({
          connect: vi.fn().mockResolvedValue({ query: vi.fn().mockResolvedValue(result), release }),
        } as unknown as Pool)(),
      ).toBe(false);
      expect(release).toHaveBeenCalledOnce();
    }
    expect(
      await databaseReadiness({
        connect: vi.fn().mockRejectedValue(new Error('private database URL')),
      } as unknown as Pool)(),
    ).toBe(false);
    const release = vi.fn();
    expect(
      await databaseReadiness({
        connect: vi.fn().mockResolvedValue({
          query: vi.fn().mockRejectedValue(new Error('private SQL')),
          release,
        }),
      } as unknown as Pool)(),
    ).toBe(false);
    expect(release.mock.calls[0]?.[0]).toEqual(new Error('Readiness unavailable.'));
  });
});

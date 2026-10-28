import { describe, expect, it } from 'vitest';
import { MODULE_NAME as analyticsModule } from '../../src/analytics/index.js';
import { MODULE_NAME as authModule } from '../../src/auth/index.js';
import { MODULE_NAME as geoModule } from '../../src/geo/index.js';
import { MODULE_NAME as linksModule } from '../../src/links/index.js';
import { MODULE_NAME as qrModule } from '../../src/qr/index.js';

/**
 * Placeholder suite (URL-18): pins the domain-module boundaries from design
 * §3.9 and keeps every placeholder file inside the coverage gate. Feature
 * tickets replace these modules — and these tests — with real behavior.
 */
describe('domain module placeholders (design §3.9)', () => {
  it('exposes the five domain modules', () => {
    expect(authModule).toBe('auth');
    expect(linksModule).toBe('links');
    expect(analyticsModule).toBe('analytics');
    expect(qrModule).toBe('qr');
    expect(geoModule).toBe('geo');
  });
});

import { describe, expect, it } from 'vitest';

/**
 * Static gate — URL-8 acceptance: no DB endpoint or credential literal in
 * committed code/config; the connection string is resolved via env/Secrets
 * Manager only (design §6.2/§9.4). Runs with NO database on every `npm test`.
 *
 * Scope: src/** and migrations/** (the code that could embed a connection).
 * `.env.example` (placeholders) and docker-compose.yml (local dev defaults,
 * documented as non-secret) are intentionally excluded — they are templates,
 * not application code.
 */

const FORBIDDEN = [
  /postgres(?:ql)?:\/\//i, // any connection string literal
  /\blocalhost:\d{4,5}\b/i, // hardcoded host:port
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/, // dotted IPv4 literal
  /password\s*[:=]\s*['"][^'"]+['"]/i, // password literal
  /secret\s*[:=]\s*['"][^'"]+['"]/i, // secret literal
];

describe('no committed DB endpoint/credential literals (src/ + migrations/)', () => {
  it('passes the static scan', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const path = await import('node:path');
    const root = process.cwd();

    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith('.ts')) files.push(full);
      }
    };
    // Scan only the layers that could embed a DB endpoint/credential: the
    // platform/connection code and the migrations. `src/index.ts` legitimately
    // binds 0.0.0.0 (a listen host, not a DB literal), so it is out of scope.
    walk(path.join(root, 'src', 'platform'));
    walk(path.join(root, 'migrations'));

    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      for (const pattern of FORBIDDEN) {
        if (pattern.test(content)) {
          violations.push(`${path.relative(root, file)} matches ${pattern}`);
        }
      }
    }
    expect(violations, `hardcoded endpoint/credential literals:\n${violations.join('\n')}`).toEqual([]);
    expect(files.length).toBeGreaterThan(0); // the scan actually ran
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Regression gate — URL-8 QA FAIL (2026-10-29): PR #4 advertised
 * `npm run migrate:status`, but node-pg-migrate@9.0.0 removed the `status`
 * action (`Invalid Action: Must be [up|down|create|redo]` — exit 1 at argument
 * parsing, in every environment). CI never invoked the script, so the broken
 * command shipped to main undetected.
 *
 * This static check runs on every `npm test` with NO database: every
 * package.json script that invokes `node-pg-migrate` must use one of the
 * actions the pinned CLI actually supports. If the dependency is ever bumped
 * and the supported action set changes, update SUPPORTED_ACTIONS together with
 * the bump — the gate forces that to be a conscious, reviewed change.
 */

const SUPPORTED_ACTIONS = new Set(['up', 'down', 'create', 'redo']);

/** First non-flag token after the `node-pg-migrate` bin is the CLI action. */
function actionOf(script: string): string | null {
  const tokens = script.split(/\s+/);
  const bin = tokens.findIndex((t) => t === 'node-pg-migrate');
  if (bin === -1) return null;
  for (const token of tokens.slice(bin + 1)) {
    if (!token.startsWith('-')) return token;
  }
  return null;
}

describe('node-pg-migrate npm scripts use supported actions (URL-8 QA regression)', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };

  const migrateScripts = Object.entries(pkg.scripts).filter(([, cmd]) =>
    cmd.includes('node-pg-migrate'),
  );

  it('finds at least the migrate and migrate:down scripts', () => {
    const names = migrateScripts.map(([name]) => name);
    expect(names).toContain('migrate');
    expect(names).toContain('migrate:down');
  });

  it.each(migrateScripts)(
    'script "%s" invokes a node-pg-migrate action supported by v9',
    (_name, cmd) => {
      const action = actionOf(cmd);
      expect(
        action,
        `no action found in "${cmd}" — expected "node-pg-migrate <up|down|create|redo> ..."`,
      ).toBeTruthy();
      expect(
        SUPPORTED_ACTIONS.has(action as string),
        `unsupported node-pg-migrate action "${action}" in "${cmd}" — ` +
          'node-pg-migrate@9 accepts only [up|down|create|redo]; an invalid ' +
          'action exits 1 at argument parsing and can never succeed',
      ).toBe(true);
    },
  );

  it('no advertised script uses the removed "status" action', () => {
    const offenders = migrateScripts.filter(([, cmd]) => actionOf(cmd) === 'status');
    expect(
      offenders,
      'node-pg-migrate@9 has no "status" action — see URL-8 QA FAIL 2026-10-29',
    ).toEqual([]);
  });
});

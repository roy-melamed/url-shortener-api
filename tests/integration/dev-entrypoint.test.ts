import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';

/**
 * URL-7 rework smoke check (Dwight blocker: AC1/AC2 `npm run dev`).
 *
 * The bug class: `src/**` used `.js` import specifiers. `tsc` build and Vitest
 * both map `.js -> .ts`, so typecheck/tests/build stayed green — but Node's
 * NATIVE type-stripping runtime (`node --experimental-strip-types src/index.ts`,
 * i.e. what `npm run dev` runs) resolves specifiers LITERALLY and does NOT map
 * `.js` to `.ts`, so the dev entrypoint died with ERR_MODULE_NOT_FOUND before
 * `listen()`. CI never ran `npm run dev`, so it never caught it.
 *
 * Two guards make this class of failure impossible to merge again:
 *  1. A deterministic static check that every relative specifier in `src/**`
 *     literally resolves to an existing file on disk (exactly how Node native
 *     resolves) — fast, no process, no flakiness.
 *  2. A real spawn of the dev entrypoint (`node --experimental-strip-types
 *     src/index.ts`) that must boot and answer `GET /healthz` with 200 — the
 *     end-to-end proof of the exact path Dwight exercised.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Extract relative import/export specifiers from a TS source file. */
function relativeSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const re = /(?:from\s*|import\s*\(?\s*)['"](\.[^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) specifiers.push(match[1]!);
  return specifiers;
}

describe('dev entrypoint module resolution (AC1/AC2 guard)', () => {
  it('every relative specifier in src/** literally resolves on disk (Node-native rule)', () => {
    const srcDir = path.join(repoRoot, 'src');
    const files = listTsFiles(srcDir);
    expect(files.length).toBeGreaterThan(0);

    const problems: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const specifier of relativeSpecifiers(source)) {
        // Node native resolves the specifier literally — the target must exist.
        const resolved = path.resolve(path.dirname(file), specifier);
        if (!existsSync(resolved)) {
          problems.push(`${path.relative(repoRoot, file)} -> '${specifier}' (missing ${path.relative(repoRoot, resolved)})`);
        }
        // The dev runtime only strips types from `.ts`; enforce the convention.
        if (!specifier.endsWith('.ts')) {
          problems.push(`${path.relative(repoRoot, file)} -> '${specifier}' (must use .ts specifier for the native dev runtime)`);
        }
      }
    }
    expect(problems, `Node-native resolution problems:\n${problems.join('\n')}`).toEqual([]);
  });

  it('boots the real dev entrypoint and serves GET /healthz 200', async () => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', 'src/index.ts'],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          NODE_ENV: 'development',
          LOG_LEVEL: 'silent',
          PORT: String(port),
          DATABASE_URL: 'postgres://smoke:smoke@localhost:5432/smoke',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    let response: Response | undefined;
    try {
      // Wait for the server to answer; bail early if the child dies (e.g. the
      // ERR_MODULE_NOT_FOUND failure this guard exists to catch).
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) {
          throw new Error(
            `dev entrypoint exited with code ${child.exitCode} before listening.\nstderr:\n${stderr}`,
          );
        }
        try {
          response = await fetch(`${baseUrl}/healthz`);
          break;
        } catch {
          await delay(150);
        }
      }

      expect(response, `server never became reachable.\nstderr:\n${stderr}`).toBeDefined();
      expect(response!.status).toBe(200);
      expect(await response!.json()).toEqual({ status: 'ok' });
      expect(stderr).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find module/);
    } finally {
      child.kill('SIGTERM');
      await delay(200);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });
});

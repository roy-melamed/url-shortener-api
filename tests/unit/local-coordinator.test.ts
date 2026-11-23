import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('runs the disposable local coordinator Python regression suite', () => {
  const cwd = fileURLToPath(new URL('../../', import.meta.url));
  const result = spawnSync(
    'python3',
    ['-B', '-m', 'unittest', 'discover', '-s', 'tests/local-coordinator', '-v'],
    {
      cwd,
      env: { ...process.env, PYTHONPATH: 'tools/local-coordinator/src' },
      encoding: 'utf8',
      timeout: 90_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stderr).toContain('OK');
}, 95_000);

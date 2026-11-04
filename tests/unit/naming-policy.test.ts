import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkRepository, checkSource } from '../../scripts/check-naming-policy.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
// Dwight R1/R2: each probe is tested through the helper AND the real CLI.
const reviewProbes: [string, string, number][] = [
  ['deploy/quoted.yml', 'services:\n  "URL-27-worker":\n    image: app', 1],
  ['deploy/quoted.yml', "services:\n  'URL-27-worker':\n    image: app", 1],
  ['deploy/quoted.yml', 'services:\n  postgres:\n    "container_name": "URL-27-postgres"', 1],
  ['deploy/quoted.yml', "services:\n  postgres:\n    'container_name': 'URL-27-postgres'", 1],
  ['deploy/quoted.yml', '\'container_name\': "url8-pg"', 1],
  ['deploy/quoted.yml', '"container_name": \'url27-backup\'', 1],
  ['deploy/quoted.yml', '"container_name": "url8"', 0],
  ['deploy/quoted.yml', "'image': 'api-v2'", 0],
  ['deploy/quoted.yml', '"container_name": "postgres16" # tracks URL-27', 0],
  [
    '.github/workflows/demo.yml',
    'name: CI\non: push\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "example --name URL-27"',
    0,
  ],
  ['scripts/demo.sh', 'echo done # example docker run --name URL-27 postgres', 0],
  ['scripts/demo.sh', 'printf "%s\\n" "Example: CREATE TABLE URL-27"', 0],
  ['scripts/demo.sh', 'echo "docker run --name URL-27 postgres"', 0],
  ['scripts/demo.sh', 'docker run --name URL-27 postgres', 1],
  ['scripts/demo.sh', 'docker run --name "URL-27" postgres # real declaration', 1],
  ['scripts/demo.sh', "docker run --name 'URL-27' postgres", 1],
  ['scripts/demo.sh', 'echo done; docker run --name=URL-27 postgres', 1],
  [
    '.github/workflows/demo.yml',
    'name: CI\nsteps:\n  - run: docker run --name "URL-27" postgres',
    1,
  ],
  ['migrations/schema.sql', 'CREATE TABLE "URL-27" (id INT);', 1],
  ['migrations/schema.sql', 'CREATE UNIQUE INDEX "URL-27-index" ON links(slug);', 1],
  ['deploy/quoted.yml', '"container_name": "url8-pg" # real declaration', 1],
  [
    '.github/workflows/demo.yml',
    'name: CI\nsteps:\n  - run: |\n      echo "example --name URL-27"\n      docker run --name URL-27 postgres',
    1,
  ],
  [
    '.github/workflows/demo.yml',
    'name: CI\nsteps:\n  - run: |\n      echo done # example docker run --name URL-27 postgres\n      printf "%s\\n" "Example: CREATE TABLE URL-27"',
    0,
  ],
  ['.github/workflows/demo.yml', 'name: CI\ndescription: docker run --name URL-27 postgres', 0],
  [
    'scripts/demo.sh',
    "printf '%s\\n' 'Example: CREATE TABLE URL-27'; docker create --name URL-27 postgres",
    1,
  ],
  ['scripts/demo.sh', 'sudo -n docker container run --name "URL-27" postgres', 1],
  ['scripts/demo.sh', 'docker run --name postgres16 postgres # example --name URL-27', 0],
  ['migrations/schema.sql', "-- CREATE TABLE URL-27\nSELECT 'Example: CREATE TABLE URL-27';", 0],
  ['migrations/schema.sql', '/* CREATE TABLE URL-27 */\nCREATE TABLE ipv6_addresses(id INT);', 0],
  ['migrations/schema.sql', '-- example CREATE TABLE good\nCREATE TABLE "URL-27"(id INT);', 1],
];
describe('naming declaration guard', () => {
  it.each(reviewProbes)('R1/R2 helper: %s %s', (file, body, count) => {
    expect(checkSource(file, body)).toHaveLength(count);
  });

  it.each(reviewProbes)('R1/R2 real CLI: %s %s', (file, body, count) => {
    const tmp = mkdtempSync(join(tmpdir(), 'naming-review-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: tmp });
      mkdirSync(join(tmp, file, '..'), { recursive: true });
      writeFileSync(join(tmp, file), body);
      execFileSync('git', ['add', '.'], { cwd: tmp });
      const run = spawnSync(
        process.execPath,
        ['--experimental-strip-types', join(root, 'scripts/check-naming-policy.ts')],
        {
          cwd: tmp,
          encoding: 'utf8',
          env: {
            ...process.env,
            HTTP_PROXY: 'http://127.0.0.1:9',
            HTTPS_PROXY: 'http://127.0.0.1:9',
          },
        },
      );
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(count ? 1 : 0);
      expect(run.stdout).toContain(`${count} violation(s)`);
      if (count) expect(run.stderr).toContain(`${file}:`);
      expect(readFileSync(join(tmp, file), 'utf8')).toBe(body);
      expect(execFileSync('git', ['diff', '--exit-code'], { cwd: tmp, encoding: 'utf8' })).toBe('');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
  it.each([
    ['infra/resource.ts', 'const r = { bucketName: "URL-27-backups" };'],
    ['infra/resource.ts', 'new Queue(this, "URL-27", {});'],
    ['deploy/compose.yml', 'services:\n  URL-27-worker:\n    image: app'],
    ['deploy/compose.yml', 'container_name: URL-27-postgres'],
    ['deploy/compose.yml', 'container_name: url8-pg'],
    ['deploy/runtime.env', 'POSTGRES_DB=url8_acceptance'],
    ['deploy/compose.yml', 'image: url27-backup'],
    ['deploy/app.json', '{"databaseName":"URL-8"}'],
    ['scripts/setup.sh', 'docker run --name url8-pg app'],
    ['scripts/setup.sql', 'CREATE DATABASE "url8_acceptance";'],
    ['deploy/app.service', 'SyslogIdentifier=url27-backup'],
    ['deploy/compose.yml', 'container_name: ryan-url8-postgres-1'],
    ['deploy/compose.yml', 'volume: ryan-url8_pgdata'],
    ['deploy/compose.yml', 'network: ryan-url8_default'],
    ['deploy/compose.yml', 'name: ryan-url8'],
    ['.github/workflows/ci.yml', 'name: URL-27 checks'],
    ['.github/workflows/ci.yml', 'jobs:\n  URL-27-build:\n    runs-on: ubuntu-latest'],
    ['deploy/runtime.yml', 'name: URL27-backup'],
    ['deploy/runtime.yml', 'name: url27-backup-copy'],
    ['migrations/20261104-table.ts', "pgm.createTable('url8_acceptance_table', {});"],
    ['migrations/20261104-index.ts', "pgm.createIndex('links', 'URL-27-index', {});"],
    ['migrations/20261104-index.ts', "pgm.createIndex('links', 'slug', { name: 'URL-27-index' });"],
    ['migrations/20261104-schema.ts', "pgm.createSchema('URL-27-schema');"],
    ['migrations/20261104.sql', 'CREATE UNIQUE INDEX "URL-27-index" ON links(slug);'],
    ['migrations/20261104.sql', 'CREATE TABLE url8_acceptance_table(id INT);'],
  ])('rejects resource declarations: %s %s', (file, body) => {
    expect(checkSource(file, body).length).toBeGreaterThan(0);
  });

  it.each([
    ['infra/resource.ts', 'const r = { name: "url8", bucketName: "ipv6-metrics" };'],
    [
      'infra/resource.ts',
      'const r = { description: "Implemented by URL-27", name: "postgres-backup" };',
    ],
    ['src/domain.ts', 'export class Sha256Digest {}'],
    ['docs/report.md', 'container_name: URL-27\nurl8-pg url8_acceptance'],
    ['tests/history.test.ts', 'const r = { container_name: "url8-pg" };'],
    ['docs/URL-27-history.sql', 'CREATE DATABASE url8_acceptance;'],
    ['migrations/20261104-schema.ts', "// URL-27 tracking\npgm.createTable('ipv6_addresses', {});"],
    [
      'migrations/20261104-index.ts',
      "pgm.createIndex('links', 'slug', { name: 'links_slug_v2' });",
    ],
    ['.github/workflows/ci.yml', 'name: CI\n# tracks URL-27'],
    ['.github/workflows/ci.yml', 'name: CI\nrun: echo "URL-27 tracking only"'],
    ['deploy/compose.yml', '# URL-27 tracking\ncontainer_name: url8'],
    ['scripts/setup.sh', '# docker run --name URL-27 app\nBRANCH=feature/URL-27-postgres-backup'],
    ['deploy/URL-27-config.yml', 'container_name: postgres16'],
    ['deploy/compose.yml', 'image: api-v2'],
    ['deploy/compose.yml', 'container_name: postgres-16'],
    ['scripts/qa.sh', 'docker run --name url27-restore-scratch-20261104 postgres:16-alpine'],
  ])('allows numeric domains and historical/tracking references: %s', (file, body) => {
    expect(checkSource(file, body)).toEqual([]);
  });

  it('exempts only each exact existing declaration once at its exact path', () => {
    const script = 'SCRIPT_NAME="url27-backup"';
    const db = 'BACKUP_DATABASES="${BACKUP_DATABASES:-urlshortener url8_acceptance}"';
    const log = 'SyslogIdentifier=url27-backup';
    expect(checkSource('scripts/postgres-backup.sh', `${script}\n${db}`)).toEqual([]);
    expect(checkSource('deploy/systemd/url-shortener-postgres-backup.service', log)).toEqual([]);
    expect(checkSource('scripts/postgres-backup.sh', `${script}\n${script}`)).toHaveLength(1);
    expect(checkSource('scripts/postgres-backup.sh', `${db}\n${db}`)).toHaveLength(1);
    expect(
      checkSource('deploy/systemd/url-shortener-postgres-backup.service', `${log}\n${log}`),
    ).toHaveLength(1);
    expect(checkSource('scripts/other.sh', script)).toHaveLength(1);
    expect(
      checkSource('scripts/postgres-backup.sh', 'SCRIPT_NAME="url27-backup-copy"'),
    ).toHaveLength(1);
    expect(
      checkSource('scripts/postgres-backup.sh', 'BACKUP_DATABASES="url8_acceptance"'),
    ).toHaveLength(1);
  });

  it('reads real active configs and returns CLI exit 1 for a new violation without runtime access', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'naming-policy-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: tmp });
      mkdirSync(join(tmp, 'deploy'));
      mkdirSync(join(tmp, 'docs'));
      writeFileSync(join(tmp, 'docs', 'URL-27.md'), 'container_name: url8-pg');
      writeFileSync(join(tmp, 'deploy', 'runtime.yml'), 'container_name: url8');
      execFileSync('git', ['add', '.'], { cwd: tmp });
      expect(checkRepository(tmp)).toEqual([]);
      // Includes newly added/modified active files, not only an exported helper.
      writeFileSync(join(tmp, 'deploy', 'runtime.yml'), 'container_name: url8-pg');
      writeFileSync(join(tmp, 'deploy', 'new.env'), 'POSTGRES_DB=URL-27');
      mkdirSync(join(tmp, 'migrations'));
      writeFileSync(
        join(tmp, 'migrations', '20261104.ts'),
        "pgm.createTable('url8_acceptance_table', {});",
      );
      expect(checkRepository(tmp)).toHaveLength(3);
      const run = spawnSync(
        process.execPath,
        ['--experimental-strip-types', join(root, 'scripts/check-naming-policy.ts')],
        {
          cwd: tmp,
          encoding: 'utf8',
          env: {
            ...process.env,
            HTTP_PROXY: 'http://127.0.0.1:9',
            HTTPS_PROXY: 'http://127.0.0.1:9',
          },
        },
      );
      expect(run.status, run.stderr).toBe(1);
      expect(run.stdout).toContain('3 violation(s)');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('accepts the real repository without changing any compatibility identifiers', () => {
    expect(checkRepository(root)).toEqual([]);
  });

  it('tracked root instructions and policy bind all five roles without local profile dependencies', () => {
    const instructions = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    const policy = readFileSync(join(root, 'docs/naming-and-identifier-policy.md'), 'utf8');
    expect(instructions).toContain('docs/naming-and-identifier-policy.md');
    for (const role of ['Michael', 'Jim', 'Dwight', 'Ryan', 'Pam']) {
      expect(instructions).toContain(role);
      expect(policy).toMatch(new RegExp(`\\| ${role}\\s+\\|`));
    }
  });

  it('has one standalone CI naming gate and leaves lint linter-only', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    expect(pkg.scripts.lint).toBe('eslint .');
    expect(workflow.match(/run: npm run check:naming/g)).toHaveLength(1);
  });
});

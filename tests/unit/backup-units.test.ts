/**
 * URL-27 backup artifacts — systemd unit/template validation plus the
 * no-OCI/no-database mock-path proof, wired into `npm test` (and therefore
 * CI) so the backup path is exercised without production contact.
 *
 * Layers:
 *  1. bash syntax (bash -n) over the script, harness and mocks;
 *  2. the full mock-path harness (tests/backup/run-tests.sh) — pg_dump,
 *     pg_dumpall, oci and curl are shadowed by recording mocks and HTTP
 *     proxies are poisoned, so any real database/network call fails the run;
 *  3. systemd unit invariants — daily 02:00 UTC, Persistent=true, oneshot
 *     no-overlap, required alert EnvironmentFile, safe modes, and a real
 *     `systemd-analyze calendar` parse when available;
 *  4. static safety scans — no credential literals, no `oci delete`, no stdin
 *     upload, no automation that enables the disabled-by-default timer.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'postgres-backup.sh');
const HARNESS = join(ROOT, 'tests', 'backup', 'run-tests.sh');
const MOCKS_DIR = join(ROOT, 'tests', 'backup', 'mocks');
const SERVICE = join(ROOT, 'deploy', 'systemd', 'url-shortener-postgres-backup.service');
const TIMER = join(ROOT, 'deploy', 'systemd', 'url-shortener-postgres-backup.timer');
const RUNBOOK = join(ROOT, 'docs', 'postgres-backup-recovery-runbook.md');

const read = (path: string): string => readFileSync(path, 'utf8');

describe('URL-27 · bash syntax', () => {
  const targets = [SCRIPT, HARNESS, ...readdirSync(MOCKS_DIR).map((m) => join(MOCKS_DIR, m))];

  it('covers script, harness and all mocks', () => {
    expect(targets.length).toBeGreaterThanOrEqual(6);
    for (const t of targets) expect(existsSync(t), `${t} must exist`).toBe(true);
  });

  it.each(targets)('bash -n %s', (target) => {
    const r = spawnSync('bash', ['-n', target], { encoding: 'utf8' });
    expect(r.stderr, `bash -n failed for ${target}`).toBe('');
    expect(r.status).toBe(0);
  });

  it('script and mocks are executable in the working tree', () => {
    for (const t of targets) {
      expect(statSync(t).mode & 0o111, `${t} must be executable`).toBeGreaterThan(0);
    }
  });
});

describe('URL-27 · mock-path proof (no OCI / no database calls)', () => {
  it('runs the full harness green under poisoned proxies + shadowed binaries', () => {
    const r = spawnSync('bash', [HARNESS], { encoding: 'utf8', timeout: 120_000 });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/^not ok /m);
    expect(out).toMatch(/^# pass \d+ fail 0$/m);
    // The harness env poisons http(s)_proxy to an unroutable port and shadows
    // pg_dump/pg_dumpall/oci/curl; a green run means every call hit a mock.
    expect(out).toContain('happy path completes');
    expect(out).toContain('no delete call issued');
    expect(out).toContain('uploads use a real file path, never stdin');
  }, 150_000);
});

describe('URL-27 · systemd service unit', () => {
  const unit = read(SERVICE);

  it('is a oneshot with journald logging and an explicit timeout', () => {
    expect(unit).toMatch(/^Type=oneshot$/m);
    expect(unit).toMatch(/^StandardOutput=journal$/m);
    expect(unit).toMatch(/^TimeoutStartSec=1h$/m);
  });

  it('requires the external alert configuration file (no "-" prefix)', () => {
    expect(unit).toMatch(/^EnvironmentFile=\/etc\/url-shortener\/backup\.env$/m);
    expect(unit).not.toMatch(/^EnvironmentFile=-/m);
  });

  it('applies root-safe umask and containment', () => {
    expect(unit).toMatch(/^UMask=0077$/m);
    for (const opt of [
      'NoNewPrivileges=yes',
      'PrivateTmp=yes',
      'ProtectHome=yes',
      'ProtectSystem=full',
    ]) {
      expect(unit, `${opt} must be set`).toContain(opt);
    }
  });

  it('is not directly enableable (timer is the only enablement path)', () => {
    expect(unit).not.toContain('[Install]');
  });

  it('has no credential literals', () => {
    expect(unit).not.toMatch(/arn:aws:/i);
    expect(unit).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    expect(unit).not.toMatch(/(password|secret|token|api[_-]?key)\s*=\s*\S+/i);
  });
});

describe('URL-27 · systemd timer unit', () => {
  const timer = read(TIMER);

  it('fires daily at 02:00 UTC', () => {
    expect(timer).toContain('OnCalendar=*-*-* 02:00:00 UTC');
  });

  it('replays missed runs (Persistent) and targets the service', () => {
    expect(timer).toMatch(/^Persistent=true$/m);
    expect(timer).toMatch(/^Unit=url-shortener-postgres-backup\.service$/m);
  });

  it('ships with the standard timer enablement hook only', () => {
    expect(timer).toMatch(/^\[Install\]$/m);
    expect(timer).toMatch(/^WantedBy=timers\.target$/m);
  });

  it('is documented as disabled by default', () => {
    expect(timer).toContain('DISABLED by default');
    expect(timer).toContain('systemctl enable');
  });

  it('parses with systemd-analyze (when available)', () => {
    const analyzer = spawnSync('systemd-analyze', ['--version'], { encoding: 'utf8' });
    if (analyzer.error || analyzer.status !== 0) return; // not on this host/CI
    const cal = spawnSync('systemd-analyze', ['calendar', '*-*-* 02:00:00 UTC'], {
      encoding: 'utf8',
    });
    expect(cal.status, cal.stderr).toBe(0);
    expect(cal.stdout).toContain('02:00:00');
    expect(cal.stdout).not.toMatch(/Error/);
  });
});

describe('URL-27 · static safety contracts', () => {
  const scanDirs = ['scripts', 'deploy', 'tests/backup'];
  const scanFiles: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else scanFiles.push(path);
    }
  };
  for (const dir of scanDirs) walk(join(ROOT, dir));

  it('scans a non-trivial artifact set', () => {
    expect(scanFiles.length).toBeGreaterThanOrEqual(7);
  });

  it('carries no credential literals', () => {
    const forbidden = [
      /arn:aws:/i,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      // literal values only — ${VAR} expansions and paths are not secrets
      /(password|secret|token|api[_-]?key)\s*[:=]\s*["'](?![$/{])[^"']{6,}["']/i,
      /key_file\s*=/,
      /postgres(?:ql)?:\/\/[^\s'"`]*@(?!(?:localhost|127\.0\.0\.1|\[::1\]))/i,
    ];
    for (const file of scanFiles) {
      const body = read(file);
      for (const re of forbidden) {
        expect(re.test(body), `${file} must not match ${re}`).toBe(false);
      }
    }
  });

  it('the script never issues an OCI delete (no delete grant)', () => {
    const body = read(SCRIPT);
    expect(body).not.toContain('os object delete');
    expect(body).toContain('--no-multipart');
  });

  it('no CI workflow or package script enables or runs the backup timer', () => {
    const ciFiles = join(ROOT, '.github', 'workflows');
    for (const f of readdirSync(ciFiles)) {
      const body = read(join(ciFiles, f));
      expect(body, `${f} must not touch backup enablement`).not.toMatch(
        /systemctl\s+(enable|--now)|postgres-backup/,
      );
    }
    const pkg = JSON.parse(read(join(ROOT, 'package.json'))) as {
      scripts: Record<string, string>;
    };
    for (const [, cmd] of Object.entries(pkg.scripts)) {
      expect(cmd).not.toMatch(/systemctl\s+enable|postgres-backup\.sh/);
    }
  });
});

describe('URL-27 · recovery runbook', () => {
  const doc = read(RUNBOOK);

  const requiredSections = [
    'Monthly disposable restore',
    'url8-pg',
    'globals',
    'SUPERUSER',
    '02:00',
    'disabled',
    'alert',
    'Retention',
    'RTO',
  ];
  it.each(requiredSections)('covers %s', (needle) => {
    expect(doc).toContain(needle);
  });

  it('forbids restoring into the live database or container', () => {
    expect(doc).toMatch(/never (target|restore into|touch)/i);
    expect(doc).toContain('url8-pg');
    expect(doc).toMatch(/--network none|no published ports/i);
  });

  it('records the remaining external configuration blockers', () => {
    expect(doc).toMatch(/alert endpoint|secret-store|secret store/i);
    expect(doc).toMatch(/delete|retention/i);
    expect(doc).toMatch(/encryption/i);
  });
});

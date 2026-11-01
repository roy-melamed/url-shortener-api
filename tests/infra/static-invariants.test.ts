/**
 * URL-19 static invariants — the ticket's "static literal / no-CDN checks".
 *
 * Two halves:
 *  1. **Source scan** — the committed application/infra source must not carry
 *     CDN/edge imports, remote DB endpoints, AWS account ids or `arn:aws:`
 *     credential literals (AD-1/AD-2/AD-7: no CloudFront; URL-19 acceptance:
 *     "No DB endpoint or secret literal committed").
 *  2. **Template scan** — the synthesized stack must not contain CloudFront/
 *     WAF/edge resources, must create no database, and must carry exactly one
 *     custom domain and no hosted zone (NFR-9: single shared domain only).
 *
 * Local-dev placeholders (`localhost` in `.env.example`, docker-compose) are
 * explicitly allowed: design §1.2/§6.2 say local dev runs against docker-compose
 * through a gitignored `.env`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applicationLambdas, synthesizedStack } from './synthesized-stack.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCAN_DIRS = ['src', 'infra', 'scripts'];
const SCAN_FILES = ['package.json', 'cdk.json'];
/** Pinned dependency graph and generated output — not authored source. */
const EXCLUDED_DIRS = new Set(['node_modules', 'dist', 'coverage', 'cdk.out', '.git']);

/** Forbidden resource/SDK tokens — deliberately not the bare word "CloudFront",
 *  which appears in design citations and "no CDN" comments. */
const FORBIDDEN_CDN_TOKENS = [
  'aws-cdk-lib/aws-cloudfront',
  'aws-cdk-lib/aws-cloudfront-origins',
  'aws-cdk-lib/aws-wafv2',
  '@aws-sdk/client-cloudfront',
  '@aws-sdk/client-wafv2',
  'AWS::CloudFront::',
  'AWS::WafV2::',
  'cloudfront.amazonaws.com',
];

function authoredSourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (EXCLUDED_DIRS.has(entry)) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (entry.endsWith('.ts') || entry.endsWith('.json') || entry.endsWith('.mjs')) {
        files.push(path);
      }
    }
  };
  for (const dir of SCAN_DIRS) walk(join(ROOT, dir));
  for (const file of SCAN_FILES) files.push(join(ROOT, file));
  // The invariant test itself quotes the tokens it forbids.
  return files.filter((file) => !file.endsWith('static-invariants.test.ts'));
}

describe('URL-19 · authored source carries no CDN/edge, remote endpoint or credential literal', () => {
  const files = authoredSourceFiles();

  it('scans a non-trivial source set', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((file) => file.endsWith('url-shortener-stack.ts'))).toBe(true);
    expect(files.some((file) => file.endsWith('cdk.json'))).toBe(true);
  });

  it.each(FORBIDDEN_CDN_TOKENS)('contains no %s reference', (token) => {
    const offenders = files.filter((file) => readFileSync(file, 'utf8').includes(token));
    expect(offenders, `${token} must not appear in ${offenders.join(', ')}`).toEqual([]);
  });

  it('contains no remote database URL (only localhost/docker-compose dev values are allowed)', () => {
    const remoteUrl =
      /postgres(?:ql)?:\/\/[^\s'"`]*@(?!(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?[/'"`])/i;
    const offenders = files.filter((file) => remoteUrl.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('contains no AWS account id and no arn:aws: credential literal', () => {
    const accountId = /\b\d{12}\b/;
    const arnLiteral = /arn:aws[a-z-]*:/;
    const offenders = files.filter((file) => {
      const source = readFileSync(file, 'utf8');
      return accountId.test(source) || arnLiteral.test(source);
    });
    expect(offenders).toEqual([]);
  });

  it('keeps the local dev contract on localhost placeholders only', () => {
    const envExample = readFileSync(join(ROOT, '.env.example'), 'utf8');
    const databaseUrl = envExample.split('\n').find((line) => line.startsWith('DATABASE_URL='));
    expect(databaseUrl, '.env.example must document DATABASE_URL').toBeDefined();
    expect(databaseUrl).toMatch(/postgres(?:ql)?:\/\/[^\s]*@(localhost|127\.0\.0\.1)/i);
  });
});

describe('URL-19 · synthesized template invariants (AD-1/AD-2/AD-7, NFR-9, FR-9.2)', () => {
  const { serialized, json } = synthesizedStack();

  it('contains no CloudFront/CDN or WAF edge resource', () => {
    expect(serialized).not.toContain('AWS::CloudFront::');
    expect(serialized).not.toContain('AWS::WafV2::');
    expect(serialized).not.toContain('cloudfront.amazonaws.com');
    expect(applicationLambdas(json).some(([logicalId]) => logicalId.includes('Distribution'))).toBe(
      false,
    );
  });

  it('creates no database — only the RDS Proxy in front of the existing instance (FR-9.2)', () => {
    expect(serialized).not.toContain('AWS::RDS::DBInstance');
    expect(serialized).not.toContain('AWS::RDS::DBCluster');
    expect(serialized).not.toContain('AWS::SecretsManager::Secret');
    const rdsResources = Object.values(json.Resources).filter((resource) =>
      resource.Type.startsWith('AWS::RDS::'),
    );
    expect(rdsResources.map((resource) => resource.Type).sort()).toEqual([
      'AWS::RDS::DBProxy',
      'AWS::RDS::DBProxyTargetGroup',
    ]);
  });

  it('carries exactly one custom domain and no per-user domain configuration (NFR-9)', () => {
    const domains = Object.values(json.Resources).filter(
      (resource) => resource.Type === 'AWS::ApiGatewayV2::DomainName',
    );
    expect(domains).toHaveLength(1);
    // The owner supplies the shared domain; there is no domain-per-user shape
    // (no `customDomain`, no domain mapping key, no `Domains` collection).
    expect(serialized).not.toContain('customDomain');
    expect(serialized).not.toContain('ApiMappingKey');
  });

  it('resolves every secret through a reference, never a literal', () => {
    expect(serialized).not.toMatch(/"(password|secret|apiKey)"\s*:\s*"[^"$]+"/i);
    expect(serialized).toContain('{{resolve:secretsmanager:');
  });
});

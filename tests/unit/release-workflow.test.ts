import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const release = readFileSync('.github/workflows/release.yml', 'utf8');
const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
describe('release workflow safety contract (not live enforcement proof)', () => {
  it('preserves quality gates and adds offline synth after build', () => {
    for (const file of [ci, release]) {
      const ordered = [
        'npm run lint',
        'npm run typecheck',
        'npm test',
        'npm run build',
        'npm run cdk:synth',
      ];
      expect(ordered.map((text) => file.indexOf(text))).toEqual(
        [...ordered.map((text) => file.indexOf(text))].sort((a, b) => a - b),
      );
      for (const text of [
        ...ordered,
        'npm run check:naming',
        'npm run check:watcher-offline',
        'npm run test:watcher-offline',
      ])
        expect(file).toContain(text);
    }
  });
  it('deploys only via explicit dispatch and separately gated staging and production', () => {
    for (const action of release.matchAll(/uses: [^@\s]+@([^\s]+)/g))
      expect(action[1]).toMatch(/^[a-f0-9]{40}$/);
    expect(release).toContain('workflow_dispatch:');
    expect(release).not.toMatch(
      /pull_request_target|workflow_run:|push:|continue-on-error|if: always|secrets: inherit|cancel-in-progress: true/,
    );
    expect(release).toContain('environment: ${{ needs.candidate.outputs.staging_environment }}');
    expect(release).toContain('environment: ${{ needs.candidate.outputs.production_environment }}');
    expect(release).toContain('needs: [candidate, staging]');
    const staging = release.slice(release.indexOf('\n  staging:'));
    expect(staging.indexOf('authorize staging')).toBeLessThan(
      staging.indexOf('aws-actions/configure-aws-credentials'),
    );
    const production = release.slice(release.indexOf('\n  production:'));
    expect(production.indexOf('authorize production')).toBeLessThan(
      production.indexOf('aws-actions/configure-aws-credentials'),
    );
    const candidate = release.slice(
      release.indexOf('\n  candidate:'),
      release.indexOf('\n  staging:'),
    );
    expect(candidate).not.toContain('id-token: write');
    expect(candidate).not.toContain('secrets.');
    expect(release).not.toContain('cdk bootstrap');
    expect(release).not.toContain('migrate:down');
  });
  it('downloads the same immutable artifact ID for both targets and never rebuilds it in deploy jobs', () => {
    expect(
      release.match(/ARTIFACT_ID: \$\{\{ needs.candidate.outputs.artifact_id \}\}/g),
    ).toHaveLength(2);
    for (const stage of ['staging', 'production']) {
      const job = release.slice(release.indexOf(`\n  ${stage}:`));
      expect(job).not.toMatch(/npm run build|npm run cdk:synth/);
      expect(job).toContain(
        `EXPECTED_TARGET_DIGEST: \${{ needs.candidate.outputs.${stage}_digest }}`,
      );
    }
  });
});

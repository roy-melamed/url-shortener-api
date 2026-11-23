import { appendFileSync, readFileSync, writeFileSync, mkdirSync, lstatSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  assertPreviousArtifact,
  assertProtectedEnvironment,
  assertReleaseContext,
  parseTarget,
  targetDigest,
  targets,
  type Target,
} from './release-policy.ts';

export interface PayloadManifest {
  sourceSha: string;
  sourceRun: string;
  payloadSha256: string;
}
export function payloadManifest(
  bytes: Buffer,
  sourceSha: string,
  sourceRun: string,
): PayloadManifest {
  if (!/^[a-f0-9]{40}$/.test(sourceSha) || !/^\d+$/.test(sourceRun))
    throw new Error('Invalid artifact provenance.');
  return { sourceSha, sourceRun, payloadSha256: createHash('sha256').update(bytes).digest('hex') };
}
export function verifiedManifest(): PayloadManifest {
  for (const file of ['release-candidate/manifest.json', 'release-candidate/payload.tgz']) {
    if (!lstatSync(file).isFile())
      throw new Error('Release payload entries must be regular files.');
  }
  const recorded = JSON.parse(
    readFileSync('release-candidate/manifest.json', 'utf8'),
  ) as PayloadManifest;
  const expected = payloadManifest(
    readFileSync('release-candidate/payload.tgz'),
    recorded.sourceSha,
    recorded.sourceRun,
  );
  if (expected.payloadSha256 !== recorded.payloadSha256)
    throw new Error('Immutable payload digest mismatch.');
  return recorded;
}
export function assertArchiveDigest(bytes: Buffer, expected: string): void {
  if (
    bytes.length > 128 * 1024 * 1024 ||
    `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== expected
  )
    throw new Error('Selected archive digest mismatch.');
}
export function assertArchiveEntries(entries: string[]): void {
  if (JSON.stringify([...entries].sort()) !== JSON.stringify(['manifest.json', 'payload.tgz']))
    throw new Error('Unexpected release artifact entries.');
}
export async function githubApi(path: string): Promise<unknown> {
  if (!process.env.GH_TOKEN) throw new Error('GitHub read permission is unavailable.');
  const result = await fetch(
    `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/${path}`,
    {
      headers: {
        authorization: `Bearer ${process.env.GH_TOKEN}`,
        accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!result.ok) throw new Error('GitHub release-policy evidence is unavailable.');
  return result.json();
}
function output(name: string, value: string): void {
  if (!process.env.GITHUB_OUTPUT || /[\r\n]/.test(value))
    throw new Error('Invalid workflow output.');
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}
export async function releaseControl(args: string[], api = githubApi): Promise<void> {
  const [command, target] = args;
  if (command === 'download') {
    assertReleaseContext(process.env);
    if (
      !/^\d+$/.test(process.env.ARTIFACT_ID ?? '') ||
      !/^sha256:[a-f0-9]{64}$/.test(process.env.ARTIFACT_DIGEST ?? '') ||
      !process.env.GH_TOKEN
    )
      throw new Error('Selected artifact binding is unavailable.');
    const response = await fetch(
      `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/${process.env.ARTIFACT_ID}/zip`,
      {
        headers: {
          authorization: `Bearer ${process.env.GH_TOKEN}`,
          accept: 'application/vnd.github+json',
        },
        signal: AbortSignal.timeout(60000),
      },
    );
    if (!response.ok) throw new Error('Selected artifact download unavailable.');
    const bytes = Buffer.from(await response.arrayBuffer());
    assertArchiveDigest(bytes, process.env.ARTIFACT_DIGEST!);
    mkdirSync('release-candidate', { recursive: true });
    writeFileSync('release-candidate/download.zip', bytes);
    const execute = promisify(execFile);
    const entries = (await execute('unzip', ['-Z1', 'release-candidate/download.zip'])).stdout
      .trim()
      .split('\n')
      .sort();
    assertArchiveEntries(entries);
    await execute('unzip', ['-q', 'release-candidate/download.zip', '-d', 'release-candidate']);
    return;
  }
  if (command === 'manifest') {
    assertReleaseContext({ ...process.env, EXPECTED_SHA: process.env.GITHUB_SHA });
    writeFileSync(
      'release-candidate/manifest.json',
      JSON.stringify(
        payloadManifest(
          readFileSync('release-candidate/payload.tgz'),
          process.env.GITHUB_SHA!,
          process.env.GITHUB_RUN_ID!,
        ),
      ),
    );
    return;
  }
  if (command === 'preflight') {
    assertReleaseContext(process.env);
    // Failed target jobs can retry the same immutable candidate. Re-running
    // candidate generation must not bind old run-level approvals to new inputs.
    if (process.env.GITHUB_RUN_ATTEMPT !== '1')
      throw new Error(
        'Candidate regeneration requires a new explicit dispatch, not replayed approvals.',
      );
    const configs = targets.map((t) =>
      parseTarget(process.env[`RELEASE_${t.toUpperCase()}_TARGET`]),
    );
    if (
      configs[0]!.origin === configs[1]!.origin ||
      (configs[0]!.account === configs[1]!.account &&
        configs[0]!.region === configs[1]!.region &&
        configs[0]!.stack === configs[1]!.stack)
    )
      throw new Error('Staging and production must be distinct deployment targets.');
    for (const [index, t] of targets.entries()) {
      assertProtectedEnvironment(await api(`environments/${t}`));
      output(`${t}_digest`, targetDigest(configs[index]!));
      output(`${t}_runner`, configs[index]!.runnerLabel);
      output(`${t}_environment`, t);
      if (process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(
          process.env.GITHUB_STEP_SUMMARY,
          `Target ${t} digest: ${targetDigest(configs[index]!)}\n`,
        );
    }
    const branch = (await api('branches/main')) as { protected?: boolean };
    if (!branch.protected) throw new Error('Main branch protection is required.');
    return;
  }
  if (command === 'select') {
    const rollback = process.env.OPERATION === 'rollback';
    if (!rollback && process.env.OPERATION !== 'release')
      throw new Error('Unknown release operation.');
    const artifactId = rollback ? process.env.PREVIOUS_ARTIFACT_ID : process.env.NEW_ARTIFACT_ID;
    if (!/^\d+$/.test(artifactId ?? '')) throw new Error('Immutable artifact ID is required.');
    const artifact = (await api(`actions/artifacts/${artifactId}`)) as {
      workflow_run: { id: number; head_sha: string };
      expired: boolean;
      name: string;
      digest: string;
    };
    if (!/^sha256:[a-f0-9]{64}$/.test(artifact.digest))
      throw new Error('Immutable artifact archive digest is unavailable.');
    if (rollback)
      assertPreviousArtifact(
        artifact,
        await api(`actions/runs/${artifact.workflow_run.id}`),
        process.env.GITHUB_REPOSITORY!,
      );
    else if (
      artifact.workflow_run.id !== Number(process.env.GITHUB_RUN_ID) ||
      artifact.workflow_run.head_sha !== process.env.GITHUB_SHA ||
      artifact.expired ||
      artifact.name !== 'release-candidate'
    )
      throw new Error('Current candidate artifact provenance mismatch.');
    output('artifact_id', artifactId!);
    output('source_run', String(artifact.workflow_run.id));
    output('source_sha', artifact.workflow_run.head_sha);
    output('archive_digest', artifact.digest);
    if (!process.env.GITHUB_STEP_SUMMARY)
      throw new Error('Approval binding summary is unavailable.');
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Human deployment approval binding\nOperation: ${process.env.OPERATION}\nArtifact ID: ${artifactId}\nArchive digest: ${artifact.digest}\nArtifact source SHA: ${artifact.workflow_run.head_sha}\nWorkflow SHA: ${process.env.GITHUB_SHA}\nBoth environment approvals apply to this unchanged artifact and the target digests from candidate policy outputs. Production remains blocked until staging succeeds.\n`,
    );
    return;
  }
  if (command === 'authorize' && targets.includes(target as Target)) {
    assertReleaseContext(process.env);
    const config = parseTarget(process.env.RELEASE_TARGET);
    const digest = targetDigest(config);
    if (digest !== process.env.EXPECTED_TARGET_DIGEST)
      throw new Error('Target changed since the approval binding was prepared.');
    const environment = (await api(`environments/${target}`)) as {
      id: number;
      protection_rules: {
        type: string;
        reviewers?: { reviewer: { id: number; type: string } }[];
      }[];
    };
    assertProtectedEnvironment(environment);
    const reviewers =
      environment.protection_rules
        .find((rule) => rule.type === 'required_reviewers')
        ?.reviewers?.filter((r) => r.reviewer.type === 'User')
        .map((r) => r.reviewer.id) ?? [];
    const reviews = (await api(`actions/runs/${process.env.GITHUB_RUN_ID}/approvals`)) as {
      state: string;
      user: { id: number; type: string };
      environments: { id: number }[];
    }[];
    if (
      !reviews.some(
        (review) =>
          review.state === 'approved' &&
          review.user.type === 'User' &&
          reviewers.includes(review.user.id) &&
          review.environments.some((e) => e.id === environment.id),
      )
    )
      throw new Error('No authorized human approval evidence for this run and environment.');
    const manifest = verifiedManifest();
    if (
      manifest.sourceSha !== process.env.ARTIFACT_SOURCE_SHA ||
      manifest.sourceRun !== process.env.ARTIFACT_SOURCE_RUN
    )
      throw new Error('Payload source differs from selected artifact provenance.');
    writeFileSync(
      '.release-authorization.json',
      JSON.stringify({
        target,
        digest,
        run: process.env.GITHUB_RUN_ID,
        workflowSha: process.env.GITHUB_SHA,
        payloadSha256: manifest.payloadSha256,
      }),
    );
    output('role_arn', config.roleArn);
    output('region', config.region);
    output('account', config.account);
    return;
  }
  throw new Error('Unknown release control operation.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  releaseControl(process.argv.slice(2)).catch(() => {
    console.error(
      'Release policy blocked: missing or invalid configuration, immutable artifact, permissions or human approval evidence.',
    );
    process.exitCode = 1;
  });
}

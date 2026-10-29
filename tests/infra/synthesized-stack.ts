/**
 * Shared synthesized template for the URL-19 infra suites (URL-19 acceptance).
 *
 * Synthesizing here — not via the CDK CLI — keeps the assertions inside
 * `npm test`, so the coverage gate CI already runs also proves the IaC
 * invariants. Synthesis is offline by design (no lookups, no credentials, no
 * product values): the owner inputs are CloudFormation parameters without
 * defaults (`infra/lib/prerequisites.ts`).
 */
import { readFileSync } from 'node:fs';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { MAINTENANCE_JOBS } from '../../src/functions/maintenance.ts';
import { UrlShortenerStack } from '../../infra/lib/url-shortener-stack.ts';

export { MAINTENANCE_JOBS };

/** Minimal structural view of a synthesized resource. */
export interface SynthResource {
  readonly Type: string;
  readonly Properties?: Record<string, unknown>;
}

export interface SynthesizedStack {
  readonly template: Template;
  /** The template as a plain object (for structural scans). */
  readonly json: {
    readonly Resources: Record<string, SynthResource>;
    readonly Parameters?: Record<string, Record<string, unknown>>;
  };
  /** The template serialized — used by the no-CDN/no-literal invariant scan. */
  readonly serialized: string;
}

let cached: SynthesizedStack | undefined;

/**
 * The CDK CLI injects `cdk.json`'s `context` (feature flags) into the app; a
 * bare `new App()` does not. Loading them here keeps the in-test synthesis
 * byte-comparable with what `npm run cdk:synth` produces.
 */
function cdkContext(): Record<string, unknown> {
  const cdkJson = JSON.parse(readFileSync(new URL('../../cdk.json', import.meta.url), 'utf8')) as {
    context?: Record<string, unknown>;
  };
  return cdkJson.context ?? {};
}

export function synthesizedStack(): SynthesizedStack {
  if (cached === undefined) {
    const template = Template.fromStack(
      new UrlShortenerStack(new App({ context: cdkContext() }), 'UrlShortenerApiTest'),
    );
    cached = {
      template,
      json: template.toJSON() as SynthesizedStack['json'],
      serialized: JSON.stringify(template.toJSON()),
    };
  }
  return cached;
}

/** Lambda resources synthesized for this stack's application code. */
export function applicationLambdas(json: SynthesizedStack['json']): Array<[string, SynthResource]> {
  return Object.entries(json.Resources).filter(
    ([, resource]) => resource.Type === 'AWS::Lambda::Function',
  );
}

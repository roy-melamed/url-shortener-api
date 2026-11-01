/**
 * CDK app entrypoint — URL-19 (CDK infrastructure / IaC).
 *
 * One stack, environment-agnostic on purpose: the AWS account and region are
 * read from the deploy environment (an owner-provided prerequisite, never
 * invented), and `cdk synth` needs no credentials, no lookups and no product
 * values — every owner input is a CloudFormation parameter without a default
 * (see `infra/lib/prerequisites.ts`).
 *
 * Run: `npm run cdk:synth` (synthesis only — this repo ships no deploy path;
 * staging deploy stays blocked until the owner supplies the prerequisites).
 */
import { App } from 'aws-cdk-lib';
import { UrlShortenerStack } from '../lib/url-shortener-stack.ts';

const app = new App();

new UrlShortenerStack(app, 'UrlShortenerApi', {
  description:
    'URL Shortener API (URL-19): HTTP API + 4 Lambdas in a private VPC, SQS/DLQ, RDS Proxy ' +
    'to the existing RDS, one shared custom domain (NFR-9), EventBridge Scheduler for ' +
    'design 3.7. No CloudFront/CDN (AD-1/AD-2/AD-7); no database created (FR-9.2).',
});

app.synth();

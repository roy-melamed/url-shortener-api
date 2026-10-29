/**
 * Ambient types for the `aws-lambda-fastify` package (URL-7).
 *
 * `aws-lambda-fastify@2.x` is a deprecated shim that re-exports
 * `aws-lambda-fastify-deprecated`; the shim itself ships no `.d.ts`, so without
 * this declaration TypeScript raises TS7016. These types mirror the runtime
 * adapter: `(app, options?) => (event, context) => Promise<LambdaResponse>`.
 * Entrypoint/platform layer only (design §3.9).
 */
declare module 'aws-lambda-fastify' {
  import type { Context } from 'aws-lambda';
  import type { FastifyInstance } from 'fastify';

  export interface LambdaFastifyOptions {
    binaryMimeTypes?: string[];
    callbackWaitsForEmptyEventLoop?: boolean;
    serializeLambdaArguments?: boolean;
    decorateRequest?: boolean;
    decorationPropertyName?: string;
  }

  export interface LambdaResponse {
    statusCode: number;
    body: string;
    headers: Record<string, string>;
    isBase64Encoded: boolean;
    cookies?: string[];
  }

  export type PromiseHandler<TEvent = unknown, TResult = LambdaResponse> = (
    event: TEvent,
    context: Context,
  ) => Promise<TResult>;

  export default function awsLambdaFastify<TEvent = unknown, TResult = LambdaResponse>(
    app: FastifyInstance,
    options?: LambdaFastifyOptions,
  ): PromiseHandler<TEvent, TResult>;
}

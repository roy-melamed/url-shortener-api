import type { FastifyInstance } from 'fastify';
import type { BearerAuthentication } from '../auth/bearer-auth.ts';
import type { InProcessRequestLimiter } from '../platform/request-limiter.ts';
import { enforceRequestLimit } from '../platform/request-limit-hook.ts';
import type { LinkCreation } from './create.ts';
import { AppError } from '../platform/errors.ts';

export function registerLinkCreation(
  app: FastifyInstance,
  links: LinkCreation,
  auth: BearerAuthentication,
  limiter: InProcessRequestLimiter,
): void {
  app.addHook('onSend', async (request, reply) => {
    if (request.routeOptions.url === '/v1/links') reply.header('Cache-Control', 'no-store');
  });
  app.post(
    '/v1/links',
    {
      bodyLimit: 16_384,
      preHandler: [
        async (request) => {
          if (
            request.raw.rawHeaders.filter(
              (value, index) => index % 2 === 0 && value.toLowerCase() === 'idempotency-key',
            ).length > 1
          )
            throw new AppError(400, 'VALIDATION_ERROR', 'Invalid idempotency key.');
          links.validate(request.body, request.headers['idempotency-key']);
        },
        auth.authenticate,
        async (request, reply) => {
          enforceRequestLimit(request, reply, {
            limiter,
            principal: (request) => auth.principal(request).subject,
          });
        },
        async (request) => {
          await links.requireVerified(auth.principal(request).userId);
        },
      ],
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(
          await links.create(
            auth.principal(request),
            request.body,
            request.headers['idempotency-key'],
          ),
        ),
  );
}

import type { FastifyInstance } from 'fastify';
import { ApiKeys } from './api-keys.ts';
import { BearerAuthentication } from './bearer-auth.ts';

/** JWT-only owner management, separate from general API-key/JWT protected use. */
export function registerApiKeyRoutes(
  app: FastifyInstance,
  authentication: BearerAuthentication,
  keys: ApiKeys,
): void {
  app.addHook('onSend', async (request, reply) => {
    if (request.routeOptions.url?.startsWith('/v1/auth/api-keys')) {
      reply.header('Cache-Control', 'no-store');
      reply.header('Pragma', 'no-cache');
    }
  });
  app.post(
    '/v1/auth/api-keys',
    { preHandler: authentication.requireJwt },
    async (request, reply) => {
      const owner = authentication.principal(request);
      return reply
        .code(201)
        .send(await keys.create(owner.userId, request.body, authentication.now()));
    },
  );
  app.get('/v1/auth/api-keys', { preHandler: authentication.requireJwt }, async (request) => ({
    keys: await keys.list(authentication.principal(request).userId),
  }));
  app.delete<{ Params: { id: string } }>(
    '/v1/auth/api-keys/:id',
    { preHandler: authentication.requireJwt },
    async (request, reply) => {
      await keys.revoke(
        authentication.principal(request).userId,
        request.params.id,
        authentication.now(),
      );
      return reply.code(204).send();
    },
  );
}

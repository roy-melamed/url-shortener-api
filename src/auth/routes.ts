import type { FastifyInstance } from 'fastify';
import type { PasswordAccounts } from './accounts.ts';
import { AppError } from '../platform/errors.ts';

/** Optional dependency injection is explicit: never invent signing/mail secrets. */
export function registerPasswordAccountRoutes(
  app: FastifyInstance,
  accounts: PasswordAccounts,
): void {
  const credentials = {
    type: 'object',
    additionalProperties: false,
    required: ['email', 'password'],
    properties: {
      email: { type: 'string', maxLength: 254 },
      password: { type: 'string', minLength: 1, maxLength: 128 },
    },
  };
  const tokenBody = {
    type: 'object',
    additionalProperties: false,
    required: ['token'],
    properties: { token: { type: 'string', maxLength: 128 } },
  };
  app.addHook('onSend', async (request, reply) => {
    const route = request.routeOptions.url;
    if (route === '/v1/users' || route?.startsWith('/v1/auth/') || route === '/v1/me') {
      reply.header('Cache-Control', 'no-store');
      reply.header('Pragma', 'no-cache');
    }
  });
  app.post('/v1/users', { schema: { body: credentials } }, async (request, reply) => {
    return reply.code(201).send(await accounts.register(request.body));
  });
  app.post('/v1/auth/sessions', { schema: { body: credentials } }, (request) =>
    accounts.login(request.body),
  );
  app.post('/v1/auth/tokens/refresh', { schema: { body: tokenBody } }, (request) =>
    accounts.refresh((request.body as { token: string }).token),
  );
  app.post('/v1/auth/emails/verify', { schema: { body: tokenBody } }, async (request, reply) => {
    await accounts.verifyEmail((request.body as { token: string }).token);
    return reply.code(204).send();
  });
  app.delete('/v1/me', async (request, reply) => {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ') || header.length > 8200)
      throw new AppError(401, 'UNAUTHENTICATED', 'Invalid session.');
    await accounts.deleteMe(header.slice(7));
    return reply.code(204).send();
  });
}

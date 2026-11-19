import type { FastifyRequest } from 'fastify';
import type { AccessTokens } from './contracts.ts';
import { ApiKeys, isCanonicalUuid } from './api-keys.ts';
import { AppError } from '../platform/errors.ts';

export type AuthenticatedPrincipal =
  | Readonly<{ kind: 'user'; userId: string; subject: `user:${string}` }>
  | Readonly<{ kind: 'apikey'; userId: string; keyId: string; subject: `apikey:${string}` }>;

export interface BearerAuthOptions {
  apiKeys: ApiKeys;
  /** Reuse URL-9's strict verifier and injected owner keys; never reissue tokens. */
  accessTokens: Pick<AccessTokens, 'verify'>;
  now?: () => Date;
}

const invalid = () => new AppError(401, 'UNAUTHENTICATED', 'Invalid credentials.');

/** Trusted request context cannot be selected/decorated through client headers. */
export class BearerAuthentication {
  private readonly principals = new WeakMap<FastifyRequest, AuthenticatedPrincipal>();
  private readonly options: BearerAuthOptions;
  constructor(options: BearerAuthOptions) {
    this.options = options;
  }

  now(): Date {
    let now: Date;
    try {
      now = this.options.now?.() ?? new Date();
    } catch {
      throw new AppError(503, 'INTERNAL', 'Authentication unavailable.');
    }
    if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
      throw new AppError(503, 'INTERNAL', 'Authentication unavailable.');
    return now;
  }

  readonly authenticate = async (request: FastifyRequest): Promise<void> => {
    await this.resolve(request, false);
  };

  readonly requireJwt = async (request: FastifyRequest): Promise<void> => {
    await this.resolve(request, true);
  };

  principal(request: FastifyRequest): AuthenticatedPrincipal {
    const principal = this.principals.get(request);
    if (!principal) throw invalid();
    return principal;
  }

  private async resolve(request: FastifyRequest, jwtOnly: boolean): Promise<void> {
    this.principals.delete(request);
    const header = request.headers.authorization;
    if (typeof header !== 'string' || header.length > 8199) throw invalid();
    // Duplicate Authorization fields must not be silently reduced to the first.
    const names = request.raw.rawHeaders.filter((_, index) => index % 2 === 0);
    if (names.filter((name) => name.toLowerCase() === 'authorization').length !== 1)
      throw invalid();
    const match = /^Bearer ([^\s,]+)$/i.exec(header);
    if (!match) throw invalid();
    const token = match[1]!;
    const now = this.now();
    let principal: AuthenticatedPrincipal;
    if (token.startsWith('usk_')) {
      if (jwtOnly) throw invalid();
      const key = await this.options.apiKeys.verify(token, now);
      principal = {
        kind: 'apikey',
        userId: key.userId,
        keyId: key.id,
        subject: `apikey:${key.id}`,
      };
    } else {
      let userId: string;
      try {
        userId = await this.options.accessTokens.verify(token, now);
      } catch {
        throw invalid();
      }
      if (!isCanonicalUuid(userId) || !(await this.options.apiKeys.store.accountExists(userId)))
        throw invalid();
      principal = { kind: 'user', userId, subject: `user:${userId}` };
    }
    this.principals.set(request, Object.freeze(principal));
  }
}

/**
 * Fastify adapter for the reusable principal limiter.
 *
 * Authentication remains outside this unit. A route opts in by resolving its
 * authenticated principal and calling `enforceRequestLimit` before its handler
 * work. Anonymous and redirect traffic are intentionally not limited here.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from './errors.ts';
import {
  InProcessRequestLimiter,
  isRateLimitPrincipal,
  type RateLimitDecision,
  type RateLimitPrincipal,
} from './request-limiter.ts';

export interface RequestLimitContext {
  limiter: InProcessRequestLimiter;
  principal: (request: FastifyRequest) => RateLimitPrincipal | null;
}

function applyRateLimitHeaders(reply: FastifyReply, decision: RateLimitDecision): void {
  reply.header('RateLimit-Limit', String(decision.limit));
  reply.header('RateLimit-Remaining', String(decision.remaining));
  reply.header('RateLimit-Reset', String(decision.resetAfterSeconds));
  reply.header('Cache-Control', 'no-store');
  if (!decision.allowed) reply.header('Retry-After', String(decision.retryAfterSeconds));
}

export function enforceRequestLimit(
  request: FastifyRequest,
  reply: FastifyReply,
  context: RequestLimitContext,
): void {
  const principal = context.principal(request);
  if (principal === null) return;
  reply.header('Cache-Control', 'no-store');
  if (!isRateLimitPrincipal(principal)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid rate-limit principal.');
  }
  const decision = context.limiter.consume(principal);
  applyRateLimitHeaders(reply, decision);
  if (!decision.allowed) {
    throw new AppError(
      429,
      'RATE_LIMITED',
      `Too many requests. Retry after ${decision.retryAfterSeconds} seconds.`,
    );
  }
}

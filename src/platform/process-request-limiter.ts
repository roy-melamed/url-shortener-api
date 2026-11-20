import { InProcessRequestLimiter } from './request-limiter.ts';

/** URL-shortener process-owned quota state, shared across application routes. */
export const processRequestLimiter = new InProcessRequestLimiter();

import { createHash, randomInt } from 'node:crypto';
import { z } from 'zod';
import type { AuthenticatedPrincipal } from '../auth/bearer-auth.ts';
import { isRateLimitPrincipal } from '../platform/request-limiter.ts';
import { isCanonicalUuid } from '../auth/api-keys.ts';
import { AppError } from '../platform/errors.ts';

const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
export function generateSlug(): string {
  return Array.from({ length: 7 }, () => alphabet[randomInt(62)]!).join('');
}
const reserved = new Set(['healthz', 'readyz']);
const inputSchema = z
  .object({
    destinationUrl: z
      .string()
      .min(1)
      .max(2048)
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            value === value.trim() &&
            Array.from(value).every(
              (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
            ) &&
            /^https?:\/\//i.test(value) &&
            ['http:', 'https:'].includes(url.protocol) &&
            !!url.hostname
          );
        } catch {
          return false;
        }
      }),
    slug: z
      .string()
      .min(3)
      .max(50)
      .regex(/^[a-zA-Z0-9]{3,50}$/)
      .refine((value) => value === value.trim())
      .optional(),
    expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  })
  .strict();

export interface CreatedLink {
  id: string;
  slug: string;
  shortUrl: string;
  destinationUrl: string;
  createdAt: string;
  expiresAt: string | null;
}
export interface CreationClaim {
  subject: string;
  key: string;
  hash: string;
  now: Date;
  expiresAt: Date;
}
export interface CreationReplay {
  hash: string;
  status: number | null;
  body: CreatedLink | null;
  state: string;
}
export interface LinkCreationTransaction {
  /** null=missing owner; false=unverified. Lock owner before any write. */
  verifiedOwner(userId: string): Promise<boolean | null>;
  claim(claim: CreationClaim): Promise<boolean>;
  reserve(slug: string): Promise<boolean>;
  insert(
    userId: string,
    slug: string,
    destinationUrl: string,
    expiresAt: Date | null,
    now: Date,
  ): Promise<{ id: string }>;
  complete(subject: string, key: string, response: CreatedLink): Promise<void>;
}
export interface LinkCreationStore {
  verifiedOwner(userId: string): Promise<boolean | null>;
  transaction<T>(work: (tx: LinkCreationTransaction) => Promise<T>): Promise<T>;
  replay(subject: string, key: string, now: Date): Promise<CreationReplay | null>;
  available(slug: string): Promise<boolean>;
}
export class IdempotencyBusy extends AppError {
  constructor() {
    super(409, 'IDEMPOTENCY_IN_PROGRESS', 'Retry the creation request.', undefined, {
      retryAfterSeconds: 1,
    });
  }
}
export class ReplayConflict extends Error {}
export class SlugCollision extends Error {}
export interface LinkCreationOptions {
  store: LinkCreationStore;
  /** Trusted configured origin, never Host/Forwarded headers. */
  publicBaseUrl: string;
  now?: () => Date;
  /** Trusted test entropy seam; production uses cryptographic randomInt. */
  slug?: () => string;
}

export class LinkCreation {
  private readonly options: LinkCreationOptions;
  private readonly origin: string;
  constructor(options: LinkCreationOptions) {
    const url = new URL(options.publicBaseUrl);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error('Invalid public link origin.');
    this.origin = url.origin;
    this.options = options;
  }
  private now(): Date {
    try {
      const now = this.options.now?.() ?? new Date();
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error();
      return now;
    } catch {
      throw new AppError(503, 'INTERNAL', 'Link creation unavailable.');
    }
  }
  validate(input: unknown, key?: unknown) {
    const parsed = inputSchema.safeParse(input);
    if (
      !parsed.success ||
      (key !== undefined &&
        (typeof key !== 'string' ||
          key.length < 1 ||
          key.length > 255 ||
          !/^[\x21-\x7e]+$/.test(key) ||
          key !== key.trim()))
    )
      throw new AppError(400, 'VALIDATION_ERROR', 'Invalid link input.');
    return {
      destinationUrl: parsed.data.destinationUrl,
      slug: parsed.data.slug ?? null,
      expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt).toISOString() : null,
      key: key as string | undefined,
    };
  }
  async requireVerified(userId: string): Promise<void> {
    this.checkOwner(await this.options.store.verifiedOwner(userId));
  }
  private checkOwner(verified: boolean | null): void {
    if (verified === null) throw new AppError(401, 'UNAUTHENTICATED', 'Invalid credentials.');
    if (!verified) throw new AppError(403, 'EMAIL_NOT_VERIFIED', 'Email verification required.');
  }
  private nextSlug(): string {
    const slug = (this.options.slug ?? generateSlug)();
    if (typeof slug !== 'string' || slug.length !== 7 || !/^[a-zA-Z0-9]{7}$/.test(slug))
      throw new AppError(503, 'INTERNAL', 'Link creation unavailable.');
    return slug;
  }
  private async suggestions(): Promise<string[]> {
    const found = new Set<string>();
    for (let attempt = 0; attempt < 24 && found.size < 3; attempt++) {
      const slug = this.nextSlug();
      if (!reserved.has(slug) && !found.has(slug) && (await this.options.store.available(slug)))
        found.add(slug);
    }
    if (found.size !== 3) throw new AppError(503, 'INTERNAL', 'Link suggestions unavailable.');
    return [...found];
  }
  private async replay(
    subject: string,
    key: string,
    hash: string,
    now: Date,
  ): Promise<CreatedLink> {
    const saved = await this.options.store.replay(subject, key, now);
    if (!saved || saved.state !== 'completed' || saved.status !== 201 || !saved.body)
      throw new IdempotencyBusy();
    if (saved.hash !== hash)
      throw new AppError(409, 'IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency payload differs.');
    // JSONB key order differs from insertion order; preserve the HTTP shape and
    // serialization order on initial create and replay, without extra fields.
    const body = saved.body;
    return {
      id: body.id,
      slug: body.slug,
      shortUrl: body.shortUrl,
      destinationUrl: body.destinationUrl,
      createdAt: body.createdAt,
      expiresAt: body.expiresAt,
    };
  }
  async create(
    principal: AuthenticatedPrincipal,
    input: unknown,
    key?: unknown,
  ): Promise<CreatedLink> {
    const parsed = this.validate(input, key);
    if (
      !isCanonicalUuid(principal.userId) ||
      !isRateLimitPrincipal(principal.subject) ||
      (principal.kind === 'user'
        ? principal.subject !== `user:${principal.userId}`
        : !isCanonicalUuid(principal.keyId) || principal.subject !== `apikey:${principal.keyId}`)
    )
      throw new AppError(401, 'UNAUTHENTICATED', 'Invalid credentials.');
    const { destinationUrl, slug, expiresAt } = parsed;
    const hash = createHash('sha256')
      .update(JSON.stringify({ destinationUrl, slug, expiresAt }))
      .digest('hex');
    const now = this.now();
    await this.requireVerified(principal.userId);
    if (slug && reserved.has(slug))
      throw new AppError(409, 'CONFLICT', 'Slug is reserved.', undefined, {
        suggestions: await this.suggestions(),
      });
    if (expiresAt && new Date(expiresAt) <= now) {
      // A committed result remains replayable even after its link has expired.
      if (parsed.key && (await this.options.store.replay(principal.subject, parsed.key, now)))
        return this.replay(principal.subject, parsed.key, hash, now);
      throw new AppError(400, 'VALIDATION_ERROR', 'Expiration must be in the future.');
    }
    for (let attempt = 0; attempt < (slug ? 1 : 8); attempt++) {
      try {
        return await this.options.store.transaction(async (tx) => {
          this.checkOwner(await tx.verifiedOwner(principal.userId));
          if (
            parsed.key &&
            !(await tx.claim({
              subject: principal.subject,
              key: parsed.key,
              hash,
              now,
              expiresAt: new Date(now.getTime() + 86_400_000),
            }))
          )
            throw new ReplayConflict();
          const candidate = slug ?? this.nextSlug();
          if (reserved.has(candidate) || !(await tx.reserve(candidate))) throw new SlugCollision();
          const link = await tx.insert(
            principal.userId,
            candidate,
            destinationUrl,
            expiresAt ? new Date(expiresAt) : null,
            now,
          );
          const response: CreatedLink = {
            id: link.id,
            slug: candidate,
            shortUrl: `${this.origin}/${candidate}`,
            destinationUrl,
            createdAt: now.toISOString(),
            expiresAt,
          };
          if (parsed.key) await tx.complete(principal.subject, parsed.key, response);
          return response;
        });
      } catch (error) {
        if (error instanceof ReplayConflict)
          return this.replay(principal.subject, parsed.key!, hash, now);
        if (!(error instanceof SlugCollision)) throw error;
        if (slug)
          throw new AppError(409, 'CONFLICT', 'Slug is reserved.', undefined, {
            suggestions: await this.suggestions(),
          });
      }
    }
    throw new AppError(503, 'INTERNAL', 'Link creation unavailable.');
  }
}

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AppError } from '../platform/errors.ts';
import { tokenHashMatches } from './crypto.ts';

export interface ApiKeyRecord {
  id: string;
  userId: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/** Existing users/api_keys tables; no plaintext is accepted by the store. */
export interface ApiKeyStore {
  accountExists(userId: string): Promise<boolean>;
  /** False only for a unique prefix collision; all other failures throw. */
  insert(record: ApiKeyRecord): Promise<boolean>;
  list(userId: string): Promise<ApiKeyRecord[]>;
  revoke(userId: string, id: string, now: Date): Promise<boolean>;
  byPrefix(prefix: string): Promise<ApiKeyRecord | null>;
  /** Recheck revocation/account existence atomically when recording usage. */
  use(id: string, now: Date): Promise<boolean>;
}

const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && value.length === 36 && canonicalUuid.test(value);
}
const keyPattern = /^usk_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/;
const invalid = () => new AppError(401, 'UNAUTHENTICATED', 'Invalid credentials.');
const hashKey = (raw: string) => createHash('sha256').update(raw).digest('hex');
const dummyHash = hashKey('unmatched-api-key');

function metadata(record: ApiKeyRecord) {
  return {
    id: record.id,
    name: record.name,
    keyPrefix: record.keyPrefix,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    revokedAt: record.revokedAt,
  };
}

/** Service-owned, injected once per application; no global secrets or provider. */
export class ApiKeys {
  readonly store: ApiKeyStore;
  constructor(store: ApiKeyStore) {
    this.store = store;
  }

  async create(userId: string, input: unknown, now: Date) {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => key !== 'name')
    ) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Invalid API key input.');
    }
    const name = (input as { name?: unknown }).name;
    if (typeof name !== 'string' || name.trim().length === 0 || name.length > 128) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Invalid API key input.');
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const keyPrefix = randomBytes(4).toString('hex');
      const raw = `usk_${keyPrefix}_${randomBytes(32).toString('base64url')}`;
      const record: ApiKeyRecord = {
        id: randomUUID(),
        userId,
        name: name.trim(),
        keyPrefix,
        keyHash: hashKey(raw),
        createdAt: now,
        lastUsedAt: null,
        revokedAt: null,
      };
      if (await this.store.insert(record)) return { ...metadata(record), key: raw };
    }
    throw new AppError(503, 'INTERNAL', 'API key service unavailable.');
  }

  async list(userId: string) {
    return (await this.store.list(userId)).map(metadata);
  }

  async revoke(userId: string, id: string, now: Date): Promise<void> {
    if (!isCanonicalUuid(id)) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid API key id.');
    if (!(await this.store.revoke(userId, id, now)))
      throw new AppError(404, 'NOT_FOUND', 'API key not found.');
  }

  async verify(raw: string, now: Date): Promise<ApiKeyRecord> {
    const parts = raw.length === 56 ? keyPattern.exec(raw) : null;
    if (!parts || Buffer.from(parts[2]!, 'base64url').toString('base64url') !== parts[2])
      throw invalid();
    const record = await this.store.byPrefix(parts[1]!);
    // Compare fixed-size digests even when the prefix is unknown. No plaintext
    // or timing-safe equality is delegated to SQL/string comparison.
    const matches = tokenHashMatches(hashKey(raw), record?.keyHash ?? dummyHash);
    if (
      !matches ||
      !record ||
      record.revokedAt ||
      !isCanonicalUuid(record.id) ||
      !isCanonicalUuid(record.userId)
    )
      throw invalid();
    if (!(await this.store.use(record.id, now))) throw invalid();
    return record;
  }
}

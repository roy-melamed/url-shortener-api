import type { ApiKeyRecord, ApiKeyStore } from '../../src/auth/api-keys.ts';

/** Disposable test-only persistence. No production fallback or real resources. */
export class MemoryApiKeyStore implements ApiKeyStore {
  readonly users = new Set<string>();
  readonly keys = new Map<string, ApiKeyRecord>();
  async accountExists(id: string) {
    return this.users.has(id);
  }
  async insert(record: ApiKeyRecord) {
    if (!this.users.has(record.userId)) throw new Error('missing test owner');
    if ([...this.keys.values()].some((key) => key.keyPrefix === record.keyPrefix)) return false;
    this.keys.set(record.id, structuredClone(record));
    return true;
  }
  async list(userId: string) {
    return [...this.keys.values()]
      .filter((key) => key.userId === userId)
      .map((key) => structuredClone(key));
  }
  async revoke(userId: string, id: string, now: Date) {
    const key = this.keys.get(id);
    if (!key || key.userId !== userId) return false;
    key.revokedAt ??= now;
    return true;
  }
  async byPrefix(prefix: string) {
    return structuredClone([...this.keys.values()].find((key) => key.keyPrefix === prefix) ?? null);
  }
  async use(id: string, now: Date) {
    const key = this.keys.get(id);
    if (!key || key.revokedAt || !this.users.has(key.userId)) return false;
    key.lastUsedAt = now;
    return true;
  }
}

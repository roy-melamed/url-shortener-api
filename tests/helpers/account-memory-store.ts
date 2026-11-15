/** Transactional fixture store, not a production adapter or persistence substitute. */
import { randomUUID } from 'node:crypto';
import { AppError } from '../../src/platform/errors.ts';
import type {
  Account,
  AccountStore,
  AccountTransaction,
  EmailTokenRecord,
  RefreshRecord,
} from '../../src/auth/contracts.ts';

export class MemoryAccountStore implements AccountStore {
  accounts = new Map<string, Account>();
  emails = new Map<string, EmailTokenRecord>();
  refresh = new Map<string, RefreshRecord>();
  private serial = Promise.resolve();
  failCommit = false;
  async credentials(email: string): Promise<Account | null> {
    return structuredClone(
      [...this.accounts.values()].find((a) => a.email === email.toLowerCase()) ?? null,
    );
  }
  async transaction<T>(work: (tx: AccountTransaction) => Promise<T>): Promise<T> {
    const previous = this.serial;
    let unlock!: () => void;
    this.serial = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;
    const before = structuredClone({
      accounts: this.accounts,
      emails: this.emails,
      refresh: this.refresh,
    });
    const tx: AccountTransaction = {
      createAccount: async (email, passwordHash) => {
        if ([...this.accounts.values()].some((a) => a.email === email))
          throw new AppError(409, 'CONFLICT', 'Account already exists.');
        const a = { id: randomUUID(), email, passwordHash, emailVerifiedAt: null };
        this.accounts.set(a.id, a);
        return a;
      },
      lockAccount: async (id) => structuredClone(this.accounts.get(id) ?? null),
      insertEmailToken: async (record) => {
        this.emails.set(record.id, structuredClone(record));
      },
      emailToken: async (id) => structuredClone(this.emails.get(id) ?? null),
      useEmailToken: async (id, now) => {
        this.emails.get(id)!.usedAt = now;
      },
      verifyEmail: async (id, now) => {
        this.accounts.get(id)!.emailVerifiedAt ??= now;
      },
      insertRefresh: async (record) => {
        this.refresh.set(record.id, structuredClone(record));
      },
      refreshToken: async (id) => structuredClone(this.refresh.get(id) ?? null),
      revokeRefresh: async (id, now) => {
        this.refresh.get(id)!.revokedAt ??= now;
      },
      revokeFamily: async (id, now) => {
        for (const r of this.refresh.values()) if (r.familyId === id) r.revokedAt ??= now;
      },
      deleteAccount: async (id) => {
        this.accounts.delete(id);
        for (const [key, row] of this.emails) if (row.userId === id) this.emails.delete(key);
        for (const [key, row] of this.refresh) if (row.userId === id) this.refresh.delete(key);
      },
    };
    try {
      const result = await work(tx);
      if (this.failCommit) throw new AppError(503, 'INTERNAL', 'Account store unavailable.');
      return result;
    } catch (error) {
      this.accounts = before.accounts;
      this.emails = before.emails;
      this.refresh = before.refresh;
      throw error;
    } finally {
      unlock();
    }
  }
}

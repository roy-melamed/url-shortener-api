import { randomUUID } from 'node:crypto';
import type {
  CreationClaim,
  CreationReplay,
  CreatedLink,
  LinkCreationStore,
  LinkCreationTransaction,
} from '../../src/links/create.ts';

/** Transactional test fixture only; actual PostgreSQL concurrency is tested separately. */
export class MemoryLinkCreationStore implements LinkCreationStore {
  readonly owners = new Map<string, boolean>();
  reservations = new Set<string>();
  links = new Map<
    string,
    { userId: string; slug: string; destinationUrl: string; expiresAt: Date | null }
  >();
  records = new Map<string, CreationClaim & CreationReplay>();
  fault?: 'reserve' | 'insert' | 'complete';
  transactions = 0;
  private tail = Promise.resolve();
  async verifiedOwner(id: string) {
    return this.owners.get(id) ?? null;
  }
  async available(slug: string) {
    return !this.reservations.has(slug);
  }
  async replay(subject: string, key: string, now: Date) {
    const record = this.records.get(`${subject}|${key}`);
    return record && record.expiresAt > now ? structuredClone(record) : null;
  }
  async transaction<T>(work: (tx: LinkCreationTransaction) => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    this.transactions++;
    const reservations = structuredClone(this.reservations),
      links = structuredClone(this.links),
      records = structuredClone(this.records);
    const tx: LinkCreationTransaction = {
      verifiedOwner: (id) => this.verifiedOwner(id),
      claim: async (claim) => {
        const id = `${claim.subject}|${claim.key}`,
          current = records.get(id);
        if (current && current.expiresAt > claim.now) return false;
        records.set(id, { ...claim, state: 'completed', status: null, body: null });
        return true;
      },
      reserve: async (slug) => {
        if (reservations.has(slug)) return false;
        reservations.add(slug);
        if (this.fault === 'reserve') throw new Error('Injected reservation failure');
        return true;
      },
      insert: async (userId, slug, destinationUrl, expiresAt) => {
        const id = randomUUID();
        links.set(id, { userId, slug, destinationUrl, expiresAt });
        if (this.fault === 'insert') throw new Error('Injected link failure');
        return { id };
      },
      complete: async (subject, key, response: CreatedLink) => {
        const record = records.get(`${subject}|${key}`)!;
        record.status = 201;
        record.body = structuredClone(response);
        if (this.fault === 'complete') throw new Error('Injected response failure');
      },
    };
    try {
      const result = await work(tx);
      this.reservations = reservations;
      this.links = links;
      this.records = records;
      return result;
    } finally {
      release();
    }
  }
}

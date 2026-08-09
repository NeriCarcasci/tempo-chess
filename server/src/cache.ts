// In-memory response cache for read-heavy endpoints. Each entry has a TTL, and the
// store is bounded: once it exceeds `max` entries it evicts the least-recently-used
// one (Map preserves insertion order, and get()/set() re-insert on access), so it
// can't grow without limit as the number of users and query permutations climbs.
//
// This is deliberately process-local. It's a latency/compute shield in front of the
// DB, not a source of truth — a multi-instance deployment can layer Redis behind the
// same interface later without changing call sites.

interface Entry {
  value: unknown;
  at: number;
}

export class TtlCache {
  private readonly store = new Map<string, Entry>();

  constructor(
    private readonly ttlMs: number,
    private readonly max = 1000,
  ) {}

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.at > this.ttlMs) {
      this.store.delete(key);
      return undefined;
    }
    // Touch: move to the most-recently-used end.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value as T;
  }

  set<T>(key: string, value: T): void {
    this.store.delete(key);
    this.store.set(key, { value, at: Date.now() });
    while (this.store.size > this.max) {
      const oldest = this.store.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  /** Drop entries. No prefix clears everything; a prefix clears matching keys
   *  (e.g. `explorer:<user>:` after that user's opening graph is rebuilt). */
  invalidate(prefix?: string): void {
    if (prefix === undefined) {
      this.store.clear();
      return;
    }
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }
}

// Tiny in-memory cache for client loaders. In an SPA every navigation re-runs the
// route's clientLoader, which otherwise re-fetches the same data (including slow,
// rate-limited Lichess calls) on every visit. Caching the loader result makes
// re-navigation feel instant and keeps third-party calls off the critical path on
// repeat visits.
//
// It is intentionally not persisted: a full page reload clears it, which is the
// natural "give me fresh data" gesture. Mutations should call invalidate().

interface Entry {
  value: unknown;
  at: number;
}

const store = new Map<string, Entry>();

/** Return a cached value if present and younger than ttlMs, else undefined. */
export function getCached<T>(key: string, ttlMs: number): T | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at > ttlMs) {
    store.delete(key);
    return undefined;
  }
  return entry.value as T;
}

export function setCached<T>(key: string, value: T): void {
  store.set(key, { value, at: Date.now() });
}

/** Drop cache entries. With no prefix, clears everything; otherwise clears keys
 *  starting with the prefix (e.g. "home:" after a sync mutates the account). */
export function invalidateCache(prefix?: string): void {
  if (!prefix) {
    store.clear();
    return;
  }
  for (const key of [...store.keys()]) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

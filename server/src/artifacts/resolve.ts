/**
 * Which `ArtifactStore` this process uses.
 *
 * Resolved once from configuration and cached, because a store built per
 * request would re-read a credential on every download.
 *
 * It fails closed and loudly. A missing service key is not a reason to fall
 * back to something that appears to work: the alternative to a signed URL is no
 * URL, never an unsigned one.
 */

import { SupabaseArtifactStore, type ArtifactStore } from "./store.js";

/**
 * The Supabase service key. Bucket-wide, so it lives only in Secret Manager and
 * only reaches services that sign or write bodies -- never a browser.
 */
export const SERVICE_KEY_ENV = "SUPABASE_SERVICE_KEY";

export class ArtifactStoreUnavailable extends Error {
  constructor(missing: string) {
    super(`${missing} is not set; artifact storage is unavailable`);
    this.name = "ArtifactStoreUnavailable";
  }
}

let cached: ArtifactStore | null = null;

export function resolveArtifactStore(env: NodeJS.ProcessEnv = process.env): ArtifactStore {
  if (cached) return cached;
  const url = env.SUPABASE_URL?.trim();
  const serviceKey = env[SERVICE_KEY_ENV]?.trim();
  if (!url) throw new ArtifactStoreUnavailable("SUPABASE_URL");
  if (!serviceKey) throw new ArtifactStoreUnavailable(SERVICE_KEY_ENV);
  cached = new SupabaseArtifactStore({ url, serviceKey });
  return cached;
}

/** Whether this process could serve a download at all. */
export function artifactStorageConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SUPABASE_URL?.trim() && env[SERVICE_KEY_ENV]?.trim());
}

/** Tests replace the store rather than the configuration. */
export function setArtifactStoreForTesting(store: ArtifactStore | null): void {
  cached = store;
}

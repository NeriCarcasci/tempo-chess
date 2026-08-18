/**
 * The `ArtifactStore` boundary.
 *
 * One interface, two implementations: Supabase Storage, and an in-memory one
 * the tests use. The point of the seam is not portability — it is that every
 * rule about ordering and verification lives above it, so a test can exercise
 * "the upload succeeded but the body is wrong" without a bucket.
 *
 * The contract deliberately has no `delete and forget`. `remove` reports
 * whether the object is gone, because deletion is not complete until the object
 * is confirmed absent and the caller has to be able to tell the difference.
 */

export interface PutObject {
  bucket: string;
  key: string;
  body: Uint8Array;
  contentType?: string;
}

export interface ObjectStat {
  bytes: number;
  sha256: string;
}

export interface ArtifactStore {
  /** Write the body. Overwriting an existing key is an error, not an update. */
  put(object: PutObject): Promise<void>;
  /** Read back what is actually stored, for verification. Null when absent. */
  stat(bucket: string, key: string): Promise<ObjectStat | null>;
  /** A short-lived URL for an authorized caller. */
  signDownload(bucket: string, key: string, ttlSeconds: number): Promise<string>;
  /** Remove the object. Resolves true only when it is confirmed gone. */
  remove(bucket: string, key: string): Promise<boolean>;
}

export class ObjectAlreadyExists extends Error {
  constructor(bucket: string, key: string) {
    // No key in the message: it reaches logs.
    super(`an object already exists in ${bucket}`);
    this.name = "ObjectAlreadyExists";
  }
}

import { createHash } from "node:crypto";

/**
 * An in-memory store.
 *
 * Not a mock of the interface — a real implementation of it, so the lifecycle
 * tests exercise the same code path the Supabase one does, including refusing
 * an overwrite and confirming a removal.
 */
export class MemoryArtifactStore implements ArtifactStore {
  private readonly objects = new Map<string, { body: Uint8Array; contentType?: string }>();
  /** Set to make the next `remove` report failure, for retry tests. */
  failNextRemoval = false;

  private static id(bucket: string, key: string): string {
    return `${bucket}/${key}`;
  }

  async put(object: PutObject): Promise<void> {
    const id = MemoryArtifactStore.id(object.bucket, object.key);
    if (this.objects.has(id)) throw new ObjectAlreadyExists(object.bucket, object.key);
    this.objects.set(id, { body: object.body, contentType: object.contentType });
  }

  async stat(bucket: string, key: string): Promise<ObjectStat | null> {
    const found = this.objects.get(MemoryArtifactStore.id(bucket, key));
    if (!found) return null;
    return {
      bytes: found.body.byteLength,
      sha256: createHash("sha256").update(found.body).digest("hex"),
    };
  }

  async signDownload(bucket: string, key: string, ttlSeconds: number): Promise<string> {
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    return `memory://${bucket}/${key}?expires=${expires}`;
  }

  async remove(bucket: string, key: string): Promise<boolean> {
    if (this.failNextRemoval) {
      this.failNextRemoval = false;
      return false;
    }
    this.objects.delete(MemoryArtifactStore.id(bucket, key));
    return !this.objects.has(MemoryArtifactStore.id(bucket, key));
  }

  /** Test helper: what bodies actually exist. */
  keys(): string[] {
    return [...this.objects.keys()].sort();
  }
}

interface SupabaseStorageConfig {
  url: string;
  serviceKey: string;
  fetchImpl?: typeof fetch;
}

/**
 * Supabase Storage over its REST API.
 *
 * Uses the service key, which is why this only ever runs in a worker or the
 * API's own process and never anywhere a browser can reach: the key is a
 * bucket-wide credential and the authorization decision has already been made
 * by the caller before anything here is invoked.
 */
export class SupabaseArtifactStore implements ArtifactStore {
  private readonly base: string;
  private readonly key: string;
  private readonly http: typeof fetch;

  constructor(config: SupabaseStorageConfig) {
    this.base = `${config.url.replace(/\/+$/, "")}/storage/v1`;
    this.key = config.serviceKey;
    this.http = config.fetchImpl ?? fetch;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.key}`, apikey: this.key, ...extra };
  }

  async put(object: PutObject): Promise<void> {
    const response = await this.http(`${this.base}/object/${object.bucket}/${object.key}`, {
      method: "POST",
      headers: this.headers({
        "content-type": object.contentType ?? "application/octet-stream",
        // Refuse to replace a body: an existing key is a different artifact.
        "x-upsert": "false",
      }),
      body: object.body,
    });
    if (response.status === 409) throw new ObjectAlreadyExists(object.bucket, object.key);
    if (!response.ok) throw new Error(`storage rejected the upload (${response.status})`);
  }

  async stat(bucket: string, key: string): Promise<ObjectStat | null> {
    // The body is re-read rather than trusting a returned header: the checksum
    // has to be computed over what is actually stored for verification to mean
    // anything.
    const response = await this.http(`${this.base}/object/${bucket}/${key}`, {
      headers: this.headers(),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`storage could not be read (${response.status})`);
    const body = new Uint8Array(await response.arrayBuffer());
    return { bytes: body.byteLength, sha256: createHash("sha256").update(body).digest("hex") };
  }

  async signDownload(bucket: string, key: string, ttlSeconds: number): Promise<string> {
    const response = await this.http(`${this.base}/object/sign/${bucket}/${key}`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ expiresIn: ttlSeconds }),
    });
    if (!response.ok) throw new Error(`storage would not sign a url (${response.status})`);
    const payload = (await response.json()) as { signedURL?: string };
    if (!payload.signedURL) throw new Error("storage returned no signed url");
    return `${this.base}${payload.signedURL}`;
  }

  async remove(bucket: string, key: string): Promise<boolean> {
    const response = await this.http(`${this.base}/object/${bucket}/${key}`, {
      method: "DELETE",
      headers: this.headers(),
    });
    // A body that is already absent is a successful deletion, not a failure:
    // the janitor retries, and a retry must converge.
    if (response.status === 404) return true;
    if (!response.ok) return false;
    return (await this.stat(bucket, key)) === null;
  }
}

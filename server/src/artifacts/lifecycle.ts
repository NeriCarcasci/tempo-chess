/**
 * The artifact lifecycle: upload, verify, attach, sign, sweep, delete.
 *
 * Ordering is the whole contract, and it is stated once here:
 *
 *  1. reserve the row as `pending`, which claims the key;
 *  2. write the object;
 *  3. read back what is stored and compare it to what was declared;
 *  4. only then mark the row `ready`.
 *
 * Every step is crash-safe in the same direction. A crash after 1 leaves a row
 * with no body, which the janitor sweeps. A crash after 2 leaves a body with a
 * pending row, which the janitor sweeps. A crash after 3 leaves a verified body
 * with a pending row, which is swept and re-uploaded. What cannot happen is a
 * `ready` row whose body was never verified, because 4 is the only writer of
 * that state and it runs after 3.
 *
 * Storage calls never happen inside a database transaction: the row writes are
 * short and separate, per the epic's prohibition on network calls in a
 * transaction.
 */

import type { Sql } from "postgres";
import {
  BUCKET_FOR_RETENTION,
  downloadTtlSeconds,
  isSweepable,
  keyLooksOpaque,
  mayDownload,
  mintObjectKey,
  sha256Of,
  systemObjectKey,
  uploadMatches,
  type ArtifactState,
  type RetentionClass,
} from "./contract.js";
import { ObjectAlreadyExists, type ArtifactStore } from "./store.js";

export interface StoreArtifactInput {
  retentionClass: RetentionClass;
  body: Uint8Array;
  mediaType?: string;
  extension?: string;
  ownerSubjectId?: string | null;
  createdByWorkflowId?: string | null;
  providerId?: number | null;
  artifactKind?: string | null;
  expiresAt?: Date | null;
  sourceReference?: string | null;
}

export interface StoredArtifact {
  id: string;
  bucket: string;
  objectKey: string;
  sha256: string;
  byteSize: number;
  state: ArtifactState;
  /** True when an identical system artifact already existed. */
  deduplicated: boolean;
}

export class ArtifactVerificationFailed extends Error {
  constructor(readonly artifactId: string) {
    super("the uploaded body did not match what was declared");
    this.name = "ArtifactVerificationFailed";
  }
}

/**
 * Store a body and make it available, or fail without leaving a usable row.
 *
 * `now` is injected so the sweep tests can age an artifact without waiting.
 */
export async function storeArtifact(
  sql: Sql,
  store: ArtifactStore,
  input: StoreArtifactInput,
  now: Date = new Date(),
): Promise<StoredArtifact> {
  const bucket = BUCKET_FOR_RETENTION[input.retentionClass];
  const sha256 = sha256Of(input.body);
  const byteSize = input.body.byteLength;

  // System artifacts are checksum-addressed, so the same body twice is the same
  // object. Everything else gets a fresh random key.
  const isSystem = input.retentionClass === "system_immutable";
  const objectKey = isSystem
    ? systemObjectKey(sha256, input.extension)
    : mintObjectKey(now, input.extension);

  if (!keyLooksOpaque(objectKey)) {
    throw new Error("refusing to write a key that is not opaque");
  }

  if (isSystem) {
    const existing = await sql<{ id: string; state: ArtifactState }[]>`
      select id, state from ops.artifacts
      where bucket = ${bucket} and object_key = ${objectKey} and state = 'ready'
    `;
    if (existing.length > 0) {
      return {
        id: existing[0].id,
        bucket,
        objectKey,
        sha256,
        byteSize,
        state: "ready",
        deduplicated: true,
      };
    }
  }

  // 1. Reserve. The unique index on (backend, bucket, key) makes this the point
  // at which two concurrent writers are separated.
  const [row] = await sql<{ id: string }[]>`
    insert into ops.artifacts (
      bucket, object_key, state, retention_class, media_type, compression,
      owner_subject_id, created_by_workflow_id, provider_id, artifact_kind,
      expires_at, source_reference
    ) values (
      ${bucket}, ${objectKey}, 'pending', ${input.retentionClass}, ${input.mediaType ?? null}, null,
      ${input.ownerSubjectId ?? null}, ${input.createdByWorkflowId ?? null},
      ${input.providerId ?? null}, ${input.artifactKind ?? null},
      ${input.expiresAt ?? null}, ${input.sourceReference ?? null}
    ) returning id
  `;

  try {
    // 2. Write the body.
    await store.put({ bucket, key: objectKey, body: input.body, contentType: input.mediaType });
  } catch (error) {
    if (!(error instanceof ObjectAlreadyExists)) {
      await markFailed(sql, row.id, "upload_rejected");
      throw error;
    }
    // A system artifact whose body is already there is the deduplicated case
    // arriving by a different route; anything else is a key collision we do not
    // want to write over.
    if (!isSystem) {
      await markFailed(sql, row.id, "key_collision");
      throw error;
    }
  }

  // 3. Read back what is actually stored.
  const observed = await store.stat(bucket, objectKey);
  if (
    !observed ||
    !uploadMatches({
      expectedSha256: sha256,
      expectedBytes: byteSize,
      observedSha256: observed.sha256,
      observedBytes: observed.bytes,
    })
  ) {
    await markFailed(sql, row.id, observed ? "checksum_mismatch" : "object_missing");
    throw new ArtifactVerificationFailed(row.id);
  }

  // 4. Only now is it downloadable.
  await sql`
    update ops.artifacts
    set state = 'ready', sha256 = ${sha256}, byte_size = ${byteSize},
        verified_at = now(), ready_at = now()
    where id = ${row.id} and state = 'pending'
  `;

  return { id: row.id, bucket, objectKey, sha256, byteSize, state: "ready", deduplicated: false };
}

async function markFailed(sql: Sql, id: string, reason: string): Promise<void> {
  await sql`
    update ops.artifacts set state = 'failed', deletion_failure_class = ${reason}
    where id = ${id} and state = 'pending'
  `;
}

/**
 * A signed URL for an authorized caller, or null.
 *
 * The authorization decision is made here against the row, not delegated to the
 * URL: once signed, the URL is a bearer token that no longer knows who asked.
 */
export async function signArtifactDownload(
  sql: Sql,
  store: ArtifactStore,
  artifactId: string,
  actorSubjectIds: readonly string[],
  ttlSeconds?: number,
): Promise<{ url: string; expiresInSeconds: number } | null> {
  const [row] = await sql<
    {
      bucket: string;
      object_key: string;
      state: ArtifactState;
      owner_subject_id: string | null;
      retention_class: RetentionClass;
    }[]
  >`
    select bucket, object_key, state, owner_subject_id, retention_class
    from ops.artifacts where id = ${artifactId}
  `;
  if (!row) return null;
  const allowed = mayDownload(
    {
      state: row.state,
      ownerSubjectId: row.owner_subject_id,
      retentionClass: row.retention_class,
    },
    actorSubjectIds,
  );
  if (!allowed) return null;
  const ttl = downloadTtlSeconds(ttlSeconds);
  return { url: await store.signDownload(row.bucket, row.object_key, ttl), expiresInSeconds: ttl };
}

export interface SweepReport {
  examined: number;
  removed: number;
  stillPresent: number;
}

/**
 * Remove bodies nothing references, and expired exports.
 *
 * Idempotent by construction: it selects by state, and a row only leaves the
 * candidate set once its object is confirmed gone. Running it twice removes
 * nothing the second time; running it after a partial failure retries exactly
 * the rows that failed.
 */
export async function sweepArtifacts(
  sql: Sql,
  store: ArtifactStore,
  now: Date = new Date(),
  limit = 200,
): Promise<SweepReport> {
  const candidates = await sql<
    { id: string; bucket: string; object_key: string; state: ArtifactState; created_at: Date | string }[]
  >`
    select id, bucket, object_key, state, created_at from ops.artifacts
    where state in ('pending', 'failed', 'deleting')
       or (state = 'ready' and expires_at is not null and expires_at < ${now})
    order by created_at
    limit ${limit}
  `;

  let removed = 0;
  let stillPresent = 0;

  for (const candidate of candidates) {
    const createdAt =
      candidate.created_at instanceof Date ? candidate.created_at : new Date(candidate.created_at);
    const expired = candidate.state === "ready" || candidate.state === "deleting";
    if (!expired && !isSweepable(candidate.state, createdAt, now)) continue;

    // Announce the intent before touching storage, so a crash mid-removal is
    // retried rather than forgotten.
    await sql`
      update ops.artifacts set state = 'deleting', deleting_at = coalesce(deleting_at, now())
      where id = ${candidate.id} and state <> 'deleted'
    `;

    const gone = await store.remove(candidate.bucket, candidate.object_key);
    if (gone) {
      await sql`
        update ops.artifacts set state = 'deleted', deleted_at = now(), deletion_failure_class = null
        where id = ${candidate.id}
      `;
      removed += 1;
    } else {
      // Stays in `deleting`, so the next sweep tries again. Deletion is not
      // complete until the object is confirmed absent.
      await sql`
        update ops.artifacts set deletion_failure_class = 'remove_failed'
        where id = ${candidate.id}
      `;
      stillPresent += 1;
    }
  }

  return { examined: candidates.length, removed, stillPresent };
}

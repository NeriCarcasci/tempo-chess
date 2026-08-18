/**
 * The E07 artifact vocabulary and the rules that need no storage backend.
 *
 * An artifact is metadata in Postgres pointing at a body in private Supabase
 * Storage. The two can never be written atomically, so the whole design is
 * about which of them is allowed to be ahead of the other: the object is
 * written first, and the row only becomes `ready` once the object has been
 * verified. A row that claims `ready` for a body that was never verified is the
 * failure this epic exists to make impossible.
 *
 * Sources: plans/database-architecture.md §8.4, plans/v1-platform-spec.md §§9,
 * 11, 17-18, plans/v1-api-contract.md §§4, 15.
 */

import { createHash, randomBytes } from "node:crypto";

/** Database architecture §8.4. */
export const ARTIFACT_STATES = ["pending", "ready", "deleting", "deleted", "failed"] as const;
export type ArtifactState = (typeof ARTIFACT_STATES)[number];

export const RETENTION_CLASSES = [
  "subject_owned",
  "system_immutable",
  "editorial",
  "temporary",
] as const;
export type RetentionClass = (typeof RETENTION_CLASSES)[number];

/** The three private buckets. There is no public bucket, by design. */
export const BUCKETS = ["subject-artifacts", "system-artifacts", "exports"] as const;
export type Bucket = (typeof BUCKETS)[number];

/**
 * Which bucket a retention class lives in.
 *
 * The mapping is total and one-way: a caller names what the artifact *is* and
 * the bucket follows. A client-selected bucket is explicitly out of scope, and
 * making this a function rather than a parameter is how that stays true.
 */
export const BUCKET_FOR_RETENTION: Readonly<Record<RetentionClass, Bucket>> = {
  subject_owned: "subject-artifacts",
  editorial: "subject-artifacts",
  system_immutable: "system-artifacts",
  temporary: "exports",
};

/**
 * Legal lifecycle transitions.
 *
 * `pending` may fail or become ready. `ready` may only start deleting — it never
 * returns to pending, because the object it names is immutable and a second
 * upload would be a different artifact. `deleting` may complete or fail, and a
 * failed deletion stays visible rather than being silently dropped.
 */
const TRANSITIONS: Readonly<Record<ArtifactState, readonly ArtifactState[]>> = {
  pending: ["ready", "failed", "deleting"],
  ready: ["deleting"],
  deleting: ["deleted", "failed"],
  // Terminal. A deleted artifact is never resurrected; a new upload is a new row.
  deleted: [],
  // A failed artifact may be retried into deletion so its orphan body is swept.
  failed: ["deleting"],
};

export function mayTransition(from: ArtifactState, to: ArtifactState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Only a verified, ready artifact has a body a caller may be given. */
export function isDownloadable(state: ArtifactState): boolean {
  return state === "ready";
}

/**
 * Whether a body is eligible to be swept.
 *
 * `pending` is included only past its grace period: an upload in flight is
 * indistinguishable from an abandoned one except by age, and sweeping a live
 * upload would delete a body its row is about to reference.
 */
export function isSweepable(
  state: ArtifactState,
  createdAt: Date,
  now: Date,
  gracePeriodMs = 6 * 60 * 60 * 1000,
): boolean {
  if (state === "failed") return true;
  if (state !== "pending") return false;
  return now.getTime() - createdAt.getTime() > gracePeriodMs;
}

export interface UploadVerification {
  readonly expectedSha256: string;
  readonly expectedBytes: number;
  readonly observedSha256: string;
  readonly observedBytes: number;
}

/**
 * Whether an uploaded object matches what was declared.
 *
 * Both halves are checked. Size alone is trivially forgeable and hash alone
 * would accept a truncated body whose hash was computed over the truncation, so
 * a mismatch in either is a failed upload rather than a warning.
 */
export function uploadMatches(verification: UploadVerification): boolean {
  return (
    verification.observedBytes === verification.expectedBytes &&
    verification.observedSha256.toLowerCase() === verification.expectedSha256.toLowerCase()
  );
}

const HEX64 = /^[0-9a-f]{64}$/;

export function isSha256(value: string): boolean {
  return HEX64.test(value.toLowerCase());
}

/**
 * A storage key that carries no meaning.
 *
 * Object keys are visible in signed URLs, storage listings, logs and support
 * tickets, so anything embedded in one is effectively disclosed. A handle, an
 * email, a subject id or a game id in a key would leak on every download, so
 * the key is random and the mapping back to an owner lives only in the row.
 *
 * The date prefix is the one concession, and it names nothing about the owner:
 * it exists so a human debugging storage can bound a search by time.
 */
export function mintObjectKey(now: Date, extension?: string): string {
  const day = now.toISOString().slice(0, 10);
  const suffix = extension ? `.${extension.replace(/^\.+/, "").toLowerCase()}` : "";
  return `${day}/${randomBytes(24).toString("hex")}${suffix}`;
}

/**
 * The key for a system artifact, addressed by content.
 *
 * §8.4 requires system artifacts to use checksum-addressed immutable keys: two
 * uploads of the same catalogue converge on one object rather than accumulating
 * copies, and the key is a claim about the body that can be checked.
 */
export function systemObjectKey(sha256: string, extension?: string): string {
  if (!isSha256(sha256)) throw new Error("a system artifact key needs a sha256");
  const hex = sha256.toLowerCase();
  const suffix = extension ? `.${extension.replace(/^\.+/, "").toLowerCase()}` : "";
  // Sharded so a bucket listing stays navigable at scale.
  return `${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex}${suffix}`;
}

/** Reject a key that leaks something, before it is ever written. */
export function keyLooksOpaque(key: string): boolean {
  if (key.includes("@") || key.includes(" ")) return false;
  // A uuid in a key is almost always a subject, user or game id.
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(key)) return false;
  return /^[0-9a-zA-Z/_.-]+$/.test(key);
}

export function sha256Of(body: Uint8Array | string): string {
  return createHash("sha256").update(body).digest("hex");
}

/**
 * How long a download URL may live.
 *
 * Short by default: a signed URL is a bearer token for a private body, and it
 * outlives the authorization check that produced it. Long enough for a browser
 * to follow a redirect and resume once, not long enough to be pasted usefully.
 */
export const DOWNLOAD_URL_TTL_SECONDS = 120;
export const MAX_DOWNLOAD_URL_TTL_SECONDS = 900;

export function downloadTtlSeconds(requested?: number): number {
  if (!requested || requested <= 0) return DOWNLOAD_URL_TTL_SECONDS;
  return Math.min(requested, MAX_DOWNLOAD_URL_TTL_SECONDS);
}

/**
 * Whether an actor may be handed a body.
 *
 * Ownership is checked against the artifact's owning subject, so an artifact
 * with no subject is only reachable by a system caller. State is checked too:
 * a pending or failed artifact has no verified body, and a deleted one has
 * nothing at all.
 */
export function mayDownload(
  artifact: { state: ArtifactState; ownerSubjectId: string | null; retentionClass: RetentionClass },
  actorSubjectIds: readonly string[],
): boolean {
  if (!isDownloadable(artifact.state)) return false;
  if (artifact.retentionClass === "system_immutable") return true;
  if (!artifact.ownerSubjectId) return false;
  return actorSubjectIds.includes(artifact.ownerSubjectId);
}

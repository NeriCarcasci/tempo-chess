/**
 * `npm run artifacts:unit` — the E07 rules that need no storage backend.
 *
 * These are the epic's acceptance criteria as assertions: a body that does not
 * match cannot be ready, a pending or failed artifact cannot be downloaded, a
 * key carries no PII, and a signed URL expires.
 */

import { strict as assert } from "node:assert";
import {
  ARTIFACT_STATES,
  BUCKETS,
  BUCKET_FOR_RETENTION,
  DOWNLOAD_URL_TTL_SECONDS,
  MAX_DOWNLOAD_URL_TTL_SECONDS,
  RETENTION_CLASSES,
  downloadTtlSeconds,
  isDownloadable,
  isSha256,
  isSweepable,
  keyLooksOpaque,
  mayDownload,
  mayTransition,
  mintObjectKey,
  sha256Of,
  systemObjectKey,
  uploadMatches,
  type ArtifactState,
} from "./contract.js";

let passed = 0;
const failures: string[] = [];

function check(name: string, body: () => string): void {
  try {
    const detail = body();
    passed += 1;
    console.log(`ok   ${name} — ${detail}`);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    console.log(`FAIL ${name}`);
  }
}

const NOW = new Date("2026-08-18T12:00:00Z");
const HASH = sha256Of("a body");

console.log("cd server && npm run artifacts:unit\n");

check("only a ready artifact is downloadable", () => {
  for (const state of ARTIFACT_STATES) {
    assert.equal(isDownloadable(state), state === "ready", state);
  }
  return "pending, deleting, deleted and failed all refuse";
});

check("a mismatched upload is never accepted", () => {
  const base = { expectedSha256: HASH, expectedBytes: 6, observedSha256: HASH, observedBytes: 6 };
  assert.equal(uploadMatches(base), true);
  assert.equal(uploadMatches({ ...base, observedBytes: 5 }), false);
  assert.equal(uploadMatches({ ...base, observedSha256: sha256Of("another body") }), false);
  // Case is not a difference; a truncation is.
  assert.equal(uploadMatches({ ...base, observedSha256: HASH.toUpperCase() }), true);
  return "size mismatch and hash mismatch both refuse; hex case does not";
});

check("the lifecycle cannot run backwards", () => {
  assert.equal(mayTransition("pending", "ready"), true);
  assert.equal(mayTransition("pending", "failed"), true);
  assert.equal(mayTransition("ready", "deleting"), true);
  assert.equal(mayTransition("deleting", "deleted"), true);
  // The ones that matter: a ready artifact never becomes pending again, and a
  // deleted one is never resurrected.
  assert.equal(mayTransition("ready", "pending"), false);
  assert.equal(mayTransition("deleted", "ready"), false);
  assert.equal(mayTransition("deleted", "pending"), false);
  assert.equal(mayTransition("failed", "ready"), false);
  return "ready never returns to pending; deleted is terminal";
});

check("deletion does not complete until the object is confirmed gone", () => {
  // `deleting` is a real state rather than a flag, so a failed provider call
  // leaves the row in `deleting` or `failed` and never in `deleted`.
  assert.equal(mayTransition("deleting", "deleted"), true);
  assert.equal(mayTransition("deleting", "failed"), true);
  assert.equal(mayTransition("ready", "deleted"), false);
  return "ready cannot jump to deleted; it passes through deleting";
});

check("an object key carries nothing about its owner", () => {
  const key = mintObjectKey(NOW, "pgn");
  assert.equal(keyLooksOpaque(key), true, key);
  assert.equal(key.startsWith("2026-08-18/"), true);
  assert.equal(key.endsWith(".pgn"), true);
  // Two artifacts made in the same instant do not collide.
  assert.notEqual(mintObjectKey(NOW), mintObjectKey(NOW));
  for (const leaky of [
    "2026-08-18/magnus@example.com.pgn",
    "2026-08-18/0f505557-34c9-4927-bf2b-6d1236fbe085.pgn",
    "2026-08-18/has space.pgn",
  ]) {
    assert.equal(keyLooksOpaque(leaky), false, leaky);
  }
  return "random key, date prefix only; email, uuid and spaces all rejected";
});

check("a system artifact is addressed by its content", () => {
  const key = systemObjectKey(HASH, "json");
  assert.equal(key, `${HASH.slice(0, 2)}/${HASH.slice(2, 4)}/${HASH}.json`);
  // The same body twice is the same object, not two copies.
  assert.equal(systemObjectKey(HASH, "json"), key);
  assert.throws(() => systemObjectKey("not-a-hash"), /sha256/);
  assert.equal(keyLooksOpaque(key), true);
  return "sharded, deterministic, and refuses a non-hash";
});

check("the bucket follows from the retention class, never from a caller", () => {
  for (const retention of RETENTION_CLASSES) {
    const bucket = BUCKET_FOR_RETENTION[retention];
    assert.ok((BUCKETS as readonly string[]).includes(bucket), retention);
  }
  assert.equal(BUCKET_FOR_RETENTION.subject_owned, "subject-artifacts");
  assert.equal(BUCKET_FOR_RETENTION.system_immutable, "system-artifacts");
  assert.equal(BUCKET_FOR_RETENTION.temporary, "exports");
  // There is no public bucket to select.
  assert.equal(BUCKETS.length, 3);
  return "4 retention classes over 3 private buckets; none public";
});

check("a signed URL is short-lived and cannot be extended indefinitely", () => {
  assert.equal(downloadTtlSeconds(), DOWNLOAD_URL_TTL_SECONDS);
  assert.equal(downloadTtlSeconds(0), DOWNLOAD_URL_TTL_SECONDS);
  assert.equal(downloadTtlSeconds(-5), DOWNLOAD_URL_TTL_SECONDS);
  assert.equal(downloadTtlSeconds(60), 60);
  assert.equal(downloadTtlSeconds(86_400), MAX_DOWNLOAD_URL_TTL_SECONDS);
  return `default ${DOWNLOAD_URL_TTL_SECONDS}s, capped at ${MAX_DOWNLOAD_URL_TTL_SECONDS}s`;
});

check("only the owning subject may be handed a body", () => {
  const artifact = {
    state: "ready" as ArtifactState,
    ownerSubjectId: "subject-a",
    retentionClass: "subject_owned" as const,
  };
  assert.equal(mayDownload(artifact, ["subject-a"]), true);
  assert.equal(mayDownload(artifact, ["subject-b"]), false);
  assert.equal(mayDownload(artifact, []), false);
  // A pending body is not downloadable even by its owner.
  assert.equal(mayDownload({ ...artifact, state: "pending" }, ["subject-a"]), false);
  assert.equal(mayDownload({ ...artifact, state: "failed" }, ["subject-a"]), false);
  assert.equal(mayDownload({ ...artifact, state: "deleted" }, ["subject-a"]), false);
  // A subject-owned artifact with no owner is reachable by nobody.
  assert.equal(mayDownload({ ...artifact, ownerSubjectId: null }, ["subject-a"]), false);
  return "non-owner, empty actor, unverified and deleted all refuse";
});

check("a system artifact is readable without owning a subject", () => {
  const asset = {
    state: "ready" as ArtifactState,
    ownerSubjectId: null,
    retentionClass: "system_immutable" as const,
  };
  assert.equal(mayDownload(asset, []), true);
  assert.equal(mayDownload({ ...asset, state: "pending" }, []), false);
  return "catalogues are not anyone's data, but still must be ready";
});

check("the janitor sweeps abandoned bodies, never live ones", () => {
  const fresh = new Date(NOW.getTime() - 60 * 1000);
  const old = new Date(NOW.getTime() - 7 * 60 * 60 * 1000);
  assert.equal(isSweepable("pending", fresh, NOW), false);
  assert.equal(isSweepable("pending", old, NOW), true);
  assert.equal(isSweepable("failed", fresh, NOW), true);
  // A ready or deleted artifact is never swept by age.
  assert.equal(isSweepable("ready", old, NOW), false);
  assert.equal(isSweepable("deleted", old, NOW), false);
  return "pending only past its grace period; ready never";
});

check("a checksum is recognised only in the shape it is stored", () => {
  assert.equal(isSha256(HASH), true);
  assert.equal(isSha256(HASH.toUpperCase()), true);
  assert.equal(isSha256("abc"), false);
  assert.equal(isSha256(`${HASH}00`), false);
  assert.equal(sha256Of("a body"), sha256Of(new TextEncoder().encode("a body")));
  return "64 hex, case-insensitive; string and bytes agree";
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
}

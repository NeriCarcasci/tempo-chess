/**
 * `npm run identity:unit` — the E06 rules that do not need a database.
 *
 * These are the epic's acceptance criteria expressed as assertions: two users
 * may hold the same identity, verification truth is never demoted, and a hidden
 * profile never appears in a lookup. Deterministic and offline.
 */

import { strict as assert } from "node:assert";
import {
  CONFIRMATION_METHODS,
  CONNECTION_KINDS,
  LINK_STATUSES,
  PROVIDER_IDS,
  PROVIDER_SLUGS,
  SUBJECT_KINDS,
  VERIFICATION_STATUSES,
  isLiveLink,
  isPlausibleHandle,
  isProviderSlug,
  mayActOnLinkedAccount,
  mayActOnSubject,
  mayReplaceVerification,
  normalizeHandle,
  projectPublicProfile,
  type PublicProfileRow,
  type VerificationStatus,
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

const PROFILE: PublicProfileRow = {
  userId: "u1",
  personalSubjectId: "s1",
  handle: "magnus",
  displayName: "Magnus",
  avatarUrl: null,
  isDiscoverable: true,
  showProviderHandles: false,
  providerHandles: [{ provider: "lichess", handle: "DrNykterstein" }],
};

console.log("cd server && npm run identity:unit\n");

check("a hidden profile never appears in a lookup", () => {
  assert.equal(projectPublicProfile({ ...PROFILE, isDiscoverable: false }), null);
  assert.notEqual(projectPublicProfile(PROFILE), null);
  return "not discoverable projects to null, not to an empty husk";
});

check("provider handles need their own opt-in", () => {
  const hidden = projectPublicProfile(PROFILE)!;
  assert.deepEqual(hidden.providerHandles, []);
  const shown = projectPublicProfile({ ...PROFILE, showProviderHandles: true })!;
  assert.equal(shown.providerHandles.length, 1);
  assert.equal(shown.providerHandles[0].handle, "DrNykterstein");
  return "discoverable alone publishes no provider handle";
});

check("the public projection carries nothing private", () => {
  const projection = projectPublicProfile({ ...PROFILE, showProviderHandles: true })!;
  const keys = Object.keys(projection).sort();
  assert.deepEqual(keys, ["avatarUrl", "displayName", "handle", "providerHandles"]);
  const serialized = JSON.stringify(projection);
  for (const leaked of ["u1", "s1", "@", "email"]) {
    assert.equal(serialized.includes(leaked), false, `projection leaked ${leaked}`);
  }
  return "4 keys; no user id, subject id or email";
});

check("a handle folds to a lookup key without merging different players", () => {
  assert.equal(normalizeHandle("  MagnusCarlsen "), "magnuscarlsen");
  assert.equal(normalizeHandle("MAGNUS"), normalizeHandle("magnus"));
  // Punctuation is significant: these are two different accounts.
  assert.notEqual(normalizeHandle("dr-nykterstein"), normalizeHandle("drnykterstein"));
  return "case and whitespace folded; punctuation preserved";
});

check("an implausible handle is refused before any provider call", () => {
  for (const bad of ["", "a", " ", "a".repeat(65), "has space", "drop;table", "e@mail"]) {
    assert.equal(isPlausibleHandle(bad), false, `accepted ${JSON.stringify(bad)}`);
  }
  for (const good of ["ab", "Magnus_Carlsen", "dr-nykterstein", "a".repeat(64)]) {
    assert.equal(isPlausibleHandle(good), true, `rejected ${good}`);
  }
  return "6 rejected, 4 accepted";
});

check("a paused link still counts as a claim; only disconnected stops", () => {
  assert.equal(isLiveLink("active"), true);
  assert.equal(isLiveLink("paused"), true);
  assert.equal(isLiveLink("disconnected"), false);
  return "matches the partial unique index in 0016";
});

check("verification truth is never demoted", () => {
  assert.equal(mayReplaceVerification("unverified", "confirmed"), true);
  assert.equal(mayReplaceVerification("confirmed", "verified"), true);
  // The case that matters: a routine re-lookup must not undo OAuth.
  assert.equal(mayReplaceVerification("verified", "confirmed"), false);
  assert.equal(mayReplaceVerification("verified", "unverified"), false);
  assert.equal(mayReplaceVerification("confirmed", "confirmed"), false);
  return "a weaker observation never overwrites a stronger one";
});

check("a revoked link is only cleared by explicit re-verification", () => {
  assert.equal(mayReplaceVerification("revoked", "confirmed"), false);
  assert.equal(mayReplaceVerification("revoked", "unverified"), false);
  assert.equal(mayReplaceVerification("revoked", "verified"), true);
  assert.equal(mayReplaceVerification("failed", "confirmed"), false);
  return "revoked and failed survive a routine re-lookup";
});

check("an actor may act only on what it owns", () => {
  assert.equal(mayActOnSubject("u1", { ownerUserId: "u1" }), true);
  assert.equal(mayActOnSubject("u1", { ownerUserId: "u2" }), false);
  // The cross-user case this epic exists for: same identity, different owners.
  assert.equal(mayActOnLinkedAccount("u1", { ownerUserId: "u1" }), true);
  assert.equal(mayActOnLinkedAccount("u2", { ownerUserId: "u1" }), false);
  // An editorial subject has no owner and belongs to nobody.
  assert.equal(mayActOnSubject("u1", { ownerUserId: null }), false);
  assert.equal(mayActOnSubject(null, { ownerUserId: "u1" }), false);
  return "non-owner, ownerless and anonymous all denied";
});

check("the vocabularies match the check constraints in 0016", () => {
  assert.deepEqual([...SUBJECT_KINDS], ["personal", "editorial", "case_study"]);
  assert.deepEqual([...CONNECTION_KINDS], ["public_lookup", "oauth"]);
  assert.deepEqual([...LINK_STATUSES], ["active", "paused", "disconnected"]);
  assert.deepEqual(
    [...CONFIRMATION_METHODS],
    ["owner_declared", "oauth_verified", "admin_reviewed"],
  );
  const ranked = VERIFICATION_STATUSES.every(
    (status) => mayReplaceVerification(status, status) === false,
  );
  assert.equal(ranked, true, "a status replaced itself");
  return `${SUBJECT_KINDS.length} kinds, ${LINK_STATUSES.length} statuses, ${VERIFICATION_STATUSES.length} verification states`;
});

check("provider slugs and ids agree", () => {
  for (const slug of PROVIDER_SLUGS) {
    assert.equal(isProviderSlug(slug), true);
    assert.equal(typeof PROVIDER_IDS[slug], "number");
  }
  assert.equal(isProviderSlug("chess24"), false);
  assert.equal(PROVIDER_IDS.chesscom, 1);
  assert.equal(PROVIDER_IDS.lichess, 2);
  return "chesscom=1 lichess=2; an unknown slug is refused";
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
}

/**
 * `npm run backfill:unit` — the reconciliation and cutover decisions.
 *
 * These two functions decide whether the whole dataset may switch to canonical
 * reads, and until now nothing defended them. The asymmetry in `compareCounts`
 * is the case a later edit inverts silently, so it is asserted in both
 * directions, and `cutoverBlockers` is exercised for states the live database
 * does not currently hold — including the one where the gate finally passes.
 */

import { strict as assert } from "node:assert";
import { compareCounts, cutoverBlockers } from "./legacy.js";

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

const category = (key: string) => key.split(":")[1] ?? "unknown";

console.log("cd server && npm run backfill:unit\n");

check("equal counts are neither a mismatch nor ahead", () => {
  const result = compareCounts(
    [{ key: "u1:lichess", n: 10 }],
    [{ key: "u1:lichess", n: 10 }],
    category,
  );
  assert.deepEqual(result.mismatches, []);
  assert.equal(result.ahead, 0);
  return "0 mismatches, 0 ahead";
});

check("fewer canonical rows than legacy is loss, and is a mismatch", () => {
  const result = compareCounts(
    [{ key: "u1:lichess", n: 10 }],
    [{ key: "u1:lichess", n: 9 }],
    category,
  );
  assert.deepEqual(result.mismatches, ["missing_canonical:lichess"]);
  assert.equal(result.ahead, 0);
  return "9 of 10 carried -> missing_canonical:lichess";
});

check("a legacy row with no canonical counterpart at all is loss", () => {
  const result = compareCounts([{ key: "u1:chesscom", n: 4 }], [], category);
  assert.deepEqual(result.mismatches, ["missing_canonical:chesscom"]);
  return "absent target counts as zero, not as skipped";
});

check("more canonical rows than legacy is progress, not a mismatch", () => {
  // This is the case that made the gate wrong: 5 synced games were never in
  // the legacy table, and calling that a mismatch keeps the gate red for the
  // very reason it should eventually go green.
  const result = compareCounts(
    [{ key: "u1:lichess", n: 342 }],
    [{ key: "u1:lichess", n: 347 }],
    category,
  );
  assert.deepEqual(result.mismatches, []);
  assert.equal(result.ahead, 5);
  return "347 vs 342 -> 0 mismatches, ahead 5";
});

check("loss and progress are counted independently across owners", () => {
  const result = compareCounts(
    [
      { key: "u1:lichess", n: 10 },
      { key: "u2:chesscom", n: 20 },
    ],
    [
      { key: "u1:lichess", n: 12 },
      { key: "u2:chesscom", n: 18 },
    ],
    category,
  );
  assert.deepEqual(result.mismatches, ["missing_canonical:chesscom"]);
  assert.equal(result.ahead, 2);
  return "one owner ahead by 2, another short -> both recorded";
});

check("a mismatch names a category and never an owner", () => {
  const result = compareCounts(
    [{ key: "0f505557-34c9-4927-bf2b-6d1236fbe085:lichess", n: 5 }],
    [],
    category,
  );
  const serialized = JSON.stringify(result.mismatches);
  assert.equal(serialized.includes("0f505557"), false, "an owner id leaked into a mismatch");
  assert.equal(serialized.includes("lichess"), true);
  return "category only";
});

check("the gate refuses while any canonical game lacks a replay", () => {
  const blockers = cutoverBlockers({
    legacyGames: 342,
    canonicalSubjectGames: 347,
    canonicalGamesWithReplay: 5,
    mismatchCount: 0,
  });
  assert.equal(blockers.length, 1);
  assert.match(blockers[0], /342 canonical games have no replay revision/);
  return blockers[0].slice(0, 60) + "...";
});

check("the gate refuses when canonical is behind legacy", () => {
  const blockers = cutoverBlockers({
    legacyGames: 342,
    canonicalSubjectGames: 300,
    canonicalGamesWithReplay: 300,
    mismatchCount: 0,
  });
  assert.equal(blockers.length, 1);
  assert.match(blockers[0], /only 300 of 342/);
  return blockers[0];
});

check("the gate refuses on an unresolved mismatch even when everything else is ready", () => {
  const blockers = cutoverBlockers({
    legacyGames: 342,
    canonicalSubjectGames: 342,
    canonicalGamesWithReplay: 342,
    mismatchCount: 3,
  });
  assert.deepEqual(blockers, ["3 reconciliation mismatches are unresolved"]);
  return "one blocker, naming the count";
});

check("the gate passes only when everything is carried, replayed and reconciled", () => {
  // The state this epic cannot currently reach. Asserting it means the gate is
  // capable of going green rather than being a permanent refusal.
  const blockers = cutoverBlockers({
    legacyGames: 342,
    canonicalSubjectGames: 347,
    canonicalGamesWithReplay: 347,
    mismatchCount: 0,
  });
  assert.deepEqual(blockers, []);
  return "no blockers when every canonical game has a replay";
});

check("a gate with nothing to migrate is not blocked", () => {
  const blockers = cutoverBlockers({
    legacyGames: 0,
    canonicalSubjectGames: 0,
    canonicalGamesWithReplay: 0,
    mismatchCount: 0,
  });
  assert.deepEqual(blockers, []);
  return "an empty legacy set does not manufacture a blocker";
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
}

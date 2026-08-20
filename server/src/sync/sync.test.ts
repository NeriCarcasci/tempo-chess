/**
 * `npm run sync:unit` — normalization and rejection, offline.
 *
 * The rejection rules run before persistence, so they are provable without a
 * database or a provider. These are the epic's acceptance criteria about what
 * never reaches a row.
 */

import { strict as assert } from "node:assert";
import {
  REJECTION_REASONS,
  SYNC_MODES,
  normalizeGame,
  replayDigest,
  subjectColor,
  tallyRejections,
  type ProviderGameInput,
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

const GAME: ProviderGameInput = {
  providerGameId: "abc123",
  variant: "standard",
  status: "mate",
  winner: "white",
  moves: [
    { uci: "e2e4", san: "e4", clockMs: 60_000 },
    { uci: "e7e5", san: "e5", clockMs: 59_000 },
  ],
  playedAt: "2026-08-18T10:00:00Z",
  rated: true,
  white: { username: "Magnus", rating: 2800 },
  black: { username: "Hikaru", rating: 2790 },
};

console.log("cd server && npm run sync:unit\n");

check("a standard finished game is accepted and hashed", () => {
  const outcome = normalizeGame(GAME);
  assert.equal(outcome.accepted, true);
  if (!outcome.accepted) throw new Error("unreachable");
  assert.equal(outcome.game.plyCount, 2);
  assert.equal(outcome.game.result, "white");
  assert.match(outcome.game.normalizedSha256, /^[0-9a-f]{64}$/);
  return `2 ply, result white, sha ${outcome.game.normalizedSha256.slice(0, 8)}`;
});

check("a variant never reaches a row", () => {
  for (const variant of ["chess960", "atomic", "crazyhouse", "horde", "racingKings"]) {
    const outcome = normalizeGame({ ...GAME, variant });
    assert.equal(outcome.accepted, false, variant);
    if (!outcome.accepted) assert.equal(outcome.reason, "non_standard_variant");
  }
  // Absence means standard, and both providers spell it differently.
  for (const ok of [null, undefined, "standard", "Standard", "fromPosition"]) {
    assert.equal(normalizeGame({ ...GAME, variant: ok }).accepted, true, String(ok));
  }
  return "5 variants refused; absent, standard and fromPosition accepted";
});

check("an unfinished game never reaches a row", () => {
  for (const status of ["started", "created", "aborted", "ongoing"]) {
    const outcome = normalizeGame({ ...GAME, status });
    assert.equal(outcome.accepted, false, status);
    if (!outcome.accepted) assert.equal(outcome.reason, "not_finished");
  }
  // A provider that reports no winner at all is unfinished, not a draw.
  const noWinner = normalizeGame({ ...GAME, winner: undefined });
  assert.equal(noWinner.accepted, false);
  if (!noWinner.accepted) assert.equal(noWinner.reason, "not_finished");
  return "4 statuses and an absent winner all refused";
});

check("a draw is a null winner, not a missing one", () => {
  const outcome = normalizeGame({ ...GAME, winner: null });
  assert.equal(outcome.accepted, true);
  if (!outcome.accepted) throw new Error("unreachable");
  assert.equal(outcome.game.result, "draw");
  assert.deepEqual(
    outcome.game.participants.map((p) => p.outcome),
    ["draw", "draw"],
  );
  return "null winner is a draw; both participants draw";
});

check("an empty replay never reaches a row", () => {
  const outcome = normalizeGame({ ...GAME, moves: [] });
  assert.equal(outcome.accepted, false);
  if (!outcome.accepted) assert.equal(outcome.reason, "empty_replay");
  return "refused";
});

check("an unknown clock stays null rather than becoming zero", () => {
  const outcome = normalizeGame({
    ...GAME,
    moves: [{ uci: "e2e4", san: "e4" }, { uci: "e7e5", san: "e5", clockMs: null }],
  });
  assert.equal(outcome.accepted, true);
  if (!outcome.accepted) throw new Error("unreachable");
  assert.deepEqual(
    outcome.game.normalizedReplay.moves.map((m) => m.clockMs),
    [null, null],
  );
  // A missing rating is null too, never 0.
  const noRating = normalizeGame({ ...GAME, white: { username: "x" } });
  if (noRating.accepted) {
    assert.equal(noRating.game.participants[0].rating, null);
  }
  return "absent clocks and ratings stay null";
});

check("the digest ignores what changes without the game changing", () => {
  const base = normalizeGame(GAME);
  const reRated = normalizeGame({
    ...GAME,
    white: { username: "Magnus", rating: 2810 },
    rated: false,
  });
  assert.equal(base.accepted && reRated.accepted, true);
  if (!base.accepted || !reRated.accepted) throw new Error("unreachable");
  // A re-fetch with a different rating snapshot is the same replay.
  assert.equal(base.game.normalizedSha256, reRated.game.normalizedSha256);
  // A different move list is a different replay.
  const different = normalizeGame({
    ...GAME,
    moves: [...GAME.moves, { uci: "g1f3", san: "Nf3" }],
  });
  if (!different.accepted) throw new Error("unreachable");
  assert.notEqual(base.game.normalizedSha256, different.game.normalizedSha256);
  return "ratings do not change the digest; moves do";
});

check("the result is part of the digest", () => {
  const white = replayDigest({ moves: [{ uci: "e2e4", san: null, clockMs: null }] }, "white");
  const black = replayDigest({ moves: [{ uci: "e2e4", san: null, clockMs: null }] }, "black");
  assert.notEqual(white, black);
  return "a corrected result produces a new digest, so it appends a revision";
});

check("both colours matching is ambiguous, not a guess", () => {
  const outcome = normalizeGame(GAME);
  if (!outcome.accepted) throw new Error("unreachable");
  assert.equal(subjectColor(outcome.game, ["magnus"]), "white");
  assert.equal(subjectColor(outcome.game, ["hikaru"]), "black");
  assert.equal(subjectColor(outcome.game, ["MAGNUS"]), "white");
  // Same subject on both sides: refuse to pick.
  assert.equal(subjectColor(outcome.game, ["magnus", "hikaru"]), null);
  assert.equal(subjectColor(outcome.game, ["someone-else"]), null);
  return "case-insensitive; both sides matching yields null";
});

check("rejections aggregate to counts and nothing else", () => {
  const summary = tallyRejections([
    "non_standard_variant",
    "non_standard_variant",
    "not_finished",
  ]);
  assert.deepEqual(summary, { non_standard_variant: 2, not_finished: 1 });
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes("abc123"), false);
  for (const reason of REJECTION_REASONS) assert.equal(typeof reason, "string");
  return `${Object.keys(summary).length} reasons, ${REJECTION_REASONS.length} in the closed set, no game id`;
});

check("the sync modes match the check constraint in 0019", () => {
  assert.deepEqual([...SYNC_MODES], ["initial", "incremental", "reconcile"]);
  return "initial, incremental, reconcile";
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
}

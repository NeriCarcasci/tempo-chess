/**
 * The claims `/v1/games/recent` makes about its own body.
 *
 * The query itself needs a real Postgres and belongs to an integration gate.
 * What is here is the shaping and the freshness marker, which is where this
 * endpoint can quietly start lying: a replay the driver handed over as text
 * rendered as a game with no moves, a standard opening presented as a custom
 * position, or an `asOf` that moves on its own and turns every ETag into a miss.
 *
 * Run with: node --test --import tsx src/analysis/recent-games.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import { INITIAL_FEN } from "chessops/fen";
import { computeEtag } from "../v1/etag.js";
import {
  asOfOf,
  initialFenOf,
  movesOf,
  shapeRecentGame,
  shapeRecentGames,
  type RecentGameRow,
} from "./recent-games.js";

const REPLAY = {
  moves: [
    { uci: "e2e4", san: "e4", clockMs: 180_000 },
    { uci: "e7e5", san: "e5", clockMs: 179_100 },
    { uci: "g1f3", san: "Nf3", clockMs: null },
  ],
};

function row(overrides: Partial<RecentGameRow> = {}): RecentGameRow {
  return {
    id: "3f1d0c9e-0000-4000-8000-000000000001",
    subject_color: "white",
    updated_at: "2026-08-18 09:15:00.5+00",
    played_at: "2026-08-17 20:11:03.71+00",
    speed: "blitz",
    result: "white",
    outcome: "win",
    opponent_username: "kasparov",
    opponent_title: "GM",
    opponent_rating: 2812,
    provider_url: "https://lichess.org/abcd1234",
    initial_fen: null,
    normalized_replay: REPLAY,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Moves

test("a parsed jsonb replay becomes the move list verbatim", () => {
  assert.deepEqual(movesOf(REPLAY), [
    { uci: "e2e4", san: "e4", clockMs: 180_000 },
    { uci: "e7e5", san: "e5", clockMs: 179_100 },
    { uci: "g1f3", san: "Nf3", clockMs: null },
  ]);
});

test("a replay handed over as text is read, not dropped", () => {
  // drizzle rewrites parsers on the shared connection, so which of these two
  // shapes arrives is not a property this module gets to assume.
  assert.deepEqual(movesOf(JSON.stringify(REPLAY)), movesOf(REPLAY));
});

test("an unparsable or empty replay is no moves rather than a throw", () => {
  for (const value of [null, undefined, "", "{oops", 7, {}, { moves: null }]) {
    assert.deepEqual(movesOf(value), [], `for ${JSON.stringify(value) ?? "undefined"}`);
  }
});

test("a move with no uci is dropped, because it cannot be applied to a board", () => {
  const moves = movesOf({ moves: [{ uci: "e2e4" }, { san: "e5" }, { uci: "", san: "??" }] });
  assert.deepEqual(moves, [{ uci: "e2e4", san: null, clockMs: null }]);
});

test("a missing san stays null instead of becoming an empty caption", () => {
  assert.deepEqual(movesOf({ moves: [{ uci: "e2e4", san: "" }] }), [
    { uci: "e2e4", san: null, clockMs: null },
  ]);
});

test("an unknown clock stays null, never zero", () => {
  const moves = movesOf({ moves: [{ uci: "e2e4" }, { uci: "e7e5", clockMs: 0 }] });
  assert.equal(moves[0].clockMs, null, "no clock reported");
  assert.equal(moves[1].clockMs, 0, "a reported zero is a flag, not an absence");
});

// ---------------------------------------------------------------------------
// Initial position

test("every spelling of the standard start collapses to null", () => {
  for (const value of [null, undefined, "", "   ", "startpos", INITIAL_FEN, ` ${INITIAL_FEN} `]) {
    assert.equal(initialFenOf(value), null, `for ${JSON.stringify(value) ?? "undefined"}`);
  }
});

test("a genuinely non-standard start survives", () => {
  const fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1";
  assert.equal(initialFenOf(fen), fen);
});

// ---------------------------------------------------------------------------
// Shaping

test("a row becomes the wire shape, with timestamps as ISO instants", () => {
  const view = shapeRecentGame(row());
  assert.deepEqual(view, {
    id: "3f1d0c9e-0000-4000-8000-000000000001",
    // Not `String(played_at)`: the driver's own text format is not ISO 8601.
    playedAt: "2026-08-17T20:11:03.710Z",
    speed: "blitz",
    result: "white",
    color: "white",
    outcome: "win",
    opponent: { username: "kasparov", title: "GM", rating: 2812 },
    providerUrl: "https://lichess.org/abcd1234",
    initialFen: null,
    moves: movesOf(REPLAY),
  });
});

test("a Date from the driver shapes the same as the text it may arrive as", () => {
  const asText = shapeRecentGame(row());
  const asDate = shapeRecentGame(row({ played_at: new Date("2026-08-17T20:11:03.710Z") }));
  assert.equal(asDate.playedAt, asText.playedAt);
});

test("a game whose sides could not be attributed keeps its board and loses its labels", () => {
  const view = shapeRecentGame(
    row({ subject_color: null, outcome: null, opponent_username: null, opponent_title: null, opponent_rating: null }),
  );
  assert.equal(view.color, null);
  assert.equal(view.outcome, null);
  assert.equal(view.opponent.username, null);
  assert.equal(view.moves.length, 3, "the game is still animatable");
});

test("the outcome is the stored one, not one re-derived from the result", () => {
  // If this ever starts recomputing, a disagreement between the participant row
  // and the absolute result would be silently papered over instead of showing.
  const view = shapeRecentGame(row({ subject_color: "black", result: "white", outcome: "loss" }));
  assert.equal(view.outcome, "loss");
  assert.equal(view.result, "white");
});

test("a played_at that is null throws rather than shipping a made-up instant", () => {
  assert.throws(() => shapeRecentGame(row({ played_at: null })), /played_at/);
});

// ---------------------------------------------------------------------------
// asOf and the ETag

test("asOf is the newest updated_at in the answer", () => {
  const asOf = asOfOf([
    row({ updated_at: "2026-08-18 09:15:00.5+00" }),
    row({ updated_at: "2026-08-19 11:00:00+00" }),
    row({ updated_at: "2026-08-01 00:00:00+00" }),
  ]);
  assert.equal(asOf, "2026-08-19T11:00:00.000Z");
});

test("an empty answer has no asOf rather than a clock reading", () => {
  assert.deepEqual(shapeRecentGames([]), { asOf: null, games: [] });
});

test("a null updated_at does not become now()", () => {
  assert.equal(asOfOf([row({ updated_at: null })]), null);
  assert.equal(asOfOf([row({ updated_at: null }), row({ updated_at: "2026-08-18T09:15:00Z" })]),
    "2026-08-18T09:15:00.000Z");
});

test("the same rows shaped twice produce the same ETag", () => {
  // The bug this pins: a generated-at timestamp in the body made every ETag
  // differ, so `If-None-Match` never matched and a poll re-sent every move of
  // every game. `asOf` comes from the rows, so nothing here moves on its own.
  const rows = [row(), row({ id: "3f1d0c9e-0000-4000-8000-000000000002" })];
  const first = computeEtag({ data: shapeRecentGames(rows), meta: { requestId: "req-1" } });
  const second = computeEtag({ data: shapeRecentGames(rows), meta: { requestId: "req-2" } });
  assert.equal(first, second, "the request id must not reach the tag");
});

test("a sync that touches a game changes the ETag", () => {
  const before = [row()];
  const after = [row({ updated_at: "2026-08-19 11:00:00+00" })];
  assert.notEqual(
    computeEtag({ data: shapeRecentGames(before), meta: { requestId: "req-1" } }),
    computeEtag({ data: shapeRecentGames(after), meta: { requestId: "req-1" } }),
  );
});

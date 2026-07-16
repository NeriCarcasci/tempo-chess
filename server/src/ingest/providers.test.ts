import assert from "node:assert/strict";
import { fetchLichessGames, normalizeLichessGame, type LichessGamePayload } from "./lichess.js";
import { normalizeChesscomGame, type ChesscomGamePayload } from "./chesscom.js";

const playedAt = new Date("2026-07-01T12:00:00.000Z");
const fetchedAt = new Date("2026-07-16T12:00:00.000Z");
// Lichess's real user-games NDJSON payload emits SAN in the `moves` string.
const lichessMoves = "e4 e5 Nf3 Nc6 Bb5 a6";
const pgn = `[Event "Live Chess"]
[White "Alice"]
[Black "Bob"]
[ECO "C60"]
[Opening "Ruy Lopez"]

1. e4 {[%clk 0:09:59]} e5 {[%clk 0:09:58]} 2. Nf3 {[%clk 0:09:57]} Nc6 {[%clk 0:09:56]} 3. Bb5 {[%clk 0:09:55]} a6 {[%clk 0:09:54]} 1-0`;

const lichessPayload: LichessGamePayload = {
  id: "abc123",
  variant: "standard",
  speed: "rapid",
  createdAt: playedAt.getTime(),
  status: "resign",
  winner: "white",
  players: {
    white: { user: { name: "Alice", id: "alice" }, rating: 1600, analysis: { accuracy: 91.2 } },
    black: { user: { name: "Bob", id: "bob" }, rating: 1580, analysis: { accuracy: 82.5 } },
  },
  opening: { eco: "C60", name: "Ruy Lopez", ply: 5 },
  clock: { initial: 600, increment: 5 },
  moves: lichessMoves,
  clocks: [59_900, 59_800, 59_700, 59_600, 59_500, 59_400],
  analysis: [{ eval: 20 }, { eval: 15 }, { eval: 28, best: "g1f3" }, {}, {}, { mate: -4 }],
  division: { middle: 5, end: 6 },
  pgn,
};

const chesscomPayload: ChesscomGamePayload = {
  url: "https://www.chess.com/game/live/987654",
  pgn,
  time_control: "600+5",
  end_time: playedAt.getTime() / 1000,
  time_class: "rapid",
  rules: "chess",
  eco: "https://www.chess.com/openings/Ruy-Lopez",
  white: { username: "Alice", rating: 1600, result: "win", uuid: "alice-uuid" },
  black: { username: "Bob", rating: 1580, result: "resigned", uuid: "bob-uuid" },
  accuracies: { white: 90.1, black: 81.4 },
};

const lichess = normalizeLichessGame(lichessPayload, "ALICE", fetchedAt);
const chesscom = normalizeChesscomGame(chesscomPayload, "alice", fetchedAt);

assert.deepEqual(
  lichess.moves.map(({ ply, san, uci, fenBefore, fenAfter }) => ({ ply, san, uci, fenBefore, fenAfter })),
  chesscom.moves.map(({ ply, san, uci, fenBefore, fenAfter }) => ({ ply, san, uci, fenBefore, fenAfter })),
);
assert.equal(lichess.pgnFingerprint, chesscom.pgnFingerprint);
assert.deepEqual(lichess.providerAccuracy, { white: 91.2, black: 82.5 });
assert.deepEqual(chesscom.providerAccuracy, { white: 90.1, black: 81.4 });
assert.equal(lichess.moves[0].clockMs, 599_000);
assert.equal(chesscom.moves[0].clockMs, 599_000);
assert.equal(lichess.moves[0].thinkTimeMs, 6_000);
assert.equal(chesscom.moves[0].thinkTimeMs, 6_000);
assert.equal(lichess.moves[0].providerEvaluation?.centipawns, 20);
assert.equal(lichess.moves[5].providerEvaluation?.mate, -4);
assert.equal(chesscom.moves[0].providerEvaluation, null);
assert.equal(lichess.moves[4].annotations.raw.providerPhase, "middlegame");
assert.equal(lichess.moves[5].annotations.raw.providerPhase, "endgame");
assert.match(lichess.canonicalGameId, /lichess/);
assert.match(chesscom.canonicalGameId, /chesscom/);

// NDJSON is intentionally split inside records and includes a malformed line;
// the stream must yield valid games without buffering the full response.
const encoded = new TextEncoder().encode(`${JSON.stringify(lichessPayload)}\nnot-json\n${JSON.stringify({ ...lichessPayload, id: "def456" })}\n`);
const chunks = [encoded.slice(0, 31), encoded.slice(31, 117), encoded.slice(117)];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response(new ReadableStream({
  pull(controller) {
    const chunk = chunks.shift();
    if (chunk) controller.enqueue(chunk); else controller.close();
  },
}), { status: 200 })) as typeof fetch;
try {
  const streamed = [];
  for await (const game of fetchLichessGames("Alice")) streamed.push(game);
  assert.deepEqual(streamed.map((game) => game.platformGameId), ["abc123", "def456"]);
} finally {
  globalThis.fetch = originalFetch;
}

assert.throws(
  () => normalizeChesscomGame({ ...chesscomPayload, pgn: "malformed" }, "alice", fetchedAt),
  /malformed or empty PGN/,
);
assert.throws(() => normalizeChesscomGame(chesscomPayload, "outsider", fetchedAt), /is not a player/);
assert.throws(() => normalizeLichessGame({ ...lichessPayload, variant: "chess960" }, "alice", fetchedAt), /unsupported variant/);
assert.throws(() => normalizeLichessGame(lichessPayload, "outsider", fetchedAt), /is not a player/);

const blackToMove = normalizeLichessGame({
  ...lichessPayload,
  id: "black-to-move",
  initialFen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1",
  moves: "e5",
  clocks: [59_900],
  analysis: [{ eval: -18 }],
}, "alice", fetchedAt);
assert.equal(blackToMove.moves[0].color, "black");
assert.equal(blackToMove.moves[0].moveNumber, 1);
assert.equal(blackToMove.moves[0].providerEvaluation?.centipawns, -18);

console.log("provider normalization tests passed");

import assert from "node:assert/strict";
import { Chess } from "chess.js";
import { buildBenchmarkCorpus, validateBenchmarkCorpus } from "./corpus.js";

const corpus = buildBenchmarkCorpus();
validateBenchmarkCorpus(corpus);

assert.equal(corpus.length, 120);
assert.equal(new Set(corpus.map((game) => game.id)).size, corpus.length);
assert.equal(
  new Set(corpus.map((game) => game.benchmarkFen)).size,
  corpus.length,
  "every benchmark position must be unique",
);
assert.deepEqual(new Set(corpus.map((game) => game.provider)), new Set(["lichess", "chesscom"]));
assert.deepEqual(new Set(corpus.map((game) => game.phase)), new Set(["opening", "middlegame", "endgame"]));
assert.deepEqual(
  new Set(corpus.map((game) => game.scenario)),
  new Set(["quiet", "tactical", "winning", "losing", "time-pressure"]),
);
assert.deepEqual(
  new Set(corpus.map((game) => game.timeControl)),
  new Set(["bullet", "blitz", "rapid", "classical"]),
);

for (const game of corpus) {
  const replay = new Chess();
  replay.loadPgn(game.pgn);
  assert.ok(replay.history().length > 0, `${game.id} must replay`);
  assert.doesNotThrow(() => new Chess(game.benchmarkFen), `${game.id} benchmark FEN must be legal`);
}

console.log(`PASS benchmark corpus: ${corpus.length} legal, credential-free games`);

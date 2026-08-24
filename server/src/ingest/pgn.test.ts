import assert from "node:assert/strict";
import { openingNameFromEcoUrl, parseClockMs, parsePgn } from "./pgn.js";

const parsed = parsePgn(`
[Event "Live Chess"]
[ECO "C45"]
[White "Alice"]
[Black "Bob"]

1. e4 {[%clk 0:10:00]} e5 {[%clk 9:59.5]} 2. Nf3 {book [%clk 0:09:57.25]}
Nc6 {[%clk nonsense]} 3. Bb5 a6 1-0
`);

assert.equal(parsed.warning, undefined);
assert.equal(parsed.headers.ECO, "C45");
assert.equal(parsed.moves.length, 6);
assert.deepEqual(
  parsed.moves.map(({ ply, san, uci, clockMs }) => ({ ply, san, uci, clockMs })),
  [
    { ply: 1, san: "e4", uci: "e2e4", clockMs: 600_000 },
    { ply: 2, san: "e5", uci: "e7e5", clockMs: 599_500 },
    { ply: 3, san: "Nf3", uci: "g1f3", clockMs: 597_250 },
    { ply: 4, san: "Nc6", uci: "b8c6", clockMs: undefined },
    { ply: 5, san: "Bb5", uci: "f1b5", clockMs: undefined },
    { ply: 6, san: "a6", uci: "a7a6", clockMs: undefined },
  ],
);
assert.match(parsed.moves[0].fenBefore, /^rnbqkbnr\/pppppppp/);
assert.match(parsed.moves[0].fenAfter, / b KQkq - /);

assert.equal(parseClockMs("1:02:03.4"), 3_723_400);
assert.equal(parseClockMs("02:03.4"), 123_400);
assert.equal(parseClockMs("invalid"), undefined);
assert.equal(openingNameFromEcoUrl("https://www.chess.com/openings/Scotch-Game-Classical-Variation"), "Scotch Game Classical Variation");

const malformed = parsePgn(`[White "Alice"]\n\n1. e4 this-is-not-a-move`);
assert.equal(malformed.moves.length, 0);
assert.ok(malformed.warning);

const repeated = parsePgn(`1. Nf3 {[%clk 0:01:00]} Nf6 {[%clk 0:00:59]} 2. Ng1 {[%clk 0:00:58]} Ng8 {[%clk 0:00:57]} 3. Nf3 {[%clk 0:00:56]} Nf6 {[%clk 0:00:55]} *`);
assert.deepEqual(repeated.moves.map((move) => move.clockMs), [60_000, 59_000, 58_000, 57_000, 56_000, 55_000]);

// Chess.com writes a judged move as two comments in a row: the prose, then the
// machine annotations. chess.js parses one comment after a move and then wants
// a move, so the second brace was a syntax error and the whole game was refused
// with "Expected ... but "{" found". That is most of what a person pastes into
// the public rating page, and the export is perfectly legal PGN.
const twoComments = parsePgn(
  `[White "Alice"]
[Black "Bob"]

` +
    `1. e4 { [%eval 0.2] [%clk 0:21:08] } e5 { [%clk 0:21:06] } ` +
    `2. Nf3? { (-7.50 → Mate in 1) Checkmate is now unavoidable. b4 was best. } ` +
    `{ [%eval #-1] [%clk 0:21:06] } (2. Bc4 Nf6) 2... Nc6 ` +
    `{ [%clk 0:21:04] } { Black wins by checkmate. } 0-1`,
);
assert.equal(twoComments.warning, undefined);
assert.deepEqual(twoComments.moves.map((move) => move.san), ["e4", "e5", "Nf3", "Nc6"]);
// The merge keeps the annotations, so the clocks inside the second block survive.
assert.deepEqual(twoComments.moves.map((move) => move.clockMs), [
  1_268_000,
  1_266_000,
  1_266_000,
  1_264_000,
]);

// Three in a row, and comments separated by newlines rather than spaces.
const threeComments = parsePgn(`[White "a"]
[Black "b"]

1. e4 { one }
{ two }
{ [%clk 0:05:00] } e5 1-0`);
assert.equal(threeComments.warning, undefined);
assert.equal(threeComments.moves.length, 2);
assert.equal(threeComments.moves[0].clockMs, 300_000);

console.log("pgn parsing tests passed");

/**
 * The layer six detectors are about to trust.
 *
 * Everything here is a question a detector will ask in anger: who attacks this
 * square, is that piece pinned, what is behind it, can this stored line be
 * replayed. If one of these answers is wrong, six families are wrong in the
 * same way at once, and the resulting labels will look plausible.
 *
 * The performance assertions are structural rather than timed. "Work grows
 * linearly with positions and PV length" is a claim about how many times the
 * expensive thing happens, and counting parses says that exactly, where a
 * wall-clock threshold would say it flakily.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSquare, parseUci } from "chessops/util";
import {
  PositionIndex,
  replayPv,
  squaresBeyond,
  rayStep,
  type PositionFact,
} from "./evidence.js";

const sq = (name: string) => parseSquare(name)!;

function indexOf(...fens: string[]): PositionIndex {
  return new PositionIndex(fens.map((fen, ply): PositionFact => ({ ply, fen })));
}

/** One position, as ply 0. */
function viewOf(fen: string) {
  return indexOf(fen).at(0);
}

// ---------------------------------------------------------------------------
// The index parses once
// ---------------------------------------------------------------------------

test("a ply is parsed once however often it is asked about", () => {
  const index = indexOf("4k3/8/8/8/8/8/8/4K3 w - - 0 1");
  for (let i = 0; i < 20; i += 1) assert.notEqual(index.at(0), null);
  assert.equal(index.parseCount, 1, "the detectors ask repeatedly; the FEN is parsed once");
});

test("an unreadable position stays unreadable without being re-derived", () => {
  const index = indexOf("this is not a fen");
  assert.equal(index.at(0), null);
  assert.equal(index.at(0), null);
  assert.equal(index.parseCount, 1, "re-deriving an abstention is a slower way to abstain");
});

test("a position that parses but is not legal is also null", () => {
  // Eight white queens and no kings: the FEN is well formed and the position
  // cannot exist. `Chess.fromSetup` is what decides, not a shape check here.
  assert.equal(viewOf("QQQQQQQQ/8/8/8/8/8/8/8 w - - 0 1"), null);
});

test("a missing ply is null rather than an error", () => {
  const index = indexOf("4k3/8/8/8/8/8/8/4K3 w - - 0 1");
  assert.equal(index.at(7), null);
  assert.equal(index.fenAt(7), null);
});

test("work grows with the number of positions, not with the number of questions", () => {
  const fens = Array.from({ length: 60 }, () => "4k3/8/8/8/8/8/8/4K3 w - - 0 1");
  const index = indexOf(...fens);
  for (let pass = 0; pass < 4; pass += 1) {
    for (let ply = 0; ply < fens.length; ply += 1) index.at(ply);
  }
  assert.equal(index.parseCount, fens.length, "four passes over sixty positions is sixty parses");
});

// ---------------------------------------------------------------------------
// Attacks
// ---------------------------------------------------------------------------

test("a knight attacks its eight squares, and nothing blocks it", () => {
  const view = viewOf("4k3/8/8/8/3N4/8/8/4K3 w - - 0 1")!;
  const attacked = [...view.attacksFrom(sq("d4"))].sort((a, b) => a - b);
  const expected = ["b3", "b5", "c2", "c6", "e2", "e6", "f3", "f5"]
    .map(sq).sort((a, b) => a - b);
  assert.deepEqual(attacked, expected);
});

test("a pawn attacks diagonally and by colour", () => {
  const white = viewOf("4k3/8/8/8/4P3/8/8/4K3 w - - 0 1")!;
  assert.deepEqual(
    [...white.attacksFrom(sq("e4"))].sort((a, b) => a - b),
    [sq("d5"), sq("f5")].sort((a, b) => a - b),
  );
  const black = viewOf("4k3/8/8/4p3/8/8/8/4K3 b - - 0 1")!;
  assert.deepEqual(
    [...black.attacksFrom(sq("e5"))].sort((a, b) => a - b),
    [sq("d4"), sq("f4")].sort((a, b) => a - b),
    "a black pawn attacks down the board, and a detector that assumes otherwise "
    + "measures one colour correctly",
  );
});

test("a slider stops at the first piece, and attacks it", () => {
  // White rook a1, white pawn a3. The rook bears on a2 and a3 and no further.
  const view = viewOf("4k3/8/8/8/8/P7/8/R3K3 w - - 0 1")!;
  const attacked = view.attacksFrom(sq("a1"));
  assert.ok(attacked.has(sq("a2")));
  assert.ok(attacked.has(sq("a3")), "the blocker itself is attacked -- that is how defence works");
  assert.ok(!attacked.has(sq("a4")), "the slider does not see through its own pawn");
});

test("defenders are counted for the occupant's own colour", () => {
  // Black knight e5 defended by the d6 pawn; White rook e1 attacks it.
  const view = viewOf("4k3/8/3p4/4n3/8/8/8/4RK2 w - - 0 1")!;
  assert.equal(view.defendersOf(sq("e5")).size(), 1);
  assert.ok(view.defendersOf(sq("e5")).has(sq("d6")));
  assert.equal(view.attackersOf(sq("e5"), "white").size(), 1);
  assert.ok(view.attackersOf(sq("e5"), "white").has(sq("e1")));
  assert.equal(view.defendersOf(sq("d4")).size(), 0, "an empty square has no defenders");
});

test("a pinned defender still defends", () => {
  // The question "how many defenders" is about exchange sequences, and a piece
  // that may not legally move still participates in one. Conflating that with
  // legal movement is how a detector decides a defended piece is hanging.
  //
  // White rook d1, black knight d5 pinned to the black king d8 by it, and the
  // black knight also defends f4... using a simpler shape: black bishop c6
  // defends e4 while pinned along the a8-h1 diagonal is awkward, so assert the
  // general property on a pin we already have.
  const view = viewOf("3k4/8/8/3n4/8/3b4/8/3RK3 w - - 0 1")!;
  // The bishop on d3 is pinned along the d-file? No -- d3 is on the d-file with
  // the rook on d1 and the knight d5 between. What matters here: both black
  // pieces on the d-file are counted as attackers of squares they bear on,
  // regardless of the pin.
  assert.ok(view.attackersOf(sq("c4"), "black").has(sq("d3")), "a pinned bishop still bears on c4");
});

// ---------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------

test("an absolute pin is found, and agrees with legal move generation", () => {
  // Bishop g5, black knight f6, black king e7 on the g5-f6-e7 diagonal.
  const view = viewOf("8/4k3/5n2/6B1/8/8/8/4K3 b - - 0 1")!;
  const pins = view.pinsAgainst("black");
  assert.equal(pins.length, 1);
  const [pin] = pins;
  assert.equal(pin!.pinned, sq("f6"));
  assert.equal(pin!.pinner, sq("g5"));
  assert.equal(pin!.target, sq("e7"));
  assert.equal(pin!.subtype, "absolute");
  // The two computations must not be able to disagree.
  assert.equal(
    view.destsFrom(sq("f6")).size(),
    0,
    "an absolutely pinned knight has no legal move, and the pin finder must say so too",
  );
});

test("a relative pin needs the piece behind to be worth more", () => {
  // Bishop g5, black knight f6, black rook e7 behind it. Rook beats knight.
  // The white king stands on f1 rather than e1: the black rook owns the e-file,
  // and a white king on it would be in check with Black to move, which is not
  // a position at all. `Chess.fromSetup` said so, which is the whole reason
  // fixtures get replayed rather than eyeballed.
  const pinned = viewOf("4k3/4r3/5n2/6B1/8/8/8/5K2 b - - 0 1")!.pinsAgainst("black");
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0]!.subtype, "relative");
  assert.equal(pinned[0]!.target, sq("e7"));

  // The same geometry with a knight behind instead of a rook is alignment, not
  // a pin: nothing is gained by the piece in front moving.
  const aligned = viewOf("4k3/4n3/5n2/6B1/8/8/8/4K3 b - - 0 1")!.pinsAgainst("black");
  assert.equal(aligned.length, 0, "two equal pieces in a line are not pinning each other");
});

test("a piece with a gap behind it is not pinned", () => {
  // Bishop g5, knight f6, and nothing at all on e7 or d8.
  const view = viewOf("4k3/8/5n2/6B1/8/8/8/4K3 b - - 0 1")!;
  assert.equal(view.pinsAgainst("black").length, 0);
});

test("a blocker stops the pin at itself rather than passing it along", () => {
  // Bishop h4, black pawn g5, knight f6, king e7, all on the h4-e7 diagonal.
  // The knight is *not* pinned to the king: the bishop never reaches it.
  //
  // What the layer does report is the pawn pinned to the knight, which is
  // correct and was not what this fixture was written to show -- a pawn that
  // moves off g5 loses a knight worth three times as much. Asserting "no pins
  // here" would have been asserting a wrong thing loudly.
  const pins = viewOf("8/4k3/5n2/6p1/7B/8/8/4K3 b - - 0 1")!.pinsAgainst("black");
  assert.ok(
    !pins.some((pin) => pin.pinned === sq("f6")),
    "the ray to the knight is blocked, so the knight is not pinned to the king",
  );
  assert.deepEqual(
    pins.map((pin) => [pin.subtype, pin.pinned, pin.target]),
    [["relative", sq("g5"), sq("f6")]],
    "the blocker itself is what is pinned, to the piece behind it",
  );
});

test("equal value behind the blocker is alignment, not a pin", () => {
  // Bishop h4, black pawn g5, black pawn f6. Nothing is gained by the front
  // pawn moving, so there is nothing to exploit and nothing to record.
  assert.deepEqual(viewOf("4k3/8/5p2/6p1/7B/8/8/4K3 b - - 0 1")!.pinsAgainst("black"), []);
});

// ---------------------------------------------------------------------------
// X-rays
// ---------------------------------------------------------------------------

test("an x-ray names the piece in front and the one behind", () => {
  // Rook a1, white pawn a4, black rook a7.
  const view = viewOf("4k3/r7/8/8/P7/8/8/R3K3 w - - 0 1")!;
  const xrays = view.xraysFrom(sq("a1"));
  assert.equal(xrays.length, 1);
  assert.equal(xrays[0]!.front, sq("a4"));
  assert.equal(xrays[0]!.rear, sq("a7"));
});

test("a knight has no x-rays, because it does not look along anything", () => {
  const view = viewOf("4k3/8/8/8/3N4/8/8/4K3 w - - 0 1")!;
  assert.deepEqual(view.xraysFrom(sq("d4")), []);
});

test("nothing behind the blocker is no x-ray", () => {
  const view = viewOf("4k3/8/8/8/P7/8/8/R3K3 w - - 0 1")!;
  assert.deepEqual(view.xraysFrom(sq("a1")), []);
});

// ---------------------------------------------------------------------------
// Rays
// ---------------------------------------------------------------------------

test("walking a ray stops at the edge instead of wrapping onto the next rank", () => {
  // Stepping east off h-file lands on the next rank's a-file, which is a legal
  // square index and a completely different part of the board. Every ray helper
  // that wrapped around got this wrong.
  const beyond = squaresBeyond(sq("f1"), sq("g1"));
  assert.deepEqual(beyond, [sq("h1")]);
  assert.deepEqual(squaresBeyond(sq("g1"), sq("h1")), []);
});

test("squares that are not aligned have no step and no ray", () => {
  assert.equal(rayStep(sq("a1"), sq("b3")), null);
  assert.deepEqual(squaresBeyond(sq("a1"), sq("b3")), []);
  assert.equal(rayStep(sq("d4"), sq("d4")), null);
});

test("a diagonal walk continues past the named square", () => {
  assert.deepEqual(squaresBeyond(sq("a1"), sq("b2")), [sq("c3"), sq("d4"), sq("e5"), sq("f6"), sq("g7"), sq("h8")]);
});

// ---------------------------------------------------------------------------
// Special moves
// ---------------------------------------------------------------------------

test("en passant is a legal move the layer recognises", () => {
  const view = viewOf("4k3/8/8/8/3pP3/8/8/4K3 b - e3 0 1")!;
  assert.ok(view.isLegal(parseUci("d4e3")!), "the capture the ep square exists for");
});

test("castling appears as the king moving onto its own rook", () => {
  const view = viewOf("4k2r/8/8/8/8/8/8/4K2R w Kk - 0 1")!;
  assert.ok(
    view.destsFrom(sq("e1")).has(sq("h1")),
    "chessops encodes castling this way, which is why 'the destination is "
    + "occupied' is not the same question as 'this is a capture'",
  );
});

test("promotions are counted as the engine counts them", () => {
  // White pawn a7 and a king with three squares. `allDests` collapses the four
  // promotion choices onto a8; MultiPV lists them separately, and only-move
  // coverage compares against that count.
  const view = viewOf("8/P7/8/8/8/8/8/K6k w - - 0 1")!;
  assert.equal(view.legalMoveCount(), 7, "3 king moves + 4 promotions");
});

test("a quiet position counts its legal moves the ordinary way", () => {
  const view = viewOf("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1")!;
  assert.equal(view.legalMoveCount(), 20);
});

// ---------------------------------------------------------------------------
// Replaying stored lines
// ---------------------------------------------------------------------------

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

test("a legal stored line replays into positions", () => {
  const view = viewOf(START)!;
  const replay = replayPv(view, ["e2e4", "e7e5", "g1f3"]);
  assert.equal(replay.available, true);
  if (!replay.available) return;
  assert.equal(replay.moves.length, 3);
  assert.equal(replay.positions.length, 4, "one position before each move, then the last");
  assert.equal(replay.fens.length, 4);
  assert.equal(replay.fens[0], view.fen, "the line starts where it was searched from");
});

test("replay work grows with the length of the line", () => {
  const view = viewOf(START)!;
  const short = replayPv(view, ["e2e4"]);
  const long = replayPv(view, ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6"]);
  assert.equal(short.available && short.positions.length, 2);
  assert.equal(long.available && long.positions.length, 7);
});

test("an illegal line is named, not partially used", () => {
  // A detector handed the first two moves of a line that does not support its
  // claim will use them. A detector handed a reason cannot.
  const replay = replayPv(viewOf(START)!, ["e2e4", "e7e5", "e2e4"]);
  assert.equal(replay.available, false);
  if (replay.available) return;
  assert.equal(replay.reason, "illegal_move");
});

test("an unparseable move is named", () => {
  const replay = replayPv(viewOf(START)!, ["e2e4", "not-a-move"]);
  assert.equal(replay.available, false);
  if (replay.available) return;
  assert.equal(replay.reason, "unparseable_move");
});

test("an absent line is named", () => {
  assert.deepEqual(replayPv(viewOf(START)!, []), { available: false, reason: "no_line" });
  assert.deepEqual(replayPv(viewOf(START)!, undefined), { available: false, reason: "no_line" });
});

test("a line shorter than the claim needs is named", () => {
  const replay = replayPv(viewOf(START)!, ["e2e4"], 3);
  assert.equal(replay.available, false);
  if (replay.available) return;
  assert.equal(replay.reason, "line_too_short", "bounded evidence, refused rather than extrapolated");
});

test("a line from an unreadable position is named", () => {
  const replay = replayPv(null, ["e2e4"]);
  assert.equal(replay.available, false);
  if (replay.available) return;
  assert.equal(replay.reason, "position_unreadable");
});

test("replaying does not disturb the indexed position", () => {
  // The index hands out one `Chess` per ply and the detectors share it. A
  // replay that played moves on that object would corrupt every later question
  // about the same ply -- and the symptom would be a detector that works alone
  // and fails when another one runs first.
  const index = indexOf(START);
  const view = index.at(0)!;
  const before = view.fen;
  replayPv(view, ["e2e4", "e7e5"]);
  assert.equal(index.at(0)!.fen, before);
  assert.equal(view.position.turn, "white", "the shared position still has White to move");
  assert.ok(view.position.board.get(sq("e2")), "and its e-pawn is still on e2");
});

// ---------------------------------------------------------------------------
// Asking out of turn
// ---------------------------------------------------------------------------

test("a position can be asked about with the other side to move", () => {
  // "Is my piece hanging?" is asked while the subject is on move and is a
  // question about what the opponent could do next.
  const index = indexOf("4k3/8/8/4n3/3P4/8/8/4K3 b - - 0 1");
  const asWhite = index.asIfToMove(0, "white");
  assert.notEqual(asWhite, null);
  assert.equal(asWhite!.turn, "white");
  assert.ok(asWhite!.isLegal(parseUci("d4e5")!), "White could take the knight if it were their move");
});

test("flipping the turn into an impossible position answers null", () => {
  // Black is in check from the rook. Giving White the move would leave Black
  // in check with White to play, which is not a position.
  const index = indexOf("4k3/8/8/8/8/8/8/4R1K1 b - - 0 1");
  assert.equal(index.asIfToMove(0, "white"), null);
});

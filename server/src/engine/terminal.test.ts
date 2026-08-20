import assert from "node:assert/strict";
import { test } from "node:test";
import { Chess } from "chessops/chess";
import { parseFen } from "chessops/fen";
import { EXPECTED_SCORE_METHODS, terminalExpectedScore } from "./contract.js";

/** Fool's mate: Black has just mated, White is to move and has no legal move. */
const WHITE_MATED = "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3";
/** The mirror: White has mated, Black is to move. */
const BLACK_MATED = "rnbqkbnr/ppppp2p/5p2/6pQ/4P3/8/PPPP1PPP/RNB1KBNR b KQkq - 1 3";
/** A classic stalemate: Black to move, no legal move, not in check. */
const STALEMATE = "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1";

function board(fen: string) {
  return Chess.fromSetup(parseFen(fen).unwrap()).unwrap();
}

test("the mated side scores zero from its own perspective", () => {
  const white = board(WHITE_MATED);
  assert.equal(white.isCheckmate(), true);
  // White is to move and is mated, so White's expected score is zero.
  assert.deepEqual(terminalExpectedScore("checkmate", "white"), {
    value: 0, method: "terminal", scoreCp: null, mateIn: 0,
  });

  const black = board(BLACK_MATED);
  assert.equal(black.isCheckmate(), true);
  // Black is mated, and the row is stored from White's perspective.
  assert.deepEqual(terminalExpectedScore("checkmate", "black"), {
    value: 1, method: "terminal", scoreCp: null, mateIn: 0,
  });
});

test("a terminal draw is half a point however it was reached", () => {
  const position = board(STALEMATE);
  assert.equal(position.isEnd(), true);
  assert.equal(position.isCheckmate(), false);
  assert.deepEqual(terminalExpectedScore("draw", "black"), {
    value: 0.5, method: "terminal", scoreCp: 0, mateIn: null,
  });
  assert.deepEqual(terminalExpectedScore("draw", "white").value, 0.5);
});

test("exactly one of a centipawn score and a mate distance is set", () => {
  // `position_evaluations_value_check` requires it, so the contract must too.
  for (const outcome of ["checkmate", "draw"] as const) {
    for (const side of ["white", "black"] as const) {
      const decided = terminalExpectedScore(outcome, side);
      assert.equal(
        (decided.scoreCp === null) !== (decided.mateIn === null),
        true,
        `${outcome}/${side} must set exactly one`,
      );
      assert.ok(decided.value >= 0 && decided.value <= 1);
    }
  }
});

test("terminal is a named method, not an anonymous number", () => {
  assert.ok(EXPECTED_SCORE_METHODS.includes("terminal"));
});

/**
 * What the tactical families are allowed to claim.
 *
 * Every test here is about the same distinction: geometry exists on a board all
 * the time, and almost none of it matters. A detector that reports the geometry
 * produces confident labels for positions where nothing happened, and those are
 * worse than no labels because they look checked.
 *
 * The canonical fixtures from FOR-121 are used rather than positions invented
 * next to each detector. A fixture that only exists beside the code it tests is
 * a fixture that agrees with it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Chess } from "chessops/chess";
import { parseFen, makeFen } from "chessops/fen";
import { parseSquare, parseUci } from "chessops/util";
import { detectGame } from "./detect.js";
import { CONCEPT_CATALOGUE } from "./catalogue.js";
import { fixturesFor, type ConceptFixture } from "./fixtures.js";
import { guaranteedGain, legalMoves, MATE_GAIN_CP } from "./tactics.js";
import { PIECE_VALUES } from "../../engine/attacks.js";
import type { GameFacts, PositionFact, TransitionFact } from "./evidence.js";

const sq = (name: string) => parseSquare(name)!;

function play(moves: readonly string[], initial: string): PositionFact[] {
  const board = Chess.fromSetup(parseFen(initial).unwrap()).unwrap();
  const positions: PositionFact[] = [{ ply: 0, fen: makeFen(board.toSetup()) }];
  moves.forEach((uci, index) => {
    board.play(parseUci(uci)!);
    positions.push({ ply: index + 1, fen: makeFen(board.toSetup()) });
  });
  return positions;
}

function transition(over: Partial<TransitionFact> & {
  fromPly: number;
  actorColor: "white" | "black";
  playedMoveUci: string;
}): TransitionFact {
  return {
    bestMoveUci: null,
    playedMoveRank: null,
    playedMoveAcceptable: true,
    onlyMove: null,
    criticality: null,
    acceptableMoveCount: null,
    candidateCount: null,
    expectedScoreBefore: 0.5,
    expectedScoreAfter: 0.5,
    phase: "middlegame",
    ...over,
  };
}

/** A game of the given moves from a position, with the subject named. */
function gameOf(
  initial: string,
  moves: readonly string[],
  subjectColor: "white" | "black",
  over: Partial<GameFacts> = {},
): GameFacts {
  const positions = play(moves, initial);
  const first = Chess.fromSetup(parseFen(initial).unwrap()).unwrap().turn;
  const transitions = moves.map((uci, index) => transition({
    fromPly: index,
    actorColor: index % 2 === 0 ? first : (first === "white" ? "black" : "white"),
    playedMoveUci: uci,
  }));
  return {
    subjectColor,
    speed: "blitz",
    playedAt: new Date("2026-08-01T00:00:00Z"),
    termination: "mate",
    result: subjectColor,
    positions,
    transitions,
    candidatesByPly: new Map(),
    ...over,
  };
}

function fixture(id: string): ConceptFixture {
  const found = fixturesFor(id.split("/")[0]!).find((entry) => entry.id === id);
  assert.ok(found, `no fixture ${id}`);
  return found;
}

function forksIn(game: GameFacts) {
  return detectGame(game).filter((found) => found.conceptSlug === "double_attack");
}

// ---------------------------------------------------------------------------
// The verification primitive
// ---------------------------------------------------------------------------

test("a motif any single reply defuses is not verified", () => {
  // White knight on c7 forking king e8 and rook a8, except a black rook on d7
  // can simply take it. One reply saves everything, so the minimum is zero.
  const position = Chess.fromSetup(parseFen("r3k3/3r4/2N5/8/8/8/8/4K3 b - - 0 1").unwrap()).unwrap();
  assert.equal(guaranteedGain(position, "white").gainCp, 0);
});

test("a fork with check is verified, because check must be answered", () => {
  const position = Chess.fromSetup(parseFen("r3k3/2N5/8/8/8/8/8/4K3 b - - 0 1").unwrap()).unwrap();
  const verdict = guaranteedGain(position, "white");
  assert.equal(verdict.gainCp, PIECE_VALUES.rook, "the rook falls whatever the king does");
  assert.notEqual(verdict.bestDefence, null);
});

test("no legal reply is mate when it is check and nothing when it is not", () => {
  // Back-rank mate: the rook checks along the eighth from a distance the king
  // cannot reach, and its own pawns take away the escape. Put the rook next to
  // the king instead and it is not mate at all -- the king simply takes it,
  // which is what the first attempt at this fixture did.
  const mated = Chess.fromSetup(parseFen("R5k1/5ppp/8/8/8/8/8/6K1 b - - 0 1").unwrap()).unwrap();
  assert.equal(legalMoves(mated).length, 0);
  const verdict = guaranteedGain(mated, "white");
  assert.equal(verdict.mate, true);
  assert.equal(verdict.gainCp, MATE_GAIN_CP);

  // Stalemate is the opposite outcome from the same shape.
  const stalemate = Chess.fromSetup(parseFen("7k/8/6Q1/8/8/8/8/6K1 b - - 0 1").unwrap()).unwrap();
  assert.equal(legalMoves(stalemate).length, 0);
  const drawn = guaranteedGain(stalemate, "white");
  assert.equal(drawn.mate, false);
  assert.equal(drawn.gainCp, 0, "a draw is not material won");
});

test("promotions are expanded, so a defence that needs a knight is found", () => {
  // A defender who can promote has four replies, not one, and they are not
  // interchangeable. Counting one would report a forced loss the defender can
  // actually escape.
  const position = Chess.fromSetup(parseFen("4k3/8/8/8/8/8/6p1/4K3 b - - 0 1").unwrap()).unwrap();
  const promotions = legalMoves(position).filter((move) => "promotion" in move && move.promotion);
  assert.equal(promotions.length, 4, "queen, rook, bishop and knight are four different replies");
  assert.deepEqual(
    [...new Set(promotions.map((move) => move.promotion))].sort(),
    ["bishop", "knight", "queen", "rook"],
  );
});

// ---------------------------------------------------------------------------
// double_attack
// ---------------------------------------------------------------------------

test("a knight fork on king and rook is recorded, with the rook as the payoff", () => {
  const positive = fixture("double_attack/knight-fork-king-rook");
  // Nc7+ Kd7 Nxa8 -- created, answered, collected.
  const found = forksIn(gameOf(positive.fen, ["b5c7", "e8d7", "c7a8"], "white"));
  assert.equal(found.length, 1, "one fork, recorded once");

  const [fork] = found;
  assert.equal(fork!.role, "execute", "the subject created it");
  assert.equal(fork!.event.facts.subtype, "royal_fork");
  assert.equal(fork!.event.facts.kingInvolved, true);
  assert.equal(
    fork!.event.facts.expectedGainCp,
    PIECE_VALUES.rook,
    "the rook, whatever the king does",
  );
  assert.equal(fork!.event.actor, "subject");
  assert.equal(fork!.event.affected, "opponent");
  assert.equal(fork!.draft.success, true, "and they took it");
  assert.equal(fork!.draft.opportunityPly, 0);
  assert.equal(fork!.draft.responsePly, 2, "the follow-up is where execution is judged");
});

test("creating a fork and not collecting it is a failure, not a success", () => {
  // The whole reason `execute` is not scored on the motif existing. A player
  // who finds the fork and then plays something else has done something a rate
  // of "100% of forks played" could never show.
  const positive = fixture("double_attack/knight-fork-king-rook");
  const found = forksIn(gameOf(positive.fen, ["b5c7", "e8d7", "e1e2"], "white"));
  assert.equal(found.length, 1);
  assert.equal(found[0]!.draft.success, false);
});

test("the colour-reversed fork behaves identically", () => {
  const twin = fixture("double_attack/knight-fork-king-rook-black");
  const found = forksIn(gameOf(twin.fen, ["b4c2", "e1d2", "c2a1"], "black"));
  assert.equal(found.length, 1, "a detector that only works for White measures half the players");
  assert.equal(found[0]!.role, "execute");
  assert.equal(found[0]!.event.facts.subtype, "royal_fork");
  assert.equal(found[0]!.draft.success, true);
});

test("one threat is not a double attack", () => {
  const nearMiss = fixture("double_attack/knight-checks-one-target-only");
  assert.deepEqual(forksIn(gameOf(nearMiss.fen, ["b5d6", "e8d8"], "white")), []);
});

test("a fork the defender can simply take is not a fork", () => {
  const refuted = fixture("double_attack/fork-square-is-defended");
  assert.deepEqual(
    forksIn(gameOf(refuted.fen, ["b5c7", "d7c7"], "white")),
    [],
    "the geometry is real and the consequence is not, which is a negative",
  );
});

test("geometry that cannot legally be played never reaches the detector", () => {
  const pinned = fixture("double_attack/forking-knight-is-pinned");
  const position = Chess.fromSetup(parseFen(pinned.fen).unwrap()).unwrap();
  assert.equal(
    position.isLegal(parseUci(pinned.move)!),
    false,
    "a game cannot contain this move, so no fork event can exist for it",
  );
});

test("a fork the opponent creates is measured as a response", () => {
  const positive = fixture("double_attack/knight-fork-king-rook");
  // Same game, but the subject is the side being forked.
  const found = forksIn(gameOf(positive.fen, ["b5c7", "e8d7", "c7a8"], "black"));
  assert.equal(found.length, 1);
  const [fork] = found;
  assert.equal(fork!.role, "respond");
  assert.equal(fork!.event.actor, "opponent", "the opponent did it");
  assert.equal(fork!.event.affected, "subject");
  assert.equal(fork!.draft.responsePly, 1, "the subject's reply is the move being judged");
  assert.equal(fork!.draft.success, false, "the rook was still lost");
});

test("a fork nobody answered is censored, never failed", () => {
  const positive = fixture("double_attack/knight-fork-king-rook");
  const found = forksIn(gameOf(positive.fen, ["b5c7"], "white", {
    termination: "resign",
    result: "white",
  }));
  assert.equal(found.length, 1);
  const [fork] = found;
  assert.equal(fork!.draft.responseObserved, false);
  assert.equal(fork!.draft.success, null);
  assert.equal(fork!.draft.censoredReason, "opponent_resigned");
  assert.equal(fork!.event.completeness, "censored");
});

test("resigning yourself is not your opponent resigning", () => {
  const positive = fixture("double_attack/knight-fork-king-rook");
  const found = forksIn(gameOf(positive.fen, ["b5c7"], "white", {
    termination: "resign",
    result: "black",
  }));
  assert.equal(found[0]!.draft.censoredReason, "game_ended");
});

// ---------------------------------------------------------------------------
// Invariants every tactical draft must satisfy
// ---------------------------------------------------------------------------

test("every tactical concept is in the catalogue with the roles it emits", () => {
  const positive = fixture("double_attack/knight-fork-king-rook");
  for (const found of detectGame(gameOf(positive.fen, ["b5c7", "e8d7", "c7a8"], "white"))) {
    const concept = CONCEPT_CATALOGUE.find((entry) => entry.slug === found.conceptSlug);
    assert.ok(concept, `${found.conceptSlug} is not in the catalogue`);
    assert.ok(
      concept.supportedRoles.includes(found.role),
      `${found.conceptSlug} emitted ${found.role}, which its version does not support`,
    );
  }
});

test("difficulty is readable before the response exists", () => {
  const positive = fixture("double_attack/knight-fork-king-rook");
  for (const found of forksIn(gameOf(positive.fen, ["b5c7", "e8d7", "c7a8"], "white"))) {
    for (const [key, value] of Object.entries(found.draft.difficulty ?? {})) {
      assert.equal(typeof value, "number", `${key} is not a number`);
      assert.ok(
        !["success", "succeeded", "failed", "score", "correct", "result"].includes(key.toLowerCase()),
        `${key} carries the outcome back into the difficulty`,
      );
    }
  }
});

test("the same game detects the same tactical rows in the same order", () => {
  const positive = fixture("double_attack/knight-fork-king-rook");
  const game = gameOf(positive.fen, ["b5c7", "e8d7", "c7a8"], "white");
  const key = (found: ReturnType<typeof forksIn>[number]) =>
    `${found.event.detectionKey}|${found.role}|${found.draft.success}`;
  assert.deepEqual(forksIn(game).map(key), forksIn(game).map(key));
});

test("two occurrences of one family at one ply do not share a key", () => {
  // The discriminator exists for this. Nothing in the current fixtures produces
  // it, so it is asserted on the construction rather than left untested.
  const positive = fixture("double_attack/knight-fork-king-rook");
  const [fork] = forksIn(gameOf(positive.fen, ["b5c7", "e8d7", "c7a8"], "white"));
  assert.match(
    fork!.event.detectionKey,
    /^double_attack:0:\d+-\d+$/,
    "the key names the attacking square and its targets, not just the ply",
  );
  assert.ok(fork!.event.detectionKey.includes(String(sq("c7"))));
});

// ---------------------------------------------------------------------------
// pin (FOR-127)
// ---------------------------------------------------------------------------

function pinsIn(game: GameFacts) {
  return detectGame(game).filter((found) => found.conceptSlug === "pin");
}

test("a pin that wins the pinned piece is recorded", () => {
  const positive = fixture("pin/rook-pins-knight-and-wins-it");
  // Rd1 Kc8 Rxd5 -- created, unpinned too late, collected.
  const found = pinsIn(gameOf(positive.fen, ["a1d1", "d8c8", "d1d5"], "white"));
  assert.equal(found.length, 1);

  const [pin] = found;
  assert.equal(pin!.role, "execute");
  assert.equal(pin!.event.facts.subtype, "absolute");
  assert.equal(
    pin!.event.facts.winnableCp,
    PIECE_VALUES.knight,
    "an undefended knight, at whatever the shared table says a knight is worth",
  );
  assert.equal(pin!.draft.success, true);
});

test("the colour-reversed winning pin behaves identically", () => {
  const twin = fixture("pin/rook-pins-knight-and-wins-it-black");
  const found = pinsIn(gameOf(twin.fen, ["a8d8", "d1c1", "d8d4"], "black"));
  assert.equal(found.length, 1);
  assert.equal(found[0]!.role, "execute");
  assert.equal(found[0]!.draft.success, true);
});

test("immobilising a piece is not the same claim as winning one", () => {
  // The distinction the contract turns on, and the one this fixture was
  // originally written on the wrong side of. Bg5 really does pin the knight --
  // it has no legal move -- and wins nothing, because Bxf6 is met by Kxf6.
  const refuted = fixture("pin/bishop-pins-knight-to-king");
  assert.deepEqual(pinsIn(gameOf(refuted.fen, ["h4g5", "e7d7"], "white")), []);

  const twin = fixture("pin/bishop-pins-knight-to-king-black");
  assert.deepEqual(pinsIn(gameOf(twin.fen, ["b4c3", "e1f1"], "black")), []);
});

test("alignment with nothing behind it is not a pin", () => {
  const nearMiss = fixture("pin/alignment-with-nothing-behind-it");
  assert.deepEqual(pinsIn(gameOf(nearMiss.fen, ["h4g5", "e8d8"], "white")), []);
});

test("a pin that was already on the board is not something the player just did", () => {
  // Otherwise one idea becomes an event every ply for as long as the geometry
  // survives, and a player who pinned a knight once is credited with pinning it
  // eleven times.
  const positive = fixture("pin/rook-pins-knight-and-wins-it");
  const found = pinsIn(gameOf(positive.fen, ["a1d1", "d8c8", "h1g1", "c8d8", "g1h1"], "white"));
  assert.equal(found.length, 1, "created once, recorded once");
  assert.equal(found[0]!.draft.opportunityPly, 0);
});

test("a pin the opponent creates is measured as a response", () => {
  const positive = fixture("pin/rook-pins-knight-and-wins-it");
  const found = pinsIn(gameOf(positive.fen, ["a1d1", "d8c8", "d1d5"], "black"));
  assert.equal(found.length, 1);
  assert.equal(found[0]!.role, "respond");
  assert.equal(found[0]!.event.actor, "opponent");
  assert.equal(found[0]!.draft.success, false, "the knight was lost anyway");
});

test("a pin nobody answered is censored", () => {
  const positive = fixture("pin/rook-pins-knight-and-wins-it");
  const found = pinsIn(gameOf(positive.fen, ["a1d1"], "white", {
    termination: "resign",
    result: "white",
  }));
  assert.equal(found.length, 1);
  assert.equal(found[0]!.draft.responseObserved, false);
  assert.equal(found[0]!.draft.success, null);
  assert.equal(found[0]!.event.completeness, "censored");
});

// ---------------------------------------------------------------------------
// skewer (FOR-128)
// ---------------------------------------------------------------------------

function skewersIn(game: GameFacts) {
  return detectGame(game).filter((found) => found.conceptSlug === "skewer");
}

test("a skewer through a checked king wins what was behind it", () => {
  const positive = fixture("skewer/bishop-checks-king-wins-rook");
  // Bb2+ Kf7 Bxh8 -- the king steps aside and the rook falls.
  const found = skewersIn(gameOf(positive.fen, ["c1b2", "g7f7", "b2h8"], "white"));
  assert.equal(found.length, 1);

  const [skewer] = found;
  assert.equal(skewer!.role, "execute");
  assert.equal(skewer!.event.facts.frontIsKing, true);
  assert.equal(skewer!.event.facts.rearValueCp, PIECE_VALUES.rook);
  assert.equal(skewer!.draft.success, true);
});

test("the colour-reversed skewer behaves identically", () => {
  const twin = fixture("skewer/bishop-checks-king-wins-rook-black");
  const found = skewersIn(gameOf(twin.fen, ["c8b7", "g2f2", "b7h1"], "black"));
  assert.equal(found.length, 1);
  assert.equal(found[0]!.role, "execute");
  assert.equal(found[0]!.draft.success, true);
});

test("a skewer on a file is found as readily as one on a diagonal", () => {
  // I briefly convinced myself this one was refutable by interposing with the
  // rook, and it is not: the only blocking squares are e2 and e3, and the black
  // king on e4 stands between its own rook and both of them. The detector was
  // right and the reasoning about it was wrong, which is why fixtures get
  // replayed rather than eyeballed.
  const positive = fixture("skewer/rook-checks-king-wins-rook");
  const found = skewersIn(gameOf(positive.fen, ["a1e1", "e4d4", "e1e7"], "white"));
  assert.equal(found.length, 1);
  assert.equal(found[0]!.event.facts.frontIsKing, true);
  assert.equal(found[0]!.draft.success, true);
});

test("a rear target the defender can recapture is not a skewer", () => {
  // Same geometry, one bishop added to guard the rook behind the king. Rxe7 is
  // answered by Bxe7 and the exchange is even, so nothing was won.
  const refuted = fixture("skewer/rear-target-is-defended");
  assert.deepEqual(skewersIn(gameOf(refuted.fen, ["a1e1", "e4d4"], "white")), []);
});

test("a pin and a skewer never label the same geometry", () => {
  // One ray, two ideas, decided entirely by which end is worth more. A shape
  // that produced both would mean the value comparison had a gap in it.
  for (const id of [
    "skewer/bishop-checks-king-wins-rook",
    "pin/rook-pins-knight-and-wins-it",
  ]) {
    const entry = fixture(id);
    const moves = id.startsWith("skewer")
      ? ["c1b2", "g7f7", "b2h8"]
      : ["a1d1", "d8c8", "d1d5"];
    const found = detectGame(gameOf(entry.fen, moves, "white"))
      .filter((row) => row.conceptSlug === "pin" || row.conceptSlug === "skewer");
    assert.equal(
      new Set(found.map((row) => row.conceptSlug)).size,
      1,
      `${id} was labelled both a pin and a skewer`,
    );
  }
});

test("a skewer the opponent creates is measured as a response", () => {
  const positive = fixture("skewer/bishop-checks-king-wins-rook");
  const found = skewersIn(gameOf(positive.fen, ["c1b2", "g7f7", "b2h8"], "black"));
  assert.equal(found.length, 1);
  assert.equal(found[0]!.role, "respond");
  assert.equal(found[0]!.event.actor, "opponent");
});

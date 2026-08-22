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
  assert.equal(verdict.gainCp, 500, "the rook falls whatever the king does");
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
  assert.equal(fork!.event.facts.expectedGainCp, 500, "the rook, whatever the king does");
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

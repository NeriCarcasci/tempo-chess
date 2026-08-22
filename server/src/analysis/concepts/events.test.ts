/**
 * That one thing that happened is stored as one thing that happened.
 *
 * FOR-123. The database half -- row cardinality, foreign keys, exact evidence
 * linkage, retry, rollback -- belongs to the integration gate, which needs a
 * database. What can be settled here is the shape the worker is handed: if the
 * detector does not group its observations correctly, or gets the colours
 * wrong, no amount of careful insertion will fix it downstream.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { Chess } from "chessops/chess";
import { parseFen, makeFen, INITIAL_FEN } from "chessops/fen";
import { parseUci } from "chessops/util";
import {
  detectGame,
  groupByEvent,
  type GameFacts,
  type PositionFact,
  type TransitionFact,
} from "./detect.js";

function play(moves: readonly string[], initial = INITIAL_FEN): PositionFact[] {
  const board = Chess.fromSetup(parseFen(initial).unwrap()).unwrap();
  const positions: PositionFact[] = [{ ply: 0, fen: makeFen(board.toSetup()) }];
  moves.forEach((uci, index) => {
    board.play(parseUci(uci)!);
    positions.push({ ply: index + 1, fen: makeFen(board.toSetup()) });
  });
  return positions;
}

/** The Fried Liver shape: real captures, real hanging material, both colours. */
const MOVES = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6", "f3g5", "d7d5", "e4d5", "f6d5"];

function game(over: Partial<GameFacts> = {}): GameFacts {
  const positions = play(MOVES);
  const transitions = MOVES.map((uci, index): TransitionFact => ({
    fromPly: index,
    actorColor: index % 2 === 0 ? "white" : "black",
    playedMoveUci: uci,
    bestMoveUci: null,
    playedMoveRank: 1,
    playedMoveAcceptable: true,
    onlyMove: index === 6,
    criticality: index === 6 ? 0.4 : null,
    acceptableMoveCount: index === 6 ? 1 : null,
    candidateCount: index === 6 ? 3 : null,
    expectedScoreBefore: 0.5,
    expectedScoreAfter: 0.5,
    phase: "opening",
  }));
  return {
    subjectColor: "white",
    speed: "blitz",
    playedAt: new Date("2026-07-01T00:00:00Z"),
    termination: "resign",
    result: "white",
    positions,
    transitions,
    ...over,
  };
}

test("a moment measured twice is one group with two observations", () => {
  const groups = groupByEvent(detectGame(game()));
  const critical = groups.filter((group) => group.event.eventType === "critical_moment");
  assert.equal(critical.length, 1, "the critical moment was grouped as two occurrences");
  assert.equal(critical[0]!.observations.length, 2);
  assert.deepEqual(
    critical[0]!.observations.map((observation) => observation.draft.role).sort(),
    ["execute", "recognize"],
    "one chess_events row, two event_concepts labels -- that is §17.4's shape",
  );
});

test("grouping loses nothing and invents nothing", () => {
  const detected = detectGame(game());
  const groups = groupByEvent(detected);
  const regrouped = groups.flatMap((group) => group.observations);
  assert.equal(regrouped.length, detected.length);
  assert.ok(groups.length < detected.length, "nothing was actually grouped in this fixture");
  assert.deepEqual(new Set(regrouped), new Set(detected));
});

test("duplicate detector output cannot become a duplicate database identity", () => {
  const [observation] = detectGame(game());
  assert.ok(observation);
  const [group] = groupByEvent([observation, observation]);
  assert.equal(group!.observations.length, 1);
});

test("group order is the order the detector found them", () => {
  const first = groupByEvent(detectGame(game())).map((group) => group.event.detectionKey);
  const second = groupByEvent(detectGame(game())).map((group) => group.event.detectionKey);
  assert.deepEqual(first, second);
  assert.equal(new Set(first).size, first.length, "two groups share a key");
});

test("every event names who acted and who it happened to", () => {
  for (const group of groupByEvent(detectGame(game()))) {
    const { actor, affected, eventType } = group.event;
    for (const side of [actor, affected]) {
      assert.ok(
        side === null || side === "subject" || side === "opponent",
        `${eventType} has an unresolvable side ${String(side)}`,
      );
    }
    // Every current event is about the subject; only who *acted* varies.
    assert.equal(affected !== null || actor !== null, true, `${eventType} names nobody at all`);
  }
});

test("a threat the opponent created is not attributed to the subject", () => {
  // The bug this replaces: actor and affected were both set to the subject's
  // colour for every event, so a piece the *opponent* was about to win read as
  // something the subject did to themselves.
  const exposed = groupByEvent(detectGame(game())).find(
    (group) => group.event.eventType === "material_exposed",
  );
  assert.ok(exposed, "the fixture produced no exposed-material event");
  assert.equal(exposed.event.actor, "opponent", "the side who could take it is the opponent");
  assert.equal(exposed.event.affected, "subject", "the piece at risk is the subject's");

  // The opening fixture never leaves White anything worth taking -- every
  // capture in it recaptures evenly -- so the offered case gets a position
  // where something really is hanging: Black's queen on d5, to a rook on d1.
  const HANGING_QUEEN = "4k3/8/8/3q4/8/8/8/3RK3 w - - 0 1";
  const offered = groupByEvent(detectGame(game({
    positions: play(["d1d5"], HANGING_QUEEN),
    transitions: [{
      fromPly: 0,
      actorColor: "white",
      playedMoveUci: "d1d5",
      bestMoveUci: "d1d5",
      playedMoveRank: 1,
      playedMoveAcceptable: true,
      onlyMove: null,
      criticality: null,
      acceptableMoveCount: null,
      candidateCount: null,
      expectedScoreBefore: 0.5,
      expectedScoreAfter: 0.9,
      phase: "endgame",
    }],
  }))).find((group) => group.event.eventType === "material_offered");
  assert.ok(offered, "the fixture produced no offered-material event");
  assert.equal(offered.event.actor, "subject", "the side who could take it is the subject");
  assert.equal(offered.event.affected, "opponent", "the piece at risk is the opponent's");
});

test("who acted does not depend on which colour the subject played", () => {
  // The sides are relative, so the same event carries the same relative actor
  // whichever colour the subject was. A detector that got this wrong would
  // measure White correctly and Black backwards.
  const asWhite = groupByEvent(detectGame(game({ subjectColor: "white" })));
  const asBlack = groupByEvent(detectGame(game({ subjectColor: "black" })));
  for (const eventType of ["material_exposed", "material_offered"]) {
    const white = asWhite.find((group) => group.event.eventType === eventType);
    const black = asBlack.find((group) => group.event.eventType === eventType);
    if (!white || !black) continue;
    assert.equal(white.event.actor, black.event.actor, `${eventType} actor flipped with colour`);
    assert.equal(
      white.event.affected,
      black.event.affected,
      `${eventType} affected flipped with colour`,
    );
  }
});

test("a position that became winning attributes the win to nobody", () => {
  // §18.1's distinction, enforced at the point it would be lost. A position
  // that improved because the opponent erred is not the subject having done
  // something, and `actor_color` is nullable precisely so this can say so.
  const winning = groupByEvent(detectGame(game({
    transitions: game().transitions.map((transition, index) =>
      index === 8 ? { ...transition, expectedScoreAfter: 0.9 } : transition,
    ),
  }))).find((group) => group.event.eventType === "winning_position_reached");
  assert.ok(winning, "the fixture produced no winning-position event");
  assert.equal(
    winning.event.actor,
    null,
    "naming an actor here credits the subject for an opponent's mistake",
  );
  assert.equal(winning.event.affected, "subject");
});

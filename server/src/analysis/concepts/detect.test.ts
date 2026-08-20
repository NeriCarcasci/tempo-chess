import assert from "node:assert/strict";
import { test } from "node:test";
import { Chess } from "chessops/chess";
import { parseFen, makeFen, INITIAL_FEN } from "chessops/fen";
import { parseUci } from "chessops/util";
import { detectGame, type GameFacts, type PositionFact, type TransitionFact } from "./detect.js";
import { CONCEPT_CATALOGUE, conceptVersionHash } from "./catalogue.js";
import { difficultyIsUncontaminated, isRecordableOpportunity } from "../observations.js";

/** Replay UCI moves from a starting position, recording the FEN at every ply. */
function play(moves: readonly string[], initial = INITIAL_FEN): PositionFact[] {
  const board = Chess.fromSetup(parseFen(initial).unwrap()).unwrap();
  const positions: PositionFact[] = [{ ply: 0, fen: makeFen(board.toSetup()) }];
  moves.forEach((uci, index) => {
    board.play(parseUci(uci)!);
    positions.push({ ply: index + 1, fen: makeFen(board.toSetup()) });
  });
  return positions;
}

function transition(over: Partial<TransitionFact> & { fromPly: number; actorColor: "white" | "black"; playedMoveUci: string }): TransitionFact {
  return {
    bestMoveUci: null,
    playedMoveRank: null,
    playedMoveAcceptable: true,
    onlyMove: null,
    criticality: null,
    expectedScoreBefore: 0.5,
    expectedScoreAfter: 0.5,
    phase: "middlegame",
    ...over,
  };
}

function game(over: Partial<GameFacts>): GameFacts {
  return {
    subjectColor: "white",
    speed: "blitz",
    playedAt: new Date("2026-07-01T00:00:00Z"),
    transitions: [],
    positions: [],
    termination: "resign",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The contract every draft must satisfy
// ---------------------------------------------------------------------------

test("every draft the detector produces is recordable", () => {
  // 1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. Ng5 d5 5. exd5 Nxd5 -- the Fried Liver
  // shape, which has real captures and real hanging material.
  const moves = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6", "f3g5", "d7d5", "e4d5", "f6d5"];
  const positions = play(moves);
  const transitions = moves.map((uci, index) =>
    transition({
      fromPly: index,
      actorColor: index % 2 === 0 ? "white" : "black",
      playedMoveUci: uci,
      criticality: index === 6 ? 0.8 : null,
      playedMoveRank: index === 6 ? 1 : null,
      onlyMove: index === 8 ? true : null,
    }),
  );

  const found = detectGame(game({ positions, transitions }));
  assert.ok(found.length > 0, "the detector found nothing in a sharp opening");
  for (const observation of found) {
    assert.ok(
      isRecordableOpportunity(observation.draft),
      `${observation.conceptSlug}/${observation.role} produced an unrecordable draft`,
    );
    assert.ok(
      difficultyIsUncontaminated(observation.draft.difficulty),
      `${observation.conceptSlug} leaked the outcome into difficulty`,
    );
    assert.ok(observation.event.startPly <= observation.event.focalPly);
    assert.ok(observation.event.focalPly <= observation.event.endPly);
  }
});

test("only the subject's own moves are observed", () => {
  const moves = ["e2e4", "e7e5", "g1f3", "b8c6"];
  const positions = play(moves);
  const transitions = moves.map((uci, index) =>
    transition({
      fromPly: index,
      actorColor: index % 2 === 0 ? "white" : "black",
      playedMoveUci: uci,
      criticality: 0.9,
      playedMoveRank: 1,
    }),
  );

  const white = detectGame(game({ subjectColor: "white", positions, transitions }));
  const black = detectGame(game({ subjectColor: "black", positions, transitions }));
  // Even plies are White's moves, odd are Black's.
  assert.ok(white.every((o) => o.draft.opportunityPly % 2 === 0));
  assert.ok(black.every((o) => o.draft.opportunityPly % 2 === 1));
});

// ---------------------------------------------------------------------------
// Recognise and execute are separate observations
// ---------------------------------------------------------------------------

test("considering the move and choosing it are recorded apart", () => {
  const moves = ["e2e4"];
  const positions = play(moves);
  // The player found a move the search retained, and it was still not good
  // enough. Recognise succeeds; execute fails.
  const transitions = [
    transition({
      fromPly: 0,
      actorColor: "white",
      playedMoveUci: "e2e4",
      criticality: 0.7,
      playedMoveRank: 3,
      playedMoveAcceptable: false,
    }),
  ];
  const found = detectGame(game({ positions, transitions }))
    .filter((o) => o.conceptSlug === "critical_moment");

  const recognize = found.find((o) => o.role === "recognize");
  const execute = found.find((o) => o.role === "execute");
  assert.equal(recognize?.draft.success, true);
  assert.equal(execute?.draft.success, false);
});

test("a critical moment is only claimed where the deep search reached", () => {
  const positions = play(["e2e4"]);
  const found = detectGame(game({
    positions,
    transitions: [transition({ fromPly: 0, actorColor: "white", playedMoveUci: "e2e4", criticality: null })],
  }));
  assert.equal(found.filter((o) => o.conceptSlug === "critical_moment").length, 0);
});

// ---------------------------------------------------------------------------
// Censoring
// ---------------------------------------------------------------------------

test("a win the opponent resigned into is censored, never failed", () => {
  const moves = ["e2e4", "e7e5"];
  const positions = play(moves);
  const transitions = [
    transition({ fromPly: 0, actorColor: "white", playedMoveUci: "e2e4", expectedScoreAfter: 0.95 }),
    transition({ fromPly: 1, actorColor: "black", playedMoveUci: "e7e5", expectedScoreAfter: 0.95 }),
  ];
  const [conversion] = detectGame(game({ positions, transitions, termination: "resign" }))
    .filter((o) => o.conceptSlug === "winning_conversion");

  assert.ok(conversion);
  assert.equal(conversion.draft.responseObserved, false);
  assert.equal(conversion.draft.success, null, "a resignation must not count as a failed conversion");
  assert.equal(conversion.draft.censoredReason, "opponent_resigned");
  assert.equal(conversion.event.completeness, "censored");
});

test("the censor reason follows the provider, and never guesses", () => {
  const positions = play(["e2e4", "e7e5"]);
  const transitions = [
    transition({ fromPly: 0, actorColor: "white", playedMoveUci: "e2e4", expectedScoreAfter: 0.95 }),
    transition({ fromPly: 1, actorColor: "black", playedMoveUci: "e7e5", expectedScoreAfter: 0.95 }),
  ];
  const reasonFor = (termination: string | null) =>
    detectGame(game({ positions, transitions, termination }))
      .find((o) => o.conceptSlug === "winning_conversion")?.draft.censoredReason;

  assert.equal(reasonFor("resign"), "opponent_resigned");
  assert.equal(reasonFor("outoftime"), "clock_expired");
  assert.equal(reasonFor("mate"), "game_ended");
  assert.equal(reasonFor(null), "game_ended", "silence is not a resignation");
});

test("a win that was played out is observed, not censored", () => {
  const moves = ["e2e4", "e7e5", "g1f3", "b8c6"];
  const positions = play(moves);
  const transitions = moves.map((uci, index) =>
    transition({
      fromPly: index,
      actorColor: index % 2 === 0 ? "white" : "black",
      playedMoveUci: uci,
      expectedScoreAfter: 0.9,
    }),
  );
  const [conversion] = detectGame(game({ positions, transitions }))
    .filter((o) => o.conceptSlug === "winning_conversion");

  assert.ok(conversion);
  assert.equal(conversion.draft.responseObserved, true);
  assert.equal(conversion.draft.success, true);
});

test("a win that was thrown away is a failed conversion", () => {
  const moves = ["e2e4", "e7e5", "g1f3", "b8c6"];
  const positions = play(moves);
  const transitions = moves.map((uci, index) =>
    transition({
      fromPly: index,
      actorColor: index % 2 === 0 ? "white" : "black",
      playedMoveUci: uci,
      // White is winning after move one and level again by the end.
      expectedScoreAfter: index === 0 ? 0.92 : 0.5,
    }),
  );
  const [conversion] = detectGame(game({ positions, transitions }))
    .filter((o) => o.conceptSlug === "winning_conversion");

  assert.equal(conversion?.draft.success, false);
});

test("a game that never reached a winning position has no conversion to judge", () => {
  const positions = play(["e2e4", "e7e5"]);
  const transitions = [
    transition({ fromPly: 0, actorColor: "white", playedMoveUci: "e2e4" }),
    transition({ fromPly: 1, actorColor: "black", playedMoveUci: "e7e5" }),
  ];
  assert.equal(
    detectGame(game({ positions, transitions })).filter((o) => o.conceptSlug === "winning_conversion").length,
    0,
  );
});

// ---------------------------------------------------------------------------
// Board-derived material
// ---------------------------------------------------------------------------

test("a free piece taken counts, and the same piece left alone does not", () => {
  // White to move with a black knight on e5 defended by nothing, and a white
  // pawn on d4 able to take it.
  const fen = "4k3/8/8/4n3/3P4/8/8/4K3 w - - 0 1";
  const taken = detectGame(game({
    positions: play(["d4e5"], fen),
    transitions: [transition({ fromPly: 0, actorColor: "white", playedMoveUci: "d4e5" })],
  })).find((o) => o.conceptSlug === "free_material");
  assert.equal(taken?.draft.success, true, "a capture of an undefended knight should count");

  const ignored = detectGame(game({
    positions: play(["e1e2"], fen),
    transitions: [transition({ fromPly: 0, actorColor: "white", playedMoveUci: "e1e2" })],
  })).find((o) => o.conceptSlug === "free_material");
  assert.equal(ignored?.draft.success, false, "walking past a free knight should not count");
});

test("material is not called free when taking it loses the exchange", () => {
  // The black knight on e5 is defended by the d6 pawn, so Rxe5 loses material.
  const fen = "4k3/8/3p4/4n3/8/8/8/4K2R w K - 0 1";
  const found = detectGame(game({
    positions: play(["e1f1"], fen),
    transitions: [transition({ fromPly: 0, actorColor: "white", playedMoveUci: "e1f1" })],
  }));
  assert.equal(
    found.filter((o) => o.conceptSlug === "free_material").length,
    0,
    "a defended piece is not material on offer",
  );
});

test("saving a hanging piece succeeds and abandoning it fails", () => {
  // Black to move; the knight on e5 is attacked by the d4 pawn and undefended.
  const fen = "4k3/8/8/4n3/3P4/8/8/4K3 b - - 0 1";
  const saved = detectGame(game({
    subjectColor: "black",
    positions: play(["e5c6"], fen),
    transitions: [transition({ fromPly: 0, actorColor: "black", playedMoveUci: "e5c6" })],
  })).find((o) => o.conceptSlug === "material_safety");
  assert.equal(saved?.draft.success, true);

  const abandoned = detectGame(game({
    subjectColor: "black",
    positions: play(["e8d8"], fen),
    transitions: [transition({ fromPly: 0, actorColor: "black", playedMoveUci: "e8d8" })],
  })).find((o) => o.conceptSlug === "material_safety");
  assert.equal(abandoned?.draft.success, false);
});

// ---------------------------------------------------------------------------
// The catalogue itself
// ---------------------------------------------------------------------------

test("every concept the detector emits is in the catalogue with that role", () => {
  const moves = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6", "f3g5", "d7d5"];
  const positions = play(moves);
  const transitions = moves.map((uci, index) =>
    transition({
      fromPly: index,
      actorColor: index % 2 === 0 ? "white" : "black",
      playedMoveUci: uci,
      criticality: 0.6,
      playedMoveRank: 1,
      onlyMove: index === 4,
      expectedScoreBefore: index === 2 ? 0.2 : 0.5,
      expectedScoreAfter: 0.9,
    }),
  );
  const found = detectGame(game({ positions, transitions }));
  assert.ok(found.length > 0);
  for (const observation of found) {
    const concept = CONCEPT_CATALOGUE.find((c) => c.slug === observation.conceptSlug);
    assert.ok(concept, `${observation.conceptSlug} is not in the catalogue`);
    assert.ok(
      concept.supportedRoles.includes(observation.role),
      `${observation.conceptSlug} does not declare the role ${observation.role}`,
    );
  }
});

test("a concept version hash is stable and follows the rule, not the wording", () => {
  const [first] = CONCEPT_CATALOGUE;
  assert.ok(first);
  assert.match(conceptVersionHash(first), /^[0-9a-f]{64}$/);
  assert.equal(conceptVersionHash(first), conceptVersionHash({ ...first }));
  assert.equal(
    conceptVersionHash({ ...first, displayName: "Renamed entirely" }),
    conceptVersionHash(first),
    "renaming a concept must not orphan its evidence",
  );
  assert.notEqual(
    conceptVersionHash({ ...first, detectorContract: { ...first.detectorContract, thresholdCp: 999 } }),
    conceptVersionHash(first),
    "changing the rule must change the version",
  );
});

test("catalogue slugs are unique", () => {
  const slugs = CONCEPT_CATALOGUE.map((concept) => concept.slug);
  assert.equal(new Set(slugs).size, slugs.length);
});

test("castling is not a free rook", () => {
  // chessops encodes castling in allDests as the king moving onto its own
  // rook. Read as "the destination is occupied", every position with castling
  // rights offered a free rook -- which is most positions in most games, and
  // the numbers would still have looked plausible.
  const fen = "r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1";
  const found = detectGame(game({
    positions: play(["e1g1"], fen),
    transitions: [transition({ fromPly: 0, actorColor: "white", playedMoveUci: "e1g1" })],
  }));
  assert.equal(found.filter((o) => o.conceptSlug === "free_material").length, 0);
  assert.equal(found.filter((o) => o.conceptSlug === "material_safety").length, 0);
});

test("a piece defended well enough is not hanging", () => {
  // Black knight on e5, defended by the d6 pawn; White's d4 pawn attacks it.
  // Taking wins a knight for a pawn, so it IS hanging by SEE -- but a knight
  // defended against a rook is not.
  const rookAttacks = "4k3/8/3p4/4n3/8/8/8/4K1R1 w - - 0 1";
  const found = detectGame(game({
    subjectColor: "black",
    positions: play(["e8d8"], "4k3/8/3p4/4n3/8/8/8/4K1R1 b - - 0 1"),
    transitions: [transition({ fromPly: 0, actorColor: "black", playedMoveUci: "e8d8" })],
  }));
  assert.equal(
    found.filter((o) => o.conceptSlug === "material_safety").length,
    0,
    `a knight defended by a pawn is not hanging to a rook (${rookAttacks})`,
  );
});

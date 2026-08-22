import assert from "node:assert/strict";
import { test } from "node:test";
import { Chess } from "chessops/chess";
import { parseFen, makeFen, INITIAL_FEN } from "chessops/fen";
import { parseUci } from "chessops/util";
import {
  DETECTORS,
  PositionIndex,
  detectGame,
  type GameFacts,
  type PositionFact,
  type TransitionFact,
} from "./detect.js";
import { CONCEPT_CATALOGUE, CRITICALITY_THRESHOLD, conceptVersionHash } from "./catalogue.js";
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
    acceptableMoveCount: null,
    candidateCount: null,
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
    result: "white",
    candidatesByPly: new Map(),
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

test("a resignation is attributed to the opponent only when the subject won", () => {
  const positions = play(["e2e4"]);
  const transitions = [
    transition({ fromPly: 0, actorColor: "white", playedMoveUci: "e2e4", expectedScoreAfter: 0.95 }),
  ];
  const reason = detectGame(game({ positions, transitions, termination: "resign", result: "black" }))
    .find((o) => o.conceptSlug === "winning_conversion")?.draft.censoredReason;
  assert.equal(reason, "game_ended", "termination alone does not identify who resigned");
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
    transitions: [transition({
      fromPly: 0,
      actorColor: "white",
      playedMoveUci: "e1e2",
      // Walking past it *and* losing ground by doing so. Without this the move
      // is one the engine rated fine, which v2 treats as playing something at
      // least as good -- see the zwischenzug case below.
      playedMoveAcceptable: false,
      bestMoveUci: "d4e5",
    })],
  })).find((o) => o.conceptSlug === "free_material");
  assert.equal(ignored?.draft.success, false, "walking past a free knight should not count");
});

test("a stronger move is not a missed offer", () => {
  // FOR-124. v1 asked only "was the move a capture", so a mate in one, a
  // winning zwischenzug and a stronger recapture all scored as failing to see
  // free material -- the detector marked a player down for playing better than
  // the thing it was measuring.
  const fen = "4k3/8/8/4n3/3P4/8/8/4K3 w - - 0 1";
  const found = detectGame(game({
    positions: play(["e1e2"], fen),
    transitions: [transition({
      fromPly: 0,
      actorColor: "white",
      playedMoveUci: "e1e2",
      playedMoveAcceptable: true,
    })],
  })).find((o) => o.conceptSlug === "free_material");
  assert.equal(found?.draft.success, true, "a move the engine rated within tolerance is not a miss");
  assert.equal(found?.event.facts.taken, false);
  assert.equal(found?.event.facts.alternativeVerified, true, "the facts must say which it was");
});

test("a bad quiet move is not blamed on an offer the engine did not prefer", () => {
  const fen = "4k3/8/8/4n3/3P4/8/8/4K3 w - - 0 1";
  const found = detectGame(game({
    positions: play(["e1e2"], fen),
    transitions: [transition({
      fromPly: 0,
      actorColor: "white",
      playedMoveUci: "e1e2",
      bestMoveUci: "e1f2",
      playedMoveAcceptable: false,
    })],
  })).filter((o) => o.conceptSlug === "free_material");
  assert.equal(found.length, 0, "a bad move does not prove which opportunity was missed");
});

test("material observations carry the facts their contracts require", () => {
  const fen = "4k3/8/8/4n3/3P4/8/8/4K3 w - - 0 1";
  const found = detectGame(game({
    positions: play(["d4e5"], fen),
    transitions: [transition({ fromPly: 0, actorColor: "white", playedMoveUci: "d4e5" })],
  })).find((o) => o.conceptSlug === "free_material");
  assert.equal(found?.event.facts.piece, "knight");
  assert.equal(typeof found?.event.facts.alternativeVerified, "boolean");
  assert.equal(typeof found?.draft.difficulty?.captureCount, "number");
  assert.equal(typeof found?.draft.difficulty?.targetIsDefended, "number");
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
  assert.equal(saved?.event.facts.piece, "knight");
  assert.equal(saved?.event.facts.resolution, "moved_to_safety");
  assert.equal(typeof saved?.draft.difficulty?.attackerCount, "number");
  assert.equal(typeof saved?.draft.difficulty?.defenderCount, "number");

  const abandoned = detectGame(game({
    subjectColor: "black",
    positions: play(["e8d8"], fen),
    transitions: [transition({
      fromPly: 0,
      actorColor: "black",
      playedMoveUci: "e8d8",
      // Left it hanging *and* lost ground. A move the engine rated fine that
      // leaves a piece en prise is a sacrifice, which v2 abstains on rather
      // than calling a blunder -- asserted separately below.
      playedMoveAcceptable: false,
    })],
  })).find((o) => o.conceptSlug === "material_safety");
  assert.equal(abandoned?.draft.success, false);
});

test("a sound sacrifice is not a hung piece", () => {
  // FOR-124. Static exchange cannot see compensation, so a piece deliberately
  // left en prise looks identical to one left by accident. When the engine
  // rated the move acceptable, the honest answer is to say nothing rather than
  // to record a failure the evidence does not support.
  const fen = "4k3/8/8/4n3/3P4/8/8/4K3 b - - 0 1";
  const found = detectGame(game({
    subjectColor: "black",
    positions: play(["e8d8"], fen),
    transitions: [transition({
      fromPly: 0,
      actorColor: "black",
      playedMoveUci: "e8d8",
      playedMoveAcceptable: true,
    })],
  })).filter((o) => o.conceptSlug === "material_safety");
  assert.equal(found.length, 0, "an abstention is no row at all, not a row saying null");
});

test("saving the focal piece is judged on that piece alone", () => {
  // FOR-124. v1 asked whether *anything* of the subject's was hanging after the
  // move, so rescuing the attacked knight while an unrelated pawn became loose
  // scored as a failure: the player did exactly the thing being measured and
  // was marked down for something else.
  //
  // Black knight on e5 attacked by the d4 pawn; black pawn on b5 attacked by
  // the white bishop on e2 and defended by nothing. Moving the knight to
  // safety leaves b5 loose, which is a different question.
  const fen = "4k3/8/8/1p2n3/3P4/8/4B3/4K3 b - - 0 1";
  const found = detectGame(game({
    subjectColor: "black",
    positions: play(["e5c6"], fen),
    transitions: [transition({
      fromPly: 0,
      actorColor: "black",
      playedMoveUci: "e5c6",
      playedMoveAcceptable: false,
    })],
  })).find((o) => o.conceptSlug === "material_safety");
  assert.equal(found?.draft.success, true, "the focal piece reached safety, which is the question");
});

// ---------------------------------------------------------------------------
// FOR-124: what the corrected contracts refuse to claim
// ---------------------------------------------------------------------------

/** One subject move from the opening position, with whatever assessment is under test. */
function oneMove(over: Partial<TransitionFact>): GameFacts {
  return game({
    positions: play(["e2e4"]),
    transitions: [transition({
      fromPly: 0,
      actorColor: "white",
      playedMoveUci: "e2e4",
      ...over,
    })],
  });
}

test("a position where every retained line agreed is not a critical moment", () => {
  // The v1 bug. `criticality` is the spread between the best and worst
  // candidate the search kept, and it is non-null the moment two lines come
  // back -- so a position where both were equal became "a moment where the
  // moves available led to genuinely different games". The concept was partly
  // measuring where the deep search happened to run.
  const flat = detectGame(oneMove({ criticality: 0, playedMoveRank: 1, acceptableMoveCount: 2 }))
    .filter((o) => o.conceptSlug === "critical_moment");
  assert.equal(flat.length, 0, "zero spread is zero at stake");

  const marginal = detectGame(oneMove({ criticality: 0.05, playedMoveRank: 1, acceptableMoveCount: 2 }))
    .filter((o) => o.conceptSlug === "critical_moment");
  assert.equal(marginal.length, 0, "a spread inside the threshold is still not a decision");

  const real = detectGame(oneMove({ criticality: 0.4, playedMoveRank: 1, acceptableMoveCount: 2 }))
    .filter((o) => o.conceptSlug === "critical_moment");
  assert.equal(real.length, 2, "a real spread is still measured, in both roles");
});

test("the threshold is exactly the published one", () => {
  // Pinned against the constant rather than the literal, so moving the
  // threshold is a deliberate act that shows up as a version bump rather than
  // a test quietly following the code.
  const atThreshold = detectGame(oneMove({
    criticality: CRITICALITY_THRESHOLD,
    playedMoveRank: 1,
    acceptableMoveCount: 2,
  })).filter((o) => o.conceptSlug === "critical_moment");
  assert.equal(atThreshold.length, 2, "the threshold is inclusive");

  const justUnder = detectGame(oneMove({
    criticality: CRITICALITY_THRESHOLD - 0.001,
    playedMoveRank: 1,
    acceptableMoveCount: 2,
  })).filter((o) => o.conceptSlug === "critical_moment");
  assert.equal(justUnder.length, 0);
});

test("recognising is about the search, not about the player", () => {
  // The wording changed because the claim had to. What is observable is
  // whether the move played was among the candidates the search retained --
  // `played_move_rank` -- and nothing here can see what was considered.
  const listed = detectGame(oneMove({ criticality: 0.4, playedMoveRank: 2, acceptableMoveCount: 2 }))
    .find((o) => o.conceptSlug === "critical_moment" && o.role === "recognize");
  assert.equal(listed?.draft.success, true);

  const unlisted = detectGame(oneMove({ criticality: 0.4, playedMoveRank: null, acceptableMoveCount: 2 }))
    .find((o) => o.conceptSlug === "critical_moment" && o.role === "recognize");
  assert.equal(unlisted?.draft.success, false, "a move the search never listed is the negative case");
});

test("an unsearched alternative does not prove an absolute only move", () => {
  // `only_move` is computed over the candidates the search retained, so v1's
  // "exactly one move held and everything else lost ground" asserted a proof
  // over all legal moves that a MultiPV search does not perform. v2 records
  // which claim it is actually making.
  //
  // The opening position has twenty legal moves. A search that kept three of
  // them cannot have ruled out the other seventeen.
  const searched = detectGame(oneMove({ onlyMove: true, candidateCount: 3, acceptableMoveCount: 1 }))
    .find((o) => o.conceptSlug === "only_move");
  assert.equal(searched?.event.facts.coverage, "searched");
  assert.equal(searched?.event.facts.legalMoveCount, 20);
  assert.equal(searched?.event.facts.candidateCount, 3);

  const absolute = detectGame(oneMove({ onlyMove: true, candidateCount: 20, acceptableMoveCount: 1 }))
    .find((o) => o.conceptSlug === "only_move");
  assert.equal(
    absolute?.event.facts.coverage,
    "absolute",
    "a search that examined every legal move may claim the stronger thing",
  );
});

test("an unknown candidate count is the weaker claim, not the stronger one", () => {
  // The failure mode worth guarding: a missing count must not read as full
  // coverage. Old assessments have no `retainedLines`, and defaulting those to
  // "absolute" would put the overclaim back with no way to see it.
  const unknown = detectGame(oneMove({ onlyMove: true, candidateCount: null, acceptableMoveCount: 1 }))
    .find((o) => o.conceptSlug === "only_move");
  assert.equal(unknown?.event.facts.coverage, "searched");
});

test("promotion choices are separate legal moves for only-move coverage", () => {
  const fen = "7k/P7/8/8/8/8/8/7K w - - 0 1";
  const found = detectGame(game({
    positions: play(["a7a8q"], fen),
    transitions: [transition({
      fromPly: 0,
      actorColor: "white",
      playedMoveUci: "a7a8q",
      onlyMove: true,
      candidateCount: 4,
      acceptableMoveCount: 1,
    })],
  })).find((o) => o.conceptSlug === "only_move");
  assert.equal(found?.event.facts.legalMoveCount, 7);
  assert.equal(found?.event.facts.coverage, "searched");
});

test("a search that retained one line has no only-move to report", () => {
  const none = detectGame(oneMove({ onlyMove: null, candidateCount: 1 }))
    .filter((o) => o.conceptSlug === "only_move");
  assert.equal(none.length, 0, "null is not false, and neither is an answer");
});

test("the conversion opportunity begins in the position that was winning", () => {
  // v1 used the ply the subject moved *from*, which is one before anything was
  // won: the opportunity was recorded as beginning in a position that was not
  // yet winning, and every conversion in the database pointed one ply early.
  const moves = ["e2e4", "e7e5", "g1f3", "b8c6"];
  const found = detectGame(game({
    positions: play(moves),
    transitions: moves.map((uci, index) => transition({
      fromPly: index,
      actorColor: index % 2 === 0 ? "white" : "black",
      playedMoveUci: uci,
      // White's move at ply 0 is the one that crosses the threshold.
      expectedScoreAfter: index === 0 ? 0.9 : 0.8,
    })),
  })).find((o) => o.conceptSlug === "winning_conversion");

  assert.equal(found?.draft.opportunityPly, 1, "the winning position is the one after the move");
  assert.equal(found?.event.startPly, 1);
  assert.equal(found?.event.focalPly, 1);
  assert.equal(found?.draft.responsePly, 2, "the response is the subject's last move");
  assert.ok(
    found!.draft.responsePly! >= found!.draft.opportunityPly,
    "the ply ordering constraint the database enforces",
  );
});

test("a win with nothing played after it is still censored, at the corrected ply", () => {
  const found = detectGame(game({
    positions: play(["e2e4"]),
    transitions: [transition({
      fromPly: 0,
      actorColor: "white",
      playedMoveUci: "e2e4",
      expectedScoreAfter: 0.9,
    })],
    termination: "resign",
  })).find((o) => o.conceptSlug === "winning_conversion");
  assert.equal(found?.draft.responseObserved, false);
  assert.equal(found?.draft.success, null, "silence is censored, never failed");
  assert.equal(found?.draft.censoredReason, "opponent_resigned");
  assert.equal(found?.draft.opportunityPly, 1);
  assert.equal(found?.event.completeness, "censored");
});

test("worse-position defence was not changed, and still reads both colours", () => {
  // Reconfirmed rather than corrected, so it keeps version 1 -- which is the
  // point of FOR-122. Expected scores are stored from White's perspective and
  // flipped for Black, and the rule has to mean the same thing either way.
  const asWhite = detectGame(oneMove({ expectedScoreBefore: 0.2, playedMoveAcceptable: true }))
    .find((o) => o.conceptSlug === "worse_position_defence");
  assert.equal(asWhite?.draft.success, true);

  const asBlack = detectGame(game({
    subjectColor: "black",
    positions: play(["e2e4", "e7e5"]),
    transitions: [transition({
      fromPly: 1,
      actorColor: "black",
      playedMoveUci: "e7e5",
      // 0.8 for White is 0.2 for Black, which is below the worse threshold.
      expectedScoreBefore: 0.8,
      playedMoveAcceptable: true,
    })],
  })).find((o) => o.conceptSlug === "worse_position_defence");
  assert.equal(asBlack?.draft.success, true, "a stored White score of 0.8 is 0.2 for Black");
  // Compared with a tolerance because `1 - 0.8` is 0.19999999999999996. The
  // perspective flip does not round, so Black's difficulty vectors carry float
  // noise. Harmless -- nothing thresholds on it -- and left alone deliberately:
  // rounding it would change what `worse_position_defence` records, and this
  // concept keeps version 1 precisely because its rule did not change.
  assert.ok(
    Math.abs((asBlack?.draft.difficulty?.expectedScoreBefore ?? 0) - 0.2) < 1e-9,
    `expected the subject's score to flip to 0.2, got ${asBlack?.draft.difficulty?.expectedScoreBefore}`,
  );
});

test("every corrected concept carries a version, and the unchanged one did not move", () => {
  const version = (slug: string) =>
    CONCEPT_CATALOGUE.find((concept) => concept.slug === slug)?.versionNo;
  for (const slug of ["material_safety", "free_material", "critical_moment", "only_move", "winning_conversion"]) {
    assert.equal(version(slug), 2, `${slug} changed its rule and must carry a new version`);
  }
  assert.equal(
    version("worse_position_defence"),
    1,
    "an unchanged rule must not be given a new version just because its neighbours were",
  );
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

// ---------------------------------------------------------------------------
// FOR-125: the registry, and one board per game
// ---------------------------------------------------------------------------

test("the detector order is a written list, and it is the order of the output", () => {
  assert.deepEqual(
    DETECTORS.map((detector) => detector.name),
    ["material", "decision", "conversion", "double_attack", "pin"],
    "the order is part of the output contract: two runs must emit the same rows "
    + "in the same sequence, or a diff between them means nothing. Adding a "
    + "detector is meant to change this line -- that is the deliberate act.",
  );
  assert.equal(
    new Set(DETECTORS.map((detector) => detector.name)).size,
    DETECTORS.length,
    "two detectors sharing a name makes the order ambiguous",
  );
});

test("every detector reads the same board, parsed once per ply", () => {
  // The point of the shared layer. Three detectors ask about the same plies,
  // and the expensive thing each of them could have done independently is
  // parsing the FEN.
  const facts = game({
    positions: play(["e2e4", "e7e5", "g1f3", "b8c6"]),
    transitions: [0, 1, 2, 3].map((ply) => transition({
      fromPly: ply,
      actorColor: ply % 2 === 0 ? "white" : "black",
      playedMoveUci: ["e2e4", "e7e5", "g1f3", "b8c6"][ply]!,
    })),
  });
  const index = new PositionIndex(facts.positions);
  const context = { game: facts, index };
  for (const detector of DETECTORS) detector.detect(context);

  // The invariant is "at most once per ply", not a fixed number: every detector
  // added widens which plies get touched, and pinning the count would make this
  // fail for the right reason every time the registry grows.
  assert.ok(
    index.parseCount <= facts.positions.length,
    `${index.parseCount} parses for ${facts.positions.length} positions -- `
    + "something is asking for a board the index already holds",
  );

  // And asking again costs nothing, which is the part that actually matters
  // once six families read the same plies.
  const before = index.parseCount;
  for (const detector of DETECTORS) detector.detect(context);
  assert.equal(index.parseCount, before, "a second pass re-parsed something");
});

test("detecting the same game twice produces the same rows in the same order", () => {
  const facts = game({
    positions: play(["e2e4", "e7e5", "g1f3", "b8c6"]),
    transitions: [0, 1, 2, 3].map((ply) => transition({
      fromPly: ply,
      actorColor: ply % 2 === 0 ? "white" : "black",
      playedMoveUci: ["e2e4", "e7e5", "g1f3", "b8c6"][ply]!,
    })),
  });
  const first = detectGame(facts);
  const second = detectGame(facts);
  assert.deepEqual(
    first.map((o) => `${o.event.detectionKey}|${o.conceptSlug}|${o.role}|${o.draft.success}`),
    second.map((o) => `${o.event.detectionKey}|${o.conceptSlug}|${o.role}|${o.draft.success}`),
  );
});

test("every event draft says how sure it is, even when the answer is nothing", () => {
  // `detection_confidence` is nullable and the column existed unused. A
  // deterministic board fact has no meaningful confidence and says null; the
  // tactical families will use it to separate a consequence proven by a stored
  // line from one inferred from static exchange alone.
  const facts = game({
    positions: play(["e2e4", "e7e5"]),
    transitions: [0, 1].map((ply) => transition({
      fromPly: ply,
      actorColor: ply % 2 === 0 ? "white" : "black",
      playedMoveUci: ["e2e4", "e7e5"][ply]!,
    })),
  });
  for (const found of detectGame(facts)) {
    assert.ok(
      found.event.confidence === null
      || (found.event.confidence >= 0 && found.event.confidence <= 1),
      `${found.event.eventType} has a confidence the column's check would reject`,
    );
  }
});

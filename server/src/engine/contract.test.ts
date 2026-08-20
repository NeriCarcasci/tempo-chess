/**
 * `npm run engine:unit` — the deterministic half of E12, with no database and
 * no Stockfish.
 *
 * Everything here decides what a cached engine result *means*: which scope one
 * position's evidence must be computed at, what makes two searches the same
 * search, how an engine's centipawns become an expected score, and what a
 * decision loss is measured against. Each of those is a place where a plausible
 * shortcut produces a confident false claim about somebody's chess, so the
 * negative cases carry as much weight as the positive ones.
 */

import { strict as assert } from "node:assert";
import {
  BUDGETS,
  ENGINE_PROFILES,
  assessCandidates,
  evaluationCacheKey,
  expectedScore,
  fromActor,
  historySignature,
  isAcceptableLoss,
  isExactEvidenceScope,
  requiredScope,
  roundScore,
  scopeViolations,
  HASH_SHAPE,
  TOLERANCE_RULE,
  type EvaluationCacheKeyInput,
} from "./contract.js";
import { exactHistoryAt } from "./history.js";
import { buildAssessment, assessmentsChecksum } from "./assessments.js";
import type { StoredEvaluation } from "./evaluations.js";

let passed = 0;
const failures: string[] = [];

function check(name: string, body: () => string): void {
  try {
    console.log(`ok   ${name} — ${body()}`);
    passed += 1;
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    console.log(`FAIL ${name}`);
  }
}

console.log("cd server && npm run engine:unit\n");

// --- scope rules ------------------------------------------------------------

check("a first-time position needs the clock and nothing more", () => {
  assert.equal(requiredScope({ halfmoveClock: 3, repetitionCount: 1 }), "rule50");
  return "rule50 is the floor: a core result cannot know a draw is one move away";
});

check("a repeated position needs its history", () => {
  assert.equal(requiredScope({ halfmoveClock: 6, repetitionCount: 2 }), "history_exact");
  assert.equal(requiredScope({ halfmoveClock: 6, repetitionCount: 3 }), "history_exact");
  return "repetition is invisible to an engine that was not given the moves";
});

check("core is never exact evidence", () => {
  assert.equal(isExactEvidenceScope("core"), false);
  for (const scope of ["rule50", "history_exact", "occurrence"] as const) {
    assert.equal(isExactEvidenceScope(scope), true);
  }
  return "history-free results stay useful for comparison and unusable as proof";
});

check("a core-scoped evaluation cannot be built into an assessment", () => {
  assert.throws(
    () =>
      buildAssessment({
        fromPly: 0,
        playedUci: "e2e4",
        actorColor: "white",
        before: evaluation({ id: "1", scope: "core" }),
        after: evaluation({ id: "2" }),
        deep: null,
        deepStatus: "not_selected",
        deepSelectionReasons: [],
        phase: null,
      }),
    /core-scoped/,
  );
  return "the writer refuses it before the trigger has to";
});

check("a scope's qualifiers are required and forbidden, both ways", () => {
  assert.deepEqual(
    scopeViolations({ scope: "core", halfmoveClock: 4, historySignature: null, occurrence: null }),
    ["core must not carry halfmoveClock"],
  );
  assert.deepEqual(
    scopeViolations({ scope: "history_exact", halfmoveClock: 4, historySignature: null, occurrence: null }),
    ["history_exact requires historySignature"],
  );
  assert.deepEqual(
    scopeViolations({
      scope: "rule50",
      halfmoveClock: 4,
      historySignature: null,
      occurrence: { materializationRunId: "r", ply: 2 },
    }),
    ["rule50 must not carry an occurrence"],
  );
  return "a row cannot claim a scope it did not compute";
});

// --- the cache key ----------------------------------------------------------

const KEY: EvaluationCacheKeyInput = {
  corePositionKeyHash: "a".repeat(64),
  scope: "rule50",
  halfmoveClock: 3,
  historySignature: null,
  occurrence: null,
  profileContentHash: "b".repeat(64),
  calibrationContentHash: "c".repeat(64),
  limitType: "nodes",
  limitValue: 50_000,
  multipv: 1,
  threads: 1,
  hashMb: 64,
  tablebase: false,
  perspective: "white",
};

check("a cache key is a sha-256", () => {
  const key = evaluationCacheKey(KEY);
  assert.match(key, HASH_SHAPE);
  assert.equal(key, evaluationCacheKey({ ...KEY }));
  return "same inputs, same key, every time";
});

check("every compatibility-relevant input changes the key", () => {
  const base = evaluationCacheKey(KEY);
  const variants: Partial<EvaluationCacheKeyInput>[] = [
    { scope: "core", halfmoveClock: null },
    { halfmoveClock: 4 },
    { profileContentHash: "d".repeat(64) },
    { calibrationContentHash: "d".repeat(64) },
    { limitValue: 500_000 },
    { limitType: "depth" },
    { multipv: 3 },
    { threads: 2 },
    { hashMb: 128 },
    { tablebase: true },
    { perspective: "black" },
    { corePositionKeyHash: "e".repeat(64) },
  ];
  for (const variant of variants) {
    assert.notEqual(
      evaluationCacheKey({ ...KEY, ...variant }),
      base,
      `${Object.keys(variant).join(",")} did not change the key`,
    );
  }
  return `${variants.length} inputs, ${variants.length} distinct keys`;
});

check("a history-exact key follows its history", () => {
  const one = evaluationCacheKey({
    ...KEY,
    scope: "history_exact",
    historySignature: historySignature({ rootFen: "start", moves: ["g1f3", "g8f6"] }),
  });
  const other = evaluationCacheKey({
    ...KEY,
    scope: "history_exact",
    historySignature: historySignature({ rootFen: "start", moves: ["b1c3", "b8c6"] }),
  });
  assert.notEqual(one, other);
  return "two ways of reaching one board are two repetition situations";
});

check("a core result cannot masquerade as a rule50 one", () => {
  assert.notEqual(
    evaluationCacheKey({ ...KEY, scope: "core", halfmoveClock: null }),
    evaluationCacheKey(KEY),
  );
  return "the scope is in the key, so a lookup cannot cross the boundary";
});

// --- expected score ---------------------------------------------------------

check("the engine's own WDL is preferred", () => {
  const score = expectedScore({ scoreCp: 35, mateIn: null, wdl: [300, 650, 50] });
  assert.equal(score.method, "wdl");
  assert.equal(roundScore(score.value), 0.625);
  return "win plus half the draws, with no curve invented in between";
});

check("a forced mate is a decided game", () => {
  assert.deepEqual(expectedScore({ scoreCp: null, mateIn: 3, wdl: null }), { value: 1, method: "mate" });
  assert.deepEqual(expectedScore({ scoreCp: null, mateIn: -3, wdl: null }), { value: 0, method: "mate" });
  return "a logistic curve over a synthetic centipawn value would blur it";
});

check("centipawns without a WDL fall back to the named curve, and say so", () => {
  const score = expectedScore({ scoreCp: 0, mateIn: null, wdl: null });
  assert.equal(score.method, "logistic");
  assert.equal(score.value, 0.5);
  assert.ok(expectedScore({ scoreCp: 400, mateIn: null, wdl: null }).value > 0.9);
  return "the fallback is labelled, so no number's provenance is anonymous";
});

check("an engine value with nothing in it is refused", () => {
  assert.throws(() => expectedScore({ scoreCp: null, mateIn: null, wdl: null }), RangeError);
  return "an unanswerable position is not silently a draw";
});

check("perspective flips for the actor", () => {
  assert.equal(fromActor(0.7, "white"), 0.7);
  assert.equal(roundScore(fromActor(0.7, "black")), 0.3);
  return "one stored number, two truthful readings";
});

// --- the tolerance rule -----------------------------------------------------

check("acceptability is a stated threshold", () => {
  assert.equal(isAcceptableLoss(TOLERANCE_RULE.expectedScoreTolerance), true);
  assert.equal(isAcceptableLoss(TOLERANCE_RULE.expectedScoreTolerance + 0.0001), false);
  assert.equal(isAcceptableLoss(-0.01), true);
  return "a move that gained expected score is not an error";
});

check("a one-line search answers none of the candidate questions", () => {
  assert.deepEqual(assessCandidates([0.6]), {
    acceptableMoveCount: null,
    onlyMove: null,
    criticality: null,
  });
  return "null, not zero: a search that never looked found nothing to report";
});

check("an only move is one adequate move among several looked at", () => {
  const assessment = assessCandidates([0.8, 0.4, 0.2]);
  assert.equal(assessment.acceptableMoveCount, 1);
  assert.equal(assessment.onlyMove, true);
  assert.equal(assessment.criticality, 0.6);
  return "criticality is what a wrong choice costs, best minus worst";
});

check("several adequate moves is not an only move", () => {
  const assessment = assessCandidates([0.81, 0.8, 0.3]);
  assert.equal(assessment.acceptableMoveCount, 2);
  assert.equal(assessment.onlyMove, false);
  return "within the tolerance is within the tolerance";
});

// --- history reconstruction -------------------------------------------------

const CHAIN = {
  occurrences: [
    { ply: 0, fen: "start", halfmoveClock: 0, repetitionCount: 1 },
    { ply: 1, fen: "one", halfmoveClock: 1, repetitionCount: 1 },
    { ply: 2, fen: "two", halfmoveClock: 0, repetitionCount: 1 },
    { ply: 3, fen: "three", halfmoveClock: 1, repetitionCount: 1 },
    { ply: 4, fen: "four", halfmoveClock: 2, repetitionCount: 2 },
  ],
  transitions: [
    { fromPly: 0, uci: "g1f3" },
    { fromPly: 1, uci: "d7d5" },
    { fromPly: 2, uci: "f3g1" },
    { fromPly: 3, uci: "g8f6" },
  ],
};

check("the history window is the halfmove clock", () => {
  assert.deepEqual(exactHistoryAt(CHAIN, 4), { rootFen: "two", moves: ["f3g1", "g8f6"] });
  return "the position after the last irreversible move, plus the moves since";
});

check("a zero clock replays nothing", () => {
  assert.deepEqual(exactHistoryAt(CHAIN, 2), { rootFen: "two", moves: [] });
  return "a capture or pawn move makes every earlier position unreachable";
});

check("a clock older than the chain clamps to the chain's start", () => {
  // A replay that began from a FEN with an inherited clock: ply 0 already
  // carries 20, so the honest root is the first position Forma actually has.
  const inherited = {
    occurrences: [
      { ply: 0, fen: "zero", halfmoveClock: 20, repetitionCount: 1 },
      { ply: 1, fen: "one", halfmoveClock: 21, repetitionCount: 1 },
    ],
    transitions: [{ fromPly: 0, uci: "g1f3" }],
  };
  assert.deepEqual(exactHistoryAt(inherited, 1), { rootFen: "zero", moves: ["g1f3"] });
  return "a shorter history can only make the engine less sure of a repetition";
});

check("a root the chain does not contain is refused", () => {
  const truncated = {
    occurrences: [{ ply: 5, fen: "five", halfmoveClock: 40, repetitionCount: 1 }],
    transitions: [],
  };
  assert.throws(() => exactHistoryAt(truncated, 5), RangeError);
  return "replaying from the wrong position would misstate every later value";
});

check("a hole in the chain is refused", () => {
  const holed = {
    occurrences: CHAIN.occurrences,
    transitions: CHAIN.transitions.filter((transition) => transition.fromPly !== 2),
  };
  assert.throws(() => exactHistoryAt(holed, 4), RangeError);
  return "a silently shortened history would misstate the repetition";
});

// --- the assessment ---------------------------------------------------------

function evaluation(overrides: Partial<StoredEvaluation> = {}): StoredEvaluation {
  return {
    id: "1",
    cacheKey: "a".repeat(64),
    scope: "rule50",
    expectedScore: 0.5,
    scoreCp: 0,
    mateIn: null,
    bestMoveUci: "e2e4",
    multipv: 1,
    nodes: 50_000,
    candidateExpectedScores: [],
    candidateMoves: [],
    ...overrides,
  };
}

check("decision loss is actor-perspective and signed", () => {
  const row = buildAssessment({
    fromPly: 0,
    playedUci: "e2e4",
    actorColor: "white",
    before: evaluation({ id: "1", expectedScore: 0.6 }),
    after: evaluation({ id: "2", expectedScore: 0.45 }),
    deep: null,
    deepStatus: "not_selected",
    deepSelectionReasons: [],
    phase: "opening",
  });
  assert.equal(row.expectedScoreBefore, 0.6);
  assert.equal(row.expectedScoreAfter, 0.45);
  assert.equal(row.decisionLoss, 0.15);
  assert.equal(row.playedMoveAcceptable, false);
  return "0.15 given up, well past the 0.02 tolerance";
});

check("black's loss is measured from black's side", () => {
  const row = buildAssessment({
    fromPly: 1,
    playedUci: "e7e5",
    actorColor: "black",
    before: evaluation({ id: "1", expectedScore: 0.4 }),
    after: evaluation({ id: "2", expectedScore: 0.55 }),
    deep: null,
    deepStatus: "not_selected",
    deepSelectionReasons: [],
    phase: "opening",
  });
  assert.equal(row.expectedScoreBefore, 0.6);
  assert.equal(row.expectedScoreAfter, 0.45);
  assert.equal(row.decisionLoss, 0.15);
  return "the same stored numbers, read from the player who moved";
});

check("the deeper search answers the candidate questions when there is one", () => {
  const row = buildAssessment({
    fromPly: 2,
    playedUci: "b1c3",
    actorColor: "white",
    before: evaluation({ id: "1", expectedScore: 0.6, multipv: 1 }),
    after: evaluation({ id: "2", expectedScore: 0.59 }),
    deep: evaluation({
      id: "3",
      expectedScore: 0.6,
      multipv: 3,
      bestMoveUci: "d2d4",
      candidateMoves: ["d2d4", "b1c3", "g1f3"],
      candidateExpectedScores: [0.6, 0.59, 0.3],
    }),
    deepStatus: "completed",
    deepSelectionReasons: [{ code: "evaluation_swing", strength: 1, observed: 120 }],
    phase: "middlegame",
  });
  assert.equal(row.acceptableMoveCount, 2);
  assert.equal(row.onlyMove, false);
  assert.equal(row.criticality, 0.3);
  assert.equal(row.playedMoveRank, 2);
  assert.equal(row.bestMoveUci, "d2d4");
  assert.equal(row.difficultyFeatures.candidateSource, "deep");
  return "rank 2 of 3 retained lines, and the decision loss still from screening";
});

check("a move outside the retained lines has no rank", () => {
  const row = buildAssessment({
    fromPly: 3,
    playedUci: "h2h3",
    actorColor: "white",
    before: evaluation({
      id: "1",
      expectedScore: 0.6,
      multipv: 3,
      candidateMoves: ["d2d4", "b1c3"],
      candidateExpectedScores: [0.6, 0.59],
    }),
    after: evaluation({ id: "2", expectedScore: 0.4 }),
    deep: null,
    deepStatus: "not_selected",
    deepSelectionReasons: [],
    phase: "middlegame",
  });
  assert.equal(row.playedMoveRank, null);
  return "null means the engine never listed it, not that it came last";
});

check("an unavailable deeper look keeps its screening evidence", () => {
  const row = buildAssessment({
    fromPly: 4,
    playedUci: "e2e4",
    actorColor: "white",
    before: evaluation({ id: "1", expectedScore: 0.6 }),
    after: evaluation({ id: "2", expectedScore: 0.2 }),
    deep: null,
    deepStatus: "unavailable",
    deepSelectionReasons: [{ code: "evaluation_swing", strength: 4, observed: 400 }],
    phase: "middlegame",
  });
  assert.equal(row.deepEvaluationId, null);
  assert.equal(row.deepStatus, "unavailable");
  assert.equal(row.decisionLoss, 0.4);
  assert.equal(row.acceptableMoveCount, null);
  return "the measurement stands; the closer look is recorded as not obtained";
});

check("the assessment checksum is about conclusions, not row order", () => {
  const rows = [1, 0].map((ply) =>
    buildAssessment({
      fromPly: ply,
      playedUci: "e2e4",
      actorColor: "white",
      before: evaluation({ id: "1", expectedScore: 0.5 }),
      after: evaluation({ id: "2", expectedScore: 0.5 }),
      deep: null,
      deepStatus: "not_selected",
      deepSelectionReasons: [],
      phase: null,
    }),
  );
  assert.equal(assessmentsChecksum(rows), assessmentsChecksum([...rows].reverse()));
  assert.match(assessmentsChecksum(rows), HASH_SHAPE);
  return "a rerun that concluded the same thing hashes the same";
});

// --- budgets ----------------------------------------------------------------

check("the per-game node envelope matches the profiles it is built from", () => {
  assert.equal(
    BUDGETS.perGameNodes,
    80 * ENGINE_PROFILES.screening.limitValue + 12 * ENGINE_PROFILES.deep.limitValue,
  );
  assert.equal(ENGINE_PROFILES.screening.threads, 1);
  assert.equal(ENGINE_PROFILES.deep.threads, 1);
  return "one thread, so a cached result is reproducible rather than merely fast";
});

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  - ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);

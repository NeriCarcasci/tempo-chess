/**
 * `npm run models:unit` — the human-context invariants, offline.
 *
 * E14's acceptance criteria stated as assertions. The load-bearing ones are the
 * refusals: a slice nobody calibrated produces `unavailable`, a promotion with
 * no supported slice is refused, and no path anywhere turns a Stockfish number
 * into a human claim.
 */

import { strict as assert } from "node:assert";

import {
  CALIBRATED_RATING_CEILING,
  CALIBRATED_RATING_FLOOR,
  PROMOTION_THRESHOLDS,
  RATING_BANDS,
  ratingBandFor,
} from "./contract.js";
import {
  calibrationRowsFor,
  describeVerdict,
  evaluatePromotion,
  expectedCalibrationError,
  percentile,
  scoreSlice,
  type HoldoutOutcome,
} from "./calibration.js";
import {
  buildPracticalContext,
  isOutOfDomain,
  observeConcession,
  sliceKeyFor,
  type SupportedSlice,
} from "./practical.js";
import {
  DEFAULT_SAMPLING_POLICY,
  checkSplitRules,
  excludeStraddlingAccounts,
  groupBySlice,
  manifestHash,
  selectHoldoutPositions,
  type ReplayedGame,
} from "./holdout.js";
import {
  contextSatisfies,
  inferenceCacheKey,
  inputContractHash,
  normalizePolicy,
  type InferenceContext,
} from "./policy.js";

const failures: string[] = [];
let passed = 0;

function test(name: string, run: () => void): void {
  try {
    run();
    passed += 1;
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Rating bands
// ---------------------------------------------------------------------------

test("bands tile the calibrated range without gaps or overlap", () => {
  assert.equal(RATING_BANDS[0]!.low, CALIBRATED_RATING_FLOOR);
  assert.equal(RATING_BANDS.at(-1)!.high, CALIBRATED_RATING_CEILING);
  for (let i = 1; i < RATING_BANDS.length; i += 1) {
    assert.equal(RATING_BANDS[i]!.low, RATING_BANDS[i - 1]!.high);
  }
});

test("a rating outside the calibrated range has no band, not the nearest one", () => {
  assert.equal(ratingBandFor(CALIBRATED_RATING_FLOOR - 1), null);
  assert.equal(ratingBandFor(CALIBRATED_RATING_CEILING), null);
  assert.equal(ratingBandFor(Number.NaN), null);
  assert.deepEqual(ratingBandFor(1000), { low: 1000, high: 1100 });
  assert.deepEqual(ratingBandFor(1099), { low: 1000, high: 1100 });
  assert.deepEqual(ratingBandFor(1100), { low: 1100, high: 1200 });
  assert.deepEqual(ratingBandFor(2199), { low: 2100, high: 2200 });
});

// ---------------------------------------------------------------------------
// Policy normalization
// ---------------------------------------------------------------------------

test("truncation records the dropped mass instead of discarding it", () => {
  const raw = [
    { uci: "e2e4", probability: 0.4 },
    { uci: "d2d4", probability: 0.3 },
    { uci: "g1f3", probability: 0.2 },
    { uci: "c2c4", probability: 0.1 },
  ];
  const distribution = normalizePolicy(raw, 2);
  assert.equal(distribution.moves.length, 2);
  assert.ok(Math.abs(distribution.retainedMass - 0.7) < 1e-9);
  assert.ok(Math.abs(distribution.unretainedMass - 0.3) < 1e-9);
  assert.equal(distribution.entropyIsLowerBound, true);
});

test("a complete distribution reports no unretained mass and exact entropy", () => {
  const distribution = normalizePolicy([
    { uci: "e2e4", probability: 0.5 },
    { uci: "d2d4", probability: 0.5 },
  ]);
  assert.equal(distribution.unretainedMass, 0);
  assert.equal(distribution.entropyIsLowerBound, false);
  assert.ok(Math.abs(distribution.entropyBits - 1) < 1e-9);
});

test("truncated entropy is a lower bound on the untruncated entropy", () => {
  // Four equally likely moves have exactly 2 bits. Keeping two of them and
  // lumping the rest must not report more than that.
  const raw = [
    { uci: "e2e4", probability: 0.25 },
    { uci: "d2d4", probability: 0.25 },
    { uci: "g1f3", probability: 0.25 },
    { uci: "c2c4", probability: 0.25 },
  ];
  const full = normalizePolicy(raw, 4);
  const truncated = normalizePolicy(raw, 2);
  assert.ok(Math.abs(full.entropyBits - 2) < 1e-9);
  assert.ok(truncated.entropyBits <= full.entropyBits + 1e-12, "truncation raised entropy");
});

test("an unnormalized distribution is renormalized rather than trusted", () => {
  const distribution = normalizePolicy([
    { uci: "e2e4", probability: 2 },
    { uci: "d2d4", probability: 2 },
  ]);
  assert.ok(Math.abs(distribution.retainedMass - 1) < 1e-9);
  assert.ok(Math.abs(distribution.moves[0]!.probability - 0.5) < 1e-9);
});

test("ties break deterministically so a cache key stays stable", () => {
  const a = normalizePolicy([
    { uci: "d2d4", probability: 0.5 },
    { uci: "e2e4", probability: 0.5 },
  ]);
  const b = normalizePolicy([
    { uci: "e2e4", probability: 0.5 },
    { uci: "d2d4", probability: 0.5 },
  ]);
  assert.deepEqual(
    a.moves.map((m) => m.uci),
    b.moves.map((m) => m.uci),
  );
});

test("a policy with no mass is an error, not an empty distribution", () => {
  assert.throws(() => normalizePolicy([{ uci: "e2e4", probability: 0 }]), /no mass/);
  assert.throws(() => normalizePolicy([{ uci: "e9e9", probability: 1 }]), /not a UCI move/);
});

const baseContext: InferenceContext = {
  provider: "lichess",
  actorRating: 1450,
  opponentRating: 1470,
  speed: "blitz",
  clockBucket: null,
  hasMoveHistory: true,
};

test("a missing rating changes the cache key rather than defaulting", () => {
  const withRating = inferenceCacheKey({
    modelComponentVersionId: "m",
    modelContentHash: "h",
    corePositionKey: "p",
    outputKind: "human_policy",
    context: baseContext,
    retainedMoveLimit: 12,
  });
  const withoutRating = inferenceCacheKey({
    modelComponentVersionId: "m",
    modelContentHash: "h",
    corePositionKey: "p",
    outputKind: "human_policy",
    context: { ...baseContext, actorRating: null },
    retainedMoveLimit: 12,
  });
  assert.notEqual(withRating, withoutRating);
});

test("the retention limit is part of the cache key", () => {
  const twelve = inferenceCacheKey({
    modelComponentVersionId: "m",
    modelContentHash: "h",
    corePositionKey: "p",
    outputKind: "human_policy",
    context: baseContext,
    retainedMoveLimit: 12,
  });
  const four = inferenceCacheKey({
    modelComponentVersionId: "m",
    modelContentHash: "h",
    corePositionKey: "p",
    outputKind: "human_policy",
    context: baseContext,
    retainedMoveLimit: 4,
  });
  assert.notEqual(twelve, four, "reusing a 4-move inference as a 12-move one changes every bound");
});

test("the input contract hash ignores field order and nothing else", () => {
  assert.equal(
    inputContractHash({ name: "human_policy.v1", requires: ["speed", "actorRating"] }),
    inputContractHash({ name: "human_policy.v1", requires: ["actorRating", "speed"] }),
  );
  assert.notEqual(
    inputContractHash({ name: "human_policy.v1", requires: ["actorRating"] }),
    inputContractHash({ name: "human_policy.v2", requires: ["actorRating"] }),
  );
});

test("context completeness names what is missing", () => {
  const result = contextSatisfies(
    { ...baseContext, actorRating: null, speed: null },
    { requires: ["actorRating", "speed", "provider"] },
  );
  assert.equal(result.complete, false);
  assert.deepEqual([...result.missing].sort(), ["actorRating", "speed"]);
});

// ---------------------------------------------------------------------------
// Practical context
// ---------------------------------------------------------------------------

const slice: SupportedSlice = {
  id: "slice-1",
  provider: "lichess",
  speed: "blitz",
  ratingBandLow: 1400,
  ratingBandHigh: 1500,
  supported: true,
  modelComponentVersionId: "model-1",
};

const policy = normalizePolicy(
  [
    { uci: "e7e5", probability: 0.5 },
    { uci: "c7c5", probability: 0.2 },
    { uci: "e7e6", probability: 0.1 },
    { uci: "d7d5", probability: 0.1 },
    { uci: "g8f6", probability: 0.1 },
  ],
  3,
);

function practicalInput(overrides: Partial<Parameters<typeof buildPracticalContext>[0]> = {}) {
  return {
    promotedModelComponentVersionId: "model-1",
    slice,
    context: baseContext,
    requiredContextFields: ["provider", "speed", "actorRating"] as const,
    adequateReplies: ["e7e5", "c7c5"],
    bestReplyUci: "e7e5",
    policy,
    ...overrides,
  } as Parameters<typeof buildPracticalContext>[0];
}

test("with no promoted model every position is unavailable", () => {
  const result = buildPracticalContext(
    practicalInput({ promotedModelComponentVersionId: null }),
  );
  assert.equal(result.status, "unavailable");
  assert.equal(result.status === "unavailable" && result.reason, "no_promoted_model");
});

test("an uncalibrated slice is unavailable, not extrapolated from a nearby one", () => {
  const result = buildPracticalContext(practicalInput({ slice: undefined }));
  assert.equal(result.status === "unavailable" && result.reason, "slice_not_calibrated");
});

test("a slice recorded as unsupported is unavailable for its own reason", () => {
  const result = buildPracticalContext(
    practicalInput({ slice: { ...slice, supported: false } }),
  );
  assert.equal(result.status === "unavailable" && result.reason, "slice_unsupported");
});

test("a slice calibrated for a different model does not license this one", () => {
  const result = buildPracticalContext(
    practicalInput({ slice: { ...slice, modelComponentVersionId: "model-2" } }),
  );
  assert.equal(result.status === "unavailable" && result.reason, "slice_not_calibrated");
});

test("a required context field that is missing is unavailable, not defaulted", () => {
  const result = buildPracticalContext(
    practicalInput({ context: { ...baseContext, actorRating: null } }),
  );
  assert.equal(result.status === "unavailable" && result.reason, "context_incomplete");
});

test("a single-line search cannot supply an adequate set", () => {
  const result = buildPracticalContext(practicalInput({ adequateReplies: undefined }));
  assert.equal(result.status === "unavailable" && result.reason, "objective_candidates_missing");
});

test("a failed inference is unavailable, never a Stockfish substitute", () => {
  const result = buildPracticalContext(practicalInput({ policy: null }));
  assert.equal(result.status === "unavailable" && result.reason, "inference_failed");
});

test("the practical vector reports the interval, not one number", () => {
  const result = buildPracticalContext(practicalInput());
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  // Retained top three: e7e5 0.5, c7c5 0.2, e7e6 0.1. Adequate = e7e5, c7c5.
  assert.ok(Math.abs(result.adequateReplyProbability - 0.7) < 1e-9);
  assert.ok(Math.abs(result.unretainedProbabilityMass - 0.2) < 1e-9);
  assert.ok(Math.abs(result.practicalPressureUpper - 0.3) < 1e-9);
  assert.ok(Math.abs(result.practicalPressureLower - 0.1) < 1e-9);
  assert.ok(result.practicalPressureLower <= result.practicalPressureUpper);
  assert.equal(result.entropyIsLowerBound, true);
  assert.equal(result.bestRefutationUci, "e7e5");
  assert.equal(result.bestRefutationRank, 1);
});

test("a best reply the model never retained reports absence, not rank zero", () => {
  const result = buildPracticalContext(practicalInput({ bestReplyUci: "g8f6" }));
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.bestRefutationUci, null);
  assert.equal(result.bestRefutationRank, null);
  assert.equal(result.bestRefutationProbability, null);
});

test("pressure bounds coincide when nothing was dropped", () => {
  const complete = normalizePolicy([
    { uci: "e7e5", probability: 0.6 },
    { uci: "c7c5", probability: 0.4 },
  ]);
  const result = buildPracticalContext(practicalInput({ policy: complete }));
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.ok(Math.abs(result.practicalPressureUpper - result.practicalPressureLower) < 1e-9);
});

test("an empty adequate set is maximum pressure, not an error", () => {
  const result = buildPracticalContext(practicalInput({ adequateReplies: [] }));
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.equal(result.adequateReplyCount, 0);
  assert.equal(result.adequateReplyProbability, 0);
  assert.equal(result.practicalPressureUpper, 1);
});

test("a rating outside the cited band is flagged out of domain", () => {
  assert.equal(isOutOfDomain(baseContext, slice), false);
  assert.equal(isOutOfDomain({ ...baseContext, actorRating: 1600 }, slice), true);
  assert.equal(isOutOfDomain({ ...baseContext, actorRating: null }, slice), true);
  const result = buildPracticalContext(
    practicalInput({ context: { ...baseContext, actorRating: 1600 } }),
  );
  assert.equal(result.status === "available" && result.outOfDomain, true);
});

test("a slice key needs provider, speed and an in-range rating", () => {
  assert.deepEqual(sliceKeyFor(baseContext), {
    provider: "lichess",
    speed: "blitz",
    band: { low: 1400, high: 1500 },
  });
  assert.equal(sliceKeyFor({ ...baseContext, actorRating: 2400 }), null);
  assert.equal(sliceKeyFor({ ...baseContext, provider: null }), null);
});

// ---------------------------------------------------------------------------
// Concession is separate evidence
// ---------------------------------------------------------------------------

test("a game that ended has no concession, and no concession is not a failure", () => {
  assert.deepEqual(
    observeConcession({
      replyPlayed: false,
      replyWasAdequate: null,
      subjectExpectedScoreBefore: null,
      subjectExpectedScoreAfter: null,
    }),
    { opponentConceded: null, subjectCapitalized: null },
  );
});

test("an adequate reply is not a concession and raises no capitalization question", () => {
  assert.deepEqual(
    observeConcession({
      replyPlayed: true,
      replyWasAdequate: true,
      subjectExpectedScoreBefore: 0.5,
      subjectExpectedScoreAfter: 0.4,
    }),
    { opponentConceded: false, subjectCapitalized: null },
  );
});

test("a concession the subject did not use is recorded as such", () => {
  assert.deepEqual(
    observeConcession({
      replyPlayed: true,
      replyWasAdequate: false,
      subjectExpectedScoreBefore: 0.6,
      subjectExpectedScoreAfter: 0.4,
    }),
    { opponentConceded: true, subjectCapitalized: false },
  );
});

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function outcome(over: Partial<HoldoutOutcome> = {}): HoldoutOutcome {
  return {
    accountKey: "a1",
    playedUci: "e2e4",
    predictedUci: "e2e4",
    predictedProbability: 0.6,
    latencyMs: 10,
    ...over,
  };
}

test("a model that answered nothing has null accuracy, not zero", () => {
  const metrics = scoreSlice([
    outcome({ predictedUci: null, predictedProbability: null }),
    outcome({ predictedUci: null, predictedProbability: null }),
  ]);
  assert.equal(metrics.top1Accuracy, null);
  assert.equal(metrics.expectedCalibrationError, null);
  assert.equal(metrics.failureRate, 1);
});

test("failures count against the failure rate and not against accuracy", () => {
  const metrics = scoreSlice([
    outcome(),
    outcome(),
    outcome({ predictedUci: null, predictedProbability: null }),
  ]);
  assert.equal(metrics.answeredSize, 2);
  assert.equal(metrics.top1Accuracy, 1);
  assert.ok(Math.abs(metrics.failureRate - 1 / 3) < 1e-9);
});

test("distinct accounts are counted, not games", () => {
  const metrics = scoreSlice([
    outcome({ accountKey: "a1" }),
    outcome({ accountKey: "a1" }),
    outcome({ accountKey: "a2" }),
  ]);
  assert.equal(metrics.distinctAccounts, 2);
  assert.equal(metrics.sampleSize, 3);
});

test("a perfectly calibrated predictor has near-zero calibration error", () => {
  // Confidence 0.7 on 100 predictions, 70 of them correct.
  const predictions = Array.from({ length: 100 }, (_, i) => ({
    confidence: 0.7,
    correct: i < 70,
  }));
  const ece = expectedCalibrationError(predictions);
  assert.ok(ece !== null && ece < 1e-9, `expected ~0, got ${ece}`);
});

test("an overconfident predictor is caught by calibration error", () => {
  const predictions = Array.from({ length: 100 }, (_, i) => ({
    confidence: 0.95,
    correct: i < 50,
  }));
  const ece = expectedCalibrationError(predictions);
  assert.ok(ece !== null && Math.abs(ece - 0.45) < 1e-9, `expected 0.45, got ${ece}`);
});

test("confidence of exactly 1 lands in the top bin rather than off the end", () => {
  const ece = expectedCalibrationError([{ confidence: 1, correct: true }]);
  assert.equal(ece, 0);
});

test("percentile on an empty sample is null, not zero", () => {
  assert.equal(percentile([], 0.95), null);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10);
  assert.equal(percentile([5], 0.95), 5);
});

// ---------------------------------------------------------------------------
// The promotion gate
// ---------------------------------------------------------------------------

const goodDataset = { accountDisjoint: true, chronologicalSplit: true, licenceCleared: true };

function passingSlice(bandLow: number, count = PROMOTION_THRESHOLDS.minSliceSampleSize) {
  return {
    slice: {
      provider: "lichess" as const,
      speed: "blitz" as const,
      band: { low: bandLow, high: bandLow + 100 },
    },
    outcomes: Array.from({ length: count }, (_, i) =>
      outcome({
        accountKey: `a${i % PROMOTION_THRESHOLDS.minSliceAccounts}`,
        // 60% of predictions correct at stated confidence 0.6: accurate and
        // calibrated, which is the combination the gate is looking for.
        predictedUci: i % 10 < 6 ? "e2e4" : "d2d4",
        predictedProbability: 0.6,
      }),
    ),
  };
}

test("a promotion with enough calibrated slices is allowed", () => {
  const perSlice = Math.ceil(PROMOTION_THRESHOLDS.minTotalSampleSize / 2);
  const verdict = evaluatePromotion({
    slices: [passingSlice(1400, perSlice), passingSlice(1500, perSlice)],
    dataset: goodDataset,
  });
  assert.deepEqual(verdict.blockers, []);
  assert.equal(verdict.promote, true);
  assert.equal(verdict.supportedSliceCount, 2);
});

test("a holdout that is not account-disjoint blocks promotion outright", () => {
  const perSlice = Math.ceil(PROMOTION_THRESHOLDS.minTotalSampleSize / 2);
  const verdict = evaluatePromotion({
    slices: [passingSlice(1400, perSlice), passingSlice(1500, perSlice)],
    dataset: { ...goodDataset, accountDisjoint: false },
  });
  assert.equal(verdict.promote, false);
  assert.ok(verdict.blockers.some((b) => b.includes("account-disjoint")));
});

test("an uncleared licence blocks promotion however good the numbers are", () => {
  const perSlice = Math.ceil(PROMOTION_THRESHOLDS.minTotalSampleSize / 2);
  const verdict = evaluatePromotion({
    slices: [passingSlice(1400, perSlice), passingSlice(1500, perSlice)],
    dataset: { ...goodDataset, licenceCleared: false },
  });
  assert.equal(verdict.promote, false);
  assert.ok(verdict.blockers.some((b) => b.includes("licence")));
});

test("a tiny holdout is refused, and says so in positions rather than vibes", () => {
  const verdict = evaluatePromotion({
    slices: [passingSlice(1400, 10)],
    dataset: goodDataset,
  });
  assert.equal(verdict.promote, false);
  assert.ok(verdict.blockers.some((b) => b.includes("10 positions")));
  assert.equal(verdict.slices[0]!.supported, false);
  assert.ok(verdict.slices[0]!.reasons.some((r) => r.includes("below the")));
});

test("one player's games are not a calibrated slice", () => {
  const outcomes = Array.from({ length: PROMOTION_THRESHOLDS.minSliceSampleSize }, () =>
    outcome({ accountKey: "just-me" }),
  );
  const verdict = evaluatePromotion({
    slices: [
      {
        slice: { provider: "lichess", speed: "blitz", band: { low: 1400, high: 1500 } },
        outcomes,
      },
    ],
    dataset: goodDataset,
  });
  assert.equal(verdict.slices[0]!.supported, false);
  assert.ok(verdict.slices[0]!.reasons.some((r) => r.includes("accounts")));
});

test("an unsupported slice publishes no metrics for anyone to quote", () => {
  const verdict = evaluatePromotion({ slices: [passingSlice(1400, 10)], dataset: goodDataset });
  const rows = calibrationRowsFor(verdict);
  assert.equal(rows[0]!.supported, false);
  assert.equal(rows[0]!.top1Accuracy, null);
  assert.equal(rows[0]!.expectedCalibrationError, null);
  assert.equal(rows[0]!.brierScore, null);
  assert.ok(rows[0]!.unsupportedReason !== null && rows[0]!.unsupportedReason.length > 0);
});

test("no slices at all is a refusal with reasons, not an empty pass", () => {
  const verdict = evaluatePromotion({ slices: [], dataset: goodDataset });
  assert.equal(verdict.promote, false);
  assert.equal(verdict.totalSampleSize, 0);
  assert.ok(describeVerdict(verdict).startsWith("refuse:"));
});

test("an inaccurate model is refused even with a huge holdout", () => {
  const perSlice = Math.ceil(PROMOTION_THRESHOLDS.minTotalSampleSize / 2);
  const inaccurate = (bandLow: number) => ({
    slice: {
      provider: "lichess" as const,
      speed: "blitz" as const,
      band: { low: bandLow, high: bandLow + 100 },
    },
    outcomes: Array.from({ length: perSlice }, (_, i) =>
      outcome({
        accountKey: `a${i % PROMOTION_THRESHOLDS.minSliceAccounts}`,
        predictedUci: i % 10 < 1 ? "e2e4" : "d2d4",
        predictedProbability: 0.1,
      }),
    ),
  });
  const verdict = evaluatePromotion({
    slices: [inaccurate(1400), inaccurate(1500)],
    dataset: goodDataset,
  });
  assert.equal(verdict.promote, false);
  assert.ok(verdict.slices.every((s) => !s.supported));
});

// ---------------------------------------------------------------------------
// Holdout construction
// ---------------------------------------------------------------------------

function replayed(over: Partial<ReplayedGame> = {}): ReplayedGame {
  return {
    gameKey: "g1",
    provider: "lichess",
    speed: "blitz",
    playedAt: "2026-07-01T12:00:00Z",
    whiteAccountKey: "alice",
    blackAccountKey: "bob",
    whiteRating: 1450,
    blackRating: 1460,
    positions: Array.from({ length: 60 }, (_, ply) => ({
      ply,
      fen: `fen-${ply}`,
      legalMoveCount: 20,
      playedUci: "e2e4",
    })),
    ...over,
  };
}

test("book plies are not sampled: they measure memory, not choice", () => {
  const selected = selectHoldoutPositions(replayed());
  assert.ok(selected.every((p) => p.ply >= DEFAULT_SAMPLING_POLICY.minPly));
});

test("a position with one legal move has nothing to predict", () => {
  const game = replayed({
    positions: Array.from({ length: 60 }, (_, ply) => ({
      ply,
      fen: `fen-${ply}`,
      legalMoveCount: 1,
      playedUci: "e2e4",
    })),
  });
  assert.equal(selectHoldoutPositions(game).length, 0);
});

test("one game cannot dominate the corpus", () => {
  const selected = selectHoldoutPositions(replayed());
  assert.ok(selected.length <= DEFAULT_SAMPLING_POLICY.maxPositionsPerGame);
});

test("sampling is reproducible without carrying a seed", () => {
  const a = selectHoldoutPositions(replayed()).map((p) => p.ply);
  const b = selectHoldoutPositions(replayed()).map((p) => p.ply);
  assert.deepEqual(a, b);
});

test("a player outside the calibrated range contributes nothing", () => {
  const game = replayed({ whiteRating: 2600, blackRating: 2600 });
  assert.equal(selectHoldoutPositions(game).length, 0);
});

test("the manifest hash ignores order and notices a changed label", () => {
  const positions = selectHoldoutPositions(replayed());
  assert.equal(manifestHash(positions), manifestHash([...positions].reverse()));
  const tampered = [{ ...positions[0]!, playedUci: "d2d4" }, ...positions.slice(1)];
  assert.notEqual(manifestHash(positions), manifestHash(tampered));
});

test("a game before the training cutoff breaks the chronological rule", () => {
  const positions = selectHoldoutPositions(replayed({ playedAt: "2019-03-01T00:00:00Z" }));
  const rules = checkSplitRules(positions, "2020-01-01T00:00:00Z");
  assert.equal(rules.chronologicalSplit, false);
  assert.equal(rules.gamesBeforeCutoff, 1);
});

test("an empty corpus is not a passing chronological split", () => {
  assert.equal(checkSplitRules([], "2020-01-01T00:00:00Z").chronologicalSplit, false);
});

test("an account whose games straddle two bands is named and dropped", () => {
  const low = selectHoldoutPositions(replayed({ gameKey: "g1", whiteRating: 1450 }));
  const high = selectHoldoutPositions(
    replayed({ gameKey: "g2", whiteRating: 1650, blackAccountKey: "carol" }),
  );
  const all = [...low, ...high];
  const rules = checkSplitRules(all, "2020-01-01T00:00:00Z");
  assert.equal(rules.accountDisjoint, false);
  assert.deepEqual(rules.straddlingAccounts, ["alice"]);
  const kept = excludeStraddlingAccounts(all, rules.straddlingAccounts);
  assert.ok(kept.every((p) => p.moverAccountKey !== "alice"));
  assert.equal(checkSplitRules(kept, "2020-01-01T00:00:00Z").accountDisjoint, true);
});

test("slices are grouped by provider, speed and band", () => {
  const positions = selectHoldoutPositions(replayed());
  const groups = groupBySlice(positions);
  for (const [key, group] of groups) {
    assert.ok(key.startsWith("lichess:blitz:"));
    assert.ok(group.positions.length > 0);
  }
});

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`models:unit — ${failures.length} failed, ${passed} passed`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`models:unit — ${passed}/${passed} passed`);

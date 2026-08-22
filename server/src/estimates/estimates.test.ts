/**
 * `npm run estimates:unit` — E15's invariants, offline.
 *
 * The numerics are checked against values that can be derived by hand, and the
 * product rules are checked as refusals: a censored chance is never a failure,
 * an unreached phase produces no bin, an improvement is not claimed from a
 * point estimate, and prose that invents a number is held back.
 */

import { strict as assert } from "node:assert";

import {
  ALIGNMENT_POLICY,
  ESTIMATOR_POLICY,
  FINDING_POLICY,
  FRAMES,
  FINDING_TYPES,
  PHASE_CONTRAST_POLICY,
  SPECIFICITY_POLICY,
} from "./contract.js";
import {
  CONCEPT_CATALOGUE,
  describeConceptRole,
} from "../analysis/concepts/catalogue.js";
import { buildPhaseContrast } from "./phases.js";
import {
  binomialUpperTail,
  findConcentration,
  moveNumberOf,
  pickExample,
  sideOf,
  failuresOf,
  observedOf,
  successesOf,
  MOVE_BANDS,
  type Moment,
  type Phase,
} from "./specificity.js";
import { betaCdf, betaQuantile, logGamma, probabilityGreater } from "./beta.js";
import {
  compare,
  estimate,
  improvementClaim,
  summarizeCoverage,
  timeWeight,
  type Estimate,
  type Observation,
} from "./estimator.js";
import {
  alignTrajectory,
  measureRecovery,
  quantile,
  type TrajectoryGame,
} from "./trajectory.js";
import {
  controlFalseDiscovery,
  dedupeAcrossFrames,
  deriveCandidates,
  derivePhaseContrast,
  selectPublished,
  structuredInputHash,
  tierFor,
  type CandidateFinding,
  type DimensionInput,
} from "./findings.js";
import { checkRendering, renderTemplate, supportedNumbers } from "./render.js";

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

const near = (a: number, b: number, tolerance = 1e-6): boolean => Math.abs(a - b) < tolerance;

// ---------------------------------------------------------------------------
// Numerics
// ---------------------------------------------------------------------------

test("log-gamma matches known factorials", () => {
  assert.ok(near(logGamma(1), 0, 1e-9));
  assert.ok(near(logGamma(2), 0, 1e-9));
  assert.ok(near(Math.exp(logGamma(5)), 24, 1e-6), "gamma(5) is 4! = 24");
  assert.ok(near(logGamma(0.5), Math.log(Math.sqrt(Math.PI)), 1e-9));
});

test("the Beta CDF of a uniform is the identity", () => {
  for (const x of [0.01, 0.25, 0.5, 0.75, 0.99]) {
    assert.ok(near(betaCdf(x, 1, 1), x, 1e-9), `I_${x}(1,1) should be ${x}`);
  }
});

test("the Beta CDF obeys its reflection identity", () => {
  for (const [x, a, b] of [
    [0.3, 2, 5],
    [0.7, 4.5, 1.5],
    [0.1, 0.5, 0.5],
  ] as const) {
    assert.ok(near(betaCdf(x, a, b), 1 - betaCdf(1 - x, b, a), 1e-9));
  }
});

test("the quantile inverts the CDF", () => {
  for (const [a, b] of [
    [1, 1],
    [2, 5],
    [0.5, 0.5],
    [20, 3],
  ] as const) {
    for (const p of [0.05, 0.5, 0.95]) {
      const x = betaQuantile(p, a, b);
      assert.ok(near(betaCdf(x, a, b), p, 1e-8), `Beta(${a},${b}) quantile ${p}`);
    }
  }
});

test("two identical posteriors are equally likely to be greater", () => {
  const p = probabilityGreater({ alpha: 4, beta: 6 }, { alpha: 4, beta: 6 });
  assert.ok(near(p, 0.5, 1e-3), `expected 0.5, got ${p}`);
});

test("a clearly better posterior is clearly more likely to be greater", () => {
  const p = probabilityGreater({ alpha: 30, beta: 5 }, { alpha: 5, beta: 30 });
  assert.ok(p > 0.999, `expected near 1, got ${p}`);
});

// ---------------------------------------------------------------------------
// Time weighting and coverage
// ---------------------------------------------------------------------------

const CUTOFF = new Date("2026-08-01T00:00:00Z");
const daysBefore = (days: number): Date =>
  new Date(CUTOFF.getTime() - days * 24 * 60 * 60 * 1000);

test("an observation at the half-life is worth exactly half", () => {
  assert.ok(near(timeWeight(CUTOFF, CUTOFF), 1));
  assert.ok(near(timeWeight(daysBefore(ESTIMATOR_POLICY.halfLifeDays), CUTOFF), 0.5, 1e-9));
  assert.ok(near(timeWeight(daysBefore(2 * ESTIMATOR_POLICY.halfLifeDays), CUTOFF), 0.25, 1e-9));
});

test("evidence from after the cutoff is not worth more than full weight", () => {
  assert.equal(timeWeight(new Date(CUTOFF.getTime() + 86_400_000), CUTOFF), 1);
});

function obs(over: Partial<Observation> = {}): Observation {
  return { occurredAt: CUTOFF, score: 1, censored: false, graded: false, ...over };
}

test("coverage accounts for every observation exactly once", () => {
  const coverage = summarizeCoverage(
    [
      obs({ score: 1 }),
      obs({ score: 0 }),
      obs({ score: 0.5, graded: true }),
      obs({ censored: true, score: null }),
    ],
    CUTOFF,
  );
  assert.equal(coverage.raw, 4);
  assert.equal(coverage.success + coverage.failure + coverage.graded + coverage.censored, 4);
  assert.equal(coverage.censored, 1);
});

test("censored evidence carries no weight", () => {
  const coverage = summarizeCoverage([obs({ censored: true, score: null })], CUTOFF);
  assert.equal(coverage.effective, 0);
  assert.equal(coverage.failure, 0, "a censored chance was counted as a failure");
});

test("effective sample never exceeds raw sample", () => {
  const coverage = summarizeCoverage(
    [obs(), obs({ occurredAt: daysBefore(300) }), obs({ censored: true, score: null })],
    CUTOFF,
  );
  assert.ok(coverage.effective <= coverage.raw);
});

// ---------------------------------------------------------------------------
// The estimator
// ---------------------------------------------------------------------------

test("no observations is unavailable, not zero", () => {
  const result = estimate([], CUTOFF);
  assert.equal(result.status, "unavailable");
  assert.equal(result.status === "unavailable" && result.reason, "no_observations");
});

test("an estimate made only of censored chances is unavailable", () => {
  const result = estimate(
    Array.from({ length: 20 }, () => obs({ censored: true, score: null })),
    CUTOFF,
  );
  assert.equal(result.status === "unavailable" && result.reason, "all_evidence_censored");
});

test("too few uncensored observations is unavailable, not a wide guess", () => {
  const result = estimate([obs(), obs()], CUTOFF);
  assert.equal(result.status === "unavailable" && result.reason, "below_minimum_sample");
});

test("a player outside the calibrated band gets no peer estimate", () => {
  const result = estimate(
    Array.from({ length: 40 }, () => obs()),
    CUTOFF,
    { outsideCalibratedRange: true },
  );
  assert.equal(result.status === "unavailable" && result.reason, "outside_calibrated_range");
  assert.equal(result.coverageStatus, "out_of_range");
});

test("a perfect record does not produce a certainty", () => {
  const result = estimate(
    Array.from({ length: 10 }, () => obs({ score: 1 })),
    CUTOFF,
  );
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.ok(result.estimate < 1, "the estimate claimed certainty from ten observations");
  assert.ok(result.intervalLow < result.estimate);
  assert.ok(result.intervalHigh <= 1);
});

test("a spotless failure record does not produce a zero either", () => {
  const result = estimate(
    Array.from({ length: 10 }, () => obs({ score: 0 })),
    CUTOFF,
  );
  assert.equal(result.status, "available");
  if (result.status !== "available") return;
  assert.ok(result.estimate > 0, "the estimate claimed a flat zero");
});

test("the interval covers the estimate and narrows with evidence", () => {
  const small = estimate(Array.from({ length: 6 }, (_, i) => obs({ score: i % 2 })), CUTOFF);
  const large = estimate(Array.from({ length: 200 }, (_, i) => obs({ score: i % 2 })), CUTOFF);
  assert.equal(small.status, "available");
  assert.equal(large.status, "available");
  if (small.status !== "available" || large.status !== "available") return;
  for (const result of [small, large]) {
    assert.ok(result.intervalLow <= result.estimate && result.estimate <= result.intervalHigh);
  }
  const smallWidth = small.intervalHigh - small.intervalLow;
  const largeWidth = large.intervalHigh - large.intervalLow;
  assert.ok(largeWidth < smallWidth, "more evidence did not narrow the interval");
});

test("thin evidence is published as limited rather than as confident", () => {
  const result = estimate(Array.from({ length: 4 }, () => obs()), CUTOFF);
  assert.equal(result.status, "available");
  assert.equal(result.coverageStatus, "limited");
});

test("old evidence still counts, and counts less", () => {
  const recent = estimate(Array.from({ length: 20 }, () => obs({ score: 1 })), CUTOFF);
  const old = estimate(
    Array.from({ length: 20 }, () => obs({ score: 1, occurredAt: daysBefore(365) })),
    CUTOFF,
  );
  assert.equal(recent.status, "available");
  assert.equal(old.status, "available");
  if (recent.status !== "available" || old.status !== "available") return;
  assert.ok(old.coverage.effective > 0, "year-old evidence was deleted rather than discounted");
  assert.ok(old.coverage.effective < recent.coverage.effective);
  assert.ok(
    old.intervalHigh - old.intervalLow > recent.intervalHigh - recent.intervalLow,
    "older evidence produced a narrower interval",
  );
});

test("a graded partial is not a coin flip between two wrong labels", () => {
  const graded = estimate(
    Array.from({ length: 20 }, () => obs({ score: 0.5, graded: true })),
    CUTOFF,
  );
  assert.equal(graded.status, "available");
  if (graded.status !== "available") return;
  assert.ok(near(graded.estimate, 0.5, 0.05));
  assert.equal(graded.coverage.graded, 20);
  assert.equal(graded.coverage.success, 0);
  assert.equal(graded.coverage.failure, 0);
});

// ---------------------------------------------------------------------------
// Improvement
// ---------------------------------------------------------------------------

function available(successes: number, total: number, when = CUTOFF): Estimate {
  const result = estimate(
    Array.from({ length: total }, (_, i) => obs({ score: i < successes ? 1 : 0, occurredAt: when })),
    CUTOFF,
  );
  if (result.status !== "available") throw new Error("fixture did not produce an estimate");
  return result;
}

test("a better point estimate on thin evidence is not an improvement claim", () => {
  const earlier = available(2, 5);
  const later = available(4, 6);
  const comparison = compare(earlier, later);
  assert.ok(comparison.delta > 0);
  assert.equal(improvementClaim(comparison, later.coverage), null);
});

test("a large, well-evidenced gain is an established improvement", () => {
  const earlier = available(10, 50);
  const later = available(40, 50);
  const comparison = compare(earlier, later);
  assert.equal(improvementClaim(comparison, later.coverage), "established_improvement");
});

test("a decline is never an improvement claim", () => {
  const earlier = available(40, 50);
  const later = available(10, 50);
  assert.equal(improvementClaim(compare(earlier, later), later.coverage), null);
});

// ---------------------------------------------------------------------------
// Trajectory
// ---------------------------------------------------------------------------

function game(key: string, phases: { phase: "opening" | "middlegame" | "endgame"; plies: number; score: number }[]): TrajectoryGame {
  const points: TrajectoryGame["points"] = [];
  let ply = 0;
  for (const part of phases) {
    for (let i = 0; i < part.plies; i += 1) {
      points.push({ ply: ply++, phase: part.phase, expectedScore: part.score });
    }
  }
  return { gameKey: key, points };
}

test("an unreached phase produces no bins at all", () => {
  const bins = alignTrajectory([
    game("a", [
      { phase: "opening", plies: 20, score: 0.5 },
      { phase: "middlegame", plies: 30, score: 0.5 },
    ]),
  ]);
  assert.ok(bins.some((bin) => bin.phase === "opening"));
  assert.ok(bins.some((bin) => bin.phase === "middlegame"));
  assert.equal(bins.filter((bin) => bin.phase === "endgame").length, 0, "an endgame was imputed");
});

test("phase reach rate reports how many games got there", () => {
  const bins = alignTrajectory([
    game("a", [
      { phase: "opening", plies: 20, score: 0.5 },
      { phase: "endgame", plies: 20, score: 0.6 },
    ]),
    game("b", [{ phase: "opening", plies: 20, score: 0.5 }]),
  ]);
  const endgame = bins.filter((bin) => bin.phase === "endgame");
  assert.ok(endgame.length > 0);
  for (const bin of endgame) assert.ok(near(bin.phaseReachRate, 0.5));
  for (const bin of bins.filter((b) => b.phase === "opening")) {
    assert.ok(near(bin.phaseReachRate, 1));
  }
});

test("a long game and a short game weigh the same in a bin", () => {
  // One game sits at 0 for 100 plies, the other at 1 for 10. Equal weighting
  // puts the median at 0.5; weighting by ply would put it near 0.
  const bins = alignTrajectory([
    game("long", [{ phase: "middlegame", plies: 100, score: 0 }]),
    game("short", [{ phase: "middlegame", plies: 10, score: 1 }]),
  ]);
  const first = bins.find((bin) => bin.phase === "middlegame" && bin.binOrdinal === 0);
  assert.ok(first);
  assert.equal(first!.gamesContributing, 2);
  assert.ok(near(first!.medianExpectedScore, 0.5));
});

test("a phase too short to align is skipped rather than stretched", () => {
  const bins = alignTrajectory([
    game("a", [
      { phase: "opening", plies: 20, score: 0.5 },
      { phase: "endgame", plies: 1, score: 0.9 },
    ]),
  ]);
  assert.equal(bins.filter((bin) => bin.phase === "endgame").length, 0);
});

test("every bin has games in it, and percentiles are ordered", () => {
  const bins = alignTrajectory([
    game("a", [{ phase: "middlegame", plies: 40, score: 0.3 }]),
    game("b", [{ phase: "middlegame", plies: 40, score: 0.7 }]),
    game("c", [{ phase: "middlegame", plies: 40, score: 0.5 }]),
  ]);
  for (const bin of bins) {
    assert.ok(bin.gamesContributing > 0);
    assert.ok(bin.p25ExpectedScore <= bin.medianExpectedScore);
    assert.ok(bin.medianExpectedScore <= bin.p75ExpectedScore);
    assert.ok(bin.phaseReachRate > 0 && bin.phaseReachRate <= 1);
  }
});

test("the bootstrap interval is reproducible", () => {
  const games = [
    game("a", [{ phase: "middlegame", plies: 40, score: 0.3 }]),
    game("b", [{ phase: "middlegame", plies: 40, score: 0.7 }]),
    game("c", [{ phase: "middlegame", plies: 40, score: 0.5 }]),
  ];
  const first = alignTrajectory(games, { seed: 7 });
  const second = alignTrajectory(games, { seed: 7 });
  assert.deepEqual(first, second, "a stored interval changed between two identical runs");
});

test("bins never exceed the policy's count per phase", () => {
  const bins = alignTrajectory([game("a", [{ phase: "middlegame", plies: 400, score: 0.5 }])]);
  const ordinals = bins.filter((b) => b.phase === "middlegame").map((b) => b.binOrdinal);
  assert.ok(Math.max(...ordinals) < ALIGNMENT_POLICY.binsPerPhase);
});

test("quantiles interpolate rather than snap to a sample point", () => {
  assert.ok(near(quantile([0, 1], 0.5), 0.5));
  assert.ok(near(quantile([0, 1, 2, 3], 0.25), 0.75));
});

// ---------------------------------------------------------------------------
// Recovery is the player's, not the opponent's
// ---------------------------------------------------------------------------

test("a gain that came from the opponent's errors is flagged as theirs", () => {
  const measurement = measureRecovery({
    beforeScore: 0.6,
    troughScore: 0.2,
    endScore: 0.5,
    subjectPlies: 10,
    counterpartyGain: 0.3,
  });
  assert.equal(measurement.counterpartyDriven, true);
  assert.ok(near(measurement.adverseChange, 0.4), "the original blunder was rewritten");
});

test("a genuine rebuild is the player's own", () => {
  const measurement = measureRecovery({
    beforeScore: 0.6,
    troughScore: 0.2,
    endScore: 0.5,
    subjectPlies: 10,
    counterpartyGain: 0,
  });
  assert.equal(measurement.counterpartyDriven, false);
  assert.ok(measurement.recoverySlope !== null && measurement.recoverySlope > 0);
  assert.equal(measurement.stabilized, true);
});

test("the original adverse change survives any recovery", () => {
  const measurement = measureRecovery({
    beforeScore: 0.9,
    troughScore: 0.1,
    endScore: 0.95,
    subjectPlies: 20,
    counterpartyGain: 0,
  });
  assert.ok(near(measurement.adverseChange, 0.8), "a blunder stopped being a blunder");
});

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

function moment(over: Partial<Moment> = {}): Moment {
  return {
    gameId: "game-a",
    ply: 30,
    phase: "middlegame",
    openingFamily: null,
    occurredAt: CUTOFF,
    censored: false,
    success: true,
    playedMoveUci: "g1f3",
    bestMoveUci: "d1d8",
    departurePly: null,
    openingName: null,
    evidenceItemId: "1",
    ...over,
  };
}

/**
 * A subset and a reference that differ only in where the failures fell.
 *
 * `inBucket` failures land in the named phase, `elsewhere` failures land in the
 * other two, and the reference carries the same chances plus the successes that
 * make the baseline share what it is.
 */
function spread(options: {
  bucket: Phase;
  bucketFailures: number;
  bucketSuccesses: number;
  otherFailures: number;
  otherSuccesses: number;
}): { subject: Moment[]; reference: Moment[] } {
  const others: Phase[] = (["opening", "middlegame", "endgame"] as Phase[]).filter(
    (phase) => phase !== options.bucket,
  );
  const reference: Moment[] = [];
  let index = 0;
  const push = (phase: Phase, success: boolean): void => {
    reference.push(
      moment({
        gameId: `game-${index}`,
        ply: 30,
        phase,
        success,
        occurredAt: new Date(CUTOFF.getTime() - index * 86_400_000),
      }),
    );
    index += 1;
  };
  for (let i = 0; i < options.bucketFailures; i += 1) push(options.bucket, false);
  for (let i = 0; i < options.bucketSuccesses; i += 1) push(options.bucket, true);
  for (let i = 0; i < options.otherFailures; i += 1) push(others[i % 2]!, false);
  for (let i = 0; i < options.otherSuccesses; i += 1) push(others[i % 2]!, true);
  return { subject: failuresOf(reference), reference: observedOf(reference) };
}

function candidate(over: Partial<CandidateFinding> = {}): CandidateFinding {
  return {
    dimensionKey: "d0",
    findingType: "strength",
    claimFamily: "concept_success",
    conceptSlug: "material_safety",
    role: "respond",
    frame: "objective",
    rawProbability: 0.99,
    adjustedProbability: null,
    confidenceTier: "low",
    priority: 50,
    weight: 1,
    claim: {},
    context: {},
    published: false,
    droppedReason: null,
    ...over,
  };
}

function dimension(over: Partial<DimensionInput> = {}): DimensionInput {
  return {
    dimensionKey: "material_safety_respond_objective",
    frame: "objective",
    conceptSlug: "material_safety",
    role: "respond",
    claimFamily: "concept_success",
    result: available(45, 50),
    comparison: null,
    failureCount: 0,
    description: describeConceptRole("material_safety", "respond"),
    moments: [],
    ...over,
  };
}

test("an unavailable estimate becomes an insufficient-evidence finding", () => {
  const candidates = deriveCandidates(dimension({ result: estimate([], CUTOFF) }));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.findingType, "insufficient_evidence");
  assert.equal(candidates[0]!.published, true, "a coverage gap was withheld from the user");
});

test("a confident high estimate is a strength", () => {
  const candidates = deriveCandidates(dimension({ result: available(90, 100) }));
  assert.ok(candidates.some((c) => c.findingType === "strength"));
});

test("a confident low estimate is a foundational miss", () => {
  const candidates = deriveCandidates(dimension({ result: available(5, 100) }));
  assert.ok(candidates.some((c) => c.findingType === "foundational_miss"));
});

test("one dimension yields at most one verdict", () => {
  const verdicts = deriveCandidates(dimension({ result: available(90, 100) })).filter((c) =>
    ["strength", "foundational_miss", "development_frontier"].includes(c.findingType),
  );
  assert.equal(verdicts.length, 1);
});

test("a claim's probability is the posterior probability it is true", () => {
  // 90 of 100: the posterior sits far above the 0.7 strength floor, so the
  // claim is near-certain. A width-based proxy would have called this 0.86.
  const strong = deriveCandidates(dimension({ result: available(90, 100) })).find(
    (c) => c.findingType === "strength",
  );
  assert.ok(strong);
  assert.ok(strong!.rawProbability > 0.99, `expected near 1, got ${strong!.rawProbability}`);

  // 72 of 100 sits just above the floor: the same verdict, far less certain.
  const marginal = deriveCandidates(dimension({ result: available(75, 100) })).find(
    (c) => c.findingType === "strength",
  );
  if (marginal) {
    assert.ok(
      marginal.rawProbability < strong!.rawProbability,
      "a marginal strength was as certain as a clear one",
    );
  }
});

test("four failures inside a strong record are not a repeated pattern", () => {
  const candidates = deriveCandidates(
    dimension({ result: available(96, 100), failureCount: 4 }),
  );
  const pattern = candidates.find((c) => c.findingType === "repeated_pattern");
  assert.ok(pattern, "the candidate was not derived at all");
  assert.ok(
    pattern!.rawProbability < 0.05,
    `a pattern claim inside a 96% record scored ${pattern!.rawProbability}`,
  );
  const controlled = controlFalseDiscovery(candidates);
  assert.equal(
    controlled.find((c) => c.findingType === "repeated_pattern")!.published,
    false,
    "noise inside a strong record was published as a pattern",
  );
});

test("repeated failures of one concept are their own finding", () => {
  const candidates = deriveCandidates(
    dimension({ result: available(20, 60), failureCount: FINDING_POLICY.repeatedPatternFailures }),
  );
  assert.ok(candidates.some((c) => c.findingType === "repeated_pattern"));
});

test("false-discovery control drops the weakest of many claims", () => {
  const candidates: CandidateFinding[] = Array.from({ length: 20 }, (_, i) =>
    candidate({
      dimensionKey: `d${i}`,
      conceptSlug: `c${i}`,
      // One strong claim among nineteen marginal ones.
      rawProbability: i === 0 ? 0.999 : 0.55,
    }),
  );
  const controlled = controlFalseDiscovery(candidates);
  assert.equal(controlled.filter((c) => c.published).length, 1);
  assert.equal(controlled.find((c) => c.dimensionKey === "d0")!.published, true);
  for (const dropped of controlled.filter((c) => !c.published)) {
    assert.ok(dropped.droppedReason && dropped.droppedReason.length > 0);
  }
});

test("coverage gaps are exempt from correction and from the display cap", () => {
  const gaps: CandidateFinding[] = Array.from({ length: 30 }, (_, i) =>
    candidate({
      dimensionKey: `gap${i}`,
      conceptSlug: `c${i}`,
      findingType: "insufficient_evidence",
      rawProbability: 1,
      priority: 10,
      published: true,
    }),
  );
  const { published } = selectPublished(controlFalseDiscovery(gaps));
  assert.equal(published.length, 30, "coverage gaps were capped away");
});

test("the display cap bounds real claims and says what it withheld", () => {
  const claims: CandidateFinding[] = Array.from({ length: 40 }, (_, i) =>
    candidate({
      dimensionKey: `d${i}`,
      conceptSlug: `c${i}`,
      rawProbability: 0.999,
      adjustedProbability: 0.99,
      confidenceTier: "high",
      published: true,
    }),
  );
  const { published, withheld } = selectPublished(claims);
  assert.equal(published.length, FINDING_POLICY.maxPublishedFindings);
  assert.equal(withheld.length, 40 - FINDING_POLICY.maxPublishedFindings);
  for (const item of withheld) assert.ok(item.droppedReason?.includes("cap"));
});

test("what is published is ranked by how much of it there is, not alphabetically", () => {
  // Same type, same certainty after correction. Before, the tie fell through to
  // the dimension key, so "you missed the only move twice" outranked "you lost
  // material twenty-nine times" because `a` sorts before `m`.
  const claims: CandidateFinding[] = [
    candidate({ dimensionKey: "a_rare", conceptSlug: "a", weight: 2, published: true, adjustedProbability: 0.99 }),
    candidate({ dimensionKey: "m_common", conceptSlug: "m", weight: 29, published: true, adjustedProbability: 0.99 }),
  ];
  const { published } = selectPublished(claims);
  assert.equal(published[0]!.dimensionKey, "m_common");
});

test("the published priority is a total order, not a per-type constant", () => {
  const claims: CandidateFinding[] = Array.from({ length: 4 }, (_, i) =>
    candidate({
      dimensionKey: `d${i}`,
      conceptSlug: `c${i}`,
      weight: 10 - i,
      published: true,
      adjustedProbability: 0.99,
    }),
  );
  const priorities = selectPublished(claims).published.map((c) => c.priority);
  assert.equal(new Set(priorities).size, priorities.length, "two findings shared a priority");
  for (let i = 1; i < priorities.length; i += 1) {
    assert.ok(priorities[i - 1]! > priorities[i]!, "the ranking was not strictly descending");
  }
});

test("the structured-input hash ignores key order and notices a changed fact", () => {
  const a = structuredInputHash({
    findingType: "strength",
    claim: { estimate: 0.8, dimension: "fork" },
    evidenceIds: [2, 1],
  });
  const b = structuredInputHash({
    findingType: "strength",
    claim: { dimension: "fork", estimate: 0.8 },
    evidenceIds: [1, 2],
  });
  const c = structuredInputHash({
    findingType: "strength",
    claim: { dimension: "fork", estimate: 0.81 },
    evidenceIds: [1, 2],
  });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

// ---------------------------------------------------------------------------
// Specificity: whether a finding may say where it happens
// ---------------------------------------------------------------------------

test("a move number is the move a player would call it", () => {
  assert.equal(moveNumberOf(0), 1, "ply 0 is White's first move");
  assert.equal(moveNumberOf(1), 1, "ply 1 is Black's reply to move 1");
  assert.equal(moveNumberOf(2), 2);
  assert.equal(moveNumberOf(45), 23);
  assert.equal(sideOf(0), "white");
  assert.equal(sideOf(45), "black");
});

test("the binomial tail matches values that can be checked by hand", () => {
  // P(X >= 1 | 1, p) is p, and P(X >= n | n, p) is p^n.
  assert.ok(near(binomialUpperTail(1, 1, 0.3), 0.3, 1e-9));
  assert.ok(near(binomialUpperTail(3, 3, 0.5), 0.125, 1e-9));
  // P(X >= 1 | 4, 0.5) is 1 - 0.5^4.
  assert.ok(near(binomialUpperTail(1, 4, 0.5), 1 - 0.0625, 1e-9));
  assert.equal(binomialUpperTail(0, 10, 0.5), 1, "at least zero always happens");
  assert.equal(binomialUpperTail(11, 10, 0.5), 0, "more than everything never happens");
});

test("a handful of failures is never a concentration, however lopsided", () => {
  const { subject, reference } = spread({
    bucket: "endgame",
    bucketFailures: 5,
    bucketSuccesses: 0,
    otherFailures: 1,
    otherSuccesses: 40,
  });
  assert.ok(subject.length < SPECIFICITY_POLICY.minSubjectSize);
  assert.equal(findConcentration(subject, reference), null);
});

test("failures spread the way the chances are spread name nowhere", () => {
  // The trap: most chances occur in the middlegame, so most failures do too.
  // Saying "your problem is the middlegame" here is a fact about chess.
  const { subject, reference } = spread({
    bucket: "middlegame",
    bucketFailures: 30,
    bucketSuccesses: 30,
    otherFailures: 20,
    otherSuccesses: 20,
  });
  const found = findConcentration(subject, reference);
  assert.equal(found, null, `claimed ${found?.label} from an even failure rate`);
});

test("failures that really bunch are named, with the count behind them", () => {
  const { subject, reference } = spread({
    bucket: "endgame",
    bucketFailures: 24,
    bucketSuccesses: 6,
    otherFailures: 10,
    otherSuccesses: 50,
  });
  const found = findConcentration(subject, reference);
  assert.ok(found, "a two-to-one difference in failure rate was not found");
  assert.equal(found!.kind, "phase");
  assert.equal(found!.label, "the endgame");
  assert.equal(found!.count, 24);
  assert.equal(found!.total, subject.length);
  assert.ok(found!.count / found!.total / found!.baselineShare >= SPECIFICITY_POLICY.minLiftRatio);
});

test("a bucket that holds nearly every chance is refused rather than named", () => {
  const { subject, reference } = spread({
    bucket: "middlegame",
    bucketFailures: 40,
    bucketSuccesses: 50,
    otherFailures: 1,
    otherSuccesses: 4,
  });
  assert.ok(subject.length >= SPECIFICITY_POLICY.minSubjectSize);
  const found = findConcentration(subject, reference);
  assert.equal(found, null, "named a phase that contains almost all of the chances");
});

test("censored chances are never evidence of a location", () => {
  const moments = [
    ...Array.from({ length: 20 }, (_, i) =>
      moment({ gameId: `g${i}`, phase: "endgame", censored: true, success: null }),
    ),
    ...Array.from({ length: 9 }, (_, i) =>
      moment({ gameId: `h${i}`, phase: "opening", success: false }),
    ),
    ...Array.from({ length: 30 }, (_, i) =>
      moment({ gameId: `k${i}`, phase: "opening", success: true }),
    ),
  ];
  assert.equal(failuresOf(moments).length, 9);
  assert.equal(successesOf(moments).length, 30);
  assert.equal(observedOf(moments).length, 39, "a censored chance was counted as evidence");
  // The endgame holds twenty of the sixty-nine recorded chances and none of the
  // evidence. It must not be reachable as a location.
  const found = findConcentration(failuresOf(moments), observedOf(moments));
  assert.ok(found === null || found.key !== "endgame");
});

test("move bands are the five fixed ones, and the last is open", () => {
  assert.equal(MOVE_BANDS.length, 5);
  assert.equal(MOVE_BANDS[0]!.low, 1);
  assert.equal(MOVE_BANDS[4]!.high, null, "the last band must not stop at move 40");
  for (let i = 1; i < MOVE_BANDS.length; i += 1) {
    assert.equal(MOVE_BANDS[i]!.low, MOVE_BANDS[i - 1]!.high! + 1, "the bands leave a gap");
  }
});

test("a move band is claimed only when the failures land in it", () => {
  const reference: Moment[] = [];
  for (let i = 0; i < 60; i += 1) {
    // Chances are spread evenly over the first sixty moves; failures are not.
    const ply = i * 2;
    const inBand = moveNumberOf(ply) >= 11 && moveNumberOf(ply) <= 20;
    reference.push(
      moment({
        gameId: `g${i}`,
        ply,
        phase: "middlegame",
        success: inBand ? i % 6 !== 0 && false : i % 5 !== 0,
        occurredAt: new Date(CUTOFF.getTime() - i * 86_400_000),
      }),
    );
  }
  const found = findConcentration(failuresOf(reference), observedOf(reference));
  assert.ok(found, "a band holding every failure was not found");
  assert.equal(found!.kind, "move_band");
  assert.equal(found!.label, "moves 11 to 20");
  assert.equal(found!.moveBand?.low, 11);
  assert.equal(found!.moveBand?.high, 20);
});

test("an opening name with a digit in it is not used as a location", () => {
  // The renderer holds back any number the claim does not support, and it
  // cannot tell "4.O-O" from a statistic. A family it cannot quote is dropped
  // rather than smuggled through by loosening the check.
  const reference: Moment[] = [];
  for (let i = 0; i < 40; i += 1) {
    reference.push(
      moment({
        gameId: `g${i}`,
        ply: 14,
        phase: "opening",
        openingFamily: i < 24 ? "Ruy Lopez, Berlin 4.O-O" : "French Defense",
        success: i < 24 ? false : true,
      }),
    );
  }
  const found = findConcentration(failuresOf(reference), observedOf(reference));
  assert.ok(
    found === null || found.kind !== "opening_family",
    "quoted an opening family containing a digit",
  );
});

test("the example is the most recent moment inside the concentration", () => {
  const inside = moment({
    gameId: "recent",
    phase: "endgame",
    success: false,
    occurredAt: new Date(CUTOFF.getTime() - 86_400_000),
  });
  const older = moment({
    gameId: "older",
    phase: "endgame",
    success: false,
    occurredAt: new Date(CUTOFF.getTime() - 30 * 86_400_000),
  });
  const outside = moment({
    gameId: "outside",
    phase: "opening",
    success: false,
    occurredAt: CUTOFF,
  });
  const concentration = findConcentration(
    ...(() => {
      const { subject, reference } = spread({
        bucket: "endgame",
        bucketFailures: 24,
        bucketSuccesses: 6,
        otherFailures: 10,
        otherSuccesses: 50,
      });
      return [subject, reference] as const;
    })(),
  )!;
  assert.ok(concentration);
  const picked = pickExample([outside, older, inside], concentration);
  assert.equal(picked?.gameId, "recent", "the example contradicted the sentence above it");
});

test("choosing an example is deterministic when two moments share an instant", () => {
  const a = moment({ gameId: "b-game", ply: 10, success: false });
  const b = moment({ gameId: "a-game", ply: 10, success: false });
  assert.equal(pickExample([a, b], null)?.gameId, pickExample([b, a], null)?.gameId);
});

// ---------------------------------------------------------------------------
// Phase as a dimension of its own
// ---------------------------------------------------------------------------

function stratum(n: number, successes: number): Observation[] {
  return Array.from({ length: n }, (_, i) => ({
    occurredAt: CUTOFF,
    score: i < successes ? 1 : 0,
    censored: false,
    graded: false,
  }));
}

test("two phases are not compared on concepts only one of them has", () => {
  const strata = new Map<Phase, Map<string, Observation[]>>([
    ["opening", new Map([["material_safety_respond", stratum(60, 24)]])],
    // The endgame's chances are a concept the opening never sees, so there is
    // nothing to compare and the pooled rates are not comparable either.
    ["endgame", new Map([["winning_conversion_convert", stratum(60, 48)]])],
  ]);
  assert.equal(buildPhaseContrast(strata, CUTOFF), null);
});

test("a small difference between phases is not worth telling anybody", () => {
  const strata = new Map<Phase, Map<string, Observation[]>>([
    [
      "opening",
      new Map([
        ["a_respond", stratum(400, 200)],
        ["b_recognize", stratum(400, 200)],
      ]),
    ],
    [
      "endgame",
      new Map([
        ["a_respond", stratum(400, 212)],
        ["b_recognize", stratum(400, 212)],
      ]),
    ],
  ]);
  const contrast = buildPhaseContrast(strata, CUTOFF);
  assert.equal(contrast, null, "published a three-point gap as a finding");
});

test("a real spread between phases is found, on shared kinds of chance only", () => {
  const strata = new Map<Phase, Map<string, Observation[]>>([
    [
      "opening",
      new Map([
        ["material_safety_respond", stratum(900, 396)],
        ["free_material_recognize", stratum(460, 212)],
        ["opening_only_thing", stratum(200, 100)],
      ]),
    ],
    [
      "middlegame",
      new Map([
        ["material_safety_respond", stratum(2600, 1404)],
        ["free_material_recognize", stratum(1400, 770)],
      ]),
    ],
    [
      "endgame",
      new Map([
        ["material_safety_respond", stratum(700, 469)],
        ["free_material_recognize", stratum(300, 198)],
        ["winning_conversion_convert", stratum(300, 240)],
      ]),
    ],
  ]);
  const contrast = buildPhaseContrast(strata, CUTOFF);
  assert.ok(contrast, "a twenty-point spread over thousands of chances was not found");
  assert.equal(contrast!.weakest, "opening");
  assert.equal(contrast!.strongest, "endgame");
  assert.deepEqual(
    [...contrast!.sharedStrata],
    ["free_material_recognize", "material_safety_respond"],
    "a concept only one phase has was pooled into the comparison",
  );
  assert.equal(contrast!.comparedPairs, 3);
  assert.ok(contrast!.probability > 0.99);
  // The estimate is over the shared strata, so it excludes the 200 opening-only
  // chances. Anything larger means an unshared stratum leaked in.
  assert.equal(contrast!.weakestEstimate.coverage.raw, 1360);
});

test("the phase contrast is corrected for having looked at every pair", () => {
  const strata = new Map<Phase, Map<string, Observation[]>>([
    [
      "opening",
      new Map([
        ["a_respond", stratum(40, 14)],
        ["b_recognize", stratum(40, 14)],
      ]),
    ],
    [
      "endgame",
      new Map([
        ["a_respond", stratum(40, 22)],
        ["b_recognize", stratum(40, 22)],
      ]),
    ],
  ]);
  const contrast = buildPhaseContrast(strata, CUTOFF)!;
  assert.ok(contrast);
  assert.equal(contrast.comparedPairs, 1, "only one pair was comparable");
  const wider = new Map(strata);
  wider.set(
    "middlegame",
    new Map([
      ["a_respond", stratum(40, 18)],
      ["b_recognize", stratum(40, 18)],
    ]),
  );
  const corrected = buildPhaseContrast(wider, CUTOFF)!;
  assert.equal(corrected.comparedPairs, 3);
  assert.ok(
    corrected.probability < contrast.probability,
    "searching three pairs was as cheap as searching one",
  );
});

test("the phase contrast is an inconsistency finding, ranked above the rest", () => {
  const strata = new Map<Phase, Map<string, Observation[]>>([
    [
      "opening",
      new Map([
        ["a_respond", stratum(400, 176)],
        ["b_recognize", stratum(400, 180)],
      ]),
    ],
    [
      "endgame",
      new Map([
        ["a_respond", stratum(400, 268)],
        ["b_recognize", stratum(400, 264)],
      ]),
    ],
  ]);
  const contrast = buildPhaseContrast(strata, CUTOFF)!;
  const finding = derivePhaseContrast({
    contrast,
    sharedConceptLabels: ["Keeping your pieces safe", "Taking what is offered"],
    claimFamily: "phase_contrast",
  });
  assert.equal(finding.findingType, "inconsistency");
  assert.ok(finding.priority > 90, "the largest true thing in the report was ranked below a verdict");
  const text = renderTemplate({ findingType: finding.findingType, claim: finding.claim });
  assert.equal(checkRendering(text, finding.claim).state, "passed", text);
  assert.ok(text.includes("the opening") && text.includes("the endgame"), text);
});

// ---------------------------------------------------------------------------
// Confidence, and collapsing the frames
// ---------------------------------------------------------------------------

test("false-discovery control alone cannot produce anything but a high tier", () => {
  // Why the tier had to stop being a restatement of the probability: BH at
  // q=0.1 cannot publish a claim whose p-value exceeds 0.1, so every published
  // finding had probability at least 0.9 and every one came out `high`.
  const claims = Array.from({ length: 8 }, (_, i) =>
    candidate({ dimensionKey: `d${i}`, conceptSlug: `c${i}`, rawProbability: 0.9 + i * 0.01 }),
  );
  for (const kept of controlFalseDiscovery(claims).filter((c) => c.published)) {
    assert.ok(kept.rawProbability >= 1 - FINDING_POLICY.falseDiscoveryRate);
  }
});

test("the tier reports how much evidence there is, not how the correction went", () => {
  // Same rate, three sample sizes. The old tier called all three `high`.
  assert.equal(tierFor(available(300, 1000)), "high");
  assert.equal(tierFor(available(9, 30)), "moderate");
  assert.equal(tierFor(available(3, 10)), "low", "ten observations was called confident");
});

test("one concept measured under two frames is one finding, not two", () => {
  const objective = candidate({
    dimensionKey: "material_safety_respond_objective",
    findingType: "foundational_miss",
    frame: "objective",
    rawProbability: 0.97,
  });
  const personal = candidate({
    dimensionKey: "material_safety_respond_personal_current",
    findingType: "foundational_miss",
    frame: "personal_current",
    rawProbability: 0.99,
  });
  const deduped = dedupeAcrossFrames([objective, personal]);
  const kept = deduped.filter((c) => c.droppedReason === null);
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.frame, "objective", "the frame was chosen by whichever scored better");
});

test("a concept that was measured does not also report a coverage gap", () => {
  // The recent window is half the evidence, so a concept with a good lifetime
  // estimate routinely also produces "not enough evidence yet" from the other
  // frame. That is an artefact of halving the sample, and it is not true.
  const measured = candidate({
    dimensionKey: "only_move_recognize_objective",
    conceptSlug: "only_move",
    role: "recognize",
    findingType: "foundational_miss",
    frame: "objective",
  });
  const gap = candidate({
    dimensionKey: "only_move_recognize_personal_current",
    conceptSlug: "only_move",
    role: "recognize",
    findingType: "insufficient_evidence",
    frame: "personal_current",
    published: true,
  });
  const { published } = selectPublished(controlFalseDiscovery(dedupeAcrossFrames([measured, gap])));
  assert.equal(
    published.filter((c) => c.findingType === "insufficient_evidence").length,
    0,
    "reported a coverage gap for a concept the report had just measured",
  );
});

test("a concept nothing measured still reports its gap", () => {
  const gaps = ["objective", "personal_current"].map((frame) =>
    candidate({
      dimensionKey: `winning_conversion_convert_${frame}`,
      conceptSlug: "winning_conversion",
      role: "convert",
      findingType: "insufficient_evidence",
      frame: frame as "objective" | "personal_current",
      published: true,
    }),
  );
  const { published } = selectPublished(controlFalseDiscovery(dedupeAcrossFrames(gaps)));
  assert.equal(published.length, 1, "one gap per concept, not one per frame");
  assert.equal(published[0]!.frame, "objective");
});

test("an improvement claim is kept in the frame that can make it", () => {
  const personal = candidate({
    dimensionKey: "only_move_recognize_personal_current",
    findingType: "established_improvement",
    frame: "personal_current",
  });
  const stray = candidate({
    dimensionKey: "only_move_recognize_objective",
    findingType: "established_improvement",
    frame: "objective",
  });
  const kept = dedupeAcrossFrames([stray, personal]).filter((c) => c.droppedReason === null);
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.frame, "personal_current");
});

test("a duplicate frame is not counted as a hypothesis the correction divides by", () => {
  // One marginal true claim among five nulls, each concept measured twice. The
  // Benjamini-Hochberg threshold for the smallest p-value is q/m, so leaving
  // the duplicates in halves it — and the one real finding in the report is
  // lost because the report measured everything twice.
  const pairs = ["a", "b", "c", "d", "e", "f"].flatMap((slug) => [
    candidate({
      dimensionKey: `${slug}_objective`,
      conceptSlug: slug,
      frame: "objective",
      rawProbability: slug === "a" ? 0.984 : 0.1,
    }),
    candidate({
      dimensionKey: `${slug}_personal_current`,
      conceptSlug: slug,
      frame: "personal_current",
      rawProbability: 0.1,
    }),
  ]);
  const withDuplicates = controlFalseDiscovery(pairs).filter((c) => c.published);
  const collapsed = controlFalseDiscovery(dedupeAcrossFrames(pairs)).filter((c) => c.published);
  assert.equal(withDuplicates.length, 0, "the arrangement under test did not reproduce");
  assert.equal(collapsed.length, 1, "collapsing the frames did not recover the real finding");
  assert.equal(collapsed[0]!.conceptSlug, "a");
});

// ---------------------------------------------------------------------------
// The renderer boundary
// ---------------------------------------------------------------------------

test("prose that only restates the finding passes", () => {
  const claim = { estimate: 0.82, intervalLow: 0.71, intervalHigh: 0.9 };
  const check = checkRendering("You convert 82% of these, somewhere between 71% and 90%.", claim);
  assert.equal(check.state, "passed", check.note ?? "");
});

test("prose that invents a statistic is held back", () => {
  const check = checkRendering("You convert 82% of these, up from 41% last month.", {
    estimate: 0.82,
  });
  assert.equal(check.state, "held");
  assert.ok(check.unsupported.includes("41%"));
});

test("prose that asserts improvement the finding never claimed is rejected", () => {
  const check = checkRendering("Your endgame technique has improved.", { estimate: 0.6 });
  assert.equal(check.state, "rejected");
});

test("an improvement finding may say so", () => {
  const check = checkRendering("Your endgame technique has improved.", { estimate: 0.6 }, {
    improvementClaimAllowed: true,
  });
  assert.equal(check.state, "passed");
});

test("small integers in ordinary English are not treated as statistics", () => {
  const check = checkRendering("This came up in 3 of your games and cost you material.", {});
  assert.equal(check.state, "passed", check.note ?? "");
});

test("empty prose is rejected rather than stored as a blank explanation", () => {
  assert.equal(checkRendering("   ", {}).state, "rejected");
});

test("rounding a supported number is allowed; changing it is not", () => {
  const supported = supportedNumbers({ estimate: 0.4235 });
  assert.ok(supported.has("42%"));
  assert.ok(supported.has("0.42"));
  assert.ok(!supported.has("55%"));
});

/** A claim carrying every optional part, so the fullest template is exercised. */
function fullClaim(): Record<string, unknown> {
  return {
    concept: {
      slug: "material_safety",
      role: "respond",
      label: "Keeping your pieces safe",
      definition: describeConceptRole("material_safety", "respond").definition,
      opportunity: "save a piece your opponent could have taken",
      succeeded: "saved it",
      missed: "left it there",
    },
    estimate: 0.29,
    intervalLow: 0.18,
    intervalHigh: 0.42,
    observed: 41,
    successes: 12,
    failures: 29,
    graded: 0,
    censored: 9,
    effectiveSample: 22.4,
    occurrences: 29,
    delta: 0.14,
    improvementProbability: 0.97,
    probabilityFloor: 0.99,
    reason: "below_minimum_sample",
    rawSample: 4,
    where: {
      kind: "move_band",
      label: "moves 21 to 30",
      count: 21,
      total: 29,
      moveLow: 21,
      moveHigh: 30,
      observedMoveLow: 22,
      observedMoveHigh: 29,
    },
    whereExamined: true,
    example: {
      gameId: "0d0a3f5e-0000-4000-8000-000000000000",
      evidenceItemId: "4711",
      moveNumber: 23,
      side: "black",
      playedMoveUci: "g1f3",
      bestMoveUci: "d1d8",
      openingName: "Scotch Game: Classical Variation",
      departureMoveNumber: 11,
    },
  };
}

test("every template renders and passes its own check", () => {
  for (const findingType of FINDING_TYPES) {
    const claim = fullClaim();
    const text = renderTemplate({ findingType, claim });
    const check = checkRendering(text, claim, {
      improvementClaimAllowed:
        findingType === "established_improvement" || findingType === "early_improvement_signal",
    });
    assert.equal(check.state, "passed", `${findingType}: ${check.note ?? ""} ${check.unsupported.join(",")}`);
    assert.ok(text.length > 40, `${findingType} rendered almost nothing: ${text}`);
  }
});

test("every template renders from a claim carrying only the minimum", () => {
  // A concept the catalogue has never heard of, no location, no example. The
  // sentence gets shorter; it must not get broken or leak an identifier.
  for (const findingType of FINDING_TYPES) {
    const claim = {
      concept: describeConceptRole("not_a_real_concept", "respond"),
      estimate: 0.5,
      intervalLow: 0.3,
      intervalHigh: 0.7,
      censored: 0,
      where: null,
      whereExamined: false,
      example: null,
    };
    const text = renderTemplate({ findingType, claim });
    const check = checkRendering(text, claim, {
      improvementClaimAllowed:
        findingType === "established_improvement" || findingType === "early_improvement_signal",
    });
    assert.equal(check.state, "passed", `${findingType}: ${check.note ?? ""} ${check.unsupported.join(",")}`);
  }
});

test("no template can put a database key in front of a reader", () => {
  // The bug this whole path exists to fix: a live report read
  // "critical_moment_recognize_objective is costing you: 22% of your chances".
  const slugLike = /\b[a-z0-9]+(?:_[a-z0-9]+)+\b/;
  for (const findingType of FINDING_TYPES) {
    for (const claim of [fullClaim(), { concept: describeConceptRole("material_safety", "respond") }]) {
      const text = renderTemplate({ findingType, claim });
      assert.ok(!slugLike.test(text), `${findingType} rendered an identifier: ${text}`);
    }
  }
});

test("a rate is never stated without the sample and the interval behind it", () => {
  const claim = fullClaim();
  for (const findingType of ["strength", "foundational_miss"] as const) {
    const text = renderTemplate({ findingType, claim });
    assert.ok(text.includes("41 chances"), `${findingType} dropped the sample size: ${text}`);
    assert.ok(text.includes("18%") && text.includes("42%"), `${findingType} dropped the interval: ${text}`);
  }
});

test("a chance the player never got is reported, not folded into the failures", () => {
  const text = renderTemplate({ findingType: "foundational_miss", claim: fullClaim() });
  assert.ok(
    text.includes("9 further chances ended before you had a move"),
    `the censored chances were silently excluded: ${text}`,
  );
});

test("a probability is never rounded up into certainty", () => {
  const claim = { ...fullClaim(), improvementProbability: 0.9998 };
  const text = renderTemplate({ findingType: "established_improvement", claim });
  assert.ok(!text.includes("100%"), text);
  assert.ok(text.includes("over 99%"), text);
  assert.equal(checkRendering(text, claim, { improvementClaimAllowed: true }).state, "passed");
});

test("the catalogue words every role it says it supports", () => {
  for (const concept of CONCEPT_CATALOGUE) {
    for (const role of concept.supportedRoles) {
      const described = describeConceptRole(concept.slug, role);
      assert.ok(described.narrative, `${concept.slug}/${role} has no reader-facing wording`);
      assert.notEqual(described.label, concept.slug);
      for (const clause of [
        described.narrative!.opportunity,
        described.narrative!.succeeded,
        described.narrative!.missed,
      ]) {
        assert.ok(clause.length > 0);
        assert.ok(!/_/.test(clause), `${concept.slug}/${role} wording contains an identifier`);
      }
    }
  }
});

test("a concept this build cannot name is described, not printed as a key", () => {
  const described = describeConceptRole("some_future_concept", "respond");
  assert.ok(!described.label.includes("some_future_concept"));
  assert.equal(described.narrative, null);
});

// ---------------------------------------------------------------------------
// Policy shape
// ---------------------------------------------------------------------------

test("the policies are frozen, so a caller cannot retune them at runtime", () => {
  assert.equal(Object.isFrozen(ESTIMATOR_POLICY), true);
  assert.equal(Object.isFrozen(ALIGNMENT_POLICY), true);
  assert.equal(Object.isFrozen(FINDING_POLICY), true);
});

test("the four comparison frames are exactly the spec's four", () => {
  assert.deepEqual([...FRAMES], [
    "personal_current",
    "peer_current",
    "peer_stretch",
    "objective",
  ]);
});

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`estimates:unit — ${failures.length} failed, ${passed} passed`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`estimates:unit — ${passed}/${passed} passed`);

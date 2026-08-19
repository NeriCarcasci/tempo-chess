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
} from "./contract.js";
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
  deriveCandidates,
  selectPublished,
  structuredInputHash,
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

function dimension(over: Partial<DimensionInput> = {}): DimensionInput {
  return {
    dimensionKey: "fork_recognition",
    frame: "peer_current",
    conceptSlug: "fork",
    role: "recognize",
    claimFamily: "concept_success",
    result: available(45, 50),
    comparison: null,
    failureCount: 0,
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
  const candidates: CandidateFinding[] = Array.from({ length: 20 }, (_, i) => ({
    dimensionKey: `d${i}`,
    findingType: "strength" as const,
    claimFamily: "concept_success",
    // One strong claim among nineteen marginal ones.
    rawProbability: i === 0 ? 0.999 : 0.55,
    adjustedProbability: null,
    confidenceTier: "low" as const,
    priority: 50,
    claim: {},
    published: false,
    droppedReason: null,
  }));
  const controlled = controlFalseDiscovery(candidates);
  assert.equal(controlled.filter((c) => c.published).length, 1);
  assert.equal(controlled.find((c) => c.dimensionKey === "d0")!.published, true);
  for (const dropped of controlled.filter((c) => !c.published)) {
    assert.ok(dropped.droppedReason && dropped.droppedReason.length > 0);
  }
});

test("coverage gaps are exempt from correction and from the display cap", () => {
  const gaps: CandidateFinding[] = Array.from({ length: 30 }, (_, i) => ({
    dimensionKey: `gap${i}`,
    findingType: "insufficient_evidence" as const,
    claimFamily: "concept_success",
    rawProbability: 1,
    adjustedProbability: null,
    confidenceTier: "low" as const,
    priority: 10,
    claim: {},
    published: true,
    droppedReason: null,
  }));
  const { published } = selectPublished(controlFalseDiscovery(gaps));
  assert.equal(published.length, 30, "coverage gaps were capped away");
});

test("the display cap bounds real claims and says what it withheld", () => {
  const claims: CandidateFinding[] = Array.from({ length: 40 }, (_, i) => ({
    dimensionKey: `d${i}`,
    findingType: "strength" as const,
    claimFamily: "concept_success",
    rawProbability: 0.999,
    adjustedProbability: 0.99,
    confidenceTier: "high" as const,
    priority: 50,
    claim: {},
    published: true,
    droppedReason: null,
  }));
  const { published, withheld } = selectPublished(claims);
  assert.equal(published.length, FINDING_POLICY.maxPublishedFindings);
  assert.equal(withheld.length, 40 - FINDING_POLICY.maxPublishedFindings);
  for (const item of withheld) assert.ok(item.droppedReason?.includes("cap"));
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

test("every template renders and passes its own check", () => {
  for (const findingType of FINDING_TYPES) {
    const claim = {
      dimension: "fork recognition",
      estimate: 0.62,
      intervalLow: 0.5,
      intervalHigh: 0.74,
    };
    const text = renderTemplate({ findingType, claim });
    const check = checkRendering(text, claim, {
      improvementClaimAllowed:
        findingType === "established_improvement" || findingType === "early_improvement_signal",
    });
    assert.equal(check.state, "passed", `${findingType}: ${check.note ?? ""} ${check.unsupported.join(",")}`);
  }
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

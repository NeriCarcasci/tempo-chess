/**
 * `npm run goals:unit` — E17's invariants, offline.
 *
 * Three lines run through every assertion here: a target must move the bar,
 * adherence is never progress, and only real-game evidence completes a goal.
 */

import { strict as assert } from "node:assert";

import { CLAIM_STATES, GOAL_POLICY, REJECTION_CODES } from "./contract.js";
import { checkHorizon, resolveStretchRating, resolveTarget } from "./resolve.js";
import {
  adherenceOf,
  checkClose,
  claimStateOf,
  readProgress,
  readinessOf,
  type MetricTarget,
} from "./progress.js";
import { generatePlan, measureAdherence, type EvidenceGap } from "./plan.js";

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
// Resolving a target
// ---------------------------------------------------------------------------

function request(over: Partial<Parameters<typeof resolveTarget>[0]> = {}) {
  return {
    metricKey: "fork_recognize",
    frame: "personal_current" as const,
    baselineValue: 0.5,
    baselineIntervalLow: 0.45,
    baselineIntervalHigh: 0.55,
    direction: "increase" as const,
    requestedValue: null,
    meaningfulChange: 0.05,
    requiredEvidenceCount: 3,
    baselineSampleSize: 40,
    ...over,
  };
}

test("a target with no baseline is refused with a code, not a guess", () => {
  const result = resolveTarget(request({ baselineValue: Number.NaN }));
  assert.equal(result.resolved, false);
  if (result.resolved) return;
  assert.equal(result.code, "missing_baseline");
});

test("a metric with no noise floor is not measurable", () => {
  const result = resolveTarget(request({ meaningfulChange: 0 }));
  assert.equal(result.resolved === false && result.code, "target_not_measurable");
});

test("an unspecified target lands exactly on the noise floor", () => {
  const result = resolveTarget(request({ baselineIntervalLow: null, baselineIntervalHigh: null }));
  assert.equal(result.resolved, true);
  if (!result.resolved) return;
  assert.ok(near(result.targetValue, 0.55));
});

test("a wide baseline interval widens the floor", () => {
  const narrow = resolveTarget(
    request({ baselineIntervalLow: 0.49, baselineIntervalHigh: 0.51 }),
  );
  const wide = resolveTarget(request({ baselineIntervalLow: 0.2, baselineIntervalHigh: 0.8 }));
  assert.ok(narrow.resolved && wide.resolved);
  if (!narrow.resolved || !wide.resolved) return;
  assert.ok(
    wide.targetValue > narrow.targetValue,
    "an uncertain baseline promised a change smaller than its own uncertainty",
  );
});

test("a target inside the noise is moved out, and the move is reported", () => {
  const result = resolveTarget(
    request({ requestedValue: 0.51, baselineIntervalLow: null, baselineIntervalHigh: null }),
  );
  assert.equal(result.resolved, true);
  if (!result.resolved) return;
  assert.ok(near(result.targetValue, 0.55), "a target inside the noise was accepted");
  assert.equal(result.adjustedFromRequested, 0.51);
});

test("an ambitious target is kept as asked", () => {
  const result = resolveTarget(request({ requestedValue: 0.9 }));
  assert.equal(result.resolved, true);
  if (!result.resolved) return;
  assert.ok(near(result.targetValue, 0.9));
  assert.equal(result.adjustedFromRequested, null);
});

test("a decreasing target moves the bar downwards", () => {
  const result = resolveTarget(
    request({
      direction: "decrease",
      baselineValue: 0.4,
      baselineIntervalLow: null,
      baselineIntervalHigh: null,
    }),
  );
  assert.equal(result.resolved, true);
  if (!result.resolved) return;
  assert.ok(result.targetValue < 0.4);
});

test("every rejection code is one a client can act on", () => {
  for (const code of REJECTION_CODES) {
    assert.ok(/^[a-z_]+$/.test(code), `${code} is not a stable code`);
  }
});

// ---------------------------------------------------------------------------
// Stretch targets are not rating plus a constant
// ---------------------------------------------------------------------------

test("a settled rating supports a larger stretch than a volatile one", () => {
  const settled = resolveStretchRating({
    currentRating: 1500,
    ratingReliability: 1,
    sampleSize: 100,
  });
  const volatile = resolveStretchRating({
    currentRating: 1500,
    ratingReliability: 0,
    sampleSize: 100,
  });
  assert.ok(settled.available && volatile.available);
  if (!settled.available || !volatile.available) return;
  assert.ok(settled.targetRating > volatile.targetRating, "the stretch was a constant");
  assert.equal(volatile.stretchApplied, GOAL_POLICY.stretchRatingLow);
  assert.equal(settled.stretchApplied, GOAL_POLICY.stretchRatingHigh);
});

test("a rating outside the calibrated band gets a caveat, not a number", () => {
  const result = resolveStretchRating({
    currentRating: 2600,
    ratingReliability: 1,
    sampleSize: 200,
  });
  assert.equal(result.available, false);
  if (result.available) return;
  assert.ok(result.caveat.includes("calibrated"));
  assert.ok(result.caveat.includes("your own games"), "the caveat left the user with nothing");
});

test("too few rated games means no rating target at all", () => {
  const result = resolveStretchRating({
    currentRating: 1500,
    ratingReliability: 1,
    sampleSize: 3,
  });
  assert.equal(result.available === false && result.code, "missing_baseline");
});

test("a horizon outside the policy band is refused", () => {
  assert.equal(checkHorizon(null).ok, true);
  assert.equal(checkHorizon(30).ok, true);
  assert.equal(checkHorizon(2).ok, false);
  assert.equal(checkHorizon(5_000).code, "horizon_out_of_range");
});

// ---------------------------------------------------------------------------
// Progress, readiness, adherence
// ---------------------------------------------------------------------------

const TARGET: MetricTarget = {
  metricKey: "fork_recognize",
  baselineValue: 0.4,
  targetValue: 0.7,
  direction: "increase",
  meaningfulChange: 0.05,
  requiredEvidenceCount: 3,
  requiredCoverageState: "limited",
};

function estimate(value: number | null, over: Partial<Parameters<typeof claimStateOf>[0]["estimate"]> = {}) {
  return {
    value,
    intervalLow: value === null ? null : value - 0.05,
    intervalHigh: value === null ? null : value + 0.05,
    coverageState: "sufficient" as const,
    unavailableReason: value === null ? "no_observations" : null,
    ...over,
  };
}

test("readiness is zero at the baseline and one at the target", () => {
  assert.equal(readinessOf(TARGET, 0.4), 0);
  assert.equal(readinessOf(TARGET, 0.7), 1);
  assert.ok(near(readinessOf(TARGET, 0.55), 0.5));
});

test("overshooting the target is still one, not a score", () => {
  assert.equal(readinessOf(TARGET, 0.95), 1);
});

test("adherence with nothing committed is null, not zero", () => {
  assert.equal(adherenceOf({ requirementsMet: 0, requirementsTotal: 0 }), null);
  assert.equal(adherenceOf({ requirementsMet: 2, requirementsTotal: 4 }), 0.5);
});

test("perfect adherence with no improvement claims nothing", () => {
  const reading = readProgress({
    target: TARGET,
    estimate: estimate(0.4),
    evidence: { realGame: 20, practice: 200 },
    adherence: { requirementsMet: 6, requirementsTotal: 6 },
  });
  assert.equal(reading.adherenceRatio, 1);
  assert.equal(reading.readiness, 0);
  assert.equal(reading.targetAchieved, false);
  assert.equal(reading.claimState, "no_evidence");
});

test("practice alone never completes a goal", () => {
  const reading = readProgress({
    target: TARGET,
    estimate: estimate(0.75),
    // At target on the estimate, but nothing was demonstrated in a real game.
    evidence: { realGame: 0, practice: 500 },
    adherence: { requirementsMet: 6, requirementsTotal: 6 },
  });
  assert.equal(reading.readiness, 1);
  assert.equal(reading.targetAchieved, false, "practice completed a goal");
  assert.notEqual(reading.claimState, "target_met");
});

test("real-game evidence at the target completes it", () => {
  const reading = readProgress({
    target: TARGET,
    estimate: estimate(0.75),
    evidence: { realGame: 5, practice: 0 },
    adherence: { requirementsMet: 0, requirementsTotal: 6 },
  });
  assert.equal(reading.claimState, "target_met");
  assert.equal(reading.targetAchieved, true);
  // Adherence was zero and the goal was still met. Doing the exercises is not
  // what completes a goal, and neither is skipping them what prevents it.
  assert.equal(reading.adherenceRatio, 0);
});

test("too few real-game observations is not yet target_met", () => {
  const reading = readProgress({
    target: { ...TARGET, requiredEvidenceCount: 10 },
    estimate: estimate(0.75),
    evidence: { realGame: 2, practice: 0 },
    adherence: { requirementsMet: 0, requirementsTotal: 0 },
  });
  assert.notEqual(reading.claimState, "target_met");
  assert.equal(reading.targetAchieved, false);
});

test("insufficient coverage produces no_evidence rather than a number", () => {
  const reading = readProgress({
    target: TARGET,
    estimate: estimate(0.75, { coverageState: "insufficient" }),
    evidence: { realGame: 5, practice: 0 },
    adherence: { requirementsMet: 0, requirementsTotal: 0 },
  });
  assert.equal(reading.claimState, "no_evidence");
  assert.equal(reading.targetAchieved, false);
});

test("an unavailable estimate is unavailable, with its reason", () => {
  const reading = readProgress({
    target: TARGET,
    estimate: estimate(null),
    evidence: { realGame: 0, practice: 0 },
    adherence: { requirementsMet: 0, requirementsTotal: 0 },
  });
  assert.equal(reading.claimState, "unavailable");
  assert.equal(reading.currentValue, null);
  assert.equal(reading.unavailableReason, "no_observations");
  assert.equal(reading.readiness, null);
});

test("going backwards is said out loud", () => {
  const reading = readProgress({
    target: TARGET,
    estimate: estimate(0.2),
    evidence: { realGame: 10, practice: 0 },
    adherence: { requirementsMet: 6, requirementsTotal: 6 },
  });
  assert.equal(reading.claimState, "declined");
  assert.ok(reading.progressFromBaseline !== null && reading.progressFromBaseline < 0);
});

test("a small wobble is not a decline", () => {
  const reading = readProgress({
    target: TARGET,
    estimate: estimate(0.39),
    evidence: { realGame: 10, practice: 0 },
    adherence: { requirementsMet: 0, requirementsTotal: 0 },
  });
  assert.notEqual(reading.claimState, "declined");
});

test("progress, readiness and adherence are three separate numbers", () => {
  const reading = readProgress({
    target: TARGET,
    estimate: estimate(0.55),
    evidence: { realGame: 4, practice: 30 },
    adherence: { requirementsMet: 3, requirementsTotal: 6 },
  });
  assert.ok(near(reading.progressFromBaseline!, 0.15));
  assert.ok(near(reading.readiness!, 0.5));
  assert.equal(reading.adherenceRatio, 0.5);
  // The three agreeing here is a coincidence of the fixture, not a derivation.
  assert.equal(reading.realGameEvidenceCount, 4);
  assert.equal(reading.practiceEvidenceCount, 30);
});

test("every claim state is reachable and named", () => {
  assert.equal(new Set(CLAIM_STATES).size, CLAIM_STATES.length);
  for (const state of CLAIM_STATES) assert.ok(/^[a-z_]+$/.test(state));
});

// ---------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------

function reading(achieved: boolean) {
  return readProgress({
    target: TARGET,
    estimate: estimate(achieved ? 0.75 : 0.45),
    evidence: { realGame: achieved ? 5 : 1, practice: 0 },
    adherence: { requirementsMet: 0, requirementsTotal: 0 },
  });
}

test("closing as completed without the evidence says so plainly", () => {
  const result = checkClose({ outcome: "completed", readings: [reading(false)] });
  assert.equal(result.demonstrated, false);
  assert.ok(result.note?.includes("at your request"));
  assert.ok(result.note?.includes("not demonstrated"));
});

test("closing as completed with the evidence records it", () => {
  const result = checkClose({ outcome: "completed", readings: [reading(true)] });
  assert.equal(result.demonstrated, true);
  assert.equal(result.note, null);
});

test("abandoning is never dressed up as an achievement", () => {
  const result = checkClose({ outcome: "abandoned", readings: [reading(true)] });
  assert.equal(result.demonstrated, false);
  assert.equal(result.outcome, "abandoned");
});

test("closing a goal with no measured targets says nothing was shown", () => {
  const result = checkClose({ outcome: "completed", readings: [] });
  assert.equal(result.demonstrated, false);
  assert.ok(result.note?.includes("nothing was demonstrated"));
});

// ---------------------------------------------------------------------------
// Plan generation
// ---------------------------------------------------------------------------

function gap(over: Partial<EvidenceGap> = {}): EvidenceGap {
  return {
    dimensionKey: "fork_recognize",
    displayName: "fork recognition",
    shortfall: 0.5,
    intervalWidth: 0.1,
    observationCount: 40,
    essential: false,
    ...over,
  };
}

test("a plan is bounded", () => {
  const plan = generatePlan(
    Array.from({ length: 20 }, (_, i) => gap({ dimensionKey: `d${i}` })),
  );
  assert.ok(plan.length <= GOAL_POLICY.maxRequirements);
});

test("essential gaps come first", () => {
  const plan = generatePlan([
    gap({ dimensionKey: "minor", shortfall: 0.9, essential: false }),
    gap({ dimensionKey: "major", shortfall: 0.3, essential: true }),
  ]);
  assert.equal(plan[0]!.cohortFilter.dimension, "major");
});

test("an unmeasured gap asks for games, not drills", () => {
  const plan = generatePlan([gap({ observationCount: 3, intervalWidth: 0.6 })]);
  assert.equal(plan[0]!.kind, "play_games");
  assert.ok(plan[0]!.rationale.includes("not enough to be sure"));
});

test("an established weakness asks for practice", () => {
  const plan = generatePlan([gap({ shortfall: 0.8, intervalWidth: 0.1, observationCount: 60 })]);
  assert.equal(plan[0]!.kind, "targeted_practice");
});

test("a near miss asks for review", () => {
  const plan = generatePlan([gap({ shortfall: 0.1, intervalWidth: 0.1, observationCount: 60 })]);
  assert.equal(plan[0]!.kind, "review_games");
});

test("every requirement can say why it exists", () => {
  for (const requirement of generatePlan([gap(), gap({ dimensionKey: "other" })])) {
    assert.ok(requirement.rationale.length >= 20, `${requirement.requirementKey} is a chore`);
  }
});

test("requirements are ranked and uniquely keyed", () => {
  const plan = generatePlan([gap({ dimensionKey: "a" }), gap({ dimensionKey: "b" })]);
  assert.deepEqual(plan.map((r) => r.displayRank), [0, 1]);
  assert.equal(new Set(plan.map((r) => r.requirementKey)).size, plan.length);
});

test("adherence counts only what the user accepted", () => {
  const plan = generatePlan([gap({ dimensionKey: "a" }), gap({ dimensionKey: "b" })]);
  const accepted = [plan[0]!.requirementKey];
  const result = measureAdherence({
    requirements: plan,
    acceptedKeys: accepted,
    observed: { [plan[0]!.requirementKey]: 99 },
  });
  assert.deepEqual(result, { met: 1, total: 1 }, "a declined requirement counted against them");
});

test("declining everything is not zero adherence, it is nothing to adhere to", () => {
  const plan = generatePlan([gap()]);
  const result = measureAdherence({ requirements: plan, acceptedKeys: [], observed: {} });
  assert.deepEqual(result, { met: 0, total: 0 });
  assert.equal(adherenceOf({ requirementsMet: 0, requirementsTotal: 0 }), null);
});

test("the policy is frozen", () => {
  assert.equal(Object.isFrozen(GOAL_POLICY), true);
});

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`goals:unit — ${failures.length} failed, ${passed} passed`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`goals:unit — ${passed}/${passed} passed`);

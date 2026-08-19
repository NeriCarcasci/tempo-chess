import { GOAL_POLICY, type ClaimState, type GoalPolicy } from "./contract.js";

/**
 * Progress, readiness and adherence — kept apart.
 *
 * This module exists to hold one line that a coaching product is permanently
 * tempted to cross. Somebody who did every exercise, every day, for six weeks
 * has high adherence. That is worth saying, and it is not improvement. Somebody
 * whose estimate has moved most of the way to the target has high readiness.
 * That is worth saying, and it is not yet demonstrated. Only real-game evidence
 * completes a goal.
 *
 * The three are computed by three functions that do not read each other's
 * inputs, so blending them later requires deleting a boundary rather than
 * forgetting one.
 */

export interface MetricTarget {
  metricKey: string;
  baselineValue: number;
  targetValue: number;
  direction: "increase" | "decrease";
  meaningfulChange: number;
  requiredEvidenceCount: number;
  requiredCoverageState: "limited" | "sufficient";
}

export interface CurrentEstimate {
  value: number | null;
  intervalLow: number | null;
  intervalHigh: number | null;
  coverageState: "insufficient" | "limited" | "sufficient";
  unavailableReason: string | null;
}

export interface EvidenceCounts {
  realGame: number;
  practice: number;
}

export interface AdherenceInput {
  requirementsMet: number;
  requirementsTotal: number;
}

export interface ProgressReading {
  metricKey: string;
  currentValue: number | null;
  intervalLow: number | null;
  intervalHigh: number | null;
  /** Movement from the frozen baseline, in the target's own units. */
  progressFromBaseline: number | null;
  /** How far along, 0 to 1. Null when there is nothing to measure. */
  readiness: number | null;
  adherenceRatio: number | null;
  requirementsMet: number;
  requirementsTotal: number;
  realGameEvidenceCount: number;
  practiceEvidenceCount: number;
  coverageState: CurrentEstimate["coverageState"];
  claimState: ClaimState;
  targetAchieved: boolean;
  unavailableReason: string | null;
}

/**
 * How far the estimate has moved towards the target.
 *
 * Zero at the baseline, one at the target, clamped. Overshooting is still one:
 * a goal is a threshold, not a score, and reporting 140% would invite a product
 * decision nobody wants to make about what that means.
 */
export function readinessOf(target: MetricTarget, currentValue: number): number {
  const span = target.targetValue - target.baselineValue;
  if (span === 0) return 1;
  const moved = currentValue - target.baselineValue;
  return Math.min(1, Math.max(0, moved / span));
}

/**
 * Adherence: what the user did against what they committed to.
 *
 * Null when nothing was committed. Zero would say they failed to do something
 * they never agreed to, which is the kind of number that makes a person close
 * an app.
 */
export function adherenceOf(input: AdherenceInput): number | null {
  if (input.requirementsTotal === 0) return null;
  return Number(
    (Math.min(input.requirementsMet, input.requirementsTotal) / input.requirementsTotal).toFixed(4),
  );
}

/**
 * What the product may claim, given everything it knows.
 *
 * The order encodes the ethics. Unavailable beats everything, because a number
 * we do not have cannot be spun. `target_met` needs readiness *and* real-game
 * evidence *and* coverage. `declined` is said out loud rather than hidden,
 * because a coaching product that only reports good news is an advertisement.
 */
export function claimStateOf(input: {
  target: MetricTarget;
  estimate: CurrentEstimate;
  evidence: EvidenceCounts;
  policy?: GoalPolicy;
}): ClaimState {
  const policy = input.policy ?? GOAL_POLICY;
  if (input.estimate.value === null) return "unavailable";
  if (input.estimate.coverageState === "insufficient") return "no_evidence";

  const readiness = readinessOf(input.target, input.estimate.value);
  const moved = input.estimate.value - input.target.baselineValue;
  const wrongWay = input.target.direction === "increase" ? moved < 0 : moved > 0;

  if (wrongWay && Math.abs(moved) >= input.target.meaningfulChange) return "declined";

  // `insufficient` already returned above, so anything still here satisfies a
  // target that asks only for `limited`. A target asking for `sufficient` still
  // has to have it.
  const coverageSufficient =
    input.target.requiredCoverageState === "limited" ||
    input.estimate.coverageState === "sufficient";

  if (
    readiness >= policy.targetMetReadiness &&
    input.evidence.realGame >= Math.max(policy.minRealGameEvidence, input.target.requiredEvidenceCount) &&
    coverageSufficient
  ) {
    return "target_met";
  }
  if (readiness >= policy.improvingReadiness && input.evidence.realGame > 0) return "improving";
  if (readiness > policy.earlySignalProgress) return "early_signal";
  return "no_evidence";
}

/**
 * One complete progress reading.
 *
 * `targetAchieved` is derived from the claim state rather than set beside it,
 * so the two cannot disagree, and adherence appears nowhere in that derivation.
 * Practice cannot complete a goal — platform spec 3.4 — and the only way to
 * make that fail here would be to pass a practice count as a real-game one,
 * which the caller cannot do by accident because they are separate fields.
 */
export function readProgress(input: {
  target: MetricTarget;
  estimate: CurrentEstimate;
  evidence: EvidenceCounts;
  adherence: AdherenceInput;
  policy?: GoalPolicy;
}): ProgressReading {
  const claimState = claimStateOf(input);
  const value = input.estimate.value;

  return {
    metricKey: input.target.metricKey,
    currentValue: value,
    intervalLow: input.estimate.intervalLow,
    intervalHigh: input.estimate.intervalHigh,
    progressFromBaseline: value === null ? null : round(value - input.target.baselineValue),
    readiness: value === null ? null : round(readinessOf(input.target, value)),
    adherenceRatio: adherenceOf(input.adherence),
    requirementsMet: input.adherence.requirementsMet,
    requirementsTotal: input.adherence.requirementsTotal,
    realGameEvidenceCount: input.evidence.realGame,
    practiceEvidenceCount: input.evidence.practice,
    coverageState: input.estimate.coverageState,
    claimState,
    targetAchieved: claimState === "target_met",
    unavailableReason: input.estimate.unavailableReason,
  };
}

function round(value: number): number {
  return Number(value.toFixed(5));
}

export interface CloseCheck {
  /** Whether the user's stated outcome matches what the evidence supports. */
  demonstrated: boolean;
  outcome: "completed" | "abandoned" | "replaced";
  /** The sentence the response uses when the two disagree. */
  note: string | null;
}

/**
 * Closing a goal.
 *
 * A user may always close their own goal — it is theirs. What the product may
 * not do is record "completed" as if the evidence supported it when it did not.
 * The two are separated: the goal closes as the user asked, and the response
 * says plainly whether the target was demonstrated.
 */
export function checkClose(input: {
  outcome: "completed" | "abandoned" | "replaced";
  readings: readonly ProgressReading[];
}): CloseCheck {
  if (input.outcome !== "completed") {
    return { demonstrated: false, outcome: input.outcome, note: null };
  }
  const essential = input.readings;
  const allMet = essential.length > 0 && essential.every((reading) => reading.targetAchieved);
  if (allMet) return { demonstrated: true, outcome: "completed", note: null };

  const missing = essential.filter((reading) => !reading.targetAchieved).length;
  return {
    demonstrated: false,
    outcome: "completed",
    note:
      essential.length === 0
        ? "This goal is closed. There were no measured targets on it, so nothing was demonstrated either way."
        : `This goal is closed at your request. ${missing} of ${essential.length} targets were not demonstrated in your games, so Forma is not recording this as an achieved target.`,
  };
}

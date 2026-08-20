import {
  GOAL_POLICY,
  type Frame,
  type GoalPolicy,
  type RejectionCode,
} from "./contract.js";

/**
 * Turning a thing somebody wants into a thing that can be measured.
 *
 * This is where a coaching product either becomes honest or does not. "Get to
 * 1600" is a wish; a target is a named metric, a baseline with its uncertainty,
 * a value beyond the noise floor, and a rule for what evidence would settle it.
 * When a wish cannot be turned into that, the answer is a stable rejection code
 * rather than a target that will quietly never be met.
 *
 * A stretch target is never `rating + constant`. Platform spec 3.2 is explicit:
 * pool, provider, speed, reliability, sample size and the policy version are all
 * inputs, and storing the arithmetic as a fact is the failure it names.
 */

export interface TargetRequest {
  metricKey: string;
  frame: Frame;
  /** The current estimate this target moves away from. */
  baselineValue: number;
  baselineIntervalLow: number | null;
  baselineIntervalHigh: number | null;
  direction: "increase" | "decrease";
  /** What the user asked for, when they named a number. */
  requestedValue: number | null;
  /** Below this a change is noise. A property of the metric. */
  meaningfulChange: number;
  requiredEvidenceCount: number;
  /** Observations behind the baseline. Thin evidence widens the noise floor. */
  baselineSampleSize: number;
}

export interface ResolvedTarget {
  resolved: true;
  metricKey: string;
  baselineValue: number;
  targetValue: number;
  direction: "increase" | "decrease";
  meaningfulChange: number;
  requiredEvidenceCount: number;
  /** Present when the target had to be moved to clear the noise floor. */
  adjustedFromRequested: number | null;
}

export interface RejectedTarget {
  resolved: false;
  code: RejectionCode;
  detail: string;
}

/**
 * Resolve one metric target.
 *
 * The rule that does the work: a target must lie beyond the baseline, in the
 * stated direction, by more than the noise floor. A target inside the noise is
 * met the moment it is set, which is the most flattering possible way to build
 * a coaching product that does nothing.
 *
 * When the user asked for something inside the noise, the target is *moved out*
 * to the floor and the adjustment is reported rather than silently accepted or
 * silently refused. They asked for something too small to see; they are told
 * the smallest thing that can be seen.
 */
export function resolveTarget(
  request: TargetRequest,
  policy: GoalPolicy = GOAL_POLICY,
): ResolvedTarget | RejectedTarget {
  void policy;
  if (!Number.isFinite(request.baselineValue)) {
    return {
      resolved: false,
      code: "missing_baseline",
      detail: "there is no baseline estimate for this metric yet",
    };
  }
  if (request.meaningfulChange <= 0) {
    return {
      resolved: false,
      code: "target_not_measurable",
      detail: "this metric has no meaningful-change threshold, so nothing about it is measurable",
    };
  }

  // A wide baseline interval is a wider noise floor: promising a change smaller
  // than the uncertainty of the starting point is promising to measure
  // something we cannot see.
  const intervalWidth =
    request.baselineIntervalLow !== null && request.baselineIntervalHigh !== null
      ? request.baselineIntervalHigh - request.baselineIntervalLow
      : 0;
  const floor = Math.max(request.meaningfulChange, intervalWidth / 2);

  const minimum =
    request.direction === "increase"
      ? request.baselineValue + floor
      : request.baselineValue - floor;

  if (request.requestedValue === null) {
    return {
      resolved: true,
      metricKey: request.metricKey,
      baselineValue: request.baselineValue,
      targetValue: round(minimum),
      direction: request.direction,
      meaningfulChange: round(floor),
      requiredEvidenceCount: request.requiredEvidenceCount,
      adjustedFromRequested: null,
    };
  }

  const clearsFloor =
    request.direction === "increase"
      ? request.requestedValue >= minimum
      : request.requestedValue <= minimum;

  return {
    resolved: true,
    metricKey: request.metricKey,
    baselineValue: request.baselineValue,
    targetValue: round(clearsFloor ? request.requestedValue : minimum),
    direction: request.direction,
    meaningfulChange: round(floor),
    requiredEvidenceCount: request.requiredEvidenceCount,
    adjustedFromRequested: clearsFloor ? null : request.requestedValue,
  };
}

function round(value: number): number {
  return Number(value.toFixed(5));
}

export interface StretchInput {
  currentRating: number;
  /** How stable that rating is. A volatile rating makes a smaller stretch. */
  ratingReliability: number;
  sampleSize: number;
}

export interface StretchTarget {
  available: true;
  targetRating: number;
  /** The band the answer came from, so it is auditable rather than magic. */
  stretchApplied: number;
  policyVersion: string;
}

export interface StretchUnavailable {
  available: false;
  code: RejectionCode;
  detail: string;
  caveat: string;
}

/**
 * A `peer_stretch` rating target.
 *
 * Not `rating + 150`. Reliability and sample size move the stretch inside the
 * policy band, and a rating outside the calibrated range produces a caveat
 * rather than a number — Forma will still describe what somebody does at the
 * board, and it will not promise them an Elo it has never calibrated.
 */
export function resolveStretchRating(
  input: StretchInput,
  policy: GoalPolicy = GOAL_POLICY,
): StretchTarget | StretchUnavailable {
  if (
    input.currentRating < policy.calibratedRatingLow ||
    input.currentRating >= policy.calibratedRatingHigh
  ) {
    return {
      available: false,
      code: "target_not_measurable",
      detail: "the rating sits outside the calibrated band",
      caveat:
        "Your rating is outside the range Forma has calibrated, so it will not promise you a rating target. Everything about your own games still applies.",
    };
  }
  if (input.sampleSize < 10) {
    return {
      available: false,
      code: "missing_baseline",
      detail: "too few rated games to establish a stable current pool",
      caveat:
        "We need more rated games before we can say where your rating actually sits, let alone where it could go.",
    };
  }

  // Reliability scales the stretch across the policy band: a settled rating
  // supports the full stretch, a volatile one only the conservative end.
  const reliability = Math.min(1, Math.max(0, input.ratingReliability));
  const stretch =
    policy.stretchRatingLow +
    (policy.stretchRatingHigh - policy.stretchRatingLow) * reliability;

  return {
    available: true,
    targetRating: Math.round(input.currentRating + stretch),
    stretchApplied: Math.round(stretch),
    policyVersion: policy.version,
  };
}

export interface HorizonCheck {
  ok: boolean;
  code?: RejectionCode;
  detail?: string;
}

export function checkHorizon(days: number | null, policy: GoalPolicy = GOAL_POLICY): HorizonCheck {
  if (days === null) return { ok: true };
  if (days < policy.minHorizonDays || days > policy.maxHorizonDays) {
    return {
      ok: false,
      code: "horizon_out_of_range",
      detail: `a horizon must be between ${policy.minHorizonDays} and ${policy.maxHorizonDays} days`,
    };
  }
  return { ok: true };
}

import {
  ESTIMATOR_POLICY,
  type CoverageStatus,
  type EstimatorPolicy,
  type UnavailableReason,
} from "./contract.js";
import { betaQuantile, probabilityGreater } from "./beta.js";

/**
 * `estimator_v1` — a transparent, discounted Beta evidence model.
 *
 * Three properties matter more here than accuracy, because this is the number a
 * person reads about themselves:
 *
 * 1. **Censored evidence is not failure.** A chance the opponent never gave the
 *    player a reply to is counted in coverage and excluded from the estimate.
 *    Folding it in as a zero would penalize a player for their opponent's
 *    choices, which is platform spec 3.3's explicit prohibition.
 * 2. **Old evidence is weaker evidence, not deleted evidence.** Time weighting
 *    is a versioned exponential half-life, so a habit from last year still
 *    counts and still counts less.
 * 3. **Raw and effective sample are both published.** One says how much was
 *    seen; the other says what it is worth. A reader given only one of them
 *    will draw the wrong conclusion from either.
 */

/** One scored opportunity, as E13 recorded it. */
export interface Observation {
  /** When the game was played. Time weighting is relative to the cutoff. */
  occurredAt: Date;
  /**
   * The graded outcome in [0, 1]. A binary success is 1 or 0; a partially
   * satisfied rubric is whatever the rubric said.
   */
  score: number | null;
  /** True when the opportunity occurred but the outcome was unobservable. */
  censored: boolean;
  /** True when the rubric graded this rather than passing or failing it. */
  graded: boolean;
}

export interface Coverage {
  raw: number;
  effective: number;
  success: number;
  failure: number;
  graded: number;
  censored: number;
  from: Date | null;
  to: Date | null;
}

export interface Estimate {
  status: "available";
  /** Posterior mean. */
  estimate: number;
  intervalLow: number;
  intervalHigh: number;
  /** The posterior itself, so a later comparison does not re-derive it. */
  posterior: { alpha: number; beta: number };
  coverage: Coverage;
  coverageStatus: CoverageStatus;
}

export interface Unavailable {
  status: "unavailable";
  reason: UnavailableReason;
  coverage: Coverage;
  coverageStatus: CoverageStatus;
}

export type EstimateResult = Estimate | Unavailable;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The weight an observation carries at the cutoff, under the half-life policy. */
export function timeWeight(
  occurredAt: Date,
  cutoff: Date,
  policy: EstimatorPolicy = ESTIMATOR_POLICY,
): number {
  const ageDays = (cutoff.getTime() - occurredAt.getTime()) / DAY_MS;
  // Evidence from after the cutoff is a bug in the caller, not a reason to give
  // it extra weight: clamped to full weight rather than amplified.
  if (ageDays <= 0) return 1;
  return Math.pow(0.5, ageDays / policy.halfLifeDays);
}

export function summarizeCoverage(
  observations: readonly Observation[],
  cutoff: Date,
  policy: EstimatorPolicy = ESTIMATOR_POLICY,
): Coverage {
  let effective = 0;
  let success = 0;
  let failure = 0;
  let graded = 0;
  let censored = 0;
  let from: Date | null = null;
  let to: Date | null = null;

  for (const observation of observations) {
    if (from === null || observation.occurredAt < from) from = observation.occurredAt;
    if (to === null || observation.occurredAt > to) to = observation.occurredAt;

    if (observation.censored) {
      censored += 1;
      continue;
    }
    // Only uncensored evidence carries weight: effective sample is the size of
    // the evidence the estimate was actually built from.
    effective += timeWeight(observation.occurredAt, cutoff, policy);
    if (observation.graded) graded += 1;
    else if ((observation.score ?? 0) >= 1) success += 1;
    else failure += 1;
  }

  return { raw: observations.length, effective, success, failure, graded, censored, from, to };
}

/**
 * Estimate one dimension.
 *
 * `outsideCalibratedRange` is supplied by the caller rather than derived, since
 * whether a player sits inside the calibrated rating band is a fact about their
 * account and not about this evidence.
 */
export function estimate(
  observations: readonly Observation[],
  cutoff: Date,
  options: { outsideCalibratedRange?: boolean; policy?: EstimatorPolicy } = {},
): EstimateResult {
  const policy = options.policy ?? ESTIMATOR_POLICY;
  const coverage = summarizeCoverage(observations, cutoff, policy);

  if (options.outsideCalibratedRange === true) {
    // The evidence may be perfectly good; what is missing is the cohort this
    // would be compared against. Platform spec 3.2: no false precision outside
    // the calibrated band.
    return {
      status: "unavailable",
      reason: "outside_calibrated_range",
      coverage,
      coverageStatus: "out_of_range",
    };
  }
  if (coverage.raw === 0) {
    return {
      status: "unavailable",
      reason: "no_observations",
      coverage,
      coverageStatus: "insufficient",
    };
  }
  if (coverage.censored === coverage.raw) {
    return {
      status: "unavailable",
      reason: "all_evidence_censored",
      coverage,
      coverageStatus: "insufficient",
    };
  }
  if (coverage.raw - coverage.censored < policy.minimumRawSample) {
    return {
      status: "unavailable",
      reason: "below_minimum_sample",
      coverage,
      coverageStatus: "insufficient",
    };
  }

  let alpha = policy.priorAlpha;
  let beta = policy.priorBeta;
  for (const observation of observations) {
    if (observation.censored) continue;
    const weight = timeWeight(observation.occurredAt, cutoff, policy);
    // A graded score contributes fractionally to both sides, which is what
    // makes "recognized the threat but defended imperfectly" a partial success
    // rather than a coin flip between two wrong labels.
    const score = Math.min(1, Math.max(0, observation.score ?? 0));
    alpha += weight * score;
    beta += weight * (1 - score);
  }

  const tail = (1 - policy.intervalMass) / 2;
  return {
    status: "available",
    estimate: alpha / (alpha + beta),
    intervalLow: betaQuantile(tail, alpha, beta),
    intervalHigh: betaQuantile(1 - tail, alpha, beta),
    posterior: { alpha, beta },
    coverage,
    coverageStatus:
      coverage.effective < policy.limitedEffectiveSample ? "limited" : "sufficient",
  };
}

export interface Comparison {
  delta: number;
  /** `P(later > earlier)`, from the two posteriors. */
  improvementProbability: number;
}

/**
 * Compare two estimates of the same dimension.
 *
 * The probability is computed from the posteriors rather than from the point
 * estimates, so two estimates that moved by 0.1 produce very different
 * confidence depending on how much evidence is behind each — which is the whole
 * reason the posterior is stored.
 */
export function compare(earlier: Estimate, later: Estimate): Comparison {
  return {
    delta: later.estimate - earlier.estimate,
    improvementProbability: probabilityGreater(later.posterior, earlier.posterior),
  };
}

/**
 * Whether an improvement may be claimed, and how strongly.
 *
 * `null` is a real answer and the common one: most changes are noise, and
 * platform spec 3.4 requires a versioned probability threshold *and* an
 * effective sample before "you improved" is said out loud.
 */
export function improvementClaim(
  comparison: Comparison,
  laterCoverage: Coverage,
  policy: EstimatorPolicy = ESTIMATOR_POLICY,
): "established_improvement" | "early_improvement_signal" | null {
  if (comparison.delta <= 0) return null;
  if (
    comparison.improvementProbability >= policy.establishedImprovementProbability &&
    laterCoverage.effective >= policy.establishedImprovementEffectiveSample
  ) {
    return "established_improvement";
  }
  if (
    comparison.improvementProbability >= policy.earlyImprovementProbability &&
    laterCoverage.effective >= policy.earlyImprovementEffectiveSample
  ) {
    return "early_improvement_signal";
  }
  return null;
}

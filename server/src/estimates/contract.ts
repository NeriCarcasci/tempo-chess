/**
 * The estimator contract: what a claim about a player is allowed to be.
 *
 * Every number here is versioned policy rather than a tuning knob. Platform
 * spec 13 requires that a new calculation method be promoted through versioned
 * shadow comparison, so these are frozen constants hashed into a component
 * version — changing one produces a new estimator, not a quiet shift in
 * everyone's numbers.
 */

/** Comparison frames (platform spec 3.2). Never mixed inside one estimate. */
export const FRAMES = ["personal_current", "peer_current", "peer_stretch", "objective"] as const;
export type Frame = (typeof FRAMES)[number];

export const WINDOW_KINDS = ["lifetime", "baseline", "recent_form"] as const;
export type WindowKind = (typeof WINDOW_KINDS)[number];

export const COVERAGE_STATUSES = ["sufficient", "limited", "insufficient", "out_of_range"] as const;
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];

export const UNAVAILABLE_REASONS = [
  "no_observations",
  "all_evidence_censored",
  "below_minimum_sample",
  "outside_calibrated_range",
  "estimator_unavailable",
] as const;
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

export const FINDING_TYPES = [
  "strength",
  "foundational_miss",
  "development_frontier",
  "repeated_pattern",
  "inconsistency",
  "early_improvement_signal",
  "established_improvement",
  "transfer",
  "insufficient_evidence",
] as const;
export type FindingType = (typeof FINDING_TYPES)[number];

export const CONFIDENCE_TIERS = ["low", "moderate", "high"] as const;
export type ConfidenceTier = (typeof CONFIDENCE_TIERS)[number];

export interface EstimatorPolicy {
  version: string;
  /**
   * Days after which an observation is worth half as much.
   *
   * Chess evidence goes stale: what someone did eighteen months ago is weaker
   * evidence about them now than what they did last week. 120 days is the v1
   * choice — long enough that a casual player's evidence does not evaporate
   * between sessions, short enough that a year-old habit does not outvote a
   * current one.
   */
  halfLifeDays: number;
  /**
   * Jeffreys prior, Beta(0.5, 0.5).
   *
   * Chosen over Beta(1, 1) because a uniform prior pulls a small sample hard
   * toward 0.5, which reads as "average at everything" for exactly the players
   * we have least evidence about. Jeffreys is the standard reference prior for
   * a rate and pulls less, while still refusing to report 0.00 from three
   * observations.
   */
  priorAlpha: number;
  priorBeta: number;
  /** Equal-tailed credible interval mass. */
  intervalMass: number;
  /** Below this effective sample, the estimate is published as `limited`. */
  limitedEffectiveSample: number;
  /** Below this raw sample, there is no estimate at all. */
  minimumRawSample: number;
  /** P(recent > baseline) needed for an early signal. */
  earlyImprovementProbability: number;
  /**
   * Effective sample needed before even an early signal is shown.
   *
   * Platform spec 3.4 wants early positive evidence surfaced before stable
   * improvement can be claimed, so this is deliberately low. It is not zero:
   * with a handful of observations the probability threshold alone is reachable
   * by noise, and "you are improving" is the claim a user is least able to
   * check and most likely to act on.
   */
  earlyImprovementEffectiveSample: number;
  /** P(recent > baseline) and effective sample needed for an established claim. */
  establishedImprovementProbability: number;
  establishedImprovementEffectiveSample: number;
}

export const ESTIMATOR_POLICY: EstimatorPolicy = Object.freeze({
  version: "estimator_v1",
  halfLifeDays: 120,
  priorAlpha: 0.5,
  priorBeta: 0.5,
  intervalMass: 0.9,
  limitedEffectiveSample: 8,
  minimumRawSample: 3,
  earlyImprovementProbability: 0.8,
  earlyImprovementEffectiveSample: 8,
  establishedImprovementProbability: 0.95,
  establishedImprovementEffectiveSample: 20,
});

export interface AlignmentPolicy {
  version: string;
  /** Bins per reached phase. 18.3 asks for approximately twenty. */
  binsPerPhase: number;
  /** A phase contributes only if the game spent at least this many plies in it. */
  minPliesPerPhase: number;
  /** Bootstrap resamples for a bin's interval. Zero disables the interval. */
  bootstrapResamples: number;
}

export const ALIGNMENT_POLICY: AlignmentPolicy = Object.freeze({
  version: "trajectory_alignment_v1",
  binsPerPhase: 20,
  minPliesPerPhase: 4,
  bootstrapResamples: 400,
});

export interface FindingPolicy {
  version: string;
  /** Benjamini-Hochberg false-discovery rate, applied per claim family. */
  falseDiscoveryRate: number;
  /** An interval entirely above this is a strength. */
  strengthFloor: number;
  /** An interval entirely below this is a foundational miss. */
  missCeiling: number;
  /** Failures of one concept before it is a repeated pattern. */
  repeatedPatternFailures: number;
  /** Interval width above which a dimension is a frontier rather than a verdict. */
  frontierIntervalWidth: number;
  /** How many findings a report publishes at most. */
  maxPublishedFindings: number;
}

export const FINDING_POLICY: FindingPolicy = Object.freeze({
  version: "finding_rules_v1",
  falseDiscoveryRate: 0.1,
  strengthFloor: 0.7,
  missCeiling: 0.35,
  repeatedPatternFailures: 4,
  frontierIntervalWidth: 0.35,
  maxPublishedFindings: 12,
});

/**
 * Named budgets for the paths this epic adds, asserted by
 * `estimates:performance`.
 *
 * Wall-clock is advisory and printed; what is asserted exactly is the query
 * count, because the dashboard is one page and "how many round trips does it
 * cost" is the number that decides whether it stays fast under load.
 */
export const DASHBOARD_BUDGETS = Object.freeze({
  /** Round trips to build the whole dashboard payload. */
  maxQueries: 8,
  dashboardReadMs: 300,
  trajectoryReadMs: 250,
  estimateRunMs: 5_000,
});

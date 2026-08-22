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
  /**
   * Interval width at or below which a published claim is `high` confidence.
   *
   * The tier used to be `tierFor(rawProbability)`, which was information-free:
   * Benjamini-Hochberg at q = 0.1 cannot publish a claim whose p-value exceeds
   * 0.1, so every surviving claim had probability >= 0.9 and every published
   * finding came out `high` — thirty-six of thirty-six, in the live database.
   * A tier that is constant by construction is a decoration on a page whose
   * whole argument is that it distinguishes what it knows from what it does
   * not. It now reports how much evidence is behind the number, which is the
   * question a reader is actually asking when they look at it.
   */
  confidentIntervalWidth: number;
  /** How many findings a report publishes at most. */
  maxPublishedFindings: number;
}

export const FINDING_POLICY: FindingPolicy = Object.freeze({
  version: "finding_rules_v2",
  falseDiscoveryRate: 0.1,
  strengthFloor: 0.7,
  missCeiling: 0.35,
  repeatedPatternFailures: 4,
  frontierIntervalWidth: 0.35,
  confidentIntervalWidth: 0.2,
  /**
   * Six.
   *
   * Twelve was already a cap on a list nobody had read end to end. With the
   * two measured frames collapsed there are at most seven concept-role
   * subjects to say anything about, so a cap of twelve was not a cap at all —
   * it published everything that survived correction and called it a shortlist.
   * Six is a number of things a person can hold, and what falls off the end is
   * recorded as withheld rather than lost.
   */
  maxPublishedFindings: 6,
});

/**
 * When a finding is allowed to say where it happens.
 *
 * Versioned like every other number here: moving one of these changes which
 * sentences the product is prepared to defend, so it produces a new
 * `finding_rules` version rather than a quiet shift in what everyone is told.
 */
export interface SpecificityPolicy {
  version: string;
  /**
   * Moments behind a claim before a location may be sought at all.
   *
   * Eight is the point below which the binomial test has no power worth
   * having: with six failures, four in one phase clears every share threshold
   * and means nothing.
   */
  minSubjectSize: number;
  /** Moments inside the bucket. Three of four is not a concentration. */
  minBucketCount: number;
  /**
   * The bucket's share of the claim's own evidence.
   *
   * Low, because the lift ratio below does the real work. This only keeps the
   * sentence honest as English: "the misses bunch here" should not be said of
   * a bucket holding a fifth of them, however striking the ratio.
   */
  minShare: number;
  /**
   * How many times over-represented the bucket must be.
   *
   * A ratio, not a difference, because the difference is the wrong measure and
   * silently impossible to clear. If a phase holds 41% of the chances, then
   * failing *every single time* in it and 58% of the time elsewhere still only
   * puts 54% of the failures there — a 13-point rise, under a 15-point
   * threshold, for a rate difference of nearly two to one.
   *
   * The ratio of the bucket's share among the failures to its share among the
   * chances is exactly the relative risk: how much likelier the player is to
   * go wrong here than they are on average. 1.3 is "half again as often as
   * usual", which is a thing worth being told.
   */
  minLiftRatio: number;
  /**
   * Above this baseline share the location is refused outright.
   *
   * A concept that only ever fires in the endgame cannot have an endgame
   * problem; it has an endgame definition. The tail test alone would let a
   * large sample through here, and the sentence would be true and useless.
   */
  maxBaselineShare: number;
  /** Binomial tail probability the concentration must beat. */
  maxTailProbability: number;
}

export const SPECIFICITY_POLICY: SpecificityPolicy = Object.freeze({
  version: "specificity_v1",
  minSubjectSize: 8,
  minBucketCount: 5,
  minShare: 0.4,
  minLiftRatio: 1.3,
  maxBaselineShare: 0.75,
  maxTailProbability: 0.05,
});

/** When two phases of a game may be said to be different from each other. */
export interface PhaseContrastPolicy {
  version: string;
  /**
   * Uncensored observations of one concept and role, in one phase, before that
   * stratum may take part in a comparison.
   *
   * Both sides must clear it. Three observations against ninety is not a
   * comparison of two phases, it is the ninety with a rounding error attached.
   */
  minPerStratum: number;
  /**
   * Concept-and-role strata the two phases must share.
   *
   * One shared stratum is a finding about that concept, not about the phase,
   * and it should be published as such by the per-concept path instead.
   */
  minSharedStrata: number;
  /**
   * The smallest gap worth telling somebody about, in rate.
   *
   * A three-point difference across ten thousand observations is real and
   * useless. Nothing in a player's week changes because of it.
   */
  minGap: number;
}

export const PHASE_CONTRAST_POLICY: PhaseContrastPolicy = Object.freeze({
  version: "phase_contrast_v1",
  minPerStratum: 5,
  minSharedStrata: 2,
  minGap: 0.1,
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

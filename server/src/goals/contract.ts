/**
 * The goal contract: what a person may promise themselves, and what Forma may
 * promise them back.
 *
 * The whole epic turns on one distinction the product is permanently tempted to
 * blur. Doing the work is adherence. Being close to the target is readiness.
 * Having demonstrated it in a real game is evidence. Only the third can
 * complete a goal, and the constants here are the versioned policy that decides
 * where each line sits.
 */

export const GOAL_STATUSES = ["draft", "active", "achieved", "abandoned", "superseded"] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const CYCLE_STATUSES = ["active", "completed", "abandoned", "superseded"] as const;
export type CycleStatus = (typeof CYCLE_STATUSES)[number];

export const CLOSE_OUTCOMES = ["completed", "abandoned", "replaced"] as const;
export type CloseOutcome = (typeof CLOSE_OUTCOMES)[number];

export const GOAL_CATEGORIES = [
  "rating",
  "tactical_reliability",
  "endgame_conversion",
  "resilience",
  "decision_speed",
  "opening_repertoire",
  "custom",
] as const;
export type GoalCategory = (typeof GOAL_CATEGORIES)[number];

export const FRAMES = ["personal_current", "peer_current", "peer_stretch", "objective"] as const;
export type Frame = (typeof FRAMES)[number];

export const REQUIREMENT_KINDS = [
  "play_games",
  "review_games",
  "targeted_practice",
  "study_material",
  "rest",
] as const;
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];

export const REQUIREMENT_UNITS = ["games", "reviews", "sessions", "minutes", "days"] as const;
export type RequirementUnit = (typeof REQUIREMENT_UNITS)[number];

export const CADENCES = ["daily", "weekly", "fortnightly"] as const;
export type Cadence = (typeof CADENCES)[number];

/**
 * What a progress reading is allowed to say.
 *
 * `improving` and `target_met` are separated from `early_signal` because the
 * spec requires a versioned probability threshold before "you improved" is said
 * out loud, and a coaching product that says it early is a coaching product
 * nobody can trust when it says it late.
 */
export const CLAIM_STATES = [
  "no_evidence",
  "early_signal",
  "improving",
  "target_met",
  "declined",
  "unavailable",
] as const;
export type ClaimState = (typeof CLAIM_STATES)[number];

export const REBASE_REASONS = [
  "estimator_promoted",
  "target_cohort_recalibrated",
  "user_changed_target",
  "baseline_superseded",
] as const;
export type RebaseReason = (typeof REBASE_REASONS)[number];

export interface GoalPolicy {
  version: string;
  /** Shortest and longest horizon a goal may name, in days. */
  minHorizonDays: number;
  maxHorizonDays: number;
  /**
   * The stretch a peer_stretch target may name, in rating points.
   *
   * Platform spec 3.2: roughly 100-200 points above a stable current pool, and
   * never stored as `rating + constant` as if it were a fact. It is a policy
   * input to a resolution that also reads reliability and sample size.
   */
  stretchRatingLow: number;
  stretchRatingHigh: number;
  /** The calibrated band. Outside it a target carries a caveat, not a number. */
  calibratedRatingLow: number;
  calibratedRatingHigh: number;
  /** Real-game observations before a target may be called met. */
  minRealGameEvidence: number;
  /** Readiness at or above this is `target_met`, given the evidence rule. */
  targetMetReadiness: number;
  /** Readiness at or above this, without the evidence, is `improving`. */
  improvingReadiness: number;
  /** Any positive movement below `improvingReadiness` is an early signal. */
  earlySignalProgress: number;
  /** Requirements a plan may prescribe at once. */
  maxRequirements: number;
}

export const GOAL_POLICY: GoalPolicy = Object.freeze({
  version: "goal_policy_v1",
  minHorizonDays: 7,
  maxHorizonDays: 730,
  stretchRatingLow: 100,
  stretchRatingHigh: 200,
  calibratedRatingLow: 1000,
  calibratedRatingHigh: 2200,
  minRealGameEvidence: 1,
  targetMetReadiness: 1,
  improvingReadiness: 0.5,
  earlySignalProgress: 0,
  maxRequirements: 6,
});

/**
 * Why a proposed goal was refused.
 *
 * Stable codes rather than prose: the acceptance criteria require a rejection a
 * client can act on, and "we could not set that goal" is not one.
 */
export const REJECTION_CODES = [
  "no_such_template",
  "template_not_promoted",
  "subject_not_eligible",
  "horizon_out_of_range",
  "target_not_measurable",
  "target_inside_noise",
  "missing_baseline",
  "already_active_goal",
] as const;
export type RejectionCode = (typeof REJECTION_CODES)[number];

/** Named budgets, asserted by `goals:performance`. */
export const GOAL_BUDGETS = Object.freeze({
  maxProgressQueries: 5,
  progressReadMs: 250,
  planReadMs: 200,
});

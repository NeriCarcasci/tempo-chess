/**
 * The onboarding contract: the stages a new user passes through, what counts as
 * enough evidence, and what a free reader is always shown.
 *
 * Every threshold here is versioned policy. Platform spec 21 is explicit that
 * "fifty games" is an onboarding hypothesis rather than a database constraint or
 * a promise that every skill has enough evidence, so the number lives in a
 * frozen constant that is hashed into a component version and can be changed by
 * promoting a new one.
 */

/** The stages, in the order the API contract names them. */
export const STAGES = [
  "linking",
  "syncing",
  "analysing",
  "diagnostic",
  "report_ready",
  "goal_setting",
  "activated",
] as const;
export type Stage = (typeof STAGES)[number];

export const RUN_STATUSES = ["active", "activated", "abandoned", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const FAILURE_REASONS = [
  "no_linked_account",
  "provider_unavailable",
  "no_eligible_games",
  "analysis_failed",
  "abandoned_by_user",
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

/**
 * Legal forward transitions.
 *
 * Deliberately a forward-only graph with one exception: `diagnostic` may be
 * skipped. A user who declines the diagnostic goes straight from `analysing` to
 * `report_ready`, and that is a choice rather than a failure — the report is
 * built from their real games either way.
 */
export const TRANSITIONS: Readonly<Record<Stage, readonly Stage[]>> = Object.freeze({
  linking: ["syncing"],
  syncing: ["analysing"],
  analysing: ["diagnostic", "report_ready"],
  diagnostic: ["report_ready"],
  report_ready: ["goal_setting"],
  goal_setting: ["activated"],
  activated: [],
});

export const COVERAGE_STATES = ["insufficient", "limited", "sufficient"] as const;
export type CoverageState = (typeof COVERAGE_STATES)[number];

export interface CoveragePolicy {
  version: string;
  /**
   * Eligible games for a broadly sufficient report.
   *
   * Platform spec 14.5's number. It is a hypothesis about when a report stops
   * being mostly noise, not a guarantee that any particular skill is covered —
   * which is why the per-dimension detail exists beside it.
   */
  sufficientGames: number;
  /** Below this, there is not enough to build a report from at all. */
  minimumGames: number;
  /** Observations before a single dimension is called sufficient. */
  sufficientDimensionObservations: number;
  /** Observations before a dimension is worth showing at all. */
  minimumDimensionObservations: number;
  /** Games that must have reached a phase before the phase is reportable. */
  minimumPhaseReach: number;
  /** The calibrated provider-rating band (platform spec 3.2). */
  calibratedRatingLow: number;
  calibratedRatingHigh: number;
}

export const COVERAGE_POLICY: CoveragePolicy = Object.freeze({
  version: "coverage_policy_v1",
  sufficientGames: 50,
  minimumGames: 5,
  sufficientDimensionObservations: 12,
  minimumDimensionObservations: 3,
  minimumPhaseReach: 5,
  calibratedRatingLow: 1000,
  calibratedRatingHigh: 2200,
});

/**
 * The limitations a coverage decision can state.
 *
 * Phrased as facts about the evidence rather than about the player: "we have
 * few of your endgames" is a statement about Forma's sample, and "you avoid
 * endgames" is a judgement we have not earned.
 */
export const LIMITATIONS = [
  "few_games",
  "narrow_date_range",
  "single_speed",
  "no_clock_data",
  "few_endgames",
  "few_middlegames",
  "outside_calibrated_rating",
  "thin_dimensions",
] as const;
export type Limitation = (typeof LIMITATIONS)[number];

export const DIAGNOSTIC_PURPOSES = [
  "earlier_mishandled",
  "transfer_variant",
  "strength_confirmation",
  "target_level",
  "timed_decision",
] as const;
export type DiagnosticPurpose = (typeof DIAGNOSTIC_PURPOSES)[number];

export interface DiagnosticPolicy {
  version: string;
  /** Items in one session. Bounded: this is an examination, not a trainer. */
  itemCount: number;
  /** At most this many items investigating one dimension. */
  maxItemsPerDimension: number;
  /** A correct move inside this many milliseconds counts as a timed success. */
  timedDecisionMs: number;
}

export const DIAGNOSTIC_POLICY: DiagnosticPolicy = Object.freeze({
  version: "diagnostic_selection_v1",
  itemCount: 8,
  maxItemsPerDimension: 2,
  timedDecisionMs: 30_000,
});

export const REPORT_SECTIONS = [
  "headline",
  "coverage",
  "strengths",
  "constraints",
  "trajectory",
  "diagnostic",
  "next_steps",
] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];

/**
 * Entitlement keys a report item can carry.
 *
 * `always` is not a tier — it is the floor. Anything that states a limitation,
 * an uncertainty or a coverage gap carries it, and the database refuses a
 * coverage item that does not. Entitlements control depth and continuity; they
 * do not hide what the product does not know.
 */
export const ENTITLEMENT_KEYS = ["always", "free_summary", "pro_detail"] as const;
export type EntitlementKey = (typeof ENTITLEMENT_KEYS)[number];

export const PLANS = ["free", "pro"] as const;
export type Plan = (typeof PLANS)[number];

/** Which entitlement keys a plan may read. */
export const PLAN_ENTITLEMENTS: Readonly<Record<Plan, readonly EntitlementKey[]>> = Object.freeze({
  free: ["always", "free_summary"],
  pro: ["always", "free_summary", "pro_detail"],
});

/**
 * Named budgets for the paths this epic adds, asserted by
 * `onboarding:performance`.
 */
export const ONBOARDING_BUDGETS = Object.freeze({
  /** Round trips to answer `GET /onboarding`. */
  maxStateQueries: 4,
  /** Round trips to render a whole baseline report. */
  maxReportQueries: 4,
  stateReadMs: 200,
  reportReadMs: 300,
});

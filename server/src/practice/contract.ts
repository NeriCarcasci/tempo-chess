/**
 * The practice contract: what an exercise is, when it comes back, and what it
 * would take to say it worked.
 *
 * The rule the whole epic is built around: solving a puzzle is engagement, not
 * improvement. Everything here keeps the two apart, and the transfer policy is
 * the only place they are ever allowed to meet.
 */

export const SOURCE_KINDS = [
  "player_evidence",
  "transfer_variant",
  "editorial",
  "licensed_dataset",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const RETENTION_CLASSES = ["subject_owned", "shared", "licensed"] as const;
export type RetentionClass = (typeof RETENTION_CLASSES)[number];

export const INTERVENTION_TYPES = [
  "explanation",
  "lesson",
  "drill",
  "review",
  "recommendation",
] as const;
export type InterventionType = (typeof INTERVENTION_TYPES)[number];

export const ASSIGNMENT_STATUSES = [
  "assigned",
  "in_progress",
  "completed",
  "skipped",
  "expired",
] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export const TRANSFER_OUTCOMES = ["positive", "negative", "inconclusive"] as const;
export type TransferOutcome = (typeof TRANSFER_OUTCOMES)[number];

export const INCOMPARABLE_REASONS = [
  "different_concept",
  "different_phase",
  "different_speed",
  "too_distant_in_time",
  "similarity_below_threshold",
  "opportunity_censored",
] as const;
export type IncomparableReason = (typeof INCOMPARABLE_REASONS)[number];

export interface SchedulerPolicy {
  version: string;
  /** The first interval, in days, after a successful first attempt. */
  firstIntervalDays: number;
  /** Multiplier applied on each subsequent success. */
  easeFactor: number;
  /** Where a failed item goes. Short, but never zero: same-day is cramming. */
  lapseIntervalDays: number;
  /** The ceiling. Beyond this an item is remembered, not being learned. */
  maxIntervalDays: number;
  /**
   * How much a hinted success is worth.
   *
   * Not zero — the player did produce the move — and not one, because they were
   * shown where to look. Scheduling a hinted solve as if it were unaided is how
   * a review system convinces itself somebody knows something they do not.
   */
  hintPenalty: number;
}

export const SCHEDULER_POLICY: SchedulerPolicy = Object.freeze({
  version: "review_scheduler_v1",
  firstIntervalDays: 1,
  easeFactor: 2.2,
  lapseIntervalDays: 1,
  maxIntervalDays: 180,
  hintPenalty: 0.5,
});

export interface TransferPolicy {
  version: string;
  /**
   * The similarity below which two situations are not comparable.
   *
   * Deliberately high. A matcher that accepts loose resemblance will find
   * transfer everywhere, and a coaching product that reports transfer
   * everywhere is one whose transfer claims mean nothing.
   */
  minSimilarity: number;
  /** Days after which earlier work is too distant to have plausibly transferred. */
  maxDaysBetween: number;
  /** Days before which a later game is too soon to be independent evidence. */
  minDaysBetween: number;
  /** Matches below this confidence are recorded as inconclusive. */
  minConfidence: number;
}

export const TRANSFER_POLICY: TransferPolicy = Object.freeze({
  version: "transfer_matcher_v1",
  minSimilarity: 0.7,
  maxDaysBetween: 90,
  minDaysBetween: 0,
  minConfidence: 0.6,
});

export interface QueuePolicy {
  version: string;
  /** Items served in one queue request. A queue nobody finishes is a backlog. */
  batchSize: number;
  /** Overdue items served before new ones, up to this share of the batch. */
  overdueShare: number;
  /** Assignments outstanding before the selector stops adding more. */
  maxOutstanding: number;
}

export const QUEUE_POLICY: QueuePolicy = Object.freeze({
  version: "practice_queue_v1",
  batchSize: 10,
  overdueShare: 0.6,
  maxOutstanding: 30,
});

/** Named budgets, asserted by `practice:performance`. */
export const PRACTICE_BUDGETS = Object.freeze({
  maxQueueQueries: 3,
  queueReadMs: 200,
  attemptWriteMs: 200,
});

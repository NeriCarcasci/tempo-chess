/**
 * What counts as an observation, and what does not.
 *
 * E13's outcome is that a single "mistakes" number cannot describe a game.
 * Three distinctions carry that, and all three are pure functions here so they
 * can be exhausted without a database, and constraints in
 * `0025_e13_events_concepts.sql` so they hold even when a detector is rewritten:
 *
 *   Recognising a chance and executing it are separate observations. A player
 *   who saw the tactic and miscalculated it has a different problem from one
 *   who never saw it, and averaging them into "partially correct" describes
 *   neither.
 *
 *   A response nobody made is censored, not failed. If the opponent resigned or
 *   the game ended, the subject never got the move -- counting that as a
 *   mistake is how an estimate slanders a player for someone else's decision.
 *
 *   A score without its rubric is not a measurement. `0.6` means nothing unless
 *   something says what was being graded.
 *
 * Sources: plans/database-architecture.md §§17-18, plans/v1-platform-spec.md
 * §§3.3-3.5, 12-13.
 */

/** Database architecture §17.1. */
export const CONCEPT_CATEGORIES = [
  "tactical",
  "positional",
  "strategic",
  "defensive",
  "temporal",
  "conversion",
  "game_management",
] as const;
export type ConceptCategory = (typeof CONCEPT_CATEGORIES)[number];

/**
 * §17.4. Roles are separate observations, never points on one scale.
 *
 * `recognize` and `execute` are the pair that matters most: they are the two
 * halves this epic exists to stop collapsing into each other.
 */
export const CONCEPT_ROLES = [
  "create",
  "recognize",
  "execute",
  "avoid",
  "prevent",
  "respond",
  "convert",
] as const;
export type ConceptRole = (typeof CONCEPT_ROLES)[number];

export const EVENT_COMPLETENESS = ["complete", "incomplete", "censored"] as const;
export type EventCompleteness = (typeof EVENT_COMPLETENESS)[number];

/** §17.6. Directional where meaning requires it. */
export const RELATION_TYPES = [
  "responds_to",
  "prevents",
  "exact_repeat",
  "structural_repeat",
  "improved_response",
  "repeated_failure",
  "transfer_variant",
] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

/** §18.1. */
export const EPISODE_KINDS = [
  "setback",
  "collapse",
  "opponent_concession",
  "stabilization",
  "second_chance",
  "capitalization",
  "recovery",
  "renewed_decline",
  "conversion",
] as const;
export type EpisodeKind = (typeof EPISODE_KINDS)[number];

/**
 * Why a response was never observed.
 *
 * A closed set, because "we did not see one" has to be attributable. An
 * open-ended free-text reason would let a detector bury a bug in prose.
 */
export const CENSOR_REASONS = [
  "game_ended",
  "opponent_resigned",
  "subject_never_on_move",
  "replay_truncated",
  "clock_expired",
] as const;
export type CensorReason = (typeof CENSOR_REASONS)[number];

export interface OpportunityDraft {
  readonly role: ConceptRole;
  readonly opportunityPly: number;
  readonly responsePly: number | null;
  readonly responseObserved: boolean;
  readonly censoredReason: CensorReason | null;
  readonly success: boolean | null;
  readonly score: number | null;
  readonly rubricComponentVersionId: string | null;
  /** Derived from the position before the response. See `difficultyIsUncontaminated`. */
  readonly difficulty: Record<string, number> | null;
}

export type OpportunityProblem =
  | "censored_must_have_null_success"
  | "censored_must_have_null_score"
  | "censored_must_state_reason"
  | "observed_must_have_success"
  | "observed_must_have_response_ply"
  | "observed_must_not_be_censored"
  | "score_requires_rubric"
  | "response_precedes_opportunity";

/**
 * Every way an opportunity row would be a lie.
 *
 * Returned as a list rather than thrown so a detector can report all of them at
 * once, and so the unit gate can exhaust them.
 */
export function inspectOpportunity(draft: OpportunityDraft): OpportunityProblem[] {
  const problems: OpportunityProblem[] = [];

  if (!draft.responseObserved) {
    // §17.5: no response means no observation. Not a failure.
    if (draft.success !== null) problems.push("censored_must_have_null_success");
    if (draft.score !== null) problems.push("censored_must_have_null_score");
    if (!draft.censoredReason) problems.push("censored_must_state_reason");
  } else {
    if (draft.success === null) problems.push("observed_must_have_success");
    if (draft.responsePly === null) problems.push("observed_must_have_response_ply");
    if (draft.censoredReason) problems.push("observed_must_not_be_censored");
  }

  if (draft.score !== null && !draft.rubricComponentVersionId) {
    problems.push("score_requires_rubric");
  }
  if (draft.responsePly !== null && draft.responsePly < draft.opportunityPly) {
    problems.push("response_precedes_opportunity");
  }
  return problems;
}

export function isRecordableOpportunity(draft: OpportunityDraft): boolean {
  return inspectOpportunity(draft).length === 0;
}

/**
 * Whether a set of observations may be counted as skill evidence.
 *
 * Censored opportunities are excluded rather than counted as failures. This is
 * the function an estimator must call: counting `total - successes` as failures
 * is exactly the arithmetic §17.5 forbids.
 */
export interface ObservationTally {
  readonly observed: number;
  readonly successes: number;
  readonly failures: number;
  readonly censored: number;
}

export function tallyObservations(drafts: readonly OpportunityDraft[]): ObservationTally {
  let observed = 0;
  let successes = 0;
  let failures = 0;
  let censored = 0;
  for (const draft of drafts) {
    if (!draft.responseObserved) {
      censored += 1;
      continue;
    }
    observed += 1;
    if (draft.success) successes += 1;
    else failures += 1;
  }
  return { observed, successes, failures, censored };
}

/**
 * The success rate over observations only, or null when there are none.
 *
 * Null rather than zero. A subject with no observed chances has an unknown
 * rate, and rendering that as 0% is the difference between "we do not know" and
 * "they always fail".
 */
export function successRate(tally: ObservationTally): number | null {
  if (tally.observed === 0) return null;
  return tally.successes / tally.observed;
}

/**
 * Whether a difficulty vector could have been computed without the outcome.
 *
 * §17.5 requires difficulty to be produced without using the observed result.
 * This cannot prove independence, but it can catch the obvious violation: a
 * difficulty vector that carries the outcome back into itself.
 */
const OUTCOME_DERIVED_KEYS = new Set(["success", "succeeded", "failed", "score", "correct", "result"]);

export function difficultyIsUncontaminated(difficulty: Record<string, number> | null): boolean {
  if (!difficulty) return true;
  return !Object.keys(difficulty).some((key) => OUTCOME_DERIVED_KEYS.has(key.toLowerCase()));
}

/**
 * Whether an episode may be attributed to the subject.
 *
 * §18.1 keeps `opponent_concession` and `recovery` as distinct kinds. A position
 * that improved because the opponent erred is not the subject recovering, and
 * relabelling one as the other credits a player for someone else's mistake.
 */
const SUBJECT_ATTRIBUTED: ReadonlySet<EpisodeKind> = new Set<EpisodeKind>([
  "stabilization",
  "capitalization",
  "recovery",
  "conversion",
]);

export function isSubjectAttributed(kind: EpisodeKind): boolean {
  return SUBJECT_ATTRIBUTED.has(kind);
}

/**
 * Whether a relation claim carries the evidence that makes it auditable.
 *
 * §17.6: "these two positions are comparable" is a claim, and a claim needs a
 * method and components. An `improved_response` in particular must name what it
 * compared, or it is an assertion wearing a foreign key.
 */
export interface RelationDraft {
  readonly relationType: RelationType;
  readonly fromEventId: number;
  readonly toEventId: number;
  readonly methodVersion: string;
  readonly components: Record<string, unknown> | null;
}

export function relationIsAuditable(draft: RelationDraft): boolean {
  if (draft.fromEventId === draft.toEventId) return false;
  if (!draft.methodVersion) return false;
  if (!draft.components || Object.keys(draft.components).length === 0) return false;
  return true;
}

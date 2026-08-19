/**
 * Every enum the onboarding API returns, and the sentence it becomes.
 *
 * In one place because the same value appears on three screens, and because a
 * missing entry is the failure mode that matters: a raw slug like
 * `outside_calibrated_rating` on screen is worse than no line at all, and a
 * fallback that prints the slug is how it gets shipped.
 *
 * The server does not send these sentences. It has them — `limitationText()` in
 * server/src/onboarding/coverage.ts — but no route returns them, so the client
 * carries its own copy. When a route starts returning them, delete this half.
 */

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

/**
 * The seven stages, plus the synthetic `not_started` that only
 * `GET /v1/onboarding` emits when there is no run at all.
 */
export const STAGE_ORDER = [
  "linking",
  "syncing",
  "analysing",
  "diagnostic",
  "report_ready",
  "goal_setting",
  "activated",
] as const;

export type Stage = (typeof STAGE_ORDER)[number] | "not_started";

export const STAGE_LABEL: Record<Stage, string> = {
  not_started: "Not started",
  linking: "Connecting",
  syncing: "Importing",
  analysing: "Analysing",
  diagnostic: "Examining",
  report_ready: "Report ready",
  goal_setting: "Setting a goal",
  activated: "Done",
};

// ---------------------------------------------------------------------------
// Failure
// ---------------------------------------------------------------------------

export const FAILURE_REASONS = [
  "no_linked_account",
  "provider_unavailable",
  "no_eligible_games",
  "analysis_failed",
  "abandoned_by_user",
] as const;

export type FailureReason = (typeof FAILURE_REASONS)[number];

export interface FailureCopy {
  title: string;
  detail: string;
  /** Whether offering "try again" is honest for this reason. */
  retryable: boolean;
}

/**
 * Five reasons, five sentences, five next steps.
 *
 * Only `no_linked_account` is written by anything today; the other four are
 * declared by the contract and will arrive as the workers grow. They are
 * written now because the alternative is a generic apology appearing the first
 * time one fires.
 *
 * `no_eligible_games` deliberately does not blame the reader. Playing bullet, or
 * playing unrated, is not a mistake — it is a thing Forma cannot read yet.
 */
export const FAILURE_COPY: Record<FailureReason, FailureCopy> = {
  no_linked_account: {
    title: "There is no chess account to read",
    detail:
      "Connect a Lichess account and Forma will start from its games. Nothing was lost — this journey just had nothing to work from.",
    retryable: false,
  },
  provider_unavailable: {
    title: "Your chess site did not answer",
    detail:
      "Lichess or Chess.com was unreachable while we were reading your games. This is on their side and it usually passes.",
    retryable: true,
  },
  no_eligible_games: {
    title: "None of your games could be read",
    detail:
      "Forma reads rated standard games against human opponents. That is a limit of what it can say something honest about, not a judgement about how you play.",
    retryable: false,
  },
  analysis_failed: {
    title: "The analysis did not finish",
    detail: "Something broke while your games were being analysed. Your games are safe and untouched.",
    retryable: true,
  },
  abandoned_by_user: {
    title: "This journey was stopped",
    detail: "You can start a fresh one whenever you like.",
    retryable: true,
  },
};

// ---------------------------------------------------------------------------
// Coverage limitations
// ---------------------------------------------------------------------------

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

export const LIMITATION_TEXT: Record<Limitation, string> = {
  few_games: "There are not many games here yet, so most of this is a first impression.",
  narrow_date_range: "These games are all from a short window, so this describes a period rather than a habit.",
  single_speed: "Every game is at one time control, so nothing here transfers to the others.",
  no_clock_data: "Your games carry no clock data, so nothing can be said about time pressure.",
  few_endgames: "Few of these games reached an endgame, so that part is largely unread.",
  few_middlegames: "Few of these games reached a middlegame, so that part is largely unread.",
  outside_calibrated_rating: "Your rating sits outside the band Forma has calibrated against, so comparisons are weaker than usual.",
  thin_dimensions: "Several areas have too little behind them to report on.",
};

/**
 * A sentence for any limitation, including one this build has never seen.
 *
 * The set is closed server-side today, and a client that crashed or printed a
 * slug the day it grew would be worse than one that says something true and
 * vague.
 */
export function limitationText(slug: string): string {
  return (
    LIMITATION_TEXT[slug as Limitation] ??
    "There is a limit on what these games can show, and this one is not described yet."
  );
}

// ---------------------------------------------------------------------------
// The baseline report
// ---------------------------------------------------------------------------

/**
 * The intended reading order.
 *
 * The API returns items ordered `section, display_order` — alphabetical, not
 * this. Coverage comes second on purpose: what Forma could read comes before
 * what it concluded.
 */
export const SECTION_ORDER = [
  "headline",
  "coverage",
  "strengths",
  "constraints",
  "trajectory",
  "diagnostic",
  "next_steps",
] as const;

export type Section = (typeof SECTION_ORDER)[number];

export const SECTION_TITLE: Record<Section, string> = {
  headline: "In short",
  coverage: "What Forma could read",
  strengths: "What is working",
  constraints: "What is holding you back",
  trajectory: "Over time",
  diagnostic: "From the examination",
  next_steps: "Where to start",
};

export function sectionTitle(section: string): string {
  return SECTION_TITLE[section as Section] ?? section.replace(/_/g, " ");
}

/** Sort sections into the intended reading order; unknown sections go last. */
export function sortSections(sections: readonly string[]): string[] {
  const rank = (section: string): number => {
    const index = (SECTION_ORDER as readonly string[]).indexOf(section);
    return index === -1 ? SECTION_ORDER.length : index;
  };
  return [...sections].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** What a withheld group actually is, in the reader's words. */
export const ENTITLEMENT_NAMES: Record<string, string> = {
  pro_detail: "The per-area detail behind this",
  free_summary: "The summary",
  always: "This",
};

export function entitlementName(key: string): string {
  return ENTITLEMENT_NAMES[key] ?? "Some of this";
}

// ---------------------------------------------------------------------------
// Work items
// ---------------------------------------------------------------------------

/**
 * `progress.stage` is a raw task type — the identifier a worker registered
 * itself under. It is the only progress detail the API gives (`progress.message`
 * is hardcoded null), so it needs a label rather than being shown raw.
 */
export const WORKFLOW_STAGE_LABEL: Record<string, string> = {
  provider_account_sync: "Reading your games from Lichess",
  chess_materialize_replay: "Rebuilding the positions",
  stockfish_screen_game: "Looking over every move",
  stockfish_deep_game: "Studying the moments that mattered",
  analysis_assess_transitions: "Judging the decisions",
  analysis_practical_context: "Working out how hard each one was",
  coaching_onboarding_prepare: "Gathering what to read",
  coaching_examination_report: "Working out where you stand",
  coaching_baseline_examination: "Writing your report",
  coaching_onboarding_advance: "Finishing up",
};

/** Null when there is nothing outstanding — say nothing rather than guessing. */
export function workflowStageLabel(stage: string | null): string | null {
  if (stage === null) return null;
  return WORKFLOW_STAGE_LABEL[stage] ?? "Working";
}

/**
 * The server's own wait sentence, capitalised and otherwise untouched.
 *
 * The caption belongs to whoever knows what is happening, and that is the
 * server. Rewriting it here is how a screen ends up saying "analysing" while
 * the work is a sync.
 */
export function waitLabel(reason: string | undefined): string {
  if (!reason) return "Working";
  return reason.charAt(0).toUpperCase() + reason.slice(1);
}

/** `pawn_structure_objective` → `Pawn structure`. Frame suffixes are stripped
 *  server-side already, but the key stays an open set, so this must not switch. */
export function humaniseDimension(key: string): string {
  const words = key.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

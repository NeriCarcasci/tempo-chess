/**
 * The published dashboard, and the shapes a page can read off it.
 *
 * `GET /v1/dashboard` returns every measurement behind the profile in one
 * document: sixty-odd skill estimates, the findings, the trajectory bins, the
 * rating pools and a version block. Nothing here computes a new statistic about
 * a player. It groups, names and orders what the API already sent, and every
 * number a screen prints comes off the wire.
 *
 * Three things about the payload would go wrong quietly, and this module is
 * where they are handled once rather than in every component.
 *
 * **The dimension key carries a frame suffix and the display name is a slug.**
 * `estimates/aggregate.ts` writes the key as `${concept}_${role}_${frame}` and
 * the display name as `` `${concept_slug} (${role})` ``, so the wire says
 * `material_safety_respond_objective` and `material_safety (respond)`. Neither
 * is a thing to show a person. `splitDimensionKey` recovers the base key that
 * `measures.ts` names, and the display name from the wire is never rendered.
 *
 * **One measure arrives as several rows.** Every dimension is estimated in two
 * frames, and the personal frame also stores the earlier half it compares
 * against, so seven measures arrive as up to twenty-one rows — and a run that
 * wrote more than once arrives as a multiple of that. A page that listed rows
 * would show the same measure three times under three unreadable names.
 * `groupMeasures` collapses them to one group per measure, keeps every row it
 * was given, and never drops one silently.
 *
 * **A censored chance is not a failure.** `coverage.censored` counts chances
 * the player never got to answer — the opponent resigned, the game ended — and
 * they are excluded from the rate rather than counted against it. The split is
 * carried through here as three separate numbers so no caller can add the wrong
 * two together.
 */

import { v1, type V1Result } from "./client";
import { ProblemError } from "./problem";
import { measureFor, measureName } from "./measures";
import { coneFinding, coneFrom, type Cone } from "../trajectory";
import type { Dashboard, Finding, RatingProfile, SkillEstimate } from "./types";

// ---------------------------------------------------------------------------
// Reading it
// ---------------------------------------------------------------------------

/**
 * The caller's dashboard, or null when nothing has been published yet.
 *
 * A 404 means "no subject, not yours, or nothing published", which the route
 * deliberately does not distinguish. All three read as "there is nothing to
 * show", which is a page state rather than an error. Anything else is a real
 * failure and is thrown, because a screen that renders an empty profile after a
 * 500 is telling somebody they have no chess.
 *
 * The envelope comes back whole rather than just the payload. `meta.redactions`
 * names the sections a plan withheld, and dropping it would silently turn "you
 * may not see this" into "this does not exist" — on the one page whose entire
 * job is telling somebody what Forma knows about them.
 */
export async function getDashboard(): Promise<V1Result<Dashboard> | null> {
  try {
    return await v1<Dashboard>("/v1/dashboard");
  } catch (error) {
    // A 401 arrives as a redirect `Response`, which React Router has to see.
    if (error instanceof Response) throw error;
    if (error instanceof ProblemError && error.status === 404) return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/**
 * The frames the estimator writes, longest first.
 *
 * Longest first matters: `peer_current` and `personal_current` both end in
 * `current`, and a shortest-match strip would leave `personal` glued to the
 * base key and lose the lookup.
 */
const FRAME_SUFFIXES = [
  "personal_current",
  "peer_current",
  "peer_stretch",
  "objective",
] as const;

export interface DimensionParts {
  /** `material_safety_respond` — the key `measures.ts` names. */
  baseKey: string;
  /** The frame the suffix carried, or null for a key without one. */
  frame: string | null;
}

/**
 * Split `material_safety_respond_objective` into its measure and its frame.
 *
 * A key with no recognised suffix comes back whole with a null frame rather
 * than being truncated on a guess. The catalogue is an open set on the server,
 * and mangling a key added after this build shipped would be worse than
 * carrying it through intact.
 */
export function splitDimensionKey(dimensionKey: string): DimensionParts {
  for (const frame of FRAME_SUFFIXES) {
    if (dimensionKey.endsWith(`_${frame}`)) {
      return { baseKey: dimensionKey.slice(0, -(frame.length + 1)), frame };
    }
  }
  return { baseKey: dimensionKey, frame: null };
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/**
 * Sufficient first, because a claim Forma can stand behind should lead.
 *
 * `out_of_range` is its own rank and its own sentence. It is not thin evidence:
 * it is a definite statement that the player's rating sits outside the band the
 * estimator was calibrated on, and sorting it with the unknowns would file a
 * refusal as an absence.
 */
const COVERAGE_RANK: Record<string, number> = {
  sufficient: 0,
  limited: 1,
  out_of_range: 2,
  insufficient: 3,
};

export function coverageRank(status: string): number {
  return COVERAGE_RANK[status] ?? 4;
}

/**
 * Why an estimate has no number, in the reader's words.
 *
 * "Not enough evidence" and "measured at zero" are opposite statements, and a
 * screen that prints neither leaves a blank that reads as the second. Every
 * reason the contract declares has a sentence here; an unrecognised one gets a
 * true and vague sentence rather than the slug.
 */
const UNAVAILABLE_TEXT: Record<string, string> = {
  no_observations: "No chance like this came up in the games Forma read.",
  all_evidence_censored:
    "Every chance ended before you could answer, so there is nothing here to score. That is not a failure on your part.",
  below_minimum_sample: "Too few chances so far to put a number on this.",
  outside_calibrated_range:
    "Your rating sits outside the band Forma calibrated against, so it will not put a number here.",
  estimator_unavailable: "Forma could not run this measure for this report.",
  metric_not_estimated: "This report did not measure this.",
};

export function unavailableText(reason: string | null): string {
  if (reason === null) return "Forma did not say why there is no figure here.";
  return (
    UNAVAILABLE_TEXT[reason] ??
    "There is no figure here, and this build does not carry the reason the estimator gave."
  );
}

// ---------------------------------------------------------------------------
// Grouping the estimates
// ---------------------------------------------------------------------------

export interface MeasureGroup {
  baseKey: string;
  /** The name a player reads. Never the wire's `displayName`. */
  name: string;
  /** One sentence about what the measure is, or null for one this build has not met. */
  definition: string | null;
  /** How a chance here can end with no answer, or null when it cannot. */
  censoring: string | null;
  /**
   * The headline: the objective frame over the whole window.
   *
   * This is the row a reader means by "how often do I do this". The personal
   * frame is the same player against their own earlier evidence, which answers
   * a different question and is shown as a change rather than as the figure.
   */
  headline: SkillEstimate;
  /** The recent window, when the personal frame produced one. */
  recent: SkillEstimate | null;
  /** The earlier half the recent window is compared against. */
  baseline: SkillEstimate | null;
  /** Every row that arrived under this measure, so nothing is dropped unseen. */
  rows: SkillEstimate[];
}

/** Is this the row that answers "how often, over everything Forma read"? */
function isHeadline(row: SkillEstimate): boolean {
  return row.frame === "objective" && row.windowKind === "lifetime";
}

/**
 * Pick one row of several for a slot, preferring the one that carries a number.
 *
 * A run that wrote its estimates twice leaves two rows in the same slot. They
 * agree when both are available, so the tie-break only matters when one is
 * unavailable and the other is not, and in that case the number is the more
 * useful of the two. Sample size breaks the remaining ties so the choice is
 * deterministic rather than dependent on row order.
 */
function best(rows: readonly SkillEstimate[]): SkillEstimate | null {
  let chosen: SkillEstimate | null = null;
  for (const row of rows) {
    if (chosen === null) {
      chosen = row;
      continue;
    }
    const hasValue = row.estimate !== null;
    const chosenHasValue = chosen.estimate !== null;
    if (hasValue !== chosenHasValue) {
      if (hasValue) chosen = row;
      continue;
    }
    if (row.rawSampleSize > chosen.rawSampleSize) chosen = row;
  }
  return chosen;
}

/**
 * One group per measure, ordered so the claims Forma can stand behind lead.
 *
 * A measure with no objective row still gets a group: its headline falls back
 * to whichever row it has, because dropping the measure entirely would turn a
 * frame the estimator skipped into a chance that never happened.
 */
export function groupMeasures(estimates: readonly SkillEstimate[]): MeasureGroup[] {
  const byBase = new Map<string, SkillEstimate[]>();
  for (const row of estimates) {
    const { baseKey } = splitDimensionKey(row.dimensionKey);
    byBase.set(baseKey, [...(byBase.get(baseKey) ?? []), row]);
  }

  const groups: MeasureGroup[] = [];
  for (const [baseKey, rows] of byBase) {
    const headline = best(rows.filter(isHeadline)) ?? best(rows);
    if (!headline) continue;
    const measure = measureFor(baseKey);
    groups.push({
      baseKey,
      name: measureName(baseKey),
      definition: measure?.definition ?? null,
      censoring: measure?.censoring ?? null,
      headline,
      recent: best(rows.filter((row) => row.windowKind === "recent_form")),
      baseline: best(rows.filter((row) => row.windowKind === "baseline")),
      rows,
    });
  }

  return groups.sort((a, b) => {
    const rank = coverageRank(a.headline.coverageStatus) - coverageRank(b.headline.coverageStatus);
    if (rank !== 0) return rank;
    const sample = b.headline.rawSampleSize - a.headline.rawSampleSize;
    if (sample !== 0) return sample;
    return a.name.localeCompare(b.name);
  });
}

/**
 * The largest number of chances behind any measure, or null when there are none.
 *
 * Only ever a denominator for a bar's width. It is not a statistic about the
 * player and is never shown as one.
 */
export function widestSample(groups: readonly MeasureGroup[]): number | null {
  let widest = 0;
  for (const group of groups) {
    if (group.headline.rawSampleSize > widest) widest = group.headline.rawSampleSize;
  }
  return widest > 0 ? widest : null;
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/**
 * What a kind of finding is, in the reader's words.
 *
 * The wire sends `foundational_miss`. The vocabulary is closed on the server
 * (`estimates/contract.ts`), so an unmapped value means the server grew a new
 * one, and the fallback is a plain noun rather than the slug.
 */
const FINDING_LABEL: Record<string, string> = {
  strength: "A strength",
  foundational_miss: "Something basic going wrong",
  development_frontier: "The edge of what you can do",
  repeated_pattern: "A pattern that repeats",
  inconsistency: "Something you do inconsistently",
  early_improvement_signal: "An early sign of improvement",
  established_improvement: "An improvement that has held",
  transfer: "Something carrying over",
  insufficient_evidence: "Not enough evidence yet",
};

export function findingLabel(findingType: string): string {
  return FINDING_LABEL[findingType] ?? "A conclusion";
}

/** How sure Forma is, as a word rather than as a tier name. */
const CONFIDENCE_LABEL: Record<string, string> = {
  high: "Confident",
  moderate: "Fairly sure",
  low: "Tentative",
};

export function confidenceLabel(tier: string): string {
  return CONFIDENCE_LABEL[tier] ?? "Confidence not stated";
}

/**
 * The findings worth showing, strongest first, with the unreadable ones counted.
 *
 * A finding whose rendered text failed the renderer's own safety check arrives
 * with a null explanation, and there is no endpoint that turns an id into a
 * sentence. Those are counted rather than described: an invented sentence is
 * the one failure this product cannot survive.
 */
export interface FindingSplit {
  readable: Finding[];
  /** Carrying an id and no text. Counted, never described. */
  silent: number;
}

export function splitFindings(findings: readonly Finding[]): FindingSplit {
  const ordered = [...findings].sort((a, b) => b.priority - a.priority);
  return {
    readable: ordered.filter((finding) => (finding.explanation ?? "").trim() !== ""),
    silent: ordered.filter((finding) => (finding.explanation ?? "").trim() === "").length,
  };
}

/**
 * The one conclusion worth putting in front of somebody who has not asked.
 *
 * Highest priority with text that passed its own check, and never a gap
 * finding: "there is not enough evidence about you" is true and is not a reason
 * to open a report.
 */
export function headlineFinding(findings: readonly Finding[]): Finding | null {
  const candidates = splitFindings(findings).readable.filter(
    (finding) => finding.findingType !== "insufficient_evidence",
  );
  return candidates[0] ?? null;
}

// ---------------------------------------------------------------------------
// What the whole document holds
// ---------------------------------------------------------------------------

export interface DashboardHoldings {
  /** Measures with a number on them. */
  measured: number;
  /** Measures the estimator refused to put a number on. */
  unmeasured: number;
  conclusions: number;
  trajectoryGames: number;
  /** Distinct phases the trajectory actually covers. */
  phases: number;
}

/**
 * What is inside, counted from what came back.
 *
 * Used by the one line on `/today` that asks somebody to open the report. A
 * count of rows that arrived is not a new claim about the player, which is why
 * this is allowed to appear somewhere they have not opted into reading.
 */
export function holdingsOf(dashboard: Dashboard): DashboardHoldings {
  const groups = groupMeasures(dashboard.estimates);
  return {
    measured: groups.filter((group) => group.headline.estimate !== null).length,
    unmeasured: groups.filter((group) => group.headline.estimate === null).length,
    conclusions: splitFindings(dashboard.findings).readable.length,
    trajectoryGames: dashboard.trajectory.includedGameCount,
    phases: new Set(dashboard.trajectory.bins.map((bin) => bin.phase)).size,
  };
}

// ---------------------------------------------------------------------------
// The one line the hub shows
// ---------------------------------------------------------------------------

/**
 * Which pool to quote when a page has room for one rating.
 *
 * A fixed preference, not the highest number. The API refuses to combine pools
 * because they are not comparable, so any single figure is a choice — and a
 * choice made by picking the largest is flattery dressed as a measurement. This
 * order is stated, deterministic, and the speed is always printed beside the
 * figure so the reader knows which pool they are looking at.
 */
const SPEED_PREFERENCE = ["blitz", "rapid", "classical", "bullet"];

export interface QuotedRating {
  provider: string;
  speed: string;
  rating: number;
}

export function quotedRating(profile: RatingProfile): QuotedRating | null {
  if (profile.state !== "published") return null;
  const usable = profile.pools.filter((pool) => pool.observedRating !== null);
  if (usable.length === 0) return null;
  const rank = (speed: string): number => {
    const index = SPEED_PREFERENCE.indexOf(speed);
    return index === -1 ? SPEED_PREFERENCE.length : index;
  };
  const chosen = [...usable].sort(
    (a, b) => rank(a.speed) - rank(b.speed) || a.provider.localeCompare(b.provider),
  )[0]!;
  return { provider: chosen.provider, speed: chosen.speed, rating: chosen.observedRating! };
}

/**
 * What `/today` says about the report, and what it says is inside it.
 *
 * The hub used to carry a stated absence here — no rating, no record, no
 * analysed-game count — because every one of those figures came from tables the
 * pipeline stopped writing. `/v1/dashboard` publishes all of them, so the
 * absence is over, and this is the shape the hub renders.
 *
 * Two claims and a count. The heading is the trajectory's own conclusion, which
 * is derived and refuses to name a phase unless the games actually separate.
 * The supporting line is Forma's top finding in its own words, or nothing at
 * all — never a sentence written here to fill the slot. The count is rows that
 * came back, which is not a new claim about the player and is therefore safe to
 * put in front of somebody who has not opted into reading it.
 */
export interface TodayReport {
  headline: string;
  detail: string;
  /** Forma's strongest conclusion, in its own words, or null. */
  finding: string | null;
  /** The graph itself. The hub draws the same one the profile and report do. */
  cone: Cone | null;
  measured: number;
  conclusions: number;
  games: number;
  rating: QuotedRating | null;
}

export function todayReport(dashboard: Dashboard): TodayReport | null {
  const cone = coneFrom(dashboard.trajectory);
  const holdings = holdingsOf(dashboard);
  const finding = headlineFinding(dashboard.findings);

  // With no trajectory and no readable finding there is no claim to make, and a
  // row that cannot state its reason does not render. That is the hub's own
  // rule and it applies to the thing at the top of it as much as to the list.
  if (cone === null && finding === null) return null;

  const reading = cone === null ? null : coneFinding(cone);
  return {
    headline: reading?.headline ?? "Forma has finished reading your games.",
    detail: reading?.detail ?? "",
    finding: finding?.explanation ?? null,
    cone,
    measured: holdings.measured,
    conclusions: holdings.conclusions,
    games: holdings.trajectoryGames,
    rating: quotedRating(dashboard.ratingProfile),
  };
}

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
import { CENSORING_NOTE, measureName } from "./measures";
import {
  coneFinding,
  coneFrom,
  costliestPhase,
  type Cone,
  type PhaseAccuracy,
} from "../trajectory";
import type { Dashboard, Finding, RatingProfile, SkillEstimate } from "./types";

/** One published phase card, as the dashboard carries it. */
export type PhaseFigure = Dashboard["phases"]["phases"][number];

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
/**
 * The last read publication, shared by every screen that needs it.
 *
 * Five surfaces read this one document — the hub, both phase pages, the
 * profile and the report — and each was paying its own round trip for it,
 * which on a managed database is most of a second per navigation for an
 * answer that cannot have changed. A publication only changes when a new
 * examination lands, so a short shared window is safe in a way that caching
 * a live query would not be, and it is what makes moving between the phase
 * pages feel like moving inside one page.
 */
let cached: { at: number; result: V1Result<Dashboard> | null } | null = null;
const DASHBOARD_TTL_MS = 60_000;

/** Drop the shared copy. For anything that knows a new publication landed. */
export function forgetDashboard(): void {
  cached = null;
}

export async function getDashboard(): Promise<V1Result<Dashboard> | null> {
  if (cached && Date.now() - cached.at < DASHBOARD_TTL_MS) return cached.result;
  try {
    const result = await v1<Dashboard>("/v1/dashboard");
    cached = { at: Date.now(), result };
    return result;
  } catch (error) {
    // A 401 arrives as a redirect `Response`, which React Router has to see.
    if (error instanceof Response) throw error;
    if (error instanceof ProblemError && error.status === 404) {
      // "Nothing published" is a page state, and a stable one: cached like an
      // answer rather than re-asked on every navigation.
      cached = { at: Date.now(), result: null };
      return null;
    }
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
  no_observations: "No key moment like this came up in the games Forma read.",
  all_evidence_censored:
    "Every moment like this ended before you could answer, so there is nothing here to score. That is not a failure on your part.",
  below_minimum_sample: "Too few key moments so far to put a number on this.",
  outside_calibrated_range:
    "Your rating sits outside the band Forma calibrated against, so it will not put a number here.",
  estimator_unavailable: "Forma could not run this measure for this report.",
  metric_not_estimated: "This report did not measure this.",
};

/**
 * Why a rating was not placed on Forma's scale, in the reader's words.
 *
 * `subject_rating_scale_estimates.suppressed_reason` is free text and nothing
 * writes it on this branch, so the first producer decides whether it is a
 * sentence or a slug. A string with no space in it is a slug, and printing one
 * on a page about somebody's chess is the failure the whole copy layer exists
 * to prevent — so it is described rather than shown.
 */
export function suppressionText(reason: string): string {
  return reason.includes(" ")
    ? reason
    : "Forma did not place this rating on its own scale, and this build does not carry the reason it gave.";
}

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
    // The words come from the estimate the API sent rather than from a table
    // here, so a concept promoted after this build shipped still reads as a
    // sentence. `measureName` is the floor, not the source.
    const copy = headline.copy;
    groups.push({
      baseKey,
      name: copy?.conceptSlug ? headline.displayName : measureName(baseKey),
      definition: copy?.definition ? copy.definition : null,
      // Shown only where the API reports censored chances; see `Measurements`.
      censoring: CENSORING_NOTE,
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
// Which way a measure is going
// ---------------------------------------------------------------------------

/**
 * The thresholds the estimator itself publishes findings at.
 *
 * `server/src/estimates/contract.ts` calls a change an early signal at a
 * posterior of 0.8 and established at 0.95. They are restated here rather than
 * chosen: a screen that drew its own line for "real" would be a second opinion
 * with no version behind it, and the two would drift the first time the policy
 * moved. If the server's numbers change, these are wrong and should follow.
 */
export const EARLY_PROBABILITY = 0.8;
export const ESTABLISHED_PROBABILITY = 0.95;

/**
 * The same two thresholds, mirrored for a change going the other way.
 *
 * Written out rather than computed as `1 - EARLY_PROBABILITY`: in binary
 * floating point that expression is 0.19999999999999996, so a posterior of
 * exactly 0.2 falls through the comparison it is meant to satisfy and a
 * measure on the boundary is silently reported as no clear change. The
 * relationship is stated here instead of evaluated.
 */
export const SLIPPING_PROBABILITY = 0.2;
export const DECLINED_PROBABILITY = 0.05;

/**
 * What may be said about a measure's movement.
 *
 * The decline states are the mirror of the improvement ones — a posterior of
 * 0.05 that a player improved is the same evidence as 0.95 that they did not —
 * and they exist here because the *findings* vocabulary has no decline type at
 * all. It can publish `early_improvement_signal` and `established_improvement`
 * and nothing in the other direction, so a report built only from findings can
 * report every gain and no loss. PRODUCT.md's first principle is that the
 * unflattering numbers are the ones that earn trust, and its anti-reference is
 * a product that hides a losing record. Reading the posterior directly is what
 * lets this page say a thing got worse.
 */
export type Movement = "declined" | "slipping" | "unclear" | "gaining" | "improved";

export function movementOf(improvementProbability: number | null): Movement {
  if (improvementProbability === null) return "unclear";
  if (improvementProbability <= DECLINED_PROBABILITY) return "declined";
  if (improvementProbability <= SLIPPING_PROBABILITY) return "slipping";
  if (improvementProbability >= ESTABLISHED_PROBABILITY) return "improved";
  if (improvementProbability >= EARLY_PROBABILITY) return "gaining";
  return "unclear";
}

/** How a movement is said out loud. Never a bare direction: the certainty is the claim. */
export const MOVEMENT_COPY: Record<Movement, { label: string; tone: string }> = {
  declined: { label: "Declined", tone: "is-declined" },
  slipping: { label: "Slipping", tone: "is-slipping" },
  unclear: { label: "No clear change", tone: "is-unclear" },
  gaining: { label: "Improving", tone: "is-gaining" },
  improved: { label: "Improved", tone: "is-improved" },
};

export interface Measure {
  baseKey: string;
  /** The catalogue's own name. Never the wire's `displayName`, never a key. */
  name: string;
  /**
   * Which job this measure is, when the concept covers more than one.
   *
   * Load-bearing rather than decorative. `critical_moment` is measured twice —
   * once for noticing the position and once for playing it — and both rows
   * carry the concept name "Positions that decide the game". Without the role
   * the stack shows the same name twice with different numbers beside it, which
   * reads as a duplicate row rather than as two different things.
   */
  role: string | null;
  /**
   * The catalogue's family for this concept — `tactical`, `defensive`,
   * `conversion` — or null on one the catalogue has not classed. It is what
   * lets the hub roll twenty-odd measures into a handful of cards without
   * inventing a taxonomy of its own.
   */
  category: string | null;
  definition: string | null;
  /** The standing rate over everything read, or null with no figure. */
  rate: number | null;
  intervalLow: number | null;
  intervalHigh: number | null;
  /** Chances behind the standing rate. */
  sample: number;
  /** Of those, the published counts: taken, missed. Censored are neither. */
  took: number;
  missed: number;
  coverageStatus: string;
  unavailableReason: string | null;
  /**
   * The same player against their own earlier games, or null when the report
   * carries only one window.
   *
   * `delta` and `improvementProbability` are read off the recent row rather
   * than derived from the two estimates: the estimator discounts old evidence
   * on a half-life and starts from a prior, so `recent - baseline` is not the
   * number it computed and a reader who subtracts the two figures on screen
   * would get a third answer.
   */
  change: {
    from: number;
    to: number;
    delta: number;
    improvementProbability: number | null;
    movement: Movement;
    /** Chances behind the recent window. */
    sample: number;
  } | null;
}

/**
 * Every measure, ordered by how far it has moved against the player.
 *
 * **Not ordered by rate, and that is the whole point.** The seven rates are
 * over different tasks — taking a free piece is not the same job as finding the
 * only move that holds — so 4% on one and 84% on another are not two ends of a
 * ranking, they are two unrelated facts. A page that sorted them would be
 * telling somebody their worst area was whichever concept happened to be
 * hardest, which is a claim about the catalogue rather than about them.
 *
 * What *is* comparable across concepts is a player against their own earlier
 * self, which is precisely the frame `personal_current` exists to provide. So
 * the stack is ranked by the posterior that the change was an improvement,
 * lowest first: the things going most clearly wrong lead, and a measure with no
 * second window sorts to the end rather than being ranked on a number it does
 * not have.
 */
export function measures(dashboard: Dashboard): Measure[] {
  // Phase-scoped concept rows belong to the Patterns sections. The profile's
  // cross-phase catalogue stays one measure per concept and role.
  return groupMeasures(dashboard.estimates.filter((estimate) => estimate.phase === null))
    .map((group): Measure => {
      const { headline, recent, baseline } = group;
      const change =
        recent && baseline && recent.estimate !== null && baseline.estimate !== null
          ? {
              from: baseline.estimate,
              to: recent.estimate,
              // The estimator's own delta when it sent one. Falling back to the
              // difference is a last resort and is still the same direction.
              delta: recent.delta ?? recent.estimate - baseline.estimate,
              improvementProbability: recent.improvementProbability,
              movement: movementOf(recent.improvementProbability),
              sample: recent.rawSampleSize,
            }
          : null;
      return {
        baseKey: group.baseKey,
        name: group.name,
        role: headline.copy?.roleLabel ?? null,
        category: headline.copy?.category ?? null,
        definition: group.definition,
        rate: headline.estimate,
        intervalLow: headline.intervalLow,
        intervalHigh: headline.intervalHigh,
        sample: headline.rawSampleSize,
        took: headline.coverage.success,
        missed: headline.coverage.failure,
        coverageStatus: headline.coverageStatus,
        unavailableReason: headline.unavailableReason,
        change,
      };
    })
    .sort((a, b) => {
      // No second window is not "no change": it is a measure this report cannot
      // rank, so it goes last rather than being sorted as though it held still.
      const left = a.change?.improvementProbability ?? Number.POSITIVE_INFINITY;
      const right = b.change?.improvementProbability ?? Number.POSITIVE_INFINITY;
      if (left !== right) return left - right;
      return a.name.localeCompare(b.name);
    });
}

// ---------------------------------------------------------------------------
// The hub's categories
// ---------------------------------------------------------------------------

/**
 * A handful of cards instead of a wall of rows.
 *
 * The hub used to render the whole ranked stack, which even folded was eight
 * near-identical lines — the repetitive strip layout the redesign exists to
 * kill. What a glance actually needs is the catalogue's own families, each
 * summarised once: how many chances of that family went by, how many were
 * missed (both summed from published counts, never derived), and the family's
 * most decisively moved measure as the card's one figure. The full stack
 * still exists, on `/profile`, where reading every measure is the point.
 */
export interface CategorySummary {
  key: string;
  /** The family on screen. */
  name: string;
  /** Measures in the family that carry a figure. */
  areas: number;
  /** Summed published counts across those measures. */
  chances: number;
  missed: number;
  /**
   * The family's most decisively moved measure — the one whose posterior sits
   * furthest from "no change" in either direction — or, with no second window
   * anywhere in the family, null. The card shows its movement as the payoff
   * figure, so a family is fronted by its clearest fact rather than a mean of
   * unrelated rates.
   */
  mover: Measure | null;
}

const CATEGORY_NAME: Record<string, string> = {
  tactical: "Tactics",
  defensive: "Defence",
  conversion: "Conversion",
};

export function categorySummaries(ranked: readonly Measure[]): CategorySummary[] {
  const byKey = new Map<string, Measure[]>();
  for (const measure of ranked) {
    if (!measure.category || measure.rate === null) continue;
    byKey.set(measure.category, [...(byKey.get(measure.category) ?? []), measure]);
  }

  const decisiveness = (measure: Measure): number => {
    const p = measure.change?.improvementProbability;
    return p === null || p === undefined ? -1 : Math.abs(p - 0.5);
  };

  return [...byKey.entries()]
    .map(([key, members]) => {
      const mover = [...members].sort((a, b) => decisiveness(b) - decisiveness(a))[0] ?? null;
      return {
        key,
        name: CATEGORY_NAME[key] ?? key.replace(/_/g, " "),
        areas: members.length,
        chances: members.reduce((sum, measure) => sum + measure.took + measure.missed, 0),
        missed: members.reduce((sum, measure) => sum + measure.missed, 0),
        mover: mover && mover.change ? mover : null,
      };
    })
    .sort((a, b) => b.missed - a.missed);
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

/**
 * A sentence with a database identifier in it, which is not a sentence.
 *
 * `rendered_explanations` is written once, at publication, and kept forever. A
 * report published before `server/src/estimates/render.ts` was repaired carries
 * text like "critical_moment_recognize_objective is costing you", and no amount
 * of correct code fixes a row that was already written — only re-running the
 * analysis does. Until that happens the product would go on showing a column
 * name to the person it is about.
 *
 * So the client refuses it. A lower-underscore-lower run is a key in every
 * catalogue this build knows and appears in no English the renderer writes. The
 * guard is deliberately narrow: it holds back the exact failure that shipped
 * and nothing else, and the moment a re-render lands the good sentence passes
 * it without anybody changing this file.
 */
const IDENTIFIER = /[a-z]+_[a-z]+/;

export function readableExplanation(finding: Finding | null): string | null {
  const text = finding?.explanation?.trim();
  if (!text) return null;
  return IDENTIFIER.test(text) ? null : text;
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
  /** The published phase cards, opening first, or empty when unpublished. */
  phases: PhaseFigure[];
  /** The same figures in the shape the trajectory's own cards read. */
  accuracy: PhaseAccuracy[];
  /**
   * The three phases in the hub's one unit, with their movement.
   *
   * This is what the hub draws. `accuracy` stays because the trajectory's own
   * cards read that shape, and `phases` stays because the phase pages quote the
   * raw published figure — but a reader only ever meets these.
   */
  readings: PhaseReading[];
  /** What has moved enough to say out loud, worst first. Often empty. */
  milestones: Milestone[];
  measured: number;
  conclusions: number;
  games: number;
  rating: QuotedRating | null;
  /**
   * Every measure, worst-moving first. This is the page's spine.
   *
   * Read from the estimates rather than the findings on purpose. An estimate
   * resolves its name from the catalogue when the dashboard is read, so it is
   * correct in any build; a finding carries prose frozen at publication time,
   * which is why a report published before the renderer was repaired still
   * prints a database key on screen. The estimates cannot go stale that way.
   */
  measures: Measure[];
  /**
   * When this report was published.
   *
   * On the page, next to the game count, because the two together are the only
   * honest reading of every figure here: a report is a frozen cohort, not a
   * live count, and an archive that has grown since says nothing about a number
   * measured before it did.
   */
  publishedAt: string;
}

/**
 * The published phase figures, in the shape the trajectory's cards read.
 *
 * `lib/trajectory.ts` declared this seam when no route returned a per-phase
 * rate: the cards said the figure was recorded but not published, and refused
 * to derive one. `/v1/dashboard` publishes the pooled rate per phase now, so
 * this is the wiring that seam was waiting for — a rename of published fields,
 * and nothing computed. Cards whose rate the estimator withheld are simply
 * absent, and the card keeps saying so.
 */
export function phaseAccuracy(dashboard: Dashboard): PhaseAccuracy[] {
  // Optional access on purpose: a payload published before the phases section
  // existed simply has none, and "none" is the pre-wiring behaviour.
  if (dashboard.phases?.state !== "published") return [];
  return dashboard.phases.phases
    .filter((figure) => figure.rate !== null)
    .map((figure) => ({
      phase: figure.phase,
      chances: figure.observed,
      took: figure.taken,
      rate: figure.rate!,
      intervalLow: figure.intervalLow,
      intervalHigh: figure.intervalHigh,
      gamesReaching: figure.gamesReaching ?? 0,
      setAside: figure.setAside,
    }));
}

export function todayReport(dashboard: Dashboard): TodayReport | null {
  const cone = coneFrom(dashboard.trajectory);
  const holdings = holdingsOf(dashboard);
  const accuracy = phaseAccuracy(dashboard);
  // With the per-phase rates published, the cone's own caption already states
  // the like-for-like phase gap in one sentence — so the hub's finding slot
  // goes to the strongest conclusion that is *not* that, instead of printing
  // the same comparison twice at two lengths. The phase pages still quote the
  // contrast verbatim, because there it is the point rather than an echo.
  const finding = headlineFinding(
    accuracy.length > 0
      ? dashboard.findings.filter(
          (entry) => (entry.claim as { kind?: string }).kind !== "phase_contrast",
        )
      : dashboard.findings,
  );

  // Nothing to draw, nothing to read out and nothing measured is a report with
  // no claim in it, and a row that cannot state its reason does not render.
  // That is the hub's own rule, applied to the thing at the top of it as much
  // as to the list. The measures join the test because they are now the page's
  // spine: a report with seven measured areas has plenty to say even when the
  // trajectory is absent and every finding was held back.
  const ranked = measures(dashboard);
  if (cone === null && finding === null && ranked.length === 0) return null;

  const reading = cone === null ? null : coneFinding(cone);
  // The hub's own sentence, from the same figure its nodes count. See
  // `costliestPhase` for why this is not `cone.decisive`.
  const costliest = cone === null ? null : costliestPhase(cone);
  return {
    headline: costliest
      ? `Your games are decided in the ${costliest.name.toLowerCase()}.`
      : reading?.headline ?? "Forma has finished reading your games.",
    detail: reading?.detail ?? "",
    finding: readableExplanation(finding),
    cone,
    phases: dashboard.phases?.state === "published" ? [...dashboard.phases.phases] : [],
    accuracy,
    readings: phaseReadings(dashboard),
    milestones: milestones(ranked),
    measured: holdings.measured,
    conclusions: holdings.conclusions,
    games: holdings.trajectoryGames,
    rating: quotedRating(dashboard.ratingProfile),
    measures: ranked,
    publishedAt: dashboard.publishedAt,
  };
}

// ---------------------------------------------------------------------------
// The hub's one unit
// ---------------------------------------------------------------------------

/**
 * One phase of the game, in the single unit the hub speaks.
 *
 * The hub used to draw three phases in three different units — mistakes per
 * game, expected score given up, a conversion percentage — on one row of three
 * identical discs. Nobody can rank those. They do not share a scale, they do
 * not share a direction, and two of the three were derived on the client from
 * thresholds that appear nowhere in the contract.
 *
 * Every phase is already published as chances taken over chances observed.
 * That is the unit, it is the estimator's own, and it is the same shape as
 * every concept in the catalogue — so one mark can draw a phase, a concept, or
 * a repertoire and a reader never has to re-learn the scale.
 *
 * Two channels, and they are never mixed:
 *
 *   * **the rate** says where you are, drawn on the full 0–100 scale with its
 *     published interval, so a tight estimate and a guess cannot look alike;
 *   * **the movement** says which way you are going, and it is the only thing
 *     allowed to colour the mark.
 *
 * Colouring by level is the version this replaced, and it is both unfair and
 * uninformative: a beginner is in the bottom band of every measure Forma has,
 * so every dial is red for as long as they need encouragement most. Movement is
 * the thing they control, it is measured against their own earlier games rather
 * than against a cohort, and it is the one comparison the estimator says is
 * valid.
 */
export interface PhaseReading {
  phase: string;
  /** Chances taken over chances observed, or null when nothing was published. */
  rate: number | null;
  intervalLow: number | null;
  intervalHigh: number | null;
  /** The counts behind the rate. Always shown beside it, never instead of it. */
  took: number;
  chances: number;
  /** Chances that ended before the player was on move. Never failures. */
  setAside: number;
  gamesReaching: number | null;
  coverageStatus: string;
  unavailableReason: string | null;
  /** Which way this phase is going, against this player's own earlier games. */
  movement: Movement;
  /** The two windows behind that movement, or null when there is one window. */
  change: { from: number; to: number; improvementProbability: number | null } | null;
}

/** The order a game is played in. Never a ranking. */
const PHASE_ORDER = ["opening", "middlegame", "endgame"];

export function phaseReadings(dashboard: Dashboard): PhaseReading[] {
  if (dashboard.phases?.state !== "published") return [];

  return [...dashboard.phases.phases]
    .map((figure): PhaseReading => {
      const change =
        figure.baselineRate !== null && figure.recentRate !== null
          ? {
              from: figure.baselineRate,
              to: figure.recentRate,
              improvementProbability: figure.improvementProbability,
            }
          : null;
      return {
        phase: figure.phase,
        rate: figure.rate,
        intervalLow: figure.intervalLow,
        intervalHigh: figure.intervalHigh,
        took: figure.taken,
        chances: figure.observed,
        setAside: figure.setAside,
        gamesReaching: figure.gamesReaching ?? null,
        coverageStatus: figure.coverageStatus,
        unavailableReason: figure.unavailableReason,
        movement: movementOf(change?.improvementProbability ?? null),
        change,
      };
    })
    .sort((a, b) => PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase));
}

/**
 * What moved, in the reader's words, worst first.
 *
 * A milestone is never written here. It is a published estimate that crossed a
 * published threshold, and the only editorial act is choosing which of them is
 * worth a card. Three rules keep it from becoming a badge shelf:
 *
 *   * **nothing is awarded for effort.** Drills done, days visited and games
 *     synced are all absent on purpose. They measure showing up, and a product
 *     that congratulates you for showing up has stopped measuring your chess;
 *   * **a milestone can be lost.** `declined` and `slipping` produce cards in
 *     the same shape as `improved` and `gaining`, because the ones a reader
 *     keeps are only worth something if the others can be taken away;
 *   * **the evidence travels with the claim**, in the card, not behind a
 *     tooltip. Two rates and the games they were counted over.
 */
export interface Milestone {
  key: string;
  /** What moved. The catalogue's own name. */
  name: string;
  movement: Movement;
  from: number;
  to: number;
  /** Chances behind the recent window. */
  sample: number;
}

export function milestones(ranked: readonly Measure[], limit = 3): Milestone[] {
  return ranked
    .filter((measure) => measure.change !== null && measure.change.movement !== "unclear")
    // Not worst-first, which is how `measures()` ranks the full stack on
    // `/profile`. That order is right there — reading every measure is the
    // point, and the things going wrong should lead a document somebody has
    // opened deliberately. On a strip of three cards it produces a hub that
    // opens on two failures every single day, which is neither the most useful
    // reading nor one anybody comes back to.
    //
    // Most-certain-first instead: distance of the posterior from 0.5,
    // descending. That is not cherry-picking — it surfaces a strong decline
    // exactly as readily as a strong gain, and it is the honest answer to
    // "what does Forma actually know changed". A player going backwards still
    // sees it first, because that is what the evidence says.
    .sort((a, b) => {
      const certainty = (measure: Measure) =>
        Math.abs((measure.change!.improvementProbability ?? 0.5) - 0.5);
      return certainty(b) - certainty(a);
    })
    .map((measure) => ({
      key: measure.baseKey,
      name: measure.name,
      movement: measure.change!.movement,
      from: measure.change!.from,
      to: measure.change!.to,
      sample: measure.change!.sample,
    }))
    .slice(0, limit);
}

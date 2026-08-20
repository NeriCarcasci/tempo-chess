/**
 * What each thing Forma measures is called, and what a published report holds.
 *
 * The coverage route sends a dimension key and nothing else about it:
 * `only_move_recognize` is what arrives on the wire. The server's own name for
 * it is no better — `estimates/aggregate.ts` builds
 * `analysis.skill_dimensions.display_name` as `` `${concept_slug} (${role})` ``,
 * so the stored name is a slug in brackets. The sentences written for a player
 * live in `server/src/analysis/concepts/catalogue.ts` and no route returns
 * them, so the client carries its own copy. That is the same arrangement, and
 * the same reason, as `lib/onboarding/copy.ts`: when a route starts returning
 * these, delete this half rather than keeping two.
 *
 * Nothing here computes anything about a player. It names, defines and orders
 * what the API already sent; every number on the profile page comes off the
 * wire.
 */

import { humaniseDimension, limitationText, LIMITATION_TEXT, sectionTitle, sortSections } from "../onboarding/copy";

/**
 * The roles v1 actually measures.
 *
 * `analysis/observations.ts` declares more (`create`, `avoid`, `prevent`), and
 * no detector in the catalogue produces them, so a key using one of those would
 * fall through to the slug fallback rather than being mis-named.
 */
export const MEASURE_ROLES = ["recognize", "execute", "respond", "convert"] as const;
export type MeasureRole = (typeof MEASURE_ROLES)[number];

export interface Measure {
  /** The concept the chances belong to. */
  conceptSlug: string;
  role: MeasureRole;
  /** `${conceptSlug}_${role}` — exactly what the coverage route sends. */
  dimensionKey: string;
  /** The name a player reads. */
  name: string;
  /** One sentence, written for the player whose game it describes. */
  definition: string;
  /**
   * Why a chance here can end with no answer, or null when it cannot.
   *
   * A censored chance is left out of the rate rather than counted against the
   * player, and a screen that does not say so silently turns "you never got to
   * answer" into "you got it wrong". Only `winning_conversion` can censor in
   * v1: the other five judge a move that was played.
   */
  censoring: string | null;
}

/**
 * The six concepts of catalogue v1, split by role.
 *
 * `critical_moment` is two rows because it is two different failures. Someone
 * who saw the move and calculated it wrong has a different problem from someone
 * who never considered it, and one "accuracy" number describes neither.
 */
export const MEASURES: readonly Measure[] = Object.freeze([
  {
    conceptSlug: "material_safety",
    role: "respond",
    dimensionKey: "material_safety_respond",
    name: "Keeping your pieces safe",
    definition:
      "One of your pieces was available to be taken for less than it is worth, and you were to move. This measures whether you noticed and dealt with it.",
    censoring: null,
  },
  {
    conceptSlug: "free_material",
    role: "recognize",
    dimensionKey: "free_material_recognize",
    name: "Taking what is offered",
    definition:
      "Your opponent left something available to be taken for less than it is worth. This measures whether you took it.",
    censoring: null,
  },
  {
    conceptSlug: "critical_moment",
    role: "recognize",
    dimensionKey: "critical_moment_recognize",
    name: "Seeing the moves that matter",
    definition:
      "A moment where the moves available led to genuinely different games. This measures whether the move you played was one the engine was seriously looking at.",
    censoring: null,
  },
  {
    conceptSlug: "critical_moment",
    role: "execute",
    dimensionKey: "critical_moment_execute",
    name: "Choosing well when it matters",
    definition:
      "The same moments, judged on the other half of the decision: whether the move you settled on was good enough.",
    censoring: null,
  },
  {
    conceptSlug: "only_move",
    role: "recognize",
    dimensionKey: "only_move_recognize",
    name: "Finding the only move",
    definition:
      "A position where exactly one move held and everything else lost ground. This measures whether you found it.",
    censoring: null,
  },
  {
    conceptSlug: "winning_conversion",
    role: "convert",
    dimensionKey: "winning_conversion_convert",
    name: "Converting a winning position",
    definition:
      "You reached a position that should win. This measures whether it still should by the time you stopped moving. One chance per game, not per move.",
    censoring:
      "If your opponent resigned or the game ended before you moved again, there was nothing to convert. Those chances are set aside rather than counted against you.",
  },
  {
    conceptSlug: "worse_position_defence",
    role: "respond",
    dimensionKey: "worse_position_defence_respond",
    name: "Defending a worse position",
    definition:
      "You were worse and had to keep the game alive. This measures whether your moves held the position rather than accelerating the slide. Being worse is not counted as a failure; only the move you played from there is judged.",
    censoring: null,
  },
]);

const BY_KEY = new Map(MEASURES.map((measure) => [measure.dimensionKey, measure]));

/** The measure a dimension key names, or null for one this build has not met. */
export function measureFor(dimensionKey: string): Measure | null {
  return BY_KEY.get(dimensionKey) ?? null;
}

/**
 * A name for any dimension key, including one added after this build shipped.
 *
 * The fallback is the humanised slug rather than the slug: the catalogue is an
 * open set on the server, and a page that printed `only_move_recognize` the day
 * a seventh concept landed would be worse than one that says something plain.
 */
export function measureName(dimensionKey: string): string {
  return measureFor(dimensionKey)?.name ?? humaniseDimension(dimensionKey);
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/** Sufficient first, because a claim Forma can stand behind should lead. */
const COVERAGE_RANK: Record<string, number> = {
  sufficient: 0,
  limited: 1,
  insufficient: 2,
};

export interface DimensionRow {
  dimensionKey: string;
  observationCount: number;
  state: string;
}

/**
 * Coverage first, then weight of evidence.
 *
 * The two disagree, which is why both are needed: `state` is decided partly on
 * the time-weighted count, so a measure with two thousand chances can still be
 * `limited` if most of them are old. Sorting on the raw count alone would put a
 * row Forma will not stand behind above one it will. An unknown state sorts
 * last rather than first — the safe end for a value this build cannot read.
 */
export function orderDimensions<T extends DimensionRow>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const rank = (COVERAGE_RANK[a.state] ?? 3) - (COVERAGE_RANK[b.state] ?? 3);
    if (rank !== 0) return rank;
    if (a.observationCount !== b.observationCount) return b.observationCount - a.observationCount;
    return measureName(a.dimensionKey).localeCompare(measureName(b.dimensionKey));
  });
}

/**
 * The largest observation count in a set, or null when there is nothing to
 * compare against.
 *
 * Only ever used as the denominator of a bar's width. It is not a statistic
 * about the player and is never shown as one: the figure beside each bar is the
 * count the API sent, and the bar just makes 1,698 and 200 stop looking alike.
 */
export function widestEvidence(rows: readonly DimensionRow[]): number | null {
  let widest = 0;
  for (const row of rows) if (row.observationCount > widest) widest = row.observationCount;
  return widest > 0 ? widest : null;
}

// ---------------------------------------------------------------------------
// What the published report holds
// ---------------------------------------------------------------------------

export const ITEM_KINDS = ["coverage", "finding", "estimate", "trajectory", "narrative"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** The subset of a report item this module reads. */
export interface ReportItemLike {
  section: string;
  itemKind: string;
  coverageDimensionKey: string | null;
}

export interface ReportSectionSummary {
  section: string;
  title: string;
  /** Coverage items, already sentences. The only items that carry readable text. */
  notes: string[];
  /** How many of each kind the section holds, counted from what came back. */
  counts: Record<ItemKind, number>;
  /** Items carrying an id and no readable form. Counted, never described. */
  unreadable: number;
}

/**
 * What a kind of item is, in the reader's words.
 *
 * `narrative` is in the map for exhaustiveness and never reaches a screen: it
 * is a slot the layout reserved for a sentence nothing writes yet, so counting
 * it would tell a reader their report holds something it does not.
 */
export const KIND_NOUN: Record<ItemKind, { one: string; many: string }> = {
  coverage: { one: "note on coverage", many: "notes on coverage" },
  finding: { one: "conclusion", many: "conclusions" },
  estimate: { one: "measured area", many: "measured areas" },
  trajectory: { one: "trajectory", many: "trajectories" },
  narrative: { one: "reserved slot", many: "reserved slots" },
};

/** What a section holds, worth naming, in item-kind order. */
export function holdings(counts: Record<ItemKind, number>): { kind: ItemKind; count: number; label: string }[] {
  return ITEM_KINDS.filter((kind) => kind !== "narrative" && counts[kind] > 0).map((kind) => ({
    kind,
    count: counts[kind],
    label: counts[kind] === 1 ? KIND_NOUN[kind].one : KIND_NOUN[kind].many,
  }));
}

/**
 * A coverage item's key is one of three things and none of them is a sentence.
 *
 * It is a limitation slug, a dimension key, or the literal
 * `insufficient_evidence` that a gap-finding is filed under. Printing it raw is
 * the failure the copy module exists to prevent.
 */
export function coverageItemText(key: string | null): string {
  if (!key) return "Coverage";
  if (key in LIMITATION_TEXT) return limitationText(key);
  if (key === "insufficient_evidence") {
    return "There is not enough evidence behind one of these to say anything yet.";
  }
  return `${measureName(key)}: too little behind it to report on.`;
}

/**
 * Group a report into its sections, in the order it was meant to be read.
 *
 * The API returns items ordered `section, display_order`, which is alphabetical
 * rather than the reading order, so the sections are re-sorted here the same
 * way `/report` re-sorts them.
 *
 * Counting is the only thing done to the items themselves. A finding carries an
 * id and no text, and there is no endpoint that turns an id into a sentence, so
 * an item that cannot be rendered is counted rather than described. A count of
 * rows that came back is not a new statistic about the player.
 */
export function summariseReport(items: readonly ReportItemLike[]): ReportSectionSummary[] {
  const bySection = new Map<string, ReportItemLike[]>();
  for (const item of items) {
    const list = bySection.get(item.section) ?? [];
    list.push(item);
    bySection.set(item.section, list);
  }

  return sortSections([...bySection.keys()]).map((section) => {
    const rows = bySection.get(section) ?? [];
    const counts: Record<ItemKind, number> = {
      coverage: 0,
      finding: 0,
      estimate: 0,
      trajectory: 0,
      narrative: 0,
    };
    const notes: string[] = [];
    let unreadable = 0;

    for (const row of rows) {
      if ((ITEM_KINDS as readonly string[]).includes(row.itemKind)) {
        counts[row.itemKind as ItemKind] += 1;
      }
      if (row.itemKind === "coverage") notes.push(coverageItemText(row.coverageDimensionKey));
      // `narrative` is a slot the layout reserved and nothing writes text into
      // yet, so it is neither readable nor a missing sentence worth counting.
      else if (row.itemKind !== "narrative") unreadable += 1;
    }

    return { section, title: sectionTitle(section), notes, counts, unreadable };
  });
}

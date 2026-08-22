/**
 * What a published report holds, and how to order it.
 *
 * This file used to carry its own copy of all six concepts -- names, one-line
 * definitions, and which of them could censor -- because no route returned
 * them. Its own header said to delete that half the moment one did. FOR-133 is
 * that moment: `/v1/dashboard` now sends `copy` beside every estimate,
 * resolved server-side from the promoted catalogue, so the sentences a player
 * reads come from the same place the detector's contract does.
 *
 * What is left here is presentation that has no server side: ordering, the
 * nouns for report items, and a name for a dimension key when the key is all
 * there is. The fallback never prints an identifier, because the catalogue is
 * an open set and a seventh concept will arrive before this build does.
 *
 * Nothing here computes anything about a player. Every number on the profile
 * page comes off the wire.
 */

import { limitationText, LIMITATION_TEXT, sectionTitle, sortSections } from "../onboarding/copy";

/**
 * The roles v1 actually measures.
 *
 * `analysis/observations.ts` declares more (`create`, `avoid`, `prevent`), and
 * no detector in the catalogue produces them, so a key using one of those would
 * fall through to the slug fallback rather than being mis-named.
 */
export const MEASURE_ROLES = ["recognize", "execute", "respond", "convert"] as const;
export type MeasureRole = (typeof MEASURE_ROLES)[number];

/**
 * A censoring note, said once for whatever measurement needs it.
 *
 * This used to be a per-concept sentence in a table that named
 * `winning_conversion` as the only measurement able to censor. That was true of
 * catalogue v1 and stopped being true the moment the tactical families landed:
 * every one of them censors when the game ends before the subject replies. The
 * page already only shows this when the API reports censored chances, so the
 * data decides whether it appears and the sentence no longer has to guess which
 * concepts can produce one.
 */
export const CENSORING_NOTE =
  "Chances you never got to answer are set aside rather than counted against you.";

/**
 * A name for any dimension key, including one added after this build shipped.
 *
 * The fallback is the humanised key rather than the key: the catalogue is an
 * open set on the server, and a page that printed `only_move_recognize` the day
 * a seventh concept landed would be worse than one that says something plain.
 *
 * Callers that have the estimate should prefer the name the API sent with it --
 * see `groupMeasures`. This exists for the coverage panel, which is given a
 * dimension key and nothing else.
 */
export function measureName(dimensionKey: string): string {
  // A dimension key is an identifier, even after replacing underscores with
  // spaces. Callers with estimate metadata use the server-owned display name;
  // callers without it get a deliberately generic reader-facing noun.
  void dimensionKey;
  return "A measured area";
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

/**
 * The vocabulary the profile page speaks, pinned where it could quietly lie.
 *
 * Three failures are worth a test each. A dimension key that does not match the
 * one the coverage route sends silently falls back to the slug, and the page
 * goes back to saying `only_move (recognize)` at somebody. A censored chance
 * described as a failure is the one thing the estimator is most careful about
 * and the easiest thing for an interface to undo. And a report item counted as
 * readable when it carries only an id is how a made-up sentence gets shipped.
 */

import { describe, expect, test } from "vitest";
import {
  CENSORING_NOTE,
  coverageItemText,
  holdings,
  measureName,
  orderDimensions,
  summariseReport,
  widestEvidence,
  type ItemKind,
  type ReportItemLike,
} from "./measures";

const dimension = (dimensionKey: string, observationCount: number, state: string) => ({
  dimensionKey,
  observationCount,
  state,
});

const item = (
  section: string,
  itemKind: string,
  coverageDimensionKey: string | null = null,
): ReportItemLike => ({ section, itemKind, coverageDimensionKey });

const counts = (over: Partial<Record<ItemKind, number>> = {}): Record<ItemKind, number> => ({
  coverage: 0,
  finding: 0,
  estimate: 0,
  trajectory: 0,
  narrative: 0,
  ...over,
});

describe("the catalogue", () => {
  test("the censoring note says the chances are not held against you", () => {
    // It used to be a per-concept sentence, attached in a table that named
    // conversion as the only measurement able to censor. That was true of
    // catalogue v1 and stopped being true when the tactical families landed:
    // every one of them censors when the game ends before the subject replies.
    expect(CENSORING_NOTE).toMatch(/set aside/i);
    expect(CENSORING_NOTE).not.toMatch(/fail/i);
  });
});

describe("measureName", () => {
  test("a key is never printed back at a reader as a key", () => {
    // The names themselves now come from the API beside each estimate, because
    // the catalogue is an open set on the server and this build cannot know
    // what a seventh concept is called. What has to hold here is the floor: no
    // underscore ever reaches a page.
    expect(measureName("only_move_recognize")).not.toMatch(/_/);
    expect(measureName("something_nobody_shipped_yet_respond")).not.toMatch(/_/);
  });

  test("a key from a catalogue this build has not met is still readable", () => {
    // The concept catalogue is an open set on the server, and the day a seventh
    // concept lands this page must not print `back_rank_recognize` at anybody.
    const name = measureName("back_rank_recognize");
    expect(name).not.toContain("_");
    expect(name.length).toBeGreaterThan(0);
  });
});

describe("orderDimensions", () => {
  test("coverage leads, because a claim Forma will not stand behind cannot", () => {
    const ordered = orderDimensions([
      dimension("a", 5000, "insufficient"),
      dimension("b", 10, "sufficient"),
      dimension("c", 4000, "limited"),
    ]);
    expect(ordered.map((row) => row.dimensionKey)).toEqual(["b", "c", "a"]);
  });

  test("within one coverage state the weight of evidence decides", () => {
    const ordered = orderDimensions([
      dimension("only_move_recognize", 335, "sufficient"),
      dimension("worse_position_defence_respond", 1698, "sufficient"),
      dimension("winning_conversion_convert", 200, "sufficient"),
    ]);
    expect(ordered.map((row) => row.observationCount)).toEqual([1698, 335, 200]);
  });

  test("a state this build cannot read sorts last rather than first", () => {
    const ordered = orderDimensions([
      dimension("a", 1, "provisional"),
      dimension("b", 1, "insufficient"),
    ]);
    expect(ordered.map((row) => row.dimensionKey)).toEqual(["b", "a"]);
  });

  test("the caller's array is not reordered underneath them", () => {
    const rows = [dimension("a", 1, "insufficient"), dimension("b", 2, "sufficient")];
    orderDimensions(rows);
    expect(rows.map((row) => row.dimensionKey)).toEqual(["a", "b"]);
  });
});

describe("widestEvidence", () => {
  test("nothing to compare against is null, never zero", () => {
    // Zero would be a denominator, and dividing by it is how every bar on the
    // page comes out `Infinity%` wide.
    expect(widestEvidence([])).toBeNull();
    expect(widestEvidence([dimension("a", 0, "insufficient")])).toBeNull();
  });

  test("the largest count is the one bars are drawn against", () => {
    expect(widestEvidence([dimension("a", 200, "limited"), dimension("b", 1698, "sufficient")])).toBe(1698);
  });
});

describe("coverageItemText", () => {
  test("the three kinds of key produce three different sentences", () => {
    const limitation = coverageItemText("few_games");
    const gap = coverageItemText("insufficient_evidence");
    const measure = coverageItemText("only_move_recognize");
    expect(new Set([limitation, gap, measure]).size).toBe(3);
    for (const sentence of [limitation, gap, measure]) expect(sentence).not.toContain("_");
  });

  test("a dimension key without catalogue metadata falls back without printing the identifier", () => {
    // The coverage route sends a key and nothing else -- no estimate, so no
    // `copy` to read the catalogue's own words from. What has to hold is that
    // the sentence is readable and carries no identifier; the catalogue name
    // appears wherever an estimate is present to carry it.
    const sentence = coverageItemText("winning_conversion_convert");
    expect(sentence).not.toContain("_");
    expect(sentence).not.toMatch(/winning conversion/i);
    expect(sentence).toMatch(/measured area/i);
  });
});

describe("summariseReport", () => {
  const items = [
    item("next_steps", "narrative"),
    item("coverage", "coverage", "few_games"),
    item("constraints", "finding"),
    item("constraints", "estimate"),
    item("constraints", "estimate"),
    item("headline", "narrative"),
    item("trajectory", "trajectory"),
  ];

  test("sections come back in reading order, not the API's alphabetical one", () => {
    // The route orders by section name. Coverage second is the product's rule:
    // what Forma could read comes before what it concluded.
    expect(summariseReport(items).map((section) => section.section)).toEqual([
      "headline",
      "coverage",
      "constraints",
      "trajectory",
      "next_steps",
    ]);
  });

  test("only coverage items become sentences", () => {
    const bySection = new Map(summariseReport(items).map((s) => [s.section, s]));
    expect(bySection.get("coverage")!.notes).toHaveLength(1);
    // A finding carries an id and no text, and no endpoint turns one into a
    // sentence. Counted rather than described is the whole rule.
    expect(bySection.get("constraints")!.notes).toEqual([]);
    expect(bySection.get("constraints")!.unreadable).toBe(3);
    expect(bySection.get("constraints")!.counts.estimate).toBe(2);
  });

  test("a reserved slot is not counted as a missing sentence", () => {
    // `narrative` is a place the layout left for text nothing writes yet.
    // Counting it would tell a reader their report holds something it does not.
    const bySection = new Map(summariseReport(items).map((s) => [s.section, s]));
    expect(bySection.get("headline")!.unreadable).toBe(0);
  });

  test("an empty report is an empty list rather than a set of empty sections", () => {
    expect(summariseReport([])).toEqual([]);
  });
});

describe("holdings", () => {
  test("only what is there is named, and named in the singular when it is one", () => {
    expect(holdings(counts({ finding: 1, estimate: 14 }))).toEqual([
      { kind: "finding", count: 1, label: "conclusion" },
      { kind: "estimate", count: 14, label: "measured areas" },
    ]);
  });

  test("a reserved slot is never listed as something the report holds", () => {
    expect(holdings(counts({ narrative: 3 }))).toEqual([]);
  });
});

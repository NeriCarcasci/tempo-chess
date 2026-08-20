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
  coverageItemText,
  holdings,
  MEASURES,
  measureFor,
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
  test("every key is the one the coverage route sends", () => {
    // `readDimensionFacts` strips the frame suffix, so what arrives is
    // `${concept_slug}_${role}`. A key built any other way looks up to nothing
    // and the row falls back to a humanised slug without anything failing.
    for (const measure of MEASURES) {
      expect(measure.dimensionKey).toBe(`${measure.conceptSlug}_${measure.role}`);
    }
  });

  test("no two measures read the same", () => {
    expect(new Set(MEASURES.map((m) => m.dimensionKey)).size).toBe(MEASURES.length);
    expect(new Set(MEASURES.map((m) => m.name)).size).toBe(MEASURES.length);
    expect(new Set(MEASURES.map((m) => m.definition)).size).toBe(MEASURES.length);
  });

  test("the two halves of a critical moment are named apart", () => {
    // The whole reason they are separate rows: seeing the move and choosing it
    // are different failures, and one label for both describes neither.
    const seeing = measureFor("critical_moment_recognize");
    const choosing = measureFor("critical_moment_execute");
    expect(seeing?.name).not.toBe(choosing?.name);
    expect(seeing?.conceptSlug).toBe(choosing?.conceptSlug);
  });

  test("only the measure that can censor carries a censoring sentence", () => {
    // Conversion is the one concept where the subject can never get to answer,
    // because the opponent resigned. Every other measure judges a move that was
    // actually played, so a censoring note there would describe nothing.
    const censoring = MEASURES.filter((m) => m.censoring !== null).map((m) => m.dimensionKey);
    expect(censoring).toEqual(["winning_conversion_convert"]);
  });

  test("the censoring sentence says the chances are not held against you", () => {
    const sentence = measureFor("winning_conversion_convert")!.censoring!;
    expect(sentence).toMatch(/set aside/i);
    expect(sentence).not.toMatch(/fail/i);
  });
});

describe("measureName", () => {
  test("a known key is a sentence-cased name, never a slug", () => {
    expect(measureName("only_move_recognize")).toBe("Finding the only move");
  });

  test("a key from a catalogue this build has not met is still readable", () => {
    // The concept catalogue is an open set on the server, and the day a seventh
    // concept lands this page must not print `back_rank_recognize` at anybody.
    const name = measureName("back_rank_recognize");
    expect(name).not.toContain("_");
    expect(measureFor("back_rank_recognize")).toBeNull();
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

  test("a dimension key is named by its measure", () => {
    expect(coverageItemText("winning_conversion_convert")).toContain("Converting a winning position");
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

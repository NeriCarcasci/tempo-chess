import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, test, vi } from "vitest";
import { deriveTearSheet } from "../lib/tearSheet";
import type { OpeningGraph, OpeningGraphEdge, OpeningGraphNode } from "../lib/openings";
import type { OpeningExplorerCoverage } from "../lib/v1/types";

/**
 * The sheet, tested where it would go back to claiming things.
 *
 * Three sentences this page is not allowed to print, each of which it printed
 * until it moved onto `/v1`:
 *
 *   - the old 90-centipawn threshold as its own definition of a mistake, which
 *     is not how one is measured any more;
 *   - "no mistakes" about a line where nothing has been judged;
 *   - a Practice control that hands the reader to a screen selecting by the
 *     older rule without saying so.
 *
 * `OpeningBookPanel` is stubbed. It fetches, and what it fetches is a separate
 * endpoint with its own tests; none of the claims here depend on it.
 */

vi.mock("./OpeningBookPanel", () => ({ OpeningBookPanel: () => null }));

const { TearSheet } = await import("./TearSheet");

const node = (k: string, p: number, g: number, nm?: string): OpeningGraphNode => ({
  k,
  p,
  g,
  o: 0,
  f: 0,
  t: 0,
  x: 0,
  nm,
});

const edge = (
  a: number,
  b: number,
  s: string,
  g: number,
  op: number,
  fa: number,
  ac: OpeningGraphEdge["ac"] = "p",
): OpeningGraphEdge => ({ a, b, u: `${s}0000`.slice(0, 4), s, g, sh: 0, ac, op, fa });

function graph(games: number, judged: number, mistakes: number): OpeningGraph {
  return {
    games,
    root: 0,
    nodes: [
      node("r", 0, games),
      node("e4", 1, games),
      node("c5", 2, games, "Sicilian Defense"),
      node("Nf3", 3, games),
    ],
    edges: [
      edge(0, 1, "e4", games, 0, 0),
      edge(1, 2, "c5", games, 0, 0, "o"),
      edge(2, 3, "Nf3", games, judged, mistakes),
    ],
  };
}

const coverage = (over: Partial<OpeningExplorerCoverage> = {}): OpeningExplorerCoverage => ({
  games: 20,
  observations: 400,
  scoredDecisions: 60,
  playerDecisions: 200,
  unanalysedGames: 14,
  ...over,
});

function draw(g: OpeningGraph, cover = coverage()) {
  return render(
    <MemoryRouter>
      <TearSheet sheet={deriveTearSheet(g, null)} coverage={cover} />
    </MemoryRouter>,
  );
}

describe("the stated threshold", () => {
  test("the mistake definition is the canonical one, not the prototype's", () => {
    draw(graph(20, 20, 3));
    const text = document.body.textContent ?? "";
    expect(text).toContain("0.02 of expected score");
    expect(text).toContain("best line the same search found");
    // The prototype counted a mistake at 90cp against a stored evaluation. It
    // is a different measurement, and carrying the old sentence across would
    // have put two rules under one word. The number survives in exactly one
    // place — the note about what Practice selects by, which is a claim about
    // a different screen and lives behind its disclosure.
    expect(text).not.toContain("90 centipawns");
    expect(text).not.toContain("centipawn");
    expect(text).toContain("Practice is drilled from the older opening graph");
  });
});

describe("coverage", () => {
  test("the gap between judged and played moves is stated as a number", () => {
    draw(graph(20, 20, 3), coverage({ scoredDecisions: 60, playerDecisions: 200 }));
    const text = document.body.textContent ?? "";
    // 200 - 60. The reader is told the denominator behind every figure above.
    expect(text).toContain("140");
    expect(text).toContain("never as moves that went well");
  });

  test("a fully analysed account says so instead of printing a gap", () => {
    draw(
      graph(20, 20, 3),
      coverage({ scoredDecisions: 200, playerDecisions: 200, unanalysedGames: 0 }),
    );
    expect(document.body.textContent).toContain("have been analysed");
    expect(document.body.textContent).not.toContain("never as moves that went well");
  });

  test("a line with nothing judged never reads as a line with no mistakes", () => {
    draw(graph(30, 0, 0), coverage({ scoredDecisions: 0, playerDecisions: 30 }));
    const text = document.body.textContent ?? "";
    expect(text).toContain("Not analysed yet");
    expect(text).not.toContain("No mistakes");
  });

  test("the threshold guess is gone", () => {
    // "Too few games" was a sentence with no number behind it, and it fired
    // both for a small judged sample and for no judged sample at all.
    draw(graph(3, 3, 1));
    expect(document.body.textContent).not.toContain("Too few games");
    expect(document.body.textContent).toContain("in 3 judged moves");
  });
});

describe("practice", () => {
  test("the control points at the trainer, scoped to the line", () => {
    draw(graph(20, 20, 3));
    const link = screen.getAllByRole("link", { name: /Practice/ })[0]!;
    expect(link.getAttribute("href")).toContain("/train");
    expect(link.getAttribute("href")).toContain("family=Sicilian");
  });

  test("the control says what its drills are selected by", () => {
    // `/train` builds its lines from the prototype graph, which counts a
    // mistake at 90cp — a different rule from the one this sheet just stated.
    // A reader who tabs straight to the button never passes the note in the
    // header, so the accessible name carries it too.
    draw(graph(20, 20, 3));
    const link = screen.getAllByRole("link", { name: /Practice/ })[0]!;
    expect(link.getAttribute("aria-label")).toContain("older opening graph");
    expect(document.body.textContent).toContain("Practice is drilled from the older opening graph");
  });
});

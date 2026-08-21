/**
 * The one thing the sheet must never do: render an unanalysed line as a clean
 * one.
 *
 * `tearSheet.smoke.ts` covers the grid's shape — labels, columns, dilution, the
 * marker. This file covers only the coverage rule, because that is the claim
 * the screen makes loudest and the one that used to be wrong in two different
 * ways at once: an opening whose games had no published analysis produced no
 * row at all, and an opening with a handful of analysed games reported "no
 * mistakes" over a sample several times larger than the one anybody had looked
 * at.
 */

import { describe, expect, test } from "vitest";
import { deriveTearSheet, tallyCells } from "./tearSheet";
import type { OpeningGraph, OpeningGraphEdge, OpeningGraphNode } from "./openings";

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

/**
 * One family, reached after 1.e4 c5, with the player's move 2 played in
 * `games` games of which `judged` carry a verdict.
 */
function sicilian(games: number, judged: number, mistakes: number): OpeningGraph {
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

describe("unanalysed games", () => {
  test("a family whose games were never analysed still gets a row", () => {
    // It used to get none: the pooling skipped any edge with no verdict, so a
    // player whose whole archive was unanalysed saw an empty sheet and had no
    // way to tell that from having no games.
    const sheet = deriveTearSheet(sicilian(12, 0, 0), null);
    const row = sheet.sections[0]?.rows.find((r) => r.family === "Sicilian Defense");
    expect(row).toBeTruthy();
    expect(tallyCells(row!.cells)).toEqual({ decisions: 0, mistakes: 0, unjudged: 12 });
  });

  test("an unjudged cell is neither blank nor coloured", () => {
    const sheet = deriveTearSheet(sicilian(12, 0, 0), null);
    const row = sheet.sections[0]!.rows[0]!;
    const cell = row.cells[1]!;
    expect(cell.state).toBe("unjudged");
    // Heat is a failure rate. There is no rate over zero judged moves, and
    // drawing one would put a colour on a number nobody computed.
    expect(cell.heat).toBeUndefined();
  });

  test("the judged and the unjudged are separate counts, never one", () => {
    // Twenty games, six of them judged. The other fourteen are not successes.
    const sheet = deriveTearSheet(sicilian(20, 6, 2), null);
    const cell = sheet.sections[0]!.rows[0]!.cells[1]!;
    expect(cell.decisions).toBe(6);
    expect(cell.failures).toBe(2);
    expect(cell.unjudged).toBe(14);
  });

  test("an opponent move contributes no coverage gap", () => {
    // Forma does not judge the opponent's choices, so their absence from the
    // assessments is not something the player is owed an analysis of.
    const sheet = deriveTearSheet(sicilian(20, 6, 2), null);
    const row = sheet.sections[0]!.rows[0]!;
    // Only the player's move 2 is pooled: 6 judged and 14 waiting, and nothing
    // from the 20-game opponent edge that entered the line.
    expect(tallyCells(row.cells)).toEqual({ decisions: 6, mistakes: 2, unjudged: 14 });
  });

  test("a fully analysed line reports no gap", () => {
    const sheet = deriveTearSheet(sicilian(9, 9, 1), null);
    expect(tallyCells(sheet.sections[0]!.rows[0]!.cells).unjudged).toBe(0);
    expect(sheet.sections[0]!.rows[0]!.cells[1]!.state).toBe("scored");
  });

  test("the marker is never nominated from unjudged moves", () => {
    // The marker is the page's single loudest claim. Resting it on moves
    // nobody has looked at would make the top of the sheet the least
    // trustworthy part of it.
    expect(deriveTearSheet(sicilian(40, 0, 0), null).marker).toBeNull();
  });
});

describe("the line to a position", () => {
  test("a cell carries the move order that reaches each of its positions", () => {
    // The book endpoint needs the move order, not just the board: the same
    // position reached by a transposition left the book somewhere else.
    const sheet = deriveTearSheet(sicilian(20, 6, 4), null);
    const cell = sheet.sections[0]!.rows[0]!.cells[1]!;
    expect(cell.nodeKeys).toEqual(["c5"]);
    expect(cell.nodeLines).toHaveLength(cell.nodeKeys.length);
    expect(cell.nodeLines[0]).toBe("e400 c500");
  });
});

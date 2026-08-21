import assert from "node:assert/strict";
import { deriveTearSheet, FLOOR_COLOR } from "./tearSheet";
import type { OpeningGraph, OpeningGraphNode, OpeningGraphEdge } from "./openings";

/**
 * Run with: npx tsx app/lib/tearSheet.smoke.ts
 *
 * The fixture is small but shaped to hit the cases that matter: a family that
 * only becomes identifiable at move 2, a variation split that dilutes, a line
 * too thin to colour, and a book that runs out.
 */

const node = (
  k: string,
  p: number,
  g: number,
  nm?: string,
): OpeningGraphNode => ({ k, p, g, o: 0, f: 0, t: 0, x: 0, nm });

/**
 * The actor is now load-bearing and is stated per edge.
 *
 * Every edge in this fixture used to be `mixed`, which was harmless while the
 * sheet only pooled edges that already carried a verdict. It stopped being
 * harmless when unjudged player decisions started being pooled too: an
 * opponent's choice marked `mixed` would be counted as the player's own
 * unanalysed move, and the Sicilian would appear to start a move earlier than
 * the player has any decision in it.
 */
const edge = (
  a: number,
  b: number,
  s: string,
  g: number,
  op = 0,
  fa = 0,
  ac: OpeningGraphEdge["ac"] = "p",
  lb?: string,
): OpeningGraphEdge => ({ a, b, u: "0000", s, g, sh: 0, ac, op, fa, lb });

// -- as White ---------------------------------------------------------------
// root -e4-> n1 -c5-> n2(Sicilian) -Nf3-> n3 -d6-> n4(Najdorf) -d4-> n6
//                                          \-g6-> n5(Dragon)  -d4-> n7
// root -e4-> n1 -e5-> n8(Italian)   -Nf3-> n9
const whiteNodes = [
  node("r", 0, 90),                                          // 0 root
  node("e4", 1, 70),                                         // 1
  node("c5", 2, 45, "Sicilian Defense"),                     // 2
  node("Nf3", 3, 44),                                        // 3
  node("d6", 4, 12, "Sicilian Defense: Najdorf Variation"),  // 4
  node("g6", 4, 30, "Sicilian Defense: Dragon Variation"),   // 5
  node("naj5", 5, 11),                                       // 6
  node("dra5", 5, 29),                                       // 7
  node("e5", 2, 4, "Italian Game"),                          // 8
  node("it3", 3, 3),                                         // 9
];
const whiteEdges = [
  edge(0, 1, "e4", 70, 30, 2),        // White move 1 — before any family is known
  edge(1, 2, "c5", 45, 0, 0, "o"),    // opponent enters the Sicilian
  edge(2, 3, "Nf3", 44, 20, 1),       // White move 2, family known, no variation yet
  edge(3, 4, "d6", 12, 0, 0, "o"),
  edge(3, 5, "g6", 30, 0, 0, "o"),
  edge(4, 6, "d4", 11, 10, 5),        // White move 3 — the tear
  edge(5, 7, "d4", 29, 50, 2),        // White move 3 — solid, and much bigger
  edge(1, 8, "e5", 4, 0, 0, "o"),
  edge(8, 9, "Nf3", 3, 3, 1),         // White move 2 — only 3 decisions: thin
];
const white: OpeningGraph = { games: 90, root: 0, nodes: whiteNodes, edges: whiteEdges };

// -- as Black ---------------------------------------------------------------
// root -e4-> b1 -c6-> b2(Caro-Kann)
const blackNodes = [
  node("r", 0, 40),
  node("e4", 1, 38, "King's Pawn Game"),
  node("c6", 2, 25, "Caro-Kann Defense"),
];
const blackEdges = [
  edge(0, 1, "e4", 38, 0, 0, "o"),
  edge(1, 2, "c6", 25, 15, 1), // Black move 1 — choosing the Caro-Kann
];
const black: OpeningGraph = { games: 40, root: 0, nodes: blackNodes, edges: blackEdges };

const sheet = deriveTearSheet(white, black);

// -- sections and labels ----------------------------------------------------
assert.equal(sheet.sections.length, 2, "one section per colour");
const [asWhite, asBlack] = sheet.sections;
assert.equal(asWhite.color, "white");
assert.equal(asBlack.color, "black");

const sicilian = asWhite.rows.find((r) => r.family === "Sicilian Defense")!;
assert.ok(sicilian, "Sicilian is a row in the White section");

// A row is named after the opening and nothing else — the sheet is already
// scoped to a side, so no "vs"/"your" prefix invents a distinction on top.
assert.equal(sicilian.label, "Sicilian Defense");
const caro = asBlack.rows.find((r) => r.family === "Caro-Kann Defense")!;
assert.equal(caro.label, "Caro-Kann Defense");

// The Sicilian is not a White row and a Black row — sections come from the
// per-colour graphs, so one family never splits across colours.
assert.equal(
  asBlack.rows.some((r) => r.family === "Sicilian Defense"),
  false,
);

// -- startMove, pre, blank --------------------------------------------------
// The line is only identifiable after 1.e4 c5, so White's first scored move
// inside it is move 2.
assert.equal(sicilian.startMove, 2, "Sicilian starts at White's move 2");
assert.equal(sicilian.cells[0]!.state, "pre", "move 1 is before the line existed");
assert.equal(sicilian.cells[0]!.decisions, 0);

assert.equal(sicilian.bookDepth, 3, "book runs out after move 3");
assert.equal(sicilian.cells[3]!.state, "blank", "move 4 is past the book");
assert.equal(sicilian.cells[3]!.nodeKeys.length, 0);

// -- thin never colours -----------------------------------------------------
const italian = asWhite.rows.find((r) => r.family === "Italian Game")!;
const italianM2 = italian.cells[1]!;
assert.equal(italianM2.decisions, 3);
assert.ok(italianM2.decisions < FLOOR_COLOR);
assert.equal(italianM2.state, "thin");
assert.equal(italianM2.heat, undefined, "a thin cell is never coloured");

// -- dilution: the family pools, the marker does not ------------------------
const familyM3 = sicilian.cells[2]!;
assert.equal(familyM3.decisions, 60, "move 3 pools both variations");
assert.equal(familyM3.failures, 7);
assert.equal(familyM3.heat, "holds", "pooled, the family looks fine");

const najdorf = sicilian.variations.find((v) => v.label === "Najdorf Variation")!;
assert.ok(najdorf, "variations unfold under the family");
const najM3 = najdorf.cells[2]!;
assert.equal(najM3.decisions, 10);
assert.equal(najM3.failures, 5);
assert.equal(najM3.heat, "tears", "on its own the Najdorf tears");

// Decisions inside the family that never reached a named variation.
const early = sicilian.variations.find((v) => v.label === "Early deviations")!;
assert.ok(early, "unnamed decisions pool into their own row");
assert.equal(early.cells[1]!.decisions, 20, "the Nf3 decision lands there");

// -- the marker -------------------------------------------------------------
assert.ok(sheet.marker, "a marker was picked");
assert.equal(sheet.marker!.rowKey, sicilian.key);
assert.equal(sheet.marker!.variationKey, najdorf.key, "fires at variation level");
assert.equal(sheet.marker!.moveNo, 3);

// Exactly one marker exists — it is a single object, but assert the intent
// holds against the shape the component consumes.
assert.equal(typeof sheet.marker!.moveNo, "number");

// -- positions behind a cell ------------------------------------------------
assert.deepEqual(najM3.nodeKeys, ["d6"], "the cell knows its position");

// -- empty input ------------------------------------------------------------
const empty = deriveTearSheet(null, null);
assert.deepEqual(empty.sections, []);
assert.equal(empty.marker, null);

// -- column span ------------------------------------------------------------
assert.equal(sheet.maxMove, 8, "at least eight columns even for a shallow book");

console.log("tearSheet: all assertions passed");

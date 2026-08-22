/**
 * The trajectory graph, pinned where it would quietly draw the wrong picture.
 *
 * Every case here is a way a chart lies without failing. It can draw the
 * endgame first, because that is the order the API sends. It can put a phase
 * nobody reached on the axis as a flat line. It can collapse a one-bin phase
 * into a zero-width polygon and simply not appear. It can claim the games were
 * decided in the last phase every single time, because spread only accumulates.
 * And it can draw a band from forty-eight games at the same strength as one
 * from two hundred.
 */

import { describe, expect, test } from "vitest";
import {
  accuracyFinding,
  bandPaths,
  buildCone,
  coneFinding,
  coneFrom,
  coneText,
  decayStops,
  medianPath,
  phaseCards,
  project,
  railBars,
  type PhaseAccuracy,
  type PlotBox,
} from "./trajectory";
import type { TrajectoryBin } from "./v1/types";

const BOX: PlotBox = { x: 0, y: 0, width: 100, height: 60 };

const bin = (over: Partial<TrajectoryBin> & { phase: string; binOrdinal: number }): TrajectoryBin => ({
  progressLow: over.binOrdinal / 4,
  progressHigh: (over.binOrdinal + 1) / 4,
  gamesContributing: 200,
  medianExpectedScore: 0.5,
  p25ExpectedScore: 0.5,
  p75ExpectedScore: 0.5,
  intervalLow: null,
  intervalHigh: null,
  phaseReachRate: 1,
  ...over,
});

/**
 * A shape close to the real thing: level and identical at move one, pulling
 * apart through the middlegame, and reached by a quarter of the games by the
 * endgame.
 */
const REAL: TrajectoryBin[] = [
  bin({ phase: "opening", binOrdinal: 0, p25ExpectedScore: 0.511, p75ExpectedScore: 0.521, medianExpectedScore: 0.521, gamesContributing: 200 }),
  bin({ phase: "opening", binOrdinal: 1, p25ExpectedScore: 0.44, p75ExpectedScore: 0.6, gamesContributing: 200 }),
  bin({ phase: "middlegame", binOrdinal: 0, p25ExpectedScore: 0.36, p75ExpectedScore: 0.64, gamesContributing: 163, phaseReachRate: 0.8 }),
  bin({ phase: "middlegame", binOrdinal: 1, p25ExpectedScore: 0.0, p75ExpectedScore: 0.667, gamesContributing: 160, phaseReachRate: 0.8 }),
  bin({ phase: "endgame", binOrdinal: 0, p25ExpectedScore: 0.012, p75ExpectedScore: 0.741, gamesContributing: 48, phaseReachRate: 0.24 }),
];

describe("reading the bins", () => {
  test("the API's alphabetical phase order is undone", () => {
    // `order by phase, bin_ordinal` is endgame, middlegame, opening — exactly
    // backwards. A graph built on the wire order shows the endgame first.
    const cone = buildCone([...REAL].reverse())!;
    expect(cone.phases.map((phase) => phase.phase)).toEqual([
      "opening",
      "middlegame",
      "endgame",
    ]);
    expect(cone.points[0]!.phase).toBe("opening");
  });

  test("no bins is no graph", () => {
    expect(buildCone([])).toBeNull();
  });

  test("every reached phase gets an equal, adjacent slot", () => {
    const cone = buildCone(REAL)!;
    expect(cone.phases.map((phase) => [phase.from, phase.to])).toEqual([
      [0, 0.3333],
      [0.3333, 0.6667],
      [0.6667, 1],
    ]);
    // Continuous: one phase ends where the next begins, and the dividers are
    // what say the ruler changed.
    expect(cone.dividers).toEqual([0.3333, 0.6667]);
  });

  test("a phase nobody reached is named, not drawn", () => {
    const cone = buildCone(REAL.filter((row) => row.phase !== "endgame"))!;
    expect(cone.unreached).toEqual(["endgame"]);
    expect(cone.phases).toHaveLength(2);
    expect(cone.points.every((point) => point.phase !== "endgame")).toBe(true);
    expect(coneText(cone)).toContain("did not reach the endgame");
  });

  test("every x stays inside the plot and nothing is NaN", () => {
    const cone = buildCone(REAL)!;
    for (const point of cone.points) {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(1);
      expect(point.xLow).toBeLessThanOrEqual(point.xHigh);
    }
  });

  test("a bin whose percentiles arrive inverted is not drawn upside down", () => {
    const cone = buildCone([
      bin({ phase: "opening", binOrdinal: 0, p25ExpectedScore: 0.8, p75ExpectedScore: 0.2 }),
    ])!;
    expect(cone.points[0]!.spread).toBeGreaterThanOrEqual(0);
  });

  test("the snapshot's game count is attached, never inferred from the bins", () => {
    const cone = coneFrom({ bins: REAL, includedGameCount: 200 })!;
    expect(cone.includedGames).toBe(200);
    // The bins count games per bin, which is a different number and would be
    // wrong here: a game contributes to several bins of the same phase.
    expect(cone.peakGames).toBe(200);
  });
});

describe("scaling", () => {
  test("score one is the top of the box and zero the bottom", () => {
    expect(project(BOX, 0, 1)).toEqual([0, 0]);
    expect(project(BOX, 1, 0)).toEqual([100, 60]);
    expect(project(BOX, 0.5, 0.5)).toEqual([50, 30]);
  });

  test("a value outside the scale is clamped rather than drawn off the plot", () => {
    expect(project(BOX, 2, 5)).toEqual([100, 0]);
    expect(project(BOX, -1, -1)).toEqual([0, 60]);
  });

  test("the band is split at level, and each half collapses when it is empty", () => {
    const above = buildCone([
      bin({ phase: "opening", binOrdinal: 0, p25ExpectedScore: 0.7, p75ExpectedScore: 0.9 }),
      bin({ phase: "opening", binOrdinal: 1, p25ExpectedScore: 0.6, p75ExpectedScore: 0.95 }),
    ])!;
    const paths = bandPaths(above.points, BOX);
    // Entirely winning: the losing half is drawn flat on the level line, which
    // has no area, rather than being given a colour it has not earned.
    expect(paths.above).not.toBe("");
    expect(new Set(losingYs(paths.below)).size).toBe(1);
  });

  test("a single bin is a bar, not an invisible zero-width polygon", () => {
    const cone = buildCone([bin({ phase: "opening", binOrdinal: 0, p25ExpectedScore: 0.2, p75ExpectedScore: 0.8 })])!;
    const paths = bandPaths(cone.points, BOX);
    const xs = [...paths.above.matchAll(/[ML](-?[\d.]+) /g)].map((match) => Number(match[1]));
    expect(Math.max(...xs)).toBeGreaterThan(Math.min(...xs));
    expect(paths.above).not.toContain("NaN");
    expect(medianPath(cone.points, BOX)).not.toContain("NaN");
  });

  test("a band with no spread at all is a hairline, not padded into a shape", () => {
    // Every game alike at this point is a real answer. Inventing a minimum
    // thickness would draw disagreement that is not in the data.
    const cone = buildCone([
      bin({ phase: "opening", binOrdinal: 0 }),
      bin({ phase: "opening", binOrdinal: 1 }),
    ])!;
    expect(cone.points.every((point) => point.spread === 0)).toBe(true);
    const paths = bandPaths(cone.points, BOX);
    expect(paths.above).not.toContain("NaN");
    expect(paths.below).not.toContain("NaN");
    expect(coneFinding(cone).headline).toBe("Your games stay close throughout.");
  });

  test("an empty series draws nothing rather than a broken path", () => {
    expect(bandPaths([], BOX)).toEqual({ above: "", below: "" });
    expect(medianPath([], BOX)).toBe("");
  });

  test("the band fades with the evidence behind it", () => {
    const cone = buildCone(REAL)!;
    const stops = decayStops(cone);
    expect(stops).toHaveLength(cone.points.length);
    // Never zero: a phase a quarter of the games reached is still evidence.
    // Never one at the thin end: it must not look like the well-evidenced end.
    expect(stops[0]!.strength).toBe(1);
    expect(stops[stops.length - 1]!.strength).toBeGreaterThan(0.4);
    expect(stops[stops.length - 1]!.strength).toBeLessThan(0.7);
    expect(stops.map((stop) => stop.offset)).toEqual(
      [...stops.map((stop) => stop.offset)].sort((a, b) => a - b),
    );
    // One stop per bin, keyed by the bin: two landing on the same x would be a
    // duplicate React key, and React drops one of the pair.
    expect(new Set(stops.map((stop) => stop.key)).size).toBe(stops.length);
  });

  test("x is quantised finer than the gap between two bins", () => {
    // A real snapshot holds twenty bins per phase, so consecutive points are
    // 0.0167 apart on a 0-1 axis. Rounded to hundredths they land on a grid
    // coarser than their own spacing: the curve stair-steps, and a denser
    // snapshot puts two points at the same x.
    const dense = Array.from({ length: 20 }, (_, index) =>
      bin({
        phase: "opening",
        binOrdinal: index,
        progressLow: index / 20,
        progressHigh: (index + 1) / 20,
      }),
    );
    const xs = buildCone(dense)!.points.map((point) => point.x);
    expect(new Set(xs).size).toBe(xs.length);
    const gaps = xs.slice(1).map((x, index) => Math.round((x - xs[index]!) * 1e6) / 1e6);
    expect(new Set(gaps).size).toBe(1);
  });

  test("no games behind any bin means no decay gradient at all", () => {
    const cone = buildCone([bin({ phase: "opening", binOrdinal: 0, gamesContributing: 0 })])!;
    expect(decayStops(cone)).toEqual([]);
    expect(railBars(cone, BOX, 63, 11)).toEqual([]);
  });

  test("the sample rail is in the plot's units, not the point's", () => {
    // A `ConePoint` carries 0-1 and the viewBox runs 0-100. Mixing the two is
    // valid SVG that piles every bar into the first hundredth of the chart,
    // which is exactly what happened the first time this was written inline.
    const cone = buildCone(REAL)!;
    const bars = railBars(cone, BOX, 63, 11);
    expect(bars).toHaveLength(cone.points.length);
    expect(bars[0]!.x).toBe(0);
    expect(bars[bars.length - 1]!.x).toBeGreaterThan(BOX.width * 0.6);
    expect(bars[bars.length - 1]!.x + bars[bars.length - 1]!.width).toBeLessThanOrEqual(BOX.width);
  });

  test("the rail is the game count, and rests on the axis", () => {
    const bars = railBars(buildCone(REAL)!, BOX, 63, 11);
    // Tallest where the most games stand, and every bar bottoms out together.
    expect(bars[0]!.height).toBe(11);
    expect(bars[bars.length - 1]!.height).toBeLessThan(4);
    // Both ends are rounded to two places, so they meet the axis within a
    // hundredth of a viewBox unit rather than exactly.
    for (const bar of bars) expect(bar.y + bar.height).toBeCloseTo(74, 1);
  });
});

/** The y values of every point in a path, for checking a collapsed area. */
function losingYs(path: string): number[] {
  return [...path.matchAll(/[ML]-?[\d.]+ (-?[\d.]+)/g)].map((match) => Number(match[1]));
}

describe("what the graph says", () => {
  test("the phase named is where the band opens, not where it is widest", () => {
    // Spread only accumulates, so the widest point is almost always the last
    // one. Naming it would say "decided in the endgame" for every player alive.
    const cone = buildCone([
      bin({ phase: "opening", binOrdinal: 0, p25ExpectedScore: 0.49, p75ExpectedScore: 0.51 }),
      bin({ phase: "opening", binOrdinal: 1, p25ExpectedScore: 0.45, p75ExpectedScore: 0.55 }),
      bin({ phase: "middlegame", binOrdinal: 0, p25ExpectedScore: 0.44, p75ExpectedScore: 0.56 }),
      bin({ phase: "middlegame", binOrdinal: 1, p25ExpectedScore: 0.05, p75ExpectedScore: 0.95 }),
      bin({ phase: "endgame", binOrdinal: 0, p25ExpectedScore: 0.02, p75ExpectedScore: 0.98, phaseReachRate: 0.24 }),
    ])!;
    expect(cone.widest.phase).toBe("endgame");
    expect(coneFinding(cone).decidedIn).toBe("middlegame");
    expect(coneFinding(cone).headline).toBe("Your games are decided in the middlegame.");
  });

  test("a band that never opens names no phase at all", () => {
    const cone = buildCone([
      bin({ phase: "opening", binOrdinal: 0, p25ExpectedScore: 0.48, p75ExpectedScore: 0.52 }),
      bin({ phase: "opening", binOrdinal: 1, p25ExpectedScore: 0.46, p75ExpectedScore: 0.54 }),
    ])!;
    expect(coneFinding(cone).decidedIn).toBeNull();
    expect(coneFinding(cone).detail).toContain("Nothing in the shape says where these games turn");
  });

  test("a lopsided band is described, so the colour is never the only carrier", () => {
    const cone = buildCone(REAL)!;
    const finding = coneFinding(cone);
    expect(finding.lopsided).toContain("collapse further than your good ones run away");
  });

  test("a band that is even either side of level claims no lopsidedness", () => {
    const cone = buildCone([
      bin({ phase: "opening", binOrdinal: 0, p25ExpectedScore: 0.5, p75ExpectedScore: 0.5 }),
      bin({ phase: "opening", binOrdinal: 1, p25ExpectedScore: 0.1, p75ExpectedScore: 0.9 }),
    ])!;
    expect(coneFinding(cone).lopsided).toBeNull();
  });

  test("the text alternative carries the sample decay, not just the shape", () => {
    const text = coneText(buildCone(REAL)!);
    expect(text).toContain("48 games");
    expect(text).toContain("24% of the archive reached it");
    expect(text).toContain("200 games");
  });
});

describe("the phase cards", () => {
  test("with no published rate a card carries no rate and invents none", () => {
    const cards = phaseCards(buildCone(REAL)!);
    expect(cards).toHaveLength(3);
    expect(cards.every((card) => card.accuracy === null)).toBe(true);
    expect(cards.every((card) => card.standing === null)).toBe(true);
    expect(accuracyFinding(cards)).toBeNull();
  });

  test("a card is aligned to its own stretch of the graph", () => {
    const cards = phaseCards(buildCone(REAL)!);
    const cone = buildCone(REAL)!;
    expect(cards.map((card) => card.from)).toEqual(cone.phases.map((phase) => phase.from));
    expect(cards.map((card) => card.to)).toEqual(cone.phases.map((phase) => phase.to));
  });

  test("a phase standing on few games says so on the card itself", () => {
    const cards = phaseCards(
      buildCone([
        bin({ phase: "opening", binOrdinal: 0, gamesContributing: 200 }),
        bin({ phase: "endgame", binOrdinal: 0, gamesContributing: 12, phaseReachRate: 0.06 }),
      ])!,
    );
    expect(cards[0]!.caution).toBeNull();
    expect(cards[1]!.caution).toContain("12 games");
    expect(cards[1]!.caution).toContain("first impression");
  });

  test("with rates published the strongest and weakest phase are named", () => {
    const rate = (phase: string, took: number, chances: number, games: number): PhaseAccuracy => ({
      phase,
      chances,
      took,
      rate: took / chances,
      intervalLow: null,
      intervalHigh: null,
      gamesReaching: games,
      setAside: 0,
    });
    const cards = phaseCards(buildCone(REAL)!, [
      rate("opening", 1397, 3141, 320),
      rate("middlegame", 3995, 7399, 305),
      rate("endgame", 1434, 2143, 89),
    ]);
    expect(cards.find((card) => card.phase === "opening")!.standing).toBe("Your weakest phase");
    expect(cards.find((card) => card.phase === "endgame")!.standing).toBe("Your strongest phase");
    // The rate counts every synced game and the band counts the frozen cohort.
    // 320 and 200 on one card without a reason is the contradiction a reader
    // spots and then stops trusting the page for.
    expect(cards[0]!.scopeNote).toContain("every synced game that reached the opening");
    expect(cards[0]!.scopeNote).toContain("200");
    // The two statements are kept apart: the band still says the games are
    // decided in the middlegame while the rates say the play is worst in the
    // opening, and neither is allowed to overwrite the other.
    expect(coneFinding(buildCone(REAL)!).decidedIn).toBe("middlegame");
    expect(accuracyFinding(cards)).toContain("44% of your chances in the opening");
    expect(accuracyFinding(cards)).toContain("12,683 graded chances");
  });

  test("a rate for only some phases names no best and no worst", () => {
    // Naming a best of two out of three is a claim about the third one that
    // nobody measured.
    const cards = phaseCards(buildCone(REAL)!, [
      {
        phase: "opening",
        chances: 100,
        took: 20,
        rate: 0.2,
        intervalLow: null,
        intervalHigh: null,
        gamesReaching: 90,
        setAside: 0,
      },
    ]);
    expect(cards.every((card) => card.standing === null)).toBe(true);
    expect(accuracyFinding(cards)).toBeNull();
  });
});

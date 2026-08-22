/**
 * The trajectory graph: one evaluation curve across a whole archive.
 *
 * This is the evaluation graph everybody knows from a single game, at player
 * scale. It is deliberately **not** a line chart of the median, and the reason
 * is in the data rather than in taste: averaging two hundred games at any point
 * gives almost exactly level, because half of them are going well and half
 * badly. A median-only chart of a real archive is a flat horizontal rule at
 * 0.500 that looks like a broken component.
 *
 * **The band is the graph.** The shaded region is the middle half of the games
 * at that point — p25 to p75 — and the line through it is the median. At move
 * one everybody is level and the band is a hairline. Later a quarter of the
 * games are lost and a quarter are won, and the hairline has opened into a
 * cone. That widening is the finding: it says where the games are decided.
 *
 * ## One graph, three phases
 *
 * The curve runs unbroken from the first move to the last, with a dashed
 * divider where one phase ends and the next begins. The dividers are not
 * decoration: the server normalises each phase to 0–100% of its own length
 * (`estimates/trajectory.ts`, following platform spec 3.5) so that a twenty-move
 * opening and a six-move opening are comparable, which means the x axis is
 * three independent runs rather than one clock. The line is continuous because
 * a game is; the dividers say where the ruler changes.
 *
 * ## Where the colour comes from
 *
 * The band is split at level and the two halves are coloured: the part above
 * 0.5 in the win colour, the part below in the loss colour. This is not a
 * relabelling of the axis. The two tails are strongly asymmetric in real data —
 * a losing quarter that falls to 0.00 beside a winning quarter that only
 * reaches 0.67 says the bad games collapse much further than the good ones run
 * away — and that asymmetry is invisible in a single-colour band. `coneFinding`
 * states it in words as well, so the colour is never the only carrier.
 *
 * ## A phase nobody reached is absent, never imputed
 *
 * Only about a quarter of a typical archive reaches an endgame, so the sample
 * decays along the axis, and a band drawn at full strength over forty-eight
 * games beside one drawn over two hundred claims evidence it does not have.
 * Every phase carries its own game count and reach rate, every bin carries the
 * games behind it, and the caller is expected to render both.
 *
 * Nothing here invents a number. Every value is a field the API sent; the only
 * arithmetic is geometry and differences between two published percentiles, and
 * the only judgement is `coneFinding`, which refuses to say a game was decided
 * anywhere unless the band actually opened there.
 */

import { smoothCurve } from "./curve";
import type { TrajectoryBin } from "./v1/types";

/** Reading order. The API orders bins by phase *name*, which is alphabetical. */
export const PHASE_ORDER = ["opening", "middlegame", "endgame"] as const;

/** Level. An expected score of 0.5 is a game going neither way. */
export const LEVEL = 0.5;

const PHASE_NAME: Record<string, string> = {
  opening: "opening",
  middlegame: "middlegame",
  endgame: "endgame",
};

/** The phase as a word. An unknown phase is humanised rather than printed raw. */
export function phaseName(phase: string): string {
  return PHASE_NAME[phase] ?? phase.replace(/_/g, " ");
}

export interface ConePoint {
  /** Position across the whole plot, 0–1. */
  x: number;
  /** The bin's own span, for a phase that holds a single bin. */
  xLow: number;
  xHigh: number;
  median: number;
  p25: number;
  p75: number;
  /** `p75 - p25`. How far apart the middle half of the games is here. */
  spread: number;
  games: number;
  phase: string;
  binOrdinal: number;
  /** Where in its own phase the bin sits, 0–1. */
  progress: number;
}

export interface ConePhase {
  phase: string;
  name: string;
  /** The slot this phase occupies across the plot, 0–1. */
  from: number;
  to: number;
  /** The most games behind any one bin here. */
  games: number;
  /** Share of the archive that reached this phase, 0–1. */
  reachRate: number;
  /**
   * The middle half's width where the games entered this phase.
   *
   * Measured on the point immediately before this phase's first bin, not on
   * that bin itself, and the difference matters twice: a phase holding a single
   * bin would otherwise have no measurable growth at all, and the games arrive
   * at a phase already carrying whatever the previous one did to them. The
   * populations either side of a boundary are not identical — only some games
   * reach the next phase — so this is a reading of the curve rather than a
   * paired comparison, which is exactly how it is described on screen.
   */
  spreadIn: number;
  /** And at the last bin of the phase. */
  spreadOut: number;
  /**
   * How much the middle half opened across this phase.
   *
   * The closest thing the published numbers have to "this is where the games
   * were decided". Spread only accumulates, so the *widest* point is almost
   * always the last one and says nothing about where the separating happened;
   * the growth across a phase does.
   */
  growth: number;
  /** The last bin of the phase: where the games stand coming out of it. */
  exit: ConePoint;
  points: ConePoint[];
}

export interface Cone {
  phases: ConePhase[];
  /** Every point, in reading order, as one continuous series. */
  points: ConePoint[];
  /** Where a dashed divider goes, 0–1. One per phase boundary. */
  dividers: number[];
  /** The most games behind any bin anywhere. The sample rail's denominator. */
  peakGames: number;
  /** The first bin of the first phase: where the games all still look alike. */
  first: ConePoint;
  /** Where the middle half of the games is furthest apart. */
  widest: ConePoint;
  /** The phase the games open up in, or null when none clearly does. */
  decisive: ConePhase | null;
  /** Phases the archive never reached, named so nothing draws a flat line. */
  unreached: string[];
  /** Games behind the whole picture, as the snapshot counted them. */
  includedGames: number;
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/**
 * Four places, not two.
 *
 * A real snapshot holds twenty bins per phase, so sixty points share the 0–1 x
 * axis and consecutive ones are 0.0167 apart. Rounded to hundredths they
 * quantise onto a grid coarser than the spacing between them: the curve gains a
 * visible stair-step, and a denser snapshot would put two points at the same x,
 * which collapses a path segment and collides two gradient stops. Path output
 * is rounded again by `project`, in a 0–100 space where two places is plenty.
 */
const round = (value: number): number => Math.round(value * 10_000) / 10_000;

function phaseRank(phase: string): number {
  const index = (PHASE_ORDER as readonly string[]).indexOf(phase);
  return index === -1 ? PHASE_ORDER.length : index;
}

/**
 * Turn the bins the API sent into a drawable curve, or null when there is none.
 *
 * Bins arrive ordered by phase name — `endgame, middlegame, opening` — which is
 * alphabetical and exactly backwards. Re-sorting is the first thing that
 * happens, and it is the single most load-bearing line in this file: a graph
 * built on the wire order shows the endgame first and reads as noise.
 */
export function buildCone(bins: readonly TrajectoryBin[]): Cone | null {
  if (bins.length === 0) return null;

  const byPhase = new Map<string, TrajectoryBin[]>();
  for (const bin of bins) {
    byPhase.set(bin.phase, [...(byPhase.get(bin.phase) ?? []), bin]);
  }
  const order = [...byPhase.keys()].sort(
    (a, b) => phaseRank(a) - phaseRank(b) || a.localeCompare(b),
  );

  // Only the phases that were actually reached share the axis, and they are
  // adjacent: the curve is continuous and a dashed divider marks each join. An
  // absent endgame shortens the picture rather than leaving a third of it
  // blank, and `unreached` carries its name so the caption can say so.
  const slotWidth = 1 / order.length;

  const phases: ConePhase[] = [];
  const points: ConePoint[] = [];

  order.forEach((phase, index) => {
    const rows = [...(byPhase.get(phase) ?? [])].sort((a, b) => a.binOrdinal - b.binOrdinal);
    const from = index * slotWidth;

    const phasePoints = rows.map((bin) => {
      const low = clamp01(bin.progressLow);
      const high = clamp01(Math.max(bin.progressHigh, bin.progressLow));
      const mid = (low + high) / 2;
      const p25 = clamp01(bin.p25ExpectedScore);
      const p75 = clamp01(Math.max(bin.p75ExpectedScore, bin.p25ExpectedScore));
      return {
        x: round(from + mid * slotWidth),
        xLow: round(from + low * slotWidth),
        xHigh: round(from + high * slotWidth),
        median: round(clamp01(bin.medianExpectedScore)),
        p25: round(p25),
        p75: round(p75),
        spread: round(p75 - p25),
        games: bin.gamesContributing,
        phase,
        binOrdinal: bin.binOrdinal,
        progress: round(mid),
      } satisfies ConePoint;
    });

    // The point the games arrive at this phase carrying, which is the last one
    // of the previous phase. For the first phase there is nothing before it, so
    // it is measured from its own opening bin.
    const arrival = points[points.length - 1] ?? phasePoints[0]!;
    points.push(...phasePoints);
    const exit = phasePoints[phasePoints.length - 1]!;
    phases.push({
      phase,
      name: phaseName(phase),
      from: round(from),
      to: round(from + slotWidth),
      // The most games behind any one bin, not a sum: a game contributes to
      // several bins of the same phase, so adding them would count it twice.
      games: phasePoints.reduce((most, point) => Math.max(most, point.games), 0),
      reachRate: clamp01(rows[0]?.phaseReachRate ?? 0),
      spreadIn: arrival.spread,
      spreadOut: exit.spread,
      growth: round(exit.spread - arrival.spread),
      exit,
      points: phasePoints,
    });
  });

  if (points.length === 0) return null;

  const first = points[0]!;
  let widest = first;
  let peakGames = 0;
  for (const point of points) {
    if (point.spread > widest.spread) widest = point;
    if (point.games > peakGames) peakGames = point.games;
  }

  // The phase where the middle half opens most, and only when it opens enough
  // to be worth naming: a fifth of the whole scale, and more than any other
  // phase. Below that the picture is a ribbon and no phase decided anything.
  const ranked = [...phases].sort((a, b) => b.growth - a.growth);
  const decisive = ranked[0] && ranked[0].growth >= 0.2 ? ranked[0] : null;

  return {
    phases,
    points,
    dividers: phases.slice(0, -1).map((phase) => phase.to),
    peakGames,
    first,
    widest,
    decisive,
    unreached: (PHASE_ORDER as readonly string[]).filter((phase) => !byPhase.has(phase)),
    includedGames: 0,
  };
}

/**
 * The cone, with the snapshot's own game count attached.
 *
 * Kept separate from `buildCone` so the geometry can be tested from bins alone,
 * and so a caller cannot pass a count that disagrees with them.
 */
export function coneFrom(
  trajectory: { bins: readonly TrajectoryBin[]; includedGameCount: number },
): Cone | null {
  const cone = buildCone(trajectory.bins);
  return cone === null ? null : { ...cone, includedGames: trajectory.includedGameCount };
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

export interface PlotBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where a point lands in the box. Score 1 is the top; 0 is the bottom. */
export function project(box: PlotBox, x: number, score: number): [number, number] {
  // Two places here, unlike everywhere else in this file: the box is a hundred
  // units wide, so a hundredth of one is a fraction of a pixel at any size the
  // chart is drawn at, and four places would double the length of a path
  // string carrying a hundred and twenty points for nothing.
  const place = (value: number): number => Math.round(value * 100) / 100;
  return [
    place(box.x + clamp01(x) * box.width),
    place(box.y + (1 - clamp01(score)) * box.height),
  ];
}

/**
 * A closed area between two curves over the same points.
 *
 * A series of one point has no curve to draw, so it becomes a bar the width of
 * that bin's own span. Without this a one-bin trajectory is a zero-width
 * polygon: valid SVG, completely invisible, and the worst way for a measurement
 * to disappear.
 */
function areaPath(
  points: readonly ConePoint[],
  box: PlotBox,
  top: (point: ConePoint) => number,
  bottom: (point: ConePoint) => number,
): string {
  if (points.length === 0) return "";
  if (points.length === 1) {
    const only = points[0]!;
    const [left, upper] = project(box, only.xLow, top(only));
    const [right] = project(box, only.xHigh, top(only));
    const [, lower] = project(box, only.xLow, bottom(only));
    return `M${left} ${upper}L${right} ${upper}L${right} ${lower}L${left} ${lower}Z`;
  }
  const edge = (pick: (point: ConePoint) => number, reversed: boolean) => {
    const series = reversed ? [...points].reverse() : points;
    return series.map((point) => {
      const [x, y] = project(box, point.x, pick(point));
      return { x, y };
    });
  };
  // Smoothed, because a corner at every bin is the sampling interval rather
  // than anything that happened in a game. The two edges are one closed shape,
  // so the join between them is a corner a round linejoin can soften instead of
  // a seam between two paths.
  const head = smoothCurve(edge(top, false), "M");
  const tail = smoothCurve(edge(bottom, true), "L");
  return `${head}${tail}Z`;
}

/**
 * The band, split at level into the winning half and the losing half.
 *
 * Two exact polygons rather than one polygon and a clip: the part of the band
 * above level runs between `max(p25, level)` and `max(p75, level)`, which
 * collapses to nothing wherever the whole band is under water, and the mirror
 * for below. Nothing is clipped, so nothing depends on clip-path support and
 * the two shapes always meet exactly on the level line.
 */
export function bandPaths(
  points: readonly ConePoint[],
  box: PlotBox,
  level: number = LEVEL,
): { above: string; below: string } {
  return {
    above: areaPath(
      points,
      box,
      (point) => Math.max(point.p75, level),
      (point) => Math.max(point.p25, level),
    ),
    below: areaPath(
      points,
      box,
      (point) => Math.min(point.p75, level),
      (point) => Math.min(point.p25, level),
    ),
  };
}

/**
 * The whole middle half as one shape, rather than two split at level.
 *
 * The split band coloured the winning quarter green and the losing quarter red,
 * and the asymmetry between them was the reading. It is still the reading — and
 * `coneFinding` says it in words — but the colour was carrying a claim the
 * figure elsewhere makes with shape, and a ribbon that is green on top and red
 * underneath for its whole length reads as decoration before it reads as data.
 * One neutral band puts the spread back in charge, which is what the eye should
 * be measuring here.
 */
export function bandPath(points: readonly ConePoint[], box: PlotBox): string {
  return areaPath(
    points,
    box,
    (point) => point.p75,
    (point) => point.p25,
  );
}

/**
 * The sample rail as one area under a curve, rather than a bar per bin.
 *
 * Drawn as bars this register was the band again at a lighter weight — same
 * width, same rhythm, near enough the same height across the opening — and a
 * reader has to work out that the two are not the same kind of thing. A curve
 * is a different kind of mark, and what this register says is a shape: the
 * archive is whole here, and by the endgame it is a quarter of itself.
 */
export function railPath(
  cone: Cone,
  box: PlotBox,
  top: number,
  height: number,
): { edge: string; area: string } {
  if (cone.peakGames <= 0 || cone.points.length === 0) return { edge: "", area: "" };
  const y = (point: ConePoint) =>
    round(top + height - (point.games / cone.peakGames) * height);
  const points = cone.points.map((point) => ({
    x: round(box.x + clamp01(point.x) * box.width),
    y: y(point),
  }));
  // Squared off to the plot's own edges, so the rail spans the same width as
  // the band above it instead of stopping half a bin short at each end.
  points.unshift({ x: round(box.x), y: points[0]!.y });
  points.push({ x: round(box.x + box.width), y: points[points.length - 1]!.y });
  const edge = smoothCurve(points);
  const floor = round(top + height);
  // Edge and area as two paths: one closed path would stroke the baseline too,
  // drawing a rule under the figure that means nothing.
  return {
    edge,
    area: `${edge}L${round(box.x + box.width)} ${floor}L${round(box.x)} ${floor}Z`,
  };
}

/** The median, as an open path. One point becomes a short flat tick. */
export function medianPath(points: readonly ConePoint[], box: PlotBox): string {
  if (points.length === 0) return "";
  if (points.length === 1) {
    const only = points[0]!;
    const [left, y] = project(box, only.xLow, only.median);
    const [right] = project(box, only.xHigh, only.median);
    return `M${left} ${y}L${right} ${y}`;
  }
  return smoothCurve(
    points.map((point) => {
      const [x, y] = project(box, point.x, point.median);
      return { x, y };
    }),
  );
}

export interface RailBar {
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
  games: number;
}

/**
 * The sample rail: one bar per bin, at the height of the games behind it.
 *
 * Here rather than in the component because the x axis of the plot runs 0–100
 * in viewBox units while a `ConePoint` carries 0–1, and mixing the two is a
 * silent failure: the bars stay valid SVG, they simply all pile up in the first
 * hundredth of the chart. That is exactly what happened the first time this was
 * written inline, and it is why the conversion is tested.
 */
export function railBars(
  cone: Cone,
  box: PlotBox,
  top: number,
  height: number,
): RailBar[] {
  if (cone.peakGames <= 0) return [];
  return cone.points.map((point) => {
    const bar = (point.games / cone.peakGames) * height;
    const left = box.x + clamp01(point.xLow) * box.width;
    const right = box.x + clamp01(point.xHigh) * box.width;
    return {
      key: `${point.phase}-${point.binOrdinal}`,
      x: round(left),
      // A bin narrower than a fifth of a viewBox unit would round away to
      // nothing on a phone. It is evidence and it has to remain visible.
      width: round(Math.max(0.2, right - left)),
      y: round(top + (height - bar)),
      height: round(bar),
      games: point.games,
    };
  });
}

/**
 * How strongly the band is drawn at each point, from the games behind it.
 *
 * Rendered as the stops of a gradient the band is masked with, so the evidence
 * running out is visible in the picture itself rather than only in the caption.
 * Never zero and never one: a phase a fifth of the games reached is still
 * evidence and must stay visible, and a phase every game reached should not
 * look identical to one half of them did.
 */
export function decayStops(cone: Cone): { key: string; offset: number; strength: number }[] {
  if (cone.peakGames <= 0) return [];
  return cone.points.map((point) => ({
    // Keyed by the bin, not by the offset: two bins landing on the same x is
    // unlikely and would be a duplicate React key, which drops a stop.
    key: `${point.phase}-${point.binOrdinal}`,
    offset: point.x,
    strength: round(0.4 + 0.6 * clamp01(point.games / cone.peakGames)),
  }));
}

// ---------------------------------------------------------------------------
// What the picture says
// ---------------------------------------------------------------------------

const pct = (value: number): string => `${Math.round(value * 100)}%`;

/** Percentage points, unsigned. The unit for a change between two rates. */
const pts = (value: number): string => `${Math.abs(Math.round(value * 100))}`;

/** Where in its own phase a bin sits, in words. */
function whereIn(point: ConePoint): string {
  const name = phaseName(point.phase);
  if (point.progress < 0.34) return `the start of the ${name}`;
  if (point.progress < 0.67) return `the middle of the ${name}`;
  return `the end of the ${name}`;
}

export interface ConeFinding {
  /** One clause, short enough to be a heading. */
  headline: string;
  /** The same claim with the numbers that make it checkable. */
  detail: string;
  /** The phase the games separate in, or null when none clearly does. */
  decidedIn: string | null;
  /**
   * Which way the band is lopsided at its widest, in words, or null when it is
   * near enough even. This is the reading the colour carries, said out loud.
   */
  lopsided: string | null;
}

/**
 * The finding the graph makes, or an honest statement that it makes none.
 *
 * "Your games are decided in the middlegame" is only said when the middle half
 * genuinely opens up there: at least a fifth of the whole scale of growth
 * across that phase, and more than any other phase managed. Spread accumulates,
 * so picking the *widest* point would name the last phase every time; growth is
 * what "decided here" actually means.
 */
export function coneFinding(cone: Cone): ConeFinding {
  const { first, widest, decisive } = cone;

  const fall = LEVEL - widest.p25;
  const rise = widest.p75 - LEVEL;
  // Only said when one side genuinely reaches further. Half a band on each side
  // of level is what a symmetric distribution looks like and is not a finding.
  const lopsided =
    fall >= rise * 1.5 && fall - rise >= 0.1
      ? `At its widest the losing quarter of your games has fallen ${pts(fall)} points below level while the winning quarter is only ${pts(rise)} above it: your bad games collapse further than your good ones run away.`
      : rise >= fall * 1.5 && rise - fall >= 0.1
        ? `At its widest the winning quarter of your games is ${pts(rise)} points above level while the losing quarter is only ${pts(fall)} below it: your good games run away further than your bad ones collapse.`
        : null;

  const opening = `At ${whereIn(first)} the middle half of your games sit between ${pct(first.p25)} and ${pct(first.p75)}.`;

  if (decisive === null) {
    return {
      headline: "Your games stay close throughout.",
      detail: `${opening} At its widest, ${whereIn(widest)}, that middle half still only runs from ${pct(widest.p25)} to ${pct(widest.p75)}. Nothing in the shape says where these games turn.`,
      decidedIn: null,
      lopsided,
    };
  }

  // Only said when it is true. The median sitting still while the band opens is
  // the whole point of drawing a band, but a median that genuinely drifts is a
  // different story and must not be described as this one.
  const drift = Math.abs(decisive.exit.median - first.median);
  const flat =
    drift < 0.05
      ? " The line through the middle barely moves, because for every game going well there is one going badly."
      : ` The middle of them ${decisive.exit.median < first.median ? "falls" : "rises"} from ${pct(first.median)} to ${pct(decisive.exit.median)} across it.`;

  return {
    headline: `Your games are decided in the ${decisive.name}.`,
    detail: `${opening} Across the ${decisive.name} that gap opens by ${pts(decisive.growth)} points, and by the end of it a quarter of your games are below ${pct(decisive.exit.p25)} and a quarter above ${pct(decisive.exit.p75)}.${flat}`,
    decidedIn: decisive.phase,
    lopsided,
  };
}

/**
 * The graph in words, for a reader who is not looking at it.
 *
 * Every chart needs one, and it has to state the finding rather than announce
 * that a chart exists. The per-phase sentences carry the sample decay, because
 * that is the part a picture makes obvious and a summary usually drops.
 */
export function coneText(cone: Cone): string {
  const finding = coneFinding(cone);
  const phases = cone.phases.map(
    (phase) =>
      `${phase.name}: ${phase.games} ${phase.games === 1 ? "game" : "games"}, ${pct(phase.reachRate)} of the archive reached it; the middle half runs from ${pct(phase.exit.p25)} to ${pct(phase.exit.p75)} as it ends.`,
  );
  const missing =
    cone.unreached.length === 0
      ? ""
      : ` Your games did not reach the ${cone.unreached.map(phaseName).join(" or the ")}, so that part is absent rather than flat.`;
  return [finding.detail, finding.lopsided, phases.join(" ")]
    .filter((part): part is string => part !== null && part !== "")
    .join(" ")
    .concat(missing);
}

// ---------------------------------------------------------------------------
// One card per phase
// ---------------------------------------------------------------------------

/**
 * How well the player took their chances in one phase.
 *
 * **No route publishes this yet.** The evidence exists — every row of
 * `analysis.concept_opportunities` carries a phase — but `GET /v1/dashboard`
 * ships estimates that are not phase-scoped, so there is nothing to read. This
 * interface is the seam: when a route starts returning per-phase rates, the
 * cards gain the figure and the interval in the same change, and until then
 * they say the figure is not published rather than deriving one here. A client
 * that split the observations itself would be inventing a measurement and
 * putting Forma's name on it.
 *
 * Note the denominator. These counts run over every synced game, while the
 * trajectory bins run over the frozen cohort the examination was published
 * from. They are different populations, so a card that shows both has to show
 * both game counts, which is why `gamesReaching` is a required field.
 */
export interface PhaseAccuracy {
  phase: string;
  /** Chances that were graded. The denominator of the rate. */
  chances: number;
  /** Of those, the ones taken. */
  took: number;
  /** The rate the server computed, 0–1. Never recomputed from the two counts. */
  rate: number;
  intervalLow: number | null;
  intervalHigh: number | null;
  /** Games that reached this phase at all. Not the same as the cohort size. */
  gamesReaching: number;
  /** Chances the player never got to answer. Excluded from the rate. */
  setAside: number;
}

export interface PhaseCard {
  phase: string;
  name: string;
  /** The slot the card aligns to, matching its segment of the graph. */
  from: number;
  to: number;

  /** How often chances here were taken, or null while no route publishes it. */
  accuracy: PhaseAccuracy | null;
  /** "Your weakest phase" / "Your strongest phase", when the gap is real. */
  standing: string | null;

  /** How much the middle half opened across this phase, in points. */
  growth: number;
  /** The one-line reading of that figure. */
  reading: string;
  reachRate: number;
  /** Games behind the band here, from the published trajectory cohort. */
  games: number;
  /** Where the games stand as the phase ends, as a sentence. */
  exit: string;
  /**
   * That the two halves of this card count different games, when they do.
   *
   * The rate runs over every synced game that reached the phase; the band runs
   * over the frozen cohort the examination was published from. Showing 320 and
   * 200 on one card without saying why is the kind of quiet contradiction a
   * reader spots and then stops trusting the whole page for.
   */
  scopeNote: string | null;
  /**
   * Why the card should be read carefully, or null.
   *
   * Thin evidence is a fact about the card, not a footnote to the page: a phase
   * a quarter of the games reached is a different kind of claim from one every
   * game reached, and the card that makes it has to say so itself.
   */
  caution: string | null;
}

/** Below this, a phase card is describing too few games to be read plainly. */
const THIN_GAMES = 30;

/** Below this gap between best and worst phase, "strongest" means nothing. */
const STANDING_GAP = 0.05;

/**
 * The cards under the graph, one per phase, in the same shape.
 *
 * Each card carries **two different statements about the same phase, kept
 * apart**, because collapsing them would be wrong in an interesting way:
 *
 *   * *how well you play here* — the share of chances taken, which is a rate;
 *   * *how much your games move here* — how far the middle half opens, which
 *     is variance.
 *
 * They can disagree and both still be true. A player can have their worst rate
 * in the opening and still have their games decided in the middlegame: one says
 * where the mistakes are, the other says where the mistakes start costing
 * whole games. A single "phase score" mixing them would say neither.
 *
 * Everything in the band half is published on `player_trajectory_bins`. The
 * accuracy half is passed in and is null today, because no route returns it.
 */
export function phaseCards(
  cone: Cone,
  accuracy: readonly PhaseAccuracy[] = [],
): PhaseCard[] {
  const byPhase = new Map(accuracy.map((entry) => [entry.phase, entry]));

  // "Strongest" and "weakest" are only worth saying when there is a gap between
  // them, and only when every phase has a rate: naming a best of two out of
  // three is a claim about the third one that nobody measured.
  const rates = cone.phases
    .map((phase) => byPhase.get(phase.phase)?.rate)
    .filter((rate): rate is number => rate !== undefined);
  const complete = rates.length === cone.phases.length && rates.length > 1;
  const best = complete ? Math.max(...rates) : null;
  const worst = complete ? Math.min(...rates) : null;
  const meaningful = best !== null && worst !== null && best - worst >= STANDING_GAP;

  return cone.phases.map((phase) => {
    const decisive = cone.decisive?.phase === phase.phase;
    const reading = decisive
      ? "This is where your games separate."
      : phase.growth >= 0.1
        ? "Your games drift apart here."
        : phase.growth <= -0.05
          ? "Your games come back together here."
          : "Your games hold their shape here.";

    const rate = byPhase.get(phase.phase) ?? null;
    const standing =
      meaningful && rate
        ? rate.rate === best
          ? "Your strongest phase"
          : rate.rate === worst
            ? "Your weakest phase"
            : null
        : null;

    return {
      phase: phase.phase,
      name: phase.name,
      from: phase.from,
      to: phase.to,
      accuracy: rate,
      standing,
      growth: phase.growth,
      reading,
      reachRate: phase.reachRate,
      games: phase.games,
      exit: `A quarter of them are below ${pct(phase.exit.p25)} and a quarter above ${pct(phase.exit.p75)} as it ends.`,
      scopeNote:
        rate && rate.gamesReaching !== phase.games
          ? `The rate counts every synced game that reached the ${phase.name}; the band is drawn from the ${phase.games.toLocaleString()} in the frozen set this report was published from.`
          : null,
      caution:
        phase.games < THIN_GAMES
          ? `Only ${phase.games} ${phase.games === 1 ? "game" : "games"} stand behind this, so read it as a first impression rather than a habit.`
          : null,
    };
  });
}

/**
 * The sentence the row of cards makes, when it makes one.
 *
 * Deliberately separate from `coneFinding`. The band says where the games are
 * decided and this says where the play is worst, and they are frequently
 * different phases — which is the most useful thing this row can tell somebody,
 * and only survives if the two are never merged into one figure.
 */
export function accuracyFinding(cards: readonly PhaseCard[]): string | null {
  const rated = cards.filter(
    (card): card is PhaseCard & { accuracy: PhaseAccuracy } => card.accuracy !== null,
  );
  if (rated.length !== cards.length || rated.length < 2) return null;

  const sorted = [...rated].sort((a, b) => a.accuracy.rate - b.accuracy.rate);
  const low = sorted[0]!;
  const high = sorted[sorted.length - 1]!;
  const gap = high.accuracy.rate - low.accuracy.rate;
  if (gap < STANDING_GAP) {
    return "You take your chances at much the same rate in every phase of the game.";
  }

  const chances = rated.reduce((sum, card) => sum + card.accuracy.chances, 0);
  return `You take ${pct(low.accuracy.rate)} of your chances in the ${low.name} and ${pct(high.accuracy.rate)} of them in the ${high.name}, a gap of ${pts(gap)} points over ${chances.toLocaleString()} graded chances.`;
}

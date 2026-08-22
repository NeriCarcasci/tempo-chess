import { heatOf, type CellHeat } from "./tearSheet";
import { smoothCurve } from "./curve";
import type { MoveNumberStat, Phase, PhaseColorStat, PlayerStats } from "./playerStats";

/**
 * The engine graph, per player: the derivations behind Today's one figure.
 *
 * Everything on the page hangs off a single axis, the player's own move number.
 * There is no second scale here and no second unit: a position is a position, a
 * cost is a cost, and every block below the figure is a partition of this
 * domain rather than a panel with an axis of its own.
 *
 * Two rules this file exists to enforce:
 *
 * 1. **Cost is the measure, not evaluation.** `avgLoss` pools honestly across
 *    games because a mistake costs the same whoever was winning. The median
 *    evaluation does not: only games still worth playing reach move 30, so the
 *    later columns are a survivorship sample. The eval field is drawn as a
 *    secondary register and the survival rail is drawn beside it, so the
 *    thinning is visible rather than asserted, and nothing on the page ever
 *    differences the evaluation into a claim.
 * 2. **Thin data is absent, never pale.** An intensity encodes a value, so a
 *    faded square reads as *low* rather than as *unknown*. Below the floors a
 *    column simply does not draw.
 */

/** The last move number that may become a column. */
export const MAX_DRAWN_MOVE = 40;

/*
 * The floors are a share of the player's own history, not a fixed count.
 *
 * They used to be flat: twenty five games before a column drew, thirty before
 * an evaluation did. On a large history that is about right. On the thirty one
 * game history most new players arrive with it is fatal, because a game is
 * over by move forty and only a fraction of any history reaches move twenty.
 * The figure stopped at move fourteen, which meant the one page that claims to
 * show a player *where in a game* their mistakes are drew the opening, half the
 * middlegame, and then stopped — on a player whose middlegame is the problem.
 *
 * A share fixes that without loosening the rule the floors exist to enforce.
 * Thin is still absent rather than pale; "thin" is now measured against the
 * history it is thin relative to.
 */

/** A column draws while this share of the player's games still reach it… */
const LANE_SHARE = 0.25;
/** …and never on fewer games than this, whatever the share works out at. */
const LANE_MIN = 8;
/**
 * An evaluation is a quartile, so it used to ask for more of the history than a
 * cost figure did, and to stop outright once half the games had ended.
 *
 * Both of those were the same gate written twice, and together they cut the
 * position off in the middlegame — the endgame register was drawn, labelled,
 * and empty. The survivorship they were guarding against is real, but it is
 * not a reason to withhold the figure: it is a fact about the figure, and this
 * page already draws that fact as its own register. The rail marked `n` *is*
 * the count of games still under the reading, so a reader can see the sample
 * thinning underneath the band rather than being told the band has stopped.
 *
 * So the position now runs as far as the cost lane does, on one floor, and the
 * rail carries the caveat. Below the floor it still does not draw at all.
 */
const EVAL_SHARE = LANE_SHARE;
const EVAL_MIN = LANE_MIN;
/** And: the share of the player's games still going at that move number. */
export const EVAL_SURVIVAL = LANE_SHARE;

/** Games that must reach a move number before its cost is drawn. */
export function laneFloorOf(cohort: number): number {
  return Math.max(LANE_MIN, Math.round(cohort * LANE_SHARE));
}

/** Games that must reach a move number before its position is drawn. */
export function evalFloorOf(cohort: number): number {
  return Math.max(EVAL_MIN, Math.round(cohort * EVAL_SHARE));
}
/** Move numbers in the headline window. Three is a plan, not a point. */
export const WINDOW = 3;
/** A window must cost this multiple of the player's own baseline. */
const WINDOW_LIFT = 1.25;
/** And this many centipawns more, absolutely. Both gates, always. */
const WINDOW_LIFT_CP = 8;
/** Columns drawn under 768px, unless the headline window reaches further. */
export const MOBILE_MAX_MOVE = 20;

export interface GraphColumn {
  moveNumber: number;
  /** Player moves here, which is also the analysed games that reached it. */
  moves: number;
  /** Share of the player's games still going, 0..1. */
  survival: number;
  avgLoss: number;
  /** Moves here that cost 90 centipawns or more. */
  errors: number;
  errorRate: number;
  /** The openings page's own ramp, so both pages read one scale. */
  heat: CellHeat | undefined;
  blunders: number;
  mistakes: number;
  inaccuracies: number;
  dominantPhase: Phase;
  medianEval: number;
  p25Eval: number;
  p75Eval: number;
  /** Whether the cohort is still thick enough to draw a position here. */
  drawEval: boolean;
}

export interface CostWindow {
  from: number;
  to: number;
  moves: number;
  avgLoss: number;
  errors: number;
}

export interface PhaseRun {
  phase: Phase;
  from: number;
  to: number;
}

export interface PlayerGraph {
  /** Drawn columns only. Truncate here, once, so nothing downstream disagrees. */
  columns: GraphColumn[];
  /** The player's games, taken as the largest column: move 1 may be absent. */
  cohort: number;
  /** Every analysed move, including those past the drawn axis. */
  totalMoves: number;
  /** Move-weighted centipawn loss across everything, the page's baseline. */
  pooledLoss: number;
  /** The last move number carrying a drawn evaluation, or null. */
  evalEndsAt: number | null;
  /**
   * Which gate actually stopped the evaluation, so the figure can name the real
   * constraint. Saying "fewer than half your games are still going" when the
   * binding limit was the sample floor is a false reason attached to a true
   * fact, which is worse than no reason at all.
   */
  evalStopReason: "sample" | "survival" | null;
  window: CostWindow | null;
  phaseRuns: PhaseRun[];
  /** True when a drawn quartile hit the engine's own ±1000 saturation. */
  saturated: boolean;
  /** The floors this history actually resolved to, so the figure can say them. */
  laneFloor: number;
  evalFloor: number;
}

const errorsOf = (move: MoveNumberStat) =>
  move.blunders + move.mistakes + move.inaccuracies;

/**
 * Centipawn loss averaged over moves, the product's one acpl derivation.
 *
 * Averaging per-game means instead would let a twelve-move loss weigh as much
 * as an eighty-move grind, and the result could not be reconciled with the
 * numbers beside it. Weighting by moves makes a total the sum of its parts,
 * which is the only version a reader can check.
 */
export function moveWeightedAcpl(
  rows: ReadonlyArray<{ acpl: number; moves: number }>,
): number | null {
  let moves = 0;
  let loss = 0;
  for (const row of rows) {
    if (!row.moves) continue;
    moves += row.moves;
    loss += row.acpl * row.moves;
  }
  return moves ? Math.round(loss / moves) : null;
}

/** One side's move-weighted cost, from the per-colour phase rows. */
export function colorAcpl(
  rows: readonly PhaseColorStat[],
  color: "white" | "black",
): number | null {
  return moveWeightedAcpl(rows.filter((row) => row.color === color));
}

/**
 * The stretch of the game that costs the most, or nothing.
 *
 * The gate matters more than the search. Taking the maximum of roughly forty
 * overlapping windows finds a peak on every player, including one for whom
 * nothing happened, because the largest of many draws is large by
 * construction. A window has to beat the player's own baseline by a quarter
 * *and* by eight centipawns before it is allowed to be a headline. When
 * nothing clears it the page says something else, which is a real outcome
 * rather than a failure.
 */
export function costWindow(
  columns: readonly GraphColumn[],
  pooledLoss: number,
): CostWindow | null {
  let best: CostWindow | null = null;
  for (let i = 0; i + WINDOW <= columns.length; i++) {
    const run = columns.slice(i, i + WINDOW);
    // Consecutive move numbers only; a gap means the window spans a hole.
    if (run[WINDOW - 1]!.moveNumber - run[0]!.moveNumber !== WINDOW - 1) continue;
    const moves = run.reduce((sum, column) => sum + column.moves, 0);
    if (!moves) continue;
    const avgLoss = Math.round(
      run.reduce((sum, column) => sum + column.avgLoss * column.moves, 0) / moves,
    );
    if (avgLoss < pooledLoss * WINDOW_LIFT) continue;
    if (avgLoss - pooledLoss < WINDOW_LIFT_CP) continue;
    // Ties go to the earlier window: the same cost sooner is the bigger problem.
    if (!best || avgLoss > best.avgLoss) {
      best = {
        from: run[0]!.moveNumber,
        to: run[WINDOW - 1]!.moveNumber,
        moves,
        avgLoss,
        errors: run.reduce((sum, column) => sum + column.errors, 0),
      };
    }
  }
  return best;
}

/** Maximal runs of adjacent columns sharing a phase. Derived, never typed. */
function phaseRunsOf(columns: readonly GraphColumn[]): PhaseRun[] {
  const runs: PhaseRun[] = [];
  for (const column of columns) {
    const last = runs[runs.length - 1];
    if (last && last.phase === column.dominantPhase) last.to = column.moveNumber;
    else runs.push({ phase: column.dominantPhase, from: column.moveNumber, to: column.moveNumber });
  }
  return runs;
}

/**
 * Build the figure.
 *
 * `maxMove` truncates once, here, because the readout, the survival rail, the
 * phase runs and the phase table's share bars all read from `columns`. A
 * second truncation downstream is how the share bars end up pointing at
 * columns that are not on screen.
 */
export function buildGraph(stats: PlayerStats, maxMove = MAX_DRAWN_MOVE): PlayerGraph {
  const all = stats.moves;
  const cohort = all.reduce((max, move) => Math.max(max, move.moves), 0);
  const pooled = moveWeightedAcpl(
    all.map((move) => ({ acpl: move.avgLoss, moves: move.moves })),
  ) ?? 0;

  const laneFloor = laneFloorOf(cohort);
  const evalFloor = evalFloorOf(cohort);

  const columns: GraphColumn[] = all
    .filter((move) => move.moveNumber <= maxMove && move.moves >= laneFloor)
    .map((move) => {
      const errors = errorsOf(move);
      const survival = cohort ? move.moves / cohort : 0;
      return {
        moveNumber: move.moveNumber,
        moves: move.moves,
        survival,
        avgLoss: move.avgLoss,
        errors,
        errorRate: move.moves ? errors / move.moves : 0,
        heat: heatOf(move.moves, errors),
        blunders: move.blunders,
        mistakes: move.mistakes,
        inaccuracies: move.inaccuracies,
        dominantPhase: move.dominantPhase,
        medianEval: move.medianEval,
        p25Eval: move.p25Eval,
        p75Eval: move.p75Eval,
        drawEval: move.evalSamples >= evalFloor && survival >= EVAL_SURVIVAL,
      };
    });

  // The evaluation runs from the first drawn column until the cohort thins, and
  // then stops. It never resumes: a later column with a big enough sample would
  // draw a second, disconnected fragment claiming to be the same line.
  let evalEndsAt: number | null = null;
  let evalStopReason: PlayerGraph["evalStopReason"] = null;
  for (const column of columns) {
    if (!column.drawEval) {
      // Report the gate that actually bound, checking the sample first because
      // that is the one that fires on a short history.
      const source = all.find((move) => move.moveNumber === column.moveNumber);
      evalStopReason =
        (source?.evalSamples ?? 0) < evalFloor ? "sample" : "survival";
      break;
    }
    evalEndsAt = column.moveNumber;
  }

  const drawnEval = columns.filter(
    (column) => column.drawEval && column.moveNumber <= (evalEndsAt ?? 0),
  );

  return {
    columns,
    cohort,
    totalMoves: stats.totalMoves,
    pooledLoss: pooled,
    evalEndsAt,
    evalStopReason,
    window: costWindow(columns, pooled),
    phaseRuns: phaseRunsOf(columns),
    saturated: drawnEval.some(
      (column) => Math.abs(column.p25Eval) >= 990 || Math.abs(column.p75Eval) >= 990,
    ),
    laneFloor,
    evalFloor,
  };
}

/**
 * Centipawns to a signed share of the win, −1 to 1.
 *
 * The y-axis is not linear in centipawns, and it should not be. A quarter of a
 * player's games at move 24 stand past five pawns, so a linear axis wide enough
 * to hold the band leaves everything between −1 and +1 in a sliver — and that
 * sliver is the entire range a player can still do something about. This is the
 * standard logistic between an evaluation and a result, so equal distance on
 * the axis means equal difference to the outcome, which is what the reader is
 * actually looking for. The readout stays in pawns; only the geometry changes.
 */
const WIN_K = 0.00368208;
export function winShare(cp: number): number {
  return 2 / (1 + Math.exp(-WIN_K * cp)) - 1;
}

/** A position in pawns, the way every board a player has seen writes it. */
export function pawns(cp: number): string {
  return (Math.abs(cp) / 100).toFixed(2);
}

/** Signed, with a real minus sign rather than a hyphen. */
export function signedPawns(cp: number): string {
  if (cp === 0) return "0.00";
  return `${cp > 0 ? "+" : "−"}${pawns(cp)}`;
}

/** "1 in 6", the shape a player can check against the counts beside it. */
export function oneIn(rate: number): string | null {
  if (rate <= 0) return null;
  return `1 in ${Math.max(2, Math.round(1 / rate))}`;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * What a reading says, in the two shapes the page needs it in.
 *
 * There is still one source. The readout above the figure was a paragraph of
 * four sentences that took three lines and pushed the picture down the page,
 * and the reader has to re-read it every time the pointer moves. So the same
 * reading is now built once as `scope` plus a handful of short figures, set as
 * one line, and joined back into `sentence` for the accessible label. The
 * picture and its description still cannot disagree, because neither is
 * written twice.
 */
export interface Reading {
  /** What the reading is of. The one thing set in ink. */
  scope: string;
  /** Short enough that all of them fit on one line beside the scope. */
  figures: string[];
  /** The same reading as prose, for anything that needs a sentence. */
  sentence: string;
}

function reading(scope: string, figures: string[], tail?: string): Reading {
  return {
    scope,
    figures,
    sentence: `${scope}. ${figures.join(". ")}.${tail ? ` ${tail}` : ""}`,
  };
}

/** The one thing a column is allowed to say. */
export function readMove(column: GraphColumn, cohort: number): Reading {
  const rate = oneIn(column.errorRate);
  const figures = [
    `${column.moves}/${cohort} games`,
    `${column.avgLoss} cp a move`,
    column.errors > 0 && rate ? `${rate} cost 90+` : "nothing cost 90+",
  ];
  if (column.drawEval) {
    figures.push(
      `${signedPawns(column.medianEval)} (${signedPawns(column.p25Eval)} to ${signedPawns(column.p75Eval)})`,
    );
  }
  const breakdown =
    column.errors > 0
      ? `${column.blunders} ${plural(column.blunders, "blunder", "blunders")}, ${column.mistakes} ${plural(column.mistakes, "mistake", "mistakes")}, ${column.inaccuracies} ${plural(column.inaccuracies, "inaccuracy", "inaccuracies")}.`
      : undefined;
  return reading(`Move ${column.moveNumber}, ${column.dominantPhase}`, figures, breakdown);
}

/** The same contract, for the run of columns the heading names. */
export function readWindow(window: CostWindow): Reading {
  const rate = oneIn(window.moves ? window.errors / window.moves : 0);
  return reading(`Moves ${window.from} to ${window.to}`, [
    `${window.avgLoss} cp a move`,
    `${window.moves} of your moves`,
    rate && window.errors > 0 ? `${rate} cost 90+` : "nothing cost 90+",
  ]);
}

/** And for the whole history, which is what the figure says at rest. */
export function readAll(graph: PlayerGraph): Reading {
  return reading("Every analysed move", [
    `${graph.pooledLoss} cp a move`,
    `${graph.totalMoves.toLocaleString()} of your moves`,
    `${graph.cohort} games`,
  ]);
}

/** The figure's smoothing, from the one module that owns it. */
export { smoothCurve as smoothPath } from "./curve";

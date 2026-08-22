import { api, apiMaybe } from "./api";

/**
 * Player-wide statistics, mirroring `server/src/players/stats.ts`.
 *
 * Every figure here is counted from the player's own analysed moves. Nothing is
 * modelled or estimated, so a field with no data underneath arrives as `null`
 * or an empty array rather than a zero pretending to be a measurement. A
 * component that cannot state where a number came from does not render it.
 *
 * Derivations live in `todayGraph.ts`. This file is types, fetchers, and the
 * two readings that are about phases rather than about the move axis.
 */

export type Phase = "opening" | "middlegame" | "endgame";

export interface MoveNumberStat {
  moveNumber: number;
  /**
   * Engine-scored player moves pooled at this move number, which is also the
   * number of analysed games that reached it: the table holds one row per move
   * per game. That is what makes the survival rail a count rather than a guess.
   */
  moves: number;
  /** How many of those carry an evaluation: the sample behind the percentiles. */
  evalSamples: number;
  /** Mean centipawns lost per move here. This is the honest pooled measure. */
  avgLoss: number;
  blunders: number;
  mistakes: number;
  inaccuracies: number;
  dominantPhase: Phase;
  /**
   * Evaluation after the player's move, player's perspective, centipawns.
   *
   * Do not draw this as "the engine graph for a player" and do not difference
   * it. Only games still worth playing reach the later move numbers, so these
   * columns are a survivorship sample whose spread widens as the sample
   * shrinks. Use `avgLoss` for any claim about the player.
   */
  medianEval: number;
  p25Eval: number;
  p75Eval: number;
}

export interface PhaseStat {
  phase: Phase;
  moves: number;
  acpl: number;
  blunders: number;
  mistakes: number;
  inaccuracies: number;
}

export interface PhaseColorStat extends PhaseStat {
  color: "white" | "black";
}

export interface MonthStat {
  month: string;
  games: number;
  acpl: number | null;
  accuracy: number | null;
}

export interface ColorRecord {
  games: number;
  win: number;
  loss: number;
  draw: number;
}

export interface PlayerStats {
  generatedAt: string;
  /** Every analysed move, including those past the graph's cap. */
  totalMoves: number;
  games: {
    total: number;
    analyzed: number;
    win: number;
    loss: number;
    draw: number;
    byColor: { white: ColorRecord; black: ColorRecord };
  };
  /**
   * Per-game figures. `acpl` here averages over *games*, so a twelve-move loss
   * weighs as much as an eighty-move grind, and it does not reconcile with the
   * move-weighted numbers elsewhere. Today renders `accuracy` once, in a
   * sentence that states the weighting, and never renders this `acpl`.
   */
  quality: {
    acpl: number | null;
    accuracy: number | null;
    byColor: {
      white: { games: number; acpl: number | null; accuracy: number | null };
      black: { games: number; acpl: number | null; accuracy: number | null };
    };
  };
  severity: {
    blunders: number;
    mistakes: number;
    inaccuracies: number;
    blundersPerGame: number | null;
  };
  moves: MoveNumberStat[];
  phases: PhaseStat[];
  phasesByColor: PhaseColorStat[];
  months: MonthStat[];
}

export function fetchPlayerStats(username: string): Promise<PlayerStats> {
  return api<PlayerStats>(`/players/${encodeURIComponent(username)}/stats`);
}

/** Degrades to null: statistics are the page's subject, but never its gate. */
export function fetchPlayerStatsMaybe(username: string): Promise<PlayerStats | null> {
  return apiMaybe<PlayerStats>(`/players/${encodeURIComponent(username)}/stats`);
}

/** Moves a phase needs before it is a reading rather than a rumour. */
export const PHASE_MOVE_FLOOR = 40;

export const PHASE_LABEL: Record<Phase, string> = {
  opening: "opening",
  middlegame: "middlegame",
  endgame: "endgame",
};

/** Phases with enough moves to compare, worst first. */
export function scoredPhases(stats: PlayerStats): PhaseStat[] {
  return stats.phases
    .filter((phase) => phase.moves >= PHASE_MOVE_FLOOR)
    .sort((a, b) => b.acpl - a.acpl);
}

export function worstPhase(stats: PlayerStats): PhaseStat | null {
  return scoredPhases(stats)[0] ?? null;
}

export function bestPhase(stats: PlayerStats): PhaseStat | null {
  const scored = scoredPhases(stats);
  return scored.length > 1 ? scored[scored.length - 1]! : null;
}

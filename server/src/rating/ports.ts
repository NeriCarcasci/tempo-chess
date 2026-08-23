/**
 * What the rating needs from the outside world, and what one is allowed to cost.
 *
 * Two ports and a budget, in their own module so both the in-process assembler
 * and the workflow phases can depend on them without depending on each other.
 *
 * The ports are deliberately narrow. Neither mentions Stockfish or Maia, and
 * neither carries a depth, a node count or a model version: those are decided
 * by whoever implements the port, because a rating that let its caller choose a
 * search depth would be a number nobody could compare to another one.
 */

/** One line of a search, valued from White's perspective after the move. */
export interface EngineLine {
  uci: string;
  expectedScoreWhite: number;
}

export interface EnginePort {
  /**
   * Evaluate one position, retaining `multipv` lines.
   *
   * Returning fewer lines than asked is allowed and meaningful: it is what a
   * position with three legal moves looks like, and the caller treats a
   * single-line answer as a search that never examined an alternative.
   */
  evaluate(input: { fen: string; multipv: number }): Promise<readonly EngineLine[]>;
}

export interface PolicyPort {
  policy(input: { fen: string; rating: number }): Promise<import("../models/policy.js").PolicyDistribution>;
}

/**
 * What one rating is allowed to cost.
 *
 * Named and versioned rather than passed in ad hoc, because the budget changes
 * what the rating can claim: a game given four MultiPV positions has less
 * measured demand than the same game given twelve, and two ratings produced
 * under different budgets are not comparable. `deepPositions` matches the
 * pipeline's own cap so a game rated here and a game rated there are.
 *
 * `plyPolicyLimit` is thirty rather than the sixty it started at, and rather
 * than the twelve to twenty that would be cheaper. Thirty is set from the floor
 * underneath it: `STRENGTH_POLICY.minimumDecisions` is eight per side, so a
 * budget of twenty plies leaves ten a side before book moves and forced
 * recaptures are excluded and can fall under the floor, and a budget so tight
 * that it produces "no rating" is worse than a slower one.
 */
export const ANALYSIS_BUDGET = {
  version: "2",
  deepPositions: 12,
  deepMultipv: 3,
  plyPolicyLimit: 30,
  /** Longer than this and the game is truncated rather than refused. */
  maxPlies: 300,
} as const;

export type AnalysisBudget = typeof ANALYSIS_BUDGET;

/**
 * How hard the objective engine looks, for the public path.
 *
 * Depth rather than nodes because that is what `analyzeFens` accepts. Stated
 * here rather than passed in so two public ratings are comparable: a rating
 * produced at depth 10 and one at depth 18 are answers to different questions,
 * and the number does not carry the depth with it.
 */
export const PUBLIC_SEARCH = {
  version: "1",
  screeningDepth: 12,
  deepDepth: 16,
} as const;

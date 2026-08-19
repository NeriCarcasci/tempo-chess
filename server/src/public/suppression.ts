/**
 * Small-cell suppression for public statistics.
 *
 * §3 of the API contract says the public statistic carries "no exact small-cell
 * counts". The naive reading of that is "hide cells under ten", which is not
 * enough: publish a total and every cell but one, and the hidden cell is a
 * subtraction away. This module does the arithmetic that makes the rule mean
 * what it says.
 *
 * It matters most in exactly the situation a young product is in. A breakdown
 * that reads "lichess 4, chess.com 1" is not a statistic, it is five people.
 */

import { SMALL_CELL_THRESHOLD } from "./contract.js";

/**
 * A published figure, which is either the number or an honest refusal.
 *
 * Deliberately not `number | null`: a null in a public body reads as "we do not
 * know", and a suppressed cell is something we know perfectly well and have
 * decided not to say. The client renders "fewer than 10", and the difference is
 * the difference between looking broken and looking careful.
 */
export type PublicFigure =
  | { readonly disclosure: "exact"; readonly value: number }
  | { readonly disclosure: "suppressed"; readonly below: number };

export interface Cell {
  readonly key: string;
  readonly count: number;
}

export interface PublishedCell {
  readonly key: string;
  readonly figure: PublicFigure;
}

export interface SuppressionResult {
  readonly cells: readonly PublishedCell[];
  readonly total: PublicFigure;
  /** Keys withheld, for the response's redaction block and for the log. */
  readonly suppressedKeys: readonly string[];
}

/**
 * A single figure with no siblings to compare it against.
 *
 * Zero is published. It names nobody, and suppressing it would make an empty
 * environment indistinguishable from a busy one we are being coy about.
 */
export function publicFigure(count: number, threshold = SMALL_CELL_THRESHOLD): PublicFigure {
  if (!Number.isFinite(count) || count < 0) {
    throw new Error("a public figure must be a non-negative count");
  }
  const value = Math.floor(count);
  if (value === 0 || value >= threshold) return { disclosure: "exact", value };
  return { disclosure: "suppressed", below: threshold };
}

/**
 * Suppress a segmented statistic, then suppress enough of the rest that the
 * first suppression cannot be undone.
 *
 * Three rules, in order:
 *
 *  1. Primary. Any cell strictly between zero and the threshold is withheld.
 *  2. Complementary. If exactly one cell is withheld and the total is
 *     published, that cell is `total - the rest`. So a second cell goes too:
 *     the smallest published one, preferring a non-zero cell, because
 *     withholding a zero hides nothing.
 *  3. Last resort. If the breakdown has collapsed to a single withheld cell
 *     with nothing to hide behind, the total is withheld as well. Publishing it
 *     would be publishing the cell.
 */
export function suppressSmallCells(
  cells: readonly Cell[],
  threshold = SMALL_CELL_THRESHOLD,
): SuppressionResult {
  const working = cells.map((cell) => ({
    key: cell.key,
    count: Math.max(0, Math.floor(cell.count)),
    suppressed: false,
  }));

  for (const cell of working) {
    if (cell.count > 0 && cell.count < threshold) cell.suppressed = true;
  }

  const total = working.reduce((sum, cell) => sum + cell.count, 0);
  const suppressedCount = () => working.filter((cell) => cell.suppressed).length;

  // Rule 2. One withheld cell in a published total is not withheld at all.
  if (suppressedCount() === 1) {
    const candidates = working.filter((cell) => !cell.suppressed);
    const nonZero = candidates.filter((cell) => cell.count > 0);
    const pool = nonZero.length > 0 ? nonZero : candidates;
    const complement = pool.reduce<(typeof working)[number] | null>(
      (smallest, cell) => (smallest === null || cell.count < smallest.count ? cell : smallest),
      null,
    );
    if (complement) complement.suppressed = true;
  }

  // Rule 3. Nothing left to hide behind.
  const withheld = working.filter((cell) => cell.suppressed);
  // After rule 2 a lone withheld cell means there was nothing to complement it
  // with: one cell, withheld, and a total that would spell it out.
  const totalIsRecoverable = withheld.length === 1;

  return {
    cells: working.map((cell) => ({
      key: cell.key,
      figure: cell.suppressed
        ? ({ disclosure: "suppressed", below: threshold } as const)
        : ({ disclosure: "exact", value: cell.count } as const),
    })),
    total: totalIsRecoverable
      ? { disclosure: "suppressed", below: threshold }
      : publicFigure(total, threshold),
    suppressedKeys: withheld.map((cell) => cell.key),
  };
}

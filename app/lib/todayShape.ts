import type { SheetCell, TearSheet } from "./tearSheet";

/**
 * The shape of a player's opening mistakes: how many land on each of their own
 * move numbers, pooled across every line they play.
 *
 * This is the product's own idea drawn as a picture. A player already knows
 * they make mistakes; what no site tells them is *where in a game* the
 * mistakes are, and that is a distribution rather than a number. It is also
 * the one thing on the home page that can be read at a glance and still be
 * worth reading, which is why it gets the page rather than a stat row.
 *
 * Both colours are pooled on purpose. "Where in a game do my mistakes fall" is
 * a question about move numbers, not sides, and `moveNoOf` already reads the
 * mover off ply parity.
 */

export interface ShapeBar {
  moveNo: number;
  mistakes: number;
  moves: number;
}

export interface OpeningShape {
  bars: ShapeBar[];
  /** Every opening mistake we can attribute to a move number. */
  total: number;
  /** The tightest three-move window, and what share of the total lands in it. */
  peak: { from: number; to: number; mistakes: number } | null;
}

/** Moves in the window the peak is measured over. Three is a plan, not a point. */
const WINDOW = 3;

export function openingShape(sheet: TearSheet): OpeningShape {
  const pooled = new Map<number, { mistakes: number; moves: number }>();
  for (const section of sheet.sections) {
    for (const row of section.rows) {
      for (const cell of row.cells) {
        const at = pooled.get(cell.moveNo) ?? { mistakes: 0, moves: 0 };
        at.mistakes += cell.failures;
        at.moves += cell.decisions;
        pooled.set(cell.moveNo, at);
      }
    }
  }

  const bars: ShapeBar[] = [];
  for (let moveNo = 1; moveNo <= sheet.maxMove; moveNo++) {
    const at = pooled.get(moveNo) ?? { mistakes: 0, moves: 0 };
    bars.push({ moveNo, mistakes: at.mistakes, moves: at.moves });
  }

  const total = bars.reduce((n, bar) => n + bar.mistakes, 0);

  /**
   * The busiest run of three consecutive moves, not the single tallest bar.
   * A player cannot act on "move 11"; they can act on "the moves either side
   * of where your book runs out", and a window is the honest way to say that.
   */
  let peak: OpeningShape["peak"] = null;
  if (total > 0 && bars.length >= WINDOW) {
    for (let i = 0; i + WINDOW <= bars.length; i++) {
      const slice = bars.slice(i, i + WINDOW);
      const mistakes = slice.reduce((n, bar) => n + bar.mistakes, 0);
      if (!peak || mistakes > peak.mistakes) {
        peak = { from: slice[0]!.moveNo, to: slice[WINDOW - 1]!.moveNo, mistakes };
      }
    }
  }

  return { bars, total, peak };
}

/** Cells for a line strip, kept so callers do not reach into the sheet twice. */
export type { SheetCell };

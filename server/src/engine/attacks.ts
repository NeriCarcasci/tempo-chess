import {
  bishopAttacks,
  rookAttacks,
  knightAttacks,
  kingAttacks,
  pawnAttacks,
} from "chessops/attacks";
import type { SquareSet } from "chessops/squareSet";
import type { Board } from "chessops/board";
import type { Color, Square, Role } from "chessops/types";

/** Centipawn material values used for exchange evaluation. */
export const PIECE_VALUES: Record<Role, number> = {
  pawn: 100,
  knight: 320,
  bishop: 330,
  rook: 500,
  queen: 900,
  king: 20000,
};

const opposite = (c: Color): Color => (c === "white" ? "black" : "white");

/**
 * All pieces (either color) that attack `square`, given an `occupied` mask
 * (which may differ from the board's, so slider x-rays resolve during SEE).
 */
export function attackersTo(
  board: Board,
  square: Square,
  occupied: SquareSet,
): SquareSet {
  const bishopsQueens = board.bishop.union(board.queen);
  const rooksQueens = board.rook.union(board.queen);
  return kingAttacks(square)
    .intersect(board.king)
    .union(knightAttacks(square).intersect(board.knight))
    .union(bishopAttacks(square, occupied).intersect(bishopsQueens))
    .union(rookAttacks(square, occupied).intersect(rooksQueens))
    // white pawns attacking `square` sit where a black pawn on `square` would attack
    .union(pawnAttacks("black", square).intersect(board.pawn).intersect(board.white))
    .union(pawnAttacks("white", square).intersect(board.pawn).intersect(board.black));
}

function leastValuableAttacker(
  board: Board,
  attackers: SquareSet,
): Square | undefined {
  let best: Square | undefined;
  let bestValue = Infinity;
  for (const sq of attackers) {
    const piece = board.get(sq);
    if (!piece) continue;
    const value = PIECE_VALUES[piece.role];
    if (value < bestValue) {
      bestValue = value;
      best = sq;
    }
  }
  return best;
}

/**
 * Static Exchange Evaluation: the material swing (centipawns, from the moving
 * side's perspective) of initiating a capture `from` → `to` and letting both
 * sides recapture optimally with their least-valuable attacker. Negative means
 * the capture loses material. Also works to test whether a piece is "hanging".
 */
export function see(board: Board, to: Square, from: Square): number {
  const attacker = board.get(from);
  if (!attacker) return 0;
  const captured = board.get(to);

  const gain: number[] = [];
  gain[0] = captured ? PIECE_VALUES[captured.role] : 0;

  let occupied = board.occupied.without(from);
  let onSquareValue = PIECE_VALUES[attacker.role]; // value of piece now on `to`
  let side: Color = opposite(attacker.color);
  let depth = 0;

  for (;;) {
    depth++;
    gain[depth] = onSquareValue - gain[depth - 1];

    const sideMask = side === "white" ? board.white : board.black;
    const attackers = attackersTo(board, to, occupied)
      .intersect(occupied)
      .intersect(sideMask);
    const next = leastValuableAttacker(board, attackers);
    if (next === undefined) break;

    onSquareValue = PIECE_VALUES[board.get(next)!.role];
    occupied = occupied.without(next);
    side = opposite(side);
  }

  // Negamax fold back: each side stops capturing if the exchange turns bad.
  while (--depth > 0) {
    gain[depth - 1] = -Math.max(-gain[depth - 1], gain[depth]);
  }
  return gain[0];
}

// Tactical "reason per move", built on Static Exchange Evaluation — the same
// idea as ChessDroid's motif detector. Runs in the browser (chessops is
// isomorphic) on any judged move that has a best-move suggestion.

import { parseFen } from "chessops/fen";
import { parseUci, makeSquare } from "chessops/util";
import { makeSan } from "chessops/san";
import { Chess } from "chessops/chess";
import {
  attacks,
  bishopAttacks,
  rookAttacks,
  knightAttacks,
  kingAttacks,
  pawnAttacks,
} from "chessops/attacks";
import type { Board } from "chessops/board";
import type { SquareSet } from "chessops/squareSet";
import type { Square, Color, Role } from "chessops/types";

const VALUES: Record<Role, number> = {
  pawn: 100,
  knight: 320,
  bishop: 330,
  rook: 500,
  queen: 900,
  king: 20000,
};
const NAME: Record<Role, string> = {
  pawn: "pawn",
  knight: "knight",
  bishop: "bishop",
  rook: "rook",
  queen: "queen",
  king: "king",
};
const opposite = (c: Color): Color => (c === "white" ? "black" : "white");

function attackersTo(board: Board, square: Square, occupied: SquareSet): SquareSet {
  const bishopsQueens = board.bishop.union(board.queen);
  const rooksQueens = board.rook.union(board.queen);
  return kingAttacks(square)
    .intersect(board.king)
    .union(knightAttacks(square).intersect(board.knight))
    .union(bishopAttacks(square, occupied).intersect(bishopsQueens))
    .union(rookAttacks(square, occupied).intersect(rooksQueens))
    .union(pawnAttacks("black", square).intersect(board.pawn).intersect(board.white))
    .union(pawnAttacks("white", square).intersect(board.pawn).intersect(board.black));
}

function leastValuable(board: Board, attackers: SquareSet): Square | undefined {
  let best: Square | undefined;
  let bestValue = Infinity;
  for (const sq of attackers) {
    const piece = board.get(sq);
    if (!piece) continue;
    if (VALUES[piece.role] < bestValue) {
      bestValue = VALUES[piece.role];
      best = sq;
    }
  }
  return best;
}

function see(board: Board, to: Square, from: Square): number {
  const attacker = board.get(from);
  if (!attacker) return 0;
  const captured = board.get(to);
  const gain: number[] = [captured ? VALUES[captured.role] : 0];
  let occupied = board.occupied.without(from);
  let onSquare = VALUES[attacker.role];
  let side: Color = opposite(attacker.color);
  let depth = 0;
  for (;;) {
    depth++;
    gain[depth] = onSquare - gain[depth - 1];
    const sideMask = side === "white" ? board.white : board.black;
    const attackers = attackersTo(board, to, occupied).intersect(occupied).intersect(sideMask);
    const next = leastValuable(board, attackers);
    if (next === undefined) break;
    onSquare = VALUES[board.get(next)!.role];
    occupied = occupied.without(next);
    side = opposite(side);
  }
  while (--depth > 0) gain[depth - 1] = -Math.max(-gain[depth - 1], gain[depth]);
  return gain[0];
}

/** The most material the side to move can win via a capture (SEE > 0). */
function bestWinnableCapture(pos: Chess): { to: Square; gain: number; role: Role } | null {
  const board = pos.board;
  const usMask = pos.turn === "white" ? board.white : board.black;
  const enemy = pos.turn === "white" ? board.black : board.white;
  let best: { to: Square; gain: number; role: Role } | null = null;
  for (const to of enemy) {
    const from = leastValuable(board, attackersTo(board, to, board.occupied).intersect(usMask));
    if (from === undefined) continue;
    const gain = see(board, to, from);
    if (gain > 0 && (!best || gain > best.gain)) {
      best = { to, gain, role: board.get(to)!.role };
    }
  }
  return best;
}

export interface MoveReason {
  motif: string;
  text: string;
}

/**
 * Explain why a move was a mistake using SEE. Detects the two highest-signal,
 * most reliable motifs: the move hangs material, or it missed a winning capture.
 * Returns null when no clear tactical motif is found (caller falls back).
 */
export function explainMove(
  fenBefore: string,
  playedUci?: string,
  bestUci?: string,
): MoveReason | null {
  if (!playedUci) return null;
  let posBefore: Chess;
  try {
    posBefore = Chess.fromSetup(parseFen(fenBefore).unwrap()).unwrap();
  } catch {
    return null;
  }
  const played = parseUci(playedUci);
  if (!played || !("from" in played)) return null;
  const mover = posBefore.turn;
  const enemyMask = (b: typeof posBefore.board) => (mover === "white" ? b.black : b.white);

  const afterPlayed = posBefore.clone();
  try {
    afterPlayed.play(played);
  } catch {
    return null;
  }

  const best = bestUci ? parseUci(bestUci) : undefined;
  const bestNormal = best && "from" in best ? best : undefined;

  // 1. Missed a forced mate (the engine's move is checkmate).
  if (bestNormal) {
    const afterBest = posBefore.clone();
    try {
      afterBest.play(bestNormal);
      if (afterBest.isCheckmate()) {
        return { motif: "missed_mate", text: `Missed mate with ${makeSan(posBefore, bestNormal)}.` };
      }
    } catch {
      /* ignore */
    }
  }

  // 2. The played move hangs material.
  const hang = bestWinnableCapture(afterPlayed);
  if (hang && hang.gain >= 200) {
    return { motif: "hanging", text: `This hangs the ${NAME[hang.role]} on ${makeSquare(hang.to)}.` };
  }

  // 3. Missed a fork — the engine's move attacks two valuable enemy pieces.
  if (bestNormal) {
    const afterBest = posBefore.clone();
    try {
      afterBest.play(bestNormal);
      const forker = afterBest.board.get(bestNormal.to);
      if (forker) {
        const enemy = enemyMask(afterBest.board);
        const hits = attacks(forker, bestNormal.to, afterBest.board.occupied).intersect(enemy);
        const targets: { role: Role; value: number }[] = [];
        for (const sq of hits) {
          const t = afterBest.board.get(sq);
          if (!t) continue;
          const defended = !attackersTo(afterBest.board, sq, afterBest.board.occupied)
            .intersect(enemy)
            .isEmpty();
          if (VALUES[t.role] > VALUES[forker.role] || !defended) {
            targets.push({ role: t.role, value: VALUES[t.role] });
          }
        }
        if (targets.length >= 2) {
          targets.sort((a, b) => b.value - a.value);
          return {
            motif: "fork",
            text: `${makeSan(posBefore, bestNormal)} forks the ${NAME[targets[0].role]} and ${NAME[targets[1].role]}.`,
          };
        }
      }
    } catch {
      /* ignore */
    }
  }

  // 4. Missed a winning capture.
  if (bestNormal) {
    const target = posBefore.board.get(bestNormal.to);
    if (target && see(posBefore.board, bestNormal.to, bestNormal.from) >= 150) {
      return { motif: "missed_material", text: `${makeSan(posBefore, bestNormal)} wins the ${NAME[target.role]}.` };
    }
  }
  return null;
}

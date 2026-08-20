/**
 * A game turned into frames a board can step through.
 *
 * The whole reason this is not just a list of FENs: **pieces carry an identity
 * from frame to frame**. Keyed by identity, a knight that moves is the same DOM
 * node in a new place and the browser can slide it there; keyed by square, it
 * vanishes from one cell and appears in another, which at three frames a second
 * reads as a board flickering rather than a game being played.
 *
 * Identity is recovered by diffing consecutive positions rather than by
 * following the move, because the diff handles castling, en passant and
 * captures with no special cases: two pieces of the same kind, one leaving a
 * square and one arriving, are the same piece. A promotion is the one case it
 * cannot match — a pawn leaves and a queen arrives — and a queen that fades in
 * where it stands is what a promotion looks like anyway.
 */

import { Chess } from "chess.js";
import type { RecentGame } from "../v1/games";

export interface ReplayPiece {
  /** Stable across frames. Use it as the React key. */
  id: string;
  /** Lower-case piece letter: k q r b n p. */
  letter: string;
  white: boolean;
  /** 0-63, a1 = 0, matching the rest of the app's square space. */
  square: number;
}

export interface ReplayFrame {
  pieces: ReplayPiece[];
  /** The move that produced this frame. Null on the opening position. */
  from: number | null;
  to: number | null;
}

/** Long games exist; a board that has to hold four of them does not need all of one. */
const MAX_PLIES = 160;

const nameToSquare = (name: string): number =>
  (Number(name[1]) - 1) * 8 + (name.charCodeAt(0) - 97);

/** A FEN's placement field as 64 cells: `"P"`, `"p"`, or null. */
function parsePlacement(placement: string): (string | null)[] {
  const squares: (string | null)[] = new Array(64).fill(null);
  const rows = placement.split("/");
  for (let row = 0; row < 8 && row < rows.length; row += 1) {
    const rank = 7 - row; // rows[0] is rank 8
    let file = 0;
    for (const character of rows[row]!) {
      if (character >= "1" && character <= "8") {
        file += Number(character);
        continue;
      }
      if (file > 7) break;
      squares[rank * 8 + file] = character;
      file += 1;
    }
  }
  return squares;
}

/** Chebyshev distance, so a castling rook is matched to the nearer rook square. */
const spread = (a: number, b: number): number =>
  Math.max(Math.abs((a % 8) - (b % 8)), Math.abs(Math.floor(a / 8) - Math.floor(b / 8)));

function withIdentity(
  placements: (string | null)[][],
  played: ({ from: number; to: number } | null)[],
): ReplayFrame[] {
  const frames: ReplayFrame[] = [];
  let ids: (string | null)[] = new Array(64).fill(null);
  let minted = 0;

  placements.forEach((squares, index) => {
    const previous = index === 0 ? null : placements[index - 1]!;
    const next: (string | null)[] = new Array(64).fill(null);
    const wanting: number[] = [];

    for (let square = 0; square < 64; square += 1) {
      if (squares[square] === null) continue;
      if (previous !== null && previous[square] === squares[square] && ids[square] !== null) {
        next[square] = ids[square];
      } else {
        wanting.push(square);
      }
    }

    // Squares a piece has just left, each still holding the id it had.
    const vacated: number[] = [];
    if (previous !== null) {
      for (let square = 0; square < 64; square += 1) {
        if (previous[square] === null) continue;
        if (previous[square] === squares[square]) continue;
        if (ids[square] !== null) vacated.push(square);
      }
    }

    for (const square of wanting) {
      const piece = squares[square]!;
      let best = -1;
      let closest = Infinity;
      for (const from of vacated) {
        if (previous![from] !== piece) continue;
        const distance = spread(from, square);
        // Nearest wins, so castling hands the king's id to the king and the
        // rook's to the rook instead of crossing the two over.
        if (distance < closest) {
          best = from;
          closest = distance;
        }
      }
      if (best === -1) {
        minted += 1;
        next[square] = `p${minted}`;
      } else {
        next[square] = ids[best];
        vacated.splice(vacated.indexOf(best), 1);
      }
    }

    const move = played[index] ?? null;
    frames.push({
      from: move?.from ?? null,
      to: move?.to ?? null,
      pieces: squares.flatMap((piece, square) =>
        piece === null
          ? []
          : [
              {
                id: next[square]!,
                letter: piece.toLowerCase(),
                white: piece === piece.toUpperCase(),
                square,
              },
            ],
      ),
    });
    ids = next;
  });

  return frames;
}

/**
 * Every position in a game, or an empty list if it cannot be replayed.
 *
 * Empty rather than partial for an unplayable start: a board showing one
 * motionless position in a row of moving ones reads as a board that has
 * crashed. A move the position rejects part-way through stops the replay there
 * instead, because everything up to it is still a true picture of the game.
 */
export function toFrames(game: RecentGame): ReplayFrame[] {
  let chess: Chess;
  try {
    chess = game.initialFen === null ? new Chess() : new Chess(game.initialFen);
  } catch {
    return [];
  }

  const placement = (): string => chess.fen().split(" ")[0]!;
  const placements: (string | null)[][] = [parsePlacement(placement())];
  const played: ({ from: number; to: number } | null)[] = [null];

  for (const move of game.moves.slice(0, MAX_PLIES)) {
    try {
      const result = chess.move({
        from: move.uci.slice(0, 2),
        to: move.uci.slice(2, 4),
        promotion: move.uci.length > 4 ? move.uci[4] : undefined,
      });
      placements.push(parsePlacement(placement()));
      played.push({ from: nameToSquare(result.from), to: nameToSquare(result.to) });
    } catch {
      break;
    }
  }

  if (placements.length < 2) return [];
  return withIdentity(placements, played);
}

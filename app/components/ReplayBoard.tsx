import { useEffect, useMemo, useState } from "react";
import { Chess } from "chess.js";
import { PieceGlyph } from "./PieceGlyph";

/**
 * The game, playing itself, while Forma works out what to say about it.
 *
 * A rating takes minutes the first time, and a spinner for that long is a page
 * asking somebody to trust it with nothing to look at. The game they just
 * pasted is the one thing on screen they already care about, so it plays.
 *
 * Deliberately not interactive and not the product's board: no evaluation, no
 * arrows, no judgement. Showing an assessment here would be showing an answer
 * before the analysis that produces it has finished, and the first number a
 * reader sees is the one they remember.
 *
 * Drawn with the marketing board's own classes (`hb-*`), so it inherits the
 * squares, the piece vectors and the shape scale rather than introducing a
 * second board style to the site.
 */

const FILES = "abcdefgh";

interface Placed {
  square: string;
  letter: string;
  white: boolean;
  col: number;
  row: number;
}

function parseBoard(fen: string): Placed[] {
  const out: Placed[] = [];
  const board = fen.split(" ")[0] ?? "";
  board.split("/").forEach((row, index) => {
    const rank = 8 - index;
    let file = 0;
    for (const character of row) {
      if (character >= "1" && character <= "8") {
        file += Number(character);
        continue;
      }
      out.push({
        square: `${FILES[file]!}${rank}`,
        letter: character.toLowerCase(),
        white: character === character.toUpperCase(),
        col: file,
        row: 8 - rank,
      });
      file += 1;
    }
  });
  return out;
}

/**
 * Merge comment blocks that sit next to each other.
 *
 * The same rule as `mergeAdjacentComments` on the server, and here for the same
 * reason: Chess.com and Lichess write a judged move as prose then annotations,
 * and chess.js treats the second brace as a syntax error. The server learned
 * this and the browser had not, so a real export rated fine and then showed no
 * board at all, because this threw and the component quietly rendered nothing.
 *
 * Deliberately duplicated rather than shared. The web app cannot import from
 * `server/`, and a six-line normaliser copied with a note is better than a
 * package invented to hold it.
 */
function mergeAdjacentComments(pgn: string): string {
  let merged = pgn;
  let previous: string;
  do {
    previous = merged;
    merged = merged.replace(/\}(\s*)\{/g, " ");
  } while (merged !== previous);
  return merged;
}

/** Every position the game passed through, or an empty list if it will not parse. */
function positionsOf(pgn: string): { fens: string[]; moves: string[] } {
  try {
    const chess = new Chess();
    chess.loadPgn(mergeAdjacentComments(pgn), { strict: false });
    const history = chess.history({ verbose: true });
    return {
      fens: [history[0]?.before ?? new Chess().fen(), ...history.map((move) => move.after)],
      moves: history.map((move) => move.san),
    };
  } catch {
    return { fens: [], moves: [] };
  }
}

export function ReplayBoard({
  pgn,
  stepMs = 900,
  /** Plays itself while something else is happening; still when it is not. */
  autoPlay = true,
  /** Jump here when it changes. Ignored while auto-playing. */
  jumpToPly,
}: {
  pgn: string;
  stepMs?: number;
  autoPlay?: boolean;
  jumpToPly?: number | null;
}) {
  const { fens, moves } = useMemo(() => positionsOf(pgn), [pgn]);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!autoPlay || fens.length < 2) return;
    // Plays through once and stops on the final position. It used to loop, on
    // the theory that a still board looks broken during a long wait; watching
    // the same game restart over and over is worse, and the progress beside it
    // is what says the page is alive.
    const timer = setInterval(() => {
      setIndex((current) => {
        if (current >= fens.length - 1) {
          clearInterval(timer);
          return current;
        }
        return current + 1;
      });
    }, stepMs);
    return () => clearInterval(timer);
  }, [autoPlay, fens.length, stepMs]);

  useEffect(() => {
    if (autoPlay || jumpToPly == null) return;
    setIndex(Math.max(0, Math.min(fens.length - 1, jumpToPly)));
  }, [autoPlay, jumpToPly, fens.length]);

  if (fens.length < 2) return null;

  const placed = parseBoard(fens[index] ?? fens[0]!);
  const moveNumber = Math.ceil(index / 2);
  const san = index > 0 ? moves[index - 1] : null;

  return (
    <figure className="rate-replay">
      <div className="hb-board">
        <div className="hb-grid" aria-hidden="true">
          {Array.from({ length: 64 }, (_, cell) => {
            const col = cell % 8;
            const row = Math.floor(cell / 8);
            return (
              <span key={cell} className={`hb-sq ${(col + row) % 2 === 1 ? "is-dark" : ""}`} />
            );
          })}
        </div>
        {placed.map((piece) => (
          <span
            key={piece.square}
            className="hb-slot"
            style={{ left: `${piece.col * 12.5}%`, top: `${piece.row * 12.5}%` }}
          >
            <PieceGlyph letter={piece.letter} white={piece.white} className="hb-piece" />
          </span>
        ))}
      </div>
      <figcaption className="rate-replay-move">
        {autoPlay ? null : (
          <button
            type="button"
            className="rate-step"
            onClick={() => setIndex((c) => Math.max(0, c - 1))}
            disabled={index === 0}
            aria-label="Previous move"
          >
            &lt;
          </button>
        )}
        <span>
          {san ? (
            <>
              {moveNumber}
              {index % 2 === 1 ? "." : "..."} {san}
            </>
          ) : (
            "Starting position"
          )}
        </span>
        {autoPlay ? null : (
          <button
            type="button"
            className="rate-step"
            onClick={() => setIndex((c) => Math.min(fens.length - 1, c + 1))}
            disabled={index === fens.length - 1}
            aria-label="Next move"
          >
            &gt;
          </button>
        )}
      </figcaption>
    </figure>
  );
}

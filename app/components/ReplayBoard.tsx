import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chess } from "chess.js";
import { Board } from "./Board";
import { Move } from "./Move";
import { loadBoardTheme } from "../lib/boardThemes";
import { loadPieceSet } from "../lib/pieceSets";

/**
 * The game, on the product's own board.
 *
 * This used to draw its own squares out of the marketing hero's classes, which
 * meant a visitor's first sight of a Forma board was a board Forma does not
 * ship: it ignored the board and piece set they had chosen, it had no last-move
 * highlight, no move list and no keyboard, and it drifted from the real thing
 * every time the real thing improved. It now mounts `Board`, reads the same
 * stored theme the review page reads, and lists moves with the same `Move`
 * glyphs. One board, one set of pieces, one place to improve them.
 *
 * Still no evaluation and no arrows. That restraint was right and is kept:
 * showing a judgement here would be answering before the analysis that produces
 * the answer has finished, and the first number a reader sees is the one they
 * remember.
 */

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

const sqIndex = (alg: string) => (Number(alg[1]) - 1) * 8 + (alg.charCodeAt(0) - 97);

function moveSquares(uci?: string): [number, number] | undefined {
  if (!uci || uci.length < 4) return undefined;
  return [sqIndex(uci.slice(0, 2)), sqIndex(uci.slice(2, 4))];
}

interface Position {
  fens: string[];
  moves: { san: string; uci: string; white: boolean }[];
}

/** Every position the game passed through, or an empty list if it will not parse. */
function positionsOf(pgn: string): Position {
  try {
    const chess = new Chess();
    chess.loadPgn(mergeAdjacentComments(pgn), { strict: false });
    const history = chess.history({ verbose: true });
    return {
      fens: [history[0]?.before ?? new Chess().fen(), ...history.map((move) => move.after)],
      moves: history.map((move) => ({
        san: move.san,
        uci: `${move.from}${move.to}${move.promotion ?? ""}`,
        white: move.color === "w",
      })),
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
  size,
}: {
  pgn: string;
  stepMs?: number;
  autoPlay?: boolean;
  jumpToPly?: number | null;
  size?: number;
}) {
  const { fens, moves } = useMemo(() => positionsOf(pgn), [pgn]);
  const [index, setIndex] = useState(0);
  const [flip, setFlip] = useState(false);
  // Read once, like the review page: a theme that changed mid-replay would
  // repaint the board under the reader for no reason they asked for.
  const [theme] = useState(() => loadBoardTheme());
  const [pieceSet] = useState(() => loadPieceSet());
  const listRef = useRef<HTMLOListElement>(null);

  const last = fens.length - 1;
  const goto = useCallback(
    (next: number) => setIndex(Math.max(0, Math.min(last, next))),
    [last],
  );

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
    goto(jumpToPly);
  }, [autoPlay, jumpToPly, goto]);

  // Arrow keys, because every other board a chess player has used has them.
  useEffect(() => {
    if (autoPlay) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      if (event.key === "ArrowLeft") { event.preventDefault(); goto(index - 1); }
      else if (event.key === "ArrowRight") { event.preventDefault(); goto(index + 1); }
      else if (event.key === "Home") { event.preventDefault(); goto(0); }
      else if (event.key === "End") { event.preventDefault(); goto(last); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [autoPlay, goto, index, last]);

  // Keep the move being shown inside the scrolling list.
  useEffect(() => {
    if (autoPlay || index === 0) return;
    listRef.current
      ?.querySelector(`[data-ply="${index}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [autoPlay, index]);

  if (fens.length === 0) return null;

  const current = index > 0 ? moves[index - 1] : undefined;
  const board = (
    <Board
      fen={fens[index]!}
      flip={flip}
      light={theme.light}
      dark={theme.dark}
      pieceSet={pieceSet}
      lastMove={moveSquares(current?.uci)}
      {...(size ? { size } : {})}
    />
  );

  if (autoPlay) {
    return (
      <div className="gr-replay">
        <div className="gr-replay-board">{board}</div>
        {current ? (
          <p className="gr-replay-move">
            <Move san={`${Math.ceil(index / 2)}${current.white ? "." : "…"}${current.san}`} white={current.white} />
          </p>
        ) : null}
      </div>
    );
  }

  // Pairs, so the list reads the way a scoresheet does rather than as one
  // column of moves whose colour the reader has to keep count of.
  const pairs: { number: number; white?: Position["moves"][number]; black?: Position["moves"][number] }[] = [];
  moves.forEach((move, ply) => {
    const number = Math.floor(ply / 2) + 1;
    const row = pairs[number - 1] ?? { number };
    if (move.white) row.white = move;
    else row.black = move;
    pairs[number - 1] = row;
  });

  const step = (label: string, to: number, disabled: boolean, glyph: string) => (
    <button type="button" className="gr-step" onClick={() => goto(to)} disabled={disabled} aria-label={label}>
      {glyph}
    </button>
  );

  return (
    <div className="gr-replay is-interactive">
      <div className="gr-replay-board">{board}</div>

      <div className="gr-replay-side">
        <ol className="gr-movelist" ref={listRef}>
          {pairs.map((pair) => (
            <li key={pair.number}>
              <span className="gr-movelist-no">{pair.number}</span>
              {([pair.white, pair.black] as const).map((move, side) => {
                if (!move) return <span key={side} />;
                const ply = (pair.number - 1) * 2 + side + 1;
                return (
                  <button
                    key={side}
                    type="button"
                    data-ply={ply}
                    className={`gr-movelist-move${ply === index ? " is-current" : ""}`}
                    onClick={() => goto(ply)}
                  >
                    <Move san={move.san} white={move.white} />
                  </button>
                );
              })}
            </li>
          ))}
        </ol>

        <div className="gr-replay-controls">
          {step("First position", 0, index === 0, "⏮")}
          {step("Previous move", index - 1, index === 0, "‹")}
          {step("Next move", index + 1, index === last, "›")}
          {step("Final position", last, index === last, "⏭")}
          <button
            type="button"
            className="gr-step gr-step-flip"
            onClick={() => setFlip((value) => !value)}
            aria-label="Flip the board"
          >
            ⇅
          </button>
        </div>
      </div>
    </div>
  );
}

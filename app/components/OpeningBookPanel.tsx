import { useEffect, useState } from "react";
import { getOpeningBook } from "../lib/v1/openings";
import { describeProblem, ProblemError } from "../lib/v1/problem";
import type { OpeningBook } from "../lib/v1/types";

/**
 * The book, at the square the sheet is pointing at.
 *
 * The sheet finds the line you keep getting wrong. This is the other half of
 * that loop and the reason the diagnosis is worth having: what the opening is
 * called, what the book plays from here, and which move of yours left it.
 *
 * It reads `GET /v1/openings/book`, and it reads it **on demand** — when a row
 * is open and a square is selected, never while scrolling a list. The endpoint
 * is a per-actor rate-limited read, and prefetching a book for every row of the
 * sheet would spend that budget drawing panels nobody opened.
 *
 * ## The two counts are never merged
 *
 * A move's `games` and its `judged` are printed as separate numbers. They are
 * different facts — how often you played it, and how often anybody looked — and
 * the difference is unanalysed games. Printing "8 games, 1 mistake" would invite
 * the reader to conclude seven went well; printing "8 games, 2 judged, 1
 * mistake" does not.
 */

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** The mover's own move number at a ply. Ply 0 is White's first move. */
function moveNoOf(ply: number): number {
  return Math.floor(ply / 2) + 1;
}

type State =
  | { kind: "loading" }
  | { kind: "ready"; book: OpeningBook }
  | { kind: "failed"; message: string };

export function OpeningBookPanel({
  position,
  line,
}: {
  /** Core position key: the four-field FEN prefix. */
  position: string;
  /** The UCI move order that reached it. Empty when the sheet has none. */
  line: string;
}) {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let live = true;
    setState({ kind: "loading" });
    getOpeningBook({ position, line })
      .then((book) => {
        if (live) setState({ kind: "ready", book });
      })
      .catch((error: unknown) => {
        if (!live) return;
        // A failed book is a missing panel, not a failed page. The sheet's own
        // numbers came from a different read and are still true.
        setState({
          kind: "failed",
          message:
            error instanceof ProblemError
              ? describeProblem(error).detail
              : "The book could not be read just now.",
        });
      });
    return () => {
      live = false;
    };
  }, [position, line]);

  if (state.kind === "loading") {
    return (
      <div className="line-book" aria-busy="true">
        <p className="cap">The book</p>
        <p className="line-book-note">Reading the book…</p>
      </div>
    );
  }

  if (state.kind === "failed") {
    return (
      <div className="line-book">
        <p className="cap">The book</p>
        <p className="line-book-note">{state.message}</p>
      </div>
    );
  }

  const { book } = state;
  const named = book.opening;
  const departure = book.departure;

  return (
    <div className="line-book">
      <p className="cap">The book</p>

      <h4 className="line-book-name">
        {named ? (
          <>
            {named.name}
            {named.eco ? <span className="line-book-eco">{named.eco}</span> : null}
          </>
        ) : (
          "No named opening on this line"
        )}
      </h4>

      {named && !named.atRequestedPosition ? (
        /* The board on screen is past the last position the catalogue names.
           Saying the position "is" the Najdorf when the book stopped naming
           two plies ago is the kind of small lie a player checks. */
        <p className="line-book-note">
          The catalogue stops naming positions after this. It is the deepest name on your
          move order, not a name for the square you are looking at.
        </p>
      ) : null}

      {departure ? (
        <p className="line-book-note">
          Your line left the book at move {moveNoOf(departure.ply)}
          {departure.side === "white" ? " for White" : " for Black"}: {departure.uci}.
          {departure.lastBookName ? ` The last position it had was the ${departure.lastBookName}.` : ""}
        </p>
      ) : book.requested.line ? (
        <p className="line-book-note">Every move of this line is in the book.</p>
      ) : null}

      {!book.book.atRequestedPosition ? (
        <p className="line-book-note">
          The book has nothing at this position, so the moves below are the ones it offers
          from the last position on your line that it did have.
        </p>
      ) : null}

      {book.book.continuations.length ? (
        <ul className="line-book-moves">
          {book.book.continuations.map((move) => (
            <li key={move.uci}>
              <span className="line-book-san">{move.san}</span>
              <span className="line-book-leads">{move.name ?? "—"}</span>
              <span className="line-book-yours">
                {move.yourGames > 0
                  ? `${move.yourGames} of your ${plural(move.yourGames, "game", "games")}`
                  : "you have not played it"}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="line-book-note">The catalogue has no continuation from here.</p>
      )}

      {book.yourMoves.length ? (
        <>
          <p className="cap line-book-sub">What you played here</p>
          <ul className="line-book-moves">
            {book.yourMoves.map((move) => (
              <li key={move.uci}>
                <span className="line-book-san">{move.san ?? move.uci}</span>
                <span className="line-book-leads">
                  {move.inBook ? "in the book" : "not in the book"}
                </span>
                {/* Three numbers, never two. `games - mistakes` is not a count
                    of moves that went well, because the games nobody analysed
                    are in the gap between `games` and `judged`. */}
                <span className="line-book-yours">
                  {move.games} {plural(move.games, "game", "games")} · {move.judged} judged ·{" "}
                  {move.mistakes} {plural(move.mistakes, "mistake", "mistakes")}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

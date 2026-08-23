import { useState } from "react";
import { Link } from "react-router";
import { PublicPage } from "../components/PublicShell";
import { GameRatingResult } from "../components/GameRatingResult";
import { ApiError } from "../lib/api";
import { rateGame, type RatingView } from "../lib/gameRating";

export function meta() {
  return [
    { title: "Rate a game · Forma" },
    {
      name: "description",
      content:
        "Paste any chess game and Forma scores it out of ten: how strongly both sides played, how much they gave away, and how much the game asked of them.",
    },
  ];
}

/**
 * The public rating page.
 *
 * The first thing a visitor can do with Forma without an account, and the only
 * marketing surface that runs the real product rather than describing it. That
 * is the whole argument for it: the claim is that Forma prices a move against
 * the person who had to answer it, and a paragraph saying so is weaker than a
 * number doing it on a game the visitor already cares about.
 *
 * Copy follows the public rules in DESIGN.md. No labels above headings, no
 * em-dashes, and no figure on this page that was not measured.
 */
export default function RatingPage() {
  const [pgn, setPgn] = useState("");
  const [view, setView] = useState<RatingView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || pgn.trim().length === 0) return;
    setBusy(true);
    setError(null);
    setView(null);
    try {
      setView(await rateGame(pgn));
    } catch (cause) {
      // A refusal from the scorer arrives as a 200 with a reason and is not an
      // error. This branch is for the ones that are: an unparseable paste, a
      // deployment without the model, or too many requests.
      setError(
        cause instanceof ApiError
          ? cause.message
          : "Something went wrong reaching the analyser. Try again in a moment.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <PublicPage>
      <div className="rate-hero">
        <h1>How well was this game played?</h1>
        <p>
          Paste a game. Forma prices every move against the player who had to answer it, not against
          an engine that would never have fallen for it, and returns one number out of ten. Ten is
          close to unreachable and meant to be.
        </p>

        <form className="rate-form" onSubmit={submit}>
          <label htmlFor="pgn">Game in PGN</label>
          <textarea
            id="pgn"
            value={pgn}
            onChange={(event) => setPgn(event.target.value)}
            disabled={busy}
            spellCheck={false}
            placeholder={'[White "..."]\n[Black "..."]\n\n1. e4 e5 2. Nf3 Nc6 ...'}
          />
          <div className="rate-actions">
            <button type="submit" className="primary-button btn-lg" disabled={busy || pgn.trim() === ""}>
              {busy ? "Reading the game" : "Rate this game"}
            </button>
            <p className="rate-note">
              A full game, from any source. Ratings in the tags are used when they are there.
            </p>
          </div>
          {error ? <p className="rate-error" role="alert">{error}</p> : null}
        </form>

        {view ? <GameRatingResult view={view} /> : null}

        {view?.status === "available" ? (
          <p className="rate-note">
            That was one game. <Link to="/signup">Connect an account</Link> and Forma does the same
            to every game you have played.
          </p>
        ) : null}
      </div>
    </PublicPage>
  );
}

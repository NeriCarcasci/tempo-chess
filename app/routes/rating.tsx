import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { PublicPage } from "../components/PublicShell";
import { GameRatingResult } from "../components/GameRatingResult";
import { ApiError } from "../lib/api";
import { peekSession } from "../lib/session";
import {
  lookupRating,
  pollRating,
  requestRating,
  type RatingProgress,
  type RatingView,
} from "../lib/gameRating";

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

/** How often to ask again while the queue works. */
const POLL_MS = 4000;

type Stage =
  | { kind: "idle" }
  | { kind: "looking" }
  | { kind: "working"; gameKey: string; done: number; total: number }
  | { kind: "ready"; view: RatingView }
  | { kind: "needs-account" }
  | { kind: "error"; message: string };

/**
 * The public rating page.
 *
 * The only marketing surface that runs the product rather than describing it,
 * which is the argument for it existing: the claim is that Forma prices a move
 * against the person who had to answer it, and a paragraph saying so is weaker
 * than a number doing it to a game the visitor already cares about.
 *
 * The flow follows what the rating actually costs. A lookup is anonymous and
 * instant, because a game somebody has already rated is a database row. A game
 * nobody has rated is minutes of queued work on a service with one rating
 * worker, so it needs an account and it reports progress instead of blocking.
 *
 * Copy follows the public rules in DESIGN.md. No labels above headings, no
 * em-dashes, and no figure on this page that was not measured.
 */
export default function RatingPage() {
  const [pgn, setPgn] = useState("");
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const signedIn = useRef(Boolean(peekSession()));

  // Polling lives in an effect keyed by the game so that leaving the page, or
  // pasting a different game, stops the previous one rather than leaving two
  // timers racing to set the same state.
  const working = stage.kind === "working" ? stage.gameKey : null;
  useEffect(() => {
    if (!working) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const progress = await pollRating(working);
        if (cancelled) return;
        setStage(stageFor(progress));
      } catch {
        // A failed poll is not a failed rating. The work is durable and the
        // next tick asks again; showing an error here would be a lie about
        // what happened to the game.
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [working]);

  function stageFor(progress: RatingProgress): Stage {
    switch (progress.state) {
      case "ready":
        return { kind: "ready", view: progress.view };
      case "working":
        return {
          kind: "working",
          gameKey: progress.gameKey,
          done: progress.done,
          total: progress.total,
        };
      case "failed":
        return { kind: "error", message: "That rating did not finish. Try it again." };
      case "absent":
        return { kind: "needs-account" };
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (stage.kind === "looking" || pgn.trim() === "") return;
    setStage({ kind: "looking" });
    try {
      const found = await lookupRating(pgn);
      if (found.state !== "absent") {
        setStage(stageFor(found));
        return;
      }
      // Nobody has rated it. Only an account can pay for that.
      if (!signedIn.current) {
        setStage({ kind: "needs-account" });
        return;
      }
      setStage(stageFor(await requestRating(pgn)));
    } catch (cause) {
      setStage({
        kind: "error",
        message:
          cause instanceof ApiError
            ? cause.message
            : "Something went wrong reaching the analyser. Try again in a moment.",
      });
    }
  }

  const busy = stage.kind === "looking" || stage.kind === "working";

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
            <button
              type="submit"
              className="primary-button btn-lg"
              disabled={busy || pgn.trim() === ""}
            >
              {stage.kind === "looking" ? "Reading the game" : "Rate this game"}
            </button>
            <p className="rate-note">
              A full game, from any source. Ratings in the tags are used when they are there.
            </p>
          </div>
          {stage.kind === "error" ? (
            <p className="rate-error" role="alert">
              {stage.message}
            </p>
          ) : null}
        </form>

        {stage.kind === "working" ? <Working done={stage.done} total={stage.total} /> : null}
        {stage.kind === "needs-account" ? <NeedsAccount /> : null}
        {stage.kind === "ready" ? <GameRatingResult view={stage.view} /> : null}

        {stage.kind === "ready" ? (
          <p className="rate-note">
            That was one game. <Link to="/signup">Connect an account</Link> and Forma does the same
            to every game you have played.
          </p>
        ) : null}
      </div>
    </PublicPage>
  );
}

/**
 * The queue, mid-flight.
 *
 * The count is real work items, not a spinner pretending to be one. When the
 * total is not known yet the bar is left out rather than drawn at zero, because
 * a bar at zero says "nothing has happened" and what is true is "we have not
 * counted yet".
 */
export function Working({ done, total }: { done: number; total: number }) {
  const share = total > 0 ? Math.min(1, done / total) : null;
  return (
    <div className="rate-result" aria-live="polite">
      <div className="rate-headline">
        <p className="rate-score">
          <span>rating this game</span>
        </p>
      </div>
      <section className="rate-demand">
        <h2>Nobody has rated this one before</h2>
        <p className="rate-caveat">
          Forma is pricing every position, then asking a human model what a player of each strength
          would have done. That is a few hundred inferences, so it takes a few minutes. The page
          keeps itself up to date.
        </p>
        {share === null ? null : (
          <div className="rate-bars">
            <div className="rate-bar">
              <span className="rate-bar-label">Progress</span>
              <span className="rate-bar-track">
                <span className="rate-bar-fill" style={{ width: `${Math.round(share * 100)}%` }} />
              </span>
              <span className="rate-bar-value">
                {done}/{total}
              </span>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

/** The one thing a visitor cannot have for free, and why. */
export function NeedsAccount() {
  return (
    <div className="rate-result">
      <div className="rate-refusal">
        <h2>This game has not been rated yet</h2>
        <p>
          Reading a rating is free and always will be. Producing a new one is a few hundred engine
          and model runs, so it needs an account behind it. Games other people have already rated
          stay open to everybody, including this one once it is done.
        </p>
        <p>
          <Link to="/signup">Create an account</Link> to rate it, or paste a game somebody has
          already run.
        </p>
      </div>
    </div>
  );
}

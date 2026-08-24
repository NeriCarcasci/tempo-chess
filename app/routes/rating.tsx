import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { PublicPage } from "../components/PublicShell";
import { GameRatingResult } from "../components/GameRatingResult";
import { ReplayBoard } from "../components/ReplayBoard";
import { RookMascot } from "../components/RookMascot";
import { ApiError } from "../lib/api";
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
  | { kind: "working"; gameKey: string; stage: "screening" | "inferring"; done: number; total: number }
  | { kind: "ready"; view: RatingView }
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
          stage: progress.stage,
          done: progress.done,
          total: progress.total,
        };
      case "failed":
        // The reason comes from the assembler rather than from a guess here.
        // "Did not finish" was true and told nobody anything, including us.
        return {
          kind: "error",
          message: progress.detail
            ? `That rating did not finish: ${progress.detail}.`
            : "That rating did not finish. Try it again.",
        };
      case "absent":
        // Nothing has been started for this game yet. The caller asks for one.
        return { kind: "looking" };
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (stage.kind === "looking" || pgn.trim() === "") return;
    setStage({ kind: "looking" });
    try {
      // A game somebody has already rated comes back from the free lookup, so
      // the common case costs nothing and answers immediately.
      const found = await lookupRating(pgn);
      if (found.state !== "absent") {
        setStage(stageFor(found));
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

  // While a rating is running the page is the rating. Keeping the form on
  // screen invites a second paste that cannot start anything, and the heading
  // asks a question the page is in the middle of answering.
  if (stage.kind === "working") {
    return (
      <PublicPage>
        <div className="rate-hero is-waiting">
          <Working stage={stage.stage} done={stage.done} total={stage.total} pgn={pgn} />
        </div>
      </PublicPage>
    );
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

        {stage.kind === "ready" ? <GameRatingResult view={stage.view} pgn={pgn} /> : null}

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
 * A first rating is minutes of work, and a spinner for that long is a page
 * asking somebody to trust it with nothing to look at. So three things share
 * the wait: the game they pasted, playing itself; the rook, which is the only
 * place on this site where waiting is allowed to have a personality; and a bar
 * driven by real work items rather than a timer pretending to be one.
 *
 * The bar is left out entirely until the total is known. A bar at zero says
 * "nothing has happened"; the truth at that moment is "we have not counted
 * yet", and drawing the first is how a loader starts lying.
 */
export function Working({
  stage,
  done,
  total,
  pgn,
}: {
  stage: "screening" | "inferring";
  done: number;
  total: number;
  pgn: string;
}) {
  // The engine half is one item that runs for minutes, so counting it produces
  // "0 of 1" for the whole wait, which reads as broken. During that half the
  // page says what is happening instead of drawing a bar that cannot move.
  const counting = stage === "inferring" && total > 1;
  const share = counting ? Math.min(1, done / total) : null;
  const percent = share === null ? null : Math.round(share * 100);

  // Rate and remaining time are measured from the polls this page has actually
  // seen, not from a constant. A number invented to look like progress is the
  // thing every fake loading bar does, and this one has real counts to use.
  const samples = useRef<{ at: number; done: number }[]>([]);
  const [rate, setRate] = useState<number | null>(null);
  useEffect(() => {
    if (!counting) return;
    const now = Date.now();
    const seen = samples.current;
    if (seen.length === 0 || seen[seen.length - 1]!.done !== done) {
      seen.push({ at: now, done });
    }
    // A short window, so the figure tracks what is happening now rather than
    // averaging in a slow cold start for the rest of the wait.
    while (seen.length > 2 && now - seen[0]!.at > 90_000) seen.shift();
    const first = seen[0]!;
    const elapsed = (now - first.at) / 1000;
    const moved = done - first.done;
    setRate(elapsed > 10 && moved > 0 ? (moved / elapsed) * 60 : null);
  }, [counting, done]);

  const remaining = rate && rate > 0 ? Math.ceil((total - done) / rate) : null;

  return (
    <div className="rate-result rate-working" aria-live="polite">
      <div className="rate-working-head">
        <RookMascot mood="curious" size={72} label="" />
        <div>
          <h2>Nobody has rated this one before</h2>
          <p className="rate-caveat">
            Forma is pricing every position, then asking a human model what a player of each
            strength would have done here. That is a few hundred inferences, so it takes a few
            minutes. This page keeps itself up to date, and the answer is saved: the next person to
            paste this game gets it straight away.
          </p>
        </div>
      </div>

      <div className="rate-working-body">
        <ReplayBoard pgn={pgn} />
        <div className="rate-working-progress">
          {percent === null ? (
            <p className="rate-caveat">
              Reading the game with the engine, position by position. This part takes a couple of
              minutes and does not report a percentage, because it is one long look rather than a
              hundred small ones.
            </p>
          ) : (
            <>
              <p className="rate-progress-figure">
                {percent}
                <span>%</span>
              </p>
              <span
                className="rate-bar-track"
                role="progressbar"
                aria-valuenow={done}
                aria-valuemin={0}
                aria-valuemax={total}
                aria-label="Rating progress"
              >
                <span className="rate-bar-fill" style={{ width: `${percent}%` }} />
              </span>
              <p className="rate-caveat">
                {done} of {total} positions done
                {rate ? `, about ${Math.round(rate)} a minute` : ""}
                {remaining ? ` and roughly ${remaining} ${remaining === 1 ? "minute" : "minutes"} left` : ""}.
                Positions other people have already had analysed are free, so this can finish sooner
                than it looks.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

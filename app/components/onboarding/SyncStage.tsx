import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { BrandLock } from "../PublicShell";
import { PieceGlyph } from "../PieceGlyph";
import { ProblemNote } from "../v1/Honesty";
import { fetchRecentGames, type RecentGame } from "../../lib/v1/games";
import { toFrames, type ReplayFrame } from "../../lib/onboarding/replay";
import { waitLabel, workflowStageLabel } from "../../lib/onboarding/copy";
import { useJourney } from "../../lib/onboarding/useJourney";
import { boardsBelongHere, type Step } from "../../lib/onboarding/sync";
import type { Workflow } from "../../lib/v1/types";

/**
 * The examination, at full size.
 *
 * This is the only screen a new account sees for several minutes, and it is
 * where the product either earns the wait or loses the person. It used to be a
 * three-pixel bar inside a 26rem card — a system reading a year of somebody's
 * chess, presented as a spinner in a box — so it takes the viewport instead.
 *
 * Three things carry the wait, in descending order of how much they are
 * trusted:
 *
 *   * **The steps.** Four of them, each with its own state and its own tally,
 *     so what has finished is marked finished and what is running says which
 *     of the four it is. A fill appears only where a denominator has settled;
 *     everywhere else the step counts up in whole games. See `readSteps`.
 *   * **The estimate.** Derived from observed throughput over analysis weight,
 *     and shown under the analysis step alone — quoted beside any other step it
 *     would be a number attached to work it did not come from.
 *   * **The games.** Real games out of the archive, replaying while they are
 *     analysed. Deliberately far slower than the processing behind them: the
 *     point is that a person sees chess, not a flicker.
 *
 * The boards are the one part that can be missing. They are evidence, not the
 * message, so when the games route is unavailable the screen is drawn without
 * them and nothing else changes.
 */

/** Four fits a wide desk and collapses to two and then one; more is a wall. */
const BOARDS = 4;
/** A move roughly every second: slow enough to read, quick enough to be alive. */
const PLY_MS = 1100;
/** So four boards do not step in unison, which reads as one animation. */
const STAGGER_MS = 260;
/** Asked for once games exist, then twice more. */
const GAME_ATTEMPTS = 3;
const GAME_RETRY_MS = 12_000;

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const onChange = (event: MediaQueryListEvent): void => setReduced(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

// ---------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------

/**
 * The four steps, each answering for itself.
 *
 * One bar stood here, and it measured the analysis - nearly all of the wall
 * clock and the only part with a stable denominator. Everything else it could
 * only name. Watching a real first run showed what that costs: for minutes the
 * screen said IMPORTING while the caption underneath said "Gathering what to
 * read", a step that runs after the import and waits on something else.
 * Nothing that had finished was marked finished, and a person cannot tell a
 * system that is working from one that is stuck if it never says what it has
 * done.
 *
 * Three segments were tried once and could not be made coherent, and the reason
 * is worth keeping: the phases do not have denominators at the same time, so
 * the early ones showed confident percentages of a total about to grow by
 * orders of magnitude. What makes four work where three did not is a rule
 * rather than an extra segment - a step draws a fill only once its denominator
 * has settled, and counts up in whole games until then. See `readSteps`.
 *
 * The state marks are shapes, not tones: a tick for done, a ring for the step
 * running now, a flat disc for one still waiting. Colour never carries meaning
 * on its own, here or anywhere else.
 */
function StepList({ steps, eta }: { steps: readonly Step[]; eta: string | null }) {
  return (
    <ol className="sync-steps">
      {steps.map((step) => (
        <li key={step.key} className={`sync-step is-${step.state}`}>
          <span className="sync-step-mark" aria-hidden="true">
            {step.state === "done" ? (
              <svg viewBox="0 0 16 16" width="12" height="12" focusable="false">
                <path
                  d="M3.5 8.5l3 3 6-7"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : null}
          </span>

          <span className="sync-step-body">
            <span className="sync-step-head">
              <span className="sync-step-label">{step.label}</span>
              {step.detail ? <span className="sync-step-detail">{step.detail}</span> : null}
            </span>

            {/* Only the step running now draws a track, and only when it has
                something true to divide by. A finished step needs no bar: the
                tick already said everything a bar could. */}
            {step.state === "running" ? (
              <span className="sync-step-track">
                <span
                  className={step.fraction === null ? "sync-step-fill is-unknown" : "sync-step-fill"}
                  style={
                    step.fraction === null
                      ? undefined
                      : { width: `${Math.round(step.fraction * 100)}%` }
                  }
                />
              </span>
            ) : null}

            {/* The estimate sits under the step it was measured from, rather
                than floating beside the whole screen where it read as a claim
                about all four. */}
            {step.state === "running" && eta ? <span className="sync-step-eta">{eta}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// The boards
// ---------------------------------------------------------------------------

function BoardFrame({ frame, flip }: { frame: ReplayFrame; flip: boolean }) {
  const place = (square: number): { col: number; row: number } => {
    const file = square % 8;
    const rank = Math.floor(square / 8);
    return flip ? { col: 7 - file, row: rank } : { col: file, row: 7 - rank };
  };
  const moved = new Set([frame.from, frame.to].filter((square) => square !== null));

  return (
    <div className="sync-board">
      <div className="sync-board-grid">
        {Array.from({ length: 64 }, (_, cell) => {
          const col = cell % 8;
          const row = Math.floor(cell / 8);
          const file = flip ? 7 - col : col;
          const rank = flip ? row : 7 - row;
          const square = rank * 8 + file;
          // a1 is dark: file 0 with rank index 0 sums to even.
          const dark = (file + rank) % 2 === 0;
          return (
            <span
              key={cell}
              className={`sync-sq${dark ? " is-dark" : ""}${moved.has(square) ? " is-moved" : ""}`}
            />
          );
        })}
      </div>
      {frame.pieces.map((piece) => {
        const { col, row } = place(piece.square);
        return (
          <span
            key={piece.id}
            className="sync-board-slot"
            style={{ transform: `translate(${col * 100}%, ${row * 100}%)` }}
          >
            <PieceGlyph letter={piece.letter} white={piece.white} />
          </span>
        );
      })}
    </div>
  );
}

/**
 * One board, replaying one game, then taking another.
 *
 * `seat` staggers both the first move and which game each board starts on, and
 * a board that finishes jumps forward by the number of boards so two of them
 * never land on the same game.
 */
function ReplayBoard({
  games,
  seat,
  still,
}: {
  games: RecentGame[];
  seat: number;
  still: boolean;
}) {
  // One value rather than two pieces of state: the slot and the ply always move
  // together, and a queued updater that sets the other one is not a pure
  // updater — React is free to run it twice, and a board would skip a game.
  const [cursor, setCursor] = useState({ slot: seat, ply: 0 });

  const game = games[cursor.slot % games.length]!;
  const frames = useMemo(() => toFrames(game), [game]);

  // Held in a ref so the interval below can advance without listing `frames`
  // and `cursor` as dependencies, which would restart the timer on every move.
  const advance = useRef<() => void>(() => {});
  advance.current = () => {
    setCursor((current) =>
      current.ply + 1 < frames.length
        ? { slot: current.slot, ply: current.ply + 1 }
        : { slot: current.slot + BOARDS, ply: 0 },
    );
  };

  useEffect(() => {
    if (still) return;
    const timer = setInterval(() => advance.current(), PLY_MS);
    const offset = setTimeout(() => advance.current(), seat * STAGGER_MS);
    return () => {
      clearInterval(timer);
      clearTimeout(offset);
    };
  }, [still, seat]);

  // A game whose moves this build cannot replay leaves the seat empty rather
  // than drawing a board that will never move.
  if (frames.length === 0) return null;

  // Reduced motion gets one position from the middle of the game and keeps it:
  // still legible, still real chess, and it never moves.
  const frame =
    frames[still ? Math.floor(frames.length / 2) : Math.min(cursor.ply, frames.length - 1)]!;

  return (
    <figure className="sync-seat">
      <BoardFrame frame={frame} flip={game.colour === "black"} />
      <figcaption>
        {game.opponent === null ? "From your archive" : `vs ${game.opponent}`}
        {game.speed === null ? "" : ` · ${game.speed}`}
      </figcaption>
    </figure>
  );
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

/**
 * The frame every onboarding screen shares.
 *
 * Exported because `/onboarding` renders its other states — the journey
 * stopped, the diagnostic, no account connected — and they were using the old
 * centred `auth-card` with a seven-step stage trail across the top. That put
 * two different products on one route: a full-bleed progress screen while the
 * work ran, and a small card listing CONNECTING / IMPORTING / ANALYSING the
 * moment it stopped. The trail is gone and this is the one frame, so a failure
 * arrives on the same screen the wait was on rather than replacing it.
 */
export function SyncShell({
  title,
  sub,
  children,
}: {
  title: string;
  sub: string;
  children: React.ReactNode;
}) {
  return (
    <main className="sync-stage">
      <a className="skip-link" href="#sync-main">
        Skip to content
      </a>
      <div className="sync-inner" id="sync-main" tabIndex={-1}>
        <header className="sync-head">
          <Link to="/" className="auth-brand" aria-label="Forma home">
            <BrandLock size={24} />
          </Link>
          <h1>{title}</h1>
          <p className="sync-sub">{sub}</p>
        </header>
        {children}
      </div>
    </main>
  );
}

export function SyncStage({
  runStage,
  workflow,
  waitReason,
  error,
}: {
  /** The run's own stage. It decides which section is current, never how full. */
  runStage: string;
  /** The examination workflow, for the server's own name for the running task. */
  workflow: Workflow | null;
  /** The run's own sentence about what it is waiting for. */
  waitReason?: string;
  /** A poll that has failed several times running. */
  error?: unknown;
}) {
  const still = useReducedMotion();
  const { journey, steps, step, eta, error: weighError } = useJourney(runStage);

  const [games, setGames] = useState<RecentGame[]>([]);
  const [attempt, setAttempt] = useState(0);
  const wanted = boardsBelongHere();

  /*
   * Asked for from the first moment, and kept asking while the import runs.
   *
   * The boards are the most responsive true thing this screen has: they are the
   * player's own games, replaying, and a game is readable as soon as a sync
   * commits the page it arrived on. Holding them back until analysis had weight
   * left the screen empty through the whole download.
   *
   * The attempt ceiling stays for the settled part of the run, where an empty
   * answer means there is genuinely nothing to draw. It does not apply while
   * importing, because there the right reading of an empty answer is "not yet"
   * rather than "never" — the games are on their way.
   */
  const stillArriving = journey.phase === "importing";
  useEffect(() => {
    if (!wanted || games.length > 0 || (!stillArriving && attempt >= GAME_ATTEMPTS)) return;
    let cancelled = false;
    const run = async (): Promise<void> => {
      const found = await fetchRecentGames(BOARDS * 2);
      if (cancelled) return;
      if (found.length > 0) setGames(found);
      else setAttempt((current) => current + 1);
    };
    const timer = setTimeout(() => void run(), attempt === 0 ? 0 : GAME_RETRY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [wanted, attempt, games.length, stillArriving]);

  /*
   * The one line under the steps, and it is the server's own words first.
   *
   * The caption belongs to whoever knows what is happening, per the rule in
   * `copy.ts`: the name of the task actually running, then the run's own
   * sentence about what it is waiting for. What it must no longer do is stand
   * in for the step, which is what made the old screen contradict itself --
   * "IMPORTING" over "Gathering what to read", two different truths at two
   * sizes. The steps say where the work is; this says what it is doing inside
   * that step, and it is dropped entirely when it would only repeat the label
   * above it.
   */
  const said =
    workflowStageLabel(workflow?.progress.stage ?? null) ??
    (waitReason === undefined ? null : waitLabel(waitReason));
  const detail = said !== null && said !== step?.label ? said : null;
  const showBoards = wanted && games.length > 0;

  return (
    <SyncShell
      /* The outcome, not the activity. The line under the bar is the server's
         own name for the task running right now, and a heading that also said
         "reading your games" would be the same sentence twice at two sizes. */
      title="Building your first report"
      sub="Forma is reading every game you have played. This takes a few minutes, and it carries on whether or not this tab is open."
    >

        {/* Polite and atomic: the steps and the caption change together, and
            announcing them separately would interrupt somebody mid-sentence
            with half a status. The boards below are outside it, because a
            screen reader does not want a move every second. */}
        <div className="sync-status" aria-live="polite" aria-atomic="true">
          <StepList steps={steps} eta={eta} />
          {detail ? <p className="sync-detail">{detail}</p> : null}
        </div>

        {error || weighError ? <ProblemNote error={error ?? weighError} /> : null}

        {showBoards ? (
          <section className="sync-games">
            <p className="cap">Your games, as they are read</p>
            {/* Hidden from assistive technology on purpose. Thirty-two glyphs
                moving every second is not information; the line above it is. */}
            <div className="sync-row" aria-hidden="true">
              {games.slice(0, BOARDS).map((_, seat) => (
                <ReplayBoard key={seat} games={games} seat={seat} still={still} />
              ))}
            </div>
          </section>
        ) : null}
    </SyncShell>
  );
}

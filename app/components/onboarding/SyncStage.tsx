import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { BrandLock } from "../PublicShell";
import { PieceGlyph } from "../PieceGlyph";
import { ProblemNote } from "../v1/Honesty";
import { fetchRecentGames, type RecentGame } from "../../lib/v1/games";
import { toFrames, type ReplayFrame } from "../../lib/onboarding/replay";
import { listWorkflows } from "../../lib/onboarding/api";
import { waitLabel, workflowStageLabel } from "../../lib/onboarding/copy";
import {
  boardsBelongHere,
  emptyTracker,
  etaLabel,
  observe,
  PHASE_LABEL,
  readJourney,
  remainingAt,
  type Journey,
} from "../../lib/onboarding/sync";
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
 *   * **The bar.** Every section fills from real completed weight over real
 *     total weight, summed across the workflows that belong to it. It is a
 *     measurement, not a phase indicator: a section that is a third done is
 *     drawn a third full whether or not it is the section running now.
 *   * **The estimate.** Derived from observed throughput over that same weight,
 *     ratcheted so it never counts upward, and absent — in words — until there
 *     is enough evidence for it.
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
/**
 * Slower than the run's own poll on purpose. One reading of the workflow list
 * is up to three requests, and the weights move in units of a whole game.
 */
const WEIGH_MS = 6_000;

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

/**
 * The workflow list, re-read while this screen is open.
 *
 * Not `usePoll`: that one is seeded from a loader and starts on the interval,
 * and this screen has no seed — waiting a whole interval before the first
 * reading would leave the bar with no denominator for six seconds every time
 * somebody reloads. It borrows the same two rules: nothing runs while the tab
 * is hidden, and a response that lands after unmount cannot set state.
 */
function useWorkflows(): { workflows: Workflow[]; error: unknown } {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    const read = async (): Promise<void> => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      try {
        const next = await listWorkflows();
        if (cancelled) return;
        setWorkflows(next);
        setError(null);
      } catch (caught) {
        if (cancelled) return;
        // A redirect is a Response and belongs to the router. The run's own
        // poll on this route is what turns an expired session into a sign-in.
        if (caught instanceof Response) return;
        setError(caught);
      }
    };
    void read();
    const timer = setInterval(() => void read(), WEIGH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return { workflows, error };
}

// ---------------------------------------------------------------------------
// The bar
// ---------------------------------------------------------------------------

/**
 * One bar, because there is one thing worth measuring.
 *
 * Three segments were tried and could not be made coherent: the phases do not
 * have denominators at the same time, so the early ones showed confident
 * percentages of a total about to grow by four orders of magnitude, and the
 * later ones sat frozen behind a ratchet. See `sync.ts` for the full account.
 *
 * What this draws instead is the analysis, which is nearly all of the wall
 * clock and the only part with a stable denominator — and it draws nothing at
 * all where there is nothing to measure, which is what the stripe is for.
 */
function JourneyBar({ journey, fraction }: { journey: Journey; fraction: number | null }) {
  const unknown = fraction === null;
  const percent = unknown ? null : Math.round(fraction * 100);

  return (
    <div className="sync-bar-one">
      <div className="sync-bar-head">
        <p className="cap sync-bar-phase">{PHASE_LABEL[journey.phase]}</p>
        {/* The count is the concrete version of the same fact, and the one a
            person actually feels. A percentage of an abstract work unit means
            little; "412 of 4,317 games" means exactly what it says. */}
        {journey.games.total > 0 ? (
          <p className="sync-bar-count">
            {journey.games.done.toLocaleString()} of {journey.games.total.toLocaleString()} games
          </p>
        ) : null}
        <p className="sync-bar-figure">{percent === null ? "—" : `${percent}%`}</p>
      </div>
      <div
        className="sync-bar-track"
        role="progressbar"
        aria-label="Examination progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
      >
        <span
          className={unknown ? "sync-bar-fill is-unknown" : "sync-bar-fill"}
          style={unknown ? undefined : { width: `${percent}%` }}
        />
      </div>
    </div>
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
  const { workflows, error: weighError } = useWorkflows();

  const journey = useMemo(() => readJourney(workflows, runStage), [workflows, runStage]);

  const [tracker, setTracker] = useState(emptyTracker);
  // Folded in when a reading lands, not on every render: a sample taken over no
  // elapsed work is a rate of infinity, and two of them in a row would put a
  // fabricated estimate on screen inside a second.
  useEffect(() => {
    setTracker((current) => observe(current, { at: Date.now(), journey }));
  }, [journey]);

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

  // The caption belongs to whoever knows what is happening, per the rule in
  // `copy.ts`, so it is the server's own words twice over before it is ours:
  // the name of the task actually running, then the run's own sentence about
  // what it is waiting for. The section's line is the last resort, so the text
  // under the bar is never empty.
  const detail =
    workflowStageLabel(workflow?.progress.stage ?? null) ??
    (waitReason === undefined ? null : waitLabel(waitReason)) ??
    PHASE_LABEL[journey.phase];
  const eta = etaLabel(remainingAt(tracker, Date.now()));
  const showBoards = wanted && games.length > 0;

  return (
    <SyncShell
      /* The outcome, not the activity. The line under the bar is the server's
         own name for the task running right now, and a heading that also said
         "reading your games" would be the same sentence twice at two sizes. */
      title="Building your first report"
      sub="Forma is reading every game you have played. This takes a few minutes, and it carries on whether or not this tab is open."
    >

        <JourneyBar journey={journey} fraction={tracker.fraction} />

        {/* Polite and atomic: the task and the estimate change together, and
            announcing them separately would interrupt somebody mid-sentence
            with half a status. The boards below are outside it, because a
            screen reader does not want a move every second. */}
        <div className="sync-status" aria-live="polite" aria-atomic="true">
          <p className="sync-detail">{detail}</p>
          <p className="sync-eta">{eta}</p>
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

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
  currentSection,
  emptyTracker,
  emptyWeights,
  etaLabel,
  observe,
  overallPercent,
  remainingAt,
  SYNC_SECTIONS,
  weighSections,
  type SectionId,
  type SectionWeights,
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
 * A console system update rather than one 0–100 sweep.
 *
 * Every segment carries its own measurement, so all three are readable at once:
 * importing full, analysing part way, writing not started. Splitting the work
 * up is also what keeps the figures honest — the examination fans out into a
 * workflow per game, and one continuous percentage over the lot of it walks
 * backwards every time a batch of them is planned.
 */
function SegmentedBar({
  active,
  fractions,
  percent,
}: {
  active: SectionId;
  fractions: Record<SectionId, number | null>;
  /** The whole examination as one figure, for assistive technology. */
  percent: number | null;
}) {
  return (
    <div
      className="sync-bar"
      role="progressbar"
      aria-label="Examination progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
    >
      {SYNC_SECTIONS.map((section) => {
        const fraction = fractions[section.id];
        // Indeterminate only where there is genuinely no denominator yet, and
        // only for the section running now: an empty track further down the bar
        // is the truth about a section that has not started.
        const unknown = fraction === null && section.id === active;
        return (
          <div
            key={section.id}
            className={`sync-seg${section.id === active ? " is-active" : ""}${
              fraction !== null && fraction >= 1 ? " is-done" : ""
            }`}
          >
            <p className="cap sync-seg-label">{section.label}</p>
            <div className="sync-seg-track">
              <span
                className={unknown ? "sync-seg-fill is-unknown" : "sync-seg-fill"}
                style={unknown ? undefined : { width: `${Math.round((fraction ?? 0) * 100)}%` }}
              />
            </div>
            <p className="sync-seg-figure">
              {fraction === null ? "—" : `${Math.round(fraction * 100)}%`}
            </p>
          </div>
        );
      })}
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

  const weights: SectionWeights = useMemo(
    () => (workflows.length === 0 ? emptyWeights() : weighSections(workflows)),
    [workflows],
  );
  const section = currentSection(weights, runStage);

  const [tracker, setTracker] = useState(emptyTracker);
  // Folded in when a reading lands, not on every render: a sample taken over no
  // elapsed work is a rate of infinity, and two of them in a row would put a
  // fabricated estimate on screen inside a second.
  useEffect(() => {
    setTracker((current) => observe(current, { at: Date.now(), weights }));
  }, [weights]);

  const [games, setGames] = useState<RecentGame[]>([]);
  const [attempt, setAttempt] = useState(0);
  const wanted = boardsBelongHere(weights, section);

  // Asked for once there are analysed games to ask about. It retries a couple
  // of times: the first request can land in the gap between the first analysis
  // workflow appearing and the first game being readable, and one empty answer
  // should not cost the boards for the rest of a run that lasts minutes.
  useEffect(() => {
    if (!wanted || games.length > 0 || attempt >= GAME_ATTEMPTS) return;
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
  }, [wanted, attempt, games.length]);

  // The caption belongs to whoever knows what is happening, per the rule in
  // `copy.ts`, so it is the server's own words twice over before it is ours:
  // the name of the task actually running, then the run's own sentence about
  // what it is waiting for. The section's line is the last resort, so the text
  // under the bar is never empty.
  const detail =
    workflowStageLabel(workflow?.progress.stage ?? null) ??
    (waitReason === undefined ? null : waitLabel(waitReason)) ??
    SYNC_SECTIONS.find((entry) => entry.id === section)!.detail;
  const eta = etaLabel(remainingAt(tracker, Date.now()));
  const showBoards = wanted && games.length > 0;

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
          {/* The outcome, not the activity. The line under the bar is the
              server's own name for the task running right now, and a heading
              that also said "reading your games" would be the same sentence
              twice at two sizes. */}
          <h1>Building your first report</h1>
          <p className="sync-sub">
            Forma is reading every game you have played. This takes a few minutes, and it carries
            on whether or not this tab is open.
          </p>
        </header>

        <SegmentedBar
          active={section}
          fractions={tracker.fractions}
          percent={overallPercent(weights)}
        />

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
      </div>
    </main>
  );
}

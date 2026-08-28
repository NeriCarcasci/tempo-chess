import { useMemo, useRef, useState } from "react";
import { Link, useRevalidator } from "react-router";
import { Chess } from "chess.js";
import type { Route } from "./+types/practice";
import { Board } from "../components/Board";
import { MoveInput } from "../components/MoveInput";
import { TopNav } from "../components/TopNav";
import { RouteError } from "../components/RouteError";
import { PracticeEmpty, ProblemNote } from "../components/v1/Honesty";
import { loadBoardTheme } from "../lib/boardThemes";
import { loadPieceSet } from "../lib/pieceSets";
import { requireSession } from "../lib/session";
import { usePrimaryActionKeys } from "../lib/usePrimaryActionKeys";
import { newIdempotencyKey } from "../lib/v1/client";
import {
  getPracticeQueue,
  recordAttempt,
  refillPractice,
  revealAnswer,
  type PracticeAttempt,
  type PracticeItem,
  type PracticeQueue,
} from "../lib/v1/practice";

/**
 * `/practice` — the drill queue, on the canonical system.
 *
 * Every item is a position from this player's own games where the engine
 * preferred another move: the decision they actually got wrong, put back in
 * front of them. That sentence is the product; each item carries its own
 * (`reason`), and the page prints it rather than a themed-puzzle framing.
 *
 * Three rules, all from the API's own contract:
 *
 *   * the queue never contains the solution, so the board is a test — the
 *     expected move exists client-side only after an attempt is recorded;
 *   * one committed answer per position. There is no "try again": the attempt
 *     advanced the spaced schedule, and the honest consequence of a miss is
 *     that the position comes back sooner, which the page says;
 *   * a revealed answer is never a success, so "show me" is offered quietly
 *     and its result reads as a reveal, not a solve.
 */

export function meta() {
  return [
    { title: "Practice · Forma" },
    { name: "description", content: "Drills built from your own games, worst mistakes first." },
  ];
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <RouteError title="Practice unavailable" error={error} />;
}

export async function clientLoader() {
  await requireSession();
  const queue = await getPracticeQueue();
  return { queue };
}

const algFromSq = (sq: number) => String.fromCharCode(97 + (sq % 8)) + (Math.floor(sq / 8) + 1);
const sqFromAlg = (alg: string) => (Number(alg[1]) - 1) * 8 + (alg.charCodeAt(0) - 97);
const uciToSquares = (uci: string): [number, number] => [
  sqFromAlg(uci.slice(0, 2)),
  sqFromAlg(uci.slice(2, 4)),
];

function sanOf(fen: string, uci: string): string {
  try {
    const game = new Chess(fen);
    const move = game.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: (uci[4] as "q") ?? undefined,
    });
    return move?.san ?? uci;
  } catch {
    return uci;
  }
}

/**
 * The server's sentences name moves in uci, which nobody reads. Swapped for
 * SAN in place, keeping the sentence's own casing; a uci that does not parse
 * in this position stays as it arrived rather than being guessed at.
 */
function withSan(sentence: string, fen: string): string {
  return sentence.replace(
    /(you played )([a-h][1-8][a-h][1-8][qrbn]?)/gi,
    (_, prefix: string, uci: string) => `${prefix}${sanOf(fen, uci)}`,
  );
}

/** Days until a stored ISO time, floored at "today". */
function daysUntil(iso: string): number {
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return 0;
  return Math.max(0, Math.round((target - Date.now()) / 86_400_000));
}

interface Verdict {
  attempt: PracticeAttempt;
  /** The move the player committed, in uci, or null on a reveal. */
  played: string | null;
  revealed: boolean;
}

export default function Practice({ loaderData }: Route.ComponentProps) {
  const queue: PracticeQueue = loaderData.queue;
  const revalidator = useRevalidator();
  const theme = useMemo(() => loadBoardTheme(), []);
  const pieceSet = useMemo(() => loadPieceSet(), []);
  usePrimaryActionKeys();

  const [index, setIndex] = useState(0);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [solved, setSolved] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [problem, setProblem] = useState<unknown | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [targets, setTargets] = useState<number[]>([]);
  const [refilling, setRefilling] = useState(false);
  // One id per attempt intent, reused on retry so a flaky submit cannot count
  // twice. Regenerated when the item advances, never on re-render.
  const attemptIdRef = useRef<string>(newIdempotencyKey());

  const items = queue.items;
  const item: PracticeItem | undefined = items[index];
  const done = index >= items.length;

  const flip = item ? item.fen.split(" ")[1] === "b" : false;

  const submit = async (moves: string[], revealed: boolean, played: string | null) => {
    if (!item || verdict || submitting) return;
    setSubmitting(true);
    setProblem(null);
    try {
      const attempt = revealed
        ? await revealAnswer(item.assignmentId, attemptIdRef.current)
        : await recordAttempt({
            assignmentId: item.assignmentId,
            clientAttemptId: attemptIdRef.current,
            moves,
          });
      if (attempt.success) setSolved((count) => count + 1);
      setVerdict({ attempt, played, revealed });
    } catch (error) {
      if (error instanceof Response) throw error;
      setProblem(error);
    } finally {
      setSubmitting(false);
    }
  };

  const tryMove = (fromSq: number, toSq: number): boolean => {
    if (!item || verdict || submitting) return false;
    let move: { from: string; to: string; promotion?: string } | null = null;
    try {
      move = new Chess(item.fen).move({
        from: algFromSq(fromSq),
        to: algFromSq(toSq),
        promotion: "q",
      });
    } catch {
      return false;
    }
    if (!move) return false;
    setSelected(null);
    setTargets([]);
    void submit([move.from + move.to + (move.promotion ?? "")], false, move.from + move.to + (move.promotion ?? ""));
    return true;
  };

  const selectSquare = (sq: number) => {
    if (!item || verdict) return;
    const moves = new Chess(item.fen).moves({
      square: algFromSq(sq) as never,
      verbose: true,
    }) as Array<{ to: string }>;
    setSelected(sq);
    setTargets(moves.map((move) => sqFromAlg(move.to)));
  };

  const onSquareClick = (sq: number) => {
    if (!item || verdict) return;
    const mover = item.fen.split(" ")[1] === "b" ? "b" : "w";
    const piece = new Chess(item.fen).get(algFromSq(sq) as never) as
      | { color: string }
      | undefined;
    if (selected != null) {
      if (targets.includes(sq)) return void tryMove(selected, sq);
      if (piece && piece.color === mover) return void selectSquare(sq);
      setSelected(null);
      setTargets([]);
      return;
    }
    if (piece && piece.color === mover) selectSquare(sq);
  };

  const next = () => {
    attemptIdRef.current = newIdempotencyKey();
    setVerdict(null);
    setProblem(null);
    setSelected(null);
    setTargets([]);
    setIndex((value) => value + 1);
  };

  const refill = async () => {
    setRefilling(true);
    try {
      await refillPractice();
      revalidator.revalidate();
    } finally {
      setRefilling(false);
    }
  };

  // The verdict's arrows: the expected move in the win colour, and the move
  // played in the loss colour when it was not the expected one. Both named in
  // the panel beside the board, so the colours never carry it alone.
  const expected = verdict?.attempt.expected[0] ?? null;
  const arrows = verdict
    ? [
        ...(verdict.played && verdict.played !== expected
          ? [
              {
                from: uciToSquares(verdict.played)[0],
                to: uciToSquares(verdict.played)[1],
                color: "var(--color-loss)",
              },
            ]
          : []),
        ...(expected
          ? [
              {
                from: uciToSquares(expected)[0],
                to: uciToSquares(expected)[1],
                color: "var(--color-win)",
              },
            ]
          : []),
      ]
    : undefined;

  const boardFen = item?.fen ?? items[items.length - 1]?.fen ?? "8/8/8/8/8/8/8/8 w - - 0 1";

  return (
    <div className="relative z-10 min-h-dvh">
      <TopNav current="practice" />
      <main className="practice-shell">
        <header className="practice-head">
          <h1>Practice</h1>
          {items.length > 0 ? (
            <p>
              <span className="figure">{items.length}</span>{" "}
              {items.length === 1 ? "position" : "positions"} from your own games
              {queue.overdue > 0 ? (
                <>
                  , <span className="figure">{queue.overdue}</span> overdue
                </>
              ) : null}
            </p>
          ) : null}
        </header>

        {items.length === 0 ? (
          <div className="practice-empty">
            <PracticeEmpty
              reason={queue.emptyReason === "none" ? null : queue.emptyReason}
              onRefill={
                queue.emptyReason === "no_material" || queue.emptyReason === "nothing_due" ? (
                  <button
                    type="button"
                    className="primary-button mt-4"
                    disabled={refilling}
                    onClick={() => void refill()}
                  >
                    {refilling ? "Looking…" : "Build drills from my games"}
                  </button>
                ) : null
              }
            />
          </div>
        ) : (
          <div className="play-workspace">
            <div className="play-board-col">
              <div className="explorer-board-frame">
                <Board
                  fen={boardFen}
                  flip={flip}
                  arrows={arrows}
                  lastMove={verdict && expected ? uciToSquares(expected) : undefined}
                  light={theme.light}
                  dark={theme.dark}
                  pieceSet={pieceSet}
                  onSquareClick={onSquareClick}
                  onMove={tryMove}
                  selected={selected}
                  targets={targets}
                  interactive={!done && !verdict && !submitting}
                />
              </div>
              <div className="train-progress">
                <span className="train-progress-track" aria-hidden="true">
                  <i
                    style={{
                      width: `${items.length ? (Math.min(index, items.length) / items.length) * 100 : 0}%`,
                    }}
                  />
                </span>
                <span className="metric">
                  {done ? items.length : index + 1} of {items.length} · {solved} solved
                </span>
              </div>
              {!done && !verdict && item ? <MoveInput fen={item.fen} onMove={tryMove} /> : null}
            </div>

            <div className="play-side">
              {done ? (
                <div className="train-result">
                  <div className="train-result-head">
                    <strong>Queue cleared</strong>
                    <span className="train-score">
                      {solved}/{items.length}
                    </span>
                  </div>
                  <p>
                    The ones you missed come back sooner.
                  </p>
                  <div className="play-actions">
                    <button
                      type="button"
                      className="primary-button"
                      disabled={refilling}
                      onClick={() => void refill()}
                    >
                      {refilling ? "Looking…" : "More from my games"}
                    </button>
                    <Link to="/today" className="secondary-button inline-flex items-center">
                      Back to Today
                    </Link>
                  </div>
                </div>
              ) : item ? (
                <>
                  <div
                    className={`train-prompt ${
                      verdict ? (verdict.attempt.success ? "is-correct" : "is-wrong") : ""
                    }`}
                  >
                    {verdict && expected ? (
                      <>
                        <strong>
                          {verdict.attempt.success
                            ? `✓ ${sanOf(item.fen, expected)}`
                            : verdict.revealed
                              ? `The move is ${sanOf(item.fen, expected)}`
                              : `✗ It was ${sanOf(item.fen, expected)}`}
                        </strong>
                        <p>
                          {verdict.attempt.success
                            ? "The engine's own choice."
                            : verdict.played
                              ? `You played ${sanOf(item.fen, verdict.played)}.`
                              : "Revealed, so not recorded as solved."}{" "}
                          {(() => {
                            const days = daysUntil(verdict.attempt.nextDueAt);
                            return days === 0
                              ? "Back within a day."
                              : `Back in ${days} ${days === 1 ? "day" : "days"}.`;
                          })()}
                        </p>
                      </>
                    ) : (
                      <>
                        <strong>{withSan(item.prompt, item.fen)}</strong>
                        <p>{withSan(item.reason, item.fen)}</p>
                        {item.reviewNumber > 0 ? (
                          <p className="practice-review-note">
                            Review {item.reviewNumber + 1} of this position.
                          </p>
                        ) : null}
                      </>
                    )}
                  </div>
                  {problem ? <ProblemNote error={problem} /> : null}
                  {verdict ? (
                    <div className="play-actions">
                      <button type="button" className="primary-button" onClick={next}>
                        {index + 1 >= items.length ? "Finish" : "Next"}
                      </button>
                    </div>
                  ) : (
                    <div className="play-actions">
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={submitting}
                        onClick={() => void submit([], true, null)}
                      >
                        Show me
                      </button>
                    </div>
                  )}
                </>
              ) : null}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { Chess } from "chess.js";
import type { Route } from "./+types/train";
import { Board, type BoardArrow } from "../components/Board";
import { MoveInput } from "../components/MoveInput";
import { TopNav } from "../components/TopNav";
import { requireSession, peekSession } from "../lib/session";
import { api } from "../lib/api";
import { recordTrainingResult } from "../lib/account";
import { RouteError } from "../components/RouteError";
import { loadBoardTheme } from "../lib/boardThemes";
import { loadPieceSet } from "../lib/pieceSets";
import { openingLesson } from "../lib/openingContent";
import { childrenOf, familyEntryIndex, indexGraph, movePrefix, pathToNode } from "../lib/openingGraph";
import { lessonForFamily } from "../lib/lessons";
import { usePrimaryActionKeys } from "../lib/usePrimaryActionKeys";
import type { OpeningGraph, OpeningGraphEdge } from "../lib/openings";

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export function meta() {
  return [{ title: "Repertoire trainer · Tempo" }];
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <RouteError title="Trainer unavailable" error={error} />;
}

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const session = await requireSession();
  const url = new URL(request.url);
  const color = url.searchParams.get("color") === "black" ? "black" : "white";
  const family = url.searchParams.get("family");
  const query = new URLSearchParams({ username: session.username, color });
  const data = await api<{ graph?: OpeningGraph | null }>(`/opening-explorer?${query}`);
  return { graph: data.graph ?? null, color: color as "white" | "black", family };
}

const algFromSq = (sq: number) => String.fromCharCode(97 + (sq % 8)) + (Math.floor(sq / 8) + 1);
const sqFromAlg = (alg: string) => (Number(alg[1]) - 1) * 8 + (alg.charCodeAt(0) - 97);
const uciToSquares = (uci: string): [number, number] => [sqFromAlg(uci.slice(0, 2)), sqFromAlg(uci.slice(2, 4))];

function formatEvalPawns(cp: number): string {
  const v = Math.round(cp / 10) / 10;
  if (v === 0) return "0.0";
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}`;
}

/** Small seeded PRNG (mulberry32) so a given drill (identified by its nonce) always
 *  produces the same line — React may recompute a useMemo with unchanged deps, and a
 *  nondeterministic line would silently reset an in-progress drill. */
function seededRandom(seed: number): () => number {
  let t = seed + 0x6d2b79f5;
  return () => {
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Depth = "quick" | "standard" | "deep";
const DEPTH_PLIES: Record<Depth, number> = { quick: 8, standard: 16, deep: 24 };
const DEPTH_KEY = "tempo-train-depth";

/** Build a training line: your main path into the opening, then the most-played
 *  continuations, with a little variety so each drill differs. `maxPlies` caps
 *  the length; `mainLineOnly` always follows the single most-played move. */
function buildLine(
  graph: OpeningGraph,
  family: string | null,
  rand: () => number,
  maxPlies: number,
  mainLineOnly: boolean,
): OpeningGraphEdge[] {
  const indexed = indexGraph(graph);
  let start = indexed.root;
  let prefix: OpeningGraphEdge[] = [];
  if (family) {
    const entry = familyEntryIndex(indexed, family, null);
    if (entry != null && entry !== indexed.root) {
      prefix = pathToNode(indexed, entry);
      start = entry;
    }
  }
  const line = [...prefix];
  let node = start;
  while (line.length < maxPlies) {
    const kids = childrenOf(indexed, node);
    if (!kids.length) break;
    const top = kids.slice(0, 2);
    // Take the most-played line, but (unless main-line-only) branch to the runner-up
    // early so re-drills differ. Follow the path as deep as your games actually go.
    const pick = !mainLineOnly && line.length < 4 && top.length > 1 && rand() < 0.35 ? top[1]! : top[0]!;
    line.push(pick);
    node = pick.b;
  }
  return line;
}

interface Feedback {
  status: "correct" | "wrong";
  expectedSan: string;
  text: string;
  /** Wrong answers hide the move on the first miss; the second miss (or Reveal) shows it. */
  reveal?: boolean;
}

export default function Train({ loaderData }: Route.ComponentProps) {
  const { graph, color, family } = loaderData;
  const userColor = color === "white" ? "w" : "b";
  const theme = useMemo(() => loadBoardTheme(), []);
  const pieceSet = useMemo(() => loadPieceSet(), []);

  const [nonce, setNonce] = useState(0);
  const [depth, setDepth] = useState<Depth>(() => {
    try {
      const d = localStorage.getItem(DEPTH_KEY);
      if (d === "quick" || d === "standard" || d === "deep") return d;
    } catch {
      /* ignore */
    }
    return "standard";
  });
  const setDrillDepth = (d: Depth) => {
    setDepth(d);
    try {
      localStorage.setItem(DEPTH_KEY, d);
    } catch {
      /* ignore */
    }
    setNonce((n) => n + 1);
  };
  const line = useMemo(
    () => (graph ? buildLine(graph, family, seededRandom(nonce + 1), DEPTH_PLIES[depth], false) : []),
    [graph, family, nonce, depth],
  );
  // Name the opening this particular line reaches so every drill can show a plan,
  // not just single-opening drills. Deepest labelled move wins — that's the most
  // specific name the move order has revealed.
  const lineFamily = useMemo(() => {
    if (family) return family;
    for (let i = line.length - 1; i >= 0; i--) {
      if (line[i]?.lb) return line[i]!.lb!;
    }
    return null;
  }, [line, family]);

  const gameRef = useRef(new Chess(START_FEN));
  const [ply, setPly] = useState(0);
  const [fen, setFen] = useState(START_FEN);
  const [lastMove, setLastMove] = useState<[number, number] | undefined>();
  const [selected, setSelected] = useState<number | null>(null);
  const [targets, setTargets] = useState<number[]>([]);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [wrongHere, setWrongHere] = useState(false);
  const [stats, setStats] = useState({ correct: 0, total: 0 });
  const [done, setDone] = useState(false);
  const [showIntro, setShowIntro] = useState(true);
  const [reviewPly, setReviewPly] = useState<number | null>(null);
  const [flip] = useState(userColor === "b");
  const replyTimer = useRef<number | undefined>(undefined);
  const revealsRef = useRef(0);
  const recordedRef = useRef(false);
  usePrimaryActionKeys();

  // When reviewing a finished line, the board shows the position at the clicked ply.
  const reviewFen = useMemo(() => {
    if (reviewPly == null) return null;
    const g = new Chess(START_FEN);
    for (let i = 0; i < reviewPly && i < line.length; i++) {
      const e = line[i]!;
      g.move({ from: e.u.slice(0, 2), to: e.u.slice(2, 4), promotion: (e.u[4] as "q") ?? undefined });
    }
    return g.fen();
  }, [reviewPly, line]);

  const explainEdge = useCallback(
    (edge: OpeningGraphEdge): string => {
      const bits = [`Your main move here — played in ${edge.g} of your game${edge.g === 1 ? "" : "s"}.`];
      if (edge.lb) bits.push(`It stays in the ${edge.lb}.`);
      if (edge.ev != null) bits.push(`The engine keeps it at ${formatEvalPawns(userColor === "b" ? -edge.ev : edge.ev)}.`);
      return bits.join(" ");
    },
    [userColor],
  );

  const restart = useCallback(() => {
    window.clearTimeout(replyTimer.current);
    revealsRef.current = 0;
    recordedRef.current = false;
    const game = new Chess(START_FEN);
    gameRef.current = game;
    setSelected(null);
    setTargets([]);
    setFeedback(null);
    setWrongHere(false);
    setStats({ correct: 0, total: 0 });
    setDone(false);
    setShowIntro(true);
    setReviewPly(null);
    // Auto-play the opponent's moves until it's your turn (or the line ends).
    let p = 0;
    while (p < line.length && game.turn() !== userColor) {
      const edge = line[p]!;
      game.move({ from: edge.u.slice(0, 2), to: edge.u.slice(2, 4), promotion: (edge.u[4] as "q") ?? undefined });
      p++;
    }
    setPly(p);
    setFen(game.fen());
    setLastMove(p > 0 ? uciToSquares(line[p - 1]!.u) : undefined);
    if (p >= line.length) setDone(true);
  }, [line, userColor]);

  useEffect(() => {
    restart();
    return () => window.clearTimeout(replyTimer.current);
  }, [restart]);

  // Persist a training result once, when a line is finished, so the account page
  // can track how much each opening has been practised.
  useEffect(() => {
    if (!done || recordedRef.current || stats.total === 0) return;
    recordedRef.current = true;
    const session = peekSession();
    if (!session) return;
    void recordTrainingResult({
      username: session.username,
      color,
      family: lineFamily,
      lineUci: line.map((e) => e.u).join(" "),
      correct: stats.correct,
      total: stats.total,
      reveals: revealsRef.current,
    });
  }, [done, stats, color, lineFamily, line]);

  /** After the user's move has rendered, wait a beat, then play the opponent's
   *  reply as its own board update. Two single-ply updates means the board plays
   *  a sound for each move and the reply feels like a real response. */
  const scheduleReplies = (fromPly: number) => {
    window.clearTimeout(replyTimer.current);
    if (fromPly >= line.length) {
      setPly(fromPly);
      setDone(true);
      return;
    }
    if (gameRef.current.turn() === userColor) {
      setPly(fromPly);
      return;
    }
    replyTimer.current = window.setTimeout(() => {
      const game = gameRef.current;
      let p = fromPly;
      while (p < line.length && game.turn() !== userColor) {
        const edge = line[p]!;
        game.move({ from: edge.u.slice(0, 2), to: edge.u.slice(2, 4), promotion: (edge.u[4] as "q") ?? undefined });
        p++;
      }
      setPly(p);
      setFen(game.fen());
      setLastMove(uciToSquares(line[p - 1]!.u));
      setWrongHere(false);
      if (p >= line.length) setDone(true);
    }, 340);
  };

  const revealAndAdvance = () => {
    const game = gameRef.current;
    if (done || game.turn() !== userColor || ply >= line.length) return;
    const edge = line[ply]!;
    revealsRef.current += 1;
    game.move({ from: edge.u.slice(0, 2), to: edge.u.slice(2, 4), promotion: (edge.u[4] as "q") ?? undefined });
    setStats((s) => ({ correct: s.correct, total: s.total + 1 }));
    setFeedback({ status: "correct", expectedSan: edge.s, text: explainEdge(edge) });
    setSelected(null);
    setTargets([]);
    setLastMove(uciToSquares(edge.u));
    setFen(game.fen());
    scheduleReplies(ply + 1);
  };

  const selectSquare = (sq: number) => {
    const moves = gameRef.current.moves({ square: algFromSq(sq) as never, verbose: true }) as Array<{ to: string }>;
    setSelected(sq);
    setTargets(moves.map((m) => sqFromAlg(m.to)));
  };

  /** Attempt the user's move (from click or drag). Returns true when accepted so
   *  a dragged piece stays put; a wrong move returns false and snaps back. */
  const tryMove = (fromSq: number, toSq: number): boolean => {
    const game = gameRef.current;
    if (done || game.turn() !== userColor || ply >= line.length) return false;
    const from = algFromSq(fromSq);
    const to = algFromSq(toSq);
    let move: { from: string; to: string; promotion?: string; san: string } | null = null;
    try {
      move = new Chess(game.fen()).move({ from, to, promotion: "q" });
    } catch {
      return false;
    }
    if (!move) return false;
    const uci = move.from + move.to + (move.promotion ?? "");
    const expected = line[ply]!;
    if (uci === expected.u) {
      game.move({ from, to, promotion: "q" });
      setStats((s) => ({ correct: s.correct + (wrongHere ? 0 : 1), total: s.total + 1 }));
      setFeedback({ status: "correct", expectedSan: expected.s, text: explainEdge(expected) });
      setSelected(null);
      setTargets([]);
      setShowIntro(false);
      setLastMove([fromSq, toSq]);
      setFen(game.fen());
      scheduleReplies(ply + 1);
      return true;
    }
    const secondMiss = wrongHere;
    setWrongHere(true);
    setFeedback({
      status: "wrong",
      expectedSan: expected.s,
      reveal: secondMiss,
      text: secondMiss
        ? `The move here is ${expected.s} — follow the green arrow, or reveal & continue.`
        : `${move.san} isn't your line here. Take another look and try again.`,
    });
    setSelected(null);
    setTargets([]);
    return false;
  };

  const onSquareClick = (sq: number) => {
    const game = gameRef.current;
    if (done || game.turn() !== userColor || ply >= line.length) return;
    const piece = game.get(algFromSq(sq) as never) as { color: string } | undefined;
    if (selected != null) {
      if (targets.includes(sq)) {
        tryMove(selected, sq);
        return;
      }
      if (piece && piece.color === userColor) {
        selectSquare(sq);
        return;
      }
      setSelected(null);
      setTargets([]);
      return;
    }
    if (piece && piece.color === userColor) selectSquare(sq);
  };

  const arrows: BoardArrow[] | undefined =
    feedback?.status === "wrong" && feedback.reveal && ply < line.length
      ? [{ from: uciToSquares(line[ply]!.u)[0], to: uciToSquares(line[ply]!.u)[1], color: "var(--color-win)" }]
      : undefined;

  const yourTurn = !done && gameRef.current.turn() === userColor && ply < line.length;
  const userMoves = line.filter((_, i) => (i % 2 === 0 ? "w" : "b") === userColor).length;

  if (!graph || line.length < 2) {
    return (
      <div className="relative z-10 min-h-dvh">
        <TopNav current="openings" />
        <main className="play-shell">
          <div className="panel mx-auto max-w-lg p-8 text-center">
            <h1 className="text-xl font-black">Not enough to train yet</h1>
            <p className="mt-3 text-sm text-ink-muted">
              There isn't a long enough line in your {color} games here. Import more games or pick a
              different opening.
            </p>
            <Link to={`/openings?color=${color}`} className="primary-button mt-6 inline-flex">
              Back to the explorer
            </Link>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="relative z-10 min-h-dvh">
      <TopNav
        current="openings"
        back={{ to: `/openings?color=${color}`, label: "Explorer" }}
      />
      <main className="play-shell">
        <header className="play-header">
          <div>
            <p className="eyebrow">Repertoire trainer</p>
            <h1>{family ? `Drill your ${family}` : `Drill your ${color} repertoire`}</h1>
            <p>Play the moves you'd choose. Tempo checks each against the line you actually play, and explains why.</p>
          </div>
        </header>

        <div className="play-workspace">
          <div className="play-board-col">
            <div className="explorer-board-frame">
              <Board
                fen={done && reviewFen ? reviewFen : fen}
                flip={flip}
                lastMove={
                  done && reviewPly != null
                    ? reviewPly > 0
                      ? uciToSquares(line[reviewPly - 1]!.u)
                      : undefined
                    : lastMove
                }
                arrows={done ? undefined : arrows}
                light={theme.light}
                dark={theme.dark}
                pieceSet={pieceSet}
                onSquareClick={onSquareClick}
                onMove={tryMove}
                selected={selected}
                targets={targets}
                interactive={yourTurn}
                silent={done}
              />
            </div>
            <div className="train-progress">
              <span className="train-progress-track" aria-hidden="true">
                <i style={{ width: `${Math.min(100, (ply / Math.max(1, line.length)) * 100)}%` }} />
              </span>
              <span className="metric">{stats.correct}/{stats.total} correct · {userMoves} moves in this line</span>
            </div>
            {yourTurn ? <MoveInput fen={fen} onMove={tryMove} /> : null}
          </div>

          <div className="play-side">
            {done ? (
              <div className="train-result">
                <div className="train-result-head">
                  <strong>Line complete</strong>
                  <span className="train-score">
                    {stats.correct}/{stats.total}
                    {stats.total ? ` · ${Math.round((stats.correct / stats.total) * 100)}%` : ""}
                  </span>
                </div>
                <p>Here's the {lineFamily ?? "line"} you drilled — tap a move to review the position.</p>
                <ol className="train-movelist">
                  {Array.from({ length: Math.ceil(line.length / 2) }, (_, r) => {
                    const wi = r * 2;
                    const bi = r * 2 + 1;
                    const isUser = (i: number) => (i % 2 === 0 ? "w" : "b") === userColor;
                    return (
                      <li key={r}>
                        <span className="mv-num">{r + 1}.</span>
                        <button
                          type="button"
                          className={`mv ${isUser(wi) ? "is-user" : ""} ${reviewPly === wi + 1 ? "is-active" : ""}`}
                          onClick={() => setReviewPly(wi + 1)}
                        >
                          {line[wi]!.s}
                        </button>
                        {line[bi] ? (
                          <button
                            type="button"
                            className={`mv ${isUser(bi) ? "is-user" : ""} ${reviewPly === bi + 1 ? "is-active" : ""}`}
                            onClick={() => setReviewPly(bi + 1)}
                          >
                            {line[bi]!.s}
                          </button>
                        ) : null}
                      </li>
                    );
                  })}
                </ol>
                <div className="play-actions">
                  <button type="button" className="primary-button" onClick={() => setNonce((n) => n + 1)}>
                    New line
                  </button>
                  {lineFamily && lessonForFamily(lineFamily, color) ? (
                    <Link to={`/lessons/${lessonForFamily(lineFamily, color)!.slug}`} className="secondary-button inline-flex items-center">
                      Take the lesson
                    </Link>
                  ) : (
                    <Link to={`/openings?color=${color}`} className="secondary-button inline-flex items-center">
                      Back to the explorer
                    </Link>
                  )}
                </div>
              </div>
            ) : showIntro ? (
              <div className="train-intro">
                <p className="eyebrow">Your line</p>
                <strong>{lineFamily ?? `Your ${color} repertoire`}</strong>
                {lineFamily ? (
                  <p>{openingLesson(lineFamily).summary}</p>
                ) : (
                  <p>A line drawn straight from your own games.</p>
                )}
                <p className="train-intro-open">
                  {ply > 0 ? (
                    <>
                      Opens <b>{line.slice(0, ply).map((e, i) => `${movePrefix(i)}${e.s}`).join(" ")}</b>.{" "}
                    </>
                  ) : null}
                  Your first move is <b>{movePrefix(ply)}{line[ply]!.s}</b>.
                </p>
                <div className="train-depth" role="group" aria-label="Drill length">
                  {(["quick", "standard", "deep"] as Depth[]).map((d) => (
                    <button
                      key={d}
                      type="button"
                      className={`train-depth-opt ${depth === d ? "is-active" : ""}`}
                      onClick={() => setDrillDepth(d)}
                      aria-pressed={depth === d}
                    >
                      {d === "quick" ? "Quick" : d === "standard" ? "Standard" : "Deep"}
                    </button>
                  ))}
                </div>
                <button type="button" className="primary-button" onClick={() => setShowIntro(false)}>
                  Start drilling → <span className="train-depth-count">{userMoves} moves</span>
                </button>
              </div>
            ) : (
              <>
                <div className={`train-prompt ${feedback?.status === "wrong" ? "is-wrong" : feedback?.status === "correct" ? "is-correct" : ""}`}>
                  {feedback ? (
                    <>
                      <strong>
                        {feedback.status === "correct"
                          ? `✓ ${feedback.expectedSan}`
                          : feedback.reveal
                            ? `✗ Your move is ${feedback.expectedSan}`
                            : "✗ Not your line"}
                      </strong>
                      <p>{feedback.text}</p>
                    </>
                  ) : yourTurn ? (
                    <>
                      <strong>Your move</strong>
                      <p>Play the move you'd choose in this position.</p>
                    </>
                  ) : (
                    <>
                      <strong>Opponent to move</strong>
                      <p>Watch the reply, then it's your turn.</p>
                    </>
                  )}
                </div>
                {feedback?.status === "wrong" ? (
                  <div className="play-actions">
                    <button type="button" className="secondary-button" onClick={() => setFeedback(null)}>
                      Try again
                    </button>
                    <button type="button" className="primary-button" onClick={revealAndAdvance}>
                      Reveal &amp; continue
                    </button>
                  </div>
                ) : null}
                <div className="play-actions">
                  <button type="button" className="secondary-button" onClick={() => setNonce((n) => n + 1)}>
                    New line
                  </button>
                </div>
              </>
            )}
            {lineFamily ? (
              <p className="train-tip">
                <b>Plan — {lineFamily}:</b> {openingLesson(lineFamily).ideas[0]}
              </p>
            ) : null}
          </div>
        </div>
      </main>
    </div>
  );
}

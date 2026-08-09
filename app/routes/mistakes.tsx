import { useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { Chess } from "chess.js";
import type { Route } from "./+types/mistakes";
import { Board } from "../components/Board";
import { MoveInput } from "../components/MoveInput";
import { TopNav } from "../components/TopNav";
import { RouteError } from "../components/RouteError";
import { requireSession } from "../lib/session";
import { loadBoardTheme } from "../lib/boardThemes";
import { loadPieceSet } from "../lib/pieceSets";
import { fetchMistakes, type MistakeDrill } from "../lib/account";
import { usePrimaryActionKeys } from "../lib/usePrimaryActionKeys";

export function meta() {
  return [{ title: "Fix your mistakes · Tempo" }];
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <RouteError title="Mistakes unavailable" error={error} />;
}

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const session = await requireSession();
  const url = new URL(request.url);
  const color = url.searchParams.get("color") === "black" ? "black" : "white";
  const drills = await fetchMistakes(session.username, color);
  return { drills, color: color as "white" | "black" };
}

const algFromSq = (sq: number) => String.fromCharCode(97 + (sq % 8)) + (Math.floor(sq / 8) + 1);
const sqFromAlg = (alg: string) => (Number(alg[1]) - 1) * 8 + (alg.charCodeAt(0) - 97);
const uciToSquares = (uci: string): [number, number] => [sqFromAlg(uci.slice(0, 2)), sqFromAlg(uci.slice(2, 4))];
const sanOf = (fen: string, uci: string): string => {
  try {
    const g = new Chess(fen);
    const m = g.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: (uci[4] as "q") ?? undefined });
    return m?.san ?? uci;
  } catch {
    return uci;
  }
};
const evalPawns = (cp: number | null): string => (cp == null ? "" : `−${(Math.round(cp / 10) / 10).toFixed(1)}`);

export default function Mistakes({ loaderData }: Route.ComponentProps) {
  const { drills, color } = loaderData;
  const theme = useMemo(() => loadBoardTheme(), []);
  const pieceSet = useMemo(() => loadPieceSet(), []);
  const flip = color === "black";
  usePrimaryActionKeys();

  const [index, setIndex] = useState(0);
  const [solved, setSolved] = useState(false);
  const [feedback, setFeedback] = useState<{ status: "correct" | "wrong"; text: string; reveal?: boolean } | null>(null);
  const [wrongCount, setWrongCount] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [targets, setTargets] = useState<number[]>([]);
  const [score, setScore] = useState(0);
  const advancingRef = useRef(false);

  const drill: MistakeDrill | undefined = drills[index];
  const done = index >= drills.length;
  const bestSan = drill ? sanOf(drill.fen, drill.bestUci) : "";
  const moveNumber = drill ? Math.floor(drill.ply / 2) + 1 : 0;

  const reset = (nextIndex: number) => {
    advancingRef.current = false;
    setIndex(nextIndex);
    setSolved(false);
    setFeedback(null);
    setWrongCount(0);
    setSelected(null);
    setTargets([]);
  };

  const selectSquare = (sq: number) => {
    if (!drill || solved) return;
    const moves = new Chess(drill.fen).moves({ square: algFromSq(sq) as never, verbose: true }) as Array<{ to: string }>;
    setSelected(sq);
    setTargets(moves.map((m) => sqFromAlg(m.to)));
  };

  const tryMove = (fromSq: number, toSq: number): boolean => {
    if (!drill || solved) return false;
    let move: { from: string; to: string; promotion?: string } | null = null;
    try {
      move = new Chess(drill.fen).move({ from: algFromSq(fromSq), to: algFromSq(toSq), promotion: "q" });
    } catch {
      return false;
    }
    if (!move) return false;
    const uci = move.from + move.to + (move.promotion ?? "");
    setSelected(null);
    setTargets([]);
    if (uci === drill.bestUci) {
      if (wrongCount === 0) setScore((s) => s + 1);
      setSolved(true);
      setFeedback({ status: "correct", text: `The engine's move — ${evalPawns(drill.lossCp)} better than the ${drill.playedSan} you played.` });
      return true;
    }
    const secondMiss = wrongCount >= 1;
    setWrongCount((w) => w + 1);
    setFeedback({
      status: "wrong",
      reveal: secondMiss,
      text: secondMiss ? `The move is ${bestSan} — follow the green arrow.` : "Not the engine's choice. Look for the move that keeps your advantage.",
    });
    return false;
  };

  const onSquareClick = (sq: number) => {
    if (!drill || solved) return;
    const mover = drill.fen.split(" ")[1] === "b" ? "b" : "w";
    const piece = new Chess(drill.fen).get(algFromSq(sq) as never) as { color: string } | undefined;
    if (selected != null) {
      if (targets.includes(sq)) return void tryMove(selected, sq);
      if (piece && piece.color === mover) return void selectSquare(sq);
      setSelected(null);
      setTargets([]);
      return;
    }
    if (piece && piece.color === mover) selectSquare(sq);
  };

  const reveal = () => {
    if (!drill) return;
    setSolved(true);
    setFeedback({ status: "correct", text: `The engine's move is ${bestSan}. Play it a few times to make it a habit.` });
  };

  const next = () => {
    if (advancingRef.current) return;
    advancingRef.current = true;
    reset(index + 1);
  };

  const boardFen = drill ? drill.fen : drills[drills.length - 1]?.fen ?? "8/8/8/8/8/8/8/8 w - - 0 1";
  const arrows = feedback?.reveal && drill ? [{ from: uciToSquares(drill.bestUci)[0], to: uciToSquares(drill.bestUci)[1], color: "var(--color-win)" }] : undefined;
  const lastMove = solved && drill ? uciToSquares(drill.bestUci) : undefined;

  return (
    <div className="relative z-10 min-h-dvh">
      <TopNav current="account" back={{ to: "/account", label: "Account" }} />
      <main className="play-shell">
        <header className="play-header">
          <div>
            <p className="eyebrow">Fix your mistakes</p>
            <h1>Drill your {color} slip-ups</h1>
            <p>These are the openings moments where the engine found a clearly better move than the one you played. Find the improvement and lock it in.</p>
          </div>
        </header>

        {drills.length === 0 ? (
          <div className="account-empty mt-8">
            <p>No {color} mistakes to drill right now — either you've been playing cleanly, or Tempo hasn't analysed enough {color} games yet. Try the other side, or come back after importing more games.</p>
            <Link to={`/mistakes?color=${color === "white" ? "black" : "white"}`} className="primary-button mt-4 inline-flex">Try your {color === "white" ? "black" : "white"} mistakes →</Link>
          </div>
        ) : (
          <div className="play-workspace">
            <div className="play-board-col">
              <div className="explorer-board-frame">
                <Board
                  fen={boardFen}
                  flip={flip}
                  lastMove={lastMove}
                  arrows={arrows}
                  light={theme.light}
                  dark={theme.dark}
                  pieceSet={pieceSet}
                  onSquareClick={onSquareClick}
                  onMove={tryMove}
                  selected={selected}
                  targets={targets}
                  interactive={!done && !solved}
                />
              </div>
              <div className="train-progress">
                <span className="train-progress-track" aria-hidden="true">
                  <i style={{ width: `${drills.length ? (Math.min(index, drills.length) / drills.length) * 100 : 0}%` }} />
                </span>
                <span className="metric">{done ? drills.length : index + 1} of {drills.length} · {score} first-try</span>
              </div>
              {!done && !solved && drill ? <MoveInput fen={drill.fen} onMove={tryMove} /> : null}
            </div>

            <div className="play-side">
              {done ? (
                <div className="train-result">
                  <div className="train-result-head">
                    <strong>Session complete</strong>
                    <span className="train-score">{score}/{drills.length}</span>
                  </div>
                  <p>You found the engine's move first try in {score} of {drills.length} positions. Come back after more games to keep sharpening.</p>
                  <div className="play-actions">
                    <button type="button" className="primary-button" onClick={() => { setScore(0); reset(0); }}>Again</button>
                    <Link to="/account" className="secondary-button inline-flex items-center">Back to account</Link>
                  </div>
                </div>
              ) : drill ? (
                <>
                  <div className={`train-prompt ${feedback?.status === "wrong" ? "is-wrong" : feedback?.status === "correct" ? "is-correct" : ""}`}>
                    {feedback ? (
                      <>
                        <strong>{feedback.status === "correct" ? `✓ ${bestSan}` : feedback.reveal ? `Play ${bestSan}` : "Try again"}</strong>
                        <p>{feedback.text}</p>
                      </>
                    ) : (
                      <>
                        <strong>Your move — find better than {drill.playedSan}</strong>
                        <p>
                          {drill.openingName ? `${drill.openingName}, ` : ""}move {moveNumber}. In a real game you played <b>{drill.playedSan}</b>
                          {drill.lossCp != null ? ` and lost about ${(Math.round(drill.lossCp / 10) / 10).toFixed(1)} pawns` : ""}. What was better?
                        </p>
                      </>
                    )}
                  </div>
                  {feedback?.status === "wrong" ? (
                    <div className="play-actions">
                      <button type="button" className="secondary-button" onClick={() => setFeedback(null)}>Try again</button>
                      <button type="button" className="primary-button" onClick={reveal}>Show me</button>
                    </div>
                  ) : solved ? (
                    <div className="play-actions">
                      <button type="button" className="primary-button" onClick={next}>{index + 1 >= drills.length ? "Finish →" : "Next →"}</button>
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

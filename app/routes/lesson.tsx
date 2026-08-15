import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { Chess } from "chess.js";
import type { Route } from "./+types/lesson";
import { Board } from "../components/Board";
import { MoveInput } from "../components/MoveInput";
import { RichText } from "../components/RichText";
import { TopNav } from "../components/TopNav";
import { requireSession } from "../lib/session";
import { loadBoardTheme } from "../lib/boardThemes";
import { loadPieceSet } from "../lib/pieceSets";
import { saveLessonProgress } from "../lib/account";
import { getLesson } from "../lib/lessons";
import { RouteError } from "../components/RouteError";
import { usePrimaryActionKeys } from "../lib/usePrimaryActionKeys";

export function meta() {
  return [{ title: "Lesson · Forma" }];
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <RouteError title="Lesson unavailable" error={error} />;
}

export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  const session = await requireSession();
  const lesson = getLesson(params.slug);
  return { lesson, username: session.username };
}

const algFromSq = (sq: number) => String.fromCharCode(97 + (sq % 8)) + (Math.floor(sq / 8) + 1);
const sqFromAlg = (alg: string) => (Number(alg[1]) - 1) * 8 + (alg.charCodeAt(0) - 97);

export default function LessonPlayer({ loaderData }: Route.ComponentProps) {
  const { lesson, username } = loaderData;
  const theme = useMemo(() => loadBoardTheme(), []);
  const pieceSet = useMemo(() => loadPieceSet(), []);
  const flip = lesson?.color === "black";

  const [phase, setPhase] = useState<"intro" | "playing" | "done">("intro");
  const [stepIndex, setStepIndex] = useState(0);
  const [played, setPlayed] = useState(false);
  const [feedback, setFeedback] = useState<{ status: "correct" | "wrong"; text: string; reveal?: boolean } | null>(null);
  const [wrongCount, setWrongCount] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [targets, setTargets] = useState<number[]>([]);
  const [score, setScore] = useState(0);
  const timer = useRef<number | undefined>(undefined);
  const savedRef = useRef(false);
  const advancingRef = useRef(false);
  usePrimaryActionKeys();

  const steps = lesson?.steps ?? [];
  const step = steps[stepIndex];
  const total = lesson?.interactiveCount ?? 0;
  const answered = useMemo(() => steps.slice(0, stepIndex).filter((s) => s.interactive).length, [steps, stepIndex]);

  // Auto-play the shown (non-learner) moves after a brief beat so the board animates.
  useEffect(() => {
    window.clearTimeout(timer.current);
    advancingRef.current = false;
    setPlayed(false);
    setFeedback(null);
    setWrongCount(0);
    setSelected(null);
    setTargets([]);
    if (phase !== "playing" || !step) return;
    if (!step.interactive) {
      // Set played + explanation together so the board only renders (and animates)
      // once — a second render mid-animation makes the piece reverse then replay.
      timer.current = window.setTimeout(() => {
        setPlayed(true);
        setFeedback({ status: "correct", text: step.explain });
      }, 420);
    }
    return () => window.clearTimeout(timer.current);
  }, [stepIndex, phase, step]);

  useEffect(() => {
    if (phase !== "done" || savedRef.current) return;
    savedRef.current = true;
    if (lesson) {
      void saveLessonProgress({
        username,
        slug: lesson.slug,
        completedSteps: total,
        totalSteps: total,
        bestScore: score,
        completed: true,
      });
    }
  }, [phase, lesson, username, total, score]);

  if (!lesson) {
    return (
      <div className="relative z-10 min-h-dvh">
        <TopNav current="lessons" />
        <main className="play-shell">
          <div className="panel mx-auto max-w-lg p-8 text-center">
            <h1 className="text-xl font-black">Lesson not found</h1>
            <Link to="/lessons" className="primary-button mt-6 inline-flex">Back to lessons</Link>
          </div>
        </main>
      </div>
    );
  }

  const boardFen = played && step ? step.fenAfter : step ? step.fenBefore : steps[steps.length - 1]?.fenAfter ?? "";
  const lastMove: [number, number] | undefined = played && step
    ? [step.from, step.to]
    : stepIndex > 0
      ? [steps[stepIndex - 1]!.from, steps[stepIndex - 1]!.to]
      : undefined;
  const arrows = feedback?.reveal && step && !played ? [{ from: step.from, to: step.to, color: "var(--color-win)" }] : undefined;

  const learnerTurn = phase === "playing" && !!step && step.interactive && !played;

  const selectSquare = (sq: number) => {
    if (!step) return;
    const moves = new Chess(step.fenBefore).moves({ square: algFromSq(sq) as never, verbose: true }) as Array<{ to: string }>;
    setSelected(sq);
    setTargets(moves.map((m) => sqFromAlg(m.to)));
  };

  const tryMove = (fromSq: number, toSq: number): boolean => {
    if (!learnerTurn || !step) return false;
    let move: { from: string; to: string; promotion?: string; san: string } | null = null;
    try {
      move = new Chess(step.fenBefore).move({ from: algFromSq(fromSq), to: algFromSq(toSq), promotion: "q" });
    } catch {
      return false;
    }
    if (!move) return false;
    const uci = move.from + move.to + (move.promotion ?? "");
    if (uci === step.uci) {
      if (wrongCount === 0) setScore((s) => s + 1);
      setSelected(null);
      setTargets([]);
      setPlayed(true);
      setFeedback({ status: "correct", text: step.explain });
      return true;
    }
    const secondMiss = wrongCount >= 1;
    setWrongCount((w) => w + 1);
    setSelected(null);
    setTargets([]);
    setFeedback({
      status: "wrong",
      reveal: secondMiss,
      text: secondMiss
        ? `The move is ${step.san} — follow the green arrow.`
        : `Not the move this line wants. Think about the plan and try again.`,
    });
    return false;
  };

  const onSquareClick = (sq: number) => {
    if (!learnerTurn || !step) return;
    const piece = new Chess(step.fenBefore).get(algFromSq(sq) as never) as { color: string } | undefined;
    const mover = step.by === "white" ? "w" : "b";
    if (selected != null) {
      if (targets.includes(sq)) {
        tryMove(selected, sq);
        return;
      }
      if (piece && piece.color === mover) {
        selectSquare(sq);
        return;
      }
      setSelected(null);
      setTargets([]);
      return;
    }
    if (piece && piece.color === mover) selectSquare(sq);
  };

  const revealMove = () => {
    if (!step) return;
    setPlayed(true);
    setFeedback({ status: "correct", text: step.explain });
  };

  const advance = () => {
    if (advancingRef.current) return;
    advancingRef.current = true;
    if (stepIndex + 1 >= steps.length) setPhase("done");
    else setStepIndex((i) => i + 1);
  };

  return (
    <div className="relative z-10 min-h-dvh">
      <TopNav current="lessons" back={{ to: "/lessons", label: "Lessons" }} />
      <main className="play-shell">
        <header className="play-header">
          <div>
            <p className="eyebrow">{lesson.family} · lesson</p>
            <h1>{lesson.title}</h1>
            <p>{lesson.subtitle}</p>
          </div>
        </header>

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
                interactive={learnerTurn}
              />
            </div>
            {phase === "playing" ? (
              <div className="train-progress">
                <span className="train-progress-track" aria-hidden="true">
                  <i style={{ width: `${total ? (answered / total) * 100 : 0}%` }} />
                </span>
                <span className="metric">Move {answered} of {total} · {score} first-try</span>
              </div>
            ) : null}
            {learnerTurn ? <MoveInput fen={step!.fenBefore} onMove={tryMove} /> : null}
          </div>

          <div className="play-side">
            {phase === "intro" ? (
              <div className="train-intro lesson-intro-card">
                <p className="eyebrow">Lesson</p>
                <strong>{lesson.title}</strong>
                <p><RichText text={lesson.intro} /></p>
                {lesson.ideas.length ? (
                  <ul className="lesson-ideas">
                    {lesson.ideas.map((idea, i) => (
                      <li key={i}><RichText text={idea} /></li>
                    ))}
                  </ul>
                ) : null}
                <button type="button" className="primary-button" onClick={() => setPhase("playing")}>
                  Start lesson →
                </button>
              </div>
            ) : phase === "done" ? (
              <div className="train-result">
                <div className="train-result-head">
                  <strong>Lesson complete</strong>
                  <span className="train-score">{score}/{total}</span>
                </div>
                <p>
                  You found {score} of the {total} key moves on the first try. Play it again to lock it in, or
                  drill it against real replies in the trainer.
                </p>
                <div className="play-actions">
                  <button type="button" className="primary-button" onClick={() => { setPhase("intro"); setStepIndex(0); setScore(0); savedRef.current = false; }}>
                    Play again
                  </button>
                  <Link to={`/train?color=${lesson.color}&family=${encodeURIComponent(lesson.family)}`} className="secondary-button inline-flex items-center">
                    Drill this line
                  </Link>
                </div>
                <Link to="/lessons" className="lesson-back">← All lessons</Link>
              </div>
            ) : (
              <>
                <div className={`train-prompt lesson-prompt ${feedback?.status === "wrong" ? "is-wrong" : feedback?.status === "correct" ? "is-correct" : ""}`}>
                  {feedback ? (
                    <>
                      <strong>
                        {feedback.status === "correct" ? `${step?.by === lesson.color ? "✓" : "→"} ${step?.san}` : feedback.reveal ? `The move is ${step?.san}` : "Try again"}
                      </strong>
                      <p><RichText text={feedback.text} /></p>
                    </>
                  ) : learnerTurn ? (
                    <>
                      <strong>Your move</strong>
                      <p><RichText text={step?.ask ?? "Play the move this line calls for."} /></p>
                    </>
                  ) : (
                    <>
                      <strong>{step?.by === "white" ? "White" : "Black"} to play</strong>
                      <p>Watch the reply.</p>
                    </>
                  )}
                </div>
                {feedback?.status === "wrong" ? (
                  <div className="play-actions">
                    <button type="button" className="secondary-button" onClick={() => { setFeedback(null); setWrongCount((w) => Math.max(w, 1)); }}>
                      Try again
                    </button>
                    <button type="button" className="primary-button" onClick={revealMove}>
                      Show me
                    </button>
                  </div>
                ) : played ? (
                  <div className="play-actions">
                    <button type="button" className="primary-button" onClick={advance}>
                      {stepIndex + 1 >= steps.length ? "Finish →" : "Continue →"}
                    </button>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

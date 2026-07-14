import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { Chess } from "chess.js";
import type { GameData, Ply, Judgment } from "../lib/game";
import { fenAt } from "../lib/game";
import { analyzeGameLocally } from "../lib/analyze";
import { explainMove } from "../lib/motifs";
import { BOARD_THEMES, loadBoardTheme, saveBoardTheme, type BoardTheme } from "../lib/boardThemes";
import { Chessboard } from "./Chessboard";

const JUDGMENT: Record<Judgment, { glyph: string; color: string }> = {
  Blunder: { glyph: "??", color: "var(--color-loss)" },
  Mistake: { glyph: "?", color: "var(--color-mistake)" },
  Inaccuracy: { glyph: "?!", color: "var(--color-inaccuracy)" },
};

function evalNum(p: Ply): number | null {
  if (p.mate !== undefined) return p.mate > 0 ? 1000 : -1000;
  if (p.evalCp !== undefined) return p.evalCp;
  return null;
}

function formatEval(p: Ply | null | undefined): string {
  if (!p) return "";
  if (p.mate !== undefined) return `M${Math.abs(p.mate)}`;
  if (p.evalCp !== undefined) {
    const v = p.evalCp / 100;
    return `${v > 0 ? "+" : ""}${v.toFixed(1)}`;
  }
  return "";
}

function uciToSan(fen: string, uci?: string): string | undefined {
  if (!uci) return undefined;
  try {
    const c = new Chess(fen);
    const m = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    return m?.san ?? uci;
  } catch {
    return uci;
  }
}

const sqIndex = (alg: string) => (Number(alg[1]) - 1) * 8 + (alg.charCodeAt(0) - 97);
function moveSquares(uci?: string): [number, number] | undefined {
  if (!uci || uci.length < 4) return undefined;
  return [sqIndex(uci.slice(0, 2)), sqIndex(uci.slice(2, 4))];
}

function keypointPlies(plies: Ply[]): Set<number> {
  const swings: { ply: number; swing: number }[] = [];
  let prev = 0;
  for (const p of plies) {
    const e = evalNum(p);
    if (e === null) continue;
    swings.push({ ply: p.ply, swing: Math.abs(e - prev) });
    prev = e;
  }
  return new Set(
    swings.filter((s) => s.swing >= 150).sort((a, b) => b.swing - a.swing).slice(0, 8).map((s) => s.ply),
  );
}

// ---------------------------------------------------------------------------
// The vertical eval spine: white moves left, black moves right, the evaluation
// curve running down the middle. Zoomed (one row per ply) so it scrolls.
// ---------------------------------------------------------------------------
const ROW = 30;
const SPINE = 88;
const MAXCP = 600;

function Glyph({ j }: { j?: Ply["judgment"] }) {
  if (!j) return null;
  const s = JUDGMENT[j.name];
  return <sup className="font-semibold" style={{ color: s.color }}>{s.glyph}</sup>;
}

function EvalTimeline({
  plies,
  current,
  keypoints,
  hasAnalysis,
  onSeek,
}: {
  plies: Ply[];
  current: number;
  keypoints: Set<number>;
  hasAnalysis: boolean;
  onSeek: (i: number) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const H = plies.length * ROW;
  const cx = SPINE / 2;
  const clampCp = (p: Ply) =>
    Math.max(-MAXCP, Math.min(MAXCP, p.mate !== undefined ? (p.mate > 0 ? MAXCP : -MAXCP) : (p.evalCp ?? 0)));
  const px = (cp: number) => cx + (cp / MAXCP) * (cx - 5);
  const py = (i: number) => i * ROW + ROW / 2;
  const pts = plies.map((p, i) => `${px(clampCp(p)).toFixed(1)},${py(i)}`).join(" ");

  useEffect(() => {
    const el = scroller.current;
    if (!el || current <= 0) return;
    const target = (current - 1) * ROW - el.clientHeight / 2 + ROW / 2;
    el.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  }, [current]);

  return (
    <div>
      <div className="mb-1.5 grid text-center" style={{ gridTemplateColumns: `1fr ${SPINE}px 1fr` }}>
        <span className="cap text-right">White</span>
        <span className="cap">eval</span>
        <span className="cap text-left">Black</span>
      </div>
      <div ref={scroller} className="relative h-[560px] overflow-y-auto rounded-panel border border-line">
        <div className="relative" style={{ height: H }}>
          {/* spine (behind the rows; center column is transparent so it shows) */}
          <svg
            className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2"
            width={SPINE}
            height={H}
            viewBox={`0 0 ${SPINE} ${H}`}
          >
            <line x1={cx} y1={0} x2={cx} y2={H} stroke="var(--color-line)" strokeWidth="1" />
            {hasAnalysis && plies.length > 1 && (
              <>
                <polygon points={`${cx},${py(0)} ${pts} ${cx},${py(plies.length - 1)}`} fill="var(--color-ink)" opacity="0.1" />
                <polyline points={pts} fill="none" stroke="var(--color-ink-muted)" strokeWidth="1.5" strokeLinejoin="round" />
                {plies.map((p, i) =>
                  keypoints.has(p.ply) ? (
                    <circle key={p.ply} cx={px(clampCp(p))} cy={py(i)} r="3" fill="var(--color-accent)" />
                  ) : null,
                )}
              </>
            )}
          </svg>

          {plies.map((p, i) => {
            const active = current === p.ply;
            const white = p.color === "white";
            const cell = `flex items-center gap-1.5 px-2 text-sm ${active ? "bg-surface-2" : ""}`;
            return (
              <button
                key={p.ply}
                type="button"
                onClick={() => onSeek(p.ply)}
                className="absolute inset-x-0 grid"
                style={{ top: i * ROW, height: ROW, gridTemplateColumns: `1fr ${SPINE}px 1fr` }}
              >
                <span className={`${cell} justify-end rounded-l-[5px]`}>
                  {white && (
                    <>
                      <span className={active ? "text-ink" : "text-ink-muted"}>
                        {p.moveNumber}. {p.san}
                        <Glyph j={p.judgment} />
                      </span>
                      {hasAnalysis && <span className="metric text-xs text-ink-faint">{formatEval(p)}</span>}
                    </>
                  )}
                </span>
                <span />
                <span className={`${cell} justify-start rounded-r-[5px]`}>
                  {!white && (
                    <>
                      {hasAnalysis && <span className="metric text-xs text-ink-faint">{formatEval(p)}</span>}
                      <span className={active ? "text-ink" : "text-ink-muted"}>
                        {p.san}
                        <Glyph j={p.judgment} />
                      </span>
                    </>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function NavButton({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="metric grid h-9 w-9 place-items-center rounded-control border border-line text-ink-muted transition-colors hover:border-line-strong hover:text-ink disabled:opacity-40 disabled:hover:border-line"
    >
      {children}
    </button>
  );
}

export function GameReview({ game }: { game: GameData }) {
  const [analyzed, setAnalyzed] = useState<GameData | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const g = analyzed ?? game;
  const n = g.plies.length;
  const [idx, setIdx] = useState(n);
  const [flip, setFlip] = useState(false);
  const [theme, setTheme] = useState<BoardTheme>(() => loadBoardTheme());
  const boardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") setIdx((i) => Math.max(0, i - 1));
      else if (e.key === "ArrowRight") setIdx((i) => Math.min(n, i + 1));
      else if (e.key === "Home") setIdx(0);
      else if (e.key === "End") setIdx(n);
      else if (e.key === "f") setFlip((f) => !f);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [n]);

  // Wheel over the board steps through moves (non-passive so we can preventDefault).
  useEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.deltaY > 0) setIdx((i) => Math.min(n, i + 1));
      else if (e.deltaY < 0) setIdx((i) => Math.max(0, i - 1));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [n]);

  const runAnalysis = async () => {
    setAnalyzing(true);
    setError(null);
    try {
      setAnalyzed(await analyzeGameLocally(game));
    } catch (e) {
      setError(`${(e as Error).message}. Is the local engine running on :8090?`);
    } finally {
      setAnalyzing(false);
    }
  };

  const setBoardTheme = (t: BoardTheme) => {
    setTheme(t);
    saveBoardTheme(t.id);
  };

  const keypoints = useMemo(() => keypointPlies(g.plies), [g.plies]);
  const current = idx > 0 ? g.plies[idx - 1] : null;
  const bestSan = current ? uciToSan(current.fenBefore, current.best) : undefined;
  const jComment = current?.judgment
    ? current.judgment.comment.replace(/^(Blunder|Mistake|Inaccuracy)[.:]?\s*/i, "")
    : "";
  const reason = useMemo(
    () => (current?.judgment ? explainMove(current.fenBefore, current.uci, current.best) : null),
    [current],
  );

  return (
    <div className="relative z-10 min-h-dvh">
      <header className="sticky top-0 z-30 border-b border-line bg-bg/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-[960px] items-center justify-between px-4 sm:px-6">
          <Link to="/" className="cap transition-colors hover:text-ink">← Report</Link>
          <a href={g.url} target="_blank" rel="noreferrer" className="cap transition-colors hover:text-ink">Lichess ↗</a>
        </div>
      </header>

      <main className="mx-auto max-w-[960px] px-4 pb-16 pt-6 sm:px-6">
        <div className="mb-5">
          <div className="cap mb-1.5">
            {g.speed ? `${g.speed} · ` : ""}
            {g.eco ? (
              <span title="ECO opening code">{g.eco}</span>
            ) : null}
            {g.eco ? " · " : ""}
            {g.opening ?? "Game"}
          </div>
          <h1 className="font-serif text-2xl leading-tight text-ink">
            {g.white.name} <span className="text-ink-faint">{g.white.rating ?? ""}</span>{" "}
            <span className="metric text-lg text-ink-muted">{g.result}</span>{" "}
            {g.black.name} <span className="text-ink-faint">{g.black.rating ?? ""}</span>
          </h1>
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          {/* BOARD COLUMN */}
          <div>
            <div className="flex items-start gap-2">
              <button
                type="button"
                onClick={() => setFlip((f) => !f)}
                title="Flip board (f)"
                className="metric mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-control border border-line text-ink-muted transition-colors hover:border-line-strong hover:text-ink"
              >
                ⇅
              </button>
              <div ref={boardRef} className="min-w-0 flex-1 touch-none">
                <Chessboard
                  fen={fenAt(g, idx)}
                  flip={flip}
                  light={theme.light}
                  dark={theme.dark}
                  lastMove={current ? moveSquares(current.uci) : undefined}
                />
              </div>
              {/* keep the board centered between the flip gutter and an equal spacer */}
              <div className="w-9 shrink-0" aria-hidden />
            </div>

            <div className="mt-3 flex items-center justify-center gap-2">
              <NavButton onClick={() => setIdx(0)} disabled={idx === 0}>⏮</NavButton>
              <NavButton onClick={() => setIdx(Math.max(0, idx - 1))} disabled={idx === 0}>◀</NavButton>
              <span className="metric w-16 text-center text-xs text-ink-faint">{idx} / {n}</span>
              <NavButton onClick={() => setIdx(Math.min(n, idx + 1))} disabled={idx === n}>▶</NavButton>
              <NavButton onClick={() => setIdx(n)} disabled={idx === n}>⏭</NavButton>
            </div>

            {!g.hasAnalysis && (
              <div className="mt-4 rounded-panel border border-line p-3">
                {analyzing ? (
                  <div className="flex items-center gap-3 text-sm text-ink-muted">
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-line border-t-accent" />
                    Grading {n} moves with Stockfish…
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm text-ink-muted">Not analyzed yet.</span>
                    <button
                      type="button"
                      onClick={runAnalysis}
                      className="rounded-control bg-accent px-3 py-1.5 text-sm font-semibold text-accent-ink transition-transform active:translate-y-px"
                    >
                      Analyze
                    </button>
                  </div>
                )}
                {error && <p className="mt-2 text-sm" style={{ color: "var(--color-loss)" }}>{error}</p>}
              </div>
            )}

            {/* current move / reason — fixed height so nothing shifts */}
            <div className="mt-4 min-h-[6rem] rounded-panel border border-line p-4">
              {current ? (
                <>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="metric text-sm text-ink">
                      {current.moveNumber}
                      {current.color === "white" ? "." : "..."} {current.san}
                    </span>
                    {current.judgment ? (
                      <span className="metric text-sm font-semibold" style={{ color: JUDGMENT[current.judgment.name].color }}>
                        {current.judgment.name} {JUDGMENT[current.judgment.name].glyph}
                      </span>
                    ) : (
                      <span className="metric text-sm text-ink-muted">{formatEval(current)}</span>
                    )}
                  </div>
                  {current.judgment && (
                    <>
                      {reason ? (
                        <p className="mt-1.5 text-sm text-ink">{reason.text}</p>
                      ) : jComment ? (
                        <p className="mt-1.5 text-sm text-ink-muted">{jComment}</p>
                      ) : null}
                      {bestSan && !reason?.text.includes(bestSan) && !jComment.includes(bestSan) && (
                        <p className="cap mt-2 normal-case tracking-normal">Best: {bestSan}</p>
                      )}
                    </>
                  )}
                </>
              ) : (
                <span className="text-sm text-ink-faint">
                  Starting position. Scroll on the board or use arrow keys to step through.
                </span>
              )}
            </div>

            <div className="mt-4 flex items-center gap-2">
              <span className="cap">Board</span>
              {BOARD_THEMES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  title={t.name}
                  onClick={() => setBoardTheme(t)}
                  className={`grid h-6 w-6 overflow-hidden rounded-[4px] border ${theme.id === t.id ? "border-accent" : "border-line"}`}
                  style={{ gridTemplateColumns: "1fr 1fr" }}
                >
                  <span style={{ background: t.light }} />
                  <span style={{ background: t.dark }} />
                </button>
              ))}
            </div>
          </div>

          {/* TIMELINE COLUMN */}
          <EvalTimeline plies={g.plies} current={idx} keypoints={keypoints} hasAnalysis={g.hasAnalysis} onSeek={setIdx} />
        </div>
      </main>
    </div>
  );
}

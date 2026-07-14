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
// The vertical eval spine. One row per ply, scroll-to-select (the centered ply
// is the active one). Containment gridlines show the size of the advantage.
// ---------------------------------------------------------------------------
const ROW = 34;
const SPINE = 120;
const MAXCP = 800;
const CX = SPINE / 2;
const px = (cp: number) => CX + (Math.max(-MAXCP, Math.min(MAXCP, cp)) / MAXCP) * (CX - 7);

function MoveText({ p, active }: { p: Ply; active: boolean }) {
  const j = p.judgment ? JUDGMENT[p.judgment.name] : null;
  const color = j ? j.color : active ? "var(--color-ink)" : "var(--color-ink-muted)";
  return (
    <span className={active ? "text-base font-semibold" : ""} style={{ color }}>
      {p.san}
      {j && <sup className="font-bold" style={{ color: j.color }}>{j.glyph}</sup>}
    </span>
  );
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
  const fromScroll = useRef(false);
  const programmatic = useRef(false);
  const ticking = useRef(false);
  const [pad, setPad] = useState(300);
  const H = plies.length * ROW;
  const py = (i: number) => i * ROW + ROW / 2;
  const clampCp = (p: Ply) => (p.mate !== undefined ? (p.mate > 0 ? MAXCP : -MAXCP) : (p.evalCp ?? 0));
  const pts = plies.map((p, i) => `${px(clampCp(p)).toFixed(1)},${py(i)}`).join(" ");

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setPad(Math.max(0, (el.clientHeight - ROW) / 2));
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (!el || current < 1) return;
    // Only snap-to-center when the change came from outside (nav/click/keys),
    // not when the user is scrolling the reel themselves.
    if (fromScroll.current) {
      fromScroll.current = false;
      return;
    }
    const target = (current - 1) * ROW;
    if (Math.abs(el.scrollTop - target) > 1) {
      programmatic.current = true;
      el.scrollTop = target;
    }
  }, [current, pad]);

  const onScroll = () => {
    if (ticking.current) return;
    ticking.current = true;
    requestAnimationFrame(() => {
      ticking.current = false;
      if (programmatic.current) {
        programmatic.current = false;
        return;
      }
      const el = scroller.current;
      if (!el) return;
      const centered = Math.max(1, Math.min(plies.length, Math.round(el.scrollTop / ROW) + 1));
      if (centered !== current) {
        fromScroll.current = true;
        onSeek(centered);
      }
    });
  };

  const cols = `2rem 1fr ${SPINE}px 1fr`;

  return (
    <div>
      <div className="mb-2 grid items-center" style={{ gridTemplateColumns: cols }}>
        <span />
        <span className="pr-2 text-right text-lg leading-none" style={{ color: "var(--color-ink)" }} title="White">
          ♟
        </span>
        <span className="cap text-center">eval</span>
        <span className="pl-2 text-lg leading-none" style={{ color: "var(--color-ink-faint)" }} title="Black">
          ♟
        </span>
      </div>

      <div ref={scroller} onScroll={onScroll} className="relative h-[76vh] overflow-y-auto">
        <div className="relative" style={{ height: pad * 2 + H }}>
          <svg
            className="pointer-events-none absolute left-1/2 -translate-x-1/2"
            style={{ top: pad }}
            width={SPINE}
            height={H}
            viewBox={`0 0 ${SPINE} ${H}`}
          >
            {[100, 300, 500].map((cp) =>
              [px(cp), px(-cp)].map((x, k) => (
                <line key={`${cp}-${k}`} x1={x} y1={0} x2={x} y2={H} stroke="var(--color-line)" strokeWidth="1" opacity={cp >= 500 ? 0.55 : 0.28} />
              )),
            )}
            <line x1={CX} y1={0} x2={CX} y2={H} stroke="var(--color-line-strong)" strokeWidth="1" />
            {hasAnalysis && plies.length > 1 && (
              <>
                <polygon points={`${CX},${py(0)} ${pts} ${CX},${py(plies.length - 1)}`} fill="var(--color-ink)" opacity="0.09" />
                <polyline points={pts} fill="none" stroke="var(--color-ink-muted)" strokeWidth="1.5" strokeLinejoin="round" />
                {plies.map((p, i) =>
                  keypoints.has(p.ply) ? <circle key={p.ply} cx={px(clampCp(p))} cy={py(i)} r="3" fill="var(--color-accent)" /> : null,
                )}
              </>
            )}
          </svg>

          {plies.map((p, i) => {
            const active = current === p.ply;
            const white = p.color === "white";
            return (
              <button
                key={p.ply}
                type="button"
                onClick={() => onSeek(p.ply)}
                className="absolute inset-x-0 grid items-center text-sm"
                style={{ top: pad + i * ROW, height: ROW, gridTemplateColumns: cols }}
              >
                <span className="metric pr-1 text-right text-xs text-ink-faint">{white ? `${p.moveNumber}.` : ""}</span>
                <span className={`flex items-baseline justify-end gap-1.5 rounded-l-[5px] px-2 ${active && white ? "bg-surface-2" : ""}`}>
                  {white && (
                    <>
                      <MoveText p={p} active={active} />
                      {active && hasAnalysis && <span className="metric text-xs text-ink-faint">{formatEval(p)}</span>}
                    </>
                  )}
                </span>
                <span />
                <span className={`flex items-baseline justify-start gap-1.5 rounded-r-[5px] px-2 ${active && !white ? "bg-surface-2" : ""}`}>
                  {!white && (
                    <>
                      {active && hasAnalysis && <span className="metric text-xs text-ink-faint">{formatEval(p)}</span>}
                      <MoveText p={p} active={active} />
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const boardRef = useRef<HTMLDivElement>(null);

  const goto = (i: number) => setIdx(Math.max(1, Math.min(n, i)));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") goto(idx - 1);
      else if (e.key === "ArrowRight") goto(idx + 1);
      else if (e.key === "Home") goto(1);
      else if (e.key === "End") goto(n);
      else if (e.key === "f") setFlip((f) => !f);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [idx, n]);

  useEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      goto(idx + (e.deltaY > 0 ? 1 : -1));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [idx, n]);

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

  const keypoints = useMemo(() => keypointPlies(g.plies), [g.plies]);
  const current = g.plies[idx - 1] ?? g.plies[g.plies.length - 1];
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
        <div className="mx-auto flex h-14 max-w-[1280px] items-center justify-between px-4 sm:px-6">
          <Link to="/" className="cap transition-colors hover:text-ink">← Report</Link>
          <a href={g.url} target="_blank" rel="noreferrer" className="cap transition-colors hover:text-ink">Lichess ↗</a>
        </div>
      </header>

      <main className="mx-auto max-w-[1280px] px-4 pb-10 pt-5 sm:px-6">
        <div className="mb-4">
          <div className="cap mb-1.5">
            {g.speed ? `${g.speed} · ` : ""}
            {g.eco ? <span title="ECO opening code">{g.eco}</span> : null}
            {g.eco ? " · " : ""}
            {g.opening ?? "Game"}
          </div>
          <h1 className="font-serif text-2xl leading-tight text-ink">
            {g.white.name} <span className="text-ink-faint">{g.white.rating ?? ""}</span>{" "}
            <span className="metric text-lg text-ink-muted">{g.result}</span>{" "}
            {g.black.name} <span className="text-ink-faint">{g.black.rating ?? ""}</span>
          </h1>
        </div>

        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,280px)_minmax(0,1fr)_minmax(0,360px)]">
          {/* EXPLANATION (left, opposite the timeline) */}
          <aside className="order-2 lg:order-1">
            {current?.judgment ? (
              <div className="rounded-panel border border-line p-5" style={{ borderColor: `color-mix(in oklch, ${JUDGMENT[current.judgment.name].color} 40%, var(--color-line))` }}>
                <div className="metric text-sm font-semibold" style={{ color: JUDGMENT[current.judgment.name].color }}>
                  {current.judgment.name} {JUDGMENT[current.judgment.name].glyph}
                </div>
                {reason ? (
                  <p className="mt-2 font-serif text-lg leading-snug text-ink">{reason.text}</p>
                ) : jComment ? (
                  <p className="mt-2 text-sm text-ink-muted">{jComment}</p>
                ) : null}
                {bestSan && !reason?.text.includes(bestSan) && !jComment.includes(bestSan) && (
                  <p className="cap mt-3 normal-case tracking-normal">Best line: {bestSan}</p>
                )}
              </div>
            ) : !g.hasAnalysis ? (
              <p className="text-sm text-ink-faint">Analyze the game to see move quality and reasons.</p>
            ) : (
              <p className="text-sm text-ink-faint">
                Nothing wrong with this move.{formatEval(current) ? ` Evaluation ${formatEval(current)}.` : ""}
              </p>
            )}
          </aside>

          {/* BOARD (center) */}
          <div className="order-1 lg:order-2">
            <div className="relative mb-2 flex justify-end">
              <button
                type="button"
                onClick={() => setSettingsOpen((o) => !o)}
                className="cap flex items-center gap-1.5 rounded-control border border-line px-2.5 py-1.5 text-ink-muted transition-colors hover:border-line-strong hover:text-ink"
              >
                ⚙ Board
              </button>
              {settingsOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setSettingsOpen(false)} />
                  <div className="absolute right-0 top-full z-20 mt-1 w-56 rounded-panel border border-line bg-surface p-4 shadow-xl">
                    <div className="cap mb-3">Board theme</div>
                    <div className="space-y-1">
                      {BOARD_THEMES.map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => {
                            setTheme(t);
                            saveBoardTheme(t.id);
                          }}
                          className={`flex w-full items-center gap-3 rounded-control px-2 py-1.5 text-left text-sm transition-colors hover:bg-surface-2 ${theme.id === t.id ? "text-ink" : "text-ink-muted"}`}
                        >
                          <span className="grid h-5 w-5 shrink-0 overflow-hidden rounded-[3px]" style={{ gridTemplateColumns: "1fr 1fr" }}>
                            <span style={{ background: t.light }} />
                            <span style={{ background: t.dark }} />
                          </span>
                          {t.name}
                          {theme.id === t.id && <span className="ml-auto text-accent">✓</span>}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>

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
              <div className="w-9 shrink-0" aria-hidden />
            </div>

            <div className="mt-3 flex items-center justify-center gap-2">
              <NavButton onClick={() => goto(1)} disabled={idx <= 1}>⏮</NavButton>
              <NavButton onClick={() => goto(idx - 1)} disabled={idx <= 1}>◀</NavButton>
              <span className="metric w-16 text-center text-xs text-ink-faint">{idx} / {n}</span>
              <NavButton onClick={() => goto(idx + 1)} disabled={idx >= n}>▶</NavButton>
              <NavButton onClick={() => goto(n)} disabled={idx >= n}>⏭</NavButton>
            </div>

            {!g.hasAnalysis && (
              <div className="mt-4 flex items-center justify-center">
                {analyzing ? (
                  <div className="flex items-center gap-3 text-sm text-ink-muted">
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-line border-t-accent" />
                    Grading {n} moves with Stockfish…
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={runAnalysis}
                    className="rounded-control bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-transform active:translate-y-px"
                  >
                    Analyze this game
                  </button>
                )}
              </div>
            )}
            {error && <p className="mt-2 text-center text-sm" style={{ color: "var(--color-loss)" }}>{error}</p>}
          </div>

          {/* TIMELINE (right) */}
          <div className="order-3">
            <EvalTimeline plies={g.plies} current={idx} keypoints={keypoints} hasAnalysis={g.hasAnalysis} onSeek={goto} />
          </div>
        </div>
      </main>
    </div>
  );
}

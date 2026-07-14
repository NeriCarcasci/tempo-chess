import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { Chess } from "chess.js";
import type { GameData, Ply, Judgment } from "../lib/game";
import { fenAt } from "../lib/game";
import { analyzeGameLocally } from "../lib/analyze";
import { explainMove } from "../lib/motifs";
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

/** Plies where the evaluation swings sharply — the game's turning points. */
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
    swings
      .filter((s) => s.swing >= 150)
      .sort((a, b) => b.swing - a.swing)
      .slice(0, 8)
      .map((s) => s.ply),
  );
}

function EvalGraph({
  plies,
  current,
  keypoints,
  onSeek,
}: {
  plies: Ply[];
  current: number;
  keypoints: Set<number>;
  onSeek: (i: number) => void;
}) {
  const W = 640;
  const H = 104;
  const MAX = 800;
  const mid = H / 2;
  const clampCp = (p: Ply): number => {
    const cp = p.mate !== undefined ? (p.mate > 0 ? MAX : -MAX) : (p.evalCp ?? 0);
    return Math.max(-MAX, Math.min(MAX, cp));
  };
  const X = (i: number) => (plies.length <= 1 ? 0 : (i / (plies.length - 1)) * W);
  const Y = (cp: number) => mid - (cp / MAX) * (mid - 3);
  const pts = plies.map((p, i) => `${X(i).toFixed(1)},${Y(clampCp(p)).toFixed(1)}`).join(" ");
  const area = `0,${mid} ${pts} ${W},${mid}`;

  const seek = (clientX: number, rect: DOMRect) => {
    const i = Math.round(((clientX - rect.left) / rect.width) * (plies.length - 1));
    onSeek(Math.max(0, Math.min(plies.length, i + 1)));
  };

  const kp = plies.map((p, i) => ({ p, i })).filter(({ p }) => keypoints.has(p.ply));

  return (
    <div
      className="relative cursor-pointer overflow-hidden rounded-[6px] border border-line"
      style={{ height: H }}
      onClick={(e) => seek(e.clientX, e.currentTarget.getBoundingClientRect())}
    >
      <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block">
        <rect x="0" y="0" width={W} height={mid} fill="var(--color-ink)" opacity="0.05" />
        <polygon points={area} fill="var(--color-ink)" opacity="0.13" />
        <polyline points={pts} fill="none" stroke="var(--color-ink-muted)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <line x1="0" y1={mid} x2={W} y2={mid} stroke="var(--color-line-strong)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      </svg>
      {current > 0 && (
        <div className="pointer-events-none absolute top-0 bottom-0 w-px bg-accent" style={{ left: `${(X(current - 1) / W) * 100}%` }} />
      )}
      {kp.map(({ p, i }) => (
        <button
          key={p.ply}
          type="button"
          title={`Move ${p.moveNumber}: ${formatEval(p)}`}
          onClick={(e) => {
            e.stopPropagation();
            onSeek(p.ply);
          }}
          className="absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2"
          style={{
            left: `${(X(i) / W) * 100}%`,
            top: Y(clampCp(p)),
            background: "var(--color-accent)",
            ["--tw-ring-color" as string]: "var(--color-bg)",
          }}
        />
      ))}
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

function MoveCell({ ply, active, isKey, onClick }: { ply?: Ply; active: boolean; isKey: boolean; onClick: () => void }) {
  if (!ply) return <td className="w-[44%]" />;
  const j = ply.judgment ? JUDGMENT[ply.judgment.name] : null;
  return (
    <td className="w-[44%] py-0.5">
      <button
        type="button"
        onClick={onClick}
        className={`metric flex w-full items-baseline gap-1.5 rounded-[4px] px-1.5 py-0.5 text-sm transition-colors ${
          active ? "bg-surface-2 text-ink" : "text-ink-muted hover:text-ink"
        }`}
      >
        {isKey && <span className="h-1 w-1 shrink-0 rounded-full" style={{ background: "var(--color-accent)" }} />}
        <span>
          {ply.san}
          {j && <sup className="font-semibold" style={{ color: j.color }}>{j.glyph}</sup>}
        </span>
        <span className="ml-auto text-xs text-ink-faint">{formatEval(ply)}</span>
      </button>
    </td>
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
  const current = idx > 0 ? g.plies[idx - 1] : null;
  const bestSan = current ? uciToSan(current.fenBefore, current.best) : undefined;
  const jComment = current?.judgment
    ? current.judgment.comment.replace(/^(Blunder|Mistake|Inaccuracy)[.:]?\s*/i, "")
    : "";
  const reason = useMemo(
    () => (current?.judgment ? explainMove(current.fenBefore, current.uci, current.best) : null),
    [current],
  );

  const rows = [];
  for (let i = 0; i < n; i += 2) rows.push({ no: i / 2 + 1, w: g.plies[i], b: g.plies[i + 1] });

  return (
    <div className="relative z-10 min-h-dvh">
      <header className="sticky top-0 z-30 border-b border-line bg-bg/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-[540px] items-center justify-between px-4">
          <Link to="/" className="cap transition-colors hover:text-ink">← Report</Link>
          <a href={g.url} target="_blank" rel="noreferrer" className="cap transition-colors hover:text-ink">
            Lichess ↗
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-[540px] px-4 pb-24 pt-6">
        <div className="mb-4">
          <div className="cap mb-1.5">
            {g.speed ? `${g.speed} · ` : ""}
            {g.eco ? `${g.eco} · ` : ""}
            {g.opening ?? "Game"}
          </div>
          <h1 className="font-serif text-2xl leading-tight text-ink">
            {g.white.name}{" "}
            <span className="text-ink-faint">{g.white.rating ? `${g.white.rating}` : ""}</span>{" "}
            <span className="metric text-lg text-ink-muted">{g.result}</span>{" "}
            {g.black.name}{" "}
            <span className="text-ink-faint">{g.black.rating ? `${g.black.rating}` : ""}</span>
          </h1>
        </div>

        {g.hasAnalysis ? (
          <div className="mb-4">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="cap">Evaluation</span>
              <span className="metric text-sm text-ink">{formatEval(current) || "start"}</span>
            </div>
            <EvalGraph plies={g.plies} current={idx} keypoints={keypoints} onSeek={setIdx} />
            <p className="cap mt-1.5 normal-case tracking-normal text-ink-faint">
              Dots mark the sharpest swings. Click the graph or a dot to jump there.
            </p>
          </div>
        ) : (
          <div className="mb-4 rounded-panel border border-line p-4">
            {analyzing ? (
              <div className="flex items-center gap-3 text-sm text-ink-muted">
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-line border-t-accent" />
                Grading {n} moves with Stockfish. This takes a few seconds.
              </div>
            ) : (
              <div className="flex items-center justify-between gap-4">
                <p className="text-sm text-ink-muted">Not analyzed yet. Grade it with the engine.</p>
                <button
                  type="button"
                  onClick={runAnalysis}
                  className="shrink-0 rounded-control bg-accent px-3 py-1.5 text-sm font-semibold text-accent-ink transition-transform active:translate-y-px"
                >
                  Analyze
                </button>
              </div>
            )}
            {error && <p className="mt-2 text-sm" style={{ color: "var(--color-loss)" }}>{error}</p>}
          </div>
        )}

        <Chessboard fen={fenAt(g, idx)} flip={flip} lastMove={current ? moveSquares(current.uci) : undefined} />

        <div className="mt-4 flex items-center justify-between">
          <div className="flex gap-2">
            <NavButton onClick={() => setIdx(0)} disabled={idx === 0}>⏮</NavButton>
            <NavButton onClick={() => setIdx(Math.max(0, idx - 1))} disabled={idx === 0}>◀</NavButton>
            <NavButton onClick={() => setIdx(Math.min(n, idx + 1))} disabled={idx === n}>▶</NavButton>
            <NavButton onClick={() => setIdx(n)} disabled={idx === n}>⏭</NavButton>
          </div>
          <div className="flex items-center gap-3">
            <span className="cap">{idx} / {n}</span>
            <button type="button" onClick={() => setFlip((f) => !f)} className="cap transition-colors hover:text-ink">Flip</button>
          </div>
        </div>

        {current?.judgment && (
          <div className="mt-4 rounded-panel border border-line p-4">
            <span className="metric text-sm font-semibold" style={{ color: JUDGMENT[current.judgment.name].color }}>
              {current.judgment.name} {JUDGMENT[current.judgment.name].glyph}
            </span>
            {reason ? (
              <p className="mt-1.5 text-sm text-ink">{reason.text}</p>
            ) : jComment ? (
              <p className="mt-1.5 text-sm text-ink-muted">{jComment}</p>
            ) : null}
            {bestSan && !reason?.text.includes(bestSan) && !jComment.includes(bestSan) && (
              <p className="cap mt-2 normal-case tracking-normal">Best: {bestSan}</p>
            )}
          </div>
        )}

        <div className="mt-6">
          <table className="w-full">
            <tbody>
              {rows.map((r) => (
                <tr key={r.no} className="align-baseline">
                  <td className="metric w-8 py-0.5 pr-1 text-right text-xs text-ink-faint">{r.no}.</td>
                  <MoveCell ply={r.w} active={idx === r.w?.ply} isKey={!!r.w && keypoints.has(r.w.ply)} onClick={() => r.w && setIdx(r.w.ply)} />
                  <MoveCell ply={r.b} active={idx === r.b?.ply} isKey={!!r.b && keypoints.has(r.b.ply)} onClick={() => r.b && setIdx(r.b.ply)} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}

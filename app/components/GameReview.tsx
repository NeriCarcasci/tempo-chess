import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Chess } from "chess.js";
import type { GameData, Ply, Judgment } from "../lib/game";
import { fenAt } from "../lib/game";
import { Chessboard } from "./Chessboard";

const JUDGMENT: Record<Judgment, { glyph: string; color: string }> = {
  Blunder: { glyph: "??", color: "var(--color-loss)" },
  Mistake: { glyph: "?", color: "var(--color-mistake)" },
  Inaccuracy: { glyph: "?!", color: "var(--color-inaccuracy)" },
};

function formatEval(p: Ply | null): string {
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

/** Diverging evaluation graph (White advantage up). Click to jump to a move. */
function EvalGraph({
  plies,
  current,
  onSeek,
}: {
  plies: Ply[];
  current: number;
  onSeek: (i: number) => void;
}) {
  const W = 640;
  const H = 90;
  const MAX = 800; // clamp cp; mates pinned to the edge
  const mid = H / 2;
  const clamp = (p: Ply): number => {
    let cp = p.mate !== undefined ? (p.mate > 0 ? MAX : -MAX) : (p.evalCp ?? 0);
    return Math.max(-MAX, Math.min(MAX, cp));
  };
  const X = (i: number) => (plies.length <= 1 ? 0 : (i / (plies.length - 1)) * W);
  const Y = (cp: number) => mid - (cp / MAX) * (mid - 2);
  const pts = plies.map((p, i) => `${X(i).toFixed(1)},${Y(clamp(p)).toFixed(1)}`).join(" ");
  const area = `0,${mid} ${pts} ${W},${mid}`;
  const curX = current > 0 ? (X(current - 1) / W) * 100 : 0;

  return (
    <div
      className="relative cursor-pointer"
      style={{ height: H }}
      onClick={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const i = Math.round(((e.clientX - r.left) / r.width) * (plies.length - 1));
        onSeek(Math.max(0, Math.min(plies.length, i + 1)));
      }}
    >
      <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block">
        <rect x="0" y="0" width={W} height={mid} fill="var(--color-surface-2)" opacity="0.5" />
        <polygon points={area} fill="var(--color-ink)" opacity="0.14" />
        <polyline points={pts} fill="none" stroke="var(--color-ink-muted)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <line x1="0" y1={mid} x2={W} y2={mid} stroke="var(--color-line-strong)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      </svg>
      {current > 0 && (
        <div className="pointer-events-none absolute top-0 bottom-0 w-px bg-accent" style={{ left: `${curX}%` }} />
      )}
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
  const n = game.plies.length;
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

  const current = idx > 0 ? game.plies[idx - 1] : null;
  const rows = [];
  for (let i = 0; i < n; i += 2) rows.push({ no: i / 2 + 1, w: game.plies[i], b: game.plies[i + 1] });

  const bestSan = current ? uciToSan(current.fenBefore, current.best) : undefined;
  const jComment = current?.judgment
    ? current.judgment.comment.replace(/^(Blunder|Mistake|Inaccuracy)[.:]?\s*/i, "")
    : "";

  return (
    <div className="relative z-10 min-h-dvh">
      <header className="sticky top-0 z-30 border-b border-line bg-bg/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-[1160px] items-center justify-between px-6 sm:px-10">
          <Link to="/" className="cap transition-colors hover:text-ink">
            ← Report
          </Link>
          <a href={game.url} target="_blank" rel="noreferrer" className="cap transition-colors hover:text-ink">
            View on Lichess ↗
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-[1160px] px-6 pb-24 pt-8 sm:px-10">
        <div className="border-b border-line pb-6">
          <div className="cap mb-2">
            {game.speed ? `${game.speed} · ` : ""}
            {game.eco ? `${game.eco} · ` : ""}
            {game.opening ?? "Game"}
          </div>
          <h1 className="font-serif text-3xl text-ink">
            {game.white.name}{" "}
            <span className="text-ink-faint">{game.white.rating ? `(${game.white.rating})` : ""}</span>{" "}
            <span className="metric text-2xl text-ink-muted">{game.result}</span>{" "}
            {game.black.name}{" "}
            <span className="text-ink-faint">{game.black.rating ? `(${game.black.rating})` : ""}</span>
          </h1>
        </div>

        <div className="mt-8 grid gap-10 lg:grid-cols-[24rem_1fr]">
          <div>
            <Chessboard fen={fenAt(game, idx)} flip={flip} size={384} />
            <div className="mt-4 flex items-center justify-between">
              <div className="flex gap-2">
                <NavButton onClick={() => setIdx(0)} disabled={idx === 0}>⏮</NavButton>
                <NavButton onClick={() => setIdx(Math.max(0, idx - 1))} disabled={idx === 0}>◀</NavButton>
                <NavButton onClick={() => setIdx(Math.min(n, idx + 1))} disabled={idx === n}>▶</NavButton>
                <NavButton onClick={() => setIdx(n)} disabled={idx === n}>⏭</NavButton>
              </div>
              <div className="flex items-center gap-3">
                <span className="cap">{idx} / {n}</span>
                <button type="button" onClick={() => setFlip((f) => !f)} className="cap transition-colors hover:text-ink">
                  Flip
                </button>
              </div>
            </div>
          </div>

          <div className="min-w-0">
            {game.hasAnalysis ? (
              <div className="mb-6">
                <div className="cap mb-2">Evaluation</div>
                <EvalGraph plies={game.plies} current={idx} onSeek={setIdx} />
              </div>
            ) : (
              <div className="mb-6 rounded-panel border border-line p-4 text-sm text-ink-muted">
                This game has no server analysis. In-browser Stockfish grading is the next build.
              </div>
            )}

            <div className="mb-6 min-h-[4.5rem] rounded-panel border border-line p-4">
              {current ? (
                current.judgment ? (
                  <div>
                    <span className="metric text-sm font-semibold" style={{ color: JUDGMENT[current.judgment.name].color }}>
                      {current.judgment.name} {JUDGMENT[current.judgment.name].glyph}
                    </span>
                    {jComment && <p className="mt-1.5 text-sm text-ink-muted">{jComment}</p>}
                    {bestSan && !jComment.includes(bestSan) && (
                      <p className="cap mt-2 normal-case tracking-normal">Best: {bestSan}</p>
                    )}
                  </div>
                ) : (
                  <div className="flex items-baseline gap-3">
                    <span className="metric text-sm text-ink">
                      {current.moveNumber}
                      {current.color === "white" ? "." : "..."} {current.san}
                    </span>
                    {formatEval(current) && <span className="metric text-sm text-ink-muted">{formatEval(current)}</span>}
                  </div>
                )
              ) : (
                <span className="text-sm text-ink-faint">Starting position. Use arrow keys to step through.</span>
              )}
            </div>

            <div className="max-h-[22rem] overflow-y-auto pr-1">
              <table className="w-full">
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.no} className="align-baseline">
                      <td className="metric w-8 py-1 text-right text-xs text-ink-faint">{r.no}.</td>
                      <MoveCell ply={r.w} active={idx === r.w?.ply} onClick={() => r.w && setIdx(r.w.ply)} />
                      <MoveCell ply={r.b} active={idx === r.b?.ply} onClick={() => r.b && setIdx(r.b.ply)} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function MoveCell({ ply, active, onClick }: { ply?: Ply; active: boolean; onClick: () => void }) {
  if (!ply) return <td className="w-[42%]" />;
  const j = ply.judgment ? JUDGMENT[ply.judgment.name] : null;
  return (
    <td className="w-[42%] py-1 pl-2">
      <button
        type="button"
        onClick={onClick}
        className={`metric rounded-[4px] px-1.5 py-0.5 text-sm transition-colors ${
          active ? "bg-surface-2 text-ink" : "text-ink-muted hover:text-ink"
        }`}
      >
        {ply.san}
        {j && (
          <span className="ml-0.5 font-semibold" style={{ color: j.color }}>
            {j.glyph}
          </span>
        )}
      </button>
    </td>
  );
}

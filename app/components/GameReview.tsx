import { useEffect, useMemo, useRef, useState } from "react";
import { conceptSectionState, conceptsAtPly, type ReviewLookup } from "../lib/v1/review";
import { Link } from "react-router";
import { Chess } from "chess.js";
import type { GameData, Ply, Judgment } from "../lib/game";
import { fenAt } from "../lib/game";
import { analyzeGameLocally } from "../lib/analyze";
import { explainMove } from "../lib/motifs";
import { loadBoardTheme, type BoardTheme } from "../lib/boardThemes";
import { loadPieceSet, type PieceSet } from "../lib/pieceSets";
import { Board } from "./Board";
import { TopNav } from "./TopNav";

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
// Vertical eval spine. One row per ply, scroll-to-select. Sized to the board.
// ---------------------------------------------------------------------------
const ROW = 48; // taller = slower, more precise scrolling
const SPINE = 140;
const MAXCP = 800;
const CX = SPINE / 2;
const px = (cp: number) => CX + (Math.max(-MAXCP, Math.min(MAXCP, cp)) / MAXCP) * (CX - 30);
const FADE = "linear-gradient(to bottom, transparent 0, #000 8%, #000 92%, transparent 100%)";

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
  height,
  onSeek,
}: {
  plies: Ply[];
  current: number;
  keypoints: Set<number>;
  hasAnalysis: boolean;
  height: number;
  onSeek: (i: number) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const fromScroll = useRef(false);
  const programmatic = useRef(false);
  const ticking = useRef(false);
  const wheelTime = useRef(0);
  const pad = Math.max(0, (height - ROW) / 2);
  const H = plies.length * ROW;
  const py = (i: number) => i * ROW + ROW / 2;
  const clampCp = (p: Ply) => (p.mate !== undefined ? (p.mate > 0 ? MAXCP : -MAXCP) : (p.evalCp ?? 0));
  const pts = plies.map((p, i) => `${px(clampCp(p)).toFixed(1)},${py(i)}`).join(" ");

  useEffect(() => {
    const el = scroller.current;
    if (!el || current < 1) return;
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

  // Wheel over the reel steps exactly one ply per notch (then snaps to center).
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const now = performance.now();
      if (now - wheelTime.current < 55) return;
      wheelTime.current = now;
      const next = Math.max(1, Math.min(plies.length, current + (e.deltaY > 0 ? 1 : -1)));
      if (next !== current) onSeek(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [current, plies.length, onSeek]);

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

  const cols = `1.75rem 1fr ${SPINE}px 1fr`;

  return (
    <div style={{ height }} className="flex flex-col">
      <div className="mb-1 grid shrink-0 items-center" style={{ gridTemplateColumns: cols }}>
        <span />
        <span className="text-center text-lg leading-none" style={{ color: "var(--color-ink)" }} title="White">♟</span>
        <span className="cap text-center">eval</span>
        <span className="text-center text-lg leading-none" style={{ color: "var(--color-ink-faint)" }} title="Black">♟</span>
      </div>

      <div
        ref={scroller}
        onScroll={onScroll}
        className="relative min-h-0 flex-1 overflow-y-auto"
        style={{ maskImage: FADE, WebkitMaskImage: FADE }}
      >
        <div className="relative" style={{ height: pad * 2 + H }}>
          <svg
            className="pointer-events-none absolute left-1/2 -translate-x-1/2"
            style={{ top: pad }}
            width={SPINE}
            height={H}
            viewBox={`0 0 ${SPINE} ${H}`}
          >
            {/* one subtle "up a piece" reference on each side, plus the center */}
            {[px(300), px(-300)].map((x, k) => (
              <line key={k} x1={x} y1={0} x2={x} y2={H} stroke="var(--color-line)" strokeWidth="1" opacity="0.4" />
            ))}
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
                <span className="flex items-baseline justify-center gap-1.5">
                  {white && (
                    <>
                      <MoveText p={p} active={active} />
                      {active && hasAnalysis && <span className="metric text-xs text-ink-faint">{formatEval(p)}</span>}
                    </>
                  )}
                </span>
                <span />
                <span className="flex items-baseline justify-center gap-1.5">
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

function NavButton({ children, onClick, disabled, label }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="metric grid h-9 w-9 place-items-center rounded-control border border-line text-ink-muted transition-colors hover:border-line-strong hover:text-ink disabled:opacity-40 disabled:hover:border-line"
    >
      <span aria-hidden="true">{children}</span>
    </button>
  );
}

const FILES = "abcdefgh";

/** `28` as `e4`. The API sends squares as indices; a player reads them as squares. */
function squareName(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 63) return null;
  return `${FILES[value & 7]}${(value >> 3) + 1}`;
}

/**
 * The fact keys that name a square, and what to call them.
 *
 * A whitelist rather than a scan, because "render anything that looks like a
 * square index" would turn a centipawn count into a square the moment one
 * happened to fall under 64.
 */
const SQUARE_FACTS: readonly (readonly [string, string])[] = [
  ["mover", "from"],
  ["to", "to"],
  ["moverTo", "to"],
  ["square", "on"],
  ["target", "target"],
  ["pinned", "pinned"],
  ["pinner", "pinner"],
  ["front", "front"],
  ["rear", "behind"],
  ["attacker", "attacker"],
  ["defender", "defender"],
  ["uncoveredTarget", "uncovered"],
  ["discoveredPiece", "from behind"],
];

/** The board facts of one occurrence, as short labelled squares. */
function evidenceOf(facts: Record<string, unknown>): { label: string; square: string }[] {
  const shown: { label: string; square: string }[] = [];
  for (const [key, label] of SQUARE_FACTS) {
    const square = squareName(facts[key]);
    if (square) shown.push({ label, square });
  }
  const targets = facts.targets;
  if (Array.isArray(targets)) {
    const named = targets.map(squareName).filter((name): name is string => name !== null);
    if (named.length > 0) shown.push({ label: "targets", square: named.join(" ") });
  }
  return shown;
}

/**
 * How one observation turned out, in a word plus a colour.
 *
 * Never colour alone: `--color-win` and `--color-loss` mean nothing to a reader
 * who cannot separate them, so the word carries the meaning and the colour only
 * reinforces it. A censored observation is neither -- nobody was asked -- and it
 * takes the muted ink rather than a third hue.
 */
function outcomeOf(concept: { observed: boolean; success: boolean | null }) {
  if (!concept.observed) return { word: "not asked", color: "var(--color-ink-faint)" };
  if (concept.success) return { word: "done", color: "var(--color-win)" };
  return { word: "missed", color: "var(--color-loss)" };
}

/**
 * What Forma saw at this move.
 *
 * Tied to the ply the reader is looking at rather than listed as a separate
 * dashboard: the claim is about this position, and a list somewhere else means
 * reading a square name and finding it on the board yourself.
 *
 * The empty state is the part that has to be right. A game that was measured
 * and had nothing at this move is not the same as a game nobody measured, and
 * both are different again from a game Forma has never synced -- so each says
 * its own sentence instead of all three showing an empty panel.
 */
function ConceptsAtMove({
  events,
  absence,
}: {
  events: ReturnType<typeof conceptsAtPly>;
  absence: { kind: "ready" } | { kind: "absent"; text: string };
}) {
  if (absence.kind === "absent") {
    return (
      <div className="mt-4">
        <div className="cap mb-2">What Forma saw</div>
        <p className="text-sm text-ink-faint">{absence.text}</p>
      </div>
    );
  }
  if (events.length === 0) {
    return (
      <div className="mt-4">
        <div className="cap mb-2">What Forma saw</div>
        <p className="text-sm text-ink-faint">Nothing it names at this move.</p>
      </div>
    );
  }
  return (
    <div className="mt-4">
      <div className="cap mb-2">What Forma saw</div>
      <ul className="flex flex-col gap-2">
        {events.map((event) =>
          event.concepts.map((concept) => {
            const outcome = outcomeOf(concept);
            const evidence = evidenceOf(event.facts ?? {});
            return (
              <li
                key={`${event.eventType}:${event.focalPly}:${concept.slug}:${concept.role}`}
                className="rounded-control bg-surface-2 px-3 py-2"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-semibold text-ink">{concept.displayName}</span>
                  <span className="metric text-xs" style={{ color: outcome.color }}>
                    {outcome.word}
                  </span>
                </div>
                <p className="mt-1 text-xs leading-snug text-ink-muted">{concept.definition}</p>
                {evidence.length > 0 && (
                  <p className="metric mt-1.5 text-xs text-ink-faint">
                    {evidence.map((item) => `${item.label} ${item.square}`).join(" · ")}
                  </p>
                )}
                {!concept.observed && concept.censoredReason && (
                  <p className="mt-1 text-xs text-ink-faint">
                    The game ended before you answered it.
                  </p>
                )}
              </li>
            );
          }),
        )}
      </ul>
    </div>
  );
}

export function GameReview({
  game,
  initialPly,
  review,
}: {
  game: GameData;
  initialPly?: number | null;
  review?: ReviewLookup | null;
}) {
  const [analyzed, setAnalyzed] = useState<GameData | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const g = analyzed ?? game;
  const n = g.plies.length;
  const [idx, setIdx] = useState(() => initialPly ? Math.max(1, Math.min(n, initialPly)) : n);
  const [flip, setFlip] = useState(false);
  const [theme] = useState<BoardTheme>(() => loadBoardTheme());
  const [pieceSet] = useState<PieceSet>(() => loadPieceSet());
  const [boardH, setBoardH] = useState(520);
  // The API numbers plies from the position before a move; the reel numbers
  // them from one. `idx - 1` is the same move in both.
  const publishedReview = review?.status === "found" ? review.review : null;
  const absence = review && review.status === "absent" ? review.reason : null;
  const boardRef = useRef<HTMLDivElement>(null);
  const lastWheel = useRef(0);

  const goto = (i: number) => setIdx(Math.max(1, Math.min(n, i)));

  // keep the eval component the same size as the board
  useEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBoardH(el.offsetWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
      const now = performance.now();
      if (now - lastWheel.current < 55) return; // one notch = one ply
      lastWheel.current = now;
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
  // When the played move was a mistake, draw the engine's best move as an arrow.
  const bestArrow = (() => {
    if (!current?.judgment || !current.best) return undefined;
    const s = moveSquares(current.best);
    return s ? [{ from: s[0], to: s[1], color: "var(--color-win)" }] : undefined;
  })();

  return (
    <div className="relative z-10 min-h-dvh">
      <TopNav
        current="game"
        back={{ to: "/", label: "My Chess" }}
        right={
          <a href={g.url} target="_blank" rel="noreferrer" className="cap transition-colors hover:text-ink">
            Lichess ↗
          </a>
        }
      />

      <main className="game-review-main mx-auto max-w-[1280px] px-4 pb-10 pt-5 sm:px-6">
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
          {/* EXPLANATION (left, vertically centered on the board) */}
          <aside
            className="game-insight-panel order-2 flex items-center lg:order-1 lg:min-h-[var(--bh)]"
            style={{ ["--bh" as string]: `${boardH}px` }}
          >
            <div className="w-full">
              {current?.judgment ? (
                <div
                  className="rounded-panel border p-5"
                  style={{ borderColor: `color-mix(in oklch, ${JUDGMENT[current.judgment.name].color} 40%, var(--color-line))` }}
                >
                  <div className="metric text-sm font-semibold" style={{ color: JUDGMENT[current.judgment.name].color }}>
                    {current.judgment.name} {JUDGMENT[current.judgment.name].glyph}
                  </div>
                  {reason ? (
                    <p className="mt-2 font-serif text-lg leading-snug text-ink">{reason.text}</p>
                  ) : jComment ? (
                    <p className="mt-2 text-sm text-ink-muted">{jComment}</p>
                  ) : null}
                  {bestSan && (
                    <p className="cap mt-3 normal-case tracking-normal">
                      Best move <span style={{ color: "var(--color-win)" }}>↗ {bestSan}</span>
                    </p>
                  )}
                </div>
              ) : !g.hasAnalysis ? (
                <div>
                  <div className="cap mb-2">Current move</div>
                  <p className="text-sm text-ink-faint">Analyze the game to see move quality and reasons.</p>
                </div>
              ) : (
                <div>
                  <div className="cap mb-2" style={{ color: "var(--color-win)" }}>Good move</div>
                  <p className="text-sm leading-relaxed text-ink-muted">
                    Nothing wrong with this move.{formatEval(current) ? ` Evaluation ${formatEval(current)}.` : ""}
                  </p>
                </div>
              )}
              <ConceptsAtMove
                events={conceptsAtPly(publishedReview, idx - 1)}
                absence={conceptSectionState(publishedReview, absence)}
              />
            </div>
          </aside>

          {/* BOARD (center) */}
          <div className="game-board-stage order-1 lg:order-2">
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
                <Board
                  fen={fenAt(g, idx)}
                  flip={flip}
                  light={theme.light}
                  dark={theme.dark}
                  pieceSet={pieceSet}
                  lastMove={current ? moveSquares(current.uci) : undefined}
                  arrows={bestArrow}
                />
              </div>
              <div className="w-9 shrink-0" aria-hidden />
            </div>

            <div className="mt-3 flex items-center justify-center gap-2">
              <NavButton onClick={() => goto(1)} disabled={idx <= 1} label="First move">⏮</NavButton>
              <NavButton onClick={() => goto(idx - 1)} disabled={idx <= 1} label="Previous move">◀</NavButton>
              <span className="metric w-16 text-center text-xs text-ink-faint">{idx} / {n}</span>
              <NavButton onClick={() => goto(idx + 1)} disabled={idx >= n} label="Next move">▶</NavButton>
              <NavButton onClick={() => goto(n)} disabled={idx >= n} label="Last move">⏭</NavButton>
            </div>

            {!g.hasAnalysis && (
              <div className="mt-4 flex items-center justify-center">
                {analyzing ? (
                  <div className="flex items-center gap-3 text-sm text-ink-muted">
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-line border-t-accent" />
                    Grading {n} moves with Stockfish…
                  </div>
                ) : (
                  <button type="button" onClick={runAnalysis} className="primary-button">
                    Analyze this game
                  </button>
                )}
              </div>
            )}
            {error && <p className="mt-2 text-center text-sm" style={{ color: "var(--color-loss)" }}>{error}</p>}
          </div>

          {/* TIMELINE (right) */}
          <div className="game-timeline-panel order-3">
            <EvalTimeline plies={g.plies} current={idx} keypoints={keypoints} hasAnalysis={g.hasAnalysis} height={boardH} onSeek={goto} />
          </div>
        </div>
      </main>
    </div>
  );
}

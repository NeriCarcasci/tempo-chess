import { useEffect, useRef, useState } from "react";
import type { OpeningStat } from "../lib/lichess";
import { pct } from "../lib/format";

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return reduced;
}

/** Eased count-up. Final value immediately under reduced motion. */
export function CountUp({
  value,
  decimals = 0,
  suffix = "",
  duration = 850,
}: {
  value: number;
  decimals?: number;
  suffix?: string;
  duration?: number;
}) {
  const reduced = usePrefersReducedMotion();
  const [n, setN] = useState(reduced ? value : 0);
  useEffect(() => {
    if (reduced) {
      setN(value);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / duration);
      setN(value * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, reduced, duration]);
  return (
    <>
      {n.toFixed(decimals)}
      {suffix}
    </>
  );
}

/** Rating history: a proper time-series line with a crosshair + tooltip on hover. */
export function RatingLine({
  data,
  height = 150,
  color = "var(--color-accent)",
}: {
  data: number[];
  height?: number;
  color?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const W = 640;
  const pad = { t: 16, r: 10, b: 14, l: 10 };
  if (data.length < 2) return null;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const iw = W - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const X = (i: number) => pad.l + (i / (data.length - 1)) * iw;
  const Y = (v: number) => pad.t + (1 - (v - min) / range) * ih;
  const line = data.map((d, i) => `${X(i).toFixed(1)},${Y(d).toFixed(1)}`).join(" ");
  const area = `${line} ${X(data.length - 1).toFixed(1)},${(pad.t + ih).toFixed(1)} ${X(0).toFixed(1)},${(pad.t + ih).toFixed(1)}`;

  function onMove(e: React.MouseEvent) {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let i = Math.round(((px - pad.l) / iw) * (data.length - 1));
    i = Math.max(0, Math.min(data.length - 1, i));
    setHover(i);
  }

  const hLeft = hover != null ? (X(hover) / W) * 100 : 0;
  const hTop = hover != null ? Y(data[hover]) : 0;

  return (
    <div
      ref={wrapRef}
      className="relative"
      style={{ height }}
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
    >
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${W} ${height}`}
        preserveAspectRatio="none"
        className="block"
      >
        <defs>
          <linearGradient id="ratingfill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity="0.15" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={area} fill="url(#ratingfill)" />
        <polyline
          points={line}
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {hover != null && (
        <>
          <div
            className="pointer-events-none absolute top-0 bottom-0 w-px bg-line-strong"
            style={{ left: `${hLeft}%` }}
          />
          <div
            className="pointer-events-none absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2"
            style={{ left: `${hLeft}%`, top: hTop, background: color, "--tw-ring-color": "var(--color-bg)" } as React.CSSProperties}
          />
          <div
            className="metric pointer-events-none absolute -translate-x-1/2 -translate-y-[140%] rounded-control border border-line bg-surface-2 px-1.5 py-0.5 text-xs text-ink"
            style={{ left: `${hLeft}%`, top: hTop }}
          >
            {data[hover]}
          </div>
        </>
      )}
    </div>
  );
}

/** Win/draw/loss as one proportional bar with 2px surface gaps between fills. */
export function ProportionBar({
  win,
  draw,
  loss,
  height = 8,
}: {
  win: number;
  draw: number;
  loss: number;
  height?: number;
}) {
  const total = win + draw + loss || 1;
  const seg = (n: number, color: string) =>
    n > 0 ? (
      <div
        style={{ flexBasis: `${(n / total) * 100}%`, background: color }}
        className="rounded-[2px]"
      />
    ) : null;
  return (
    <div className="flex w-full gap-[2px]" style={{ height }}>
      {seg(win, "var(--color-win)")}
      {seg(draw, "var(--color-draw)")}
      {seg(loss, "var(--color-loss)")}
    </div>
  );
}

/**
 * Openings as a diverging chart around the 50% break-even line: bars to the
 * right (win) are strengths, to the left (loss) are weak lines. One view shows
 * both. Win/loss are the validated diverging poles; the center is neutral.
 */
export function DivergingOpenings({ openings }: { openings: OpeningStat[] }) {
  const rows = [...openings].sort((a, b) => b.adjWinRate - a.adjWinRate);
  const TRACK = 148; // px; center at TRACK/2
  const half = TRACK / 2;
  const posOf = (rate: number) => half + (rate - 0.5) * TRACK;
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <span className="cap" style={{ color: "var(--color-loss)" }}>
          weaker
        </span>
        <span className="cap">even</span>
        <span className="cap" style={{ color: "var(--color-win)" }}>
          stronger
        </span>
      </div>
      <div className="divide-y divide-line">
        {rows.map((o) => {
          const dev = o.adjWinRate - 0.5; // adjusted, de-noised
          const len = Math.abs(dev) * TRACK;
          const win = dev >= 0;
          const rawX = posOf(o.winRate);
          const low = o.conf === "low";
          return (
            <div
              key={o.name}
              className={`flex items-center gap-3 py-2 ${low ? "opacity-70" : ""}`}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-ink" title={o.name}>
                  {o.name}
                </div>
                <div className="cap mt-0.5">
                  {o.eco ? `${o.eco} · ` : ""}
                  {o.games}g · {pct(o.winRate)} raw
                </div>
              </div>
              <div className="relative shrink-0" style={{ width: TRACK, height: 18 }}>
                <div className="absolute top-0 bottom-0 w-px bg-line" style={{ left: half }} />
                <div
                  className="absolute top-1/2 h-3 w-px -translate-y-1/2 bg-line-strong"
                  style={{ left: rawX }}
                  title={`raw ${pct(o.winRate)}`}
                />
                <div
                  className="absolute top-1/2 h-2.5 -translate-y-1/2 rounded-[2px]"
                  style={{
                    left: win ? half : half - len,
                    width: len,
                    background: win ? "var(--color-win)" : "var(--color-loss)",
                  }}
                />
              </div>
              <div
                className="metric w-9 text-right text-sm"
                style={{ color: win ? "var(--color-win)" : "var(--color-loss)" }}
              >
                {pct(o.adjWinRate)}
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-xs leading-relaxed text-ink-faint">
        Bars show win rate adjusted for sample size; the tick marks the raw rate.
        A line needs games, not luck, to move off your baseline.
      </p>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";

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

/** Single-value arc gauge (0–100). Draws on mount; static under reduced motion. */
export function Ring({
  value,
  size = 132,
  stroke = 9,
  color = "var(--color-accent)",
  children,
}: {
  value: number;
  size?: number;
  stroke?: number;
  color?: string;
  children?: React.ReactNode;
}) {
  const reduced = usePrefersReducedMotion();
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    if (reduced) {
      setDrawn(true);
      return;
    }
    const id = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(id);
  }, [reduced]);

  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, value));
  const offset = drawn ? circumference * (1 - v / 100) : circumference;
  const c = size / 2;

  return (
    <div className="relative grid place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={c} cy={c} r={r} fill="none" stroke="var(--color-surface-2)" strokeWidth={stroke} />
        <circle
          cx={c}
          cy={c}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{
            transition: reduced ? undefined : "stroke-dashoffset 950ms cubic-bezier(0.16,1,0.3,1)",
          }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">{children}</div>
    </div>
  );
}

/** Eased count-up. Renders final value immediately under reduced motion. */
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
  const started = useRef(false);
  useEffect(() => {
    if (reduced) {
      setN(value);
      return;
    }
    started.current = true;
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

/** Compact rating trend line with a soft area fill. Scales to its container. */
export function Sparkline({
  data,
  height = 56,
  color = "var(--color-accent)",
}: {
  data: number[];
  height?: number;
  color?: string;
}) {
  const id = useRef(`sk-${Math.random().toString(36).slice(2, 8)}`);
  if (data.length < 2) return null;
  const W = 240;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((d, i) => {
    const x = (i / (data.length - 1)) * W;
    const y = height - ((d - min) / range) * (height - 8) - 4;
    return [x, y] as const;
  });
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [lx, ly] = pts[pts.length - 1];

  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${W} ${height}`}
      preserveAspectRatio="none"
      className="overflow-visible"
    >
      <defs>
        <linearGradient id={id.current} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.22" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`${line} ${W},${height} 0,${height}`} fill={`url(#${id.current})`} />
      <polyline
        points={line}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={lx} cy={ly} r="2.6" fill={color} />
    </svg>
  );
}

/** Win / draw / loss as one proportional bar. */
export function RecordBar({ win, draw, loss }: { win: number; draw: number; loss: number }) {
  const total = win + draw + loss || 1;
  const seg = (n: number, color: string) =>
    n > 0 ? <div style={{ width: `${(n / total) * 100}%`, background: color }} /> : null;
  return (
    <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-surface-2">
      {seg(win, "var(--color-accent)")}
      {seg(draw, "var(--color-info)")}
      {seg(loss, "var(--color-blunder)")}
    </div>
  );
}

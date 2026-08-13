/**
 * Tempo's identity: the crown of a rook, plus the wordmark.
 *
 * The turret only, three merlons over a tapered wall on a flared plinth. A whole
 * rook has to shrink its own body to fit a 20px nav, which reads as a squashed
 * piece; the crown is the part that identifies a rook anyway, and it gives the
 * mark a wide, stable stance at any size.
 *
 * Every corner is rounded in the *geometry*, not left to `stroke-linejoin`. A
 * round join only softens the outside of a stroke by half its width — at 1.6
 * that is under a pixel, which is why the mark still read as a set of right
 * angles however round the joins claimed to be. Rounding the path itself is the
 * only thing that actually shows.
 */

type Point = [number, number];

/**
 * A closed polygon with every corner rounded by `r`, in the path's own units.
 *
 * Written as a function rather than a hand-authored `d` string so the radius is
 * one number to tune instead of two dozen control points to re-derive. Each
 * corner backs off along both edges and turns the corner with a quadratic whose
 * control point is the original vertex, so the curve is tangent to both edges
 * and the silhouette is unchanged between corners.
 */
function roundedPolygon(points: Point[], r: number): string {
  const len = points.length;
  const parts: string[] = [];

  for (let i = 0; i < len; i++) {
    const prev = points[(i - 1 + len) % len];
    const cur = points[i];
    const next = points[(i + 1) % len];

    const toPrev: Point = [prev[0] - cur[0], prev[1] - cur[1]];
    const toNext: Point = [next[0] - cur[0], next[1] - cur[1]];
    const lenPrev = Math.hypot(toPrev[0], toPrev[1]);
    const lenNext = Math.hypot(toNext[0], toNext[1]);

    // Never eat more than half of either edge, or adjacent corners would
    // overrun each other on the short sides — the merlon notches are the
    // tightest place this has to hold.
    const d = Math.min(r, lenPrev / 2, lenNext / 2);

    const start: Point = [cur[0] + (toPrev[0] / lenPrev) * d, cur[1] + (toPrev[1] / lenPrev) * d];
    const end: Point = [cur[0] + (toNext[0] / lenNext) * d, cur[1] + (toNext[1] / lenNext) * d];

    const n = (v: number) => Number(v.toFixed(2));
    parts.push(`${i === 0 ? "M" : "L"}${n(start[0])} ${n(start[1])}`);
    parts.push(`Q${n(cur[0])} ${n(cur[1])} ${n(end[0])} ${n(end[1])}`);
  }

  return `${parts.join(" ")} Z`;
}

/** Three merlons over a tapered wall, clockwise from the top left. */
const TURRET_POINTS: Point[] = [
  [3, 6],
  [7.4, 6],
  [7.4, 9.8],
  [9.8, 9.8],
  [9.8, 6],
  [14.2, 6],
  [14.2, 9.8],
  [16.6, 9.8],
  [16.6, 6],
  [21, 6],
  [19.4, 16],
  [4.6, 16],
];

/** The flared plinth, sharing the turret's bottom edge so the two read as one. */
const PLINTH_POINTS: Point[] = [
  [3.2, 16],
  [20.8, 16],
  [20.8, 19.6],
  [3.2, 19.6],
];

/** Enough to take the edge off without the merlons turning into bobbles. */
const TURRET_RADIUS = 0.9;
const PLINTH_RADIUS = 1;

const TURRET = roundedPolygon(TURRET_POINTS, TURRET_RADIUS);
const PLINTH = roundedPolygon(PLINTH_POINTS, PLINTH_RADIUS);

export function RookMark({
  size = 24,
  className,
  title,
}: {
  size?: number;
  className?: string;
  /** Set only when the mark stands alone as the accessible name. */
  title?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinejoin="round"
      strokeLinecap="round"
    >
      <path d={TURRET} />
      <path d={PLINTH} />
    </svg>
  );
}

/**
 * Lockup for the nav, auth cards, and footer. The mark carries the accent; the
 * wordmark stays ink so the pair reads as one object rather than two colours
 * competing.
 */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <span className="logo">
      <RookMark size={size} className="logo-mark" />
      <span className="logo-word">Tempo</span>
    </span>
  );
}

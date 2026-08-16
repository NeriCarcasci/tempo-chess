/**
 * Forma's identity: the mascot's head, plus the wordmark.
 *
 * The mark is not drawn — it is *cut* from the mascot. Every number below is
 * lifted verbatim from app/components/RookMascot.tsx and mapped into a 24-box
 * by fit(), so the mark carries the mascot's merlon pitch, its notch width and
 * its collar proportion exactly. A mark that merely resembled the character
 * would drift away from it the first time either was tuned; this one cannot,
 * because there is only one set of coordinates and this file borrows them.
 *
 * The head and not the whole piece: a full rook has to shrink its own body to
 * fit a 20px nav, which reads as a squashed piece. Crown and collar are the
 * part that identifies the character anyway — they are what the mascot leads
 * with — and the pair gives the mark a wide, stable stance at any size.
 *
 * Solid, not stroked. The mascot is a heavy ink outline around a flat fill, and
 * at 16px an outline of that weight closes up into a blob. A silhouette keeps
 * the shape the outline was describing.
 *
 * One shape, not two. Crown and collar overlap on the mascot — the collar is
 * painted first and the crown sits on top of it — so what you see between them
 * is a single ink line, the crown's own bottom edge. Drawing them as two
 * abutting shapes instead gives you two outlines meeting, which reads as a
 * doubled line and is the one thing about the mascot this mark can get wrong
 * for free. So the mark takes their union: crenellated top, straight sides, and
 * the collar's 12-a-side flare stepping out at the bottom.
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
function roundedPolygon(points: Point[], radii: number[]): string {
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
    // overrun each other on the short sides — the merlon notches and the
    // 12-wide collar step are the tightest places this has to hold.
    const d = Math.min(radii[i], lenPrev / 2, lenNext / 2);

    const start: Point = [cur[0] + (toPrev[0] / lenPrev) * d, cur[1] + (toPrev[1] / lenPrev) * d];
    const end: Point = [cur[0] + (toNext[0] / lenNext) * d, cur[1] + (toNext[1] / lenNext) * d];

    const n = (v: number) => Number(v.toFixed(2));
    parts.push(`${i === 0 ? "M" : "L"}${n(start[0])} ${n(start[1])}`);
    parts.push(`Q${n(cur[0])} ${n(cur[1])} ${n(end[0])} ${n(end[1])}`);
  }

  return `${parts.join(" ")} Z`;
}

/* ------------------------------------------------------------------ */
/* Mascot coordinates. Change these only to follow the mascot.          */
/*                                                                      */
/*   crown   x 72..208, y 94..152, merlons on a 50 pitch topping out    */
/*           at y 64, corner radius 5                                   */
/*   collar  x 60..220, y 152..178, rx 10                               */
/*                                                                      */
/* The collar's top is the crown's bottom, y 152, so the only thing the  */
/* two parts share is the ink line itself: both 9-wide strokes land on   */
/* that one edge and coincide exactly. The mascot tucks its collar up    */
/* behind the crown to y 144 instead, which is invisible there because   */
/* the crown is opaque over it — but carried into a mark it puts two     */
/* strokes 8 apart and thickens the join into a band.                    */
/*                                                                      */
/* Their union, clockwise from the top-left merlon. Straight-sided,      */
/* because the mascot's crown is a block and it is the body underneath   */
/* — not in this mark — that does the tapering. The old mark tapered the */
/* turret itself, which is why it read as a generic castle icon rather   */
/* than as this character.                                              */
/* ------------------------------------------------------------------ */
const HEAD: [Point, number][] = [
  [[72, 64], 5], [[108, 64], 5], [[108, 94], 5], [[122, 94], 5],   // left merlon, notch
  [[122, 64], 5], [[158, 64], 5], [[158, 94], 5], [[172, 94], 5],  // middle merlon, notch
  [[172, 64], 5], [[208, 64], 5],                                  // right merlon
  [[208, 152], 3], [[220, 152], 3],                                // step out to the collar
  [[220, 178], 10], [[60, 178], 10],                               // the collar itself
  [[60, 152], 3], [[72, 152], 3],                                  // step back in
];

/* Why the step corners are 3 and not the collar's own 10: the flare is 12
   wide, so two radii of 10 cap each other at 6 and consume the whole edge —
   the step stops being a step and becomes a shoulder, and at 22px the collar
   simply disappears into the crown. Three leaves half the edge flat, which is
   what keeps the flare legible down to 16. The bottom corners are the mascot's
   real 10: nothing crowds them there. */

const HEAD_POINTS = HEAD.map(([p]) => p);
const HEAD_RADII = HEAD.map(([, r]) => r);

/* ------------------------------------------------------------------ */

const VIEW = 24;
/** Filled art carries more weight than the old 1.6 stroke, so it sits smaller. */
const MARGIN = 1.5;

/**
 * Map mascot units into the 24-box, centred, preserving aspect. Radii scale with
 * it — a radius that stayed put would round a 24-unit mark by the amount meant
 * for a 350-unit one and dissolve the crenellation entirely.
 */
function fit(points: Point[]) {
  const x0 = Math.min(...points.map((p) => p[0]));
  const x1 = Math.max(...points.map((p) => p[0]));
  const y0 = Math.min(...points.map((p) => p[1]));
  const y1 = Math.max(...points.map((p) => p[1]));
  const scale = Math.min((VIEW - MARGIN * 2) / (x1 - x0), (VIEW - MARGIN * 2) / (y1 - y0));
  const dx = (VIEW - (x1 - x0) * scale) / 2 - x0 * scale;
  const dy = (VIEW - (y1 - y0) * scale) / 2 - y0 * scale;
  const placed: Point[] = points.map(([x, y]) => [x * scale + dx, y * scale + dy]);
  return { scale, placed };
}

const { scale, placed } = fit(HEAD_POINTS);
const HEAD_PATH = roundedPolygon(placed, HEAD_RADII.map((r) => r * scale));

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
      viewBox={`0 0 ${VIEW} ${VIEW}`}
      className={className}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      fill="currentColor"
    >
      <path d={HEAD_PATH} />
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
      <span className="logo-word">Forma</span>
    </span>
  );
}

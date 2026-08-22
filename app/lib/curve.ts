/**
 * One curve routine, shared by every figure that joins sampled points.
 *
 * A polyline through a hundred and twenty bins is a saw, and the corner at
 * every bin is an artefact of the sampling interval rather than anything that
 * happened in a game. Fritsch–Carlson is the smoothing that is allowed here:
 * it passes through every sample exactly, and its tangents are clamped so the
 * curve can never overshoot the samples it joins. A Catmull–Rom or a plain
 * cardinal spline would round the same corners and invent a dip below the
 * lowest quartile on the way — a position no game in the archive was ever in.
 *
 * That no-overshoot property is load-bearing beyond looking right. The
 * trajectory band is drawn as two polygons that meet exactly on the level
 * line, built by clamping one edge to `max(value, level)` and the other to
 * `min(value, level)`. A curve that overshot would push the winning half below
 * level and open a gap between the two halves. Monotone cubic cannot: every
 * segment stays inside the interval of its own two endpoints.
 */

export interface CurvePoint {
  x: number;
  y: number;
}

/** Two places, matching the precision the projections already round to. */
const place = (value: number): number => Math.round(value * 100) / 100;

/**
 * A monotone cubic through the points, as SVG path data.
 *
 * `command` is what the first point emits: "M" to start a path, "L" to
 * continue one — which is how the returned edge joins the reversed edge in a
 * closed area without a seam.
 *
 * A flat run emits `L` rather than a cubic with zero tangents. The two are the
 * same line, but a horizontal stretch of a band is usually a clamp against a
 * boundary rather than a curve, and saying so with the simpler command keeps
 * the path readable and lets anything reading the geometry back out — a test
 * checking that a collapsed half of a band sits on exactly one y — still see
 * what it is looking at.
 */
export function smoothCurve(
  points: ReadonlyArray<CurvePoint>,
  command: "M" | "L" = "M",
): string {
  const n = points.length;
  if (n === 0) return "";
  const at = (index: number) => points[Math.max(0, Math.min(n - 1, index))]!;
  if (n === 1) return `${command}${place(at(0).x)} ${place(at(0).y)}`;

  // Secant slopes between neighbours, then tangents clamped to them.
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const run = at(i + 1).x - at(i).x;
    slope.push(run === 0 ? 0 : (at(i + 1).y - at(i).y) / run);
  }
  const tangent: number[] = new Array(n);
  tangent[0] = slope[0]!;
  tangent[n - 1] = slope[n - 2]!;
  for (let i = 1; i < n - 1; i++) {
    const before = slope[i - 1]!;
    const after = slope[i]!;
    // A local extremum gets a flat tangent. This is what stops the overshoot.
    tangent[i] = before * after <= 0 ? 0 : (2 * before * after) / (before + after);
  }

  let d = `${command}${place(at(0).x)} ${place(at(0).y)}`;
  for (let i = 0; i < n - 1; i++) {
    const from = at(i);
    const to = at(i + 1);
    if (from.y === to.y && tangent[i] === 0 && tangent[i + 1] === 0) {
      d += `L${place(to.x)} ${place(to.y)}`;
      continue;
    }
    const third = (to.x - from.x) / 3;
    d += `C${place(from.x + third)} ${place(from.y + third * tangent[i]!)}`;
    d += ` ${place(to.x - third)} ${place(to.y - third * tangent[i + 1]!)}`;
    d += ` ${place(to.x)} ${place(to.y)}`;
  }
  return d;
}

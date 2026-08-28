import { useId } from "react";
import { usePrefersReducedMotion } from "./charts";
import { MOVEMENT_COPY, type Movement } from "../lib/v1/dashboard";
import type { PhaseMissBin } from "../lib/v1/types";
import { buildCone, type ConePoint } from "../lib/trajectory";
import type { TrajectoryBin } from "../lib/v1/types";

/**
 * The measurement instruments: small marks that draw one published figure
 * each, shared by the hub and the phase pages so the same quantity is never
 * drawn two different ways.
 *
 * Ground rules, all inherited:
 *
 *   * every number drawn here arrived on the wire — nothing is derived beyond
 *     geometry, and an interval is always drawn on the full scale it is a
 *     share of, never scaled to its own width;
 *   * two things may be coloured: the accent, and a semantic result. The
 *     gauge and the rings carry the accent because they are "your figure";
 *     the split bar carries the result colours because taken and missed are
 *     results. Nothing here introduces a hue;
 *   * meaning never rides on colour alone — every coloured mark travels with
 *     its count in words;
 *   * the one animation is a value growing to its size, which is the job
 *     DESIGN.md lets motion have on a measurement, and reduced motion gets
 *     the final state outright.
 */

const pct = (value: number): string => `${Math.round(value * 100)}%`;

// ---------------------------------------------------------------------------
// Gauge — one rate, 0–100, with the interval on the same arc
// ---------------------------------------------------------------------------

/**
 * The arc gauge DESIGN.md lists and nothing had built: a single value on an
 * accent arc, with the interval drawn as a quieter arc on the same track so a
 * tight estimate and a guess cannot look alike. The figure sits in the middle
 * in the numeral face; the label under it says what the figure is of.
 */
export function Gauge({
  value,
  low,
  high,
  label,
  detail,
  size = 148,
}: {
  /** 0–1. The published rate. */
  value: number;
  /** 0–1, or null when the estimator sent no interval. */
  low: number | null;
  high: number | null;
  /** What this is a rate of, printed under the figure. */
  label: string;
  /** One more line, usually the sample. */
  detail?: string;
  size?: number;
}) {
  const reduced = usePrefersReducedMotion();
  const uid = useId();
  const stroke = 12;
  const radius = (size - stroke) / 2;
  const centre = size / 2;
  // The gap sits at the bottom so the arc reads as a dial, not a spinner.
  const span = 0.75; // share of the full circle the track occupies
  const circumference = 2 * Math.PI * radius;
  const trackLength = circumference * span;
  const start = 135; // degrees; the track runs clockwise to 45
  const arc = (share: number) => trackLength * Math.max(0, Math.min(1, share));

  const hasInterval = low !== null && high !== null;

  return (
    <figure className="gauge" style={{ width: size }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-labelledby={`${uid}-title`}
      >
        <title id={`${uid}-title`}>
          {label}: {pct(value)}
          {hasInterval ? `, between ${pct(low)} and ${pct(high)}` : ""}
        </title>
        <g transform={`rotate(${start} ${centre} ${centre})`}>
          <circle
            className="gauge-track"
            cx={centre}
            cy={centre}
            r={radius}
            fill="none"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${trackLength} ${circumference}`}
          />
          <circle
            className={`gauge-value${reduced ? "" : " is-grown"}`}
            cx={centre}
            cy={centre}
            r={radius}
            fill="none"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${arc(value)} ${circumference}`}
            style={{ "--gauge-length": `${arc(value)}px` } as React.CSSProperties}
          />
          {/* The interval, over the value arc: a translucent ink window from
              low to high, readable against the fill and the empty track
              alike. */}
          {hasInterval ? (
            <circle
              className="gauge-interval"
              cx={centre}
              cy={centre}
              r={radius}
              fill="none"
              strokeWidth={stroke}
              strokeLinecap="butt"
              strokeDasharray={`${Math.max(arc(high) - arc(low), 1)} ${circumference}`}
              strokeDashoffset={-arc(low)}
            />
          ) : null}
        </g>
      </svg>
      <figcaption className="gauge-copy">
        <b className="metric">{pct(value)}</b>
        <span>{label}</span>
        {hasInterval ? (
          <small className="metric">
            {pct(low)}-{pct(high)}
          </small>
        ) : null}
        {detail ? <small>{detail}</small> : null}
      </figcaption>
    </figure>
  );
}

// ---------------------------------------------------------------------------
// ChanceSplit — taken, missed and set aside, as one proportional bar
// ---------------------------------------------------------------------------

/**
 * What happened to every key moment, in one bar: handled and missed carry the
 * two result colours, and moments that ended before the player was on move are
 * hatched — the openings page's own mark for "not judged", because colouring
 * them either way would count a moment nobody got. The counts print beside
 * the bar, so the colours never carry the meaning alone.
 */
export function ChanceSplit({
  taken,
  missed,
  setAside,
}: {
  taken: number;
  missed: number;
  setAside: number;
}) {
  const total = taken + missed + setAside || 1;
  const width = (n: number) => `${(n / total) * 100}%`;
  return (
    <div className="chancesplit">
      <div className="chancesplit-bar" aria-hidden="true">
        {taken > 0 ? <span className="is-taken" style={{ flexBasis: width(taken) }} /> : null}
        {missed > 0 ? <span className="is-missed" style={{ flexBasis: width(missed) }} /> : null}
        {setAside > 0 ? (
          <span className="is-aside" style={{ flexBasis: width(setAside) }} />
        ) : null}
      </div>
      <p className="chancesplit-key">
        <span>
          <i className="is-taken" aria-hidden="true" /> {taken.toLocaleString()} handled
        </span>
        <span>
          <i className="is-missed" aria-hidden="true" /> {missed.toLocaleString()} missed
        </span>
        {setAside > 0 ? (
          <span>
            <i className="is-aside" aria-hidden="true" /> {setAside.toLocaleString()} set aside
          </span>
        ) : null}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MissHistogram — where in the game the misses fall
// ---------------------------------------------------------------------------

interface MissBucket {
  from: number;
  to: number;
  missed: number;
  observed: number;
}

/**
 * Adjacent move numbers pooled into at most `maxBars` buckets, so a phase
 * spanning forty moves does not draw forty hairline bars. Bucketing is the
 * only arithmetic: the counts are summed, never rescaled.
 */
export function bucketMisses(bins: readonly PhaseMissBin[], maxBars = 14): MissBucket[] {
  if (bins.length === 0) return [];
  const sorted = [...bins].sort((a, b) => a.moveNumber - b.moveNumber);
  const first = sorted[0]!.moveNumber;
  const last = sorted[sorted.length - 1]!.moveNumber;
  const span = last - first + 1;
  const width = Math.max(1, Math.ceil(span / maxBars));
  const buckets = new Map<number, MissBucket>();
  for (const bin of sorted) {
    const index = Math.floor((bin.moveNumber - first) / width);
    const from = first + index * width;
    const bucket = buckets.get(index) ?? {
      from,
      to: Math.min(from + width - 1, last),
      missed: 0,
      observed: 0,
    };
    bucket.missed += bin.missed;
    bucket.observed += bin.observed;
    buckets.set(index, bucket);
  }
  return [...buckets.values()].sort((a, b) => a.from - b.from);
}

/**
 * The misses across the phase's own move numbers, as the hub's shape chart at
 * row scale. Bars are counts, so a taller bar is more misses; the window the
 * heading names is coloured, exactly as the opening shape colours its peak.
 */
export function MissHistogram({
  bins,
  peak,
}: {
  bins: readonly PhaseMissBin[];
  /** The run of moves the headline names, coloured to match it. */
  peak: { from: number; to: number } | null;
}) {
  const buckets = bucketMisses(bins);
  if (buckets.length === 0) return null;
  const tallest = buckets.reduce((most, bucket) => Math.max(most, bucket.missed), 0);
  return (
    <div className="shape-bars is-compact">
      {buckets.map((bucket) => {
        const inPeak =
          peak !== null && bucket.to >= peak.from && bucket.from <= peak.to;
        const label =
          bucket.from === bucket.to ? `${bucket.from}` : `${bucket.from}-${bucket.to}`;
        return (
          <div
            key={bucket.from}
            className={`shape-bar ${inPeak ? "is-peak" : ""}`}
            title={`Moves ${label}: ${bucket.missed} missed of ${bucket.observed} key moments`}
          >
            <span
              className="shape-fill"
              style={{ height: tallest ? `${(bucket.missed / tallest) * 100}%` : "0%" }}
            />
            <span className="shape-tick">{label}</span>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TrajectoryLine — one line, drawn properly
// ---------------------------------------------------------------------------

/**
 * A smooth path through the points, Catmull-Rom converted to cubic beziers.
 *
 * The curve passes exactly through every published point; the smoothing only
 * decides how it travels between them, which is the difference between a
 * drawn line and a saw. Nothing is invented at a bin — the bins are the
 * anchors.
 */
function smoothPath(pts: readonly (readonly [number, number])[]): string {
  if (pts.length === 0) return "";
  const at = (i: number) => pts[Math.max(0, Math.min(pts.length - 1, i))]!;
  let d = `M ${at(0)[0].toFixed(2)} ${at(0)[1].toFixed(2)}`;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const t = 1 / 6;
    const c1x = p1[0] + (p2[0] - p0[0]) * t;
    const c1y = p1[1] + (p2[1] - p0[1]) * t;
    const c2x = p2[0] - (p3[0] - p1[0]) * t;
    const c2y = p2[1] - (p3[1] - p1[1]) * t;
    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`;
  }
  return d;
}

const VIEW_H = 100;

/**
 * The trajectory as one line: where the middle of your games sits, from the
 * first move to the last.
 *
 * It went through a shaded band and then a field of quantile capsules, and
 * both were the same mistake in different clothes — a picture carrying every
 * quantile at once, which is a research figure rather than something read at
 * a glance. The line is the reading: it starts at level and falls where the
 * games are actually lost, and that fall is the whole story the hub has to
 * tell. The spread behind it is a deep reading, so it is drawn only where
 * deep reading happens (`spread`, set by the profile and the report).
 */
export function TrajectoryLine({
  points,
  dividers = [],
  spread = false,
}: {
  points: readonly ConePoint[];
  /** Phase boundaries, 0–1 across the plot. */
  dividers?: readonly number[];
  /** Draw the middle half behind the line. Deep pages only. */
  spread?: boolean;
}) {
  const reduced = usePrefersReducedMotion();
  const uid = useId();
  const fillId = `traj-fill-${uid}`;
  if (points.length < 2) return null;

  const X = (v: number) => v * 100;
  const Y = (v: number) => (1 - v) * VIEW_H;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const line = smoothPath(points.map((p) => [X(p.x), Y(p.median)] as const));
  const area = `${line} L ${X(last.x).toFixed(2)} ${VIEW_H} L ${X(first.x).toFixed(2)} ${VIEW_H} Z`;
  const band = spread
    ? `${smoothPath(points.map((p) => [X(p.x), Y(p.p75)] as const))} L ${X(last.x).toFixed(2)} ${Y(last.p25).toFixed(2)} ${smoothPath(
        [...points].reverse().map((p) => [X(p.x), Y(p.p25)] as const),
      ).replace(/^M[^C]*/, "")} Z`
    : null;

  return (
    <svg
      className={`trajline${reduced ? "" : " is-drawn"}`}
      viewBox={`0 0 100 ${VIEW_H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--color-accent)" stopOpacity="0.22" />
          <stop offset="1" stopColor="var(--color-accent)" stopOpacity="0" />
        </linearGradient>
      </defs>

      {[0.25, 0.75].map((g) => (
        <line
          key={g}
          className="trajline-grid"
          x1="0"
          y1={Y(g)}
          x2="100"
          y2={Y(g)}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {/* Level is the one line that means something: a game either side could
          still take. Everything else here is a landmark. */}
      <line
        className="trajline-level"
        x1="0"
        y1={Y(0.5)}
        x2="100"
        y2={Y(0.5)}
        vectorEffect="non-scaling-stroke"
      />
      {dividers.map((at) => (
        <line
          key={at}
          className="trajline-divider"
          x1={X(at)}
          y1="0"
          x2={X(at)}
          y2={VIEW_H}
          vectorEffect="non-scaling-stroke"
        />
      ))}

      {band ? <path className="trajline-band" d={band} /> : null}
      <path className="trajline-area" d={area} fill={`url(#${fillId})`} />
      <path className="trajline-path" d={line} fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Donut — a share, drawn as a ring
// ---------------------------------------------------------------------------

/**
 * One share as a ring, with its figure inside it.
 *
 * The bar this replaced measured the same thing and read as a loading
 * indicator: a track that fills is a thing waiting to finish, which is the
 * wrong idea entirely for a standing measurement, and cutting it into cells
 * changed the texture without changing that. A ring is closed, so it reads as
 * a proportion of a whole rather than as progress toward one, and it gives
 * the figure a place to sit at the centre of its own evidence.
 */
export function Donut({
  value,
  size = 104,
  stroke = 11,
  children,
}: {
  /** 0–1, or null when there is no figure to draw. */
  value: number | null;
  size?: number;
  stroke?: number;
  /** What sits in the middle. Usually the figure itself. */
  children?: React.ReactNode;
}) {
  const reduced = usePrefersReducedMotion();
  const r = (size - stroke) / 2;
  const c = size / 2;
  const circumference = 2 * Math.PI * r;
  const drawn = value === null ? 0 : Math.max(0, Math.min(1, value)) * circumference;

  return (
    <span className="donut" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle className="donut-track" cx={c} cy={c} r={r} fill="none" strokeWidth={stroke} />
        {/* An arc shorter than its own round cap paints as a dot, which reads
            as a small reading rather than as none. A phase that gives up 0.4
            of a point should show nothing at all, so the arc has to be longer
            than the cap that finishes it before it is worth drawing. */}
        {value !== null && drawn > stroke ? (
          <circle
            className={`donut-value${reduced ? "" : " is-grown"}`}
            cx={c}
            cy={c}
            r={r}
            fill="none"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${drawn} ${circumference}`}
            transform={`rotate(-90 ${c} ${c})`}
            style={{ "--donut-length": `${drawn}px` } as React.CSSProperties}
          />
        ) : null}
      </svg>
      <span className="donut-mid">{children}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// PhaseBand — one phase's slice of the trajectory
// ---------------------------------------------------------------------------

/**
 * The trajectory, cropped to one phase: the same line the hub draws, over
 * this phase's own bins only. Built by the same `buildCone`, so the slice
 * cannot disagree with the whole — it is the same curve with two thirds of it
 * off the page.
 */
export function PhaseBand({
  bins,
  phase,
}: {
  bins: readonly TrajectoryBin[];
  phase: string;
}) {
  const cone = buildCone(bins.filter((bin) => bin.phase === phase));
  if (cone === null) return null;

  return (
    <div className="phaseband">
      {/* The axis sits inside the plot, not beside it: as a sibling its
          containing block was the whole component, so "Lost" was positioned
          against the bottom of the strip under the graph and landed on top
          of the word "starts". */}
      <div className="phaseband-plot">
        <div className="phaseband-axis" aria-hidden="true">
          <span>Won</span>
          <span>Level</span>
          <span>Lost</span>
        </div>
        <TrajectoryLine points={cone.points} />
      </div>
      <div className="phaseband-ends" aria-hidden="true">
        <span>starts</span>
        <span>ends</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dial — the hub's one mark
// ---------------------------------------------------------------------------

/**
 * A rate, its interval, and which way it is going — as one pressable object.
 *
 * This is the only mark the hub draws, at three sizes: large on `/today`, mid
 * at the top of a phase page, small in a stack. A reader learns the scale once.
 *
 * What the three parts say, and why they are separate:
 *
 *   * **the arc** is where you are — the published rate on the full 0–100
 *     scale, never scaled to its own width, with the interval as a window on
 *     the same track. An estimate over forty chances and one over four hundred
 *     must not draw the same confident line;
 *   * **the disc** is which way you are going. It is the only coloured surface,
 *     and its colour comes from the estimator's posterior, never from the rate.
 *     A phase nobody has compared yet is ink, not red;
 *   * **the mark** is which thing this is, so the row can be told apart before
 *     any of it is read.
 *
 * The disc is knocked out of the arc rather than sitting behind it: the ring
 * and the fill are one object with one edge, which is what lets it press like a
 * key without the two halves shearing apart. `--tone` is set by the caller's
 * class; nothing here picks a colour.
 */
export function Dial({
  value,
  low,
  high,
  size = 132,
  mark,
  title,
}: {
  /** 0–1, or null when nothing was published. Null draws an empty track. */
  value: number | null;
  low: number | null;
  high: number | null;
  size?: number;
  /** The thing's own mark, knocked out of the disc. */
  mark?: React.ReactNode;
  /** Read out to a screen reader. The visible figures live beside the dial. */
  title: string;
}) {
  const reduced = usePrefersReducedMotion();
  const uid = useId();
  const stroke = Math.round(size * 0.085);
  const radius = (size - stroke) / 2;
  const centre = size / 2;
  const circumference = 2 * Math.PI * radius;
  // A three-quarter track with the gap at the bottom, matching `Gauge`: the
  // two are the same instrument at two levels of detail, and a reader who
  // learns one has learned the other.
  const span = 0.75;
  const trackLength = circumference * span;
  const arc = (share: number) => trackLength * Math.max(0, Math.min(1, share));
  const hasInterval = low !== null && high !== null && value !== null;
  // The disc stops short of the track so the two read as separate facts. Any
  // less and the fill looks like part of the arc; any more and the mark starts
  // swimming in the middle of a wide ring.
  const disc = radius - stroke * 0.72;

  return (
    // The dial owns its own mark's size. It used to be set per context — one
    // value on the hub's node, another wherever else a dial was drawn — so the
    // same mark rendered at a different size inside the same component
    // depending on who had rendered it. One ratio, one place.
    <span
      className="dial"
      style={{ width: size, height: size, "--dial-size": `${size}px` } as React.CSSProperties}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-labelledby={`${uid}-t`}
      >
        <title id={`${uid}-t`}>{title}</title>
        <circle className="dial-disc" cx={centre} cy={centre} r={disc} />
        <g transform={`rotate(135 ${centre} ${centre})`}>
          <circle
            className="dial-track"
            cx={centre}
            cy={centre}
            r={radius}
            fill="none"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${trackLength} ${circumference}`}
          />
          {value !== null ? (
            <circle
              className={`dial-value${reduced ? "" : " is-grown"}`}
              cx={centre}
              cy={centre}
              r={radius}
              fill="none"
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={`${arc(value)} ${circumference}`}
              style={{ "--dial-length": `${arc(value)}px` } as React.CSSProperties}
            />
          ) : null}
          {hasInterval ? (
            <circle
              className="dial-interval"
              cx={centre}
              cy={centre}
              r={radius}
              fill="none"
              strokeWidth={stroke}
              strokeLinecap="butt"
              strokeDasharray={`${Math.max(arc(high) - arc(low), 1)} ${circumference}`}
              strokeDashoffset={-arc(low)}
            />
          ) : null}
        </g>
      </svg>
      {mark ? (
        <span className="dial-mark" aria-hidden="true">
          {mark}
        </span>
      ) : null}
    </span>
  );
}


// ---------------------------------------------------------------------------
// MoveChip — which way a thing is going, as a word
// ---------------------------------------------------------------------------

/**
 * The movement, as a word on an enamel tab.
 *
 * Never a signed percentage. "+49pp, recently +48" is a change announced and
 * then withdrawn in the same breath, and it asks a reader to hold two
 * percentage-point figures in their head to learn one fact they could have
 * been told outright. The word is the fact; the two rates behind it live on
 * the milestone card and the phase header, where there is room to read them.
 *
 * It carried an up or down triangle for one revision. The label already puts
 * the meaning somewhere other than the colour, which is what the rule asks
 * for, so the glyph was a second mark saying the same thing — and a triangle
 * glued to the inside of a pill is a hard little shape on a page that has
 * none.
 *
 * `--tone` comes from the caller's own `is-` class. Nothing here picks a hue.
 */
export function MoveChip({ movement }: { movement: Movement }) {
  return <span className={`move-chip is-${movement}`}>{MOVEMENT_COPY[movement].label}</span>;
}

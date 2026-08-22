import { useId } from "react";
import type { Cone, PhaseAccuracy, PlotBox } from "../lib/trajectory";
import {
  accuracyFinding,
  bandPaths,
  coneFinding,
  coneText,
  decayStops,
  LEVEL,
  medianPath,
  phaseCards,
  project,
  railBars,
} from "../lib/trajectory";

/**
 * The trajectory: one evaluation graph across a whole archive, and a card per
 * phase underneath it.
 *
 * The graph is the familiar single-game evaluation curve applied to a
 * distribution. The shaded region is the middle half of the games at that point
 * and the line through it is the median; a dashed divider marks each phase
 * boundary. See `lib/trajectory.ts` for why this is a band and not a line — the
 * short version is that the median of two hundred games is level everywhere, so
 * a line chart of it is a flat rule that reads as a broken component.
 *
 * ## Why the band is coloured, and what the colour means
 *
 * The band is split at level: the part above 0.5 takes the win colour, the part
 * below takes the loss colour. The obvious objection is that this only
 * relabels the axis and produces a ribbon that is green on top and red
 * underneath for its whole length. It does not, and the real numbers are why.
 * The two tails are strongly asymmetric — a losing quarter that reaches 0.00
 * beside a winning quarter that only reaches 0.67 — so the red half of the band
 * is three times the depth of the green half through the middlegame, and the
 * first bins are entirely above level and therefore entirely green. The shape
 * of that asymmetry is the reading, and it is exactly what a single-colour band
 * hides. `coneFinding` states it in words too, so the colour is never the only
 * carrier of it.
 *
 * DESIGN.md allows two coloured things: the accent and a semantic result. A
 * band drawn from expected score *is* a result, and these are the two semantic
 * colours. Nothing else here is coloured.
 *
 * ## Why there is no text in the SVG
 *
 * The graph has to be legible at 375px and at full width. A `font-size` inside
 * a scaled viewBox is either unreadable on a phone or shouting on a monitor,
 * and there is no unit that fixes it. So the SVG carries only geometry, with
 * `preserveAspectRatio="none"` and `vector-effect="non-scaling-stroke"` on
 * every stroke, and every label is HTML. The phase names live on the cards,
 * which sit directly under the segment they describe, so the graph needs no
 * labels of its own.
 *
 * ## Carrying the sample decay
 *
 * Only about a quarter of a typical archive reaches an endgame. Three things
 * say so, because this is the failure the picture would otherwise commit: the
 * band is masked by a gradient built from the per-bin game count, so it fades
 * where the evidence thins; the rail under the curve is that same count drawn
 * as bars; and each card states the games and the reach rate in words.
 */

/** The plot, in viewBox units. x is 0–100 so HTML labels can share the scale. */
const PLOT: PlotBox = { x: 0, y: 0, width: 100, height: 58 };
const RAIL_TOP = 63;
const RAIL_HEIGHT = 11;
const VIEW_HEIGHT = RAIL_TOP + RAIL_HEIGHT;

/** Expected-score gridlines. Level is drawn differently: it is the only one that means something. */
const GRID = [0, 0.25, 0.75, 1];

const pct = (value: number): string => `${Math.round(value * 100)}%`;
const signed = (value: number): string =>
  `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(Math.round(value * 100))}`;

export function Trajectory({
  cone,
  accuracy = [],
}: {
  cone: Cone;
  /**
   * How often chances were taken in each phase. Empty today: no route
   * publishes per-phase rates, and the cards say so rather than deriving one.
   */
  accuracy?: readonly PhaseAccuracy[];
}) {
  const uid = useId();
  const maskId = `cone-decay-${uid}`;
  const gradientId = `cone-decay-grad-${uid}`;
  const descriptionId = `cone-desc-${uid}`;

  const finding = coneFinding(cone);
  const band = bandPaths(cone.points, PLOT);
  const stops = decayStops(cone);
  const cards = phaseCards(cone, accuracy);
  const rowFinding = accuracyFinding(cards);
  const [, levelY] = project(PLOT, 0, LEVEL);

  return (
    <figure className="cone">
      {/* The axis labels sit beside the plot in HTML, so they need to know how
          much of the drawing is plot and how much is the sample rail under it.
          Passed as a custom property rather than duplicated in the stylesheet:
          two copies of 58/74 would drift the first time the rail changes
          height, and the failure is silent — "Lost" quietly stops meaning
          zero. */}
      <div
        className="cone-frame"
        style={
          {
            "--cone-plot-share": `${(PLOT.height / VIEW_HEIGHT) * 100}%`,
            "--phase-columns": cards
              .map((card) => `${Math.round((card.to - card.from) * 1000)}fr`)
              .join(" "),
          } as React.CSSProperties
        }
      >
        <div className="cone-axis" aria-hidden="true">
          <span className="is-top">Won</span>
          <span className="is-level">Level</span>
          <span className="is-bottom">Lost</span>
        </div>

        <div className="cone-plot">
          <svg
            viewBox={`0 0 100 ${VIEW_HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-describedby={descriptionId}
          >
            <title>{finding.headline}</title>
            {stops.length > 0 ? (
              <defs>
                {/* The evidence, as transparency. Each stop is one bin's share
                    of the largest bin, so the band physically fades where the
                    games run out instead of claiming the same strength over
                    forty-eight games as over two hundred. */}
                <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
                  {stops.map((stop) => (
                    <stop
                      key={stop.key}
                      offset={stop.offset}
                      stopColor="#ffffff"
                      stopOpacity={stop.strength}
                    />
                  ))}
                </linearGradient>
                <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="100" height={VIEW_HEIGHT}>
                  <rect x="0" y="0" width="100" height={VIEW_HEIGHT} fill={`url(#${gradientId})`} />
                </mask>
              </defs>
            ) : null}

            {GRID.map((line) => {
              const [, y] = project(PLOT, 0, line);
              return (
                <line
                  key={line}
                  className="cone-grid"
                  x1={0}
                  y1={y}
                  x2={100}
                  y2={y}
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}

            <g className="cone-sweep" mask={stops.length > 0 ? `url(#${maskId})` : undefined}>
              <path className="cone-above" d={band.above} vectorEffect="non-scaling-stroke" />
              <path className="cone-below" d={band.below} vectorEffect="non-scaling-stroke" />
            </g>

            <line
              className="cone-level"
              x1={0}
              y1={levelY}
              x2={100}
              y2={levelY}
              vectorEffect="non-scaling-stroke"
            />

            <path
              className="cone-median"
              d={medianPath(cone.points, PLOT)}
              fill="none"
              vectorEffect="non-scaling-stroke"
            />

            {/* Where the ruler changes. Each phase is normalised across its own
                length, so the curve is continuous but the x axis is three
                separate runs, and these say where one ends. */}
            {cone.dividers.map((at) => (
              <line
                key={at}
                className="cone-divider"
                x1={at * 100}
                y1={0}
                x2={at * 100}
                y2={RAIL_TOP + RAIL_HEIGHT}
                vectorEffect="non-scaling-stroke"
              />
            ))}

            <g className="cone-rail">
              {railBars(cone, PLOT, RAIL_TOP, RAIL_HEIGHT).map((bar) => (
                <rect key={bar.key} x={bar.x} y={bar.y} width={bar.width} height={bar.height} />
              ))}
            </g>
          </svg>
        </div>

        <ol className="phase-cards">
          {cards.map((card) => (
            <li key={card.phase} className="phase-card">
              <p className="phase-card-head">
                <strong>{card.name}</strong>
                {card.standing ? <span className="tag tag-sub">{card.standing}</span> : null}
              </p>

              {/* How well you play here. A rate, and today an absence: the
                  evidence is phase-tagged in the database and no route returns
                  it, so the card says that rather than splitting the estimates
                  itself and putting Forma's name on the result. */}
              {card.accuracy ? (
                <div className="phase-rate">
                  <p className="phase-figure">
                    <b>{pct(card.accuracy.rate)}</b>
                    <small>of your chances taken here</small>
                  </p>
                  <span className="rate-track" aria-hidden="true">
                    <i
                      className="rate-interval"
                      style={{
                        left: `${(card.accuracy.intervalLow ?? card.accuracy.rate) * 100}%`,
                        width: `${((card.accuracy.intervalHigh ?? card.accuracy.rate) - (card.accuracy.intervalLow ?? card.accuracy.rate)) * 100}%`,
                      }}
                    />
                    <i className="rate-point" style={{ left: `${card.accuracy.rate * 100}%` }} />
                  </span>
                  <p className="phase-evidence">
                    {card.accuracy.intervalLow !== null && card.accuracy.intervalHigh !== null
                      ? `${pct(card.accuracy.intervalLow)} to ${pct(card.accuracy.intervalHigh)} · `
                      : ""}
                    {card.accuracy.took.toLocaleString()} of{" "}
                    {card.accuracy.chances.toLocaleString()} chances across{" "}
                    {card.accuracy.gamesReaching.toLocaleString()} games
                    {card.accuracy.setAside > 0
                      ? ` · ${card.accuracy.setAside.toLocaleString()} set aside`
                      : ""}
                  </p>
                </div>
              ) : (
                <p className="phase-missing">
                  How often you take a chance in the {card.name} is recorded against every
                  observation and is not published to this screen yet. Forma will not split the
                  figures it does publish to fill the gap.
                </p>
              )}

              {/* How much your games move here. A different statement from the
                  rate above, and deliberately not merged with it: where the
                  mistakes are and where they start costing whole games are
                  frequently different phases. */}
              <div className="phase-band">
                <p className="phase-figure is-secondary">
                  <b>{signed(card.growth)}</b>
                  <small>points wider by the end</small>
                </p>
                <p className="phase-reading">{card.reading}</p>
                <p className="phase-evidence">
                  {card.exit} {card.games.toLocaleString()}{" "}
                  {card.games === 1 ? "game" : "games"} · {pct(card.reachRate)} of your games reach
                  it.
                </p>
                {card.scopeNote ? <p className="phase-evidence">{card.scopeNote}</p> : null}
                {card.caution ? <p className="phase-caution">{card.caution}</p> : null}
              </div>
            </li>
          ))}
        </ol>
      </div>

      <figcaption>
        <p className="cone-finding">{finding.detail}</p>
        {finding.lopsided ? <p className="cone-finding">{finding.lopsided}</p> : null}
        {rowFinding ? <p className="cone-finding">{rowFinding}</p> : null}
        {cone.unreached.length > 0 ? (
          <p className="cone-absent">
            Your games did not reach the {cone.unreached.join(" or ")}, so that part of the picture
            is absent rather than flat.
          </p>
        ) : null}
        <p className="cone-note">
          Expected score from your side of the board, from the engine that read every move. The
          shaded region is the middle half of your games at that point, coloured by which side of
          level it falls; the line through it is the median; the strip underneath is how many games
          are still being counted, and the band fades with it. Each phase is measured across its own
          length, which is what the dashed dividers mark.
        </p>
      </figcaption>
      <p id={descriptionId} className="sr-only">
        {coneText(cone)}
      </p>
    </figure>
  );
}

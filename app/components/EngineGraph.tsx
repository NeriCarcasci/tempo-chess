import { useCallback, useMemo, useRef, useState } from "react";
import { FigureNote } from "./FigureNote";
import {
  oneIn,
  readAll,
  readMove,
  readWindow,
  signedPawns,
  smoothPath,
  winShare,
  type GraphColumn,
  type PlayerGraph,
} from "../lib/todayGraph";

/**
 * The engine graph, per player rather than per game.
 *
 * A game report draws one game's evaluation against its own move numbers. This
 * draws every analysed game against the same axis at once, which is the thing
 * no site tells a player: not that they make mistakes, but *where in a game*
 * the mistakes are, and that is a distribution rather than a number.
 *
 * Three registers, one x-axis, read top to bottom as position, cost, and how
 * much of the history is still under the reading:
 *
 *   evaluation  where your games typically stand, while enough are still going
 *   cost        the share of your moves that cost 90 centipawns or more
 *   n           how many games reached this move number at all
 *
 * The third register is the honesty of the first two drawn rather than written.
 * `moves` at a move number *is* the number of analysed games that reached it,
 * so the rail is a count, and a reader can see for themselves that the right
 * of the figure rests on a fraction of the games.
 *
 * Accent means exactly one thing in this figure: cost. The ink ring means "the
 * one worth starting from", the same as it does on the openings page. Nothing
 * else here is coloured.
 */

const FIELD_W = 1000;
const FIELD_H = 260;
/** Keeps a 2px stroke on the band from clipping at the top and bottom edges. */
const INSET = 4;

/**
 * The rules the field is read against: level, a pawn either way, three either
 * way. Fixed values rather than a fitted domain, because the axis is logistic —
 * a label's height is what carries the scale, so the same label has to mean the
 * same height on every player's page.
 */
const RULES = [300, 100, 0, -100, -300] as const;

/** The survival rail's own box. Short: it is a check, not a chart. */
const RAIL_H = 34;

/** Where a centipawn value sits in the field, top-down. */
function yOf(cp: number): number {
  return FIELD_H / 2 - winShare(cp) * (FIELD_H / 2 - INSET);
}

/** The same, as a share of the field's height, for the labels in the gutter. */
function topOf(cp: number): number {
  return (yOf(cp) / FIELD_H) * 100;
}

export function EngineGraph({
  graph,
  username,
  truncatedAt,
}: {
  graph: PlayerGraph;
  username: string;
  /** The last move number the full figure would have drawn, when narrowed. */
  truncatedAt?: number | null;
}) {
  const { columns, cohort, window: peak } = graph;
  const [at, setAt] = useState<number | null>(null);
  const figure = useRef<HTMLDivElement | null>(null);

  const n = columns.length;

  // Column centres, so the line, the squares, the rail and the axis all sit on
  // one grid. Mapping the line edge to edge instead would drift it half a
  // column away from the squares it is supposed to be read against.
  const xOf = useCallback((index: number) => ((index + 0.5) / n) * FIELD_W, [n]);

  // The leading run only. A later column with a big enough sample would
  // otherwise draw a second, disconnected fragment claiming to be the same line.
  const evalRun = useMemo(() => {
    const run: GraphColumn[] = [];
    for (const column of columns) {
      if (!column.drawEval) break;
      run.push(column);
    }
    return run;
  }, [columns]);

  const paths = useMemo(() => {
    if (evalRun.length < 2) return null;
    const points = (pick: (column: GraphColumn) => number) =>
      evalRun.map((column, index) => ({ x: xOf(index), y: yOf(pick(column)) }));
    const top = points((column) => column.p75Eval);
    const bottom = points((column) => column.p25Eval).reverse();
    return {
      line: smoothPath(points((column) => column.medianEval)),
      // One closed shape, so the join between the two edges is a corner the
      // round linejoin can soften rather than a seam between two paths.
      band: `${smoothPath(top)} ${smoothPath(bottom, "L")} Z`,
    };
  }, [evalRun, xOf]);

  /**
   * The survival rail, as one area rather than thirty five bars.
   *
   * Drawn as bars it was the cost lane again in a lighter grey — same width,
   * same rhythm, near enough the same height at every column, and a reader has
   * to work out that the two registers are not the same kind of thing. A curve
   * is a different kind of mark, and what this register says is a shape: your
   * history is whole here, and by move thirty it is a third of itself.
   */
  const rail = useMemo(() => {
    if (!n) return null;
    const inner = RAIL_H - 2;
    const yAt = (column: GraphColumn) =>
      RAIL_H - Math.max(0, Math.min(1, column.survival)) * inner;
    const points = columns.map((column, index) => ({ x: xOf(index), y: yAt(column) }));
    // Squared off to the field's edges, so the rail spans the same width as
    // every other register instead of stopping half a column short of it.
    points.unshift({ x: 0, y: points[0]!.y });
    points.push({ x: FIELD_W, y: points[points.length - 1]!.y });
    const edge = smoothPath(points);
    // The edge is stroked and the area is filled, as two paths, because one
    // path closed to the baseline would draw a stroke along the baseline too —
    // a second horizontal rule under the figure that means nothing.
    return { edge, area: `${edge} L${FIELD_W} ${RAIL_H} L0 ${RAIL_H} Z` };
  }, [columns, n, xOf]);

  /**
   * Where the drawn position ends, in field coordinates.
   *
   * The rules run the full width because the axis does, but past this point
   * nothing is measured, and a rule at full strength over an empty third of the
   * field invites a reader to look for a line that is deliberately not there.
   * So they carry on faintly instead, and the dashed stop says where.
   */
  const stopAt = evalRun.length && evalRun.length < n ? xOf(evalRun.length - 1) : FIELD_W;

  const pointed = at != null ? columns[at] ?? null : null;

  /**
   * One reading, one source. The visible line, the figure's accessible label
   * and any hover text all come from here, so the picture and its description
   * can never disagree about the same column.
   */
  const readout = pointed
    ? readMove(pointed, cohort)
    : peak
      ? readWindow(peak)
      : readAll(graph);

  const onPointer = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const box = figure.current?.getBoundingClientRect();
      if (!box || !n) return;
      const ratio = (event.clientX - box.left) / box.width;
      setAt(Math.max(0, Math.min(n - 1, Math.floor(ratio * n))));
    },
    [n],
  );

  const onKey = useCallback(
    (event: React.KeyboardEvent) => {
      if (!n) return;
      const current = at ?? 0;
      if (event.key === "ArrowRight") setAt(Math.min(n - 1, current + 1));
      else if (event.key === "ArrowLeft") setAt(Math.max(0, current - 1));
      else if (event.key === "Home") setAt(0);
      else if (event.key === "End") setAt(n - 1);
      else if (event.key === "Escape") setAt(null);
      else return;
      event.preventDefault();
    },
    [at, n],
  );

  const ticks = new Set([1, 5, 10, 15, 20, 25, 30, 35, columns[n - 1]?.moveNumber ?? 0]);

  /**
   * The columns the heading names, as a rule under them rather than a ring
   * around them.
   *
   * The ring is the openings page's mark and it means "the one worth starting
   * from" — one square, on a strip of many. Three squares in a row each wearing
   * their own two-pixel ink border is not that mark; it is three boxes, and the
   * thing being pointed at is the *run*, which a box around each member of it
   * cannot say. A single rule beneath them can.
   */
  const brace = useMemo(() => {
    if (!peak) return null;
    const from = columns.findIndex((column) => column.moveNumber >= peak.from);
    const to = columns.findIndex((column) => column.moveNumber >= peak.to);
    if (from < 0 || to < from) return null;
    return { left: (from / n) * 100, width: ((to - from + 1) / n) * 100 };
  }, [columns, n, peak]);

  return (
    <figure className="today-graph">
      {/* One line, fixed height, above the plot: the figure never reflows under
          a pointer and the reading is never occluded by the thing it reads. */}
      <p className="today-graph-readout" aria-live="polite">
        <b>{readout.scope}</b>
        {readout.figures.map((figure) => (
          <span key={figure}>{figure}</span>
        ))}
      </p>

      <div
        className="today-graph-plot"
        ref={figure}
        onPointerMove={onPointer}
        onPointerLeave={() => setAt(null)}
      >
        {/* Register A: where your games stand, while enough are still going. */}
        <div className="today-field">
          <span className="cap today-reg">evaluation</span>
          {paths ? (
            <svg
              viewBox={`0 0 ${FIELD_W} ${FIELD_H}`}
              preserveAspectRatio="none"
              role="img"
              tabIndex={0}
              onKeyDown={onKey}
              aria-label={`Your evaluation and the cost of your moves, by your own move number. ${readout.sentence}`}
            >
              {RULES.filter((cp) => cp !== 0).map((cp) => (
                <g key={cp}>
                  <line
                    className="today-rule"
                    x1={0}
                    y1={yOf(cp)}
                    x2={stopAt}
                    y2={yOf(cp)}
                    vectorEffect="non-scaling-stroke"
                  />
                  {stopAt < FIELD_W ? (
                    <line
                      className="today-rule is-unread"
                      x1={stopAt}
                      y1={yOf(cp)}
                      x2={FIELD_W}
                      y2={yOf(cp)}
                      vectorEffect="non-scaling-stroke"
                    />
                  ) : null}
                </g>
              ))}
              {/* An opaque fill with a same-colour round-joined stroke. Opaque
                  because a translucent band over five rules is a plaid; round
                  because the band's corners are the sampling interval rather
                  than anything that happened in a game. */}
              <path className="today-band" d={paths.band} vectorEffect="non-scaling-stroke" />
              {/* Level goes over the band, not under it: it is the one line the
                  reader has to be able to find inside the middle half. */}
              <line className="today-zero" x1={0} y1={yOf(0)} x2={stopAt} y2={yOf(0)} vectorEffect="non-scaling-stroke" />
              {stopAt < FIELD_W ? (
                <line className="today-zero is-unread" x1={stopAt} y1={yOf(0)} x2={FIELD_W} y2={yOf(0)} vectorEffect="non-scaling-stroke" />
              ) : null}
              <path className="today-median" d={paths.line} vectorEffect="non-scaling-stroke" />
              {/* Where the position stops being drawn, drawn. The sentence under
                  the field says why; this says where, on the axis itself. */}
              {stopAt < FIELD_W ? (
                <line
                  className="today-evalstop"
                  x1={stopAt}
                  y1={0}
                  x2={stopAt}
                  y2={FIELD_H}
                  vectorEffect="non-scaling-stroke"
                />
              ) : null}
              {at != null ? (
                <g>
                  <line
                    className="today-hair"
                    x1={xOf(at)}
                    y1={0}
                    x2={xOf(at)}
                    y2={FIELD_H}
                    vectorEffect="non-scaling-stroke"
                  />
                </g>
              ) : null}
            </svg>
          ) : (
            <p className="today-field-empty">
              Your evaluation is not drawn yet. No move number has {graph.evalFloor} of
              your analysed games reaching it with an evaluation on record.
            </p>
          )}
          {paths ? (
            <span className="today-eval-scale" aria-hidden="true">
              {RULES.map((cp) => (
                <b key={cp} data-level={cp === 0 ? "" : undefined} style={{ top: `${topOf(cp)}%` }}>
                  {cp === 0 ? "level" : signedPawns(cp)}
                </b>
              ))}
            </span>
          ) : null}
        </div>

        {graph.evalEndsAt != null && graph.evalEndsAt < (columns[n - 1]?.moveNumber ?? 0) ? (
          <p className="today-truncation">
            Your evaluation stops at move {graph.evalEndsAt}:{" "}
            {graph.evalStopReason === "survival"
              ? "fewer than half your games are still going after it."
              : `after it, fewer than ${graph.evalFloor} of your games reach that move.`}
          </p>
        ) : null}

        {/* Register B: the cost lane, on the openings page's own ramp. */}
        <div className="today-lane-row">
          <span className="cap today-reg">cost</span>
          <div className="today-lane">
            {columns.map((column, index) => (
              <span key={column.moveNumber} className="today-cell">
                <span
                  className={`line-sq ${at === index ? "is-picked" : ""}`}
                  data-heat={column.heat}
                  data-state={column.heat ? "scored" : "thin"}
                  style={{ ["--i" as string]: index }}
                />
              </span>
            ))}
          </div>
          {brace ? (
            <div className="today-lane-brace" aria-hidden="true">
              <i style={{ left: `${brace.left}%`, width: `${brace.width}%` }} />
            </div>
          ) : null}
        </div>

        {/* Register C: how many games are still under the reading. */}
        <div className="today-rail-row">
          <span className="cap today-reg">n</span>
          <div className="today-rail">
            {rail ? (
              <svg
                viewBox={`0 0 ${FIELD_W} ${RAIL_H}`}
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <path className="today-rail-area" d={rail.area} />
                <path className="today-rail-edge" d={rail.edge} vectorEffect="non-scaling-stroke" />
              </svg>
            ) : null}
          </div>
        </div>

        <div className="today-axis" aria-hidden="true">
          {columns.map((column) => (
            <span key={column.moveNumber}>{ticks.has(column.moveNumber) ? column.moveNumber : ""}</span>
          ))}
        </div>

        {truncatedAt != null && columns[n - 1] ? (
          <p className="today-truncation">
            Moves {columns[n - 1]!.moveNumber + 1} to {truncatedAt} are not drawn at this
            width.
          </p>
        ) : null}

        <div className="today-phasebar" aria-hidden="true">
          {graph.phaseRuns.map((run) => (
            <span
              key={`${run.phase}-${run.from}`}
              className="today-phaserun"
              style={{ flexGrow: run.to - run.from + 1 }}
            >
              <b className="cap">{run.phase}</b>
            </span>
          ))}
        </div>
      </div>

      {/*
        The one sentence you cannot read the picture without, and the
        definitions behind a mark.

        This was a seventy five word paragraph sitting under the figure, opening
        on a count the page's own provenance footer already gives. None of it
        was wrong, and none of it could be thrown away either: the lane's
        thresholds and the sign convention are what make the figure checkable
        rather than decorative, which is the whole argument of PRODUCT.md's
        first principle. So it moved behind a mark rather than being deleted.
        What stays visible is the sign, because a reader who does not know which
        way is up is not reading the chart at all.
      */}
      <figcaption>
        <p>
          Positive is better for you, whichever colour you had.
          <FigureNote title="How this figure is measured">
            <p>
              The lane is the share of your moves at each move number that cost 90
              centipawns or more. It darkens at 12% and again at 25%, the same
              thresholds your openings page uses. The line is the middle of the games
              that reached that move, and the band is their middle half.
            </p>
            <p>
              A move number is drawn while {graph.laneFloor} of your {graph.cohort}{" "}
              analysed games still reach it. Fewer and fewer of them do as a game goes
              on, which is what the rail marked <b>n</b> is: at the right of the figure
              you are reading a fraction of your history, and the rail is how much.
            </p>
            <p>
              The vertical axis is the difference an evaluation makes to the result
              rather than the evaluation itself, so the same distance means the same
              thing whether you are level or three pawns down.
              {graph.saturated
                ? " Some of those games were already decided, and those evaluations stop at 10.00."
                : ""}
            </p>
          </FigureNote>
        </p>
      </figcaption>

      {/*
        The series in text. A picture is not an accessible equivalent of itself,
        so the numbers are reachable rather than merely described. Clipped, not
        `display: none`, which would take it out of the accessibility tree.

        The clipping lives on a wrapping block rather than on the table: a table
        in auto layout takes its min-content width whatever `width` says, so
        clipping it directly leaves it at full width and pushes the page
        sideways on a phone.
      */}
      <div className="today-series">
      <table>
        <caption>{username}: cost and evaluation by move number</caption>
        <thead>
          <tr>
            <th scope="col">Move number</th>
            <th scope="col">Games reaching it</th>
            <th scope="col">Centipawns a move</th>
            <th scope="col">Moves costing 90 or more</th>
          </tr>
        </thead>
        <tbody>
          {columns.map((column) => (
            <tr key={column.moveNumber}>
              <th scope="row">{column.moveNumber}</th>
              <td>{column.moves}</td>
              <td>{column.avgLoss}</td>
              <td>{column.errors}{oneIn(column.errorRate) ? ` (${oneIn(column.errorRate)})` : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </figure>
  );
}

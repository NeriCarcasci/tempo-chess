import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import { Board } from "./Board";
import { Dial } from "./instruments";
import {
  MarkBack,
  MarkConvert,
  MarkDefend,
  MarkDone,
  MarkDrill,
  MarkLesson,
  MarkLocked,
  MarkPosition,
  MarkStar,
  MarkTactic,
  PhaseFace,
} from "./pathMarks";
import { MOVEMENT_COPY, type PhaseReading } from "../lib/v1/dashboard";
import type { PathFace, PathNode } from "../lib/v1/pathNodes";
import type { PhaseKey } from "../lib/v1/phases";

/**
 * The path, as a canvas rather than a page.
 *
 * Three entrances stand in one space, each with a road leaving it, and
 * pressing one flies a camera down that road into that phase's territory.
 * Nothing scrolls. The camera travels.
 *
 * ## The camera
 *
 * One progress value drives the whole move, and `x`, `y` and `scale` are all
 * derived from it. That is not a stylistic choice: three independent springs
 * on the three transform channels let the framing drift mid-flight, because
 * the translation is computed against a scale that has not arrived yet. With
 * one progress value the frame is correct at every instant, which is what
 * makes the arrival land on the thing you pressed.
 *
 * ## A path runs the way you were already going
 *
 * This is per-territory, and getting it wrong once is what taught it. The
 * opening sits *above* the hub, so you fly up to it - and its first draft then
 * walked you back down, which is a reversal at exactly the moment a reader is
 * getting their bearings. The fix is not "every path climbs": that just moved
 * the reversal onto the other two, which sit below the hub and are travelled
 * downward.
 *
 * So each territory carries its own `dir`, and it is always the direction the
 * camera was already moving: the opening climbs, the middlegame and the
 * endgame descend. Travel and path are one continuous motion in every case,
 * and it is also what keeps a road from ever crossing the path it leads to,
 * because the two occupy different ground by construction.
 */

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

/** Where the three entrances stand. Deliberately not joined to each other. */
const CIRCLES: Record<PhaseKey, { x: number; y: number }> = {
  opening: { x: 0, y: -300 },
  middlegame: { x: -380, y: 250 },
  endgame: { x: 380, y: 250 },
};

/**
 * Each territory: where its path starts, and which way it runs.
 *
 * `dir` is -1 for a path that climbs and 1 for one that descends, and it
 * always continues the direction of travel from the hub.
 */
const REGIONS: Record<PhaseKey, { x: number; y: number; dir: 1 | -1 }> = {
  opening: { x: 0, y: -3200, dir: -1 },
  middlegame: { x: -3400, y: 1200, dir: 1 },
  endgame: { x: 3400, y: 1200, dir: 1 },
};

const HUB = { x: 0, y: 0, scale: 1 };
/** The step between stops, and the swing either side of the route. */
const STEP = 250;
const SWING = 135;

/** Where a stop sits. Index 0 is the start; the path runs from there. */
function nodeAt(region: { x: number; y: number; dir: number }, index: number) {
  return {
    x: region.x + Math.sin(index * 1.15) * SWING,
    y: region.y + region.dir * index * STEP,
  };
}

/**
 * The road out of an entrance, heading toward its territory.
 *
 * **It is a departure, not a connection.** Two drafts tried to draw the whole
 * distance and both failed the same way: a territory's own path occupied the
 * corridor its road had to travel, so the line crossed the heading and every
 * stop it was meant to lead to. Bowing the curve only moved where it crossed.
 *
 * So the road leaves the circle, bends, and fades to nothing well short of the
 * territory. That is also the honest reading - the line says "there is
 * somewhere that way", and once you have travelled, the territory has a path
 * of its own. Nothing needs to be joined.
 */
function roadOut(circle: { x: number; y: number }, region: { x: number; y: number }) {
  const dx = region.x - circle.x;
  const dy = region.y - circle.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const reach = 1800;
  const end = { x: circle.x + ux * reach, y: circle.y + uy * reach };
  const control = {
    x: circle.x + ux * (reach / 2) + -uy * 240,
    y: circle.y + uy * (reach / 2) + ux * 240,
  };
  return { d: `M ${circle.x} ${circle.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`, from: circle, to: end };
}

/**
 * A smooth route through the stops, in world coordinates.
 *
 * Plain curves and nothing else. Every third gap carried a loop for one
 * revision, on the argument that an even left-right ladder reads as a chart
 * axis - but a loop drawn in dots is a knot, it reads as the route doubling
 * back on itself, and it put a tangle between two stops that have nothing to
 * do with each other. The swing of the path is enough character on its own.
 */
function routePath(region: { x: number; y: number; dir: number }, count: number): string {
  if (count < 2) return "";
  const points = Array.from({ length: count }, (_, index) => nodeAt(region, index));
  let d = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const point = points[index]!;
    const midY = (previous.y + point.y) / 2;
    d += ` C ${previous.x} ${midY}, ${point.x} ${midY}, ${point.x} ${point.y}`;
  }
  return d;
}

export interface CanvasRegion {
  phase: PhaseKey;
  name: string;
  /** What the entrance says under its name. Never a completion figure. */
  standing: string;
  nodes: PathNode[];
  reading: PhaseReading | null;
  summary: string;
  /** The phase's own counts, for the panel beside the path. */
  split: { handled: number; missed: number; setAside: number } | null;
  gamesReaching: number | null;
}

interface Camera {
  x: number;
  y: number;
  scale: number;
}

export function PathCanvas({ regions }: { regions: readonly CanvasRegion[] }) {
  const reduced = useReducedMotion();
  const [where, setWhere] = useState<PhaseKey | null>(null);
  const [open, setOpen] = useState<PathNode | null>(null);

  const progress = useMotionValue(1);
  const from = useRef<Camera>(HUB);
  const to = useRef<Camera>(HUB);
  const [dip, setDip] = useState(0);
  /** How far along its own path the camera has walked, in world units. */
  const walked = useMotionValue(0);
  const ceiling = useRef(0);
  /** Which way the current territory runs, so walking follows the path. */
  const heading = useRef<1 | -1>(1);
  /**
   * How far the world slides left to make room for an opened stop.
   *
   * The sheet takes three quarters of the screen, so without this the stop a
   * reader just pressed ends up underneath it. Sliding the world instead of
   * shrinking it keeps the scale - and therefore the reading of the route -
   * exactly as it was.
   */
  const shift = useMotionValue(0);

  const scale = useTransform(progress, (value) => {
    const base = from.current.scale + (to.current.scale - from.current.scale) * value;
    return base * (1 - dip * Math.sin(Math.PI * value));
  });
  const x = useTransform([progress, scale, shift], ([value, size, aside]: number[]) => {
    const cx = from.current.x + (to.current.x - from.current.x) * (value as number);
    return -cx * (size as number) + (aside as number);
  });
  const y = useTransform([progress, scale, walked], ([value, size, along]: number[]) => {
    const cy = from.current.y + (to.current.y - from.current.y) * (value as number);
    return -(cy + heading.current * (along as number)) * (size as number);
  });

  const travel = useCallback(
    (target: Camera, distance: number) => {
      from.current = {
        x: from.current.x + (to.current.x - from.current.x) * progress.get(),
        y:
          from.current.y +
          (to.current.y - from.current.y) * progress.get() +
          heading.current * walked.get(),
        scale: scale.get(),
      };
      to.current = target;
      walked.set(0);
      setDip(reduced ? 0 : Math.min(0.6, distance / 9000));
      progress.set(0);
      animate(progress, 1, reduced ? { duration: 0 } : { duration: 1.3, ease: [0.16, 1, 0.3, 1] });
    },
    [progress, reduced, scale, walked],
  );

  const enter = useCallback(
    (phase: PhaseKey) => {
      const region = REGIONS[phase];
      const circle = CIRCLES[phase];
      const found = regions.find((entry) => entry.phase === phase);
      ceiling.current = Math.max(0, ((found?.nodes.length ?? 1) - 1) * STEP);
      heading.current = region.dir;
      setWhere(phase);
      setOpen(null);
      // Arrive just short of the start, so the first stop and the territory's
      // name are both in frame on landing.
      travel(
        { x: region.x, y: region.y - region.dir * 80, scale: 1 },
        Math.hypot(region.x - circle.x, region.y - circle.y),
      );
    },
    [regions, travel],
  );

  const leave = useCallback(() => {
    const distance = where ? Math.hypot(REGIONS[where].x, REGIONS[where].y) : 0;
    setWhere(null);
    setOpen(null);
    ceiling.current = 0;
    travel(HUB, distance);
    heading.current = 1;
  }, [travel, where]);

  // Walking a path is the wheel: inside a territory there is no document to
  // scroll. Wheeling forward always walks *along* the path, whichever way that
  // territory runs, so the gesture means the same thing in all three.
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (where === null) return;
      event.preventDefault();
      walked.set(Math.min(ceiling.current, Math.max(0, walked.get() + event.deltaY)));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [walked, where]);

  // The world slides aside for an opened stop, and back when it closes.
  useEffect(() => {
    const room = open ? -Math.round(window.innerWidth * 0.375) : 0;
    animate(shift, room, reduced ? { duration: 0 } : { duration: 0.42, ease: [0.16, 1, 0.3, 1] });
  }, [open, reduced, shift]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (open) setOpen(null);
      else if (where) leave();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [leave, open, where]);

  const here = useMemo(() => regions.find((entry) => entry.phase === where) ?? null, [regions, where]);

  return (
    <div className="canvas" ref={viewport}>
      <motion.div className="canvas-world" style={{ x, y, scale }}>
        <svg
          className="canvas-wires"
          viewBox="-6000 -6000 12000 12000"
          style={{ left: -6000, top: -6000, width: 12000, height: 12000 }}
          aria-hidden="true"
        >
          {/* A stroke gradient per road, in world coordinates, so each fades
              along its own direction. The stops name their colour outright:
              `currentColor` inside `<defs>` resolves against the gradient's
              own inherited colour rather than the path referencing it, so the
              roads came out in body ink and the live one never turned. */}
          <defs>
            {(Object.keys(CIRCLES) as PhaseKey[]).map((phase) => {
              const road = roadOut(CIRCLES[phase], REGIONS[phase]);
              const tone = where === phase ? "var(--color-accent)" : "var(--color-line-strong)";
              return (
                <linearGradient
                  key={`fade:${phase}`}
                  id={`road-${phase}`}
                  gradientUnits="userSpaceOnUse"
                  x1={road.from.x}
                  y1={road.from.y}
                  x2={road.to.x}
                  y2={road.to.y}
                >
                  <stop offset="0%" stopColor={tone} stopOpacity="0.9" />
                  <stop offset="55%" stopColor={tone} stopOpacity="0.45" />
                  <stop offset="100%" stopColor={tone} stopOpacity="0" />
                </linearGradient>
              );
            })}
          </defs>

          {(Object.keys(CIRCLES) as PhaseKey[]).map((phase) => (
            <path
              key={phase}
              className="canvas-road"
              d={roadOut(CIRCLES[phase], REGIONS[phase]).d}
              stroke={`url(#road-${phase})`}
              fill="none"
            />
          ))}

          {/* The route: one dotted accent line and nothing else.
              It was a wide grey bed under a white surface under a centre-line,
              which is a lot of road for a canvas whose only other marks are
              circles - the stops sat *on* it rather than *in* it. A single
              line of the brand colour runs behind every face instead, so the
              stops thread onto the road rather than covering it.
              The locked tail is the same line, quieter. */}
          {regions.map((region) => {
            const open = region.nodes.filter((node) => node.kind !== "locked").length;
            return (
              <g key={`route:${region.phase}`}>
                <path
                  className="canvas-route is-locked"
                  d={routePath(REGIONS[region.phase], region.nodes.length)}
                  fill="none"
                />
                <path
                  className="canvas-route"
                  d={routePath(REGIONS[region.phase], open)}
                  fill="none"
                />
              </g>
            );
          })}
        </svg>

        {/* The three entrances. Big, round, and pressable. Each counts this
            player's own waiting evidence and never a percentage: a ring filled
            to 72% under the word "Opening" says the opening is 72% complete,
            and nothing here is completable. */}
        {regions.map((region) => (
          <button
            key={region.phase}
            type="button"
            className={`orb is-${region.phase}${where === region.phase ? " is-here" : ""}`}
            style={{ left: CIRCLES[region.phase].x, top: CIRCLES[region.phase].y }}
            onClick={() => enter(region.phase)}
            aria-label={`${region.name}. ${region.standing}. Travel there.`}
          >
            <span className="orb-face" aria-hidden="true">
              <PhaseFace phase={region.phase} />
            </span>
            <span className="orb-label">
              <b>{region.name}</b>
              <small>{region.standing}</small>
            </span>
          </button>
        ))}

        {/* Each territory's masthead, at the start of its own path: its name
            and everything Forma has measured about it.

            This was a floating card pinned to the corner of the screen, which
            is the shape of a default modal - it hovered over the world rather
            than belonging to it, and it said nothing about *where* you were.
            Standing it at the head of the path makes it the territory's own
            sign. It is still not among the stops: a measurement set on the
            route would read as a thing to complete. */}
        {regions.map((region) => (
          <div
            key={`region:${region.phase}`}
            className="region"
            style={{
              left: REGIONS[region.phase].x,
              top: REGIONS[region.phase].y - REGIONS[region.phase].dir * 340,
            }}
          >
            <h2>{region.name}</h2>
            <p>{region.summary}</p>
            <RegionStats region={region} />
          </div>
        ))}

        {regions.map((region) =>
          region.nodes.map((node, index) => (
            <PathStop
              // Re-keyed on arrival so the stops of the territory you land in
              // play their entrance rather than being there already.
              key={`${node.id}:${where ?? "hub"}`}
              node={node}
              at={nodeAt(REGIONS[region.phase], index)}
              index={index}
              live={where === region.phase}
              first={index === 0}
              reduced={reduced ?? false}
              onOpen={() => setOpen(node)}
            />
          )),
        )}
      </motion.div>

      {/* Everything below is chrome over the canvas, never on the path. */}
      <BackControl where={where} open={open !== null} onLeave={leave} onClose={() => setOpen(null)} />
      {where === null ? (
        <div className="canvas-head">
          <h1>Your path</h1>
          <p>Three parts of a game. Pick one and travel there.</p>
        </div>
      ) : null}
      {open ? <StopSheet node={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

/**
 * The way out, and the only chrome at the top of the screen.
 *
 * The product's nav bar does not render on this route. A canvas somebody is
 * flying around is a place, and a sticky bar with a logo and three tabs across
 * the top of it is browser chrome bolted to a map. One arrow is enough: out of
 * a territory, then out of the canvas.
 */
function BackControl({
  where,
  open,
  onLeave,
  onClose,
}: {
  where: PhaseKey | null;
  open: boolean;
  onLeave: () => void;
  onClose: () => void;
}) {
  // Back undoes one step at a time. With a stop open it closes that stop and
  // leaves you standing where you were; pressing it again leaves the
  // territory. Doing both at once threw away the place a reader had just
  // travelled to, which is a lot to lose to one press.
  if (open) {
    return (
      <button type="button" className="canvas-back" onClick={onClose} aria-label="Close this stop">
        <MarkBack />
      </button>
    );
  }
  if (where === null) {
    return (
      <Link to="/today" className="canvas-back" aria-label="Back to Today">
        <MarkBack />
      </Link>
    );
  }
  return (
    <button type="button" className="canvas-back" onClick={onLeave} aria-label="Back to all three">
      <MarkBack />
    </button>
  );
}

/** Every face a stop can wear. The taxonomy lives in `pathNodes.ts`. */
const FACES: Record<PathFace, React.ReactNode> = {
  position: <MarkPosition />,
  tactic: <MarkTactic />,
  defend: <MarkDefend />,
  convert: <MarkConvert />,
  lesson: <MarkLesson />,
  drill: <MarkDrill />,
  locked: <MarkLocked />,
};

/**
 * One stop: a face, and its name beside it.
 *
 * **Beside, not under.** The route swings left and right down the middle of
 * the territory, and a name centred under each face sits directly on the line
 * to the next stop - so the type ran through the road at every step. Hanging
 * the name off the outer side of the swing keeps the middle clear and gives
 * the eye one column of text to read down instead of a zigzag.
 *
 * The name and nothing else. Every stop used to carry a counted line too, and
 * forty of those down a path is a wall of small grey type that turns a route
 * back into a table. The counts are on the panel and on the stop's own sheet,
 * which is where somebody who wants a number is actually looking.
 */
function PathStop({
  node,
  at,
  index,
  live,
  first,
  reduced,
  onOpen,
}: {
  node: PathNode;
  at: { x: number; y: number };
  index: number;
  live: boolean;
  first: boolean;
  reduced: boolean;
  onOpen: () => void;
}) {
  const side = Math.sin(index * 1.15) >= 0 ? "is-right" : "is-left";
  const locked = node.kind === "locked";
  const className = [
    "stop",
    `is-${node.kind}`,
    side,
    first && !node.done ? "is-first" : "",
    node.done ? "is-done" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const body = (
    <>
      <span className="stop-face" aria-hidden="true">
        {FACES[node.face]}
        {node.done ? (
          <span className="stop-done">
            <MarkDone />
          </span>
        ) : null}
      </span>
      <span className="stop-name">
        {node.title}
        {node.stars !== null ? (
          <span className="stop-stars" aria-label={`${node.stars} of 3 stars`}>
            {[0, 1, 2].map((index) => (
              <MarkStar key={index} filled={index < node.stars!} />
            ))}
          </span>
        ) : null}
      </span>
    </>
  );

  return (
    <motion.div
      className="stop-slot"
      style={{ left: at.x, top: at.y }}
      initial={reduced ? false : { opacity: 0, scale: 0.72 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{
        delay: live && !reduced ? Math.min(index * 0.055, 0.6) : 0,
        duration: reduced ? 0 : 0.45,
        ease: [0.16, 1, 0.3, 1],
      }}
    >
      {locked ? (
        <div className={`${className} is-inert`} title={node.detail}>
          {body}
        </div>
      ) : (
        <button
          type="button"
          className={className}
          onClick={onOpen}
          aria-label={`${node.title}. ${node.detail}.`}
        >
          {body}
        </button>
      )}
    </motion.div>
  );
}

/**
 * What Forma has measured about this territory, on its own sign.
 *
 * Every figure here is published: the rate and its interval come from the
 * estimator, the counts from the phase card, and the movement is the one
 * comparison the estimator says is valid. Nothing is scored out of anything
 * else - the three territories are not comparable and the canvas never puts
 * them side by side.
 */
function RegionStats({ region }: { region: CanvasRegion }) {
  const reading = region.reading;
  const split = region.split;
  const total = split ? split.handled + split.missed + split.setAside || 1 : 1;

  if (!reading || reading.rate === null) {
    return (
      <p className="region-none">
        {region.gamesReaching === 0 ? "None of your games reach this phase." : "Not measured yet."}
      </p>
    );
  }

  return (
    <div className="region-stats">
      <div className="region-figure">
        <Dial
          value={reading.rate}
          low={reading.intervalLow}
          high={reading.intervalHigh}
          size={92}
          title={`${region.name}: ${Math.round(reading.rate * 100)}% of key moments handled`}
          mark={<PhaseFace phase={region.phase} />}
        />
        <p className="region-read">
          <span>Handled</span>
          <b>{Math.round(reading.rate * 100)}%</b>
          <small>
            {reading.took.toLocaleString()} of {reading.chances.toLocaleString()} key moments
          </small>
        </p>
      </div>

      {split ? (
        <div className="region-split">
          <div className="region-bar" aria-hidden="true">
            <span className="is-handled" style={{ flexBasis: `${(split.handled / total) * 100}%` }} />
            <span className="is-missed" style={{ flexBasis: `${(split.missed / total) * 100}%` }} />
            {split.setAside > 0 ? (
              <span className="is-aside" style={{ flexBasis: `${(split.setAside / total) * 100}%` }} />
            ) : null}
          </div>
          <ul className="region-key">
            <li>
              <i className="is-handled" aria-hidden="true" />
              {split.handled.toLocaleString()} handled
            </li>
            <li>
              <i className="is-missed" aria-hidden="true" />
              {split.missed.toLocaleString()} missed
            </li>
            {split.setAside > 0 ? (
              <li>
                <i className="is-aside" aria-hidden="true" />
                {split.setAside.toLocaleString()} set aside
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}

      <dl className="region-facts">
        {reading.intervalLow !== null && reading.intervalHigh !== null ? (
          <div>
            <dt>Likely range</dt>
            <dd className="metric">
              {Math.round(reading.intervalLow * 100)}&ndash;{Math.round(reading.intervalHigh * 100)}%
            </dd>
          </div>
        ) : null}
        <div>
          <dt>Against your earlier games</dt>
          <dd className={MOVEMENT_COPY[reading.movement].tone}>
            {MOVEMENT_COPY[reading.movement].label}
          </dd>
        </div>
        {region.gamesReaching !== null ? (
          <div>
            <dt>Games reaching here</dt>
            <dd className="metric">{region.gamesReaching.toLocaleString()}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

/**
 * A stop, opened.
 *
 * **Every stop opens the same way**, and that is the point of it. The first
 * version had review stops open a panel while lessons and drills navigated
 * straight off the canvas, so pressing two things that look identical did two
 * different kinds of thing - one of them throwing away the place you were
 * standing in. Now a press always opens the stop, the stop always says what it
 * is, and leaving the canvas is always a deliberate second press.
 */
function StopSheet({ node, onClose }: { node: PathNode; onClose: () => void }) {
  return (
    <motion.aside
      className="stop-sheet"
      initial={{ opacity: 0, x: 40 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.34, ease: [0.16, 1, 0.3, 1] }}
      aria-label={node.title}
    >
      {/* The way out sits on the seam between the sheet and the canvas, which
          is where a reader's eye already is: they are looking at the edge of
          the thing covering the path they came from. A cross in the far corner
          is the furthest point on the screen from that. */}
      <button type="button" className="stop-sheet-edge" onClick={onClose} aria-label="Close this stop">
        <MarkBack />
      </button>

      <div className="stop-sheet-inner">
        <header className="stop-sheet-head">
          {node.done ? <p className="stop-sheet-done">Finished</p> : null}
          <h2>{node.title}</h2>
          {node.subtitle ? <p className="stop-sheet-sub">{node.subtitle}</p> : null}
        </header>

        <div className="stop-sheet-body">
          {node.board ? (
            <figure className="stop-sheet-board">
              <Board fen={node.board.fen} size={420} flip={node.board.flip} arrows={arrowsFor(node.board)} />
              <figcaption>
                The move you played is drawn in red, the move that held in green.
              </figcaption>
            </figure>
          ) : null}

          <div className="stop-sheet-side">
            <p className="stop-sheet-detail">{node.detail}</p>

            {node.deck?.definition ? (
              <p className="stop-sheet-def">{node.deck.definition}</p>
            ) : null}

            {/* The evidence, where explaining is the job. It is deliberately
                not on the path: a route reads as places to go, and a count
                hung under every face turns it back into a table. */}
            {node.deck ? (
              <dl className="stop-sheet-facts">
                <div>
                  <dt>Handled here</dt>
                  <dd className="metric">
                    {node.deck.evidence.handled.toLocaleString()} of{" "}
                    {node.deck.evidence.seen.toLocaleString()}
                  </dd>
                </div>
                {node.deck.evidence.setAside > 0 ? (
                  <div>
                    <dt>Set aside</dt>
                    <dd className="metric">{node.deck.evidence.setAside.toLocaleString()}</dd>
                  </div>
                ) : null}
                {node.deck.rate !== null ? (
                  <div>
                    <dt>{node.deck.ratePooled ? "Across every phase" : "Handled rate here"}</dt>
                    <dd className="metric">
                      {Math.round(node.deck.rate * 100)}%
                      {node.deck.intervalLow !== null && node.deck.intervalHigh !== null
                        ? ` (${Math.round(node.deck.intervalLow * 100)}–${Math.round(node.deck.intervalHigh * 100)}%)`
                        : ""}
                    </dd>
                  </div>
                ) : null}
              </dl>
            ) : null}

            {node.progress && !node.done ? (
              <p className="stop-sheet-detail">
                {node.progress.done} of {node.progress.total} steps done
              </p>
            ) : null}

            {node.to ? (
              <Link to={node.to} className="primary-button btn-lg stop-sheet-go">
                {node.action ?? "Open"}
              </Link>
            ) : node.kind === "review" ? (
              <Link to="/practice" className="primary-button btn-lg stop-sheet-go">
                Drill positions like this
              </Link>
            ) : null}
          </div>
        </div>
      </div>
    </motion.aside>
  );
}

const sqFromAlg = (alg: string): number => (Number(alg[1]) - 1) * 8 + (alg.charCodeAt(0) - 97);
const uciSquares = (uci: string): [number, number] => [
  sqFromAlg(uci.slice(0, 2)),
  sqFromAlg(uci.slice(2, 4)),
];

/** The move played and the move that held, both under the pieces. */
function arrowsFor(board: NonNullable<PathNode["board"]>) {
  const arrows = [
    ...(board.playedMoveUci
      ? [
          {
            from: uciSquares(board.playedMoveUci)[0],
            to: uciSquares(board.playedMoveUci)[1],
            color: "var(--color-loss)",
          },
        ]
      : []),
    ...(board.bestMoveUci
      ? [
          {
            from: uciSquares(board.bestMoveUci)[0],
            to: uciSquares(board.bestMoveUci)[1],
            color: "var(--color-win)",
          },
        ]
      : []),
  ];
  return arrows.length > 0 ? arrows : undefined;
}

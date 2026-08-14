import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import type { OpeningGraph } from "../lib/openings";
import { Move } from "./Move";

/**
 * The map — the product's centrepiece.
 *
 * Your opening tree drawn as ink: branches fan out from wherever you stand,
 * thickness is how often your games go there, and one orange tear marks the
 * line that keeps costing you. Click a branch to walk it; the moves you have
 * walked collect on the left as tiles, and clicking a tile takes you back.
 *
 * Everything here renders from the graph the explorer already ships, so
 * walking is instant — no fetch per step, which is most of what makes it feel
 * like a map instead of a series of pages.
 */

/** Branches shown before the rest fold behind "quieter moves". */
const MAX_FAN = 6;
/** Vertical pitch of one branch row, px. */
const ROW = 62;
/** Width of the ribbon field between the junction and the chips, px. */
const FAN_W = 176;

interface Props {
  graph: OpeningGraph;
  /** Position key of the weak node — where the single orange tear points. */
  tearKey: string | null;
  /** Explorer href for the torn line, shown when the walk arrives there. */
  tearHref: string | null;
}

/**
 * Outgoing edges per node, indexed once. The graph arrives as flat arrays;
 * walking it by filtering 13k edges per click would still be fast, but this
 * makes every step O(1) and the tear-chain search linear.
 */
function useAdjacency(graph: OpeningGraph) {
  return useMemo(() => {
    const out = new Map<number, number[]>();
    graph.edges.forEach((e, i) => {
      const list = out.get(e.a);
      if (list) list.push(i);
      else out.set(e.a, [i]);
    });
    // Big branches first, everywhere, so the map reads top-down by weight.
    for (const list of out.values()) {
      list.sort((x, y) => graph.edges[y].g - graph.edges[x].g);
    }
    return out;
  }, [graph]);
}

/**
 * The edges on the way from the root to the torn node. These carry the orange
 * dot, so wherever you stand the map shows which branch leads to the problem.
 */
function useTearChain(graph: OpeningGraph, out: Map<number, number[]>, tearKey: string | null) {
  return useMemo(() => {
    if (!tearKey) return new Set<number>();
    const target = graph.nodes.findIndex((n) => n.k === tearKey);
    if (target < 0) return new Set<number>();
    // BFS, so a transposition still yields the shortest telling of the line.
    const parent = new Map<number, number>();
    const queue = [graph.root];
    const seen = new Set(queue);
    while (queue.length) {
      const cur = queue.shift()!;
      if (cur === target) break;
      for (const ei of out.get(cur) ?? []) {
        const next = graph.edges[ei].b;
        if (seen.has(next)) continue;
        seen.add(next);
        parent.set(next, ei);
        queue.push(next);
      }
    }
    const chain = new Set<number>();
    let cur = target;
    while (parent.has(cur)) {
      const ei = parent.get(cur)!;
      chain.add(ei);
      cur = graph.edges[ei].a;
    }
    return cur === graph.root ? chain : new Set<number>();
  }, [graph, out, tearKey]);
}

/** Point on the ribbon's centreline, for placing the tear dot along it. */
function onCurve(cy: number, yi: number, t: number) {
  const px = [0, FAN_W * 0.45, FAN_W * 0.6, FAN_W];
  const py = [cy, cy, yi, yi];
  const u = 1 - t;
  const x = u * u * u * px[0] + 3 * u * u * t * px[1] + 3 * u * t * t * px[2] + t * t * t * px[3];
  const y = u * u * u * py[0] + 3 * u * u * t * py[1] + 3 * u * t * t * py[2] + t * t * t * py[3];
  return { x, y };
}

/** A filled ribbon that tapers from `w` at the junction to a fine tip. */
function ribbonPath(cy: number, yi: number, w: number) {
  const h = Math.max(w / 2, 1.6);
  const c1 = FAN_W * 0.45;
  const c2 = FAN_W * 0.6;
  return (
    `M0,${cy - h} C${c1},${cy - h} ${c2},${yi - 1.6} ${FAN_W},${yi - 1.6}` +
    `L${FAN_W},${yi + 1.6} C${c2},${yi + 1.6} ${c1},${cy + h} 0,${cy + h} Z`
  );
}

export function OpeningMap({ graph, tearKey, tearHref }: Props) {
  const out = useAdjacency(graph);
  const chain = useTearChain(graph, out, tearKey);
  /** Edge indices walked so far; the focus is the end of the last one. */
  const [path, setPath] = useState<number[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [hot, setHot] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const focus = path.length ? graph.edges[path[path.length - 1]].b : graph.root;
  const focusNode = graph.nodes[focus];
  const atTear = tearKey != null && focusNode.k === tearKey;

  const fanAll = out.get(focus) ?? [];
  const fan = showAll ? fanAll : fanAll.slice(0, MAX_FAN);
  const folded = fanAll.length - fan.length;

  const height = Math.max(fan.length * ROW, 170);
  const cy = height / 2;
  const maxG = fan.length ? graph.edges[fan[0]].g : 1;

  // A mouse wheel scrolls the walk horizontally — the map is a strip, and
  // vertical wheeling over it should move along the line, not past the card.
  // Attached by hand because React's onWheel is passive and cannot preventDefault.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Each step extends the strip to the right; follow it so the new fan is in
  // view without the user having to chase their own move.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ left: el.scrollWidth, behavior: "smooth" });
  }, [path]);

  const walk = (edgeIndex: number) => {
    setPath((p) => [...p, edgeIndex]);
    setShowAll(false);
    setHot(null);
  };
  const rewind = (steps: number) => {
    setPath((p) => p.slice(0, steps));
    setShowAll(false);
    setHot(null);
  };

  return (
    <div className="omap">
      <div className="omap-head">
        <div>
          <h2 className="font-serif text-2xl text-ink">Your map</h2>
          <p className="mt-1.5 text-sm text-ink-muted">
            Every branch is a line your games actually walk — thicker means more
            often. Click one to follow it.
          </p>
        </div>
        <Link to="/openings" className="quiet-button shrink-0">Open the full map</Link>
      </div>

      <div ref={scroller} className="omap-scroll">
        <div className="omap-strip" style={{ minHeight: height }}>
          {/* The walk so far. The seed is the starting position; each tile is
              a move already taken, and clicking one returns there. */}
          <div className="omap-path">
            <button
              type="button"
              className="omap-seed"
              onClick={() => rewind(0)}
              disabled={path.length === 0}
              aria-label="Back to the starting position"
              title="Start"
            />
            {path.map((ei, i) => {
              const edge = graph.edges[ei];
              const white = graph.nodes[edge.a].p % 2 === 0;
              return (
                <button
                  key={`${ei}-${i}`}
                  type="button"
                  className="omap-tile"
                  onClick={() => rewind(i + 1)}
                  title={`Back to after ${edge.s}`}
                >
                  <Move san={edge.s} white={white} />
                </button>
              );
            })}
          </div>

          {fan.length ? (
            <div className="omap-fan" style={{ width: FAN_W, height }} key={focus}>
              <svg
                className="omap-svg"
                width={FAN_W}
                height={height}
                viewBox={`0 0 ${FAN_W} ${height}`}
                aria-hidden="true"
              >
                {fan.map((ei, i) => {
                  const edge = graph.edges[ei];
                  const yi = i * ROW + ROW / 2;
                  const w = 5 + 19 * Math.sqrt(edge.g / maxG);
                  const torn = chain.has(ei);
                  const dot = torn ? onCurve(cy, yi, 0.56) : null;
                  return (
                    <g key={ei} className="omap-branch" style={{ animationDelay: `${i * 45}ms` }}>
                      <path
                        d={ribbonPath(cy, yi, w)}
                        fill="var(--color-ink)"
                        opacity={hot === null || hot === ei ? 0.92 : 0.35}
                        style={{ transition: "opacity 160ms ease" }}
                      />
                      {dot ? (
                        <>
                          <circle className="omap-halo" cx={dot.x} cy={dot.y} r={11} fill="var(--color-accent)" />
                          <circle cx={dot.x} cy={dot.y} r={4.5} fill="var(--color-accent)" />
                        </>
                      ) : null}
                    </g>
                  );
                })}
              </svg>
            </div>
          ) : null}

          {fan.length ? (
            <div className="omap-chips" style={{ height }} key={`c${focus}`}>
              {fan.map((ei, i) => {
                const edge = graph.edges[ei];
                const target = graph.nodes[edge.b];
                const white = focusNode.p % 2 === 0;
                const name = edge.lb ?? target.nm;
                const torn = chain.has(ei) || (tearKey != null && target.k === tearKey);
                return (
                  <button
                    key={ei}
                    type="button"
                    className={`omap-chip ${torn ? "is-torn" : ""}`}
                    style={{ top: i * ROW + ROW / 2 - 21, animationDelay: `${i * 45}ms` }}
                    onClick={() => walk(ei)}
                    onMouseEnter={() => setHot(ei)}
                    onMouseLeave={() => setHot(null)}
                  >
                    <b className="omap-move">
                      <Move san={edge.s} white={white} />
                    </b>
                    {name ? <small title={name}>{name}</small> : null}
                    <span className="omap-games">{edge.g}</span>
                  </button>
                );
              })}
              {folded > 0 ? (
                <button
                  type="button"
                  className="omap-more"
                  style={{ top: fan.length * ROW + 2 }}
                  onClick={() => setShowAll(true)}
                >
                  {folded} quieter move{folded === 1 ? "" : "s"}
                </button>
              ) : null}
            </div>
          ) : (
            <div className="omap-end">
              Your games end here — {focusNode.g} of them reached this position.
            </div>
          )}
        </div>
      </div>

      {/* The walk arrived at the tear: this is the line to fix, so the one
          strong action on the card appears exactly here and nowhere else. */}
      {atTear && tearHref ? (
        <div className="omap-cta">
          <p className="text-sm text-ink-muted">
            This is the position that keeps costing you.
          </p>
          <Link to={tearHref} className="primary-button">Walk this line</Link>
        </div>
      ) : null}
    </div>
  );
}

import { useEffect, useMemo, useRef } from "react";
import { Link } from "react-router";
import { InfoTip } from "./InfoTip";
import type {
  OpeningTreeEdge,
  OpeningTreeNode,
  PersonalOpeningTree,
} from "../lib/openings";

const COLUMN_STEP = 176;
const NODE_WIDTH = 132;
const NODE_HEIGHT = 54;
const ROW_STEP = 68;
const GRAPH_LEFT = 72;

function hrefForEdge(params: URLSearchParams, family: string, edge: OpeningTreeEdge): string {
  const next = new URLSearchParams(params);
  next.set("family", family);
  next.set("node", edge.toKey);
  next.set("from", edge.fromKey);
  next.set("move", edge.moveUci);
  return `/openings?${next}`;
}

function hrefForRoot(params: URLSearchParams, tree: PersonalOpeningTree): string {
  const next = new URLSearchParams(params);
  next.set("family", tree.family);
  next.set("node", tree.rootKey);
  next.delete("from");
  next.delete("move");
  return `/openings?${next}`;
}

function findPath(tree: PersonalOpeningTree, targetKey: string): OpeningTreeEdge[] {
  if (targetKey === tree.rootKey) return [];
  const outgoing = new Map<string, OpeningTreeEdge[]>();
  for (const edge of tree.edges) {
    const list = outgoing.get(edge.fromKey) ?? [];
    list.push(edge);
    outgoing.set(edge.fromKey, list);
  }
  const queue: Array<{ key: string; path: OpeningTreeEdge[] }> = [
    { key: tree.rootKey, path: [] },
  ];
  const visited = new Set([tree.rootKey]);
  while (queue.length) {
    const current = queue.shift()!;
    for (const edge of outgoing.get(current.key) ?? []) {
      const path = [...current.path, edge];
      if (edge.toKey === targetKey) return path;
      if (!visited.has(edge.toKey)) {
        visited.add(edge.toKey);
        queue.push({ key: edge.toKey, path });
      }
    }
  }
  return [];
}

function turnLabel(node: OpeningTreeNode): string {
  const move = Math.floor(node.ply / 2) + 1;
  return node.ply % 2 === 0 ? `${move} · White` : `${move} · Black`;
}

function actorLabel(actor: OpeningTreeEdge["actor"]): string {
  if (actor === "player") return "Your move";
  if (actor === "opponent") return "Opponent";
  return "Both sides";
}

interface GraphColumn {
  node: OpeningTreeNode;
  branches: OpeningTreeEdge[];
  chosen: OpeningTreeEdge | null;
  x: number;
  points: Array<{ edge: OpeningTreeEdge; y: number }>;
}

function arrangeBranches(
  branches: OpeningTreeEdge[],
  chosen: OpeningTreeEdge | null,
  centerY: number,
): Array<{ edge: OpeningTreeEdge; y: number }> {
  if (!branches.length) return [];
  const primary = branches.find((edge) => edge.id === chosen?.id) ?? branches[0]!;
  const others = branches.filter((edge) => edge.id !== primary.id);
  const points = [{ edge: primary, y: centerY }];
  others.forEach((edge, index) => {
    const distance = Math.floor(index / 2) + 1;
    const direction = index % 2 === 0 ? -1 : 1;
    points.push({ edge, y: centerY + direction * distance * ROW_STEP });
  });
  return points.sort((left, right) => left.y - right.y);
}

function curve(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
): string {
  const middle = sourceX + (targetX - sourceX) * 0.48;
  return `M ${sourceX} ${sourceY} C ${middle} ${sourceY}, ${middle} ${targetY}, ${targetX} ${targetY}`;
}

export function OpeningLineTree({
  tree,
  selectedNodeKey,
  selectedMove,
  params,
}: {
  tree: PersonalOpeningTree;
  selectedNodeKey: string;
  selectedMove: OpeningTreeEdge | null;
  params: URLSearchParams;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const nodeByKey = useMemo(
    () => new Map(tree.nodes.map((node) => [node.key, node])),
    [tree.nodes],
  );
  const outgoing = useMemo(() => {
    const map = new Map<string, OpeningTreeEdge[]>();
    for (const edge of tree.edges) {
      const list = map.get(edge.fromKey) ?? [];
      list.push(edge);
      map.set(edge.fromKey, list);
    }
    for (const edges of map.values()) {
      edges.sort((left, right) =>
        right.games - left.games ||
        right.failures - left.failures ||
        left.moveSan.localeCompare(right.moveSan),
      );
    }
    return map;
  }, [tree.edges]);
  const path = useMemo(
    () => findPath(tree, selectedNodeKey),
    [tree, selectedNodeKey],
  );
  const nodeKeys = [...path.map((edge) => edge.fromKey), selectedNodeKey];
  const rawColumns = nodeKeys.map((key, index) => {
    const node = nodeByKey.get(key)!;
    return {
      node,
      branches: outgoing.get(key) ?? [],
      chosen: path[index] ?? (selectedMove?.fromKey === key ? selectedMove : null),
    };
  });
  const maxBranches = Math.max(1, ...rawColumns.map((column) => column.branches.length));
  const sideRows = Math.ceil((maxBranches - 1) / 2);
  const graphHeight = Math.max(250, sideRows * ROW_STEP * 2 + 126);
  const centerY = Math.round(graphHeight / 2) + 12;
  const columns: GraphColumn[] = rawColumns.map((column, index) => ({
    ...column,
    x: GRAPH_LEFT + index * COLUMN_STEP,
    points: arrangeBranches(column.branches, column.chosen, centerY),
  }));
  const graphWidth = Math.max(540, GRAPH_LEFT + columns.length * COLUMN_STEP + 40);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    element.scrollTo({ left: element.scrollWidth });
  }, [selectedNodeKey, selectedMove?.id]);

  return (
    <section className="opening-tree-panel" aria-labelledby="opening-tree-heading">
      <header className="opening-tree-header">
        <div>
          <p className="eyebrow">Personal opening tree</p>
          <div className="flex items-center gap-2">
            <h3 id="opening-tree-heading">Your {tree.family} lines</h3>
            <InfoTip label="personal opening tree">
              Every branch comes from your imported games. Counts use unique games, identical positions are merged, and red nodes mark your costly engine-checked decisions.
            </InfoTip>
          </div>
          <p>{tree.games} game{tree.games === 1 ? "" : "s"} in this opening · select a node to expand that branch.</p>
        </div>
        <Link to={hrefForRoot(params, tree)} className="tree-root-link">Return to root</Link>
      </header>

      <div className="tree-legend" aria-label="Tree legend">
        <span><i className="tree-key tree-key-player" /> Your move</span>
        <span><i className="tree-key tree-key-opponent" /> Opponent move</span>
        <span><i className="tree-key tree-key-costly" /> Costly decision</span>
        <span><i className="tree-key tree-key-path" /> Active line</span>
      </div>

      <div className="opening-graph-viewport" ref={viewport} tabIndex={0}>
        <div
          className="opening-graph-canvas"
          style={{ width: graphWidth, height: graphHeight }}
        >
          <svg
            className="opening-graph-lines"
            viewBox={`0 0 ${graphWidth} ${graphHeight}`}
            aria-hidden="true"
          >
            <circle className="graph-root-dot" cx="24" cy={centerY} r="5" />
            {columns.flatMap((column, index) => {
              const previous = columns[index - 1];
              const sourceX = previous ? previous.x + NODE_WIDTH : 29;
              return column.points.map(({ edge, y }) => {
                const onPath = column.chosen?.id === edge.id;
                return (
                  <path
                    key={edge.id}
                    className={[
                      "graph-connector",
                      onPath ? "is-on-path" : "",
                      edge.failures > 0 ? "has-failure" : "",
                    ].filter(Boolean).join(" ")}
                    d={curve(sourceX, centerY, column.x, y)}
                  />
                );
              });
            })}
          </svg>

          <span className="graph-root-label" style={{ top: centerY + 12 }}>Root</span>
          {columns.map((column) => (
            <div key={column.node.key}>
              <span className="graph-depth-label" style={{ left: column.x, top: 15 }}>
                {turnLabel(column.node)}
                <small>{column.node.games} reached</small>
              </span>
              {column.points.map(({ edge, y }) => {
                const onPath = column.chosen?.id === edge.id;
                const selected = selectedMove?.id === edge.id;
                const target = nodeByKey.get(edge.toKey);
                const finding = edge.failures > 0
                  ? `${edge.failures} costly`
                  : edge.actor === "opponent"
                    ? "reply"
                    : "handled";
                return (
                  <Link
                    key={edge.id}
                    to={hrefForEdge(params, tree.family, edge)}
                    className={[
                      "graph-move-node",
                      `is-${edge.actor}`,
                      edge.failures > 0 ? "has-failure" : "",
                      onPath ? "is-on-path" : "",
                      selected ? "is-selected" : "",
                    ].filter(Boolean).join(" ")}
                    style={{
                      left: column.x,
                      top: y - NODE_HEIGHT / 2,
                      width: NODE_WIDTH,
                      height: NODE_HEIGHT,
                    }}
                    aria-current={selected ? "step" : undefined}
                    aria-label={`${edge.moveSan}, ${actorLabel(edge.actor)}, ${edge.games} game${edge.games === 1 ? "" : "s"}, ${edge.sharePercent}% from here, ${finding}`}
                  >
                    <span>
                      <strong>{edge.moveSan}</strong>
                      {target?.transposition ? <b title="Also reached by another move order">↗</b> : null}
                    </span>
                    <small>{edge.games}g · {edge.sharePercent}%</small>
                    {edge.failures > 0 ? <i>{edge.failures}</i> : null}
                  </Link>
                );
              })}
              {column.node.terminalGames > 0 ? (
                <span
                  className="graph-terminal-label"
                  style={{ left: column.x, top: graphHeight - 28 }}
                >
                  {column.node.terminalGames} ended here
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </div>
      <p className="tree-instruction">
        Follow the highlighted line. Select any sibling node to expand a different continuation; ↗ marks a transposition.
      </p>
    </section>
  );
}

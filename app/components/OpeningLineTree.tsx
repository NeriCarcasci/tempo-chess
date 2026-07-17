import { useMemo } from "react";
import { Link } from "react-router";
import { InfoTip } from "./InfoTip";
import type {
  OpeningTreeEdge,
  OpeningTreeNode,
  PersonalOpeningTree,
} from "../lib/openings";

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

function actorLabel(actor: OpeningTreeEdge["actor"]): string {
  if (actor === "player") return "You";
  if (actor === "opponent") return "Opponent";
  return "Both sides";
}

function sideToMove(node: OpeningTreeNode): "white" | "black" {
  return node.ply % 2 === 0 ? "white" : "black";
}

function moveLabel(node: OpeningTreeNode): string {
  const move = Math.floor(node.ply / 2) + 1;
  return `Move ${move}`;
}

function moveNotation(node: OpeningTreeNode): string {
  const move = Math.floor(node.ply / 2) + 1;
  return node.ply % 2 === 0 ? `${move}.` : `${move}…`;
}

function centerChosen(
  branches: OpeningTreeEdge[],
  chosen: OpeningTreeEdge | null,
): OpeningTreeEdge[] {
  const active = branches.find((edge) => edge.id === chosen?.id);
  if (!active) return branches;
  const rest = branches.filter((edge) => edge.id !== active.id);
  rest.splice(Math.floor(rest.length / 2), 0, active);
  return rest;
}

interface TreeLevel {
  node: OpeningTreeNode;
  branches: OpeningTreeEdge[];
  chosen: OpeningTreeEdge | null;
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
  const levels: TreeLevel[] = nodeKeys.map((key, index) => {
    const node = nodeByKey.get(key)!;
    const chosen = path[index] ?? (selectedMove?.fromKey === key ? selectedMove : null);
    return {
      node,
      chosen,
      branches: centerChosen(outgoing.get(key) ?? [], chosen),
    };
  });

  return (
    <section className="opening-tree-panel" aria-labelledby="opening-tree-heading">
      <header className="opening-tree-header">
        <div>
          <p className="eyebrow">Personal opening tree</p>
          <div className="flex items-center gap-2">
            <h3 id="opening-tree-heading">Your {tree.family} lines</h3>
            <InfoTip label="personal opening tree">
              Every branch comes from your imported games. Counts use unique games,
              identical positions are merged, and red markers show costly engine-checked decisions.
            </InfoTip>
          </div>
          <p>
            {tree.games} game{tree.games === 1 ? "" : "s"} in this opening · follow
            the line downward and choose any alternative to explore it.
          </p>
        </div>
        <Link to={hrefForRoot(params, tree)} className="tree-root-link">
          Return to root
        </Link>
      </header>

      <div className="tree-legend" aria-label="Tree legend">
        <span><i className="tree-key tree-key-white" /> White move</span>
        <span><i className="tree-key tree-key-black" /> Black move</span>
        <span><i className="tree-key tree-key-costly" /> Costly decision</span>
        <span><i className="tree-key tree-key-path" /> Active line</span>
      </div>

      <div className="opening-tree-flow">
        <div className="tree-origin">
          <span className="tree-origin-mark" aria-hidden="true" />
          <strong>Starting position</strong>
          <small>{tree.games} games</small>
        </div>

        {levels.map((level) => {
          const side = sideToMove(level.node);
          return (
            <section
              className={`opening-tree-level is-${side}`}
              key={level.node.key}
              aria-label={`${moveLabel(level.node)}, ${side} to move`}
            >
              {level.branches.length ? (
                <div
                  className={[
                    "tree-branch-row",
                    level.branches.length === 1 ? "is-single" : "",
                  ].filter(Boolean).join(" ")}
                >
                  {level.branches.map((edge) => {
                    const onPath = level.chosen?.id === edge.id;
                    const selected = selectedMove?.id === edge.id;
                    const target = nodeByKey.get(edge.toKey);
                    const finding = edge.failures > 0
                      ? `${edge.failures} costly decision${edge.failures === 1 ? "" : "s"}`
                      : "no costly decision flagged";
                    return (
                      <div
                        className={`tree-branch ${onPath ? "is-on-path" : ""}`}
                        key={edge.id}
                      >
                        <Link
                          to={hrefForEdge(params, tree.family, edge)}
                          className={[
                            "graph-move-node",
                            `is-${side}`,
                            `is-${edge.actor}`,
                            edge.failures > 0 ? "has-failure" : "",
                            onPath ? "is-on-path" : "",
                            selected ? "is-selected" : "",
                          ].filter(Boolean).join(" ")}
                          aria-current={selected ? "step" : undefined}
                          aria-label={`${edge.moveSan}, ${side} move by ${actorLabel(edge.actor)}, ${edge.games} game${edge.games === 1 ? "" : "s"}, ${edge.sharePercent}% from here, ${finding}`}
                        >
                          <span className="move-node-topline">
                            <span className="move-side">{moveNotation(level.node)}</span>
                            <span className="move-owner">{actorLabel(edge.actor)}</span>
                          </span>
                          <span className="move-node-main">
                            <strong>{edge.moveSan}</strong>
                            {target?.transposition ? (
                              <b title="Also reached by another move order">↗</b>
                            ) : null}
                            {edge.failures > 0 ? (
                              <i aria-label={`${edge.failures} costly`}>
                                {edge.failures} costly
                              </i>
                            ) : null}
                          </span>
                          <small>
                            {edge.games} game{edge.games === 1 ? "" : "s"}
                            <span aria-hidden="true"> · </span>
                            {edge.sharePercent}% from here
                          </small>
                        </Link>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="tree-line-end">No further moves in your imported games</div>
              )}
            </section>
          );
        })}
      </div>

      <p className="tree-instruction">
        The orange route is the line you are viewing. A ↗ marks the same position
        reached through a different move order.
      </p>
    </section>
  );
}

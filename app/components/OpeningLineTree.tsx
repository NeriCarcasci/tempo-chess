import { useMemo } from "react";
import { Link } from "react-router";
import { InfoTip } from "./InfoTip";
import { openingSlug } from "../lib/openingContent";
import type {
  OpeningTreeEdge,
  OpeningTreeNode,
  PersonalOpeningTree,
} from "../lib/openings";

function hrefForEdge(
  params: URLSearchParams,
  family: string,
  edge: OpeningTreeEdge,
): string {
  const next = new URLSearchParams(params);
  const destinationFamily = edge.openingLabel ?? family;
  next.set("family", destinationFamily);
  next.set("node", edge.toKey);
  next.set("from", edge.fromKey);
  next.set("move", edge.moveUci);
  const pathname = edge.openingLabel
    ? `/openings/${openingSlug(edge.openingLabel)}`
    : typeof window === "undefined" ? "/openings" : window.location.pathname;
  return `${pathname}?${next}`;
}

function hrefForRoot(params: URLSearchParams, tree: PersonalOpeningTree): string {
  const next = new URLSearchParams(params);
  next.set("family", tree.family);
  next.set("node", tree.rootKey);
  next.delete("from");
  next.delete("move");
  const pathname = typeof window === "undefined" ? "/openings" : window.location.pathname;
  return `${pathname}?${next}`;
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
  return `Move ${Math.floor(node.ply / 2) + 1}`;
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
  focusFamily,
}: {
  tree: PersonalOpeningTree;
  selectedNodeKey: string;
  selectedMove: OpeningTreeEdge | null;
  params: URLSearchParams;
  focusFamily?: string | null;
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
          <p className="eyebrow">{focusFamily ? "Your games in this opening" : "Your opening map"}</p>
          <div className="flex items-center gap-2">
            <h3 id="opening-tree-heading">{focusFamily ?? "Start from move one"}</h3>
            <InfoTip label="personal opening tree">
              Every branch is built from your imported games. Games that reach the
              same position are merged even if the sites gave them different names.
            </InfoTip>
          </div>
          <p>
            Follow a move to see exactly how the sample narrows from your full
            {` ${tree.games}`}-game repertoire.
          </p>
        </div>
        <Link
          preventScrollReset
          to={hrefForRoot(params, tree)}
          className="tree-root-link"
        >
          Return to move one
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
          <small>{tree.games} imported games</small>
        </div>

        {levels.map((level) => {
          const side = sideToMove(level.node);
          const repertoireShare = tree.games
            ? Math.round((level.node.games / tree.games) * 100)
            : 0;
          return (
            <section
              className={`opening-tree-level is-${side}`}
              key={level.node.key}
              aria-label={`${moveLabel(level.node)}, ${side} to move`}
            >
              <div className="tree-sample-funnel">
                <span>
                  <strong>{level.node.games} of {tree.games}</strong> games reached here
                  {level.node.games === tree.games ? "" : ` · ${repertoireShare}% of repertoire`}
                </span>
                <span className="tree-sample-track" aria-hidden="true">
                  <i style={{ width: `${repertoireShare}%` }} />
                </span>
              </div>

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
                          preventScrollReset
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
                          aria-label={`${edge.moveSan}, ${side} move by ${actorLabel(edge.actor)}, ${edge.games} of ${tree.games} games, ${edge.sharePercent}% of games from this position, ${finding}`}
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
                          {edge.openingLabel ? (
                            <span className="move-opening-label">{edge.openingLabel}</span>
                          ) : null}
                          <small>
                            {edge.games} of {tree.games} games
                            <span aria-hidden="true"> · </span>
                            {edge.sharePercent}% from here
                          </small>
                        </Link>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="tree-line-end">No later move is stored for these games</div>
              )}
            </section>
          );
        })}
      </div>

      <p className="tree-instruction">
        The first count is always against your complete imported repertoire. The
        percentage is local to the position above it. A ↗ means the same position
        was reached through another move order.
      </p>
    </section>
  );
}

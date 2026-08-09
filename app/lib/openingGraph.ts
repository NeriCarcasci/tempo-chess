import type { OpeningGraph, OpeningGraphEdge, OpeningGraphNode } from "./openings";

/**
 * Pre-indexed view of the opening graph. Everything the explorer needs to walk
 * branches in memory: children per node (frequency-sorted) and parent edges for
 * path reconstruction. Built once per graph.
 */
export interface IndexedGraph {
  graph: OpeningGraph;
  root: number;
  childrenByNode: Map<number, OpeningGraphEdge[]>;
  parentEdge: Map<number, OpeningGraphEdge>;
}

export function indexGraph(graph: OpeningGraph): IndexedGraph {
  const childrenByNode = new Map<number, OpeningGraphEdge[]>();
  const parentEdge = new Map<number, OpeningGraphEdge>();
  for (const edge of graph.edges) {
    const list = childrenByNode.get(edge.a) ?? [];
    list.push(edge);
    childrenByNode.set(edge.a, list);
    // First edge into a node wins as its canonical parent (edges are emitted in
    // ply order, so this is the shallowest arrival).
    if (!parentEdge.has(edge.b)) parentEdge.set(edge.b, edge);
  }
  for (const list of childrenByNode.values()) {
    list.sort(
      (left, right) =>
        right.g - left.g ||
        right.fa - left.fa ||
        left.s.localeCompare(right.s),
    );
  }
  return { graph, root: graph.root, childrenByNode, parentEdge };
}

export function nodeAt(graph: OpeningGraph, index: number): OpeningGraphNode {
  return graph.nodes[index]!;
}

export function childrenOf(indexed: IndexedGraph, index: number): OpeningGraphEdge[] {
  return indexed.childrenByNode.get(index) ?? [];
}

/** Canonical position key doubles as a FEN prefix; complete it for rendering. */
export function fenFromNode(node: OpeningGraphNode): string {
  return `${node.k} 0 1`;
}

/**
 * Convert a UCI move to the two 0-63 square indices the board component wants
 * (a1 = 0, h8 = 63). Returns null for malformed input.
 */
export function uciToSquares(uci: string): [number, number] | null {
  if (!uci || uci.length < 4) return null;
  const square = (file: string, rank: string): number | null => {
    const f = file.charCodeAt(0) - 97; // a-h -> 0-7
    const r = Number(rank) - 1; // 1-8 -> 0-7
    if (f < 0 || f > 7 || r < 0 || r > 7) return null;
    return r * 8 + f;
  };
  const from = square(uci[0]!, uci[1]!);
  const to = square(uci[2]!, uci[3]!);
  if (from == null || to == null) return null;
  return [from, to];
}

/** Full-move number and side for the move made *from* a node of the given ply. */
export function moveMeta(fromPly: number): { number: number; isWhite: boolean } {
  return { number: Math.floor(fromPly / 2) + 1, isWhite: fromPly % 2 === 0 };
}

/** e.g. `1.` for a white move, `1…` for a black move. */
export function movePrefix(fromPly: number): string {
  const { number, isWhite } = moveMeta(fromPly);
  return isWhite ? `${number}.` : `${number}…`;
}

/**
 * Breadth-first path of edges from the root to a target node. Empty when the
 * target is the root or unreachable. Handles transpositions (many parents) by
 * returning the shortest arrival.
 */
export function pathToNode(indexed: IndexedGraph, targetIndex: number): OpeningGraphEdge[] {
  if (targetIndex === indexed.root) return [];
  const queue: Array<{ node: number; path: OpeningGraphEdge[] }> = [
    { node: indexed.root, path: [] },
  ];
  const visited = new Set([indexed.root]);
  while (queue.length) {
    const current = queue.shift()!;
    for (const edge of childrenOf(indexed, current.node)) {
      if (edge.b === targetIndex) return [...current.path, edge];
      if (!visited.has(edge.b)) {
        visited.add(edge.b);
        queue.push({ node: edge.b, path: [...current.path, edge] });
      }
    }
  }
  return [];
}

/** Follow a list of UCI moves from the root, stopping at the first that is not a stored branch. */
export function pathFromUci(indexed: IndexedGraph, ucis: string[]): OpeningGraphEdge[] {
  const path: OpeningGraphEdge[] = [];
  let node = indexed.root;
  for (const uci of ucis) {
    const edge = childrenOf(indexed, node).find((candidate) => candidate.u === uci);
    if (!edge) break;
    path.push(edge);
    node = edge.b;
  }
  return path;
}

/**
 * Resolve an opening family to the best node to land on for exploration: the
 * position right after the family is first named (so the branch list shows the
 * real continuations), falling back to the flagged decision, then null.
 */
export function familyEntryIndex(
  indexed: IndexedGraph,
  family: string,
  weakestNodeKey: string | null,
): number | null {
  const { nodes, edges } = indexed.graph;
  let shallowest: OpeningGraphEdge | null = null;
  for (const edge of edges) {
    if (edge.lb !== family) continue;
    const ply = nodes[edge.a]!.p;
    if (
      !shallowest ||
      ply < nodes[shallowest.a]!.p ||
      (ply === nodes[shallowest.a]!.p && edge.g > shallowest.g)
    ) {
      shallowest = edge;
    }
  }
  // Land after the naming move so its continuations are the visible branches.
  if (shallowest) return shallowest.b;
  if (weakestNodeKey) {
    const flagged = nodes.findIndex((node) => node.k === weakestNodeKey);
    if (flagged >= 0) return flagged;
  }
  return null;
}

export function actorLabel(actor: OpeningGraphEdge["ac"]): string {
  if (actor === "p") return "You";
  if (actor === "o") return "Opponent";
  return "Both sides";
}

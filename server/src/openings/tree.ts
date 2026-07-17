export interface TreeObservation {
  gameId: string;
  positionKey: string;
  nextPositionKey: string;
  fen: string;
  nextFen: string;
  ply: number;
  moveUci: string;
  moveSan: string;
  actorIsPlayer: boolean;
  acceptable: boolean | null;
  acceptableReason: string | null;
  evaluationLossCp: number | null;
  playedAt: string | Date | null;
  nodeName: string | null;
  nextNodeName: string | null;
}

export interface PersonalOpeningTreeNode {
  key: string;
  fen: string;
  name: string | null;
  ply: number;
  games: number;
  opportunities: number;
  failures: number;
  terminalGames: number;
  transposition: boolean;
}

export interface PersonalOpeningTreeEdge {
  id: string;
  fromKey: string;
  toKey: string;
  moveUci: string;
  moveSan: string;
  games: number;
  sharePercent: number;
  actor: "player" | "opponent" | "mixed";
  opportunities: number;
  acceptable: number;
  failures: number;
  averageLossCp: number | null;
  lastPlayedAt: string | null;
  savedMove: boolean;
  catalogueMove: boolean;
}

export interface PersonalOpeningTree {
  family: string;
  scope: "family" | "player";
  games: number;
  rootKey: string;
  nodes: PersonalOpeningTreeNode[];
  edges: PersonalOpeningTreeEdge[];
}

interface NodeAccumulator {
  key: string;
  fen: string;
  name: string | null;
  ply: number;
  games: Set<string>;
  opportunities: number;
  failures: number;
  incoming: Set<string>;
}

interface EdgeAccumulator {
  fromKey: string;
  toKey: string;
  moveUci: string;
  moveSan: string;
  games: Set<string>;
  playerGames: Set<string>;
  opponentGames: Set<string>;
  opportunities: number;
  acceptable: number;
  failures: number;
  loss: number;
  lossCount: number;
  lastPlayedAt: Date | null;
  savedMove: boolean;
  catalogueMove: boolean;
}

function latest(left: Date | null, value: string | Date | null): Date | null {
  if (!value) return left;
  const right = new Date(value);
  if (Number.isNaN(right.getTime())) return left;
  return !left || right > left ? right : left;
}

export function buildPersonalOpeningTree(
  family: string,
  rows: TreeObservation[],
  scope: PersonalOpeningTree["scope"] = "family",
): PersonalOpeningTree | null {
  if (!rows.length) return null;
  const nodes = new Map<string, NodeAccumulator>();
  const edges = new Map<string, EdgeAccumulator>();
  const seenDecision = new Set<string>();

  const ensureNode = (
    key: string,
    fen: string,
    name: string | null,
    ply: number,
  ): NodeAccumulator => {
    const existing = nodes.get(key);
    if (existing) return existing;
    const node: NodeAccumulator = {
      key,
      fen,
      name,
      ply,
      games: new Set(),
      opportunities: 0,
      failures: 0,
      incoming: new Set(),
    };
    nodes.set(key, node);
    return node;
  };

  for (const row of [...rows].sort((left, right) => left.ply - right.ply)) {
    // Opening exploration is about the first decision from a position in each
    // game. Repetitions later in the same game would otherwise make outgoing
    // branch counts exceed the unique games that reached their parent.
    const decisionKey = `${row.gameId}|${row.positionKey}`;
    if (seenDecision.has(decisionKey)) continue;
    seenDecision.add(decisionKey);
    const source = ensureNode(
      row.positionKey,
      row.fen,
      row.nodeName,
      Math.max(0, row.ply - 1),
    );
    const target = ensureNode(
      row.nextPositionKey,
      row.nextFen,
      row.nextNodeName,
      row.ply,
    );
    source.games.add(row.gameId);
    target.games.add(row.gameId);
    target.incoming.add(row.positionKey);
    if (row.actorIsPlayer && row.acceptable != null) {
      source.opportunities += 1;
      if (!row.acceptable) source.failures += 1;
    }

    const id = `${row.positionKey}|${row.moveUci}|${row.nextPositionKey}`;
    const edge = edges.get(id) ?? {
      fromKey: row.positionKey,
      toKey: row.nextPositionKey,
      moveUci: row.moveUci,
      moveSan: row.moveSan,
      games: new Set<string>(),
      playerGames: new Set<string>(),
      opponentGames: new Set<string>(),
      opportunities: 0,
      acceptable: 0,
      failures: 0,
      loss: 0,
      lossCount: 0,
      lastPlayedAt: null,
      savedMove: false,
      catalogueMove: false,
    };
    edge.games.add(row.gameId);
    (row.actorIsPlayer ? edge.playerGames : edge.opponentGames).add(row.gameId);
    if (row.actorIsPlayer && row.acceptable != null) {
      edge.opportunities += 1;
      if (row.acceptable) edge.acceptable += 1;
      else edge.failures += 1;
      if (row.evaluationLossCp != null) {
        edge.loss += row.evaluationLossCp;
        edge.lossCount += 1;
      }
    }
    edge.lastPlayedAt = latest(edge.lastPlayedAt, row.playedAt);
    edge.savedMove ||= row.acceptableReason === "saved_repertoire_move";
    edge.catalogueMove ||= row.acceptableReason === "catalogue_move";
    edges.set(id, edge);
  }

  const root = [...nodes.values()]
    .sort((left, right) => left.ply - right.ply || right.games.size - left.games.size)[0]!;
  const treeEdges = [...edges.entries()].map(([id, edge]) => {
    const parentGames = nodes.get(edge.fromKey)?.games.size ?? edge.games.size;
    const actor = edge.playerGames.size && edge.opponentGames.size
      ? "mixed"
      : edge.playerGames.size
        ? "player"
        : "opponent";
    return {
      id,
      fromKey: edge.fromKey,
      toKey: edge.toKey,
      moveUci: edge.moveUci,
      moveSan: edge.moveSan,
      games: edge.games.size,
      sharePercent: parentGames ? Math.round((edge.games.size / parentGames) * 100) : 0,
      actor,
      opportunities: edge.opportunities,
      acceptable: edge.acceptable,
      failures: edge.failures,
      averageLossCp: edge.lossCount ? Math.round(edge.loss / edge.lossCount) : null,
      lastPlayedAt: edge.lastPlayedAt?.toISOString() ?? null,
      savedMove: edge.savedMove,
      catalogueMove: edge.catalogueMove,
    } satisfies PersonalOpeningTreeEdge;
  }).sort((left, right) =>
    nodes.get(left.fromKey)!.ply - nodes.get(right.fromKey)!.ply ||
    right.games - left.games ||
    left.moveSan.localeCompare(right.moveSan),
  );
  const outgoingGames = new Map<string, Set<string>>();
  for (const edge of edges.values()) {
    const games = outgoingGames.get(edge.fromKey) ?? new Set<string>();
    for (const gameId of edge.games) games.add(gameId);
    outgoingGames.set(edge.fromKey, games);
  }

  return {
    family,
    scope,
    games: root.games.size,
    rootKey: root.key,
    nodes: [...nodes.values()].map((node) => ({
      key: node.key,
      fen: node.fen,
      name: node.name,
      ply: node.ply,
      games: node.games.size,
      opportunities: node.opportunities,
      failures: node.failures,
      terminalGames: [...node.games].filter((gameId) =>
        !outgoingGames.get(node.key)?.has(gameId),
      ).length,
      transposition: node.incoming.size > 1,
    })).sort((left, right) => left.ply - right.ply || right.games - left.games),
    edges: treeEdges,
  };
}

export function focusPersonalOpeningTree(
  tree: PersonalOpeningTree,
  targetKey: string,
): PersonalOpeningTree {
  const outgoing = new Map<string, PersonalOpeningTreeEdge[]>();
  for (const edge of tree.edges) {
    const list = outgoing.get(edge.fromKey) ?? [];
    list.push(edge);
    outgoing.set(edge.fromKey, list);
  }

  const queue: Array<{ key: string; path: PersonalOpeningTreeEdge[] }> = [
    { key: tree.rootKey, path: [] },
  ];
  const visited = new Set([tree.rootKey]);
  let path: PersonalOpeningTreeEdge[] = [];
  while (queue.length) {
    const current = queue.shift()!;
    if (current.key === targetKey) {
      path = current.path;
      break;
    }
    for (const edge of outgoing.get(current.key) ?? []) {
      if (visited.has(edge.toKey)) continue;
      visited.add(edge.toKey);
      queue.push({ key: edge.toKey, path: [...current.path, edge] });
    }
  }

  const visibleParents = new Set([
    tree.rootKey,
    ...path.map((edge) => edge.fromKey),
    targetKey,
  ]);
  const edges = tree.edges.filter((edge) => visibleParents.has(edge.fromKey));
  const visibleNodes = new Set([
    tree.rootKey,
    ...edges.flatMap((edge) => [edge.fromKey, edge.toKey]),
  ]);
  return {
    ...tree,
    nodes: tree.nodes.filter((node) => visibleNodes.has(node.key)),
    edges,
  };
}

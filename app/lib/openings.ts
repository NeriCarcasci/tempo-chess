export type FindingStatus =
  | "emerging"
  | "stable"
  | "unstable"
  | "blind_spot"
  | "decaying";

export interface OpeningMetrics {
  mastery: number;
  evidence: number;
  interval: { low: number; high: number };
  effectiveSample: number;
  consistency: number;
  averageLossCp: number | null;
  status: FindingStatus;
}

export interface OpeningFamily {
  family: string;
  games: number;
  opportunities: number;
  acceptable: number;
  failures: number;
  mastery: number;
  evidence: number;
  status: FindingStatus;
  weakestNodeKey: string | null;
  weakestLine: string;
}

export interface OpeningFinding {
  nodeKey: string;
  name: string;
  family: string;
  variation: string | null;
  fen: string;
  lineSan: string;
  lineUci: string;
  opportunities: number;
  games: number;
  acceptable: number;
  failures: number;
  metrics: OpeningMetrics;
  transposition: boolean;
}

export interface OpeningFailure {
  gameId: string;
  platformGameId: string;
  ply: number;
  opponent: string | null;
  playedAt: string | null;
  result: string;
  playerColor: "white" | "black";
  moveUci: string;
  moveSan: string;
  bestMoveUci: string | null;
  evaluationLossCp: number | null;
  reason: string | null;
  url: string | null;
  fen: string;
}

export interface OpeningTreeNode {
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

export interface OpeningTreeEdge {
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
  games: number;
  rootKey: string;
  nodes: OpeningTreeNode[];
  edges: OpeningTreeEdge[];
}

export interface OpeningExplorerData {
  username: string;
  sample: { games: number; observations: number; scoredDecisions: number };
  families: OpeningFamily[];
  selected: OpeningFinding | null;
  selectedMove: OpeningTreeEdge | null;
  tree: PersonalOpeningTree | null;
  failures: OpeningFailure[];
  findings: OpeningFinding[];
}

export interface PlayerCoverage {
  username: string;
  availableGames: number;
  importedGames: number;
  analyzedGames: number;
  activeImport: {
    id: string;
    status: "queued" | "ingesting" | "analyzing" | "completed" | "failed" | "cancelled";
    discoveredGames: number;
    requestedGames: number;
  } | null;
  historyComplete: boolean;
  skippedGames: number;
  importLimit: number;
}

export function reliabilityLabel(games: number): string {
  if (games <= 1) return "Seen in 1 game";
  if (games < 5) return `Seen in ${games} games`;
  return `Repeated across ${games} games`;
}

export function handledPercent(family: OpeningFamily): number {
  return family.opportunities
    ? Math.round((family.acceptable / family.opportunities) * 100)
    : 0;
}

export function rankOpeningFamilies(families: OpeningFamily[]): OpeningFamily[] {
  return [...families].sort((left, right) => {
    const leftRepeated = left.games >= 3 ? 1 : 0;
    const rightRepeated = right.games >= 3 ? 1 : 0;
    const leftRate = left.opportunities ? left.failures / left.opportunities : 0;
    const rightRate = right.opportunities ? right.failures / right.opportunities : 0;
    return (
      rightRepeated - leftRepeated ||
      rightRate * Math.sqrt(right.games) - leftRate * Math.sqrt(left.games) ||
      right.failures - left.failures ||
      right.games - left.games
    );
  });
}

export type ImportStatus =
  | "queued"
  | "ingesting"
  | "analyzing"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type AnalysisPass = "screening" | "deep";

export interface ImportProgress {
  id: string;
  username: string;
  platform: "lichess" | "chesscom";
  status: ImportStatus;
  requestedGames: number;
  discoveredGames: number;
  queuedTasks: number;
  runningTasks: number;
  completedTasks: number;
  failedTasks: number;
  totalPositions: number;
  analyzedPositions: number;
  cacheHits: number;
  deepPositions: number;
  maxPositions: number;
  estimatedCostUsd: number;
  actualCostUsd: number;
  cancelRequested: boolean;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AnalysisTaskRecord {
  id: string;
  importId: string;
  gameId: string;
  pass: AnalysisPass;
  status: TaskStatus;
  priority: number;
  idempotencyKey: string;
  attempts: number;
  maxAttempts: number;
  payload: Record<string, unknown>;
}

export interface AnalysisBudget {
  maxPositions: number;
  maxDeepPositionsPerGame: number;
  estimatedScreeningCostPerPositionUsd: number;
  estimatedDeepCostPerPositionUsd: number;
}

export const DEFAULT_ANALYSIS_BUDGET: Readonly<AnalysisBudget> = Object.freeze({
  maxPositions: 5_000,
  maxDeepPositionsPerGame: 12,
  estimatedScreeningCostPerPositionUsd: 0.0000025,
  estimatedDeepCostPerPositionUsd: 0.000025,
});

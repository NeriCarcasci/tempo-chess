import type { AnalysisProfile } from "../engine/stockfish.js";

export type BenchmarkPhase = "opening" | "middlegame" | "endgame";
export type BenchmarkScenario =
  | "quiet"
  | "tactical"
  | "winning"
  | "losing"
  | "time-pressure";

export interface BenchmarkGame {
  id: string;
  provider: "lichess" | "chesscom";
  timeControl: "bullet" | "blitz" | "rapid" | "classical";
  phase: BenchmarkPhase;
  scenario: BenchmarkScenario;
  /** A complete, legal PGN. Endgame fixtures use SetUp/FEN headers. */
  pgn: string;
  /** Position selected from the PGN for reproducible engine comparison. */
  benchmarkFen: string;
  decisionPly: number;
  remainingClockMs?: number;
}

export interface BenchmarkEvaluation {
  bestMove?: string;
  evalCp?: number;
  mate?: number;
  elapsedMs: number;
  engineTimeMs?: number;
  nodes?: number;
  candidateMoves: string[];
}

export interface BenchmarkSession {
  analyze(fen: string, profile: AnalysisProfile): Promise<BenchmarkEvaluation>;
  close(): Promise<void> | void;
}

export interface BenchmarkAdapter {
  name: string;
  createSession(): Promise<BenchmarkSession>;
}

export interface BenchmarkSample extends BenchmarkEvaluation {
  gameId: string;
  profileId: string;
  temperature: "cold" | "warm";
}

export interface ProfileMetrics {
  profileId: string;
  sampleCount: number;
  runtimeMs: {
    all: { p50: number; p95: number };
    cold: { p50: number; p95: number };
    warm: { p50: number; p95: number };
  };
  costUsdPerPosition: { p50: number; p95: number };
  bestMoveAgreement: number;
  judgmentStability: number;
  referenceMoveInCandidates: number;
}

export interface CostForecast {
  games: 30 | 100 | 500;
  estimatedUsdP50: number;
  estimatedUsdP95: number;
}

export interface BenchmarkReport {
  generatedAt: string;
  adapter: string;
  corpusGames: number;
  profiles: ProfileMetrics[];
  recommended: { screening: string; deep: string };
  assumptions: {
    positionsPerGame: number;
    deepAnalysisRate: number;
    vCpuUsdPerSecond: number;
    gibUsdPerSecond: number;
    workerGiB: number;
  };
  forecasts: CostForecast[];
  regressions: string[];
}

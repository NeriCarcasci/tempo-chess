import { Chess } from "chess.js";
import { Engine } from "../engine/stockfish.js";
import type { AnalysisProfile } from "../engine/stockfish.js";
import type {
  BenchmarkAdapter,
  BenchmarkEvaluation,
  BenchmarkSession,
} from "./types.js";

/** Adapter boundary keeps the benchmark independent from the production worker. */
export class StockfishBenchmarkAdapter implements BenchmarkAdapter {
  readonly name = "stockfish";

  constructor(private readonly enginePath = process.env.STOCKFISH_PATH) {}

  async createSession(): Promise<BenchmarkSession> {
    const engine = new Engine(this.enginePath);
    return {
      analyze: async (fen, profile): Promise<BenchmarkEvaluation> => {
        const result = await engine.analyze(fen, profile);
        return {
          bestMove: result.best,
          evalCp: result.evalCp,
          mate: result.mate,
          elapsedMs: result.elapsedMs,
          engineTimeMs: result.engineTimeMs,
          nodes: result.nodes,
          candidateMoves: result.candidates.map((line) => line.pv[0]).filter(Boolean),
        };
      },
      close: () => engine.quit(),
    };
  }
}

function hash(input: string): number {
  let value = 2166136261;
  for (const char of input) {
    value ^= char.charCodeAt(0);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

function profileNodes(profile: AnalysisProfile): number {
  return profile.limit.type === "nodes" ? profile.limit.value : profile.limit.value * 20_000;
}

/**
 * Deterministic CI adapter. It proves corpus/report plumbing and catches metric
 * regressions without pretending to measure Stockfish strength or hardware.
 */
export class FixtureBenchmarkAdapter implements BenchmarkAdapter {
  readonly name = "deterministic-fixture (not a hardware measurement)";

  async createSession(): Promise<BenchmarkSession> {
    let cold = true;
    return {
      analyze: async (fen, profile) => {
        const chess = new Chess(fen);
        const moves = chess.moves({ verbose: true }).map((move) => move.lan).sort();
        const seed = hash(fen);
        const nodes = profileNodes(profile);
        const isDeep = nodes >= 250_000;
        const referenceIndex = seed % moves.length;
        const selectedIndex = !isDeep && seed % 9 === 0
          ? (referenceIndex + 1) % moves.length
          : referenceIndex;
        const baseEval = (seed % 801) - 400;
        const jitter = isDeep ? 0 : (seed % 81) - 40;
        const elapsedMs = Math.max(1, Math.round(nodes / 125_000 + (cold ? 18 : 0) + (seed % 3)));
        cold = false;
        return {
          bestMove: moves[selectedIndex],
          evalCp: baseEval + jitter,
          elapsedMs,
          engineTimeMs: Math.max(1, Math.round(nodes / 125_000)),
          nodes,
          candidateMoves: Array.from({ length: Math.min(profile.multiPv, moves.length) }, (_, i) =>
            moves[(selectedIndex + i) % moves.length]),
        };
      },
      close: () => undefined,
    };
  }
}

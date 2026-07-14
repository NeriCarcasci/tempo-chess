import type { GameData, Ply, Judgment } from "./game";

const ENGINE_URL =
  (import.meta.env.VITE_ENGINE_URL as string | undefined) || "http://localhost:8090";
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

interface EngineResult {
  fen: string;
  depth: number;
  evalCp?: number;
  mate?: number;
  best?: string;
}

// Mate is treated as a huge centipawn value for loss/swing math only.
const toCp = (r: { evalCp?: number; mate?: number }): number =>
  r.mate !== undefined ? (r.mate > 0 ? 100000 : -100000) : (r.evalCp ?? 0);

function classify(cpLoss: number): Judgment | undefined {
  if (cpLoss >= 300) return "Blunder";
  if (cpLoss >= 150) return "Mistake";
  if (cpLoss >= 90) return "Inaccuracy";
  return undefined;
}

/**
 * Grade an un-analyzed game with our own engine. Evaluates the start position
 * plus the position after every ply, then derives per-move eval, the engine's
 * preferred move, and a blunder/mistake/inaccuracy judgment from centipawn loss.
 */
export async function analyzeGameLocally(game: GameData, depth = 12): Promise<GameData> {
  const positions = [START_FEN, ...game.plies.map((p) => p.fenAfter)];
  const res = await fetch(`${ENGINE_URL}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fens: positions, depth }),
  });
  if (!res.ok) throw new Error(`Engine returned ${res.status}`);
  const { results } = (await res.json()) as { results: EngineResult[] };
  const cp = results.map(toCp); // White's perspective per position

  const plies: Ply[] = game.plies.map((p, k) => {
    const i = k + 1; // index of the position after this ply
    const after = results[i];
    const before = results[i - 1];
    const cpLoss = p.color === "white" ? cp[i - 1] - cp[i] : cp[i] - cp[i - 1];
    const j = classify(cpLoss);
    return {
      ...p,
      evalCp: after.mate === undefined ? after.evalCp : undefined,
      mate: after.mate,
      best: before.best, // best move available at the position before this ply
      judgment: j ? { name: j, comment: "" } : undefined,
    };
  });

  return { ...game, plies, hasAnalysis: true };
}

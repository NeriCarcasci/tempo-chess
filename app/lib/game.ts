import { Chess } from "chess.js";

export type Judgment = "Inaccuracy" | "Mistake" | "Blunder";

export interface Ply {
  ply: number; // 1-based half-move
  moveNumber: number; // full-move number
  color: "white" | "black";
  san: string;
  uci: string;
  fenBefore: string;
  fenAfter: string;
  // From Lichess server analysis when the game was analyzed:
  evalCp?: number; // centipawns after this move, White's perspective
  mate?: number; // mate-in-N (signed) after this move
  best?: string; // engine's best move (UCI) instead of the one played
  judgment?: { name: Judgment; comment: string };
}

export interface GameData {
  id: string;
  white: { name: string; rating?: number };
  black: { name: string; rating?: number };
  result: string; // "1-0" | "0-1" | "½-½"
  winner?: "white" | "black";
  status?: string;
  opening?: string;
  eco?: string;
  speed?: string;
  plies: Ply[];
  hasAnalysis: boolean;
  url: string;
}

const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export function fenAt(game: GameData, index: number): string {
  if (index <= 0) return START_FEN;
  return game.plies[Math.min(index, game.plies.length) - 1].fenAfter;
}

export async function fetchGame(id: string): Promise<GameData> {
  const res = await fetch(
    `https://lichess.org/game/export/${encodeURIComponent(id)}?opening=true&evals=true&clocks=false`,
    { headers: { Accept: "application/json" } },
  );
  if (!res.ok) throw new Error(`Lichess game "${id}" (${res.status})`);
  const g = await res.json();

  const sans: string[] = (g.moves ?? "").trim()
    ? g.moves.trim().split(/\s+/)
    : [];
  const analysis: any[] = Array.isArray(g.analysis) ? g.analysis : [];
  const chess = new Chess();
  const plies: Ply[] = [];

  for (let i = 0; i < sans.length; i++) {
    const fenBefore = chess.fen();
    let mv;
    try {
      mv = chess.move(sans[i]);
    } catch {
      break;
    }
    if (!mv) break;
    const a = analysis[i];
    plies.push({
      ply: i + 1,
      moveNumber: Math.floor(i / 2) + 1,
      color: i % 2 === 0 ? "white" : "black",
      san: mv.san,
      uci: mv.from + mv.to + (mv.promotion ?? ""),
      fenBefore,
      fenAfter: chess.fen(),
      evalCp: a && typeof a.eval === "number" ? a.eval : undefined,
      mate: a && typeof a.mate === "number" ? a.mate : undefined,
      best: a?.best,
      judgment: a?.judgment
        ? { name: a.judgment.name as Judgment, comment: a.judgment.comment }
        : undefined,
    });
  }

  return {
    id: g.id,
    white: { name: g.players.white.user?.name ?? "White", rating: g.players.white.rating },
    black: { name: g.players.black.user?.name ?? "Black", rating: g.players.black.rating },
    result: g.winner ? (g.winner === "white" ? "1-0" : "0-1") : "½-½",
    winner: g.winner,
    status: g.status,
    opening: g.opening?.name,
    eco: g.opening?.eco,
    speed: g.speed,
    plies,
    hasAnalysis: analysis.length > 0,
    url: `https://lichess.org/${g.id}`,
  };
}

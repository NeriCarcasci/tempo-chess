import { Chess } from "chess.js";
import type {
  BenchmarkGame,
  BenchmarkPhase,
  BenchmarkScenario,
} from "./types.js";

interface Archetype {
  name: string;
  phase: BenchmarkPhase;
  scenario: BenchmarkScenario;
  fen?: string;
  prefix?: string[];
}

const ARCHETYPES: Archetype[] = [
  { name: "open-king-pawn", phase: "opening", scenario: "quiet", prefix: ["e2e4", "e7e5", "g1f3", "b8c6"] },
  { name: "sicilian", phase: "opening", scenario: "tactical", prefix: ["e2e4", "c7c5", "g1f3", "d7d6", "d2d4", "c5d4"] },
  { name: "queens-gambit", phase: "opening", scenario: "quiet", prefix: ["d2d4", "d7d5", "c2c4", "e7e6"] },
  { name: "scotch", phase: "opening", scenario: "time-pressure", prefix: ["e2e4", "e7e5", "g1f3", "b8c6", "d2d4", "e5d4"] },
  { name: "closed-centre", phase: "middlegame", scenario: "quiet", prefix: ["d2d4", "g8f6", "c2c4", "e7e6", "b1c3", "f8b4", "e2e3", "e8g8", "f1d3", "d7d5"] },
  { name: "open-centre", phase: "middlegame", scenario: "tactical", prefix: ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6", "d2d4", "e5d4", "e1g1", "f8c5"] },
  { name: "white-pressure", phase: "middlegame", scenario: "winning", fen: "r3r1k1/ppp2ppp/2n2n2/3qp3/3P4/2P2N2/PP1N1PPP/R2QR1K1 w - - 0 16" },
  { name: "black-pressure", phase: "middlegame", scenario: "losing", fen: "2r2rk1/pp3ppp/2n1b3/3pP3/3P4/2P1BN2/PP3PPP/R2R2K1 b - - 0 19" },
  { name: "pawn-race", phase: "endgame", scenario: "tactical", fen: "8/5pk1/6p1/3P4/4P3/5K2/8/8 w - - 0 42" },
  { name: "king-pawn", phase: "endgame", scenario: "winning", fen: "8/8/8/3k4/8/3K4/4P3/8 w - - 0 45" },
  { name: "rook-defence", phase: "endgame", scenario: "losing", fen: "8/6k1/5pp1/8/4P3/5P2/6PP/4R1K1 b - - 0 38" },
  { name: "minor-piece", phase: "endgame", scenario: "time-pressure", fen: "8/5pk1/6p1/3n4/3P4/4B1P1/5PK1/8 w - - 0 51" },
];

function hash(input: string): number {
  let value = 2166136261;
  for (const char of input) {
    value ^= char.charCodeAt(0);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

/** Select legal continuations deterministically while retaining tactical variety. */
function extendGame(chess: Chess, seed: string, plies: number): void {
  for (let ply = 0; ply < plies && !chess.isGameOver(); ply++) {
    const moves = chess.moves({ verbose: true });
    const ordered = [...moves].sort((a, b) => {
      const tacticalA = Number(Boolean(a.captured)) * 2 + Number(a.san.includes("+"));
      const tacticalB = Number(Boolean(b.captured)) * 2 + Number(b.san.includes("+"));
      return tacticalB - tacticalA || a.lan.localeCompare(b.lan);
    });
    chess.move(ordered[hash(`${seed}:${ply}`) % ordered.length]);
  }
}

function buildGame(archetype: Archetype, ordinal: number): BenchmarkGame {
  const id = `bench-${archetype.name}-${String(ordinal + 1).padStart(2, "0")}`;
  const chess = archetype.fen ? new Chess(archetype.fen) : new Chess();
  for (const move of archetype.prefix ?? []) chess.move(move);

  const leadIn = archetype.phase === "opening" ? 2 + (ordinal % 4) : 4 + (ordinal % 5);
  extendGame(chess, `${id}:lead`, leadIn);
  const benchmarkFen = chess.fen();
  const decisionPly = chess.history().length;
  extendGame(chess, `${id}:tail`, 8 + (ordinal % 7));

  chess.header(
    "Event", "Tempo credential-free benchmark",
    "Site", ordinal % 2 === 0 ? "https://lichess.org" : "https://chess.com",
    "Date", `2026.01.${String((ordinal % 28) + 1).padStart(2, "0")}`,
    "Round", "-",
    "White", `FixtureWhite${ordinal}`,
    "Black", `FixtureBlack${ordinal}`,
    "Result", "*",
  );

  const timeControls = ["bullet", "blitz", "rapid", "classical"] as const;
  const timeControl = timeControls[(ordinal + ARCHETYPES.indexOf(archetype)) % timeControls.length];
  return {
    id,
    provider: ordinal % 2 === 0 ? "lichess" : "chesscom",
    timeControl,
    phase: archetype.phase,
    scenario: archetype.scenario,
    pgn: chess.pgn(),
    benchmarkFen,
    decisionPly,
    remainingClockMs: archetype.scenario === "time-pressure" ? 3_000 + ordinal * 250 : undefined,
  };
}

/** 12 archetypes x 10 variations = 120 deterministic, legal game records. */
export function buildBenchmarkCorpus(): BenchmarkGame[] {
  return ARCHETYPES.flatMap((archetype) =>
    Array.from({ length: 10 }, (_, ordinal) => buildGame(archetype, ordinal)),
  );
}

/** Throws if a checked-in or generated fixture can no longer be replayed. */
export function validateBenchmarkCorpus(corpus: BenchmarkGame[]): void {
  const ids = new Set<string>();
  for (const game of corpus) {
    if (ids.has(game.id)) throw new Error(`Duplicate benchmark game id: ${game.id}`);
    ids.add(game.id);
    const replay = new Chess();
    replay.loadPgn(game.pgn);
    if (replay.history().length === 0) throw new Error(`Fixture has no moves: ${game.id}`);
    new Chess(game.benchmarkFen);
  }
}

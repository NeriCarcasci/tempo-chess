/** TEMPORARY dev preview — delete after checking the dense dashboard layout. */
import { Dashboard } from "../components/Dashboard";
import { aggregate } from "../lib/lichess";
import type { GameLite, Profile } from "../lib/lichess";
import type {
  OpeningExplorerData,
  OpeningFinding,
  OpeningFamily,
  OpeningGraph,
} from "../lib/openings";

const OPENINGS = [
  "Sicilian Defense: Najdorf Variation",
  "Sicilian Defense: Dragon Variation",
  "French Defense: Winawer Variation",
  "Caro-Kann Defense: Advance Variation",
  "Queen's Gambit Declined: Orthodox Defense",
  "Ruy Lopez: Berlin Defense",
  "Italian Game: Giuoco Pianissimo",
  "London System",
  "Van 't Kruijs Opening",
  "Bongcloud Attack",
];

const MOVES =
  "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be3 e5 Nb3 Be6 f3 Be7 Qd2 O-O O-O-O Nbd7 g4 b5 g5 b4 Ne2 Ne8 f4 a5 f5 a4";

const games: GameLite[] = [];
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
for (let d = 0; d < 150; d++) {
  if (rnd() > 0.62) continue;
  const n = 1 + Math.floor(rnd() * 6);
  const bias = Math.sin(d / 11) * 0.22;
  for (let k = 0; k < n; k++) {
    const r = rnd() + bias;
    games.push({
      id: `g${d}-${k}`,
      opponent: `player${d}${k}`,
      opponentRating: 1500 + Math.floor(rnd() * 400),
      color: k % 2 ? "white" : "black",
      result: r < 0.46 ? "win" : r < 0.9 ? "loss" : "draw",
      createdAt: Date.now() - (150 - d) * 86_400_000 - k * 600_000,
      speed: "blitz",
      rated: true,
      opening: OPENINGS[(d + k) % OPENINGS.length],
      eco: ["B90", "C11", "B12", "D35"][(d + k) % 4],
      ratingDiff: Math.floor(rnd() * 10) - 5,
      accuracy: 55 + Math.floor(rnd() * 35),
      moves: k === 0 ? MOVES : undefined,
      url: "#",
    } as GameLite);
  }
}
games.sort((a, b) => b.createdAt - a.createdAt);

const wins = games.filter((g) => g.result === "win").length;
const losses = games.filter((g) => g.result === "loss").length;

const profile = {
  id: "ncarcasc",
  username: "ncarcasc",
  createdAt: Date.UTC(2019, 3, 1),
  playTime: { total: 1_100_000 },
  count: {
    all: games.length,
    rated: games.length,
    win: wins,
    loss: losses,
    draw: games.length - wins - losses,
  },
  profile: { country: "IE" },
  perfs: {
    blitz: { rating: 1743, prog: 12, games: 900, prov: false },
    rapid: { rating: 1690, prog: -8, games: 300, prov: false },
    bullet: { rating: 1602, prog: 4, games: 210, prov: false },
  },
} as unknown as Profile;

// -- a small but real graph: root → 3 first moves → replies → a tear --------

// Node helper: k, ply, games, scored, failures
const N = (k: string, p: number, g: number, f = 0, nm?: string) =>
  ({ k, p, g, o: g, f, t: 0, x: 0 as const, nm });

const nodes = [
  N("root", 0, 120), // 0
  N("e4", 1, 78, 0, "King's Pawn Game"), // 1
  N("d4", 1, 30, 0, "Queen's Pawn Game"), // 2
  N("c4", 1, 12, 0, "English Opening"), // 3
  N("e4c5", 2, 46, 0, "Sicilian Defense"), // 4
  N("e4e5", 2, 22, 0, "King's Pawn Game"), // 5
  N("e4c6", 2, 10, 0, "Caro-Kann Defense"), // 6
  N("e4c5Nf3", 3, 40, 2), // 7
  N("e4c5c3", 3, 6, 0, "Sicilian Defense: Alapin"), // 8
  N("e4c5Nf3d6", 4, 26, 3, "Sicilian Defense"), // 9
  N("e4c5Nf3Nc6", 4, 14, 0, "Sicilian Defense: Old Sicilian"), // 10
  N("najdorf", 5, 19, 7, "Sicilian Defense: Najdorf"), // 11 ← the tear
  N("d4d5", 2, 18, 0, "Queen's Pawn Game"), // 12
  N("d4Nf6", 2, 12, 0, "Indian Defense"), // 13
];

// Edge helper
const E = (a: number, b: number, u: string, s: string, g: number, fa = 0, lb?: string) =>
  ({ a, b, u, s, g, sh: 0, ac: "m" as const, op: g, fa, lb });

const edges = [
  E(0, 1, "e2e4", "e4", 78),
  E(0, 2, "d2d4", "d4", 30),
  E(0, 3, "c2c4", "c4", 12),
  E(1, 4, "c7c5", "c5", 46, 0, "Sicilian Defense"),
  E(1, 5, "e7e5", "e5", 22),
  E(1, 6, "c7c6", "c6", 10, 0, "Caro-Kann Defense"),
  E(4, 7, "g1f3", "Nf3", 40, 2),
  E(4, 8, "c2c3", "c3", 6, 0, "Alapin Variation"),
  E(7, 9, "d7d6", "d6", 26, 3),
  E(7, 10, "b8c6", "Nc6", 14),
  E(9, 11, "d2d4", "d4", 19, 7, "Najdorf structures"),
  E(2, 12, "d7d5", "d5", 18),
  E(2, 13, "g8f6", "Nf6", 12, 0, "Indian Defense"),
];

const graph = { games: 120, root: 0, nodes, edges } as unknown as OpeningGraph;

const FAMS: Array<[string, number, number, number]> = [
  ["Sicilian Defense", 34, 121, 19],
  ["French Defense", 22, 74, 6],
  ["Caro-Kann Defense", 18, 60, 5],
  ["Queen's Gambit Declined", 15, 48, 4],
  ["Ruy Lopez", 12, 40, 3],
  ["Nimzo-Indian Defense", 2, 6, 1],
  ["Dutch Defense", 1, 3, 1],
];

const families: OpeningFamily[] = FAMS.map(([name, g, opp, fail]) => ({
  family: name,
  games: g,
  opportunities: opp,
  acceptable: opp - fail,
  failures: fail,
  mastery: Math.round(((opp - fail) / opp) * 100),
  evidence: g,
  status: fail / opp > 0.15 ? "blind_spot" : "reliable",
  weakestNodeKey: null,
  weakestLine: "",
})) as OpeningFamily[];

const selected = {
  nodeKey: "najdorf",
  name: "Sicilian Defense: Najdorf Variation",
  family: "Sicilian Defense",
  variation: "Najdorf Variation",
  fen: "rnbqkb1r/1p2pppp/p2p1n2/8/3NP3/2N1B3/PPP2PPP/R2QKB1R b KQkq - 1 6",
  lineSan: "e4 c5 Nf3 d6 d4",
  lineUci: "",
  opportunities: 121,
  games: 34,
  acceptable: 102,
  failures: 19,
  metrics: {
    mastery: 62,
    evidence: 34,
    interval: { low: 0.5, high: 0.72 },
    effectiveSample: 30,
    consistency: 0.7,
    averageLossCp: 74,
    status: "blind_spot",
  },
  transposition: false,
} as unknown as OpeningFinding;

const opening = {
  username: "ncarcasc",
  sample: { games: games.length, observations: 900, scoredDecisions: 352 },
  families,
  selected,
  selectedMove: null,
  tree: null,
  graph,
  failures: [
    { gameId: "g1-0", platformGameId: "x", ply: 12, moveSan: "e5", opponent: "player110" },
  ],
  findings: [selected],
} as unknown as OpeningExplorerData;

export default function PreviewDense() {
  const summary = aggregate(profile, games);
  return <Dashboard summary={summary} opening={opening} coverage={null} platform="lichess" />;
}

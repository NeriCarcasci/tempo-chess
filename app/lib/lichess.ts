// Client-side Lichess access for the dashboard demo. In production this routes
// through the Cloud Run API (which persists to Postgres/GCS); Lichess allows
// CORS, so for a live demo the SPA can read the public endpoints directly.

import { Chess } from "chess.js";

export type Speed = "bullet" | "blitz" | "rapid" | "classical";
export type Result = "win" | "loss" | "draw";

export interface Perf {
  games: number;
  rating: number;
  rd: number;
  prog: number;
  prov?: boolean;
}

export interface Profile {
  id: string;
  username: string;
  perfs: Record<string, Perf>;
  createdAt: number;
  seenAt?: number;
  playTime?: { total: number };
  profile?: { flag?: string; location?: string; bio?: string };
  count: { all: number; rated: number; win: number; loss: number; draw: number };
}

export interface GameLite {
  id: string;
  createdAt: number;
  speed: string;
  rated: boolean;
  color: "white" | "black";
  result: Result;
  userRating: number;
  ratingDiff?: number;
  opponent: string;
  opponentRating?: number;
  eco?: string;
  opening?: string;
  status: string;
  moves?: string;
  accuracy?: number;
  acpl?: number;
  inaccuracy?: number;
  mistake?: number;
  blunder?: number;
}

const API = "https://lichess.org";

export async function fetchProfile(username: string): Promise<Profile> {
  const res = await fetch(`${API}/api/user/${encodeURIComponent(username)}`);
  if (!res.ok) throw new Error(`Lichess user "${username}" (${res.status})`);
  return res.json();
}

export async function fetchGames(username: string, max = 100): Promise<GameLite[]> {
  const params = new URLSearchParams({
    max: String(max),
    opening: "true",
    accuracy: "true",
    moves: "true",
    sort: "dateDesc",
  });
  const res = await fetch(
    `${API}/api/games/user/${encodeURIComponent(username)}?${params}`,
    { headers: { Accept: "application/x-ndjson" } },
  );
  if (!res.ok) throw new Error(`Lichess games "${username}" (${res.status})`);
  const uname = username.toLowerCase();
  const text = await res.text();
  const out: GameLite[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const g = JSON.parse(line);
    const color: "white" | "black" =
      g.players.white.user?.name?.toLowerCase() === uname ? "white" : "black";
    const me = g.players[color];
    const opp = g.players[color === "white" ? "black" : "white"];
    const result: Result = !g.winner
      ? "draw"
      : g.winner === color
        ? "win"
        : "loss";
    const an = me.analysis;
    out.push({
      id: g.id,
      createdAt: g.createdAt,
      speed: g.speed,
      rated: g.rated,
      color,
      result,
      userRating: me.rating,
      ratingDiff: me.ratingDiff,
      opponent:
        opp.user?.name ??
        (opp.aiLevel ? `Stockfish level ${opp.aiLevel}` : "Anonymous"),
      opponentRating: opp.rating,
      eco: g.opening?.eco,
      opening: g.opening?.name,
      status: g.status,
      moves: g.moves,
      accuracy: an?.accuracy,
      acpl: an?.acpl,
      inaccuracy: an?.inaccuracy,
      mistake: an?.mistake,
      blunder: an?.blunder,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface FormatStat {
  key: Speed;
  label: string;
  rating: number;
  games: number;
  prog: number;
  prov?: boolean;
}

export interface OpeningStat {
  eco?: string;
  name: string;
  games: number;
  win: number;
  loss: number;
  draw: number;
  winRate: number;
}

export interface ColorStat {
  games: number;
  win: number;
  draw: number;
  loss: number;
  winRate: number;
}

export interface Summary {
  username: string;
  flag?: string;
  location?: string;
  memberSince: number;
  playTimeSec: number;
  record: { win: number; loss: number; draw: number; all: number; rated: number };
  winRate: number;
  formats: FormatStat[];
  bestFormat?: FormatStat;
  analyzed: {
    count: number;
    total: number;
    avgAccuracy?: number;
    avgAcpl?: number;
    blunders: number;
    mistakes: number;
    inaccuracies: number;
    blundersPerGame: number;
  };
  trend: { label: string; ratings: number[] };
  openings: OpeningStat[];
  toughOpenings: OpeningStat[];
  byColor: { white: ColorStat; black: ColorStat };
  recent: GameLite[];
  board: RecentPosition | null;
}

export interface RecentPosition {
  fen: string;
  ply: number;
  moveNumber: number;
  opponent: string;
  color: "white" | "black";
  result: Result;
  opening?: string;
  url?: string;
}

const SPEED_LABELS: Record<Speed, string> = {
  bullet: "Bullet",
  blitz: "Blitz",
  rapid: "Rapid",
  classical: "Classical",
};

function colorStat(games: GameLite[]): ColorStat {
  const s = { games: games.length, win: 0, draw: 0, loss: 0, winRate: 0 };
  for (const g of games) s[g.result]++;
  s.winRate = s.games ? s.win / s.games : 0;
  return s;
}

// A representative middlegame snapshot from the most recent game with moves —
// the page's chess-identity anchor (later: the actual position you blundered in).
function recentPosition(games: GameLite[]): RecentPosition | null {
  const g = games.find((x) => x.moves && x.moves.trim().length > 0);
  if (!g || !g.moves) return null;
  const sans = g.moves.trim().split(/\s+/);
  const target = Math.min(sans.length, Math.max(16, Math.floor(sans.length * 0.6)));
  const chess = new Chess();
  let played = 0;
  for (let i = 0; i < target; i++) {
    try {
      chess.move(sans[i]);
      played++;
    } catch {
      break;
    }
  }
  return {
    fen: chess.fen(),
    ply: played,
    moveNumber: Math.max(1, Math.ceil(played / 2)),
    opponent: g.opponent,
    color: g.color,
    result: g.result,
    opening: g.opening,
    url: g.url,
  };
}

export function aggregate(profile: Profile, games: GameLite[]): Summary {
  const formats: FormatStat[] = (Object.keys(SPEED_LABELS) as Speed[])
    .map((key) => {
      const p = profile.perfs[key];
      return p
        ? {
            key,
            label: SPEED_LABELS[key],
            rating: p.rating,
            games: p.games,
            prog: p.prog,
            prov: p.prov,
          }
        : null;
    })
    .filter((f): f is FormatStat => f !== null && f.games > 0);

  // Prefer an established (non-provisional) rating as "strongest"; a provisional
  // bullet number over 5 games shouldn't outrank an established classical one.
  const established = formats.filter((f) => !f.prov);
  const bestFormat = (established.length ? established : formats)
    .slice()
    .sort((a, b) => b.rating - a.rating)[0];

  // Analyzed subset (games that carry Lichess server analysis).
  const analyzedGames = games.filter((g) => g.blunder !== undefined);
  const withAcc = analyzedGames.filter((g) => g.accuracy !== undefined);
  const sum = (arr: GameLite[], k: keyof GameLite) =>
    arr.reduce((a, g) => a + ((g[k] as number) ?? 0), 0);
  const analyzed = {
    count: analyzedGames.length,
    total: games.length,
    avgAccuracy: withAcc.length
      ? withAcc.reduce((a, g) => a + (g.accuracy ?? 0), 0) / withAcc.length
      : undefined,
    avgAcpl: analyzedGames.length
      ? Math.round(sum(analyzedGames, "acpl") / analyzedGames.length)
      : undefined,
    blunders: sum(analyzedGames, "blunder"),
    mistakes: sum(analyzedGames, "mistake"),
    inaccuracies: sum(analyzedGames, "inaccuracy"),
    blundersPerGame: analyzedGames.length
      ? sum(analyzedGames, "blunder") / analyzedGames.length
      : 0,
  };

  // Rating trend: the most-played speed present in the fetched games.
  const speedCounts = new Map<string, number>();
  for (const g of games) speedCounts.set(g.speed, (speedCounts.get(g.speed) ?? 0) + 1);
  const trendSpeed =
    [...speedCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "rapid";
  const trendRatings = games
    .filter((g) => g.speed === trendSpeed)
    .slice()
    .reverse()
    .map((g) => g.userRating);

  // Openings across the fetched sample.
  const byOpening = new Map<string, OpeningStat>();
  for (const g of games) {
    const name = g.opening ?? "Unknown opening";
    const o =
      byOpening.get(name) ??
      { eco: g.eco, name, games: 0, win: 0, loss: 0, draw: 0, winRate: 0 };
    o.games++;
    o[g.result]++;
    byOpening.set(name, o);
  }
  const allOpenings = [...byOpening.values()].map((o) => ({
    ...o,
    winRate: o.games ? o.win / o.games : 0,
  }));
  const openings = [...allOpenings]
    .sort((a, b) => b.games - a.games)
    .slice(0, 6);
  const toughOpenings = [...allOpenings]
    .filter((o) => o.games >= 3)
    .sort((a, b) => a.winRate - b.winRate)
    .slice(0, 4);

  return {
    username: profile.username,
    flag: profile.profile?.flag,
    location: profile.profile?.location,
    memberSince: profile.createdAt,
    playTimeSec: profile.playTime?.total ?? 0,
    record: {
      win: profile.count.win,
      loss: profile.count.loss,
      draw: profile.count.draw,
      all: profile.count.all,
      rated: profile.count.rated,
    },
    winRate: profile.count.all ? profile.count.win / profile.count.all : 0,
    formats,
    bestFormat,
    analyzed,
    trend: { label: SPEED_LABELS[trendSpeed as Speed] ?? trendSpeed, ratings: trendRatings },
    openings,
    toughOpenings,
    byColor: {
      white: colorStat(games.filter((g) => g.color === "white")),
      black: colorStat(games.filter((g) => g.color === "black")),
    },
    recent: games.slice(0, 12),
    board: recentPosition(games),
  };
}

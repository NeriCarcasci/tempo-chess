// Client-side Lichess access for the dashboard demo. In production this routes
// through the Cloud Run API (which persists to Postgres/GCS); Lichess allows
// CORS, so for a live demo the SPA can read the public endpoints directly.

import { Chess } from "chess.js";
import { wilson, shrink, confidence } from "./stats.js";
import { OTHER_FAMILY, openingFamilyOrOther } from "./openingFamily";

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
  url?: string;
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

export async function fetchProfile(username: string, signal?: AbortSignal): Promise<Profile> {
  const res = await fetch(`${API}/api/user/${encodeURIComponent(username)}`, { signal });
  if (!res.ok) throw new Error(`Lichess user "${username}" (${res.status})`);
  return res.json();
}

export async function fetchGames(username: string, max = 100, signal?: AbortSignal): Promise<GameLite[]> {
  const params = new URLSearchParams({
    max: String(max),
    opening: "true",
    accuracy: "true",
    moves: "true",
    sort: "dateDesc",
  });
  const res = await fetch(
    `${API}/api/games/user/${encodeURIComponent(username)}?${params}`,
    { headers: { Accept: "application/x-ndjson" }, signal },
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
      url: `${API}/${g.id}`,
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
  /** Empirical-Bayes estimate: raw rate shrunk toward the player's baseline. */
  adjWinRate: number;
  /** Wilson 95% interval on the raw win rate. */
  ciLo: number;
  ciHi: number;
  conf: "low" | "medium" | "high";
  /**
   * The individual openings inside this row, when it is the "Other" bucket.
   * Empty for a real family — there is nothing to unfold.
   */
  members?: Array<{ name: string; games: number }>;
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
  winRateCI: { lo: number; hi: number };
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
  days: PlayDay[];
}

/** One calendar day of play, for the activity grid. */
export interface PlayDay {
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string;
  games: number;
  win: number;
  draw: number;
  loss: number;
}

export interface RecentPosition {
  /** The game it came from, so the panel can link into the review. */
  id: string;
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
    id: g.id,
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

/**
 * Games folded onto the calendar they were played on.
 *
 * The day key is built from the local date parts rather than by slicing an ISO
 * string: `toISOString()` is UTC, so anything played after 7pm in Dublin — or
 * before 7am in Los Angeles — lands on the neighbouring day and the grid
 * disagrees with the clock the player was actually looking at.
 */
function playDays(games: GameLite[]): PlayDay[] {
  const byDay = new Map<string, PlayDay>();
  for (const g of games) {
    const d = new Date(g.createdAt);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")}`;
    const day = byDay.get(date) ?? { date, games: 0, win: 0, draw: 0, loss: 0 };
    day.games++;
    day[g.result]++;
    byDay.set(date, day);
  }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function aggregate(profile: Profile, games: GameLite[]): Summary {
  const formats: FormatStat[] = (Object.keys(SPEED_LABELS) as Speed[])
    .map<FormatStat | null>((key) => {
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
  type OpeningAcc = {
    eco?: string;
    name: string;
    games: number;
    win: number;
    loss: number;
    draw: number;
  };
  // Keyed by family, not by the full opening name. Grouping by name gave a row
  // per variation, so two Caro-Kanns and a Van 't Kruijs read as three
  // unrelated openings — which is not how anyone thinks about their results.
  const byOpening = new Map<string, OpeningAcc>();
  const members = new Map<string, Map<string, number>>();
  for (const g of games) {
    const name = g.opening ?? "Unknown opening";
    const key = openingFamilyOrOther(g.opening);
    const o =
      byOpening.get(key) ??
      { eco: g.eco, name: key, games: 0, win: 0, loss: 0, draw: 0 };
    o.games++;
    o[g.result]++;
    // A family spans ECO codes — a Sicilian is B20 through B99 — so the code
    // only survives while every game in the row agrees on it. Keeping the
    // first game's would label the whole row with one variation's code.
    if (o.eco !== g.eco) o.eco = undefined;
    byOpening.set(key, o);
    // Only the catch-all needs its contents listed; a family row is already
    // named after everything in it.
    if (key === OTHER_FAMILY) {
      const inner = members.get(key) ?? new Map<string, number>();
      inner.set(name, (inner.get(name) ?? 0) + 1);
      members.set(key, inner);
    }
  }
  // Prior for shrinkage = the player's overall win rate over this sample.
  const sampleWins = games.filter((g) => g.result === "win").length;
  const priorMean = games.length ? sampleWins / games.length : 0.5;
  const allOpenings: OpeningStat[] = [...byOpening.values()].map((o) => {
    const ci = wilson(o.win, o.games);
    const inner = members.get(o.name);
    return {
      ...o,
      members: inner
        ? [...inner.entries()]
            .map(([name, games]) => ({ name, games }))
            .sort((a, b) => b.games - a.games)
        : undefined,
      winRate: o.games ? o.win / o.games : 0,
      adjWinRate: shrink(o.win, o.games, priorMean),
      ciLo: ci.lo,
      ciHi: ci.hi,
      conf: confidence(o.games),
    };
  });
  const openings = [...allOpenings]
    .sort((a, b) => {
      // Other always sits at the bottom: it is a leftovers row, not a result.
      if (a.name === OTHER_FAMILY) return 1;
      if (b.name === OTHER_FAMILY) return -1;
      return b.games - a.games;
    })
    .slice(0, 6);
  // Rank weak lines by the adjusted (shrunk) rate, not the raw one.
  const toughOpenings = [...allOpenings]
    // "Other" is a bucket of unrelated openings, so calling it a weak line
    // would be meaningless — there is no single thing to go and fix.
    .filter((o) => o.name !== OTHER_FAMILY)
    .filter((o) => o.games >= 3)
    .sort((a, b) => a.adjWinRate - b.adjWinRate)
    .slice(0, 5);

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
    winRateCI: (() => {
      const c = wilson(profile.count.win, profile.count.all);
      return { lo: c.lo, hi: c.hi };
    })(),
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
    days: playDays(games),
  };
}

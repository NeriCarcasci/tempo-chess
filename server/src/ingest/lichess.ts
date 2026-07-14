import type { NormalizedGame, Speed } from "./types.js";

const LICHESS_API = "https://lichess.org";

interface LichessPlayer {
  user?: { name: string; id: string };
  rating?: number;
}

interface LichessGame {
  id: string;
  rated: boolean;
  variant: string;
  speed: string;
  perf: string;
  createdAt: number;
  lastMoveAt: number;
  status: string;
  players: { white: LichessPlayer; black: LichessPlayer };
  winner?: "white" | "black";
  opening?: { eco: string; name: string; ply: number };
  clock?: { initial: number; increment: number; totalTime: number };
  moves?: string;
  pgn?: string;
}

function mapSpeed(s: string): Speed | undefined {
  switch (s) {
    case "ultraBullet":
    case "bullet":
      return "bullet";
    case "blitz":
      return "blitz";
    case "rapid":
      return "rapid";
    case "classical":
      return "classical";
    case "correspondence":
      return "correspondence";
    default:
      return undefined;
  }
}

export interface LichessFetchOptions {
  /** Max games to fetch (newest first). */
  max?: number;
  /** Only games created after this epoch-ms timestamp (for incremental sync). */
  since?: number;
  /** Personal API token — optional, raises rate limits. */
  token?: string;
}

/**
 * Streams a user's games newest-first as an async generator, so callers can
 * process/persist incrementally without buffering an entire history.
 */
export async function* fetchLichessGames(
  username: string,
  opts: LichessFetchOptions = {},
): AsyncGenerator<NormalizedGame> {
  const params = new URLSearchParams({
    pgnInJson: "true",
    clocks: "true",
    evals: "true",
    opening: "true",
    moves: "true",
    sort: "dateDesc",
  });
  if (opts.max) params.set("max", String(opts.max));
  if (opts.since) params.set("since", String(opts.since));

  const res = await fetch(
    `${LICHESS_API}/api/games/user/${encodeURIComponent(username)}?${params}`,
    {
      headers: {
        Accept: "application/x-ndjson",
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
    },
  );
  if (!res.ok) {
    throw new Error(`Lichess API ${res.status} for "${username}"`);
  }
  if (!res.body) return;

  const uname = username.toLowerCase();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield normalize(JSON.parse(line) as LichessGame, uname);
    }
  }
  const tail = buf.trim();
  if (tail) yield normalize(JSON.parse(tail) as LichessGame, uname);
}

function normalize(g: LichessGame, uname: string): NormalizedGame {
  const color: "white" | "black" =
    g.players.white.user?.name?.toLowerCase() === uname ? "white" : "black";
  const me = color === "white" ? g.players.white : g.players.black;
  const opp = color === "white" ? g.players.black : g.players.white;
  const result = !g.winner ? "draw" : g.winner === color ? "win" : "loss";

  const timeControl = g.clock
    ? `${g.clock.initial}+${g.clock.increment}`
    : g.speed === "correspondence"
      ? "correspondence"
      : undefined;

  return {
    platform: "lichess",
    platformGameId: g.id,
    url: `${LICHESS_API}/${g.id}`,
    playedAt: new Date(g.createdAt),
    color,
    result,
    termination: g.status,
    speed: mapSpeed(g.speed),
    timeControl,
    userRating: me.rating,
    opponentUsername: opp.user?.name,
    opponentRating: opp.rating,
    eco: g.opening?.eco,
    openingName: g.opening?.name,
    plyCount: g.moves ? g.moves.split(" ").filter(Boolean).length : undefined,
    pgn: g.pgn ?? "",
  };
}

import type { NormalizedGame, GameResult, Speed } from "./types.js";
import { parsePgnHeaders, openingNameFromEcoUrl } from "./pgn.js";

const CHESSCOM_API = "https://api.chess.com/pub";
// Chess.com blocks requests without a descriptive User-Agent.
const USER_AGENT = "TempoChess/0.1 (+https://github.com/NeriCarcasci/tempo-chess)";

interface ChesscomPlayer {
  username: string;
  rating: number;
  result: string;
}

interface ChesscomGame {
  url: string;
  pgn: string;
  time_control: string;
  end_time: number;
  rated: boolean;
  time_class: string; // bullet | blitz | rapid | daily
  rules: string; // chess | chess960 | ...
  eco?: string;
  white: ChesscomPlayer;
  black: ChesscomPlayer;
}

// Chess.com encodes the outcome in each player's `result` string.
const DRAW_RESULTS = new Set([
  "agreed",
  "repetition",
  "stalemate",
  "insufficient",
  "50move",
  "timevsinsufficient",
]);

function mapResult(r: string): GameResult {
  if (r === "win") return "win";
  if (DRAW_RESULTS.has(r)) return "draw";
  return "loss";
}

function mapSpeed(timeClass: string): Speed | undefined {
  switch (timeClass) {
    case "bullet":
      return "bullet";
    case "blitz":
      return "blitz";
    case "rapid":
      return "rapid";
    case "daily":
      return "correspondence";
    default:
      return undefined;
  }
}

export async function fetchChesscomArchives(username: string): Promise<string[]> {
  const res = await fetch(
    `${CHESSCOM_API}/player/${encodeURIComponent(username.toLowerCase())}/games/archives`,
    { headers: { "User-Agent": USER_AGENT } },
  );
  if (!res.ok) {
    throw new Error(`Chess.com archives ${res.status} for "${username}"`);
  }
  const data = (await res.json()) as { archives: string[] };
  return data.archives;
}

export interface ChesscomFetchOptions {
  /** Only games ending after this epoch-ms timestamp (for incremental sync). */
  since?: number;
  /** Stop after yielding this many games. */
  max?: number;
}

/**
 * Streams a user's games newest-first. Chess.com serves monthly PGN archives;
 * we walk them from most-recent and stop early once we pass `since`/`max`.
 */
export async function* fetchChesscomGames(
  username: string,
  opts: ChesscomFetchOptions = {},
): AsyncGenerator<NormalizedGame> {
  const archives = await fetchChesscomArchives(username);
  const uname = username.toLowerCase();
  let count = 0;

  for (const archiveUrl of archives.reverse()) {
    const res = await fetch(archiveUrl, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) continue;
    const data = (await res.json()) as { games: ChesscomGame[] };

    for (const g of data.games.reverse()) {
      if (opts.since && g.end_time * 1000 < opts.since) return;
      if (g.rules !== "chess") continue; // skip variants
      yield normalize(g, uname);
      if (opts.max && ++count >= opts.max) return;
    }
  }
}

function normalize(g: ChesscomGame, uname: string): NormalizedGame {
  const color: "white" | "black" =
    g.white.username.toLowerCase() === uname ? "white" : "black";
  const me = color === "white" ? g.white : g.black;
  const opp = color === "white" ? g.black : g.white;

  // Game id: trailing path segment of the game URL (e.g. .../game/live/1234).
  const platformGameId = g.url.split("/").filter(Boolean).pop() ?? g.url;

  // Chess.com's JSON `eco` is actually the opening URL; the real ECO code
  // (e.g. "B06") lives in the PGN headers.
  const headers = parsePgnHeaders(g.pgn ?? "");

  return {
    platform: "chesscom",
    platformGameId,
    url: g.url,
    playedAt: new Date(g.end_time * 1000),
    color,
    result: mapResult(me.result),
    speed: mapSpeed(g.time_class),
    timeControl: g.time_control,
    userRating: me.rating,
    opponentUsername: opp.username,
    opponentRating: opp.rating,
    eco: headers.ECO,
    openingName: openingNameFromEcoUrl(g.eco),
    pgn: g.pgn ?? "",
  };
}

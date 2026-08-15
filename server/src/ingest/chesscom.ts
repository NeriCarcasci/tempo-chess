import {
  createCanonicalGameId,
  createPgnFingerprint,
  normalizeProviderUsername,
  validateNormalizedGame,
} from "./canonical.js";
import { openingNameFromEcoUrl, parsePgn } from "./pgn.js";
import {
  NORMALIZED_GAME_SCHEMA_VERSION,
  type GameResult,
  type NormalizedGame,
  type NormalizedMove,
  type Speed,
} from "./types.js";

const CHESSCOM_API = "https://api.chess.com/pub";
const USER_AGENT = "FormaChess/0.1 (+https://github.com/NeriCarcasci/tempo-chess)";

interface ChesscomPlayer {
  username?: string;
  rating?: number;
  result?: string;
  uuid?: string;
}

export interface ChesscomGamePayload {
  url: string;
  pgn?: string;
  time_control?: string;
  end_time?: number;
  rated?: boolean;
  time_class?: string;
  rules?: string;
  eco?: string;
  white: ChesscomPlayer;
  black: ChesscomPlayer;
  accuracies?: { white?: number; black?: number };
}

const DRAW_RESULTS = new Set(["agreed", "repetition", "stalemate", "insufficient", "50move", "timevsinsufficient"]);

function mapResult(result?: string): GameResult {
  if (result === "win") return "win";
  if (result && DRAW_RESULTS.has(result)) return "draw";
  return "loss";
}

function mapSpeed(timeClass?: string): Speed | null {
  switch (timeClass) {
    case "bullet": return "bullet";
    case "blitz": return "blitz";
    case "rapid": return "rapid";
    case "daily": return "correspondence";
    default: return null;
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function liveClock(timeControl?: string): { initialMs: number; incrementMs: number } | null {
  const match = /^(\d+)(?:\+(\d+))?$/.exec(timeControl ?? "");
  if (!match) return null;
  return { initialMs: Number(match[1]) * 1000, incrementMs: Number(match[2] ?? 0) * 1000 };
}

function normalizeMoves(parsed: ReturnType<typeof parsePgn>, timeControl?: string): NormalizedMove[] {
  const control = liveClock(timeControl);
  const previousClock: Record<"white" | "black", number | null> = {
    white: control?.initialMs ?? null,
    black: control?.initialMs ?? null,
  };
  return parsed.moves.map((move) => {
    const color = move.color;
    const clockMs = move.clockMs ?? null;
    const thinkTimeMs = clockMs !== null && previousClock[color] !== null && control
      ? Math.max(0, previousClock[color]! + control.incrementMs - clockMs)
      : null;
    // A missing intermediate clock invalidates the next delta for this side.
    previousClock[color] = clockMs;
    return {
      ply: move.ply,
      moveNumber: move.moveNumber,
      color,
      uci: move.uci,
      san: move.san,
      fenBefore: move.fenBefore,
      fenAfter: move.fenAfter,
      clockMs,
      thinkTimeMs,
      providerEvaluation: null,
      annotations: { comment: null, nags: [], raw: {} },
    };
  });
}

export function normalizeChesscomGame(
  game: ChesscomGamePayload,
  accountUsername: string,
  fetchedAt = new Date(),
): NormalizedGame {
  const pgn = game.pgn ?? "";
  const parsed = parsePgn(pgn);
  if (parsed.warning || parsed.moves.length === 0) {
    throw new Error(`Chess.com game ${game.url || "<unknown>"} has malformed or empty PGN${parsed.warning ? `: ${parsed.warning}` : ""}`);
  }
  const uname = normalizeProviderUsername(accountUsername);
  const whiteName = game.white.username ?? parsed.headers.White ?? null;
  const blackName = game.black.username ?? parsed.headers.Black ?? null;
  const whiteMatches = whiteName != null && normalizeProviderUsername(whiteName) === uname;
  const blackMatches = blackName != null && normalizeProviderUsername(blackName) === uname;
  if (!whiteMatches && !blackMatches) throw new Error(`Connected Chess.com account "${accountUsername}" is not a player in ${game.url}`);
  const color = whiteMatches ? "white" : "black";
  const me = color === "white" ? game.white : game.black;
  const opponent = color === "white" ? game.black : game.white;
  const result = mapResult(me.result);
  const platformGameId = game.url.split("/").filter(Boolean).pop() ?? game.url;
  if (!platformGameId) throw new Error("Chess.com game is missing a platform game ID");
  const playedAt = game.end_time == null ? null : new Date(game.end_time * 1000);
  const moves = normalizeMoves(parsed, game.time_control);
  const whiteAccuracy = numberOrNull(game.accuracies?.white);
  const blackAccuracy = numberOrNull(game.accuracies?.black);

  return validateNormalizedGame({
    schemaVersion: NORMALIZED_GAME_SCHEMA_VERSION,
    canonicalGameId: createCanonicalGameId("chesscom", platformGameId),
    pgnFingerprint: createPgnFingerprint({
      moves, whiteUsername: whiteName, blackUsername: blackName,
      result, connectedColor: color, playedAt,
    }),
    provenance: {
      provider: "chesscom",
      platformGameId,
      accountUsername,
      accountProviderId: me.uuid ?? null,
      sourceUrl: game.url || null,
      fetchedAt,
    },
    players: {
      white: { username: whiteName, providerId: game.white.uuid ?? null, rating: numberOrNull(game.white.rating) },
      black: { username: blackName, providerId: game.black.uuid ?? null, rating: numberOrNull(game.black.rating) },
    },
    providerAccuracy: whiteAccuracy === null && blackAccuracy === null ? null : { white: whiteAccuracy, black: blackAccuracy },
    moves,
    platform: "chesscom",
    platformGameId,
    url: game.url || null,
    playedAt,
    color,
    result,
    termination: parsed.headers.Termination ?? me.result ?? null,
    speed: mapSpeed(game.time_class),
    timeControl: game.time_control ?? null,
    userRating: numberOrNull(me.rating),
    opponentUsername: opponent.username ?? (color === "white" ? blackName : whiteName),
    opponentRating: numberOrNull(opponent.rating),
    eco: parsed.headers.ECO ?? null,
    openingName: openingNameFromEcoUrl(game.eco) ?? parsed.headers.Opening ?? null,
    plyCount: moves.length,
    pgn,
  });
}

export async function fetchChesscomArchives(username: string): Promise<string[]> {
  const res = await fetch(`${CHESSCOM_API}/player/${encodeURIComponent(username.toLowerCase())}/games/archives`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`Chess.com archives ${res.status} for "${username}"`);
  const data = (await res.json()) as { archives?: string[] };
  return Array.isArray(data.archives) ? data.archives : [];
}

export interface ChesscomFetchOptions { since?: number; max?: number }

export async function* fetchChesscomGames(username: string, opts: ChesscomFetchOptions = {}): AsyncGenerator<NormalizedGame> {
  const archives = await fetchChesscomArchives(username);
  let count = 0;
  for (const archiveUrl of [...archives].reverse()) {
    const res = await fetch(archiveUrl, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) continue;
    const data = (await res.json()) as { games?: ChesscomGamePayload[] };
    for (const game of [...(data.games ?? [])].reverse()) {
      if (opts.since && game.end_time != null && game.end_time * 1000 < opts.since) return;
      if (game.rules !== "chess") continue;
      try {
        yield normalizeChesscomGame(game, username);
        count += 1;
      } catch {
        // A malformed game must not prevent the rest of a monthly archive importing.
        continue;
      }
      if (opts.max && count >= opts.max) return;
    }
  }
}

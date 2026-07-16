import { Chess } from "chess.js";
import { createCanonicalGameId, createPgnFingerprint, normalizeProviderUsername, validateNormalizedGame } from "./canonical.js";
import {
  NORMALIZED_GAME_SCHEMA_VERSION,
  type JsonValue,
  type NormalizedGame,
  type NormalizedMove,
  type Speed,
} from "./types.js";

const LICHESS_API = "https://lichess.org";

interface LichessPlayer {
  user?: { name?: string; id?: string };
  rating?: number;
  analysis?: { accuracy?: number; inaccuracy?: number; mistake?: number; blunder?: number; acpl?: number };
}

interface LichessAnalysis {
  eval?: number;
  mate?: number;
  accuracy?: number;
  best?: string;
  variation?: string;
  judgment?: { name?: string; comment?: string };
}

export interface LichessGamePayload {
  id: string;
  rated?: boolean;
  variant?: string;
  speed?: string;
  perf?: string;
  createdAt?: number;
  lastMoveAt?: number;
  status?: string;
  players: { white: LichessPlayer; black: LichessPlayer };
  winner?: "white" | "black";
  opening?: { eco?: string; name?: string; ply?: number };
  clock?: { initial?: number; increment?: number; totalTime?: number };
  moves?: string;
  clocks?: number[];
  analysis?: LichessAnalysis[];
  accuracy?: { white?: number; black?: number };
  division?: { middle?: number; end?: number };
  initialFen?: string;
  pgn?: string;
}

function mapSpeed(speed?: string): Speed | null {
  switch (speed) {
    case "ultraBullet":
    case "bullet": return "bullet";
    case "blitz": return "blitz";
    case "rapid": return "rapid";
    case "classical": return "classical";
    case "correspondence": return "correspondence";
    default: return null;
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function phaseForPly(ply: number, division?: LichessGamePayload["division"]): string | null {
  if (!division?.middle) return null;
  if (ply < division.middle) return "opening";
  if (!division.end || ply < division.end) return "middlegame";
  return "endgame";
}

function normalizeMoves(game: LichessGamePayload): NormalizedMove[] {
  const chess = new Chess(game.initialFen && game.initialFen !== "startpos" ? game.initialFen : undefined);
  const tokens = game.moves?.trim().split(/\s+/).filter(Boolean) ?? [];
  const moves: NormalizedMove[] = [];
  const previousClock: Record<"white" | "black", number | null> = {
    white: numberOrNull(game.clock?.initial) === null ? null : game.clock!.initial! * 1000,
    black: numberOrNull(game.clock?.initial) === null ? null : game.clock!.initial! * 1000,
  };
  const incrementMs = numberOrNull(game.clock?.increment) === null ? 0 : game.clock!.increment! * 1000;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const uciMatch = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(token);
    const fenBefore = chess.fen();
    const color = chess.turn() === "w" ? "white" : "black";
    const moveNumber = Number(fenBefore.split(" ")[5]);
    let played;
    try {
      // The user-games NDJSON endpoint currently emits SAN in `moves`.
      // Accept UCI as well so archived fixtures and compatible exports remain valid.
      played = uciMatch
        ? chess.move({ from: uciMatch[1], to: uciMatch[2], promotion: uciMatch[3] })
        : chess.move(token);
    } catch {
      break;
    }
    if (!played) break;

    const ply = index + 1;
    // Lichess clocks are integer centiseconds remaining after each ply.
    const clockMs = numberOrNull(game.clocks?.[index]) === null ? null : game.clocks![index] * 10;
    const thinkTimeMs = clockMs === null || previousClock[color] === null
      ? null
      : Math.max(0, previousClock[color]! + incrementMs - clockMs);
    if (clockMs !== null) previousClock[color] = clockMs;

    const analysis = game.analysis?.[index];
    const hasEvaluation = analysis != null && (numberOrNull(analysis.eval) !== null || numberOrNull(analysis.mate) !== null || numberOrNull(analysis.accuracy) !== null);
    const raw: Record<string, JsonValue> = {};
    if (analysis?.best) raw.best = analysis.best;
    if (analysis?.variation) raw.variation = analysis.variation;
    if (analysis?.judgment?.name) raw.judgment = analysis.judgment.name;
    const providerPhase = phaseForPly(ply, game.division);
    if (providerPhase) raw.providerPhase = providerPhase;

    moves.push({
      ply,
      moveNumber,
      color,
      uci: `${played.from}${played.to}${played.promotion ?? ""}`,
      san: played.san,
      fenBefore,
      fenAfter: chess.fen(),
      clockMs,
      thinkTimeMs,
      // Lichess JSON analysis scores are already expressed from White's POV.
      providerEvaluation: hasEvaluation ? {
        source: "lichess",
        centipawns: numberOrNull(analysis?.eval),
        mate: numberOrNull(analysis?.mate),
        accuracy: numberOrNull(analysis?.accuracy),
      } : null,
      annotations: {
        comment: analysis?.judgment?.comment ?? null,
        nags: [],
        raw,
      },
    });
  }
  return moves;
}

export function normalizeLichessGame(
  game: LichessGamePayload,
  accountUsername: string,
  fetchedAt = new Date(),
): NormalizedGame {
  if (game.variant && game.variant !== "standard") {
    throw new Error(`Lichess game ${game.id} uses unsupported variant "${game.variant}"`);
  }
  const uname = normalizeProviderUsername(accountUsername);
  const whiteName = game.players.white.user?.name ?? null;
  const blackName = game.players.black.user?.name ?? null;
  const whiteMatches = whiteName != null && normalizeProviderUsername(whiteName) === uname;
  const blackMatches = blackName != null && normalizeProviderUsername(blackName) === uname;
  if (!whiteMatches && !blackMatches) throw new Error(`Connected Lichess account "${accountUsername}" is not a player in ${game.id}`);
  const color = whiteMatches ? "white" : "black";
  const me = color === "white" ? game.players.white : game.players.black;
  const opponent = color === "white" ? game.players.black : game.players.white;
  const moves = normalizeMoves(game);
  if (moves.length === 0) throw new Error(`Lichess game ${game.id} has malformed or empty moves`);
  const providerAccuracy = {
    white: numberOrNull(game.accuracy?.white ?? game.players.white.analysis?.accuracy),
    black: numberOrNull(game.accuracy?.black ?? game.players.black.analysis?.accuracy),
  };
  const sourceUrl = `${LICHESS_API}/${game.id}`;
  const playedAt = game.createdAt == null ? null : new Date(game.createdAt);
  const result = !game.winner ? "draw" : game.winner === color ? "win" : "loss";
  const timeControl = game.clock?.initial != null && game.clock?.increment != null
    ? `${game.clock.initial}+${game.clock.increment}`
    : game.speed === "correspondence" ? "correspondence" : null;

  return validateNormalizedGame({
    schemaVersion: NORMALIZED_GAME_SCHEMA_VERSION,
    canonicalGameId: createCanonicalGameId("lichess", game.id),
    pgnFingerprint: createPgnFingerprint({
      moves, whiteUsername: whiteName, blackUsername: blackName,
      result, connectedColor: color, playedAt,
    }),
    provenance: {
      provider: "lichess",
      platformGameId: game.id,
      accountUsername,
      accountProviderId: me.user?.id ?? null,
      sourceUrl,
      fetchedAt,
    },
    players: {
      white: { username: whiteName, providerId: game.players.white.user?.id ?? null, rating: numberOrNull(game.players.white.rating) },
      black: { username: blackName, providerId: game.players.black.user?.id ?? null, rating: numberOrNull(game.players.black.rating) },
    },
    providerAccuracy: providerAccuracy.white === null && providerAccuracy.black === null ? null : providerAccuracy,
    moves,
    platform: "lichess",
    platformGameId: game.id,
    url: sourceUrl,
    playedAt,
    color,
    result,
    termination: game.status ?? null,
    speed: mapSpeed(game.speed),
    timeControl,
    userRating: numberOrNull(me.rating),
    opponentUsername: opponent.user?.name ?? null,
    opponentRating: numberOrNull(opponent.rating),
    eco: game.opening?.eco ?? null,
    openingName: game.opening?.name ?? null,
    plyCount: moves.length,
    pgn: game.pgn ?? "",
  });
}

export interface LichessFetchOptions {
  max?: number;
  since?: number;
  token?: string;
}

export async function* fetchLichessGames(username: string, opts: LichessFetchOptions = {}): AsyncGenerator<NormalizedGame> {
  const params = new URLSearchParams({
    pgnInJson: "true", clocks: "true", evals: "true", accuracy: "true",
    opening: "true", division: "true", moves: "true", sort: "dateDesc",
  });
  if (opts.max) params.set("max", String(opts.max));
  if (opts.since) params.set("since", String(opts.since));
  const res = await fetch(`${LICHESS_API}/api/games/user/${encodeURIComponent(username)}?${params}`, {
    headers: { Accept: "application/x-ndjson", ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
  });
  if (!res.ok) throw new Error(`Lichess API ${res.status} for "${username}"`);
  if (!res.body) return;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const parseLine = (line: string): LichessGamePayload | null => {
    try { return JSON.parse(line) as LichessGamePayload; } catch { return null; }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      const game = line ? parseLine(line) : null;
      if (game) {
        try { yield normalizeLichessGame(game, username); } catch { /* skip malformed game */ }
      }
    }
  }
  buffer += decoder.decode();
  const tail = buffer.trim();
  const game = tail ? parseLine(tail) : null;
  if (game) {
    try { yield normalizeLichessGame(game, username); } catch { /* skip malformed game */ }
  }
}

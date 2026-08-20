/**
 * Recent games with their moves, for the screens that replay them and the one
 * that names the last of them.
 *
 * `GET /v1/games/recent` has landed. It answers `{ asOf, games }`, wraps the
 * opponent in an object and carries `outcome` — the subject's own result —
 * beside `result`, which names the winning colour. This module is still the
 * only place that knows the wire shape.
 *
 * Two rules follow from that, and both are deliberate:
 *
 *   * **It never throws.** The sync screen replays these games as evidence that
 *     work is happening. That evidence is worth having and is never worth a
 *     blank page, so a 404, a network failure or a body this build cannot read
 *     all become an empty list, and the caller draws the rest of the screen
 *     without boards.
 *   * **It reads defensively rather than trusting the shape.** A game with no
 *     usable moves is dropped instead of rendering an empty board, and a move
 *     that is not a UCI pair is dropped instead of stopping the replay
 *     somewhere unpredictable.
 */

import { v1Maybe } from "./client";

export interface GameMove {
  uci: string;
  /** Present when the API sends it. Nothing here needs it, so it stays optional. */
  san?: string;
}

export interface RecentGame {
  id: string;
  /** The handle on the other side of the board, when the API names one. */
  opponent: string | null;
  /** The subject's colour, which decides which way up the board is drawn. */
  colour: "white" | "black" | null;
  speed: string | null;
  /** Which colour won, or a draw. Not the subject's result — see `outcome`. */
  result: string | null;
  /**
   * How it went *for the subject*.
   *
   * Separate from `result` on purpose: "black won" and "you lost" are the same
   * game only once you know which side the person was, and a screen that reads
   * one as the other congratulates people on their defeats.
   */
  outcome: "win" | "loss" | "draw" | null;
  /** ISO 8601, as the API sends it. */
  playedAt: string | null;
  /** The game on the site it was played on, when the provider exposes one. */
  providerUrl: string | null;
  /** Only set when the game did not start from the standard position. */
  initialFen: string | null;
  moves: GameMove[];
}

/** `e2e4`, or `e7e8q` for a promotion. Anything else is not a move we can play. */
const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

function readMove(entry: unknown): GameMove | null {
  // A bare string and `{ uci }` are a coin flip for a route still being
  // written, and reading both costs one branch. Getting it wrong costs the
  // whole row of boards.
  if (typeof entry === "string") {
    const uci = entry.trim().toLowerCase();
    return UCI.test(uci) ? { uci } : null;
  }
  if (typeof entry !== "object" || entry === null) return null;
  const record = entry as Record<string, unknown>;
  const uci = text(record.uci)?.toLowerCase() ?? null;
  if (uci === null || !UCI.test(uci)) return null;
  const san = text(record.san);
  return san === null ? { uci } : { uci, san };
}

/**
 * The handle across the board.
 *
 * The route sends `{ username, title, rating }`; a bare string is still read
 * because the sync screen shipped against that shape and a row reading "From
 * your archive" where a name belongs is a silent loss, not a visible one.
 */
function readOpponent(entry: unknown): string | null {
  if (typeof entry === "string") return text(entry);
  if (typeof entry !== "object" || entry === null) return null;
  return text((entry as Record<string, unknown>).username);
}

function readOutcome(entry: unknown): RecentGame["outcome"] {
  const value = text(entry)?.toLowerCase() ?? null;
  return value === "win" || value === "loss" || value === "draw" ? value : null;
}

function readGame(entry: unknown): RecentGame | null {
  if (typeof entry !== "object" || entry === null) return null;
  const record = entry as Record<string, unknown>;

  const id = text(record.id);
  if (id === null) return null;

  const moves = Array.isArray(record.moves)
    ? record.moves.map(readMove).filter((move): move is GameMove => move !== null)
    : [];
  // A game with nothing to play is not a game this screen can show. Rendering
  // its opening position would be a still picture in a row of moving ones,
  // which reads as a board that has crashed.
  if (moves.length === 0) return null;

  // Both spellings, because the server is written by other hands and the
  // British one is the house style here. The cost of guessing wrong is every
  // board drawn from the wrong seat.
  const rawColour = (text(record.colour) ?? text(record.color))?.toLowerCase() ?? null;
  const colour = rawColour === "white" || rawColour === "black" ? rawColour : null;

  return {
    id,
    opponent: readOpponent(record.opponent),
    colour,
    speed: text(record.speed),
    result: text(record.result),
    outcome: readOutcome(record.outcome),
    playedAt: text(record.playedAt),
    providerUrl: text(record.providerUrl),
    initialFen: text(record.initialFen),
    moves,
  };
}

/**
 * The caller's most recent games, newest first, or an empty list.
 *
 * The `catch` is not belt and braces: `v1Maybe` swallows a `ProblemError` but
 * deliberately rethrows the redirect a 401 produces, and this is called from an
 * effect where a thrown `Response` reaches nothing that can act on it. An
 * expired session is handled by the poll this screen is already running.
 */
export async function fetchRecentGames(limit: number): Promise<RecentGame[]> {
  try {
    const data = await v1Maybe<unknown>("/v1/games/recent", { query: { limit } });
    // A collection route may answer with the array itself or with `{ games }`.
    const rows = Array.isArray(data)
      ? data
      : Array.isArray((data as { games?: unknown } | null)?.games)
        ? ((data as { games: unknown[] }).games)
        : null;
    if (rows === null) return [];
    return rows.map(readGame).filter((game): game is RecentGame => game !== null);
  } catch {
    return [];
  }
}

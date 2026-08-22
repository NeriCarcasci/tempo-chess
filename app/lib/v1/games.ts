/**
 * Recent games with their moves, for the screens that replay them.
 *
 * `GET /v1/games/recent` is being written on the server as this ships, so this
 * module is the seam: it is the only place that knows the wire shape, and the
 * only file that has to change when the real route lands.
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

import { v1Data, v1Maybe } from "./client";

export interface GameMove {
  uci: string;
  /** Present when the API sends it. Nothing here needs it, so it stays optional. */
  san?: string;
}

export interface RecentGame {
  id: string;
  /** The handle on the other side of the board, when the API names one. */
  opponent: string | null;
  /** Their rating in that game, when the provider recorded one. */
  opponentRating: number | null;
  /** The subject's colour, which decides which way up the board is drawn. */
  colour: "white" | "black" | null;
  speed: string | null;
  /** Who won: `white`, `black` or `draw`. Not the subject's own result. */
  result: string | null;
  /**
   * The subject's own result, which is the one a person reads.
   *
   * Separate from `result` because they answer different questions and the
   * route sends both: a game whose `result` is `black` is a win or a loss
   * depending on which seat the subject was in, and collapsing the two here
   * would put the wrong letter beside half of somebody's games.
   */
  outcome: "win" | "loss" | "draw" | null;
  playedAt: string | null;
  /** The game on the site it was played on, when the route names it. */
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
 * The other side of the board, from either shape the route might send.
 *
 * `listRecentGames` ships `{ username, title, rating }`; this module was
 * written against a bare string before the route existed, and reading only the
 * string is why the sync screen said "From your archive" under every board it
 * drew. Both are read, because one branch is cheaper than being wrong about
 * every row.
 */
function readOpponent(value: unknown): { name: string | null; rating: number | null } {
  if (typeof value === "string") return { name: text(value), rating: null };
  if (typeof value !== "object" || value === null) return { name: null, rating: null };
  const record = value as Record<string, unknown>;
  const rating =
    typeof record.rating === "number" && Number.isFinite(record.rating) ? record.rating : null;
  return { name: text(record.username), rating };
}

const OUTCOMES = new Set(["win", "loss", "draw"]);

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

  const opponent = readOpponent(record.opponent);
  const rawOutcome = text(record.outcome)?.toLowerCase() ?? null;

  return {
    id,
    opponent: opponent.name,
    opponentRating: opponent.rating,
    colour,
    speed: text(record.speed),
    result: text(record.result),
    // An outcome nobody agreed on is null rather than a guess, for the same
    // reason as the colour: a wrong letter beside a game is worse than none.
    outcome: rawOutcome !== null && OUTCOMES.has(rawOutcome) ? (rawOutcome as RecentGame["outcome"]) : null,
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
    return gamesFrom(data) ?? [];
  } catch {
    return [];
  }
}

/** One decoder for the optional and strict reads, so their accepted wire shape cannot drift. */
function gamesFrom(data: unknown): RecentGame[] | null {
  // A collection route may answer with the array itself or with `{ games }`.
  const rows = Array.isArray(data)
    ? data
    : Array.isArray((data as { games?: unknown } | null)?.games)
      ? (data as { games: unknown[] }).games
      : null;
  return rows?.map(readGame).filter((game): game is RecentGame => game !== null) ?? null;
}

/**
 * The same read for callers that must distinguish an empty archive from a
 * failed request. Optional dashboard rows use `fetchRecentGames`; identifier
 * resolution cannot, because swallowing the failure turns "unreachable" into
 * the stronger claim that the game was never synced.
 */
export async function fetchRecentGamesStrict(limit: number): Promise<RecentGame[]> {
  const data = await v1Data<unknown>("/v1/games/recent", { query: { limit } });
  const games = gamesFrom(data);
  if (games === null) throw new Error("the recent-games response has no games array");
  return games;
}

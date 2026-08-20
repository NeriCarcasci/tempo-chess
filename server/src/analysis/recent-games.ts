/**
 * The subject's newest games, with the moves in them.
 *
 * `chess.game_replay_revisions.normalized_replay` is the only place Forma keeps
 * the moves of a game, and nothing on the API could reach it: `/v1/games/{id}`
 * carries metadata and publication state, and the opening explorer carries a
 * position graph keyed by core position. So a screen that wanted to put a real
 * board on the page had nothing to animate, and the wait while analysis runs
 * was a spinner over games the person had already played.
 *
 * `GET /games/{gameId}/review` in §7 does carry moves, and is not what this
 * replaces: it carries them for one game, for one *published* run. The window
 * this read exists to fill is the one before a publication exists at all.
 *
 * Two properties this module has to keep, because a board is about to be drawn
 * from what it returns.
 *
 *   - **A move list is evidence, not decoration.** The moves come from the
 *     replay revision the subject's own row points at
 *     (`subject_games.latest_replay_revision_id`), not from the provider game's
 *     current pointer. The two differ while a provider correction is in flight,
 *     and the subject's is the one every published analysis cited.
 *   - **`initialFen` null means the standard starting position.** Providers
 *     spell that three ways — absent, blank, and the literal `startpos` — and a
 *     client that fed any of them to a FEN parser would fail to render a game
 *     that starts perfectly normally. Normalizing here gives the client one
 *     rule instead of three.
 *
 * There is no publication state in the response on purpose. This read exists to
 * show games *while* analysis is still running, and a field saying whether a
 * verdict exists would invite a screen to render the absence of one as a claim.
 */

import { INITIAL_FEN } from "chessops/fen";
import type { Queryable } from "../db/queryable.js";
import { requiredIso, toDate, type RawTimestamp } from "../db/timestamps.js";

/**
 * How many games one request may ask for.
 *
 * The bound is about bytes, not rows: a game carries every ply it contains, so
 * a long classical game is a few kilobytes on its own. Twelve boards is more
 * than any screen animates at once, and it keeps the worst case well inside
 * what a phone on a hotel connection will accept.
 */
export const RECENT_GAMES_MAX_LIMIT = 12;
export const RECENT_GAMES_DEFAULT_LIMIT = 6;

export interface RecentGameMove {
  uci: string;
  /**
   * Absent from older replays. A caller that needs to caption a move has to
   * cope with null rather than being handed a reconstruction we did not store.
   */
  san: string | null;
  /** Milliseconds left on the mover's clock. Null when the provider never said. */
  clockMs: number | null;
}

/** The other player, as the provider described them when the game was synced. */
export interface RecentGameOpponent {
  username: string | null;
  title: string | null;
  rating: number | null;
}

export interface RecentGameView {
  /** `chess.subject_games.id` — the same id `GET /v1/games/{gameId}` takes. */
  id: string;
  playedAt: string;
  speed: string | null;
  /** Who won, absolutely. `draw` is a result, not a missing winner. */
  result: "white" | "black" | "draw";
  /** Null when the sync could not tell which side the subject played. */
  color: "white" | "black" | null;
  /** The same game from the subject's side. Null when the colour is unknown. */
  outcome: "win" | "loss" | "draw" | null;
  opponent: RecentGameOpponent;
  providerUrl: string | null;
  /** Null means the standard starting position. */
  initialFen: string | null;
  moves: RecentGameMove[];
}

export interface RecentGames {
  /**
   * When the newest of these games was last written by a sync, or null when
   * there are none.
   *
   * Deliberately not the time the query ran. A body carrying a clock hashes
   * differently on every request, so the ETag never matches and the conditional
   * request machinery becomes decoration — a bug this codebase has already
   * shipped once. It is also the less useful of the two: a reader wants to know
   * how current the answer is, not how recently a query executed over rows that
   * had not changed in a week.
   */
  asOf: string | null;
  games: RecentGameView[];
}

export interface RecentGameRow {
  id: string;
  subject_color: "white" | "black" | null;
  updated_at: RawTimestamp;
  played_at: RawTimestamp;
  speed: string | null;
  result: "white" | "black" | "draw";
  outcome: "win" | "loss" | "draw" | null;
  opponent_username: string | null;
  opponent_title: string | null;
  opponent_rating: number | null;
  provider_url: string | null;
  initial_fen: string | null;
  /** jsonb. Parsed or raw text, depending on which parsers the driver has. */
  normalized_replay: unknown;
}

interface RawReplay {
  moves?: unknown;
}

/**
 * `normalized_replay` as an object, whatever the driver handed over.
 *
 * `drizzle(client, { schema })` in `db/client.ts` rewrites parsers on the
 * shared connection, so what a raw query gets back for a jsonb column is not
 * guaranteed across this process's lifetime. Accepting both shapes costs one
 * branch and removes a whole class of "worked in the worker, threw in the API".
 */
function replayOf(value: unknown): RawReplay {
  if (value === null || value === undefined) return {};
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as RawReplay;
    } catch {
      // A replay we cannot parse is a game with no moves to show, not a 500 on
      // a screen whose only job is to animate the other eleven.
      return {};
    }
  }
  return typeof value === "object" ? (value as RawReplay) : {};
}

/** A number the driver may have handed over as numeric text. */
function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The move list, dropping anything that is not a playable move.
 *
 * A move without a UCI cannot be applied to a board, so shipping it would put
 * the client's replay one ply out of step with the game for every ply after it.
 * Dropping it truncates the animation instead, which is visibly incomplete
 * rather than quietly wrong.
 */
export function movesOf(normalizedReplay: unknown): RecentGameMove[] {
  const raw = replayOf(normalizedReplay).moves;
  if (!Array.isArray(raw)) return [];
  const moves: RecentGameMove[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const move = entry as { uci?: unknown; san?: unknown; clockMs?: unknown };
    if (typeof move.uci !== "string" || move.uci.length === 0) continue;
    moves.push({
      uci: move.uci,
      san: typeof move.san === "string" && move.san.length > 0 ? move.san : null,
      clockMs: finiteOrNull(move.clockMs),
    });
  }
  return moves;
}

/** The three ways a provider spells "the game started normally". */
const STANDARD_START = new Set(["", "startpos", INITIAL_FEN]);

/**
 * The starting position, or null when it is the standard one.
 *
 * `positions/canonical.ts` already treats absent and blank as the initial
 * position when it materializes a replay, and `ingest/lichess.ts` already
 * treats `startpos` that way. Collapsing all of them to null here means the
 * wire contract has one rule — null is the start — rather than exporting three
 * provider spellings for a client to rediscover.
 */
export function initialFenOf(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  return STANDARD_START.has(trimmed) ? null : trimmed;
}

export function shapeRecentGame(row: RecentGameRow): RecentGameView {
  return {
    id: row.id,
    playedAt: requiredIso(row.played_at, "played_at"),
    speed: row.speed,
    result: row.result,
    color: row.subject_color,
    outcome: row.outcome,
    opponent: {
      username: row.opponent_username,
      title: row.opponent_title,
      rating: finiteOrNull(row.opponent_rating),
    },
    providerUrl: row.provider_url,
    initialFen: initialFenOf(row.initial_fen),
    moves: movesOf(row.normalized_replay),
  };
}

/**
 * The newest `updated_at` in the answer, as an ISO instant.
 *
 * `subject_games.updated_at` moves when a sync rewrites the subject's statement
 * about a game — a new game, or a provider correction repointing it at a newer
 * replay revision. That is exactly the event that should change this response,
 * so it is the honest freshness marker for it.
 */
export function asOfOf(rows: readonly RecentGameRow[]): string | null {
  let newest: Date | null = null;
  for (const row of rows) {
    const stamp = toDate(row.updated_at);
    if (stamp && !Number.isNaN(stamp.getTime()) && (newest === null || stamp > newest)) {
      newest = stamp;
    }
  }
  return newest === null ? null : newest.toISOString();
}

export function shapeRecentGames(rows: readonly RecentGameRow[]): RecentGames {
  return { asOf: asOfOf(rows), games: rows.map(shapeRecentGame) };
}

/**
 * Read the subject's newest games.
 *
 * Must run inside `withActorContext`. `chess.subject_games` carries
 * `force row level security` with a policy on `private.current_actor_id()`,
 * which is null on an unbound pooled connection — so this returns zero rows
 * rather than raising, and an unbound read is indistinguishable from an empty
 * account. Every outage this project has had of that shape started here.
 *
 * Ordered by when the games were played, not by when they were synced. A first
 * sync writes a whole history in one transaction, so `updated_at` would order
 * an entire account by provider pagination order, which is not a thing anybody
 * recognises as "my recent games". The id breaks ties so the page is stable
 * when two games share a timestamp.
 */
export async function readRecentSubjectGames(
  sql: Queryable,
  input: { subjectId: string; limit: number },
): Promise<RecentGames> {
  const rows = await sql<RecentGameRow[]>`
    select
      sg.id,
      sg.subject_color,
      sg.updated_at,
      rev.played_at,
      rev.speed,
      rev.result,
      rev.provider_url,
      rev.initial_fen,
      rev.normalized_replay,
      -- The subject's own outcome is already stored against their colour. It is
      -- read rather than derived from result and subject_color, so there is one
      -- implementation of "did I win" and not a second one on this path.
      mine.outcome,
      opp.username_snapshot as opponent_username,
      opp.title_snapshot    as opponent_title,
      opp.rating            as opponent_rating
    from chess.subject_games sg
    join chess.game_replay_revisions rev on rev.id = sg.latest_replay_revision_id
    -- Both are left joins, and both come back null when subject_color is null:
    -- a comparison against null is null, not false. That is the honest answer
    -- for a game whose sides the sync could not attribute, and it keeps the
    -- game on the screen with an unnamed opponent rather than dropping it.
    left join chess.game_revision_participants mine
      on mine.replay_revision_id = rev.id and mine.color = sg.subject_color
    left join chess.game_revision_participants opp
      on opp.replay_revision_id = rev.id and opp.color <> sg.subject_color
    where sg.subject_id = ${input.subjectId}
      and sg.status = 'included'
      and sg.latest_replay_revision_id is not null
    order by rev.played_at desc, sg.id desc
    limit ${input.limit}
  `;
  return shapeRecentGames(rows);
}

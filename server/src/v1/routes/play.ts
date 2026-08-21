/**
 * `GET /v1/play/opponents` and `POST /v1/play/moves` — playing a game against
 * the engine, per plans/v1-api-contract.md §14.
 *
 * ## Nothing is persisted, and that is the design
 *
 * §14 also reserves `POST /play/sessions`, `POST /play/sessions/{id}/moves` and
 * `DELETE /play/sessions/{id}`. This ships the stateless half of that: the
 * client holds the game and the server answers one position at a time. No game
 * is stored. The only durable trace a move leaves is the kernel's own
 * idempotency record — one response envelope in `ops`, keyed to a request,
 * expiring in a day, joined to nothing and reachable as nothing — which every
 * `/v1` command writes and which is not a record of a game. Three reasons, in
 * order of weight.
 *
 * The first is the one the rest of the platform cares about. Platform spec §3.1
 * puts bot games in a separate evidence stratum from a player's real games, and
 * §14 says this feature "is isolated from evidence unless a future explicit
 * assessment contract promotes it". A training game that exists as no row
 * cannot leak into the canonical archive, cannot be picked up by a coverage
 * query that forgot to exclude it, and cannot be exported as one of the games
 * this person played. That is a stronger guarantee than a flag column, because
 * it does not depend on every future query remembering the flag.
 *
 * The second is that a session would buy no safety. A stored game makes the
 * server the authority on whose turn it is — but the only party a play session
 * could be defended against is the player themselves, and there is no rating,
 * no opponent and no evidence at stake. What actually needs bounding is engine
 * time, and that is the rate limit, which works identically either way.
 *
 * The third is that it would cost a tenant table under RLS, a deletion cascade,
 * an export decision and a retention rule, for a feature whose screen has no
 * "resume" affordance to justify them.
 *
 * What would change the decision: a resumable game, or a sparring record that
 * some future practice loop actually reads. Either needs its own table with its
 * own retention story — never `chess.games`, and never `analysis.*`.
 *
 * ## A move is not an evaluation
 *
 * The response carries a move, a resulting position and which opponent played
 * it. It carries no score, and `engine/opponent.ts` never parses one off the
 * wire, so there is no field a caller could route into an evaluation. The
 * search is a handicapped few hundred milliseconds with no promoted recipe and
 * no calibration version behind it; it is not comparable with anything
 * `POST /v1/positions/evaluations` returns and is deliberately not shaped like
 * it.
 *
 * ## Why not `POST /v1/positions/evaluations`
 *
 * It answers a different question and answers it asynchronously. It interns the
 * position, keys a work item on the promoted recipe's cache key, and returns
 * 202 with a workflow when the answer is not already cached — and in a game
 * every position after the opening is novel, so it would be 202 every time. The
 * outbox that would dispatch that work runs on a one-minute schedule, which is
 * a minute per bot move. It also has no strength parameter and must not gain
 * one: its profile is fixed server-side precisely so nobody can ask for a
 * weaker search, and asking for a weaker search is the entire point here.
 */

import { z } from "zod";
import { ProblemError } from "../problem.js";
import type { RouteDefinition } from "../registry.js";
import { POLICIES } from "../rate-limit.js";
import {
  MOVE_BUDGET_MS,
  MOVE_HISTORY_LIMIT,
  OPPONENT_FAMILIES,
  OpponentEngineError,
  PLAY_LEVEL_KEYS,
  describeReply,
  levelByKey,
  opponentCatalogue,
  resolveGame,
  selectOpponent,
} from "../../engine/opponent.js";

const GAME_STATUSES = [
  "in_play",
  "checkmate",
  "stalemate",
  "insufficient_material",
  "fifty_move",
] as const;

// ---------------------------------------------------------------------------
// GET /v1/play/opponents
// ---------------------------------------------------------------------------

const catalogueSchema = z.object({
  families: z.array(
    z.object({
      family: z.enum(OPPONENT_FAMILIES),
      available: z.boolean(),
      unavailableReason: z.enum(["not_configured", "not_permitted_here"]).nullable(),
      levels: z.array(
        z.object({
          // The same closed set the move request accepts, so a client can hand
          // a catalogue key straight back without widening it to a string.
          key: z.enum(PLAY_LEVEL_KEYS),
          nominalRating: z.int(),
          /** What this family actually plays the level at. */
          playsAt: z.int(),
          /** True when the family cannot reach the level and played its nearest. */
          clamped: z.boolean(),
        }),
      ),
    }),
  ),
});

const listOpponentsRoute: RouteDefinition<never, never, z.infer<typeof catalogueSchema>> = {
  method: "GET",
  path: "/v1/play/opponents",
  operationId: "listPlayOpponents",
  summary: "The opponents and strengths this deployment can actually play",
  description:
    "The server's level catalogue, per family. `available` is false when a family is not configured here; a client must not offer an unavailable family, and asking for one is refused rather than served by a different engine. `playsAt` is the rating the family really plays a level at and `clamped` says it could not reach the level — Stockfish's strength limiter stops at 1320, so the lower levels are its floor rather than their nominal rating.",
  kind: "read",
  auth: "required",
  envelope: "resource",
  successStatus: 200,
  dataSchema: catalogueSchema,
  etag: true,
  // The catalogue is a pure function of this process's configuration, so it
  // cannot change without a redeploy. It is deliberately not rate limited: the
  // limiter costs a round trip to Postgres and this route costs none.
  cacheControl: "private, max-age=60",
  async handler() {
    const families = opponentCatalogue().map((entry) => ({
      family: entry.family,
      available: entry.available,
      unavailableReason: entry.unavailableReason,
      levels: entry.levels.map((level) => ({
        key: level.key,
        nominalRating: level.nominalRating,
        playsAt: level.playsAt,
        clamped: level.clamped,
      })),
    }));
    return { data: { families } };
  },
};

// ---------------------------------------------------------------------------
// POST /v1/play/moves
// ---------------------------------------------------------------------------

/**
 * The request.
 *
 * `moves` are the UCI moves played from `fen`, and they are optional because
 * "play this position out from here" is a real entry point from the explorer.
 * When they are supplied they are replayed into the engine so repetition and
 * the fifty-move rule are visible to it. There is no field for search depth,
 * time or thread count, and there must not be: a search budget on the request
 * is a way to buy unbounded engine time from a signed-in account.
 */
const moveBodySchema = z
  .object({
    position: z
      .object({
        // Long enough for any legal FEN and far too short for a PGN.
        fen: z.string().min(10).max(120),
        moves: z
          .array(z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/))
          .max(MOVE_HISTORY_LIMIT)
          .default([]),
      })
      .strict(),
    opponent: z
      .object({
        family: z.enum(OPPONENT_FAMILIES),
        /** A key from `GET /v1/play/opponents`, never a rating of the client's own. */
        level: z.enum(PLAY_LEVEL_KEYS),
      })
      .strict(),
  })
  .strict();

const moveResultSchema = z.object({
  /** Null when the position is already over; then `position.status` says how. */
  reply: z.object({ uci: z.string(), san: z.string() }).nullable(),
  position: z.object({
    fen: z.string(),
    turn: z.enum(["white", "black"]),
    status: z.enum(GAME_STATUSES),
  }),
  opponent: z.object({
    family: z.enum(OPPONENT_FAMILIES),
    level: z.enum(PLAY_LEVEL_KEYS),
    nominalRating: z.int(),
    playsAt: z.int(),
    clamped: z.boolean(),
    /** The engine that answered, as it identified itself. Null when none did. */
    engine: z.string().nullable(),
  }),
});

const requestMoveRoute: RouteDefinition<
  never,
  z.infer<typeof moveBodySchema>,
  z.infer<typeof moveResultSchema>
> = {
  method: "POST",
  path: "/v1/play/moves",
  operationId: "requestOpponentMove",
  summary: "The opponent's reply in a game against the engine",
  description:
    "Validates the position and every supplied move server-side, then returns one bounded engine move. No game is stored: it lives in the client, and a game against the engine is never part of the player's archive or of any analysis. The reply carries no evaluation, and there is no depth, time or MultiPV parameter. A family the deployment cannot serve is refused rather than answered by a different engine.",
  kind: "command",
  auth: "required",
  idempotency: "key",
  envelope: "resource",
  successStatus: 200,
  bodySchema: moveBodySchema,
  dataSchema: moveResultSchema,
  rateLimits: [{ policy: POLICIES.playMove, source: "actor" }],
  // No `withActorContext`, and no actor is read from `auth` beyond the rate
  // limit's identity: this handler touches no tenant table, which is only true
  // because no game is persisted. Any future write here needs the actor binding
  // back, and the RLS policies would refuse an unbound connection anyway.
  async handler({ body }) {
    const resolved = resolveGame(body.position.fen, body.position.moves);
    if (!resolved.ok) {
      const { field, detail } = resolved.rejection;
      throw new ProblemError("VALIDATION_FAILED", {
        detail,
        errors: [{ path: `body.position.${field}`, code: "MALFORMED", message: detail }],
      });
    }
    // The enum guarantees the key is in the catalogue; the lookup is what turns
    // it into the level, and a null here would mean the two had drifted apart.
    const level = levelByKey(body.opponent.level);
    if (!level) throw new ProblemError("INTERNAL_ERROR");

    const selection = selectOpponent(body.opponent.family);
    if (!selection.ok) {
      // Truthful rather than optimistic, and never substituted. The client asked
      // for a specific opponent; answering with a different one would be a claim
      // about the move that is not true.
      throw new ProblemError("CONFLICT", { detail: selection.unavailable.detail });
    }
    const familyLevel = selection.adapter.levelFor(level);
    const game = resolved.game;

    if (game.status !== "in_play") {
      return {
        data: {
          reply: null,
          position: { fen: game.fen, turn: game.turn, status: game.status },
          opponent: {
            family: selection.adapter.family,
            level: level.key,
            nominalRating: level.nominalRating,
            playsAt: familyLevel.playsAt,
            clamped: familyLevel.clamped,
            engine: null,
          },
        },
      };
    }

    let reply;
    try {
      reply = await selection.adapter.reply({
        // The server's own rendering of the position, not the client's string.
        rootFen: game.rootFen,
        moves: body.position.moves,
        level,
        budgetMs: MOVE_BUDGET_MS,
      });
    } catch (error) {
      if (error instanceof OpponentEngineError) {
        // Retryable, and honestly so: a fresh process usually answers. The
        // detail is the adapter's own message, which names no path and no host.
        throw new ProblemError("PROVIDER_UNAVAILABLE", { detail: error.message });
      }
      throw error;
    }

    // The last check between an engine's output and a player's board. An engine
    // that answers with a move that is not legal here is broken or is answering
    // a different position, and either way the client must not be handed it.
    const described = describeReply(game.position, reply.uci);
    if (!described.ok) {
      throw new ProblemError("PROVIDER_UNAVAILABLE", {
        detail: "the engine did not return a legal move",
      });
    }

    return {
      data: {
        reply: { uci: described.uci, san: described.san },
        position: {
          fen: described.fen,
          turn: game.turn === "white" ? "black" : "white",
          status: described.status,
        },
        opponent: {
          family: selection.adapter.family,
          level: level.key,
          nominalRating: level.nominalRating,
          playsAt: reply.playsAt,
          clamped: reply.clamped,
          engine: reply.engine,
        },
      },
    };
  },
};

export const PLAY_ROUTES = [listOpponentsRoute, requestMoveRoute] as const;

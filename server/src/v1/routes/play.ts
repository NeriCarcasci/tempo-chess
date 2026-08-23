/**
 * `GET /v1/play/opponents` and `POST /v1/play/moves` — playing a game against
 * the engine, per plans/v1-api-contract.md §14.
 *
 * ## Nothing is persisted, and that is the design
 *
 * §14 also reserves `POST /play/sessions`, `POST /play/sessions/{id}/moves` and
 * `DELETE /play/sessions/{id}`. This ships the stateless half of that: the
 * client holds the game and the server answers one position at a time. No game
 * is stored. Stockfish leaves only the kernel's expiring idempotency record.
 * Maia-3 also leaves an anonymous, reusable position-policy inference plus the
 * workflow that produced it. Neither stores the game, result or move history,
 * and neither is historical chess evidence. Three reasons, in order of weight.
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
 * wire, so there is no field a caller could route into an evaluation.
 * Stockfish uses a handicapped few-hundred-millisecond search; Maia uses the
 * promoted human-policy model. Neither is comparable with anything
 * `POST /v1/positions/evaluations` returns, and the response is deliberately
 * not shaped like an evaluation.
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
 * weaker search, and asking for a weaker search is the entire point here. Maia
 * uses its separate continuation workflow; this route waits through that
 * workflow contract rather than turning a policy move into an evaluation.
 */

import { z } from "zod";
import { client } from "../../db/client.js";
import { ProblemError } from "../problem.js";
import type { RouteDefinition } from "../registry.js";
import { POLICIES } from "../rate-limit.js";
import { isContinuationRating } from "../../models/continuation-rating.js";
import {
  hasProductionMaia3,
  requestContinuationMove,
} from "../../models/continuation.js";
import {
  MOVE_BUDGET_MS,
  MOVE_HISTORY_LIMIT,
  OPPONENT_FAMILIES,
  OpponentEngineError,
  PLAY_LEVEL_KEYS,
  describeReply,
  levelByKey,
  maia3Level,
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
  // Maia availability follows the promoted model pointer; Stockfish follows
  // process configuration. The short private cache avoids querying that pointer
  // on every render without claiming it can only change on a redeploy.
  cacheControl: "private, max-age=60",
  async handler() {
    const maiaAvailable = await hasProductionMaia3(client);
    const families = opponentCatalogue(process.env, maiaAvailable).map((entry) => ({
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
    /** Stable for one bot turn so a completed Maia job samples once across retries. */
    turnKey: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
  })
  .strict();

const moveResultSchema = z.object({
  state: z.enum(["ready", "scheduled"]),
  workflowId: z.string().nullable(),
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
    "Validates the position and every supplied move server-side, then returns one bounded opponent move. Stockfish answers immediately; Maia can return a scheduled workflow before the completed move is cached. No game is stored: it lives in the client, and a game against the engine is never part of the player's archive or of any analysis. The reply carries no evaluation, and there is no depth, time or MultiPV parameter. A family the deployment cannot serve is refused rather than answered by a different engine.",
  kind: "command",
  auth: "required",
  idempotency: "key",
  envelope: "resource",
  successStatus: 200,
  bodySchema: moveBodySchema,
  dataSchema: moveResultSchema,
  rateLimits: [{ policy: POLICIES.playMove, source: "actor" }],
  // No game row is written. Maia's durable workflow still needs the authenticated
  // profile as its owner so only that player can watch it; the anonymous policy
  // cache remains reusable and contains no profile reference.
  async handler({ auth, body }) {
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
    const game = resolved.game;

    if (game.status !== "in_play") {
      let familyLevel = maia3Level(level);
      if (body.opponent.family === "stockfish") {
        const terminalSelection = selectOpponent("stockfish");
        if (!terminalSelection.ok) {
          throw new ProblemError("CONFLICT", { detail: terminalSelection.unavailable.detail });
        }
        familyLevel = terminalSelection.adapter.levelFor(level);
      }
      return {
        data: {
          state: "ready",
          workflowId: null,
          reply: null,
          position: { fen: game.fen, turn: game.turn, status: game.status },
          opponent: {
            family: body.opponent.family,
            level: level.key,
            nominalRating: level.nominalRating,
            playsAt: familyLevel.playsAt,
            clamped: familyLevel.clamped,
            engine: null,
          },
        },
      };
    }

    if (body.opponent.family === "maia") {
      if (!isContinuationRating(level.nominalRating)) throw new ProblemError("INTERNAL_ERROR");
      const outcome = await requestContinuationMove(client, {
        fen: game.fen,
        rating: level.nominalRating,
        turnKey: body.turnKey,
        ownerProfileId: auth!.profileId,
      });
      if (outcome.state === "unavailable") {
        throw new ProblemError("CONFLICT", {
          detail: "No calibrated Maia-3 model is currently promoted.",
        });
      }
      if (outcome.state === "invalid_position" || outcome.state === "terminal_position") {
        throw new ProblemError("INTERNAL_ERROR");
      }
      const familyLevel = maia3Level(level);
      if (outcome.state === "scheduled") {
        return {
          status: 202,
          data: {
            state: "scheduled",
            workflowId: outcome.workflowId,
            reply: null,
            position: { fen: game.fen, turn: game.turn, status: game.status },
            opponent: {
              family: "maia",
              level: level.key,
              nominalRating: level.nominalRating,
              playsAt: familyLevel.playsAt,
              clamped: false,
              engine: null,
            },
          },
          resource: { type: "workflow", id: outcome.workflowId },
        };
      }
      const described = describeReply(game.position, outcome.moveUci);
      if (!described.ok) {
        throw new ProblemError("PROVIDER_UNAVAILABLE", {
          detail: "Maia-3 did not return a legal move",
        });
      }
      return {
        status: 200,
        data: {
          state: "ready",
          workflowId: null,
          reply: { uci: described.uci, san: described.san },
          position: {
            fen: described.fen,
            turn: game.turn === "white" ? "black" : "white",
            status: described.status,
          },
          opponent: {
            family: "maia",
            level: level.key,
            nominalRating: level.nominalRating,
            playsAt: familyLevel.playsAt,
            clamped: false,
            engine: "Maia-3 5M",
          },
        },
      };
    }

    const selection = selectOpponent(body.opponent.family);
    if (!selection.ok) {
      // Truthful rather than optimistic, and never substituted. The client asked
      // for a specific opponent; answering with a different one would be a claim
      // about the move that is not true.
      throw new ProblemError("CONFLICT", { detail: selection.unavailable.detail });
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
        state: "ready",
        workflowId: null,
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

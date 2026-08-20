/**
 * The bounded interactive evaluation of API contract §14.
 *
 * "Interactive analysis is not the historical-analysis pipeline." It shares the
 * engine, the calibration and the cache, and nothing else: no run, no
 * publication, no transition assessment, and no claim about a player. A number
 * a user asked for about a position they pasted is not evidence about their
 * chess, and the schema keeps them apart by keeping this out of
 * `analysis.transition_assessments` entirely.
 *
 * Three things are deliberately not parameters. The search profile, because §14
 * says "no arbitrary depth/threads/MultiPV parameters" and the way to keep that
 * true is to have no field that could carry one. The engine version, because it
 * comes from the same promoted pointer the game pipeline uses — a user's ad-hoc
 * evaluation and their game review must not be able to disagree about which
 * engine Forma runs. And the position identity, because the FEN is validated
 * and interned server-side into a core position, so what travels through the
 * work ledger is a row id and a halfmove clock rather than a board.
 */

import { Chess } from "chessops/chess";
import { makeFen, parseFen } from "chessops/fen";
import type { Sql } from "postgres";
import { DuplicateWorkError, insertWorkflow } from "../ops/ledger.js";
import { currentRecipeFor } from "../analysis/validation.js";
import { coreKey, coreKeyHash } from "../positions/canonical.js";
import { cacheKeyFor, findCachedEvaluation, type StoredEvaluation } from "./evaluations.js";
import { readEngineRoles } from "./recipe.js";
import { resolveProfile } from "./profiles.js";
import { EVALUATE_POSITION_TASK } from "./worker.js";

/** Why a purpose is declared: it is a usage label, never a search parameter. */
export const EVALUATION_PURPOSES = ["explore", "review_position", "practice_check"] as const;
export type EvaluationPurpose = (typeof EVALUATION_PURPOSES)[number];

export interface InteractiveRequest {
  fen: string;
  purpose: EvaluationPurpose;
  ownerProfileId: string;
}

export type InteractiveOutcome =
  | { state: "ready"; evaluation: StoredEvaluation; halfmoveClock: number }
  | { state: "scheduled"; workflowId: string }
  | { state: "invalid_position"; detail: string }
  | { state: "unavailable"; reason: "no_promoted_recipe" };

export interface NormalizedPosition {
  corePositionId: string;
  corePositionKeyHash: string;
  coreKey: string;
  halfmoveClock: number;
  fen: string;
}

/**
 * Validate a client FEN and intern its core position.
 *
 * Standard chess only: `Chess.fromSetup` refuses an illegal position, and a
 * variant setup has no core key in E09's sense. The interned row is anonymous —
 * a board arrangement with no owner — which is why the API role may write it at
 * all; without it there would be no durable handle for the request and the
 * board itself would have to travel through the ledger.
 */
export async function internPosition(sql: Sql, fen: string): Promise<NormalizedPosition | string> {
  const setup = parseFen(fen.trim());
  if (setup.isErr) return "that is not a readable FEN";
  const position = Chess.fromSetup(setup.value);
  if (position.isErr) return "that is not a legal standard chess position";

  const key = coreKey(position.value);
  const hash = coreKeyHash(key);
  const [board, turn, castling, enPassant] = key.split(" ");
  const canonical = makeFen(position.value.toSetup());
  const halfmoveClock = Number(canonical.split(" ")[4]);

  await sql`
    insert into chess.core_positions (core_key_hash, core_key, board, turn, castling, en_passant)
    values (${hash}, ${key}, ${board!}, ${turn!}, ${castling!}, ${enPassant!})
    on conflict (core_key_hash) do nothing
  `;
  const [row] = await sql<{ id: string }[]>`
    select id from chess.core_positions where core_key_hash = ${hash}
  `;
  return {
    corePositionId: String(row!.id),
    corePositionKeyHash: hash,
    coreKey: key,
    halfmoveClock,
    // The clock is kept; the fullmove number is not, because it cannot change
    // an evaluation and keeping it would split one cache entry into many.
    fen: `${key} ${halfmoveClock} 1`,
  };
}

/**
 * Answer from the cache, or schedule one bounded search.
 *
 * `rule50` scope, never `core`: the user's FEN carried a halfmove clock, and
 * discarding it would answer a different question than the one asked whenever
 * the position is near a fifty-move draw.
 */
export async function evaluatePositionRequest(
  sql: Sql,
  request: InteractiveRequest,
): Promise<InteractiveOutcome> {
  const normalized = await internPosition(sql, request.fen);
  if (typeof normalized === "string") return { state: "invalid_position", detail: normalized };

  const promoted = await currentRecipeFor(sql, "deep_game_analysis");
  if (!promoted) return { state: "unavailable", reason: "no_promoted_recipe" };
  const roles = await readEngineRoles(sql, promoted.recipeVersionId);
  const profile = await resolveProfile(sql, {
    engineVersionId: roles.engineVersionId,
    calibrationVersionId: roles.calibrationVersionId,
    profile: "interactive",
  });

  const cacheKey = cacheKeyFor({
    corePositionId: normalized.corePositionId,
    corePositionKeyHash: normalized.corePositionKeyHash,
    scope: "rule50",
    fen: normalized.fen,
    halfmoveClock: normalized.halfmoveClock,
    history: null,
    occurrence: null,
    profile,
  });
  const cached = await findCachedEvaluation(sql, cacheKey);
  if (cached) {
    return { state: "ready", evaluation: cached, halfmoveClock: normalized.halfmoveClock };
  }

  try {
    const workflow = await sql.begin(async (tx) =>
      insertWorkflow(tx as unknown as Sql, {
        kind: "position_evaluation",
        ownerProfileId: request.ownerProfileId,
        resource: { type: "core_position", id: normalized.corePositionId },
        items: [
          {
            taskType: EVALUATE_POSITION_TASK,
            resourceClass: "cpu_engine",
            queue: "stockfish-screen",
            // The cache key: two users asking about the same position under the
            // same profile are one piece of work, and the second one joins the
            // first rather than paying for it again.
            idempotencyKey: `e12:${EVALUATE_POSITION_TASK}:${cacheKey}`,
            inputRef: `corePosition:${normalized.corePositionId}`,
            payload: {
              corePositionId: normalized.corePositionId,
              halfmoveClock: normalized.halfmoveClock,
              engineVersionId: roles.engineVersionId,
              calibrationVersionId: roles.calibrationVersionId,
            },
            timeoutSeconds: 120,
          },
        ],
      }),
    );
    return { state: "scheduled", workflowId: workflow.workflowId };
  } catch (error) {
    // Someone is already asking. Returning their workflow is the whole point of
    // keying the item on the cache key: the second request waits for the first
    // search instead of starting a second identical one.
    if (error instanceof DuplicateWorkError && error.existingWorkflowId) {
      return { state: "scheduled", workflowId: error.existingWorkflowId };
    }
    throw error;
  }
}

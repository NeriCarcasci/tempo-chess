import type { Sql } from "postgres";

import { jsonParam } from "../db/json.js";
import { internPosition, type NormalizedPosition } from "../engine/interactive.js";
import { DuplicateWorkError, insertWorkflow } from "../ops/ledger.js";
import type { ContinuationRating } from "./continuation-rating.js";
import { Maia3Engine } from "./maia3.js";
import {
  inferenceCacheKey,
  inputContractHash,
  stablePolicyMove,
  type InferenceContext,
  type PolicyDistribution,
} from "./policy.js";

export const CONTINUATION_TASK = "maia3_generate_continuation_policy";
export const CONTINUATION_RETAINED_MOVE_LIMIT = 218;

export const CONTINUATION_CONTRACT = {
  name: "maia3_continuation_context.v1",
  requires: ["actorRating"] as const,
};
export const CONTINUATION_CONTRACT_HASH = inputContractHash(CONTINUATION_CONTRACT);

interface ProductionModel {
  id: string;
  contentHash: string;
}

export type ContinuationOutcome =
  | {
      state: "ready";
      moveUci: string;
      rating: ContinuationRating;
      candidates: readonly { uci: string; probability: number }[];
    }
  | { state: "scheduled"; workflowId: string }
  | { state: "invalid_position"; detail: string }
  | { state: "terminal_position"; detail: string }
  | { state: "unavailable"; reason: "no_promoted_maia3" };

export interface ContinuationRequest {
  fen: string;
  rating: ContinuationRating;
  turnKey: string;
  ownerProfileId: string;
}

/** Latest Maia-3 human-policy component whose latest lifecycle state is production. */
async function productionMaia3(sql: Sql): Promise<ProductionModel | null> {
  const [row] = await sql<{ id: string; content_hash: string }[]>`
    select cv.id, cv.content_hash
    from analysis.component_versions cv
    join analysis.model_profiles p on p.component_version_id = cv.id
    join lateral (
      select e.to_state from analysis.component_lifecycle_events e
      where e.component_version_id = cv.id order by e.id desc limit 1
    ) lifecycle on true
    where p.role = 'human_policy'
      and p.licence_review_status = 'cleared'
      and lifecycle.to_state = 'production'
      and coalesce(
        cv.model_identity ->> 'family',
        ((cv.model_identity #>> '{}')::jsonb) ->> 'family'
      ) = 'maia3'
    order by cv.created_at desc, cv.id desc
    limit 1
  `;
  return row ? { id: row.id, contentHash: row.content_hash } : null;
}

/** Whether the API may truthfully advertise Maia-3 as a playable family. */
export async function hasProductionMaia3(sql: Sql): Promise<boolean> {
  return (await productionMaia3(sql)) !== null;
}

function contextFor(rating: number): InferenceContext {
  return {
    provider: null,
    actorRating: rating,
    opponentRating: rating,
    speed: null,
    clockBucket: null,
    hasMoveHistory: false,
  };
}

export async function readContinuationPolicy(
  sql: Sql,
  modelComponentVersionId: string,
  cacheKey: string,
): Promise<PolicyDistribution | null> {
  const [inference] = await sql<{ id: string; retained: string; entropy: string }[]>`
    select id, retained_probability_mass as retained, policy_entropy_bits as entropy
    from analysis.model_inferences
    where model_component_version_id = ${modelComponentVersionId} and cache_key = ${cacheKey}
  `;
  if (!inference) return null;
  const rows = await sql<{ rank: number; uci: string; probability: string }[]>`
    select rank, uci, probability from analysis.model_move_probabilities
    where model_inference_id = ${inference.id} order by rank
  `;
  if (rows.length === 0) return null;
  const retainedMass = Number(inference.retained);
  const unretainedMass = Math.min(1, Math.max(0, 1 - retainedMass));
  return {
    moves: rows.map((row) => ({ rank: row.rank, uci: row.uci, probability: Number(row.probability) })),
    retainedMass,
    unretainedMass,
    entropyBits: Number(inference.entropy),
    entropyIsLowerBound: unretainedMass > 0,
  };
}

/**
 * Everything a caller needs to reuse one continuation inference.
 *
 * The play route asks for a move and gets one. A game rating asks a different
 * question of the same cache: is this `(position, rating)` already inferred,
 * and if not, what does the work item that would infer it look like? Both
 * answers have to come from here rather than from a second implementation,
 * because the cache key is what makes the two features share work at all. A
 * rating that computed its own key would miss every row play had written and
 * quietly double the platform's Maia bill.
 *
 * Null means the position cannot be asked about: no promoted model, or a FEN
 * that is not a legal position.
 */
export interface ContinuationLookup {
  modelComponentVersionId: string;
  cacheKey: string;
  corePositionId: string;
  halfmoveClock: number;
  /** The cached distribution, or null when nothing has inferred this yet. */
  policy: PolicyDistribution | null;
}

export async function lookupContinuation(
  sql: Sql,
  fen: string,
  rating: number,
): Promise<ContinuationLookup | null> {
  const normalized = await internPosition(sql, fen);
  if (typeof normalized === "string") return null;
  const model = await productionMaia3(sql);
  if (!model) return null;

  const cacheKey = inferenceCacheKey({
    modelComponentVersionId: model.id,
    modelContentHash: model.contentHash,
    corePositionKey: normalized.coreKey,
    outputKind: "human_policy",
    context: contextFor(rating),
    retainedMoveLimit: CONTINUATION_RETAINED_MOVE_LIMIT,
  });

  return {
    modelComponentVersionId: model.id,
    cacheKey,
    corePositionId: normalized.corePositionId,
    halfmoveClock: normalized.halfmoveClock,
    policy: await readContinuationPolicy(sql, model.id, cacheKey),
  };
}

/**
 * The same lookup for many positions at once.
 *
 * `lookupContinuation` costs about five round trips, which is fine for one move
 * and ruinous for a game rating: a few hundred pairs became more than a
 * thousand queries and blew the API's request timeout before it could schedule
 * anything. The work here is identical, arranged so it is paid once.
 *
 * The promoted model is read once rather than per pair. Each distinct position
 * is interned once rather than once per rung, which is a factor of nine on its
 * own. And the cache is asked one question about every key instead of one
 * question each.
 */
export interface ContinuationAsk {
  fen: string;
  rating: number;
}

export interface BatchedLookup extends ContinuationAsk {
  modelComponentVersionId: string;
  cacheKey: string;
  corePositionId: string;
  halfmoveClock: number;
  /** True when this pair has already been inferred and needs no work item. */
  cached: boolean;
}

export async function lookupContinuations(
  sql: Sql,
  asks: readonly ContinuationAsk[],
): Promise<BatchedLookup[]> {
  if (asks.length === 0) return [];
  const model = await productionMaia3(sql);
  if (!model) return [];

  const positions = new Map<string, NormalizedPosition>();
  for (const fen of new Set(asks.map((ask) => ask.fen))) {
    const normalized = await internPosition(sql, fen);
    if (typeof normalized === "string") continue;
    positions.set(fen, normalized);
  }

  const resolved = asks.flatMap((ask) => {
    const normalized = positions.get(ask.fen);
    if (!normalized) return [];
    return [
      {
        ...ask,
        modelComponentVersionId: model.id,
        corePositionId: normalized.corePositionId,
        halfmoveClock: normalized.halfmoveClock,
        cacheKey: inferenceCacheKey({
          modelComponentVersionId: model.id,
          modelContentHash: model.contentHash,
          corePositionKey: normalized.coreKey,
          outputKind: "human_policy",
          context: contextFor(ask.rating),
          retainedMoveLimit: CONTINUATION_RETAINED_MOVE_LIMIT,
        }),
        cached: false,
      },
    ];
  });

  const keys = resolved.map((entry) => entry.cacheKey);
  const rows = await sql<{ cache_key: string }[]>`
    select cache_key from analysis.model_inferences
    where model_component_version_id = ${model.id} and cache_key = any(${keys})`;
  const have = new Set(rows.map((row) => row.cache_key));
  return resolved.map((entry) => ({ ...entry, cached: have.has(entry.cacheKey) }));
}

export async function requestContinuationMove(
  sql: Sql,
  request: ContinuationRequest,
): Promise<ContinuationOutcome> {
  const normalized = await internPosition(sql, request.fen);
  if (typeof normalized === "string") return { state: "invalid_position", detail: normalized };

  const { Chess } = await import("chessops/chess");
  const { parseFen } = await import("chessops/fen");
  const setup = parseFen(normalized.fen);
  const board = setup.isOk ? Chess.fromSetup(setup.value) : null;
  if (!board || board.isErr) return { state: "invalid_position", detail: "that is not a legal position" };
  if (board.value.isEnd()) {
    return { state: "terminal_position", detail: "that position has no move to continue with" };
  }

  const model = await productionMaia3(sql);
  if (!model) return { state: "unavailable", reason: "no_promoted_maia3" };
  const context = contextFor(request.rating);
  const cacheKey = inferenceCacheKey({
    modelComponentVersionId: model.id,
    modelContentHash: model.contentHash,
    corePositionKey: normalized.coreKey,
    outputKind: "human_policy",
    context,
    retainedMoveLimit: CONTINUATION_RETAINED_MOVE_LIMIT,
  });
  const policy = await readContinuationPolicy(sql, model.id, cacheKey);
  if (policy) {
    return {
      state: "ready",
      moveUci: stablePolicyMove(policy, `${cacheKey}:${request.turnKey}`),
      rating: request.rating,
      candidates: policy.moves.slice(0, 5).map(({ uci, probability }) => ({ uci, probability })),
    };
  }

  try {
    const workflow = await sql.begin(async (tx) =>
      insertWorkflow(tx as unknown as Sql, {
        kind: "position_continuation",
        ownerProfileId: request.ownerProfileId,
        resource: { type: "core_position", id: normalized.corePositionId },
        items: [
          {
            taskType: CONTINUATION_TASK,
            resourceClass: "cpu_interactive_model",
            queue: "maia-play",
            idempotencyKey: `maia3:${CONTINUATION_TASK}:${cacheKey}`,
            inputRef: `corePosition:${normalized.corePositionId}`,
            payload: {
              corePositionId: normalized.corePositionId,
              halfmoveClock: normalized.halfmoveClock,
              rating: request.rating,
              modelComponentVersionId: model.id,
              cacheKey,
            },
            timeoutSeconds: 90,
          },
        ],
      }),
    );
    return { state: "scheduled", workflowId: workflow.workflowId };
  } catch (error) {
    if (error instanceof DuplicateWorkError && error.existingWorkflowId) {
      return { state: "scheduled", workflowId: error.existingWorkflowId };
    }
    throw error;
  }
}

export async function storeContinuationPolicy(
  sql: Sql,
  input: {
    modelComponentVersionId: string;
    corePositionId: string;
    rating: number;
    cacheKey: string;
    policy: PolicyDistribution;
    latencyMs: number;
  },
): Promise<string> {
  return sql.begin(async (tx) => {
    const inserted = await tx<{ id: string }[]>`
      insert into analysis.model_inferences (
        model_component_version_id, core_position_id, output_kind,
        context_actor_rating, context_opponent_rating, context_has_move_history,
        input_contract_hash, cache_key, retained_probability_mass,
        retained_move_count, policy_entropy_bits, raw_payload
      ) values (
        ${input.modelComponentVersionId}, ${input.corePositionId}, 'human_policy',
        ${input.rating}, ${input.rating}, false, ${CONTINUATION_CONTRACT_HASH}, ${input.cacheKey},
        ${input.policy.retainedMass}, ${input.policy.moves.length}, ${input.policy.entropyBits},
        ${jsonParam({ family: "maia3", model: "5m", rating: input.rating, latencyMs: input.latencyMs })}::text::jsonb
      )
      on conflict (model_component_version_id, cache_key) do nothing
      returning id
    `;
    let inferenceId = inserted[0]?.id;
    if (!inferenceId) {
      const [existing] = await tx<{ id: string }[]>`
        select id from analysis.model_inferences
        where model_component_version_id = ${input.modelComponentVersionId}
          and cache_key = ${input.cacheKey}
      `;
      if (!existing) throw new Error("continuation inference conflicted but could not be read");
      return existing.id;
    }
    for (const move of input.policy.moves) {
      await tx`
        insert into analysis.model_move_probabilities (model_inference_id, rank, uci, probability)
        values (${inferenceId}, ${move.rank}, ${move.uci}, ${move.probability})
      `;
    }
    return inferenceId;
  });
}

export interface ContinuationPolicyEngine {
  inferPolicy(fen: string, rating: number): ReturnType<Maia3Engine["inferPolicy"]>;
}

let continuationEngine: ContinuationPolicyEngine | null | undefined;

export function resolveContinuationEngine(): ContinuationPolicyEngine | null {
  if (continuationEngine !== undefined) return continuationEngine;
  const pythonPath = process.env.MAIA3_PYTHON_PATH;
  const bridgePath = process.env.MAIA3_BRIDGE_PATH;
  const checkpointPath = process.env.MAIA3_CHECKPOINT_PATH;
  continuationEngine = pythonPath && bridgePath && checkpointPath
    ? new Maia3Engine({
        pythonPath,
        bridgePath,
        checkpointPath,
        retainedMoveLimit: CONTINUATION_RETAINED_MOVE_LIMIT,
      })
    : null;
  return continuationEngine;
}

export function setContinuationEngineForTests(
  engine: ContinuationPolicyEngine | null | undefined,
): void {
  continuationEngine = engine;
}

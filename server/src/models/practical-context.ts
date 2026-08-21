import type { Sql } from "postgres";

import type { Queryable } from "../db/queryable.js";
import { isAcceptableLoss } from "../engine/contract.js";
import {
  RETAINED_MOVE_LIMIT,
  type Provider,
  type Speed,
  type UnavailableReason,
} from "./contract.js";
import { buildPracticalContext, type PracticalContext } from "./practical.js";
import {
  contextSatisfies,
  inferenceCacheKey,
  inputContractHash,
  isProvider,
  isSpeed,
  normalizePolicy,
  type InferenceContext,
  type PolicyDistribution,
} from "./policy.js";
import { lookupCalibrationSlice, resolvePromotedHumanModel } from "./store.js";
import { jsonParam } from "../db/json.js";

/**
 * Compute practical counterplay for one analysis run.
 *
 * The position under discussion is the one the subject's move created, and the
 * human being modelled is the opponent who has to reply to it. Every assessment
 * in the run gets a row: the ones that could be answered get the vector, and
 * the ones that could not get a reason. There is no third outcome, because a
 * missing row is the one a reader silently interprets as "no pressure".
 */

/** The declared context contract this epic's model is asked under. */
export const HUMAN_POLICY_CONTRACT = {
  name: "human_policy_context.v1",
  requires: ["provider", "speed", "actorRating"] as const,
};

export const HUMAN_POLICY_CONTRACT_HASH = inputContractHash({
  name: HUMAN_POLICY_CONTRACT.name,
  requires: HUMAN_POLICY_CONTRACT.requires,
});

/** What a policy engine has to offer. Narrow so the gates can supply a fixture. */
export interface HumanPolicyEngine {
  inferPolicy(
    fen: string,
    rating: number,
  ): Promise<{
    policy: PolicyDistribution;
    latencyMs: number;
    networkBand?: number;
    modelRating?: number;
  }>;
}

export interface PracticalContextSummary {
  written: number;
  available: number;
  unavailable: Record<string, number>;
  inferencesComputed: number;
  inferencesReused: number;
}

interface AssessmentRow {
  id: string;
  from_ply: number;
  actor_color: "white" | "black";
  after_evaluation_id: string;
  deep_evaluation_id: string | null;
}

/**
 * Write the run's practical context.
 *
 * Idempotent by the `(run, assessment)` unique key: a retried step lands on the
 * rows it already wrote instead of doubling them, and the immutability trigger
 * means the retry cannot restate an earlier answer with a newer model.
 */
export async function computePracticalContext(
  sql: Sql,
  engine: HumanPolicyEngine | null,
  input: {
    runId: string;
    materializationRunId: string;
    subjectGameId: string;
    modelContentHash: string;
  },
): Promise<PracticalContextSummary> {
  const summary: PracticalContextSummary = {
    written: 0,
    available: 0,
    unavailable: {},
    inferencesComputed: 0,
    inferencesReused: 0,
  };

  const assessments = await sql<AssessmentRow[]>`
    select id, from_ply, actor_color, after_evaluation_id, deep_evaluation_id
    from analysis.transition_assessments
    where analysis_run_id = ${input.runId}
    order by from_ply
  `;
  if (assessments.length === 0) return summary;

  const promotedModelId = await resolvePromotedHumanModel(sql);
  const game = await readGameContext(sql, input.subjectGameId);

  for (const assessment of assessments) {
    const { decision, inferenceId } = await decideOne(sql, engine, {
      ...input,
      promotedModelId,
      game,
      assessment,
      summary,
    });
    await writeRow(sql, input.runId, assessment.id, decision, inferenceId);
    summary.written += 1;
    if (decision.status === "available") summary.available += 1;
    else summary.unavailable[decision.reason] = (summary.unavailable[decision.reason] ?? 0) + 1;
  }

  return summary;
}

interface GameContext {
  provider: Provider | null;
  speed: Speed | null;
  ratings: { white: number | null; black: number | null };
}

async function readGameContext(sql: Queryable, subjectGameId: string): Promise<GameContext> {
  const [row] = await sql<{ slug: string; speed: string | null; revision_id: string }[]>`
    select p.slug, r.speed, r.id as revision_id
    from chess.subject_games sg
    join chess.provider_games pg on pg.id = sg.provider_game_id
    join app.providers p on p.id = pg.provider_id
    join chess.game_replay_revisions r on r.id = sg.latest_replay_revision_id
    where sg.id = ${subjectGameId}
  `;
  if (!row) return { provider: null, speed: null, ratings: { white: null, black: null } };

  const participants = await sql<{ color: "white" | "black"; rating: number | null }[]>`
    select color, rating from chess.game_revision_participants
    where replay_revision_id = ${row.revision_id}
  `;
  const ratings = { white: null as number | null, black: null as number | null };
  for (const participant of participants) ratings[participant.color] = participant.rating;

  return {
    provider: isProvider(row.slug) ? row.slug : null,
    speed: row.speed !== null && isSpeed(row.speed) ? row.speed : null,
    ratings,
  };
}

async function decideOne(
  sql: Sql,
  engine: HumanPolicyEngine | null,
  input: {
    runId: string;
    materializationRunId: string;
    modelContentHash: string;
    promotedModelId: string | null;
    game: GameContext;
    assessment: AssessmentRow;
    summary: PracticalContextSummary;
  },
): Promise<{ decision: PracticalContext; inferenceId: string | null }> {
  const { assessment, game } = input;
  // The opponent is the side that has to answer the move just played.
  const opponentColor = assessment.actor_color === "white" ? "black" : "white";
  const context: InferenceContext = {
    provider: game.provider,
    actorRating: game.ratings[opponentColor],
    opponentRating: game.ratings[assessment.actor_color],
    speed: game.speed,
    clockBucket: null,
    hasMoveHistory: false,
  };

  if (input.promotedModelId === null) {
    return refuse("no_promoted_model");
  }
  const complete = contextSatisfies(context, HUMAN_POLICY_CONTRACT);
  if (!complete.complete) return refuse("context_incomplete");

  const slice = await lookupCalibrationSlice(sql, {
    modelComponentVersionId: input.promotedModelId,
    provider: context.provider!,
    speed: context.speed!,
    rating: context.actorRating!,
  });

  // The objective evidence comes before the model runs: an inference on a
  // position whose adequate reply set is unknown is work nobody can use.
  const replies = await readAdequateReplies(sql, assessment);
  if (replies === null) {
    return refuse("objective_candidates_missing");
  }

  // Ask for the slice before spending an inference on it. A position in an
  // uncalibrated band is unavailable whatever the model would have said, and
  // running the model anyway would only produce a number nobody may quote.
  if (slice === undefined || !slice.supported || slice.modelComponentVersionId !== input.promotedModelId) {
    return {
      decision: buildPracticalContext({
        promotedModelComponentVersionId: input.promotedModelId,
        slice,
        context,
        requiredContextFields: HUMAN_POLICY_CONTRACT.requires,
        adequateReplies: replies.adequate,
        bestReplyUci: replies.best,
        policy: null,
      }),
      inferenceId: null,
    };
  }

  const fen = await readAfterFen(sql, input.materializationRunId, assessment.from_ply);
  if (fen === null) return refuse("objective_candidates_missing");

  const corePositionKey = fen.coreKey;
  const cacheKey = inferenceCacheKey({
    modelComponentVersionId: input.promotedModelId,
    modelContentHash: input.modelContentHash,
    corePositionKey,
    outputKind: "human_policy",
    context,
    retainedMoveLimit: RETAINED_MOVE_LIMIT,
  });

  let inferenceId = await findInference(sql, input.promotedModelId, cacheKey);
  let policy: PolicyDistribution | null = null;

  if (inferenceId !== null) {
    input.summary.inferencesReused += 1;
    policy = await readInferencePolicy(sql, inferenceId);
  } else if (engine === null) {
    return refuse("inference_failed");
  } else {
    try {
      const inference = await engine.inferPolicy(fen.fen, context.actorRating!);
      policy = inference.policy;
      inferenceId = await storeInference(sql, {
        modelComponentVersionId: input.promotedModelId,
        corePositionId: fen.corePositionId,
        occurrenceRunId: input.materializationRunId,
        occurrencePly: assessment.from_ply + 1,
        context,
        cacheKey,
        policy: inference.policy,
        networkBand: inference.networkBand ?? null,
        modelRating: inference.modelRating ?? null,
      });
      input.summary.inferencesComputed += 1;
    } catch {
      return refuse("inference_failed");
    }
  }

  if (policy === null || inferenceId === null) {
    return refuse("inference_failed");
  }

  await sql`
    insert into analysis.run_model_inference_uses (analysis_run_id, model_inference_id)
    values (${input.runId}, ${inferenceId})
    on conflict do nothing
  `;

  return {
    decision: buildPracticalContext({
      promotedModelComponentVersionId: input.promotedModelId,
      slice,
      context,
      requiredContextFields: HUMAN_POLICY_CONTRACT.requires,
      adequateReplies: replies.adequate,
      bestReplyUci: replies.best,
      policy,
    }),
    inferenceId,
  };
}

function refuse(reason: UnavailableReason): { decision: PracticalContext; inferenceId: null } {
  return { decision: { status: "unavailable", reason }, inferenceId: null };
}

/**
 * The adequate replies to the position the move created.
 *
 * Null when the search that produced the after-position kept one line: a
 * one-line search never looked at an alternative, so "which replies were
 * adequate" has no answer, and a set of one invented from the best move would
 * report every position as maximally forcing.
 */
async function readAdequateReplies(
  sql: Queryable,
  assessment: AssessmentRow,
): Promise<{ adequate: string[]; best: string } | null> {
  const evaluationId = assessment.deep_evaluation_id ?? assessment.after_evaluation_id;
  const candidates = await sql<{ uci: string; expected_score: string; rank: number }[]>`
    select uci, expected_score, rank from analysis.evaluation_candidates
    where position_evaluation_id = ${evaluationId}
    order by rank
  `;
  if (candidates.length < 2) return null;

  // expected_score is stored from White's perspective; the mover here is
  // whoever is to move in the after-position, which is the opponent.
  const moverIsWhite = assessment.actor_color === "black";
  const scored = candidates.map((candidate) => ({
    uci: candidate.uci,
    score: moverIsWhite ? Number(candidate.expected_score) : 1 - Number(candidate.expected_score),
  }));
  const best = scored.reduce((a, b) => (b.score > a.score ? b : a));
  return {
    adequate: scored.filter((c) => isAcceptableLoss(best.score - c.score)).map((c) => c.uci),
    best: best.uci,
  };
}

async function readAfterFen(
  sql: Queryable,
  materializationRunId: string,
  fromPly: number,
): Promise<{ fen: string; corePositionId: string; coreKey: string } | null> {
  const [row] = await sql<{ fen: string; core_position_id: string; core_key: string }[]>`
    select o.fen, o.core_position_id, cp.core_key
    from chess.position_occurrences o
    join chess.core_positions cp on cp.id = o.core_position_id
    where o.run_id = ${materializationRunId} and o.ply = ${fromPly + 1}
  `;
  if (!row) return null;
  return { fen: row.fen, corePositionId: row.core_position_id, coreKey: row.core_key };
}

async function findInference(
  sql: Queryable,
  modelComponentVersionId: string,
  cacheKey: string,
): Promise<string | null> {
  const [row] = await sql<{ id: string }[]>`
    select id from analysis.model_inferences
    where model_component_version_id = ${modelComponentVersionId} and cache_key = ${cacheKey}
  `;
  return row?.id ?? null;
}

async function readInferencePolicy(
  sql: Queryable,
  inferenceId: string,
): Promise<PolicyDistribution | null> {
  const moves = await sql<{ rank: number; uci: string; probability: string }[]>`
    select rank, uci, probability from analysis.model_move_probabilities
    where model_inference_id = ${inferenceId} order by rank
  `;
  if (moves.length === 0) return null;
  const [inference] = await sql<{ retained: string; entropy: string }[]>`
    select retained_probability_mass as retained, policy_entropy_bits as entropy
    from analysis.model_inferences where id = ${inferenceId}
  `;
  if (!inference) return null;
  const retainedMass = Number(inference.retained);
  const unretainedMass = Math.min(1, Math.max(0, 1 - retainedMass));
  return {
    moves: moves.map((move) => ({
      rank: move.rank,
      uci: move.uci,
      probability: Number(move.probability),
    })),
    retainedMass,
    unretainedMass,
    entropyBits: Number(inference.entropy),
    entropyIsLowerBound: unretainedMass > 0,
  };
}

async function storeInference(
  sql: Sql,
  input: {
    modelComponentVersionId: string;
    corePositionId: string;
    occurrenceRunId: string;
    occurrencePly: number;
    context: InferenceContext;
    cacheKey: string;
    policy: PolicyDistribution;
    networkBand: number | null;
    modelRating: number | null;
  },
): Promise<string> {
  return sql.begin(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      insert into analysis.model_inferences (
        model_component_version_id, core_position_id, occurrence_run_id, occurrence_ply,
        output_kind, context_provider, context_actor_rating, context_opponent_rating,
        context_speed, context_has_move_history, input_contract_hash, cache_key,
        retained_probability_mass, retained_move_count, policy_entropy_bits, raw_payload
      ) values (
        ${input.modelComponentVersionId}, ${input.corePositionId}, ${input.occurrenceRunId},
        ${input.occurrencePly}, 'human_policy', ${input.context.provider},
        ${input.context.actorRating}, ${input.context.opponentRating}, ${input.context.speed},
        ${input.context.hasMoveHistory}, ${HUMAN_POLICY_CONTRACT_HASH}, ${input.cacheKey},
        ${input.policy.retainedMass}, ${input.policy.moves.length}, ${input.policy.entropyBits},
        ${jsonParam({ networkBand: input.networkBand, modelRating: input.modelRating })}::jsonb
      )
      returning id
    `;
    for (const move of input.policy.moves) {
      await tx`
        insert into analysis.model_move_probabilities (model_inference_id, rank, uci, probability)
        values (${row!.id}, ${move.rank}, ${move.uci}, ${move.probability})
      `;
    }
    return row!.id;
  });
}

async function writeRow(
  sql: Queryable,
  runId: string,
  assessmentId: string,
  decision: PracticalContext,
  inferenceId: string | null,
): Promise<void> {
  if (decision.status === "unavailable") {
    await sql`
      insert into analysis.practical_context_assessments (
        transition_assessment_id, analysis_run_id, status, unavailable_reason
      ) values (${assessmentId}, ${runId}, 'unavailable', ${decision.reason})
      on conflict (analysis_run_id, transition_assessment_id) do nothing
    `;
    return;
  }
  await sql`
    insert into analysis.practical_context_assessments (
      transition_assessment_id, analysis_run_id, status, policy_inference_id,
      calibration_slice_id, pressure_method, adequate_reply_count,
      adequate_reply_probability, unretained_probability_mass, policy_entropy_bits,
      entropy_is_lower_bound, best_refutation_uci, best_refutation_probability,
      best_refutation_rank, out_of_domain
    ) values (
      ${assessmentId}, ${runId}, 'available', ${inferenceId!},
      ${decision.sliceId}, ${decision.pressureMethod}, ${decision.adequateReplyCount},
      ${decision.adequateReplyProbability}, ${decision.unretainedProbabilityMass},
      ${decision.policyEntropyBits}, ${decision.entropyIsLowerBound},
      ${decision.bestRefutationUci}, ${decision.bestRefutationProbability},
      ${decision.bestRefutationRank}, ${decision.outOfDomain}
    )
    on conflict (analysis_run_id, transition_assessment_id) do nothing
  `;
}

/**
 * The evaluation cache: looking one up, and storing one exactly once.
 *
 * Two properties carry this file.
 *
 * **Storing is idempotent, and it is idempotent at the database.** A duplicate
 * queue delivery or a retried attempt recomputes the same position and arrives
 * with the same cache key; `on conflict (cache_key) do nothing` means the second
 * one reads the first one's row instead of writing a second. That is the same
 * shape E11 used for run planning and E04 used for work items — the arbiter is
 * an index, not a check-then-insert that two workers can both pass.
 *
 * **Nothing here writes a subject, user or game.** The request carries a core
 * position, a scope and a profile, and that is all the table has room for. An
 * occurrence-scoped request is the one exception and it is explicit: it names a
 * materialization run, which is why those rows cascade with the occurrence and
 * are not shared.
 *
 * The engine call happens outside every transaction in this file. That is not
 * an optimisation — an engine search inside a transaction would hold a
 * connection for the length of a 500,000-node search, and the epic forbids it.
 *
 * Sources: plans/database-architecture.md §§15.2, 15.3, 29.5.
 */

import type { Sql } from "postgres";
import type { Queryable } from "../db/queryable.js";
import {
  evaluationCacheKey,
  expectedScore,
  historySignature,
  roundScore,
  scopeViolations,
  type EvaluationInputRole,
  type EvaluationScope,
  type ExactHistory,
} from "./contract.js";
import type { ResolvedProfile } from "./profiles.js";
import type { CandidateLine, PositionEval } from "./stockfish.js";

/** Everything that identifies one search, before it has been run. */
export interface EvaluationRequest {
  corePositionId: string;
  /** E09's deterministic core identity; the cache key's anchor. */
  corePositionKeyHash: string;
  scope: EvaluationScope;
  /** The position to search. For `history_exact` this is the replayed result. */
  fen: string;
  halfmoveClock: number | null;
  history: ExactHistory | null;
  occurrence: { materializationRunId: string; ply: number } | null;
  profile: ResolvedProfile;
}

export interface StoredEvaluation {
  id: string;
  cacheKey: string;
  scope: EvaluationScope;
  /** White's perspective, as stored. */
  expectedScore: number;
  scoreCp: number | null;
  mateIn: number | null;
  bestMoveUci: string | null;
  multipv: number;
  nodes: number | null;
  /** White's perspective, ordered by engine rank. */
  candidateExpectedScores: readonly number[];
  candidateMoves: readonly string[];
}

/** The deterministic identity of the search this request describes. */
export function cacheKeyFor(request: EvaluationRequest): string {
  const violations = scopeViolations({
    scope: request.scope,
    halfmoveClock: request.halfmoveClock,
    historySignature: request.history ? historySignature(request.history) : null,
    occurrence: request.occurrence,
  });
  if (violations.length > 0) throw new Error(violations.join("; "));

  return evaluationCacheKey({
    corePositionKeyHash: request.corePositionKeyHash,
    scope: request.scope,
    halfmoveClock: request.halfmoveClock,
    historySignature: request.history ? historySignature(request.history) : null,
    occurrence: request.occurrence,
    profileContentHash: request.profile.profileContentHash,
    calibrationContentHash: request.profile.calibrationContentHash,
    limitType: request.profile.spec.limitType,
    limitValue: request.profile.spec.limitValue,
    multipv: request.profile.spec.multipv,
    threads: request.profile.spec.threads,
    hashMb: request.profile.spec.hashMb,
    tablebase: request.profile.spec.tablebase,
    perspective: "white",
  });
}

interface EvaluationRow {
  id: string;
  cache_key: string;
  scope: EvaluationScope;
  expected_score: string;
  score_cp: number | null;
  mate_in: number | null;
  best_move_uci: string | null;
  multipv: number;
  nodes: string | null;
}

const SELECT_EVALUATION =
  "id, cache_key, scope, expected_score, score_cp, mate_in, best_move_uci, multipv, nodes";

async function hydrate(sql: Queryable, row: EvaluationRow): Promise<StoredEvaluation> {
  const candidates = await sql<{ uci: string; expected_score: string }[]>`
    select uci, expected_score from analysis.evaluation_candidates
    where position_evaluation_id = ${row.id}
    order by rank
  `;
  return {
    id: String(row.id),
    cacheKey: row.cache_key,
    scope: row.scope,
    expectedScore: Number(row.expected_score),
    scoreCp: row.score_cp,
    mateIn: row.mate_in,
    bestMoveUci: row.best_move_uci,
    multipv: row.multipv,
    nodes: row.nodes == null ? null : Number(row.nodes),
    candidateExpectedScores: candidates.map((candidate) => Number(candidate.expected_score)),
    candidateMoves: candidates.map((candidate) => candidate.uci),
  };
}

/** The cache read. One index probe on `position_evaluations_cache_key`. */
export async function findCachedEvaluation(
  sql: Queryable,
  cacheKey: string,
): Promise<StoredEvaluation | null> {
  const [row] = await sql<EvaluationRow[]>`
    select ${sql.unsafe(SELECT_EVALUATION)} from analysis.position_evaluations
    where cache_key = ${cacheKey}
  `;
  return row ? hydrate(sql, row) : null;
}

export interface StoreResult {
  evaluation: StoredEvaluation;
  /** False when an identical computation was already stored. */
  created: boolean;
}

/**
 * Store one engine result under its cache key, or return the one already there.
 *
 * The candidates are written in the same transaction as the evaluation: a row
 * whose MultiPV lines arrived separately could be read between the two, and an
 * adequate-move count computed from a half-written candidate list is a wrong
 * answer that looks like a right one.
 */
export async function storeEvaluation(
  sql: Sql,
  request: EvaluationRequest,
  result: PositionEval,
  workerRevision: string,
): Promise<StoreResult> {
  const cacheKey = cacheKeyFor(request);
  const primary = expectedScore({
    scoreCp: result.evalCp ?? null,
    mateIn: result.mate ?? null,
    wdl: result.wdl ?? null,
  });

  const inserted = await sql.begin(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      insert into analysis.position_evaluations (
        core_position_id, scope, halfmove_clock, history_signature, occurrence_run_id,
        occurrence_ply, model_profile_id, calibration_component_version_id, limit_type,
        limit_value, multipv, threads, hash_mb, tablebase, perspective, score_cp, mate_in,
        wdl_win, wdl_draw, wdl_loss, expected_score, expected_score_method, best_move_uci,
        depth, seldepth, nodes, nps, engine_time_ms, wall_time_ms, worker_revision, cache_key
      ) values (
        ${request.corePositionId}, ${request.scope}, ${request.halfmoveClock},
        ${request.history ? historySignature(request.history) : null},
        ${request.occurrence?.materializationRunId ?? null}, ${request.occurrence?.ply ?? null},
        ${request.profile.modelProfileId}, ${request.profile.calibrationVersionId},
        ${request.profile.spec.limitType}, ${request.profile.spec.limitValue},
        ${request.profile.spec.multipv}, ${request.profile.spec.threads},
        ${request.profile.spec.hashMb}, ${request.profile.spec.tablebase}, 'white',
        ${result.evalCp ?? null}, ${result.mate ?? null},
        ${result.wdl?.[0] ?? null}, ${result.wdl?.[1] ?? null}, ${result.wdl?.[2] ?? null},
        ${roundScore(primary.value)}, ${primary.method}, ${result.best ?? null},
        ${result.depth}, ${candidateSelDepth(result)}, ${result.nodes ?? null},
        ${result.nps ?? null}, ${result.engineTimeMs ?? null}, ${Math.round(result.elapsedMs)},
        ${workerRevision}, ${cacheKey}
      )
      on conflict (cache_key) do nothing
      returning id
    `;
    if (!row) return null;

    for (const candidate of dedupeCandidates(result.candidates)) {
      const value = expectedScore({
        scoreCp: candidate.evalCp ?? null,
        mateIn: candidate.mate ?? null,
        wdl: candidate.wdl ?? null,
      });
      await tx`
        insert into analysis.evaluation_candidates (
          position_evaluation_id, rank, uci, score_cp, mate_in, wdl_win, wdl_draw, wdl_loss,
          expected_score, expected_score_method, pv, nodes
        ) values (
          ${row.id}, ${candidate.rank}, ${candidate.pv[0]!}, ${candidate.evalCp ?? null},
          ${candidate.mate ?? null}, ${candidate.wdl?.[0] ?? null}, ${candidate.wdl?.[1] ?? null},
          ${candidate.wdl?.[2] ?? null}, ${roundScore(value.value)}, ${value.method},
          ${tx.json(candidate.pv as never)}, ${candidate.nodes ?? null}
        )
      `;
    }
    return row.id;
  });

  const [row] = await sql<EvaluationRow[]>`
    select ${sql.unsafe(SELECT_EVALUATION)} from analysis.position_evaluations
    where cache_key = ${cacheKey}
  `;
  if (!row) throw new Error("the evaluation vanished between insert and read");
  return { evaluation: await hydrate(sql, row), created: inserted !== null };
}

/** The engine reports seldepth per line; the row records the primary line's. */
function candidateSelDepth(result: PositionEval): number | null {
  return result.candidates.find((candidate) => candidate.rank === 1)?.selDepth ?? null;
}

/**
 * One line per first move.
 *
 * Stockfish can emit two MultiPV lines starting with the same move as a search
 * converges, and the schema refuses a duplicate move within an evaluation. The
 * lower rank is the engine's own preference, so the first occurrence wins and
 * an adequate-move count stays a count of distinct moves.
 */
function dedupeCandidates(candidates: readonly CandidateLine[]): CandidateLine[] {
  const seen = new Set<string>();
  const kept: CandidateLine[] = [];
  for (const candidate of [...candidates].sort((left, right) => left.rank - right.rank)) {
    const move = candidate.pv[0];
    if (!move || seen.has(move)) continue;
    seen.add(move);
    kept.push({ ...candidate, rank: kept.length + 1 });
  }
  return kept;
}

/**
 * Record that a run read this evaluation, in a named role.
 *
 * Idempotent by primary key, so a retried step re-links rather than failing —
 * and because the link is not the evidence, re-linking cannot change a result.
 */
export async function linkRunUse(
  sql: Queryable,
  runId: string,
  evaluationId: string,
  role: EvaluationInputRole,
): Promise<void> {
  await sql`
    insert into analysis.run_evaluation_uses (run_id, position_evaluation_id, input_role)
    values (${runId}, ${evaluationId}, ${role})
    on conflict do nothing
  `;
}

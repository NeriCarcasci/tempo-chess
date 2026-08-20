/**
 * Turning cached evaluations into the objective assessment of a decision.
 *
 * This is where the epic's product claim is actually made, so it is worth being
 * precise about what is and is not claimed.
 *
 * What is claimed: the actor's expected score before the move, the actor's
 * expected score after it, the difference, whether that difference is inside a
 * named tolerance, and — when the search retained more than one line — how many
 * moves were inside that tolerance and how much the position had at stake.
 *
 * What is not claimed: that the move was a "mistake" or a "blunder". Database
 * architecture §16.1 makes those optional versioned presentation
 * classifications derived from measurements, and this table stores the
 * measurement. A later epic that wants labels can derive them and version the
 * derivation; deriving them here would freeze one editorial choice into the
 * evidence.
 *
 * The other deliberate restraint is the nulls. When screening retains one line,
 * `acceptableMoveCount`, `onlyMove` and `criticality` are null rather than
 * defaulted, because a one-line search never looked at an alternative. A zero
 * there would read as "no adequate moves existed", which is a dramatic claim to
 * make about a search that did not look.
 */

import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import type { Queryable } from "../db/queryable.js";
import {
  assessCandidates,
  fromActor,
  isAcceptableLoss,
  isExactEvidenceScope,
  roundScore,
  type DeepStatus,
} from "./contract.js";
import type { StoredEvaluation } from "./evaluations.js";
import type { GamePhase } from "../analysis/phase.js";
import type { CriticalReasonDetail } from "./critical-position.js";
import { jsonParam } from "../db/json.js";

export interface TransitionEvidence {
  fromPly: number;
  playedUci: string;
  actorColor: "white" | "black";
  before: StoredEvaluation;
  after: StoredEvaluation;
  /** The deeper look, when it was selected and succeeded. */
  deep: StoredEvaluation | null;
  deepStatus: DeepStatus;
  deepSelectionReasons: readonly CriticalReasonDetail[];
  phase: GamePhase | null;
}

export interface AssessmentRow {
  fromPly: number;
  playedUci: string;
  bestMoveUci: string | null;
  playedMoveRank: number | null;
  actorColor: "white" | "black";
  expectedScoreBefore: number;
  expectedScoreAfter: number;
  decisionLoss: number;
  playedMoveAcceptable: boolean;
  acceptableMoveCount: number | null;
  onlyMove: boolean | null;
  criticality: number | null;
  difficultyFeatures: Record<string, unknown>;
  beforeEvaluationId: string;
  afterEvaluationId: string;
  deepEvaluationId: string | null;
  deepStatus: DeepStatus;
  deepSelectionReasons: readonly CriticalReasonDetail[];
  phase: GamePhase | null;
}

/**
 * One transition's assessment, from the evidence that was actually computed.
 *
 * The candidate-derived columns come from the deeper search when there was one,
 * because that is the search that looked at alternatives. The decision loss
 * does not: it comes from the before/after pair, which the database requires to
 * share a profile and a limit. Mixing a deep "before" with a screening "after"
 * would produce a loss that is mostly the gap between two searches.
 */
export function buildAssessment(evidence: TransitionEvidence): AssessmentRow {
  // The database refuses this too. Refusing it here names the rule instead of
  // surfacing a trigger message from the middle of a batch insert.
  for (const [side, source] of [["before", evidence.before], ["after", evidence.after]] as const) {
    if (!isExactEvidenceScope(source.scope)) {
      throw new Error(`${side} evidence is core-scoped and cannot be exact evidence about an occurrence`);
    }
  }
  const expectedBefore = roundScore(fromActor(evidence.before.expectedScore, evidence.actorColor));
  const expectedAfter = roundScore(fromActor(evidence.after.expectedScore, evidence.actorColor));
  const decisionLoss = roundScore(expectedBefore - expectedAfter);

  const candidateSource = evidence.deep ?? evidence.before;
  const actorCandidateScores = candidateSource.candidateExpectedScores.map((score) =>
    fromActor(score, evidence.actorColor),
  );
  const candidates = assessCandidates(actorCandidateScores);
  const rankIndex = candidateSource.candidateMoves.indexOf(evidence.playedUci);

  return {
    fromPly: evidence.fromPly,
    playedUci: evidence.playedUci,
    bestMoveUci: candidateSource.bestMoveUci ?? evidence.before.bestMoveUci,
    // Null means "not among the lines this search retained", which is different
    // from "ranked last". A rank invented for a move the engine never listed
    // would be the most quotable wrong number in the table.
    playedMoveRank: rankIndex >= 0 ? rankIndex + 1 : null,
    actorColor: evidence.actorColor,
    expectedScoreBefore: expectedBefore,
    expectedScoreAfter: expectedAfter,
    decisionLoss,
    playedMoveAcceptable: isAcceptableLoss(decisionLoss),
    acceptableMoveCount: candidates.acceptableMoveCount,
    onlyMove: candidates.onlyMove,
    criticality: candidates.criticality,
    difficultyFeatures: {
      // Which search answered the candidate questions, so a reader can tell a
      // one-line screening null from a three-line deep zero.
      candidateSource: evidence.deep ? "deep" : "screening",
      retainedLines: candidateSource.candidateMoves.length,
      beforeScope: evidence.before.scope,
      afterScope: evidence.after.scope,
    },
    beforeEvaluationId: evidence.before.id,
    afterEvaluationId: evidence.after.id,
    deepEvaluationId: evidence.deep?.id ?? null,
    deepStatus: evidence.deepStatus,
    deepSelectionReasons: evidence.deepSelectionReasons,
    phase: evidence.phase,
  };
}

/**
 * The checksum of one run's assessment family.
 *
 * Over the measurements rather than the row ids, so a rerun that produced the
 * same conclusions from the same evidence hashes the same even though its
 * identity columns differ. That is what makes E11's manifest comparison a
 * statement about results.
 */
export function assessmentsChecksum(rows: readonly AssessmentRow[]): string {
  const canonical = JSON.stringify(
    [...rows]
      .sort((left, right) => left.fromPly - right.fromPly)
      .map((row) => [
        row.fromPly,
        row.playedUci,
        row.actorColor,
        row.expectedScoreBefore,
        row.expectedScoreAfter,
        row.playedMoveAcceptable,
        row.acceptableMoveCount,
        row.onlyMove,
        row.criticality,
        row.deepStatus,
        row.phase,
      ]),
  );
  return createHash("sha256").update(canonical).digest("hex");
}

export interface WriteAssessmentsInput {
  runId: string;
  materializationRunId: string;
  toleranceVersionId: string;
  rows: readonly AssessmentRow[];
}

/**
 * Write one run's assessments, all of them, in one transaction.
 *
 * All-or-nothing because a partially assessed game is exactly the thing E11's
 * manifest check exists to refuse: 40 of 80 transitions is not "half a review",
 * it is a review that would silently omit the second half of the game. The
 * unique constraint on `(run, transition)` makes a retried step land on the
 * same rows rather than doubling them, and the immutability trigger means the
 * retry cannot restate an earlier answer.
 */
export async function writeAssessments(
  sql: Sql,
  input: WriteAssessmentsInput,
): Promise<{ written: number; checksum: string }> {
  const checksum = assessmentsChecksum(input.rows);
  await sql.begin(async (tx) => {
    for (const row of input.rows) {
      await tx`
        insert into analysis.transition_assessments (
          analysis_run_id, materialization_run_id, from_ply, before_evaluation_id,
          after_evaluation_id, deep_evaluation_id, deep_status, deep_selection_reasons,
          actor_color, played_move_uci, best_move_uci, played_move_rank,
          expected_score_before, expected_score_after, tolerance_component_version_id,
          played_move_acceptable, acceptable_move_count, only_move, criticality,
          difficulty_features, phase
        ) values (
          ${input.runId}, ${input.materializationRunId}, ${row.fromPly},
          ${row.beforeEvaluationId}, ${row.afterEvaluationId}, ${row.deepEvaluationId},
          ${row.deepStatus}, ${jsonParam(row.deepSelectionReasons)}::jsonb,
          ${row.actorColor}, ${row.playedUci}, ${row.bestMoveUci}, ${row.playedMoveRank},
          ${row.expectedScoreBefore}, ${row.expectedScoreAfter}, ${input.toleranceVersionId},
          ${row.playedMoveAcceptable}, ${row.acceptableMoveCount}, ${row.onlyMove},
          ${row.criticality}, ${jsonParam(row.difficultyFeatures)}::jsonb, ${row.phase}
        )
        on conflict (analysis_run_id, materialization_run_id, from_ply) do nothing
      `;
    }
  });
  return { written: input.rows.length, checksum };
}

/** How many assessments a run already has. Used to make the step resumable. */
export async function countAssessments(sql: Queryable, runId: string): Promise<number> {
  const [row] = await sql<{ count: string }[]>`
    select count(*)::text as count from analysis.transition_assessments
    where analysis_run_id = ${runId}
  `;
  return Number(row.count);
}

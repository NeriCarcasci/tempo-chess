/**
 * `analysis_detect_concepts` — turning an analysed game into skill evidence.
 *
 * The step E13 was missing. Everything around it existed: the tables, the
 * vocabulary and validators in `analysis/observations.ts`, and the whole
 * consumer chain from `estimates/aggregate.ts` through the baseline report. But
 * nothing ever wrote a `concept_opportunities` row outside a gate, so the
 * estimator grouped nothing into nothing and every report said the same thing:
 * we have your games and we have measured none of them.
 *
 * This runs once per game, after the transitions have been assessed, because it
 * reads those assessments. It writes three kinds of row in one transaction:
 *
 *   * a `chess_events` row per detected moment -- what happened, and where;
 *   * a `concept_opportunities` row per observation -- what it says about the
 *     player, or that it says nothing because they never got to answer;
 *   * an `evidence_items` row per opportunity, which is what makes a claim in a
 *     report traceable back to the game it came from.
 *
 * One transaction because a half-written game is worse than an unwritten one:
 * the estimator would read the opportunities that landed and call the result a
 * measurement.
 *
 * ## Every write is bound
 *
 * All three tables are actor-scoped. The owner is resolved from the workflow
 * before anything else runs -- the pattern the rest of this codebase learned
 * the hard way, where an unbound read returns zero rows rather than raising and
 * the failure presents as "you have no data".
 */

import type { Sql } from "postgres";
import { withActor } from "../../db/actor.js";
import { jsonParam } from "../../db/json.js";
import { requiredDate, type RawTimestamp } from "../../db/timestamps.js";
import { registerHandler, type WorkContext, type WorkResult } from "../../ops/handlers.js";
import { WorkFailure } from "../../ops/retry.js";
import { isRecordableOpportunity, difficultyIsUncontaminated } from "../observations.js";
import { conceptBySlug } from "./catalogue.js";
import { conceptVersionIds } from "./register.js";
import { detectGame, type GameFacts, type PositionFact, type TransitionFact } from "./detect.js";
import { publishedMaterializationRun } from "../../engine/recipe.js";

export const DETECT_TASK = "analysis_detect_concepts";

interface Payload {
  readonly runId?: unknown;
}

interface RunRow {
  subject_game_id: string | null;
  subject_id: string | null;
  replay_revision_id: string | null;
}

/**
 * Detect and record, for one run whose owner is already known.
 *
 * Separated from the handler so that an operator can run the detector over
 * games that were analysed before it existed, without redoing the engine work
 * those runs already paid for. The handler resolves the owner from the workflow
 * and calls this; a backfill resolves it from the subject and calls the same
 * thing. There is deliberately no second implementation.
 */
export async function detectForRun(
  sql: Sql,
  runId: string,
  ownerProfileId: string,
): Promise<WorkResult> {
  return withActor(sql, ownerProfileId, async (tx) => {
    const [run] = await tx<RunRow[]>`
      select subject_game_id, subject_id, replay_revision_id
      from analysis.runs where id = ${runId}
    `;
    if (!run?.subject_game_id || !run.subject_id || !run.replay_revision_id) {
      throw new WorkFailure("invalid_input", "unknown_run", "no such analysis run");
    }

    // The position graph hangs off the materialization, not off the analysis
    // run: a run names the replay revision it analysed, and the materializer
    // publishes exactly one chain per revision.
    const materializationRunId = await publishedMaterializationRun(tx, run.replay_revision_id);
    if (materializationRunId === null) {
      throw new WorkFailure(
        "invalid_input",
        "no_published_materialization",
        "the run's replay revision has no published position graph",
      );
    }

    const [game] = await tx<{
      subject_color: string;
      replay_revision_id: string;
      speed: string | null;
      termination: string | null;
      played_at: RawTimestamp;
    }[]>`
      select g.subject_color, r.id as replay_revision_id, r.speed, r.termination, r.played_at
      from chess.subject_games g
      join chess.game_replay_revisions r on r.id = g.latest_replay_revision_id
      where g.id = ${run.subject_game_id}
    `;
    if (!game) throw new WorkFailure("invalid_input", "unknown_game", "no such subject game");
    if (game.subject_color !== "white" && game.subject_color !== "black") {
      throw new WorkFailure("invalid_input", "unknown_color", "the subject played neither colour");
    }

    const positions = await tx<{ ply: number; fen: string }[]>`
      select ply, fen from chess.position_occurrences
      where run_id = ${materializationRunId}
      order by ply
    `;
    const transitions = await tx<{
      from_ply: number;
      actor_color: string;
      played_move_uci: string;
      best_move_uci: string | null;
      played_move_rank: number | null;
      played_move_acceptable: boolean;
      only_move: boolean | null;
      criticality: string | null;
      expected_score_before: string;
      expected_score_after: string;
      phase: string | null;
    }[]>`
      select from_ply, actor_color, played_move_uci, best_move_uci, played_move_rank,
             played_move_acceptable, only_move, criticality,
             expected_score_before, expected_score_after, phase
      from analysis.transition_assessments
      where analysis_run_id = ${runId}
      order by from_ply
    `;
    if (transitions.length === 0) {
      // Nothing to read is not nothing to say, but it is nothing to measure.
      return {
        outputRef: `run:${runId}`,
        outputSummary: { opportunities: 0, reason: "no_assessed_transitions" },
      };
    }

    const versions = await conceptVersionIds(tx);
    if (versions.size === 0) {
      throw new WorkFailure(
        "unsupported",
        "no_registered_concepts",
        "the concept catalogue has not been registered in this environment",
      );
    }

    const facts: GameFacts = {
      subjectColor: game.subject_color,
      speed: game.speed,
      playedAt: requiredDate(game.played_at, "game_replay_revisions.played_at"),
      termination: game.termination,
      positions: positions.map((row): PositionFact => ({ ply: row.ply, fen: row.fen })),
      transitions: transitions.map((row): TransitionFact => ({
        fromPly: row.from_ply,
        actorColor: row.actor_color === "white" ? "white" : "black",
        playedMoveUci: row.played_move_uci,
        bestMoveUci: row.best_move_uci,
        playedMoveRank: row.played_move_rank,
        playedMoveAcceptable: row.played_move_acceptable,
        onlyMove: row.only_move,
        criticality: row.criticality === null ? null : Number(row.criticality),
        expectedScoreBefore: Number(row.expected_score_before),
        expectedScoreAfter: Number(row.expected_score_after),
        phase: row.phase,
      })),
    };

    // Evidence is append-only, and the grants say so: `forma_analysis` may
    // insert and select these tables and may not delete from them. That is the
    // right shape -- a worker that can delete a player's evidence can quietly
    // rewrite what a report was based on -- so a re-delivery is answered by
    // declining to write a second copy rather than by clearing the first.
    //
    // Redetecting the same game under a changed catalogue is a different
    // matter, and it is a new analysis run, not an overwrite of this one.
    // `run_id` on all three evidence tables references
    // `chess.materialization_runs`, not `analysis.runs`. The evidence is about
    // a position graph rather than about one pass of the engine over it, which
    // is why the estimator joins these rows by game and snapshot and never by
    // run at all.
    const [existing] = await tx<{ count: string }[]>`
      select count(*)::text from analysis.concept_opportunities
      where run_id = ${materializationRunId}
    `;
    if (existing && Number(existing.count) > 0) {
      return {
        outputRef: `run:${runId}`,
        outputSummary: { opportunities: Number(existing.count), duplicate: true },
      };
    }

    const detected = detectGame(facts);

    let written = 0;
    let censored = 0;
    let skipped = 0;
    const byConcept = new Map<string, number>();

    for (const observation of detected) {
      const conceptVersionId = versions.get(observation.conceptSlug);
      const definition = conceptBySlug(observation.conceptSlug);
      if (!conceptVersionId || !definition) {
        // The catalogue in the database is behind this build. Skipping is the
        // conservative answer: an unregistered concept has no definition a
        // player could be shown, so evidence against it could not be explained.
        skipped += 1;
        continue;
      }
      // The validators exist so a detector cannot write a row that lies. They
      // are checked here, on the way in, rather than trusted.
      if (!isRecordableOpportunity(observation.draft)
        || !difficultyIsUncontaminated(observation.draft.difficulty)) {
        skipped += 1;
        continue;
      }

      const [event] = await tx<{ id: string }[]>`
        insert into analysis.chess_events (
          run_id, replay_revision_id, subject_game_id, event_type, start_ply, focal_ply,
          end_ply, actor_color, affected_color, facts, detection_confidence, completeness
        ) values (
          ${materializationRunId}, ${game.replay_revision_id}, ${run.subject_game_id},
          ${observation.event.eventType}, ${observation.event.startPly},
          ${observation.event.focalPly}, ${observation.event.endPly},
          ${game.subject_color}, ${game.subject_color},
          ${jsonParam(observation.event.facts)}::jsonb, null, ${observation.event.completeness}
        )
        returning id
      `;
      if (!event) throw new Error("the event vanished on insert");

      const [evidence] = await tx<{ id: string }[]>`
        insert into analysis.evidence_items (
          run_id, evidence_kind, subject_id, subject_game_id, occurred_at, confidence
        ) values (
          ${materializationRunId}, 'opportunity', ${run.subject_id}, ${run.subject_game_id},
          ${facts.playedAt.toISOString()}, null
        )
        returning id
      `;
      if (!evidence) throw new Error("the evidence item vanished on insert");

      await tx`
        insert into analysis.concept_opportunities (
          run_id, subject_id, subject_game_id, event_id, concept_version_id, role,
          opportunity_ply, response_ply, response_observed, censored_reason, success,
          score, rubric_component_version_id, difficulty, phase, speed, context,
          confidence, evidence_source_kind, occurred_at
        ) values (
          ${materializationRunId}, ${run.subject_id}, ${run.subject_game_id}, ${event.id}, ${conceptVersionId},
          ${observation.draft.role}, ${observation.draft.opportunityPly},
          ${observation.draft.responsePly}, ${observation.draft.responseObserved},
          ${observation.draft.censoredReason}, ${observation.draft.success},
          ${observation.draft.score}, ${observation.draft.rubricComponentVersionId},
          ${jsonParam(observation.draft.difficulty)}::jsonb, ${observation.phase},
          ${game.speed}, ${jsonParam({ evidenceItemId: evidence.id })}::jsonb, null,
          ${definition.evidenceSourceKind}, ${facts.playedAt.toISOString()}
        )
      `;

      written += 1;
      if (!observation.draft.responseObserved) censored += 1;
      byConcept.set(observation.conceptSlug, (byConcept.get(observation.conceptSlug) ?? 0) + 1);
    }

    return {
      outputRef: `run:${runId}`,
      outputSummary: {
        opportunities: written,
        censored,
        skipped,
        concepts: Object.fromEntries(byConcept),
      },
      metrics: { inputCount: transitions.length, outputCount: written },
    };
  });
}

/**
 * Deferred, for the reason `models/worker.ts` documents: `db/client.js` refuses
 * to load without a database identity, so an offline gate that only wants the
 * handler function must not pull it in at import time.
 */
async function runtimeSql(): Promise<Sql> {
  const { client } = await import("../../db/client.js");
  return client as unknown as Sql;
}

export async function detectConcepts(context: WorkContext, sql: Sql): Promise<WorkResult> {
  const payload = context.item.payload as Payload;
  const runId = typeof payload.runId === "string" ? payload.runId : null;
  if (runId === null) {
    throw new WorkFailure("invalid_input", "invalid_payload", "the payload names no run");
  }

  // The owner comes from the workflow the API created, never from the payload,
  // and it is resolved before anything reads a tenant table.
  const [workflow] = await sql<{ owner_profile_id: string | null }[]>`
    select owner_profile_id from ops.workflows where id = ${context.item.workflowId}
  `;
  if (!workflow?.owner_profile_id) {
    throw new WorkFailure("invalid_input", "unowned_workflow", "the workflow names no owner");
  }
  return detectForRun(sql, runId, workflow.owner_profile_id);
}

let registered = false;

export function registerConceptHandlers(): void {
  if (registered) return;
  registered = true;
  registerHandler(DETECT_TASK, async (context) => detectConcepts(context, await runtimeSql()));
}

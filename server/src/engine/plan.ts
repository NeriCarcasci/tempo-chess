/**
 * Planning one game's objective analysis.
 *
 * Everything a client could try to choose is chosen here instead: the recipe
 * comes from the promoted pointer for the `deep_game_analysis` surface, the
 * limits come from `ENGINE_PROFILES`, and the subject comes from the ownership
 * join rather than from the request. API contract §7 is explicit that "recipe
 * and limits are selected server-side" and that "users cannot request arbitrary
 * depth/threads/nodes", and the way to keep that true is for there to be no
 * parameter that could carry them.
 *
 * Nothing is invented when a precondition is missing. No promoted recipe and no
 * published materialization are both real states with real causes, and they are
 * returned as such — an analysis that ran under a recipe nobody promoted would
 * be a claim made by whichever deployment happened to start first.
 */

import type { Sql } from "postgres";
import { DuplicateWorkError, insertWorkflow } from "../ops/ledger.js";
import { currentRecipeFor } from "../analysis/validation.js";
import { planRun } from "../analysis/runs.js";
import { readEngineRoles, publishedMaterializationRun } from "./recipe.js";
import { ASSESS_TASK, DEEP_TASK, SCREEN_TASK } from "./worker.js";
import { PRACTICAL_TASK } from "../models/worker.js";

export interface PlanGameAnalysisInput {
  subjectGameId: string;
  /** The verified caller. Ownership is a join, not a filter the caller supplies. */
  ownerProfileId: string;
  trigger?: "user_request" | "scheduled" | "backfill";
}

export type PlanGameAnalysisOutcome =
  /** The current publication already covers the current replay revision. */
  | { state: "published"; runId: string; publicationId: string }
  | { state: "scheduled"; runId: string; workflowId: string; alreadyScheduled: boolean }
  | { state: "unavailable"; reason: "no_promoted_recipe" | "no_published_materialization" };

interface GameRow {
  subject_id: string;
  latest_replay_revision_id: string;
  published_run_id: string | null;
  published_revision_id: string | null;
  published_recipe_version_id: string | null;
  publication_id: string | null;
}

/**
 * Plan, or recognise that there is nothing to plan.
 *
 * The publication check compares the published run's revision with the game's
 * *current* one. A publication against an older revision is not a reason to
 * skip: the provider corrected the replay, so the analysis is about a game that
 * has since changed, and E11's game view already calls that `stale`.
 */
export async function planGameAnalysis(
  sql: Sql,
  input: PlanGameAnalysisInput,
): Promise<PlanGameAnalysisOutcome | null> {
  const [game] = await sql<GameRow[]>`
    select sg.subject_id, sg.latest_replay_revision_id,
           pub.run_id as published_run_id, pub.replay_revision_id as published_revision_id,
           pub.recipe_version_id as published_recipe_version_id, pub.publication_id
    from chess.subject_games sg
    join app.analysis_subjects s on s.id = sg.subject_id
    left join analysis.subject_game_publications pub on pub.subject_game_id = sg.id
    where sg.id = ${input.subjectGameId} and s.owner_user_id = ${input.ownerProfileId}
  `;
  if (!game) return null;

  const promoted = await currentRecipeFor(sql, "deep_game_analysis");
  const covered =
    game.published_run_id !== null &&
    String(game.published_revision_id) === String(game.latest_replay_revision_id);

  // §7's "existing compatible publication". Compatible means two things: it read
  // the replay revision that is current now, and it used the recipe that is
  // promoted now. A publication from a superseded method is a real analysis and
  // stays readable, but answering a request for analysis with it would mean a
  // promoted method never reaches a game that was analysed before it.
  if (covered && (!promoted || game.published_recipe_version_id === promoted.recipeVersionId)) {
    return { state: "published", runId: game.published_run_id!, publicationId: game.publication_id! };
  }
  if (!promoted) return { state: "unavailable", reason: "no_promoted_recipe" };

  const materializationRunId = await publishedMaterializationRun(
    sql,
    String(game.latest_replay_revision_id),
  );
  if (!materializationRunId) {
    return { state: "unavailable", reason: "no_published_materialization" };
  }

  const roles = await readEngineRoles(sql, promoted.recipeVersionId);
  const run = await planRun(sql, {
    recipeVersionId: promoted.recipeVersionId,
    scope: {
      subjectId: game.subject_id,
      subjectGameId: input.subjectGameId,
      replayRevisionId: String(game.latest_replay_revision_id),
    },
    trigger: input.trigger ?? "user_request",
    actor: { kind: "system" },
  });

  const enginePayload = {
    materializationRunId,
    engineVersionId: roles.engineVersionId,
    calibrationVersionId: roles.calibrationVersionId,
  };

  try {
    const workflow = await sql.begin(async (tx) =>
      insertWorkflow(tx as unknown as Sql, {
        kind: "game_analysis",
        ownerProfileId: input.ownerProfileId,
        resource: { type: "subject_game", id: input.subjectGameId },
        items: [
          {
            taskType: SCREEN_TASK,
            resourceClass: "cpu_engine",
            queue: "stockfish-screen",
            // Scoped to the run, so replanning after a failed run is new work
            // and a duplicate delivery for the same run is not.
            idempotencyKey: `e12:${SCREEN_TASK}:${run.id}`,
            inputRef: `materializationRun:${materializationRunId}`,
            payload: enginePayload,
            // One unit per position, so workflow progress reflects the work
            // rather than counting three items of wildly different size.
            weight: 80,
            timeoutSeconds: 900,
          },
          {
            taskType: DEEP_TASK,
            resourceClass: "cpu_engine",
            queue: "stockfish-deep",
            idempotencyKey: `e12:${DEEP_TASK}:${run.id}`,
            inputRef: `materializationRun:${materializationRunId}`,
            payload: enginePayload,
            weight: 12,
            timeoutSeconds: 900,
            dependsOn: [0],
          },
          {
            taskType: ASSESS_TASK,
            resourceClass: "aggregation",
            queue: "analysis",
            idempotencyKey: `e12:${ASSESS_TASK}:${run.id}`,
            inputRef: `run:${run.id}`,
            payload: { runId: run.id },
            weight: 4,
            dependsOn: [1],
          },
          {
            // E14's human layer. It runs on cpu_model rather than cpu_engine
            // because a human policy is not an engine, and it depends on the
            // assessment because it annotates assessments: a run with no
            // objective answer has nothing for it to be practical about.
            taskType: PRACTICAL_TASK,
            resourceClass: "cpu_model",
            queue: "analysis",
            idempotencyKey: `e14:${PRACTICAL_TASK}:${run.id}`,
            inputRef: `run:${run.id}`,
            payload: { runId: run.id },
            weight: 4,
            dependsOn: [2],
          },
        ],
      }),
    );
    return {
      state: "scheduled",
      runId: run.id,
      workflowId: workflow.workflowId,
      alreadyScheduled: false,
    };
  } catch (error) {
    if (error instanceof DuplicateWorkError && error.existingWorkflowId) {
      // The same run was already scheduled — a retried command, or two tabs.
      // The ledger's unique index is the arbiter and the loser reports the
      // winner's workflow rather than creating a second set of engine work.
      return {
        state: "scheduled",
        runId: run.id,
        workflowId: error.existingWorkflowId,
        alreadyScheduled: true,
      };
    }
    throw error;
  }
}

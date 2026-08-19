/**
 * Recomputing where a goal stands.
 *
 * `writeProgress` had no caller, so `coaching.goal_progress_snapshots` was
 * always empty and the progress endpoint always answered "nothing has been
 * measured on this goal yet". Every piece of the calculation existed and
 * nothing ran it.
 *
 * The trigger is the honest one: **new real games**. A progress reading is a
 * comparison between the estimate the cycle pinned and the estimate the newest
 * published analysis carries, and the only thing that produces a new published
 * analysis is the player playing. So a sync that accepted games queues this,
 * and activating a goal queues it once so the first reading exists.
 *
 * What it must never do is let practice complete a goal. That separation is in
 * `readProgress`, and it is preserved here by counting the two kinds of
 * evidence with two different queries against two different tables — the sort
 * of duplication that is worth having, because the alternative is one query
 * with a flag somebody eventually reads the wrong way.
 */

import type { Sql } from "postgres";
import { registerHandler, type WorkContext, type WorkResult } from "../ops/handlers.js";
import { WorkFailure } from "../ops/retry.js";
import { createWorkflow } from "../ops/ledger.js";
import { measureAdherence } from "./plan.js";
import { readProgress, type ProgressReading } from "./progress.js";
import { writeProgress } from "./store.js";

export const PROGRESS_TASK = "coaching_goal_progress";

interface CycleRow {
  cycle_id: string;
  goal_id: string;
  subject_id: string;
  starts_on: string;
}

/**
 * Queue a progress refresh for every active cycle of one subject.
 *
 * Returns the number queued, which is usually zero: most syncs belong to people
 * who have not set a goal, and queueing nothing is the right answer rather than
 * a workflow that exists to do nothing.
 */
export async function planProgressForSubject(
  sql: Sql,
  input: { subjectId: string; ownerProfileId: string; reason: string },
): Promise<{ queued: number; workflowId: string | null }> {
  const cycles = await sql<{ id: string }[]>`
    select c.id
    from coaching.coaching_cycles c
    join coaching.goals g on g.id = c.goal_id
    where g.subject_id = ${input.subjectId} and c.status = 'active' and g.status = 'active'
  `;
  if (cycles.length === 0) return { queued: 0, workflowId: null };

  const created = await createWorkflow({
    kind: "maintenance",
    ownerProfileId: input.ownerProfileId,
    resource: { type: "subject", id: input.subjectId },
    items: [...cycles].map((cycle) => ({
      taskType: PROGRESS_TASK,
      resourceClass: "aggregation" as const,
      payload: { cycleId: cycle.id },
      // Scoped to the reason, so two different triggers do not collapse into
      // one item and lose a refresh: a sync landing games and a goal being
      // activated are different events and both deserve a reading.
      idempotencyKey: `progress:${cycle.id}:${input.reason}`,
      queue: "analysis" as const,
    })),
  });
  return { queued: cycles.length, workflowId: created.workflowId };
}

/**
 * One reading per metric on one cycle, against the newest published analysis.
 *
 * Idempotent by `(analysis_run_id, cycle_id, metric_key)`: running it twice
 * against the same publication writes nothing the second time, so a redelivered
 * message cannot inflate a history that a chart is drawn from.
 */
export async function refreshCycleProgress(
  input: { cycleId: string },
  sql: Sql,
): Promise<{ written: number; analysisRunId: string | null; reason?: string }> {
  const [cycle] = await sql<CycleRow[]>`
    select c.id as cycle_id, c.goal_id, g.subject_id, c.starts_on
    from coaching.coaching_cycles c
    join coaching.goals g on g.id = c.goal_id
    where c.id = ${input.cycleId} and c.status = 'active'
  `;
  if (!cycle) return { written: 0, analysisRunId: null, reason: "no_active_cycle" };

  const [publication] = await sql<{ run_id: string }[]>`
    select run_id from analysis.subject_live_publications where subject_id = ${cycle.subject_id}
  `;
  if (!publication) return { written: 0, analysisRunId: null, reason: "no_published_analysis" };

  const targets = await sql<
    {
      metric_key: string;
      baseline_value: string;
      target_value: string;
      direction: "increase" | "decrease";
      meaningful_change: string;
      required_evidence_count: number;
      required_coverage_state: "limited" | "sufficient";
    }[]
  >`
    select metric_key, baseline_value, target_value, direction, meaningful_change,
           required_evidence_count, required_coverage_state
    from coaching.goal_metric_targets where cycle_id = ${cycle.cycle_id}
  `;
  if (targets.length === 0) return { written: 0, analysisRunId: null, reason: "no_targets" };

  const estimates = await sql<
    {
      dimension_key: string;
      estimate: string | null;
      interval_low: string | null;
      interval_high: string | null;
      coverage_state: string | null;
    }[]
  >`
    select d.dimension_key, e.estimate, e.interval_low, e.interval_high,
           e.coverage_state
    from analysis.player_skill_estimates e
    join analysis.skill_dimensions d on d.id = e.skill_dimension_id
    where e.analysis_run_id = ${publication.run_id} and e.window_kind = 'lifetime'
  `;
  const byMetric = new Map([...estimates].map((row) => [row.dimension_key, row]));

  // Real-game evidence: games the subject played since the cycle opened. This
  // is the only count that can complete a goal.
  const [games] = await sql<{ count: string }[]>`
    select count(*)::text as count
    from chess.subject_games sg
    join chess.provider_games pg on pg.id = sg.provider_game_id
    where sg.subject_id = ${cycle.subject_id}
      and sg.status = 'included'
      and pg.played_at >= ${cycle.starts_on}::date
  `;
  const realGameEvidence = Number(games?.count ?? 0);

  // Practice evidence: a separate table, counted separately, and carried in a
  // separate field all the way to the response.
  const [practice] = await sql<{ count: string }[]>`
    select count(*)::text as count
    from coaching.practice_attempts a
    join coaching.learning_assignments la on la.id = a.assignment_id
    where la.subject_id = ${cycle.subject_id} and a.attempted_at >= ${cycle.starts_on}::date
  `;
  const practiceEvidence = Number(practice?.count ?? 0);

  const requirements = await sql<
    {
      requirement_key: string;
      kind: string;
      quantity: string;
      unit: string;
      window_days: number;
      essential: boolean;
      rationale: string;
      display_rank: number;
      cohort_filter: Record<string, unknown>;
    }[]
  >`
    select requirement_key, kind, quantity, unit, window_days, essential, rationale,
           display_rank, cohort_filter
    from coaching.goal_requirements where cycle_id = ${cycle.cycle_id}
  `;
  // The current revision of each commitment, and only the ones still enabled: a
  // person who turned a commitment off has not failed it.
  const commitments = await sql<
    { commitment_key: string; enabled: boolean; accepted_requirement_keys: string[] }[]
  >`
    select distinct on (commitment_key) commitment_key, enabled, accepted_requirement_keys
    from coaching.goal_commitments
    where cycle_id = ${cycle.cycle_id}
    order by commitment_key, revision desc
  `;
  const acceptedKeys = [...commitments]
    .filter((row) => row.enabled)
    .flatMap((row) => row.accepted_requirement_keys ?? []);

  // What actually happened, per requirement. A requirement asking for games is
  // measured in games and one asking for drills is measured in drills — the
  // whole point of keeping the two counts apart.
  const observed: Record<string, number> = {};
  for (const requirement of requirements) {
    observed[requirement.requirement_key] =
      requirement.kind === "play_games" ? realGameEvidence : practiceEvidence;
  }

  const measured = measureAdherence({
    requirements: [...requirements].map((row) => ({
      requirementKey: row.requirement_key,
      kind: row.kind as never,
      quantity: Number(row.quantity),
      unit: row.unit as never,
      windowDays: row.window_days,
      essential: row.essential,
      rationale: row.rationale,
      displayRank: row.display_rank,
      cohortFilter: row.cohort_filter ?? {},
    })),
    acceptedKeys,
    observed,
  });
  const adherence = { requirementsMet: measured.met, requirementsTotal: measured.total };

  const readings: ProgressReading[] = [...targets].map((target) => {
    const estimate = byMetric.get(target.metric_key);
    return readProgress({
      target: {
        metricKey: target.metric_key,
        baselineValue: Number(target.baseline_value),
        targetValue: Number(target.target_value),
        direction: target.direction,
        meaningfulChange: Number(target.meaningful_change),
        requiredEvidenceCount: target.required_evidence_count,
        requiredCoverageState: target.required_coverage_state,
      },
      estimate: {
        value: estimate?.estimate == null ? null : Number(estimate.estimate),
        intervalLow: estimate?.interval_low == null ? null : Number(estimate.interval_low),
        intervalHigh: estimate?.interval_high == null ? null : Number(estimate.interval_high),
        coverageState: (estimate?.coverage_state as "insufficient" | "limited" | "sufficient") ?? "insufficient",
        // Named rather than left null: "this metric is not in the report" and
        // "this metric has no evidence" are different things to be told.
        unavailableReason: estimate ? null : "metric_not_estimated",
      },
      evidence: { realGame: realGameEvidence, practice: practiceEvidence },
      adherence,
    });
  });

  const written = await writeProgress(sql, {
    cycleId: cycle.cycle_id,
    analysisRunId: publication.run_id,
    readings,
  });
  return { written, analysisRunId: publication.run_id };
}

async function runProgressItem(context: WorkContext, sql: Sql): Promise<WorkResult> {
  const payload = context.item.payload as { cycleId?: unknown };
  const cycleId = typeof payload.cycleId === "string" ? payload.cycleId : null;
  if (cycleId === null) {
    throw new WorkFailure("invalid_input", "invalid_payload", "the payload names no cycle");
  }
  const startedAt = Date.now();
  const result = await refreshCycleProgress({ cycleId }, sql);
  return {
    outputRef: `cycle:${cycleId}`,
    outputSummary: {
      written: result.written,
      analysisRunId: result.analysisRunId,
      skipped: result.reason ?? null,
    },
    metrics: { outputCount: result.written, computeMs: Date.now() - startedAt },
  };
}

let registered = false;

export function registerGoalHandlers(): void {
  if (registered) return;
  registered = true;
  registerHandler(PROGRESS_TASK, async (context) => runProgressItem(context, await runtimeSql()));
}

async function runtimeSql(): Promise<Sql> {
  const { client } = await import("../db/client.js");
  return client as unknown as Sql;
}

/**
 * Queue a refresh for every cycle whose newest analysis is newer than its
 * newest reading.
 *
 * The sweep half of the loop: a person plays, the games are synced and
 * analysed, a new publication lands, and this notices that the goal has not
 * been re-measured against it. Bounded, and a no-op when nothing has moved.
 */
export async function planStaleProgress(
  sql: Sql,
  input: { limit?: number } = {},
): Promise<{ queued: number }> {
  const limit = Math.min(Math.max(1, Math.floor(input.limit ?? 100)), 500);
  const stale = await sql<{ id: string; owner_user_id: string | null; run_id: string }[]>`
    select c.id, s.owner_user_id, p.run_id
    from coaching.coaching_cycles c
    join coaching.goals g on g.id = c.goal_id
    join app.analysis_subjects s on s.id = g.subject_id
    join analysis.subject_live_publications p on p.subject_id = g.subject_id
    where c.status = 'active' and g.status = 'active'
      and not exists (
        select 1 from coaching.goal_progress_snapshots snap
        where snap.cycle_id = c.id and snap.analysis_run_id = p.run_id
      )
    limit ${limit}
  `;
  if (stale.length === 0) return { queued: 0 };

  await createWorkflow({
    kind: "maintenance",
    ownerProfileId: stale[0]!.owner_user_id,
    resource: { type: "coaching_cycle", id: stale[0]!.id },
    items: [...stale].map((row) => ({
      taskType: PROGRESS_TASK,
      resourceClass: "aggregation" as const,
      payload: { cycleId: row.id },
      // Keyed by the publication, so one reading is taken per cycle per
      // analysis and a sweep that runs every ten minutes does not write the
      // same row forty times.
      idempotencyKey: `progress:${row.id}:${row.run_id}`,
      queue: "analysis" as const,
    })),
  });
  return { queued: stale.length };
}

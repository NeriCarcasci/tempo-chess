import type { Sql } from "postgres";
import { isoOf } from "../db/timestamps.js";

import type { Queryable } from "../db/queryable.js";
import type { Stage } from "./contract.js";
import type { CoverageDecision } from "./coverage.js";
import type { RunState } from "./state.js";
import { deriveStage } from "./state.js";
import type { SelectedItem } from "./diagnostic.js";
import type { ReportItem } from "./baseline.js";

/**
 * Reading and writing the onboarding journey.
 *
 * Every read is scoped by the owning profile in the query rather than filtered
 * afterwards, so a run belonging to someone else is indistinguishable from one
 * that does not exist. That is the same posture E12's review takes and for the
 * same reason: distinguishing them turns an identifier into an oracle.
 */

export interface OnboardingRunRow {
  id: string;
  subject_id: string;
  stage: Stage;
  status: RunState["status"];
  diagnostic_choice: "adaptive" | "skip";
  sync_workflow_id: string | null;
  examination_run_id: string | null;
  subject_data_snapshot_id: string | null;
  report_viewed_at: Date | null;
  goal_selected_at: Date | null;
  commitment_accepted_at: Date | null;
  activated_at: Date | null;
  failure_reason: string | null;
  created_at: Date;
}

export interface LoadedRun {
  row: OnboardingRunRow;
  state: RunState;
  baselineReportId: string | null;
  derivedStage: Stage;
}

/**
 * Load one run and everything the state machine needs to judge it.
 *
 * One query. The stage is then derived rather than read: a worker that crashed
 * between finishing its work and writing the stage would otherwise leave the
 * user staring at a spinner for work that is done.
 *
 * ## Why `sync_complete` counts items and not the workflow
 *
 * `sync_workflow_id` names the whole `initial_examination` workflow — sync,
 * prepare, report, examine, advance — and this read used to be
 * `w.state = 'succeeded'`. That is only true once the *entire* examination has
 * finished, so `syncComplete` was false for the whole journey, and everything
 * downstream of it inherited the lie: `deriveStage` returned `syncing` from the
 * first move to the last, `nextAction` said "importing your games" while the
 * engine was working through two hundred games, the stage trail held IMPORTING
 * lit right through analysis, and a failure at *any* step was reported to the
 * reader as the import not having finished. One wrong join, told four ways.
 *
 * It is the same confusion the sync screen's own progress bar had, one layer
 * down: the five-step examination read as though it were the account sync,
 * because the column it is stored in is named after one.
 *
 * A run with no sync items at all is complete rather than pending. An account
 * on a provider with no adapter has nothing planned for it (see `planner.ts`),
 * and waiting on work that will never be created is how such an account would
 * hang the journey for ever.
 */
export async function loadRun(
  sql: Queryable,
  input: { runId: string; ownerProfileId: string },
): Promise<LoadedRun | null> {
  const [row] = await sql<
    (OnboardingRunRow & {
      has_linked_account: boolean;
      sync_complete: boolean;
      analysis_complete: boolean;
      diagnostic_complete: boolean;
      diagnostic_session_id: string | null;
      baseline_report_id: string | null;
    })[]
  >`
    select r.id, r.subject_id, r.stage, r.status, r.diagnostic_choice, r.sync_workflow_id,
           r.examination_run_id, r.subject_data_snapshot_id, r.report_viewed_at,
           r.goal_selected_at, r.commitment_accepted_at, r.activated_at, r.failure_reason,
           r.created_at,
           exists (
             select 1 from app.subject_account_memberships m
             where m.subject_id = r.subject_id
           ) as has_linked_account,
           -- The sync items, not the workflow holding them. See the note above.
           not exists (
             select 1 from ops.work_items i
             where i.workflow_id = r.sync_workflow_id
               and i.task_type = 'provider_account_sync'
               and i.status <> 'succeeded'
           ) as sync_complete,
           (ar.status = 'succeeded') as analysis_complete,
           coalesce(ds.status = 'completed', false) as diagnostic_complete,
           ds.id as diagnostic_session_id,
           br.id as baseline_report_id
    from coaching.onboarding_runs r
    left join ops.workflows w on w.id = r.sync_workflow_id
    left join analysis.runs ar on ar.id = r.examination_run_id
    left join coaching.diagnostic_sessions ds on ds.onboarding_run_id = r.id
    left join coaching.baseline_reports br on br.onboarding_run_id = r.id
    where r.id = ${input.runId} and r.user_id = ${input.ownerProfileId}
    limit 1
  `;
  if (!row) return null;

  const state: RunState = {
    stage: row.stage,
    status: row.status,
    diagnosticChoice: row.diagnostic_choice,
    hasLinkedAccount: row.has_linked_account,
    syncComplete: row.sync_complete === true,
    analysisComplete: row.analysis_complete === true,
    diagnosticComplete: row.diagnostic_complete === true,
    diagnosticSessionId: row.diagnostic_session_id,
    baselineReportId: row.baseline_report_id,
    reportViewedAt: row.report_viewed_at,
    goalSelectedAt: row.goal_selected_at,
    commitmentAcceptedAt: row.commitment_accepted_at,
  };

  return {
    row,
    state,
    baselineReportId: row.baseline_report_id,
    derivedStage: deriveStage(state),
  };
}

/** The caller's current journey, or null when they have never started one. */
export async function currentRun(
  sql: Queryable,
  ownerProfileId: string,
): Promise<LoadedRun | null> {
  const [row] = await sql<{ id: string }[]>`
    select id from coaching.onboarding_runs
    where user_id = ${ownerProfileId}
    order by (status = 'active') desc, created_at desc
    limit 1
  `;
  if (!row) return null;
  return loadRun(sql, { runId: row.id, ownerProfileId });
}

/**
 * Start a journey, or return the one already running.
 *
 * A repeated request is a resume, not a second start: the partial unique index
 * on active runs makes that true even under a double-submitted form, and the
 * conflict path reads the existing row rather than raising.
 */
/**
 * Retire a run whose examination died, so the person can start another.
 *
 * **A dead sync never fails its run.** The workflow ends `failed`, and the run
 * carries on saying `active` with a next action of `wait`, because nothing
 * tells it otherwise. Every screen already knows to read the workflow as well
 * and say the journey has stopped -- and then the only thing offered was "start
 * again", which resumed the same dead run and planned nothing, because at most
 * one run per subject may be active and this one still claimed to be. The
 * person was stuck for good, on an account whose games had synced perfectly
 * well.
 *
 * So starting again starts again. The dead run is closed with the reason it
 * actually had, its evidence stays on record, and the insert below is free to
 * create a fresh one -- which re-plans the whole examination from the sync
 * forward, with new idempotency keys derived from the new run id.
 *
 * Only a run whose workflow is genuinely finished-and-bad is touched. A running
 * or queued workflow leaves its run exactly where it is, which is what stops
 * this from becoming a way to restart an examination that is merely slow.
 */
async function retireDeadRun(sql: Sql, subjectId: string): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    update coaching.onboarding_runs r
    set status = 'failed',
        failure_reason = 'analysis_failed',
        completed_at = now(),
        updated_at = now()
    where r.subject_id = ${subjectId}
      and r.status = 'active'
      and r.sync_workflow_id is not null
      and exists (
        select 1 from ops.workflows w
        where w.id = r.sync_workflow_id and w.state in ('failed', 'cancelled')
      )
    returning r.id
  `;
  return rows.length > 0;
}

export async function startRun(
  sql: Sql,
  input: {
    userId: string;
    subjectId: string;
    diagnosticChoice: "adaptive" | "skip";
  },
): Promise<{ runId: string; created: boolean }> {
  // Before anything else, because the alternative is resuming a corpse: the
  // partial unique index allows one active run per subject, so a dead one that
  // still calls itself active is what makes "start again" a no-op.
  await retireDeadRun(sql, input.subjectId);

  const [inserted] = await sql<{ id: string }[]>`
    insert into coaching.onboarding_runs (user_id, subject_id, diagnostic_choice)
    values (${input.userId}, ${input.subjectId}, ${input.diagnosticChoice})
    on conflict do nothing
    returning id
  `;
  if (inserted) return { runId: inserted.id, created: true };

  const [existing] = await sql<{ id: string }[]>`
    select id from coaching.onboarding_runs
    where subject_id = ${input.subjectId} and status = 'active'
  `;
  if (!existing) throw new Error("the run neither inserted nor exists");
  return { runId: existing.id, created: false };
}

/** Record that the user actually opened their report. */
export async function markReportViewed(
  sql: Queryable,
  input: { runId: string; ownerProfileId: string },
): Promise<void> {
  await sql`
    update coaching.onboarding_runs
    set report_viewed_at = coalesce(report_viewed_at, now()),
        stage = case when stage = 'report_ready' then 'goal_setting' else stage end,
        updated_at = now()
    where id = ${input.runId} and user_id = ${input.ownerProfileId} and status = 'active'
  `;
}

/**
 * Activate.
 *
 * The `where` clause carries every precondition, so a concurrent request that
 * cleared one of them between the check and the write finds nothing to update
 * rather than activating on stale facts. The database's own constraint is the
 * second line of defence.
 */
export async function activate(
  sql: Queryable,
  input: { runId: string; ownerProfileId: string },
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    update coaching.onboarding_runs
    set activated_at = now(), status = 'activated', stage = 'activated',
        completed_at = now(), updated_at = now()
    where id = ${input.runId} and user_id = ${input.ownerProfileId} and status = 'active'
      and report_viewed_at is not null
      and goal_selected_at is not null
      and commitment_accepted_at is not null
      and exists (
        select 1 from coaching.baseline_reports b where b.onboarding_run_id = ${input.runId}
      )
    returning id
  `;
  return rows.length > 0;
}

export interface StoredCoverage {
  id: string;
  decision: CoverageDecision;
}

export async function writeCoverage(
  sql: Sql,
  input: {
    subjectDataSnapshotId: string;
    policyComponentVersionId: string;
    decision: CoverageDecision;
  },
): Promise<string> {
  return sql.begin(async (tx) => {
    const decision = input.decision;
    const [snapshot] = await tx<{ id: string }[]>`
      insert into coaching.data_coverage_snapshots (
        subject_data_snapshot_id, policy_component_version_id, overall_state, total_games,
        eligible_games, decision_count, earliest_played_at, latest_played_at, speeds_covered,
        clock_available_games, opening_reach_count, middlegame_reach_count,
        endgame_reach_count, rating_in_calibrated_range, limitations
      ) values (
        ${input.subjectDataSnapshotId}, ${input.policyComponentVersionId},
        ${decision.overallState}, ${decision.totalGames}, ${decision.eligibleGames},
        ${decision.dimensions.reduce((sum, d) => sum + d.observationCount, 0)},
        ${isoOf(decision.earliestPlayedAt)}, ${isoOf(decision.latestPlayedAt)},
        ${decision.speedsCovered}, ${decision.clockAvailableGames},
        ${decision.openingReachCount}, ${decision.middlegameReachCount},
        ${decision.endgameReachCount}, ${decision.ratingInCalibratedRange},
        ${decision.limitations}
      )
      on conflict (subject_data_snapshot_id, policy_component_version_id) do nothing
      returning id
    `;
    if (!snapshot) {
      const [existing] = await tx<{ id: string }[]>`
        select id from coaching.data_coverage_snapshots
        where subject_data_snapshot_id = ${input.subjectDataSnapshotId}
          and policy_component_version_id = ${input.policyComponentVersionId}
      `;
      if (!existing) throw new Error("the coverage snapshot neither inserted nor exists");
      return existing.id;
    }

    for (const dimension of decision.dimensions) {
      await tx`
        insert into coaching.data_coverage_dimensions (
          coverage_snapshot_id, dimension_key, observation_count, effective_count,
          earliest_played_at, latest_played_at, state, limitation_reason
        ) values (
          ${snapshot.id}, ${dimension.dimensionKey}, ${dimension.observationCount},
          ${dimension.effectiveCount}, ${isoOf(dimension.earliestPlayedAt)},
          ${isoOf(dimension.latestPlayedAt)}, ${dimension.state}, ${dimension.limitationReason}
        )
        on conflict do nothing
      `;
    }
    return snapshot.id;
  });
}

export async function readCoverage(
  sql: Queryable,
  coverageSnapshotId: string,
): Promise<{
  overallState: string;
  totalGames: number;
  eligibleGames: number;
  limitations: string[];
  dimensions: { dimensionKey: string; observationCount: number; state: string; limitationReason: string | null }[];
} | null> {
  const [snapshot] = await sql<
    {
      overall_state: string;
      total_games: number;
      eligible_games: number;
      limitations: string[];
    }[]
  >`
    select overall_state, total_games, eligible_games, limitations
    from coaching.data_coverage_snapshots where id = ${coverageSnapshotId}
  `;
  if (!snapshot) return null;
  const dimensions = await sql<
    {
      dimension_key: string;
      observation_count: number;
      state: string;
      limitation_reason: string | null;
    }[]
  >`
    select dimension_key, observation_count, state, limitation_reason
    from coaching.data_coverage_dimensions
    where coverage_snapshot_id = ${coverageSnapshotId}
    order by state, dimension_key
  `;
  return {
    overallState: snapshot.overall_state,
    totalGames: snapshot.total_games,
    eligibleGames: snapshot.eligible_games,
    limitations: snapshot.limitations,
    dimensions: dimensions.map((row) => ({
      dimensionKey: row.dimension_key,
      observationCount: row.observation_count,
      state: row.state,
      limitationReason: row.limitation_reason,
    })),
  };
}

export async function createDiagnosticSession(
  sql: Sql,
  input: {
    onboardingRunId: string;
    subjectId: string;
    selectionComponentVersionId: string;
    rubricComponentVersionId: string;
    items: readonly SelectedItem[];
  },
): Promise<{ sessionId: string; created: boolean }> {
  return sql.begin(async (tx) => {
    const [session] = await tx<{ id: string }[]>`
      insert into coaching.diagnostic_sessions (
        onboarding_run_id, subject_id, selection_component_version_id,
        rubric_component_version_id, item_count
      ) values (
        ${input.onboardingRunId}, ${input.subjectId}, ${input.selectionComponentVersionId},
        ${input.rubricComponentVersionId}, ${input.items.length}
      )
      on conflict do nothing
      returning id
    `;
    if (!session) {
      const [existing] = await tx<{ id: string }[]>`
        select id from coaching.diagnostic_sessions
        where onboarding_run_id = ${input.onboardingRunId} and status = 'open'
      `;
      if (!existing) throw new Error("the session neither inserted nor exists");
      return { sessionId: existing.id, created: false };
    }

    for (const item of input.items) {
      await tx`
        insert into coaching.diagnostic_session_items (
          session_id, ordinal, purpose, core_position_id, fen, investigates_dimension_key,
          investigates_finding_id, expected_uci, acceptable_uci
        ) values (
          ${session.id}, ${item.ordinal}, ${item.purpose}, ${item.corePositionId}, ${item.fen},
          ${item.dimensionKey}, ${item.findingId}, ${item.expectedUci},
          ${item.acceptableUci as string[]}
        )
      `;
    }
    return { sessionId: session.id, created: true };
  });
}

export async function writeBaseline(
  sql: Sql,
  input: {
    subjectId: string;
    onboardingRunId: string;
    subjectDataSnapshotId: string;
    analysisRunId: string;
    coverageSnapshotId: string;
    layoutComponentVersionId: string;
    diagnosticSessionId: string | null;
    manifestSha256: string;
    items: readonly ReportItem[];
  },
): Promise<{ reportId: string; created: boolean }> {
  return sql.begin(async (tx) => {
    const [report] = await tx<{ id: string }[]>`
      insert into coaching.baseline_reports (
        subject_id, onboarding_run_id, subject_data_snapshot_id, analysis_run_id,
        coverage_snapshot_id, layout_component_version_id, diagnostic_session_id,
        manifest_sha256
      ) values (
        ${input.subjectId}, ${input.onboardingRunId}, ${input.subjectDataSnapshotId},
        ${input.analysisRunId}, ${input.coverageSnapshotId},
        ${input.layoutComponentVersionId}, ${input.diagnosticSessionId},
        ${input.manifestSha256}
      )
      on conflict (onboarding_run_id) do nothing
      returning id
    `;
    if (!report) {
      const [existing] = await tx<{ id: string }[]>`
        select id from coaching.baseline_reports where onboarding_run_id = ${input.onboardingRunId}
      `;
      if (!existing) throw new Error("the baseline neither inserted nor exists");
      return { reportId: existing.id, created: false };
    }

    for (const item of input.items) {
      await tx`
        insert into coaching.baseline_report_items (
          baseline_report_id, section, display_order, item_kind, finding_id,
          player_skill_estimate_id, trajectory_snapshot_id, coverage_dimension_key,
          rendered_explanation_id, entitlement_key
        ) values (
          ${report.id}, ${item.section}, ${item.displayOrder}, ${item.itemKind},
          ${item.findingId ?? null}, ${item.playerSkillEstimateId ?? null},
          ${item.trajectorySnapshotId ?? null}, ${item.coverageDimensionKey ?? null},
          ${item.renderedExplanationId ?? null}, ${item.entitlementKey}
        )
      `;
    }
    return { reportId: report.id, created: true };
  });
}

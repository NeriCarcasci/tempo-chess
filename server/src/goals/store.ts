import type { Sql } from "postgres";
import { isoOf } from "../db/timestamps.js";

import type { Queryable } from "../db/queryable.js";
import type { CloseOutcome, GoalStatus } from "./contract.js";
import type { Requirement } from "./plan.js";
import type { ProgressReading } from "./progress.js";
import type { ResolvedTarget } from "./resolve.js";
import { jsonParam } from "../db/json.js";

/**
 * Reading and writing goals.
 *
 * Ownership is a join to the caller's subjects in every query rather than a
 * filter afterwards, so a goal belonging to someone else is indistinguishable
 * from one that does not exist.
 */

export interface GoalRow {
  id: string;
  subject_id: string;
  template_version_id: string | null;
  status: GoalStatus;
  stated_objective: string;
  target_provider: string | null;
  target_pool: string | null;
  target_speed: string | null;
  comparison_frame: string;
  horizon_days: number | null;
  uncalibrated_caveat: string | null;
  created_at: Date;
  activated_at: Date | null;
  closed_at: Date | null;
  close_outcome: CloseOutcome | null;
  close_note: string | null;
}

export async function listGoals(
  sql: Queryable,
  ownerProfileId: string,
): Promise<GoalRow[]> {
  return sql<GoalRow[]>`
    select g.id, g.subject_id, g.template_version_id, g.status, g.stated_objective,
           g.target_provider, g.target_pool, g.target_speed, g.comparison_frame,
           g.horizon_days, g.uncalibrated_caveat, g.created_at, g.activated_at,
           g.closed_at, g.close_outcome, g.close_note
    from coaching.goals g
    join app.analysis_subjects s on s.id = g.subject_id
    where s.owner_user_id = ${ownerProfileId}
    order by (g.status = 'active') desc, g.created_at desc
  `;
}

export async function loadGoal(
  sql: Queryable,
  input: { goalId: string; ownerProfileId: string },
): Promise<GoalRow | null> {
  const [row] = await sql<GoalRow[]>`
    select g.id, g.subject_id, g.template_version_id, g.status, g.stated_objective,
           g.target_provider, g.target_pool, g.target_speed, g.comparison_frame,
           g.horizon_days, g.uncalibrated_caveat, g.created_at, g.activated_at,
           g.closed_at, g.close_outcome, g.close_note
    from coaching.goals g
    join app.analysis_subjects s on s.id = g.subject_id
    where g.id = ${input.goalId} and s.owner_user_id = ${input.ownerProfileId}
  `;
  return row ?? null;
}

export async function createGoal(
  sql: Queryable,
  input: {
    subjectId: string;
    templateVersionId: string | null;
    statedObjective: string;
    comparisonFrame: string;
    targetProvider: string | null;
    targetPool: string | null;
    targetSpeed: string | null;
    horizonDays: number | null;
    uncalibratedCaveat: string | null;
  },
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into coaching.goals (
      subject_id, template_version_id, stated_objective, comparison_frame,
      target_provider, target_pool, target_speed, horizon_days, uncalibrated_caveat
    ) values (
      ${input.subjectId}, ${input.templateVersionId}, ${input.statedObjective},
      ${input.comparisonFrame}, ${input.targetProvider}, ${input.targetPool},
      ${input.targetSpeed}, ${input.horizonDays}, ${input.uncalibratedCaveat}
    )
    returning id
  `;
  return row!.id;
}

/**
 * Start a cycle: the immutable part of a goal.
 *
 * Targets are written in the same transaction, because a cycle with no targets
 * is a promise with nothing behind it, and a target written afterwards could be
 * one somebody added once the first one looked unreachable.
 */
export async function createCycle(
  sql: Sql,
  input: {
    goalId: string;
    baselineReportId: string | null;
    baselineAnalysisRunId: string;
    baselineSnapshotId: string;
    targetCohortVersionId: string | null;
    estimatorComponentVersionId: string;
    planGeneratorComponentVersionId: string;
    startsOn: string;
    endsOn: string | null;
    targets: readonly ResolvedTarget[];
    requiredCoverageState: "limited" | "sufficient";
  },
): Promise<{ cycleId: string; created: boolean }> {
  return sql.begin(async (tx) => {
    const [existing] = await tx<{ id: string }[]>`
      select id from coaching.coaching_cycles
      where goal_id = ${input.goalId} and status = 'active'
    `;
    if (existing) return { cycleId: existing.id, created: false };

    const [next] = await tx<{ next: number }[]>`
      select coalesce(max(sequence_no), 0) + 1 as next
      from coaching.coaching_cycles where goal_id = ${input.goalId}
    `;
    const [cycle] = await tx<{ id: string }[]>`
      insert into coaching.coaching_cycles (
        goal_id, sequence_no, baseline_report_id, baseline_analysis_run_id,
        baseline_snapshot_id, target_cohort_version_id, estimator_component_version_id,
        plan_generator_component_version_id, starts_on, ends_on
      ) values (
        ${input.goalId}, ${next!.next}, ${input.baselineReportId},
        ${input.baselineAnalysisRunId}, ${input.baselineSnapshotId},
        ${input.targetCohortVersionId}, ${input.estimatorComponentVersionId},
        ${input.planGeneratorComponentVersionId}, ${input.startsOn}, ${input.endsOn}
      )
      returning id
    `;

    for (const target of input.targets) {
      await tx`
        insert into coaching.goal_metric_targets (
          cycle_id, metric_key, baseline_value, target_value, direction,
          meaningful_change, required_evidence_count, required_coverage_state
        ) values (
          ${cycle!.id}, ${target.metricKey}, ${target.baselineValue}, ${target.targetValue},
          ${target.direction}, ${target.meaningfulChange}, ${target.requiredEvidenceCount},
          ${input.requiredCoverageState}
        )
      `;
    }

    await tx`
      update coaching.goals
      set status = 'active', activated_at = coalesce(activated_at, now())
      where id = ${input.goalId} and status = 'draft'
    `;

    return { cycleId: cycle!.id, created: true };
  });
}

export async function writeRequirements(
  sql: Queryable,
  input: { cycleId: string; generatorComponentVersionId: string; requirements: readonly Requirement[] },
): Promise<number> {
  let written = 0;
  for (const requirement of input.requirements) {
    const rows = await sql<{ id: string }[]>`
      insert into coaching.goal_requirements (
        cycle_id, requirement_key, kind, quantity, unit, window_days, essential,
        rationale, generator_component_version_id, cohort_filter, display_rank
      ) values (
        ${input.cycleId}, ${requirement.requirementKey}, ${requirement.kind},
        ${requirement.quantity}, ${requirement.unit}, ${requirement.windowDays},
        ${requirement.essential}, ${requirement.rationale},
        ${input.generatorComponentVersionId}, ${jsonParam(requirement.cohortFilter)}::jsonb,
        ${requirement.displayRank}
      )
      on conflict (cycle_id, requirement_key) do nothing
      returning id
    `;
    written += rows.length;
  }
  return written;
}

export interface CommitmentRow {
  commitment_key: string;
  revision: number;
  target: string;
  cadence: string;
  unit: string;
  enabled: boolean;
  accepted_requirement_keys: string[];
  effective_from: string;
  confirmed_at: Date;
}

/** The current revision of each commitment on a cycle. */
export async function currentCommitments(
  sql: Queryable,
  cycleId: string,
): Promise<CommitmentRow[]> {
  return sql<CommitmentRow[]>`
    select distinct on (commitment_key)
           commitment_key, revision, target, cadence, unit, enabled,
           accepted_requirement_keys, effective_from, confirmed_at
    from coaching.goal_commitments
    where cycle_id = ${cycleId}
    order by commitment_key, revision desc
  `;
}

/**
 * Record a commitment revision.
 *
 * Append-only: a change writes a new revision and closes the previous one's
 * effective window by convention rather than by editing it. `confirmedAt` is
 * required by the schema, so there is no code path that records a commitment
 * the user did not confirm.
 */
export async function recordCommitment(
  sql: Queryable,
  input: {
    cycleId: string;
    commitmentKey: string;
    target: number;
    cadence: string;
    unit: string;
    enabled: boolean;
    acceptedRequirementKeys: readonly string[];
    effectiveFrom: string;
    confirmedAt: Date;
  },
): Promise<number> {
  const [row] = await sql<{ revision: number }[]>`
    insert into coaching.goal_commitments (
      cycle_id, commitment_key, revision, target, cadence, unit, enabled,
      accepted_requirement_keys, effective_from, confirmed_at
    )
    select ${input.cycleId}, ${input.commitmentKey},
           coalesce(max(revision), 0) + 1, ${input.target}, ${input.cadence},
           ${input.unit}, ${input.enabled}, ${input.acceptedRequirementKeys as string[]},
           ${input.effectiveFrom}, ${isoOf(input.confirmedAt)}
    from coaching.goal_commitments
    where cycle_id = ${input.cycleId} and commitment_key = ${input.commitmentKey}
    returning revision
  `;
  return row!.revision;
}

export async function writeProgress(
  sql: Queryable,
  input: { cycleId: string; analysisRunId: string; readings: readonly ProgressReading[] },
): Promise<number> {
  let written = 0;
  for (const reading of input.readings) {
    const rows = await sql<{ id: string }[]>`
      insert into coaching.goal_progress_snapshots (
        cycle_id, analysis_run_id, metric_key, current_value, interval_low, interval_high,
        progress_from_baseline, readiness, adherence_ratio, requirements_met,
        requirements_total, real_game_evidence_count, practice_evidence_count,
        coverage_state, claim_state, target_achieved, unavailable_reason
      ) values (
        ${input.cycleId}, ${input.analysisRunId}, ${reading.metricKey}, ${reading.currentValue},
        ${reading.intervalLow}, ${reading.intervalHigh}, ${reading.progressFromBaseline},
        ${reading.readiness}, ${reading.adherenceRatio}, ${reading.requirementsMet},
        ${reading.requirementsTotal}, ${reading.realGameEvidenceCount},
        ${reading.practiceEvidenceCount}, ${reading.coverageState}, ${reading.claimState},
        ${reading.targetAchieved}, ${reading.unavailableReason}
      )
      on conflict (analysis_run_id, cycle_id, metric_key) do nothing
      returning id
    `;
    written += rows.length;
  }
  return written;
}

/** The latest progress reading per metric on a goal's active cycle. */
export async function latestProgress(
  sql: Queryable,
  goalId: string,
): Promise<
  {
    metric_key: string;
    current_value: string | null;
    readiness: string | null;
    adherence_ratio: string | null;
    real_game_evidence_count: number;
    practice_evidence_count: number;
    claim_state: string;
    target_achieved: boolean;
    unavailable_reason: string | null;
  }[]
> {
  return sql`
    select distinct on (p.metric_key)
           p.metric_key, p.current_value, p.readiness, p.adherence_ratio,
           p.real_game_evidence_count, p.practice_evidence_count, p.claim_state,
           p.target_achieved, p.unavailable_reason
    from coaching.goal_progress_snapshots p
    join coaching.coaching_cycles c on c.id = p.cycle_id
    where c.goal_id = ${goalId}
    order by p.metric_key, p.created_at desc
  `;
}

export async function closeGoal(
  sql: Queryable,
  input: {
    goalId: string;
    ownerProfileId: string;
    outcome: CloseOutcome;
    demonstrated: boolean;
    note: string | null;
  },
): Promise<boolean> {
  // `achieved` is reserved for a demonstrated target. A user closing their own
  // goal as completed without the evidence closes it as `abandoned` with a note
  // saying so, rather than the product recording an achievement that did not
  // happen.
  const status: GoalStatus =
    input.outcome === "replaced"
      ? "superseded"
      : input.demonstrated
        ? "achieved"
        : "abandoned";
  const rows = await sql<{ id: string }[]>`
    update coaching.goals
    set status = ${status}, closed_at = now(), close_outcome = ${input.outcome},
        close_note = ${input.note}
    where id = ${input.goalId}
      and status in ('draft', 'active')
      and subject_id in (
        select id from app.analysis_subjects where owner_user_id = ${input.ownerProfileId}
      )
    returning id
  `;
  return rows.length > 0;
}

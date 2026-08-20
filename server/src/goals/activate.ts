/**
 * Turning a goal into a cycle with a plan.
 *
 * E17 shipped `createCycle`, `writeRequirements` and `generatePlan`, and nothing
 * called any of them. A goal was created as a draft and stayed one: the plan
 * endpoint answered `unavailable` forever, every commitment had no cycle to
 * attach to, and the progress endpoint read a table nothing wrote. The pieces
 * were all correct and none of them were connected.
 *
 * This is the connection. Creating a goal with at least one resolved target now
 * opens its first cycle, pins what the cycle is measured against, and generates
 * the plan from the gaps this person's own report found.
 *
 * What the cycle pins is the point. A target is meaningless without the run and
 * snapshot its baseline came from — "you improved" is a comparison, and a
 * comparison whose other side moved is a claim about nothing.
 */

import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import { registerComponent, registerComponentVersion } from "../analysis/versions.js";
import { GOAL_POLICY } from "./contract.js";
import { generatePlan, type EvidenceGap } from "./plan.js";
import { createCycle, writeRequirements } from "./store.js";
import type { ResolvedTarget } from "./resolve.js";

export const GOAL_COMPONENT_KEYS = {
  planGenerator: "goal_plan_generator",
  targetResolver: "goal_target_resolver",
} as const;

export interface RegisteredGoalVersions {
  planGeneratorVersionId: string;
  targetResolverVersionId: string;
}

/**
 * Register the two methods a cycle pins.
 *
 * The plan generator and the target resolver are versioned components for the
 * same reason every estimator is: changing how a target is adjusted, or how a
 * gap becomes a requirement, changes what a person was asked to do. A cycle that
 * did not record which version produced its plan could not explain itself later.
 */
export async function registerGoalComponents(sql: Sql): Promise<RegisteredGoalVersions> {
  await registerComponent(sql, {
    componentKey: GOAL_COMPONENT_KEYS.planGenerator,
    category: "projection",
    description: "Turns the gaps a report found into a ranked, bounded plan of requirements.",
    inputContract: "skill_estimate.v1",
    outputContract: "goal_plan.v1",
  });
  await registerComponent(sql, {
    componentKey: GOAL_COMPONENT_KEYS.targetResolver,
    category: "projection",
    description: "Resolves a requested target against the baseline's own noise floor.",
    inputContract: "skill_estimate.v1",
    outputContract: "goal_target.v1",
  });

  const hash = (name: string, policy: unknown): string =>
    createHash("sha256").update(`${name}:${JSON.stringify(policy)}`).digest("hex");

  const planGenerator = await registerComponentVersion(sql, {
    componentKey: GOAL_COMPONENT_KEYS.planGenerator,
    version: GOAL_POLICY.version,
    implementationSha256: hash("plan", GOAL_POLICY),
    configuration: GOAL_POLICY,
    deterministic: true,
  });
  const targetResolver = await registerComponentVersion(sql, {
    componentKey: GOAL_COMPONENT_KEYS.targetResolver,
    version: GOAL_POLICY.version,
    implementationSha256: hash("target", GOAL_POLICY),
    configuration: GOAL_POLICY,
    deterministic: true,
  });

  return {
    planGeneratorVersionId: planGenerator.id,
    targetResolverVersionId: targetResolver.id,
  };
}

export interface ActivationInput {
  goalId: string;
  subjectId: string;
  targets: readonly ResolvedTarget[];
  horizonDays: number | null;
}

export type Activation =
  | { activated: true; cycleId: string; requirements: number; created: boolean }
  | { activated: false; reason: "no_published_analysis" | "no_targets" };

/**
 * Open the goal's first cycle and write its plan.
 *
 * Refuses without a published analysis rather than opening a cycle anchored to
 * nothing. "You have no baseline yet" is a state the product can show and act
 * on; a cycle whose baseline is zero is a promise that quietly measures the
 * wrong thing.
 */
export async function activateGoal(sql: Sql, input: ActivationInput): Promise<Activation> {
  if (input.targets.length === 0) return { activated: false, reason: "no_targets" };

  const [publication] = await sql<{ run_id: string; subject_data_snapshot_id: string }[]>`
    select run_id, subject_data_snapshot_id
    from analysis.subject_live_publications
    where subject_id = ${input.subjectId}
  `;
  if (!publication) return { activated: false, reason: "no_published_analysis" };

  // The baseline report, when there is one. A goal set from the onboarding
  // report cites it; a goal set later by somebody who has been using Forma for
  // a while has an analysis run and no onboarding report, and that is fine.
  const [report] = await sql<{ id: string }[]>`
    select b.id
    from coaching.baseline_reports b
    join coaching.onboarding_runs r on r.id = b.onboarding_run_id
    where r.subject_id = ${input.subjectId}
    order by b.published_at desc
    limit 1
  `;

  const versions = await registerGoalComponents(sql);

  const estimates = await sql<
    {
      dimension_key: string;
      display_name: string;
      estimate: string | null;
      interval_low: string | null;
      interval_high: string | null;
      raw_sample_size: number;
    }[]
  >`
    select d.dimension_key, d.display_name, e.estimate, e.interval_low, e.interval_high,
           e.raw_sample_size
    from analysis.player_skill_estimates e
    join analysis.skill_dimensions d on d.id = e.skill_dimension_id
    where e.analysis_run_id = ${publication.run_id} and e.window_kind = 'lifetime'
  `;

  const targeted = new Map(input.targets.map((target) => [target.metricKey, target]));
  const gaps: EvidenceGap[] = [...estimates].map((row) => {
    const estimate = row.estimate === null ? 0 : Number(row.estimate);
    const low = row.interval_low === null ? estimate : Number(row.interval_low);
    const high = row.interval_high === null ? estimate : Number(row.interval_high);
    const target = targeted.get(row.dimension_key);
    // Shortfall against the target where one was set, and against the top of
    // the scale otherwise: an untargeted dimension can still be the weakest
    // thing about somebody's game, and the plan should be allowed to say so.
    const goal = target ? target.targetValue : 1;
    return {
      dimensionKey: row.dimension_key,
      displayName: row.display_name,
      shortfall: Math.max(0, Math.min(1, goal - estimate)),
      intervalWidth: Math.max(0, high - low),
      observationCount: row.raw_sample_size,
      essential: target !== undefined,
    };
  });

  const startsOn = new Date().toISOString().slice(0, 10);
  const endsOn =
    input.horizonDays === null
      ? null
      : new Date(Date.now() + input.horizonDays * 86_400_000).toISOString().slice(0, 10);

  const cycle = await createCycle(sql, {
    goalId: input.goalId,
    baselineReportId: report?.id ?? null,
    baselineAnalysisRunId: publication.run_id,
    baselineSnapshotId: publication.subject_data_snapshot_id,
    targetCohortVersionId: null,
    estimatorComponentVersionId: versions.targetResolverVersionId,
    planGeneratorComponentVersionId: versions.planGeneratorVersionId,
    startsOn,
    endsOn,
    targets: input.targets,
    // A cycle may not be measured on evidence Forma has already called
    // insufficient. `limited` is the floor: below it the report itself says it
    // does not know enough, and a target on top of that is a guess with a date.
    requiredCoverageState: "limited",
  });

  const requirements = await writeRequirements(sql, {
    cycleId: cycle.cycleId,
    generatorComponentVersionId: versions.planGeneratorVersionId,
    requirements: generatePlan(gaps),
  });

  return {
    activated: true,
    cycleId: cycle.cycleId,
    requirements,
    created: cycle.created,
  };
}

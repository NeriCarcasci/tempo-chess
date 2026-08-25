import { createHash } from "node:crypto";

import type { Sql } from "postgres";

import { registerComponent, registerComponentVersion } from "../analysis/versions.js";
import { buildSubjectReport } from "../estimates/worker.js";
import { currentRecipeFor } from "../analysis/validation.js";
import { planRun } from "../analysis/runs.js";
import { freezeSubjectSnapshot, registerCohortVersion } from "../analysis/snapshots.js";
import { pendingMaterializationCount, snapshotAnalysisPending } from "../analysis/planner.js";
import { registerHandler, type WorkContext, type WorkResult } from "../ops/handlers.js";
import { WorkFailure } from "../ops/retry.js";
import { withActor } from "../db/actor.js";
import { requiredDate, toDate, type RawTimestamp } from "../db/timestamps.js";
import { COVERAGE_POLICY, DIAGNOSTIC_POLICY, STAGES } from "./contract.js";
import {
  ADVANCE_TASK,
  EXAMINATION_REPORT_TASK,
  ONBOARDING_COHORT,
  PREPARE_TASK,
} from "./planner.js";
import { decideCoverage, type DimensionFacts, type GameFacts } from "./coverage.js";
import { buildReport, manifestHash } from "./baseline.js";
import { writeBaseline, writeCoverage } from "./store.js";
import { recordOnboardingEvent } from "./telemetry.js";

/**
 * The examination step: decide coverage, then publish the baseline.
 *
 * It runs after E15's subject report, reads the same frozen snapshot, and
 * writes two things that never move again — the coverage decision and the
 * baseline. Everything it needs comes from the run, so a retry produces the
 * same report rather than a second opinion.
 */

export const EXAMINATION_TASK = "coaching_baseline_examination";

export const ONBOARDING_COMPONENT_KEYS = {
  coverage: "coverage_policy",
  layout: "baseline_layout",
  diagnosticSelection: "diagnostic_selection",
  diagnosticRubric: "diagnostic_rubric",
} as const;

export interface RegisteredOnboardingVersions {
  coverageVersionId: string;
  layoutVersionId: string;
  selectionVersionId: string;
  rubricVersionId: string;
}

export async function registerOnboardingComponents(
  sql: Sql,
): Promise<RegisteredOnboardingVersions> {
  const catalogue: [string, string, string, string, string][] = [
    [
      ONBOARDING_COMPONENT_KEYS.coverage,
      "projection",
      "Decides how much Forma is entitled to say from a frozen snapshot, and names what is missing.",
      "subject_snapshot.v1",
      "coverage_decision.v1",
    ],
    [
      ONBOARDING_COMPONENT_KEYS.layout,
      "projection",
      "Lays out the immutable baseline report and assigns entitlement keys.",
      "subject_report.v1",
      "baseline_report.v1",
    ],
    [
      ONBOARDING_COMPONENT_KEYS.diagnosticSelection,
      "projection",
      "Chooses bounded diagnostic items from the uncertainties a report leaves open.",
      "skill_estimate.v1",
      "diagnostic_session.v1",
    ],
    [
      ONBOARDING_COMPONENT_KEYS.diagnosticRubric,
      "finding_rules",
      "Scores one diagnostic attempt against the item's immutable expected and acceptable moves.",
      "diagnostic_session.v1",
      "diagnostic_attempt.v1",
    ],
  ];
  for (const [key, category, description, input, output] of catalogue) {
    await registerComponent(sql, {
      componentKey: key,
      category: category as never,
      description,
      inputContract: input,
      outputContract: output,
    });
  }

  const hash = (name: string, policy: unknown): string =>
    createHash("sha256").update(`${name}:${JSON.stringify(policy)}`).digest("hex");

  const coverage = await registerComponentVersion(sql, {
    componentKey: ONBOARDING_COMPONENT_KEYS.coverage,
    version: COVERAGE_POLICY.version,
    implementationSha256: hash("coverage", COVERAGE_POLICY),
    configuration: COVERAGE_POLICY,
    deterministic: true,
  });
  const layout = await registerComponentVersion(sql, {
    componentKey: ONBOARDING_COMPONENT_KEYS.layout,
    version: "baseline_layout_v1",
    implementationSha256: hash("layout", { version: 1 }),
    configuration: { version: 1 },
    deterministic: true,
  });
  const selection = await registerComponentVersion(sql, {
    componentKey: ONBOARDING_COMPONENT_KEYS.diagnosticSelection,
    version: DIAGNOSTIC_POLICY.version,
    implementationSha256: hash("selection", DIAGNOSTIC_POLICY),
    configuration: DIAGNOSTIC_POLICY,
    deterministic: true,
  });
  const rubric = await registerComponentVersion(sql, {
    componentKey: ONBOARDING_COMPONENT_KEYS.diagnosticRubric,
    version: "diagnostic_rubric_v1",
    implementationSha256: hash("rubric", { best: 1, acceptable: 0.6, hintHalving: true }),
    configuration: { best: 1, acceptable: 0.6, hintHalving: true },
    deterministic: true,
  });

  return {
    coverageVersionId: coverage.id,
    layoutVersionId: layout.id,
    selectionVersionId: selection.id,
    rubricVersionId: rubric.id,
  };
}

interface Payload {
  onboardingRunId?: unknown;
  /** The stage an advance item is moving the run to. */
  stage?: unknown;
}

export async function buildExamination(
  context: WorkContext,
  sql: Sql,
): Promise<WorkResult> {
  const payload = context.item.payload as Payload;
  const runId = typeof payload.onboardingRunId === "string" ? payload.onboardingRunId : null;
  if (runId === null) {
    throw new WorkFailure("invalid_input", "invalid_payload", "the payload names no run");
  }

  const [workflow] = await sql<{ owner_profile_id: string | null }[]>`
    select owner_profile_id from ops.workflows where id = ${context.item.workflowId}
  `;
  if (!workflow?.owner_profile_id) {
    throw new WorkFailure("invalid_input", "unowned_workflow", "the workflow names no owner");
  }

  const versions = await registerOnboardingComponents(sql);

  return withActor(sql, workflow.owner_profile_id, async (tx) => {
    const [run] = await tx<
      {
        subject_id: string;
        subject_data_snapshot_id: string | null;
        examination_run_id: string | null;
      }[]
    >`
      select subject_id, subject_data_snapshot_id, examination_run_id
      from coaching.onboarding_runs where id = ${runId}
    `;
    if (!run) throw new WorkFailure("invalid_input", "unknown_run", "no such onboarding run");
    if (!run.subject_data_snapshot_id || !run.examination_run_id) {
      throw new WorkFailure(
        "invalid_input",
        "examination_not_ready",
        "the run has no frozen snapshot or no completed analysis to read",
      );
    }

    const games = await readGameFacts(tx, run.subject_data_snapshot_id);
    const dimensions = await readDimensionFacts(tx, run.examination_run_id);
    const rating = await readProviderRating(tx, run.subject_id);

    const decision = decideCoverage(games, dimensions, { providerRating: rating });
    const coverageSnapshotId = await writeCoverage(tx, {
      subjectDataSnapshotId: run.subject_data_snapshot_id,
      policyComponentVersionId: versions.coverageVersionId,
      decision,
    });

    const findings = await tx<{ id: string; finding_type: string; priority: number }[]>`
      select id, finding_type, priority from analysis.findings
      where analysis_run_id = ${run.examination_run_id}
      order by priority desc, created_at
    `;
    const estimates = await tx<{ id: string; dimension_key: string; estimate: string | null }[]>`
      select e.id, d.dimension_key, e.estimate
      from analysis.player_skill_estimates e
      join analysis.skill_dimensions d on d.id = e.skill_dimension_id
      where e.analysis_run_id = ${run.examination_run_id}
      order by d.dimension_key
    `;
    const [trajectory] = await tx<{ id: string }[]>`
      select id from analysis.player_trajectory_snapshots
      where analysis_run_id = ${run.examination_run_id} limit 1
    `;
    const [session] = await tx<{ id: string }[]>`
      select id from coaching.diagnostic_sessions
      where onboarding_run_id = ${runId} and status = 'completed' limit 1
    `;

    const items = buildReport({
      coverage: decision,
      findings: findings.map((row) => ({
        id: row.id,
        findingType: row.finding_type,
        priority: row.priority,
      })),
      estimates: estimates.map((row) => ({
        id: String(row.id),
        dimensionKey: row.dimension_key,
        estimate: row.estimate === null ? null : Number(row.estimate),
      })),
      trajectorySnapshotId: trajectory?.id ?? null,
      diagnosticSessionId: session?.id ?? null,
    });

    const written = await writeBaseline(tx, {
      subjectId: run.subject_id,
      onboardingRunId: runId,
      subjectDataSnapshotId: run.subject_data_snapshot_id,
      analysisRunId: run.examination_run_id,
      coverageSnapshotId,
      layoutComponentVersionId: versions.layoutVersionId,
      diagnosticSessionId: session?.id ?? null,
      manifestSha256: manifestHash(items),
      items,
    });

    await tx`
      update coaching.onboarding_runs
      set stage = case when stage in ('analysing', 'diagnostic') then 'report_ready' else stage end,
          updated_at = now()
      where id = ${runId} and status = 'active'
    `;

    recordOnboardingEvent({
      event: "baseline_published",
      traceId: context.traceId,
      onboardingRunId: runId,
      coverageState: decision.overallState,
      limitationCount: decision.limitations.length,
      eligibleGames: decision.eligibleGames,
      reportItems: items.length,
      alreadyPublished: !written.created,
    });

    return {
      outputRef: `baseline:${written.reportId}`,
      outputSummary: {
        coverageState: decision.overallState,
        reportItems: items.length,
        duplicate: !written.created,
      },
    };
  });
}

/** The per-game facts the coverage policy reads. */
async function readGameFacts(sql: Sql, snapshotId: string): Promise<GameFacts[]> {
  const rows = await sql<
    {
      played_at: RawTimestamp;
      speed: string | null;
      has_clock: boolean;
      reached_middlegame: boolean;
      reached_endgame: boolean;
    }[]
  >`
    select r.played_at, r.speed,
           (r.time_control is not null) as has_clock,
           exists (
             select 1 from analysis.transition_assessments ta
             join analysis.subject_game_publications pub on pub.run_id = ta.analysis_run_id
             where pub.subject_game_id = g.subject_game_id and ta.phase = 'middlegame'
           ) as reached_middlegame,
           exists (
             select 1 from analysis.transition_assessments ta
             join analysis.subject_game_publications pub on pub.run_id = ta.analysis_run_id
             where pub.subject_game_id = g.subject_game_id and ta.phase = 'endgame'
           ) as reached_endgame
    from analysis.subject_data_snapshot_games g
    join chess.game_replay_revisions r on r.id = g.replay_revision_id
    where g.snapshot_id = ${snapshotId}
  `;
  return rows.map((row) => ({
    playedAt: requiredDate(row.played_at, "game_replay_revisions.played_at"),
    speed: row.speed ?? "unknown",
    hasClock: row.has_clock,
    reachedMiddlegame: row.reached_middlegame,
    reachedEndgame: row.reached_endgame,
    // Membership in the frozen snapshot *is* eligibility: E11's cohort
    // definition already applied the filter, and re-deciding it here would give
    // the report a different corpus from the estimates.
    eligible: true,
  }));
}

/** Coverage per dimension, taken from the estimates rather than recomputed. */
async function readDimensionFacts(sql: Sql, analysisRunId: string): Promise<DimensionFacts[]> {
  const rows = await sql<
    {
      dimension_key: string;
      raw_sample_size: number;
      effective_sample_size: string;
      evidence_from: RawTimestamp;
      evidence_to: RawTimestamp;
    }[]
  >`
    select d.dimension_key, e.raw_sample_size, e.effective_sample_size,
           e.evidence_from, e.evidence_to
    from analysis.player_skill_estimates e
    join analysis.skill_dimensions d on d.id = e.skill_dimension_id
    where e.analysis_run_id = ${analysisRunId} and e.window_kind = 'lifetime'
    order by d.dimension_key
  `;
  return rows.map((row) => ({
    // The estimate's dimension key carries a frame suffix; the coverage row is
    // about the evidence, which is the same whichever frame reads it.
    dimensionKey: row.dimension_key.replace(/_(objective|personal_current|peer_current|peer_stretch)$/, ""),
    observationCount: row.raw_sample_size,
    effectiveCount: Number(row.effective_sample_size),
    earliestPlayedAt: toDate(row.evidence_from),
    latestPlayedAt: toDate(row.evidence_to),
  }));
}

async function readProviderRating(sql: Sql, subjectId: string): Promise<number | null> {
  const [row] = await sql<{ rating: number | null }[]>`
    select p.rating
    from chess.subject_games sg
    join chess.game_revision_participants p on p.replay_revision_id = sg.latest_replay_revision_id
    where sg.subject_id = ${subjectId} and p.color = sg.subject_color and p.rating is not null
    order by sg.updated_at desc
    limit 1
  `;
  return row?.rating ?? null;
}

let registered = false;

export function registerOnboardingHandlers(): void {
  if (registered) return;
  registered = true;
  registerHandler(EXAMINATION_TASK, async (context) =>
    buildExamination(context, await runtimeSql()),
  );
  registerHandler(PREPARE_TASK, async (context) =>
    prepareExamination(context, await runtimeSql()),
  );
  registerHandler(EXAMINATION_REPORT_TASK, async (context) =>
    buildExaminationReport(context, await runtimeSql()),
  );
  registerHandler(ADVANCE_TASK, async (context) => advanceStage(context, await runtimeSql()));
}

async function runtimeSql(): Promise<Sql> {
  const { client } = await import("../db/client.js");
  return client as unknown as Sql;
}

// ---------------------------------------------------------------------------
// Prepare: freeze what the examination will read, and plan the work that reads it
// ---------------------------------------------------------------------------

/**
 * The step between "the games have arrived" and "the report can be built".
 *
 * It freezes the snapshot, plans the analysis run against the promoted recipe,
 * records both on the onboarding run, and — in the same transaction — queues the
 * report, the examination and the stage advance that follow. Doing the recording
 * and the queueing together is the point: a crash between them would leave a run
 * that had a snapshot and no work to consume it, which is indistinguishable from
 * a stuck user.
 *
 * Idempotent. A retry that finds the run already carrying a snapshot and an
 * analysis run returns them rather than freezing a second one — and because
 * `freezeSubjectSnapshot` and `planRun` are both idempotent by content, even a
 * retry that gets past that check converges on the same ids.
 */
export async function prepareExamination(context: WorkContext, sql: Sql): Promise<WorkResult> {
  const payload = context.item.payload as Payload;
  const runId = typeof payload.onboardingRunId === "string" ? payload.onboardingRunId : null;
  if (runId === null) {
    throw new WorkFailure("invalid_input", "invalid_payload", "the payload names no run");
  }

  const [workflow] = await sql<{ owner_profile_id: string | null }[]>`
    select owner_profile_id from ops.workflows where id = ${context.item.workflowId}
  `;
  if (!workflow?.owner_profile_id) {
    throw new WorkFailure("invalid_input", "unowned_workflow", "the workflow names no owner");
  }
  const ownerProfileId = workflow.owner_profile_id;

  const [run] = await sql<
    {
      subject_id: string;
      user_id: string;
      subject_data_snapshot_id: string | null;
      examination_run_id: string | null;
      status: string;
    }[]
  >`
    select subject_id, user_id, subject_data_snapshot_id, examination_run_id, status
    from coaching.onboarding_runs where id = ${runId}
  `;
  if (!run) throw new WorkFailure("invalid_input", "unknown_run", "no such onboarding run");
  if (run.status !== "active") {
    // Abandoned or already activated: not a failure, and not work to do again.
    return { outputRef: `onboarding-run:${runId}`, outputSummary: { skipped: run.status } };
  }
  if (run.subject_data_snapshot_id && run.examination_run_id) {
    return {
      outputRef: `analysis-run:${run.examination_run_id}`,
      outputSummary: { snapshotId: run.subject_data_snapshot_id, alreadyPrepared: true },
    };
  }

  /*
   * Wait for the games to be *rebuilt*, not analysed.
   *
   * Freezing a snapshot needs a published materialization per game, because
   * `freezeSubjectSnapshot` joins one -- but it needs nothing to have been
   * through the engine. Waiting for analysis here was what forced the entire
   * archive to be analysed: with no snapshot in existence there was nothing to
   * scope the sweep to, so it swept every game the subject owned, and this step
   * then waited for all of it. Three hundred and thirty three games were
   * analysed so that a report could read two hundred.
   *
   * Freezing first inverts it. The snapshot names the cohort, the sweep plans
   * analysis only for games a snapshot wants, and the report waits for those.
   * The games outside the cohort are never in anybody's way.
   *
   * Bound to the actor for the same reason the writes below are: RLS hides
   * `chess.subject_games` entirely from an unbound connection, so an unbound
   * count is zero however many games are waiting.
   */
  const pending = await withActor(sql, ownerProfileId, (tx) =>
    pendingMaterializationCount(tx, run.subject_id),
  );
  if (pending > 0) {
    throw new WorkFailure(
      "transient",
      "materialization_pending",
      `${pending} of this subject's games have not been rebuilt yet`,
      120,
    );
  }

  // Everything from here writes tenant tables -- `analysis.subject_data_snapshots`,
  // `analysis.runs` and their children -- whose policies resolve ownership
  // through `app.analysis_subjects` and `private.current_actor_id()`. The owner
  // was resolved at the top of this function and then never used: the writes
  // went out on the unbound connection and the snapshot insert was refused by
  // its own policy. `buildExamination` above binds the actor for exactly this
  // reason; this one did not.
  return withActor(sql, ownerProfileId, async (tx) => {
  const cohort = await registerCohortVersion(tx, {
    cohortKey: ONBOARDING_COHORT.key,
    version: ONBOARDING_COHORT.version,
    definition: ONBOARDING_COHORT.definition,
  });
  const snapshot = await freezeSubjectSnapshot(tx, {
    subjectId: run.subject_id,
    cohortVersionId: cohort.id,
    // Now, and stated: a snapshot never includes a game played after its
    // cutoff, so the report is about a period rather than about "whenever the
    // query happened to run".
    cutoff: new Date().toISOString(),
  });

  // The promotion surface, not the run type: `onboarding_examination` is the
  // surface a baseline is served from, and promoting a new method for it must
  // not silently change what a live profile reads.
  const recipe = await currentRecipeFor(tx, "onboarding_examination");
  if (!recipe) {
    // Truthful rather than a placeholder report: with no promoted recipe there
    // is no method to run, and saying so is better than inventing one.
    throw new WorkFailure(
      "unsupported",
      "no_promoted_recipe",
      "no subject_live recipe has been promoted",
    );
  }

  const planned = await planRun(tx, {
    recipeVersionId: recipe.recipeVersionId,
    scope: { subjectId: run.subject_id, subjectDataSnapshotId: snapshot.id },
    trigger: "user_request",
    actor: { kind: "user", id: ownerProfileId },
    workItemId: context.item.id,
  });

  // Recording only. The report, the examination and the advance were planned
  // with this item, and they resolve the run id from this row when they get
  // there — a worker role cannot create work, and should not be able to.
  await tx`
    update coaching.onboarding_runs
    set subject_data_snapshot_id = ${snapshot.id},
        examination_run_id = ${planned.id},
        stage = case when stage in ('linking', 'syncing') then 'analysing' else stage end,
        updated_at = now()
    where id = ${runId}
  `;

  return {
    outputRef: `analysis-run:${planned.id}`,
    outputSummary: {
      snapshotId: snapshot.id,
      games: snapshot.gameCount,
      underCovered: snapshot.underCovered,
      alreadyPlanned: planned.alreadyPlanned,
    },
    metrics: { inputCount: snapshot.gameCount, outputCount: 1 },
  };
  });
}

// ---------------------------------------------------------------------------
// Advance: move the stage when the work behind it finished
// ---------------------------------------------------------------------------

/**
 * Move the run to the stage its work has reached.
 *
 * A separate item rather than a side effect of the examination, because the
 * stage is what the person sees and the examination is what produced it: an
 * epic that couples them ends up with a report that exists and a screen that
 * still says "analysing". Setting a stage the run has already passed is a
 * no-op rather than an error — a redelivered message must not walk a journey
 * backwards.
 */
export async function advanceStage(context: WorkContext, sql: Sql): Promise<WorkResult> {
  const payload = context.item.payload as Payload;
  const runId = typeof payload.onboardingRunId === "string" ? payload.onboardingRunId : null;
  const target = typeof payload.stage === "string" ? payload.stage : null;
  if (runId === null || target === null) {
    throw new WorkFailure("invalid_input", "invalid_payload", "the payload names no run or stage");
  }
  if (!(STAGES as readonly string[]).includes(target)) {
    throw new WorkFailure("invalid_input", "unknown_stage", "that is not a stage");
  }

  const [run] = await sql<{ stage: string; status: string }[]>`
    select stage, status from coaching.onboarding_runs where id = ${runId}
  `;
  if (!run) throw new WorkFailure("invalid_input", "unknown_run", "no such onboarding run");
  if (run.status !== "active") {
    return { outputRef: `onboarding-run:${runId}`, outputSummary: { skipped: run.status } };
  }

  const from = STAGES.indexOf(run.stage as (typeof STAGES)[number]);
  const to = STAGES.indexOf(target as (typeof STAGES)[number]);
  if (to <= from) {
    return {
      outputRef: `onboarding-run:${runId}`,
      outputSummary: { stage: run.stage, moved: false },
    };
  }

  await sql`
    update coaching.onboarding_runs
    set stage = ${target}, updated_at = now()
    where id = ${runId} and status = 'active'
  `;
  return { outputRef: `onboarding-run:${runId}`, outputSummary: { stage: target, moved: true } };
}

// ---------------------------------------------------------------------------
// The report step, in onboarding's own words
// ---------------------------------------------------------------------------

/**
 * Run E15's subject report for the run `prepare` planned.
 *
 * A thin wrapper, and the reason it exists is a permission boundary rather than
 * a behaviour: the ledger lets only the API and the ops deployment create work,
 * so the whole examination is planned before any of it runs, and this item's
 * payload cannot name an analysis run that did not exist yet. Resolving it here
 * keeps E15 generic — it still takes a run id and knows nothing about
 * onboarding — and keeps the coupling to a coaching table inside the coaching
 * module.
 */
export async function buildExaminationReport(
  context: WorkContext,
  sql: Sql,
): Promise<WorkResult> {
  const payload = context.item.payload as Payload;
  const runId = typeof payload.onboardingRunId === "string" ? payload.onboardingRunId : null;
  if (runId === null) {
    throw new WorkFailure("invalid_input", "invalid_payload", "the payload names no run");
  }

  const [workflow] = await sql<{ owner_profile_id: string | null }[]>`
    select owner_profile_id from ops.workflows where id = ${context.item.workflowId}
  `;
  if (!workflow?.owner_profile_id) {
    throw new WorkFailure("invalid_input", "unowned_workflow", "the workflow names no owner");
  }
  const ownerProfileId = workflow.owner_profile_id;

  const [run] = await sql<
    { examination_run_id: string | null; status: string; subject_data_snapshot_id: string | null }[]
  >`
    select examination_run_id, status, subject_data_snapshot_id
    from coaching.onboarding_runs where id = ${runId}
  `;
  if (!run) throw new WorkFailure("invalid_input", "unknown_run", "no such onboarding run");
  if (run.status !== "active") {
    return { outputRef: `onboarding-run:${runId}`, outputSummary: { skipped: run.status } };
  }
  if (!run.examination_run_id) {
    throw new WorkFailure(
      "invalid_input",
      "run_not_prepared",
      "the onboarding run has no analysis run to report on",
    );
  }

  /*
   * The engine wait lives here now.
   *
   * `prepare` freezes the snapshot as soon as the games are rebuilt, so by the
   * time this runs the cohort is named and the sweep is analysing exactly it.
   * This is the step that cannot proceed on half-read evidence: a report over a
   * snapshot whose games have not been through the engine says the player is a
   * beginner at everything, which is not a truthful "we do not know yet" -- it
   * is a wrong answer with a confident face.
   */
  if (run.subject_data_snapshot_id) {
    const waiting = await withActor(sql, ownerProfileId, (tx) =>
      snapshotAnalysisPending(tx, run.subject_data_snapshot_id!),
    );
    if (waiting > 0) {
      throw new WorkFailure(
        "transient",
        "analysis_pending",
        `${waiting} of this report's games have not been analysed yet`,
        120,
      );
    }
  }

  return buildSubjectReport(
    { ...context, item: { ...context.item, payload: { runId: run.examination_run_id } } },
    sql,
  );
}

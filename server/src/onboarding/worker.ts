import { createHash } from "node:crypto";

import type { Sql } from "postgres";

import { registerComponent, registerComponentVersion } from "../analysis/versions.js";
import { registerHandler, type WorkContext, type WorkResult } from "../ops/handlers.js";
import { WorkFailure } from "../ops/retry.js";
import { withActor } from "../db/actor.js";
import { COVERAGE_POLICY, DIAGNOSTIC_POLICY } from "./contract.js";
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
      played_at: Date;
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
    playedAt: row.played_at,
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
      evidence_from: Date | null;
      evidence_to: Date | null;
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
    earliestPlayedAt: row.evidence_from,
    latestPlayedAt: row.evidence_to,
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
}

async function runtimeSql(): Promise<Sql> {
  const { client } = await import("../db/client.js");
  return client as unknown as Sql;
}

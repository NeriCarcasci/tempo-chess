/**
 * `npm run estimates:integration` — E15 end to end on a disposable Postgres.
 *
 * The path under test is the one a user's homepage actually takes: freeze a
 * snapshot, run the estimator over the opportunities it covers, align the
 * trajectory, derive and correct findings, render prose, publish the pointer,
 * and read the dashboard back through it.
 *
 * The assertions that matter are the refusals. A censored chance never becomes
 * a failure; a phase nobody reached produces no bin; a finding with no evidence
 * is refused at commit; prose that invents a number is stored held and is not
 * shown; and a second delivery of the same work changes nothing.
 */

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";

import { GateReport, startAnalysisHarness } from "../../analysis/gates/harness.js";
import { setAnalysisEventSink } from "../../analysis/telemetry.js";
import { setEngineEventSink } from "../../engine/telemetry.js";
import {
  PLAIN_MOVES,
  SHA,
  fixtureEngineSession,
  seedAnalysableGame,
  seedPromotedRecipe,
} from "../../engine/fixtures.js";
import { registerRecipeVersion } from "../../analysis/versions.js";
import { promoteRecipe, recordValidationRun, registerValidationDataset } from "../../analysis/validation.js";
import { freezeSubjectSnapshot, registerCohortVersion } from "../../analysis/snapshots.js";
import { planRun } from "../../analysis/runs.js";
import { readDashboard } from "../dashboard.js";
import { setEstimatesEventSink } from "../telemetry.js";
import { ESTIMATE_COMPONENT_KEYS, registerEstimateComponents } from "../store.js";
import { jsonParam } from "../../db/json.js";

const report = new GateReport("E15 estimates integration gate");
const harness = await startAnalysisHarness();
const sql = harness.sql;
setAnalysisEventSink(() => {});
setEngineEventSink(() => {});
setEstimatesEventSink(() => {});

process.env.DATABASE_URL = harness.db.urlFor("forma_analysis");
process.env.DATABASE_ROLE = "forma_analysis";
const { planGameAnalysis } = await import("../../engine/plan.js");
const { ASSESS_TASK, DEEP_TASK, SCREEN_TASK, assessTransitions, deepenGame, screenGame, setEngineSessionFactory } =
  await import("../../engine/worker.js");
const { SUBJECT_REPORT_TASK, buildSubjectReport } = await import("../worker.js");

setEngineSessionFactory(async () => fixtureEngineSession({}));

function context(taskType: string, payload: Record<string, unknown>, workflow = "") {
  return {
    item: {
      id: "1",
      workflowId: workflow,
      taskType,
      resourceClass: "aggregation" as const,
      inputRef: null,
      payload,
      attempt: 1,
      maxAttempts: 5,
      leaseOwner: "gate",
      timeoutSeconds: 300,
    },
    traceId: null,
    async checkpoint() {
      return { continue: true };
    },
  };
}

const SUFFIX = `e${Date.now().toString(36)}`;

try {
  // -------------------------------------------------------------------------
  report.section("a report needs a frozen snapshot and analysed games");

  const engineVersions = await seedPromotedRecipe(sql, SUFFIX);
  const game = await seedAnalysableGame(sql, { moves: PLAIN_MOVES });

  const planned = await planGameAnalysis(sql, {
    subjectGameId: game.subjectGameId,
    ownerProfileId: game.ownerUserId,
  });
  if (planned?.state !== "scheduled") throw new Error(`plan said ${planned?.state}`);
  const enginePayload = {
    materializationRunId: game.materializationRunId,
    engineVersionId: engineVersions.engineProfileId,
    calibrationVersionId: engineVersions.calibrationVersionId,
  };
  await screenGame(context(SCREEN_TASK, enginePayload, planned.workflowId), sql);
  await deepenGame(context(DEEP_TASK, enginePayload, planned.workflowId), sql);
  await assessTransitions(context(ASSESS_TASK, { runId: planned.runId }, planned.workflowId), sql);

  const conceptVersionId = await seedConcept();
  await seedOpportunities(game, conceptVersionId);

  const cohortVersionId = await seedCohort();
  const snapshot = await freezeSubjectSnapshot(sql, {
    subjectId: game.subjectId,
    cohortVersionId,
    cutoff: new Date(Date.now() + 60_000).toISOString(),
  });

  await report.check("the snapshot froze the game the report will read", async () => {
    const [row] = await sql<{ count: string }[]>`
      select count(*)::text as count from analysis.subject_data_snapshot_games
      where snapshot_id = ${snapshot.id}
    `;
    assert.equal(row?.count, "1");
  });

  const versions = await registerEstimateComponents(sql);
  const recipeId = await seedSubjectRecipe();
  const workflowId = await seedWorkflow(game.ownerUserId);

  const run = await planRun(sql, {
    recipeVersionId: recipeId,
    scope: { subjectId: game.subjectId, subjectDataSnapshotId: snapshot.id },
    trigger: "user_request",
    actor: { kind: "system" },
  });

  // -------------------------------------------------------------------------
  report.section("building the report");

  let result: Awaited<ReturnType<typeof buildSubjectReport>> | null = null;
  await report.check("the run produces estimates, a trajectory and findings", async () => {
    result = await buildSubjectReport(context(SUBJECT_REPORT_TASK, { runId: run.id }, workflowId), sql);
    const summary = result.outputSummary as Record<string, number>;
    assert.ok(summary.estimates > 0, "no estimate was produced");
    assert.ok(summary.trajectoryBins > 0, "no trajectory bin was produced");
  });

  await report.check("every estimate's coverage accounts for its whole sample", async () => {
    const rows = await sql<
      {
        raw_sample_size: number;
        success_count: number;
        failure_count: number;
        graded_count: number;
        censored_count: number;
        effective_sample_size: string;
      }[]
    >`
      select raw_sample_size, success_count, failure_count, graded_count, censored_count,
             effective_sample_size
      from analysis.player_skill_estimates where analysis_run_id = ${run.id}
    `;
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.equal(
        row.success_count + row.failure_count + row.graded_count + row.censored_count,
        row.raw_sample_size,
      );
      assert.ok(Number(row.effective_sample_size) <= row.raw_sample_size);
    }
  });

  await report.check("a censored chance was counted and never scored", async () => {
    const [row] = await sql<{ censored_count: number }[]>`
      select censored_count from analysis.player_skill_estimates
      where analysis_run_id = ${run.id} and censored_count > 0 limit 1
    `;
    assert.ok(row, "the fixture's censored opportunity did not reach an estimate");
  });

  await report.check("an unreached phase produced no bin at all", async () => {
    const rows = await sql<{ phase: string }[]>`
      select distinct b.phase from analysis.player_trajectory_bins b
      join analysis.player_trajectory_snapshots s on s.id = b.trajectory_snapshot_id
      where s.analysis_run_id = ${run.id}
    `;
    // The fixture game is six plies of opening. Anything else would be imputed.
    assert.deepEqual(rows.map((r) => r.phase), ["opening"]);
  });

  await report.check("every bin carries how many games reached its phase", async () => {
    const rows = await sql<{ phase_reach_rate: string; games_contributing: number }[]>`
      select b.phase_reach_rate, b.games_contributing from analysis.player_trajectory_bins b
      join analysis.player_trajectory_snapshots s on s.id = b.trajectory_snapshot_id
      where s.analysis_run_id = ${run.id}
    `;
    for (const row of rows) {
      assert.ok(Number(row.phase_reach_rate) > 0 && Number(row.phase_reach_rate) <= 1);
      assert.ok(row.games_contributing > 0);
    }
  });

  // -------------------------------------------------------------------------
  report.section("a claim without evidence cannot be committed");

  await report.check("a factual finding with no evidence is refused at commit", async () => {
    await assert.rejects(
      () =>
        sql.begin(async (tx) => {
          await tx`
            insert into analysis.findings (
              analysis_run_id, subject_id, finding_type, priority, confidence_tier,
              claim, claim_family
            ) values (
              ${run.id}, ${game.subjectId}, 'strength', 50, 'high',
              ${jsonParam({ dimension: "nothing" })}::jsonb, 'concept_success'
            )
          `;
        }),
      /no supporting evidence/,
    );
  });

  await report.check("an insufficient-evidence finding needs none", async () => {
    await sql.begin(async (tx) => {
      await tx`
        insert into analysis.findings (
          analysis_run_id, subject_id, finding_type, priority, confidence_tier,
          claim, claim_family
        ) values (
          ${run.id}, ${game.subjectId}, 'insufficient_evidence', 10, 'low',
          ${jsonParam({ dimension: "nothing yet" })}::jsonb, 'concept_success'
        )
      `;
    });
  });

  await report.check("an improvement claim must cite the estimate that measured it", async () => {
    await assert.rejects(
      () => sql`
        insert into analysis.findings (
          analysis_run_id, subject_id, finding_type, priority, confidence_tier,
          claim, claim_family
        ) values (
          ${run.id}, ${game.subjectId}, 'established_improvement', 90, 'high',
          ${jsonParam({ dimension: "wishful" })}::jsonb, 'personal_change'
        )
      `,
      /findings_improvement_needs_estimate/,
    );
  });

  // -------------------------------------------------------------------------
  report.section("the renderer boundary holds in the database");

  await report.check("every explanation pins the hash of its structured input", async () => {
    const rows = await sql<{ structured_input_hash: string; safety_state: string }[]>`
      select r.structured_input_hash, r.safety_state
      from analysis.rendered_explanations r
      join analysis.findings f on f.id = r.finding_id
      where f.analysis_run_id = ${run.id}
    `;
    assert.ok(rows.length > 0, "no prose was rendered");
    for (const row of rows) assert.match(row.structured_input_hash, /^[0-9a-f]{64}$/);
  });

  await report.check("held text has to say why it was held", async () => {
    await assert.rejects(
      () => sql`
        insert into analysis.rendered_explanations (
          finding_id, renderer_component_version_id, locale, tone, reading_level,
          structured_input_hash, rendered_text, safety_state
        )
        select f.id, ${versions.rendererVersionId}, 'fr', 'plain', 'general',
               ${"a".repeat(64)}, 'du texte', 'held'
        from analysis.findings f where f.analysis_run_id = ${run.id} limit 1
      `,
      /rendered_state_explained/,
    );
  });

  await report.check("prose is immutable, so editing wording cannot edit a fact", async () => {
    await assert.rejects(
      () => sql`update analysis.rendered_explanations set rendered_text = 'nicer'`,
      /immutable|refuse/i,
    );
  });

  // -------------------------------------------------------------------------
  report.section("publication and the dashboard");

  await report.check("the live pointer moved to this run", async () => {
    const [row] = await sql<{ run_id: string }[]>`
      select run_id from analysis.subject_live_publications where subject_id = ${game.subjectId}
    `;
    assert.equal(row?.run_id, run.id);
  });

  await report.check("the dashboard reads the published report", async () => {
    const dashboard = await readDashboard(sql, {
      subjectId: game.subjectId,
      ownerProfileId: game.ownerUserId,
    });
    assert.ok(dashboard, "the published subject has no dashboard");
    assert.equal(dashboard!.runId, run.id);
    assert.ok(dashboard!.estimates.length > 0);
    assert.equal(dashboard!.sections.trajectory, "published");
    // Later epics. Named states rather than absent keys.
    assert.equal(dashboard!.sections.goal, "unavailable");
    assert.equal(dashboard!.sections.connections, "unavailable");
  });

  await report.check("the dashboard names what is missing rather than hiding it", async () => {
    const dashboard = await readDashboard(sql, {
      subjectId: game.subjectId,
      ownerProfileId: game.ownerUserId,
    });
    assert.ok(dashboard!.trajectory.unreachedPhases.includes("endgame"));
    assert.ok(
      dashboard!.coverageWarnings.some((warning) => warning.includes("endgame")),
      "the report drew a curve over a phase nobody played without saying so",
    );
  });

  await report.check("an unavailable estimate carries a reason, never a zero", async () => {
    const dashboard = await readDashboard(sql, {
      subjectId: game.subjectId,
      ownerProfileId: game.ownerUserId,
    });
    for (const estimate of dashboard!.estimates) {
      assert.equal(
        estimate.estimate === null,
        estimate.unavailableReason !== null,
        `${estimate.dimensionKey} has neither a value nor a reason, or both`,
      );
    }
  });

  await report.check("held prose is not shown to the reader", async () => {
    const dashboard = await readDashboard(sql, {
      subjectId: game.subjectId,
      ownerProfileId: game.ownerUserId,
    });
    for (const finding of dashboard!.findings) {
      if (finding.explanationState !== "passed") assert.equal(finding.explanation, null);
    }
  });

  await report.check("another owner sees nothing rather than a 403", async () => {
    const dashboard = await readDashboard(sql, {
      subjectId: game.subjectId,
      ownerProfileId: randomUUID(),
    });
    assert.equal(dashboard, null);
  });

  await report.check("a duplicate delivery is acknowledged, not repeated", async () => {
    const before = await countEstimates(run.id);
    const second = await buildSubjectReport(
      context(SUBJECT_REPORT_TASK, { runId: run.id }, workflowId),
      sql,
    );
    assert.equal((second.outputSummary as Record<string, unknown>).duplicate, true);
    assert.equal(await countEstimates(run.id), before);
  });

  await report.check("estimates cannot be restated after the fact", async () => {
    await assert.rejects(
      () => sql`update analysis.player_skill_estimates set estimate = 1`,
      /immutable|refuse/i,
    );
  });
} finally {
  await harness.destroy();
}

report.finish();

// ---------------------------------------------------------------------------

async function countEstimates(runId: string): Promise<number> {
  const [row] = await sql<{ count: string }[]>`
    select count(*)::text as count from analysis.player_skill_estimates
    where analysis_run_id = ${runId}
  `;
  return Number(row!.count);
}

async function seedConcept(): Promise<string> {
  const [concept] = await sql<{ id: string }[]>`
    insert into analysis.concepts (slug, family, category, display_name)
    values (${`fork_${SUFFIX}`}, 'tactics', 'tactical', 'Fork')
    returning id
  `;
  const [version] = await sql<{ id: string }[]>`
    insert into analysis.concept_versions (
      concept_id, version_no, human_definition, detector_contract, supported_roles,
      rubric_contract, version_hash
    ) values (
      ${concept!.id}, 1, 'A fork attacks two targets at once.',
      ${jsonParam({ detector: "gate" })}::jsonb, array['recognize','execute']::text[],
      ${jsonParam({ rubric: "gate" })}::jsonb, ${SHA(`concept-${SUFFIX}`)}
    )
    returning id
  `;
  return version!.id;
}

/**
 * A spread of opportunities: successes, failures and one censored chance.
 *
 * The censored one is the point of the fixture. It must reach the coverage
 * counts and never reach the estimate.
 */
async function seedOpportunities(
  game: {
    subjectId: string;
    subjectGameId: string;
    materializationRunId: string;
    replayRevisionId: string;
  },
  conceptVersionId: string,
): Promise<void> {
  const [evidence] = await sql<{ id: string }[]>`
    insert into analysis.evidence_items (
      run_id, evidence_kind, subject_id, subject_game_id, occurred_at
    ) values (
      ${game.materializationRunId}, 'opportunity', ${game.subjectId},
      ${game.subjectGameId}, now()
    )
    returning id
  `;
  void evidence;

  for (let i = 0; i < 60; i += 1) {
    const censored = i === 59;
    const [event] = await sql<{ id: string }[]>`
      insert into analysis.chess_events (
        run_id, replay_revision_id, subject_game_id, event_type, start_ply, focal_ply,
        end_ply, actor_color, facts, completeness
      ) values (
        ${game.materializationRunId}, ${game.replayRevisionId}, ${game.subjectGameId},
        'tactical_opportunity', ${i}, ${i}, ${i}, 'white', ${jsonParam({ gate: true })}::jsonb,
        ${censored ? "censored" : "complete"}
      )
      returning id
    `;
    await sql`
      insert into analysis.concept_opportunities (
        run_id, subject_id, subject_game_id, event_id, concept_version_id, role,
        opportunity_ply, response_ply, response_observed, censored_reason, success,
        evidence_source_kind, occurred_at
      ) values (
        ${game.materializationRunId}, ${game.subjectId}, ${game.subjectGameId},
        ${event!.id}, ${conceptVersionId}, 'recognize', ${i},
        ${censored ? null : i + 1}, ${!censored},
        ${censored ? "subject_never_on_move" : null},
        ${censored ? null : i % 20 !== 0},
        'deterministic', now()
      )
    `;
  }
}

/**
 * A cohort that selects the fixture game and nothing it does not describe.
 *
 * Registered through `registerCohortVersion` rather than inserted, so the
 * definition goes through the same schema the real path uses: a hand-written
 * row that the validator would have rejected is a fixture testing a shape
 * production never sees.
 */
async function seedCohort(): Promise<string> {
  const registered = await registerCohortVersion(sql, {
    cohortKey: `gate_${SUFFIX}`,
    version: "1",
    definition: {
      // seedAnalysableGame writes a rated blitz Lichess game with no clocks.
      providers: ["lichess"],
      rated: "rated",
      speeds: ["blitz"],
      includeBotOpponents: false,
      playedFrom: null,
      playedTo: null,
      maxGames: null,
      // One game is the fixture. A floor of two would mark the snapshot
      // under-covered, which is a real state but not the one under test here.
      minGames: 1,
      requireClocks: false,
      ratingMin: null,
      ratingMax: null,
    },
  });
  return registered.id;
}

async function seedSubjectRecipe(): Promise<string> {
  const recipe = await registerRecipeVersion(sql, {
    recipeKey: `subject_report_${SUFFIX}`,
    version: "1",
    runType: "subject_live",
    inputSchemaVersion: "subject_snapshot.v1",
    outputSchemaVersion: "subject_report.v1",
    requiredArtifacts: ["skill_estimates", "trajectory_bins", "findings"],
    roles: {
      estimator: { componentKey: ESTIMATE_COMPONENT_KEYS.estimator, version: "estimator_v1" },
      trajectory_aligner: {
        componentKey: ESTIMATE_COMPONENT_KEYS.alignment,
        version: "trajectory_alignment_v1",
      },
      finding_rules: {
        componentKey: ESTIMATE_COMPONENT_KEYS.findingRules,
        version: "finding_rules_v1",
      },
      renderer: { componentKey: ESTIMATE_COMPONENT_KEYS.renderer, version: "template_renderer_v1" },
    },
  });
  const dataset = await registerValidationDataset(sql, {
    datasetKey: `subject_golden_${SUFFIX}`,
    version: "1",
    manifestSha256: SHA(`subject-golden-${SUFFIX}`),
    samplingDescription: "The committed subject-report fixture.",
    accountDisjoint: true,
    chronologicalSplit: false,
    governanceClass: "internal",
  });
  const validationRunId = await recordValidationRun(sql, {
    datasetId: dataset.id,
    candidate: { recipeVersionId: recipe.id },
    executionRevision: "gate",
    status: "passed",
    outputChecksum: SHA(`subject-golden-output-${SUFFIX}`),
    metrics: [{ metricKey: "estimate_coverage", sampleSize: 1, value: 1 }],
  });
  await promoteRecipe(sql, {
    surface: "live_player_profile",
    recipeVersionId: recipe.id,
    reason: "E15 gate",
    actor: { kind: "system" },
    validationRunId,
  });
  return recipe.id;
}

async function seedWorkflow(ownerProfileId: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into ops.workflows (kind, owner_profile_id, resource_type, resource_id, state)
    values ('subject_estimation', ${ownerProfileId}, 'subject', ${randomUUID()}, 'running')
    returning id
  `;
  return row!.id;
}

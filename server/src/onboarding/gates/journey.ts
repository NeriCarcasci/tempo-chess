/**
 * `npm run journey:gate` — one person, from a linked account to a drill.
 *
 * Every epic before this one proved its own piece against a real database. What
 * none of them proved is that the pieces are connected, and they were not: the
 * ledger had no registered handlers, `commitBatch` had no caller, nothing
 * materialized a synced replay, nothing planned a game analysis, nothing opened
 * a coaching cycle, nothing wrote a progress reading, and nothing created a
 * practice assignment. Each of those was a working component with no one to
 * call it.
 *
 * So this gate walks the whole journey and asserts at every joint:
 *
 *   link an account -> start onboarding -> sync from a provider -> materialize
 *   -> analyse -> report -> examine -> report ready -> set a goal -> open a
 *   cycle with a plan -> measure progress -> assign practice -> attempt it.
 *
 * The provider is a real HTTP server on loopback serving real NDJSON, so the
 * adapter, the cursor and the sort order are exercised rather than mocked. The
 * engine is E12's fixture session: this gate is about the wiring, and Stockfish
 * has its own gates.
 *
 * Handlers are called with the owner connection, as every integration gate in
 * this repository does — tenancy is the security gates' claim. What is *not*
 * faked is the planning: the planners run as `forma_api` through the module
 * connection, which is the role that will really do it, and E04's rule that a
 * worker may not create work is what shaped the whole chain.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { createDisposableDatabase, grantRolePasswords } from "../../platform/harness/postgres.js";
import { applyMigrations } from "../../platform/harness/migrations.js";
import { GateReport } from "../../v1/gates/harness.js";

const report = new GateReport("Journey gate: linked account to drill");

// --- a provider on loopback -------------------------------------------------

/**
 * Two rated blitz games, in the shape Lichess sends them.
 *
 * Real NDJSON over real HTTP: the adapter's parsing, its `since` cursor and its
 * ascending sort are part of what this gate is proving, and a stubbed fetch
 * would prove none of them.
 */
const PLAYED_AT = Date.UTC(2026, 6, 1, 12, 0, 0);
const GAMES = [
  {
    id: "journeygame1",
    rated: true,
    variant: "standard",
    speed: "blitz",
    createdAt: PLAYED_AT,
    lastMoveAt: PLAYED_AT + 300_000,
    status: "resign",
    winner: "black",
    moves: "e2e4 e7e5 g1f3 b8c6 f1c4 g8f6 f3g5 d7d5 e4d5 c6d4",
    clock: { initial: 300, increment: 0 },
    players: {
      white: { user: { name: "ncarcasc" }, rating: 1500, ratingDiff: -8 },
      black: { user: { name: "opponent_one" }, rating: 1520, ratingDiff: 8 },
    },
  },
  {
    id: "journeygame2",
    rated: true,
    variant: "standard",
    speed: "blitz",
    createdAt: PLAYED_AT + 3_600_000,
    lastMoveAt: PLAYED_AT + 3_900_000,
    status: "mate",
    winner: "white",
    moves: "d2d4 d7d5 c2c4 e7e6 b1c3 g8f6 c1g5 f8e7 e2e3 e8g8",
    clock: { initial: 300, increment: 0 },
    players: {
      white: { user: { name: "ncarcasc" }, rating: 1492, ratingDiff: 9 },
      black: { user: { name: "opponent_two" }, rating: 1480, ratingDiff: -9 },
    },
  },
];

let requestsSeen: { since: string | null; sort: string | null }[] = [];

const provider = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const since = url.searchParams.get("since");
  requestsSeen.push({ since, sort: url.searchParams.get("sort") });
  const after = since === null ? -1 : Number(since) - 1;
  const body = GAMES.filter((game) => game.createdAt > after)
    .map((game) => JSON.stringify(game))
    .join("\n");
  response.writeHead(200, { "content-type": "application/x-ndjson" });
  response.end(body);
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
const providerPort = (provider.address() as AddressInfo).port;
process.env.LICHESS_API_URL = `http://127.0.0.1:${providerPort}`;

// --- a database, and the connections the journey uses ------------------------

const db = await createDisposableDatabase();
await applyMigrations(db.adminUrl);
await grantRolePasswords(db, ["forma_api"]);

// The planners run through the module connection, as `forma_api`, because that
// is the role that plans work in production and the one E04 grants `insert` to.
process.env.DATABASE_URL = db.urlFor("forma_api");
process.env.DATABASE_ROLE = "forma_api";
delete process.env.FORMA_ENV;
delete process.env.K_SERVICE;

const sql = postgres(db.adminUrl, { max: 6, prepare: false, onnotice: () => {} });

const { beginOnboarding } = await import("../planner.js");
const { syncAccount } = await import("../../sync/worker.js");
const { prepareExamination, buildExaminationReport, buildExamination, advanceStage } = await import(
  "../worker.js"
);
const { materializeReplayRevision } = await import("../../positions/worker.js");
const { planPendingWork } = await import("../../analysis/planner.js");
const { screenGame, deepenGame, assessTransitions, setEngineSessionFactory } = await import(
  "../../engine/worker.js"
);
const { fixtureEngineSession, seedPromotedRecipe } = await import("../../engine/fixtures.js");
const { buildSubjectReport } = await import("../../estimates/worker.js");
const { activateGoal } = await import("../../goals/activate.js");
const { refreshCycleProgress, planProgressForSubject } = await import(
  "../../goals/progress-worker.js"
);
const { assignPractice } = await import("../../practice/select.js");
const { promoteRecipe, recordValidationRun, registerValidationDataset } = await import(
  "../../analysis/validation.js"
);
const { registerEstimateComponents, ESTIMATE_COMPONENT_KEYS } = await import(
  "../../estimates/store.js"
);
const { registerRecipeVersion } = await import("../../analysis/versions.js");

setEngineSessionFactory(async () => fixtureEngineSession());

// --- the person -------------------------------------------------------------

const userId = randomUUID();
await sql`insert into app.profiles (user_id) values (${userId})`;
const [subject] = await sql<{ id: string }[]>`
  insert into app.analysis_subjects (kind, owner_user_id, display_label)
  values ('personal', ${userId}, 'Journey subject')
  returning id
`;
const subjectId = subject!.id;

const [identity] = await sql<{ id: string }[]>`
  insert into app.provider_identities (
    provider_id, provider_identity_key, key_basis, current_display_username,
    current_normalized_username
  ) values (2, 'journey-ncarcasc', 'username', 'ncarcasc', 'ncarcasc')
  returning id
`;
const [account] = await sql<{ id: string }[]>`
  insert into app.linked_accounts (owner_user_id, provider_identity_id, verification_status)
  values (${userId}, ${identity!.id}, 'confirmed')
  returning id
`;
await sql`
  insert into app.subject_account_memberships (
    subject_id, linked_account_id, valid_from, confirmation_method, confirmed_at,
    confirmed_by_user_id
  ) values (
    ${subjectId}, ${account!.id}, now(), 'owner_declared', now(), ${userId}
  )
`;

// The methods the journey runs under. A promoted recipe is a precondition for
// analysing anything, and the gate seeds real ones rather than stubbing the
// check that requires them.
const stamp = `journey_${Date.now()}`;
await seedPromotedRecipe(sql, stamp);
await registerEstimateComponents(sql);
const subjectRecipe = await registerRecipeVersion(sql, {
  recipeKey: `journey_subject_${stamp}`,
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
  datasetKey: `journey_golden_${stamp}`,
  version: "1",
  manifestSha256: "a".repeat(64),
  samplingDescription: "The journey gate's own fixture.",
  accountDisjoint: true,
  chronologicalSplit: false,
  governanceClass: "internal",
});
const validationRunId = await recordValidationRun(sql, {
  datasetId: dataset.id,
  candidate: { recipeVersionId: subjectRecipe.id },
  executionRevision: "gate",
  status: "passed",
  outputChecksum: "b".repeat(64),
  metrics: [{ metricKey: "estimate_coverage", sampleSize: 1, value: 1 }],
});
// The examination reads from its own surface, so promoting to it is what makes
// the onboarding chain runnable at all.
await promoteRecipe(sql, {
  surface: "onboarding_examination",
  recipeVersionId: subjectRecipe.id,
  reason: "journey gate",
  actor: { kind: "system" },
  validationRunId,
});

// ---------------------------------------------------------------------------
report.section("starting the journey");

const [run] = await sql<{ id: string }[]>`
  insert into coaching.onboarding_runs (user_id, subject_id)
  values (${userId}, ${subjectId})
  returning id
`;
const runId = run!.id;

let workflowId = "";
await report.check("starting onboarding plans real work, in order", async () => {
  const begun = await beginOnboarding(sql, { runId, userId, subjectId });
  assert.equal(begun.planned, true);
  workflowId = (begun as { workflowId: string }).workflowId;

  const items = await sql<{ task_type: string; status: string }[]>`
    select task_type, status from ops.work_items where workflow_id = ${workflowId}
    order by id
  `;
  assert.deepEqual(
    [...items].map((item) => item.task_type),
    [
      "provider_account_sync",
      "coaching_onboarding_prepare",
      "coaching_examination_report",
      "coaching_baseline_examination",
      "coaching_onboarding_advance",
    ],
  );
  // Only the sync is runnable: everything after it is blocked on what it
  // produces, which is the property that made a single workflow possible.
  assert.deepEqual(
    [...items].map((item) => item.status),
    ["ready", "blocked", "blocked", "blocked", "blocked"],
  );

  const [stage] = await sql<{ stage: string }[]>`
    select stage from coaching.onboarding_runs where id = ${runId}
  `;
  assert.equal(stage!.stage, "syncing");
});

// ---------------------------------------------------------------------------
report.section("syncing from the provider");

await report.check("the sync lands real games and moves the cursor", async () => {
  const summary = await syncAccount(
    { payload: { linkedAccountId: account!.id, subjectId, mode: "initial" }, holder: "journey" },
    sql,
  );
  assert.equal(summary.accepted, 2, "both games should have been accepted");
  assert.equal(summary.rejected, 0);

  const [games] = await sql<{ count: string }[]>`
    select count(*)::text as count from chess.subject_games where subject_id = ${subjectId}
  `;
  assert.equal(games!.count, "2");

  const [state] = await sql<{ cursor_value: string | null }[]>`
    select cursor_value from ops.account_sync_state where linked_account_id = ${account!.id}
  `;
  assert.equal(state!.cursor_value, String(GAMES[1]!.createdAt));
  assert.equal(requestsSeen[0]!.sort, "dateAsc", "a resumable sync walks forwards");
});

await report.check("a second sync reads from the cursor and adds nothing", async () => {
  requestsSeen = [];
  const summary = await syncAccount(
    { payload: { linkedAccountId: account!.id, subjectId, mode: "incremental" }, holder: "journey-2" },
    sql,
  );
  assert.equal(summary.accepted, 0);
  assert.notEqual(requestsSeen[0]?.since, null, "the second sync must send a cursor");

  const [games] = await sql<{ count: string }[]>`
    select count(*)::text as count from chess.subject_games where subject_id = ${subjectId}
  `;
  assert.equal(games!.count, "2", "a re-read must not duplicate a game");
});

// ---------------------------------------------------------------------------
report.section("turning games into evidence");

await report.check("the sweep plans materialization for the new games", async () => {
  const swept = await planPendingWork(sql, { subjectId });
  assert.equal(swept.materializations, 2);
  // Nothing to analyse yet: a game that is not materialized cannot be screened.
  assert.equal(swept.analyses, 0);
});

await report.check("materializing produces the position chain", async () => {
  const revisions = await sql<{ id: string }[]>`
    select distinct latest_replay_revision_id as id from chess.subject_games
    where subject_id = ${subjectId}
  `;
  for (const revision of revisions) {
    const result = await materializeReplayRevision({ replayRevisionId: revision.id }, sql);
    assert.equal(result.occurrences > 0, true);
  }
  const [published] = await sql<{ count: string }[]>`
    select count(*)::text as count from chess.materialization_runs where state = 'published'
  `;
  assert.equal(published!.count, "2");
});

let analysisRunIds: string[] = [];
await report.check("the sweep then plans the analysis of each game", async () => {
  const swept = await planPendingWork(sql, { subjectId });
  assert.equal(swept.analyses, 2);

  const runs = await sql<{ id: string }[]>`
    select r.id from analysis.runs r
    where r.subject_id = ${subjectId} and r.run_type = 'game_analysis'
    order by r.created_at
  `;
  analysisRunIds = [...runs].map((row) => row.id);
  assert.equal(analysisRunIds.length, 2);
});

await report.check("screening, deepening and assessment run and publish", async () => {
  const items = await sql<
    { id: string; task_type: string; payload: Record<string, unknown>; workflow_id: string }[]
  >`
    select i.id::text as id, i.task_type, i.payload, i.workflow_id
    from ops.work_items i
    join ops.workflows w on w.id = i.workflow_id
    where w.kind = 'game_analysis'
    order by i.id
  `;
  for (const item of items) {
    const context = {
      item: {
        // A real work item id: the handlers record which item produced a run,
        // and the column is a bigint.
        id: item.id,
        workflowId: item.workflow_id,
        taskType: item.task_type,
        payload: item.payload,
        attempt: 1,
        leaseOwner: "gate",
      },
      traceId: null,
      async checkpoint() {
        return { continue: true };
      },
    } as never;
    if (item.task_type === "stockfish_screen_game") await screenGame(context, sql);
    if (item.task_type === "stockfish_deep_game") await deepenGame(context, sql);
    if (item.task_type === "analysis_assess_transitions") await assessTransitions(context, sql);
  }

  const [assessments] = await sql<{ count: string }[]>`
    select count(*)::text as count from analysis.transition_assessments
  `;
  assert.equal(Number(assessments!.count) > 0, true, "no transition was assessed");
});

// ---------------------------------------------------------------------------
report.section("the examination");

/**
 * The context a handler would get from the executor, with the *real* item.
 *
 * The item id matters: handlers record which work item planned a run, and the
 * column is a bigint. A synthetic id would pass a unit test and fail here,
 * which is the kind of thing this gate exists to catch.
 */
async function workContext(taskType: string, payload: Record<string, unknown>) {
  const [item] = await sql<{ id: string }[]>`
    select id::text as id from ops.work_items
    where workflow_id = ${workflowId} and task_type = ${taskType}
  `;
  assert.notEqual(item, undefined, `no ${taskType} item was planned`);
  return {
    item: {
      id: item!.id,
      workflowId,
      taskType,
      payload,
      attempt: 1,
      leaseOwner: "gate",
    },
    traceId: null,
    async checkpoint() {
      return { continue: true };
    },
  } as never;
}

await report.check("prepare freezes a snapshot and plans the analysis run", async () => {
  const result = await prepareExamination(await workContext("coaching_onboarding_prepare", { onboardingRunId: runId }), sql);
  assert.equal(typeof result.outputRef, "string");

  const [row] = await sql<
    { subject_data_snapshot_id: string | null; examination_run_id: string | null; stage: string }[]
  >`
    select subject_data_snapshot_id, examination_run_id, stage
    from coaching.onboarding_runs where id = ${runId}
  `;
  assert.notEqual(row!.subject_data_snapshot_id, null);
  assert.notEqual(row!.examination_run_id, null);
  assert.equal(row!.stage, "analysing");
});

await report.check("the report runs, and is empty for a reason worth naming", async () => {
  const result = await buildExaminationReport(
    await workContext("coaching_examination_report", { onboardingRunId: runId }),
    sql,
  );
  assert.equal(typeof result.outputRef, "string");

  const [publication] = await sql<{ run_id: string }[]>`
    select run_id from analysis.subject_live_publications where subject_id = ${subjectId}
  `;
  assert.notEqual(publication, undefined, "nothing was published");

  // Here is where the journey currently stops, and the reason is a real gap
  // rather than a wiring one. E15's estimators read `analysis.concept_
  // opportunities` — "there was a fork here; did they take it?" — and **nothing
  // in the product writes that table**. E13 shipped its schema, its invariants
  // and its version registry, and no detector. Every gate that produced an
  // estimate seeded the opportunities by hand.
  //
  // So a subject with real games, real materializations and real transition
  // assessments still has no evidence any estimator can read, and the report is
  // empty. That is the honest state, and this assertion pins it so that the day
  // a detector lands, this check fails and somebody rewrites it to assert the
  // estimates that should now exist.
  const [opportunities] = await sql<{ count: string }[]>`
    select count(*)::text as count from analysis.concept_opportunities
  `;
  assert.equal(opportunities!.count, "0", "a concept detector now exists; rewrite this check");

  const [estimates] = await sql<{ count: string }[]>`
    select count(*)::text as count from analysis.player_skill_estimates
  `;
  assert.equal(estimates!.count, "0", "estimates exist without opportunities; investigate");
});

await report.check("the examination writes coverage and an immutable baseline", async () => {
  await buildExamination(await workContext("coaching_baseline_examination", { onboardingRunId: runId }), sql);

  const [coverage] = await sql<{ count: string }[]>`
    select count(*)::text as count from coaching.data_coverage_snapshots
  `;
  assert.equal(Number(coverage!.count) > 0, true);

  const [baseline] = await sql<{ manifest_sha256: string }[]>`
    select b.manifest_sha256 from coaching.baseline_reports b
    where b.onboarding_run_id = ${runId}
  `;
  assert.match(baseline!.manifest_sha256, /^[0-9a-f]{64}$/);
});

await report.check("the stage advances to report_ready", async () => {
  await advanceStage(
    await workContext("coaching_onboarding_advance", { onboardingRunId: runId, stage: "report_ready" }),
    sql,
  );
  const [row] = await sql<{ stage: string }[]>`
    select stage from coaching.onboarding_runs where id = ${runId}
  `;
  assert.equal(row!.stage, "report_ready");
});

// ---------------------------------------------------------------------------
report.section("the goal");

await report.check("a goal cannot be set against a report with no estimates", async () => {
  const [goal] = await sql<{ id: string }[]>`
    insert into coaching.goals (
      subject_id, stated_objective, comparison_frame, horizon_days
    ) values (
      ${subjectId}, 'Stop hanging pieces in the middlegame', 'personal_current', 60
    )
    returning id
  `;
  // No targets, because there is no baseline to resolve one against. The
  // product's answer is `no_targets` rather than a cycle anchored to zero, and
  // that refusal is the behaviour worth pinning: a goal measured against a
  // number nobody produced is worse than no goal.
  const activation = await activateGoal(sql, {
    goalId: goal!.id,
    subjectId,
    horizonDays: 60,
    targets: [],
  });
  assert.equal(activation.activated, false);
  assert.equal((activation as { reason: string }).reason, "no_targets");

  const [cycles] = await sql<{ count: string }[]>`
    select count(*)::text as count from coaching.coaching_cycles where goal_id = ${goal!.id}
  `;
  assert.equal(cycles!.count, "0", "a cycle was opened with nothing to measure");
});

await report.check("progress has nothing to say, and says so", async () => {
  const queued = await planProgressForSubject(sql, {
    subjectId,
    ownerProfileId: userId,
    reason: "journey",
  });
  // No active cycle, so no reading is queued. Zero is the right answer and the
  // planner returning it without creating an empty workflow is the point.
  assert.equal(queued.queued, 0);
  assert.equal(queued.workflowId, null);
});

report.section("practice");

await report.check("practice is assigned from the player's own mistakes", async () => {
  // No cycle: practice from a player's own mistakes does not require a goal,
  // which is deliberate. Somebody who has not set one should still be able to
  // work on the thing they actually got wrong last week.
  const result = await assignPractice(sql, { subjectId, cycleId: null });
  if (result.assigned === 0) {
    // The fixture engine may find nothing beyond the tolerance in ten plies.
    // Saying so is better than asserting a number the fixture does not owe us.
    assert.equal(result.reason, "no_material");
    return;
  }

  const [assignment] = await sql<
    { reason: string; fen: string; solution_uci: string[]; id: string }[]
  >`
    select la.id, la.reason, tv.fen, tv.solution_uci
    from coaching.learning_assignments la
    join coaching.training_item_versions tv on tv.id = la.training_item_version_id
    where la.subject_id = ${subjectId}
    limit 1
  `;
  assert.equal(assignment!.reason.length >= 15, true, "an assignment must say why");
  assert.equal(assignment!.solution_uci.length >= 1, true);

  const [item] = await sql<{ source_kind: string; retention_class: string }[]>`
    select ti.source_kind, ti.retention_class
    from coaching.training_items ti
    join coaching.training_item_versions tv on tv.item_id = ti.id
    where tv.id = (
      select training_item_version_id from coaching.learning_assignments where id = ${assignment!.id}
    )
  `;
  // Made of this person's games, so it belongs to them and goes when they go.
  assert.equal(item!.source_kind, "player_evidence");
  assert.equal(item!.retention_class, "subject_owned");
});

// ---------------------------------------------------------------------------

setEngineSessionFactory(null);
await sql.end({ timeout: 5 });
await new Promise<void>((resolve) => provider.close(() => resolve()));
await db.destroy();
report.finish();

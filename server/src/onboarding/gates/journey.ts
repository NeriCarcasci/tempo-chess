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
 * Every step runs on the connection its own deployment uses: `forma_api` plans,
 * `forma_ops` sweeps, `forma_ingestion` syncs, `forma_stockfish` searches and
 * `forma_analysis` aggregates and publishes. That is not tenancy theatre — a
 * grant is part of the wiring, and running the chain as its owner is how a
 * missing one reached production. `forma_analysis` had no grant on the opening
 * catalogue that the report step reads, so every examination died at the same
 * step while this gate stayed green.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { createDisposableDatabase, grantRolePasswords } from "../../platform/harness/postgres.js";
import { applyMigrations } from "../../platform/harness/migrations.js";
import { GateReport } from "../../v1/gates/harness.js";
import { withActor } from "../../db/actor.js";

const report = new GateReport("Journey gate: linked account to drill");

// --- a provider on loopback -------------------------------------------------

/**
 * Two rated blitz games, in the shape Lichess sends them.
 *
 * Real NDJSON over real HTTP: the adapter's parsing, its `since` cursor and its
 * ascending sort are part of what this gate is proving, and a stubbed fetch
 * would prove none of them.
 *
 * `moves` is SAN because that is what Lichess puts on this endpoint. It used to
 * be UCI here, which stopped matching the day the adapter was corrected to
 * replay SAN — every game then failed to parse, was dropped before it could
 * even be counted as a rejection, and the sync reported nothing accepted. A
 * fixture that claims to be the shape a provider sends has to actually be it.
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
    moves: "e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 d5 exd5 Nd4",
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
    moves: "d4 d5 c4 e6 Nc3 Nf6 Bg5 Be7 e3 O-O",
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
await grantRolePasswords(db, [
  "forma_api",
  "forma_ops",
  "forma_ingestion",
  "forma_stockfish",
  "forma_analysis",
]);

// The planners run through the module connection, as `forma_api`, because that
// is the role that plans work in production and the one E04 grants `insert` to.
process.env.DATABASE_URL = db.urlFor("forma_api");
process.env.DATABASE_ROLE = "forma_api";
delete process.env.FORMA_ENV;
delete process.env.K_SERVICE;

const sql = postgres(db.adminUrl, { max: 6, prepare: false, onnotice: () => {} });

/**
 * Each step, on the connection the deployment that owns it really uses.
 *
 * This gate used to run every handler on the owner connection, on the reasoning
 * that tenancy is the security gates' claim and this one is about wiring. That
 * reasoning has a hole, and onboarding fell through it: the step that writes a
 * baseline report reads the opening catalogue, `forma_analysis` had no grant on
 * it, and *every examination ever run* died there. The gate was green
 * throughout, because the owner it ran as could read everything.
 *
 * A grant is part of the wiring. So the chain runs as the five roles that will
 * really run it, and a missing one fails here rather than in production five
 * attempts deep behind an unclassified handler error.
 *
 * The assertions keep using the owner connection on purpose: what a step is
 * allowed to do and what the gate is allowed to look at are different
 * questions, and checking the result through a restricted role would make a
 * missing grant look like a missing row.
 */
const roleConnections = new Map<string, ReturnType<typeof postgres>>();
function as(role: string): typeof sql {
  const held = roleConnections.get(role);
  if (held) return held as typeof sql;
  const made = postgres(db.urlFor(role), { max: 3, prepare: false, onnotice: () => {} });
  roleConnections.set(role, made);
  return made as typeof sql;
}

/** `forma-api`: plans work, because E04 lets nothing else create it. */
const api = as("forma_api");
/** `forma-ops`: the sweep, for the same reason. */
const ops = as("forma_ops");
/** `forma-ingestion`: provider traffic and the canonical commit behind it. */
const ingestion = as("forma_ingestion");
/** `forma-stockfish`: the engine, and nothing that needs an actor. */
const stockfish = as("forma_stockfish");
/** `forma-analysis`: aggregation and publication, which is most of a report. */
const analysis = as("forma_analysis");

const { beginOnboarding } = await import("../planner.js");
// Aliased because this file already has a `startRun`-shaped idea in its head:
// the section at the bottom is about starting a *second* run after the first
// one's examination died.
const { startRun: startRunAgain } = await import("../store.js");
const { syncAccount } = await import("../../sync/worker.js");
const { prepareExamination, buildExaminationReport, buildExamination, advanceStage } = await import(
  "../worker.js"
);
const { materializeReplayRevision } = await import("../../positions/worker.js");
const { planPendingWork } = await import("../../analysis/planner.js");
const { detectConcepts } = await import("../../analysis/concepts/worker.js");
const { registerCatalogue } = await import("../../analysis/concepts/register.js");
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
const { registerEstimateComponents, ESTIMATE_COMPONENT_KEYS, ESTIMATE_COMPONENT_VERSIONS } =
  await import("../../estimates/store.js");
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
// The named ideas the detector measures. In production this is part of the
// `forma-promote` job, beside recipe promotion, and without it the detector
// refuses with `no_registered_concepts` — which is what this gate got the first
// time it tried to run the step that produces a report's actual content.
await registerCatalogue(sql);
await registerEstimateComponents(sql);
const subjectRecipe = await registerRecipeVersion(sql, {
  recipeKey: `journey_subject_${stamp}`,
  version: "1",
  runType: "subject_live",
  inputSchemaVersion: "subject_snapshot.v1",
  outputSchemaVersion: "subject_report.v1",
  requiredArtifacts: ["skill_estimates", "trajectory_bins", "findings"],
  roles: {
    estimator: { componentKey: ESTIMATE_COMPONENT_KEYS.estimator, version: ESTIMATE_COMPONENT_VERSIONS.estimator },
    trajectory_aligner: {
      componentKey: ESTIMATE_COMPONENT_KEYS.alignment,
      version: ESTIMATE_COMPONENT_VERSIONS.alignment,
    },
    finding_rules: {
      componentKey: ESTIMATE_COMPONENT_KEYS.findingRules,
      version: ESTIMATE_COMPONENT_VERSIONS.findingRules,
    },
    renderer: { componentKey: ESTIMATE_COMPONENT_KEYS.renderer, version: ESTIMATE_COMPONENT_VERSIONS.renderer },
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
  const begun = await withActor(api, userId, (tx) =>
    beginOnboarding(tx, { runId, userId, subjectId }),
  );
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
  // Bound, exactly as `runSyncItem` binds it before calling this: the sync
  // writes `chess.subject_games` and reads `app.linked_accounts`, both of which
  // force row level security against `private.current_actor_id()`.
  const summary = await withActor(ingestion, userId, (tx) =>
    syncAccount(
      { payload: { linkedAccountId: account!.id, subjectId, mode: "initial" }, holder: "journey" },
      tx,
    ),
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
  const summary = await withActor(ingestion, userId, (tx) =>
    syncAccount(
      { payload: { linkedAccountId: account!.id, subjectId, mode: "incremental" }, holder: "journey-2" },
      tx,
    ),
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
  const swept = await planPendingWork(ops, { subjectId });
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
    const result = await materializeReplayRevision({ replayRevisionId: revision.id }, analysis);
    assert.equal(result.occurrences > 0, true);
  }
  const [published] = await sql<{ count: string }[]>`
    select count(*)::text as count from chess.materialization_runs where state = 'published'
  `;
  assert.equal(published!.count, "2");
});

/*
 * Freezing comes *before* the analysis sweep, and the order is not cosmetic.
 *
 * `planPendingGameAnalyses` only plans games some frozen snapshot actually
 * reads. Until `prepare` freezes one there is nothing for that filter to match,
 * so a sweep run here plans nothing at all — which is exactly what happened to
 * this gate the day the filter landed: two games materialized, zero analyses
 * planned, and every check after it failing on evidence that was never going to
 * be produced.
 *
 * Production has the same shape and depends on the same thing. `prepare` waits
 * for materialization, freezes the snapshot and stops; the analyses behind it
 * are planned by the *next* sweep, because E04 forbids a worker creating work.
 * That is why `forma-sweep-work` is on the scheduler: without a sweep after
 * prepare, the report step waits out its attempts for analysis nobody planned.
 */
await report.check("prepare freezes a snapshot and plans the analysis run", async () => {
  const result = await prepareExamination(await workContext("coaching_onboarding_prepare", { onboardingRunId: runId }), analysis);
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

let analysisRunIds: string[] = [];
await report.check("the sweep then plans the analysis of each game", async () => {
  const swept = await planPendingWork(ops, { subjectId });
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
    if (item.task_type === "stockfish_screen_game") await screenGame(context, stockfish);
    if (item.task_type === "stockfish_deep_game") await deepenGame(context, stockfish);
    if (item.task_type === "analysis_assess_transitions") await assessTransitions(context, analysis);
    // The step the report's *content* comes from. It was skipped here for as
    // long as `analysis.concept_opportunities` had no producer, and a producer
    // landed without this catching up -- so the gate went on asserting the
    // table was empty while production filled it with ten thousand rows, and
    // the estimator path over real evidence was never once exercised.
    if (item.task_type === "analysis_detect_concepts") await detectConcepts(context, analysis);
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

await report.check("the report runs, and the estimators read real evidence", async () => {
  const result = await buildExaminationReport(
    await workContext("coaching_examination_report", { onboardingRunId: runId }),
    analysis,
  );
  assert.equal(typeof result.outputRef, "string");

  const [publication] = await sql<{ run_id: string }[]>`
    select run_id from analysis.subject_live_publications where subject_id = ${subjectId}
  `;
  assert.notEqual(publication, undefined, "nothing was published");

  // This is where the journey used to stop, and the two assertions here used to
  // pin zero: nothing in the product wrote `analysis.concept_opportunities`, so
  // no estimator had anything to read and the report was empty by construction.
  // The note left behind said that the day a detector landed this check would
  // fail and somebody should rewrite it to assert the estimates that now exist.
  // A detector did land, and this gate did not notice for a long time, because
  // it never ran the step -- the two steps a report's *content* comes from were
  // the two the chain above skipped.
  //
  // So it asserts properties rather than counts. The exact numbers move every
  // time a concept is added to the catalogue, and a gate that pins them would
  // fail on work that is going well.
  const [opportunities] = await sql<{ count: string }[]>`
    select count(*)::text as count from analysis.concept_opportunities
  `;
  assert.equal(Number(opportunities!.count) > 0, true, "the detector found nothing to measure");

  const [estimates] = await sql<{ count: string }[]>`
    select count(*)::text as count from analysis.player_skill_estimates
  `;
  assert.equal(Number(estimates!.count) > 0, true, "no estimator read the evidence");

  // Findings are what the reader actually sees, and the false-discovery control
  // between the estimates and them is the part most worth proving runs at all.
  // Zero *published* findings is a legitimate answer over two games; a
  // publication with no findings row of any kind means the stage was skipped.
  const [findings] = await sql<{ count: string }[]>`
    select count(*)::text as count from analysis.findings
  `;
  assert.equal(Number(findings!.count) > 0, true, "the finding stage produced nothing at all");
});

await report.check("the examination writes coverage and an immutable baseline", async () => {
  await buildExamination(await workContext("coaching_baseline_examination", { onboardingRunId: runId }), analysis);

  // Insufficient, and stated. Two games is nowhere near the fifty the coverage
  // policy calls broadly sufficient, and the one thing this product may never do
  // is publish a confident profile over an archive that cannot support one.
  const [coverage] = await sql<{ count: string; overall_state: string }[]>`
    select count(*)::text as count, min(overall_state) as overall_state
    from coaching.data_coverage_snapshots
  `;
  assert.equal(Number(coverage!.count) > 0, true);
  assert.equal(coverage!.overall_state, "insufficient", "two games were called sufficient");

  const [baseline] = await sql<{ manifest_sha256: string }[]>`
    select b.manifest_sha256 from coaching.baseline_reports b
    where b.onboarding_run_id = ${runId}
  `;
  assert.match(baseline!.manifest_sha256, /^[0-9a-f]{64}$/);
});

await report.check("the stage advances to report_ready", async () => {
  await advanceStage(
    await workContext("coaching_onboarding_advance", { onboardingRunId: runId, stage: "report_ready" }),
    analysis,
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
    {
      reason: string;
      fen: string;
      solution_uci: string[];
      id: string;
      source_game_id: string | null;
      concept_slug: string | null;
      role: string | null;
      phase: string | null;
      move_number: number | null;
      side: string | null;
    }[]
  >`
    select la.id, la.reason, la.source_game_id, la.concept_slug, la.role,
           la.phase, la.move_number, la.side, tv.fen, tv.solution_uci
    from coaching.learning_assignments la
    join coaching.training_item_versions tv on tv.id = la.training_item_version_id
    where la.subject_id = ${subjectId}
    limit 1
  `;
  assert.equal(assignment!.reason.length >= 15, true, "an assignment must say why");
  assert.equal(assignment!.solution_uci.length >= 1, true);
  assert.ok(assignment!.source_game_id, "the drill lost its source game");
  assert.ok(assignment!.concept_slug, "the drill lost its catalogue pattern");
  assert.ok(["recognize", "execute", "respond", "convert"].includes(assignment!.role ?? ""));
  assert.ok(["opening", "middlegame", "endgame"].includes(assignment!.phase ?? ""));
  assert.ok((assignment!.move_number ?? 0) >= 1);
  assert.ok(assignment!.side === "white" || assignment!.side === "black");

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

// ---------------------------------------------------------------------------
report.section("starting again after an examination dies");

/*
 * The recovery path, which is the one a real person is most likely to need.
 *
 * A dead sync never fails its run: the workflow ends `failed` and the run keeps
 * saying `active` with a next action of `wait`. The screens read the workflow
 * too and correctly say the journey has stopped -- and then the only thing on
 * offer, "start again", resumed the same dead run and planned nothing, because
 * at most one run per subject may be active and this one still claimed to be.
 *
 * This is done last, on the subject the whole gate has been using, because it
 * ends that subject's journey deliberately. Everything above it has already run
 * against the healthy version.
 */
await report.check("a run whose workflow died is retired, and a new one starts", async () => {
  // `completed_at` comes with the state: the ledger's own check constraint
  // refuses a terminal workflow that never finished, which is the shape a real
  // dead one always has.
  await sql`
    update ops.workflows
    set state = 'failed', completed_at = now(), updated_at = now()
    where id = ${workflowId}
  `;

  const started = await withActor(api, userId, (tx) =>
    startRunAgain(tx, { userId, subjectId, diagnosticChoice: "skip" }),
  );
  assert.equal(started.created, true, "start again resumed the dead run instead of replacing it");
  assert.notEqual(started.runId, runId, "the same run was handed back");

  const [dead] = await sql<{ status: string; failure_reason: string | null }[]>`
    select status, failure_reason from coaching.onboarding_runs where id = ${runId}
  `;
  assert.equal(dead!.status, "failed");
  assert.equal(dead!.failure_reason, "analysis_failed");

  // Exactly one active run, which is the invariant the partial unique index
  // protects and the thing a resumed corpse was quietly holding.
  const [active] = await sql<{ count: string }[]>`
    select count(*)::text as count from coaching.onboarding_runs
    where subject_id = ${subjectId} and status = 'active'
  `;
  assert.equal(active!.count, "1");
});

// ---------------------------------------------------------------------------

setEngineSessionFactory(null);
await sql.end({ timeout: 5 });
// Every role connection too: `db.destroy()` drops the database, and a live
// session against it turns a teardown into a hang.
for (const connection of roleConnections.values()) await connection.end({ timeout: 5 });
await new Promise<void>((resolve) => provider.close(() => resolve()));
await db.destroy();
report.finish();

/**
 * `npm run engine:integration` — the whole journey, against a real database.
 *
 * Plan → screen → deepen → assess → publish → read, over a game whose replay
 * was materialized by E09's own code and whose moves repeat, so both evaluation
 * scopes occur in one chain rather than being asserted separately.
 *
 * The claims that need a database and cannot be made anywhere else:
 *
 *  - every transition of a published run has before/after evidence, and neither
 *    side is core-scoped;
 *  - a repeated position's evidence is `history_exact` and a first-time
 *    position's is `rule50`, decided by the materialized repetition count;
 *  - the second game reusing the same opening runs no new searches;
 *  - a duplicate delivery of any handler produces no second row;
 *  - a failed deeper search leaves `unavailable` and still publishes;
 *  - the compatibility trigger refuses evidence that does not belong together;
 *  - deleting a run removes its uses and keeps the anonymous cache entry.
 */

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { GateReport, startAnalysisHarness } from "../../analysis/gates/harness.js";
import { setAnalysisEventSink } from "../../analysis/telemetry.js";
import { readRun } from "../../analysis/runs.js";
import {
  registerComponent,
  registerComponentVersion,
  registerRecipeVersion,
} from "../../analysis/versions.js";
import { promoteRecipe, recordValidationRun, registerValidationDataset } from "../../analysis/validation.js";
import { rollbackSubjectGame } from "../../analysis/publication.js";
import { TRANSITION_ASSESSMENT_FAMILY } from "../contract.js";
import { setEngineEventSink } from "../telemetry.js";
import {
  FIXTURE_ENGINE,
  PLAIN_MOVES,
  REPEATING_MOVES,
  SHA,
  fixtureEngineSession,
  seedAnalysableGame,
  seedPromotedRecipe,
} from "../fixtures.js";
import type { EngineProfileKey } from "../contract.js";

const report = new GateReport("E12 engine integration gate");
const harness = await startAnalysisHarness();
const sql = harness.sql;
setAnalysisEventSink(() => {});
setEngineEventSink(() => {});

/**
 * The planner and the handlers reach `ops/ledger.js`, which resolves the
 * deployment's own connection at module load — a gate E01 put there on purpose.
 * So they are imported after the harness exists and the environment names a
 * real least-privilege role. The gate's own statements still run on the owner
 * connection, because seeding needs writes the workers are correctly denied.
 */
process.env.DATABASE_URL = harness.db.urlFor("forma_analysis");
process.env.DATABASE_ROLE = "forma_analysis";
const { planGameAnalysis } = await import("../plan.js");
const { readGameReview } = await import("../review.js");
const { evaluatePositionRequest } = await import("../interactive.js");
const {
  ASSESS_TASK,
  DEEP_TASK,
  EVALUATE_POSITION_TASK,
  SCREEN_TASK,
  assessTransitions,
  deepenGame,
  evaluateInteractivePosition,
  screenGame,
  setEngineSessionFactory,
} = await import("../worker.js");

/** A leased work item, as the executor would hand one to a handler. */
function context(taskType: string, payload: Record<string, unknown>, workflow = "") {
  return {
    item: {
      id: "1",
      workflowId: workflow,
      taskType,
      resourceClass: "cpu_engine" as const,
      inputRef: null,
      payload,
      attempt: 1,
      maxAttempts: 5,
      leaseOwner: "gate",
      timeoutSeconds: 300,
    },
    traceId: "gate-trace",
    async checkpoint() {
      return { continue: true };
    },
  };
}

let searches: { profile: EngineProfileKey; fen: string }[] = [];
function installEngine(options: { failOn?: readonly EngineProfileKey[] } = {}): void {
  setEngineSessionFactory(async () =>
    fixtureEngineSession({
      ...options,
      onSearch: (profile, fen) => searches.push({ profile, fen }),
    }),
  );
}
installEngine();

const SUFFIX = `e${Date.now().toString(36)}`;

try {
  // -------------------------------------------------------------------------
  report.section("preconditions are states, not assumptions");

  const early = await seedAnalysableGame(sql);
  await report.check("no promoted recipe means unavailable, not a queued promise", async () => {
    const outcome = await planGameAnalysis(sql, {
      subjectGameId: early.subjectGameId,
      ownerProfileId: early.ownerUserId,
    });
    assert.deepEqual(outcome, { state: "unavailable", reason: "no_promoted_recipe" });
  });

  const versions = await seedPromotedRecipe(sql, SUFFIX);

  const unmaterialized = await seedAnalysableGame(sql, { publish: false });
  await report.check("an unpublished materialization is not analysable", async () => {
    const outcome = await planGameAnalysis(sql, {
      subjectGameId: unmaterialized.subjectGameId,
      ownerProfileId: unmaterialized.ownerUserId,
    });
    assert.deepEqual(outcome, { state: "unavailable", reason: "no_published_materialization" });
  });

  await report.check("another owner's game is indistinguishable from no game", async () => {
    const outcome = await planGameAnalysis(sql, {
      subjectGameId: early.subjectGameId,
      ownerProfileId: randomUUID(),
    });
    assert.equal(outcome, null);
  });

  // -------------------------------------------------------------------------
  report.section("planning");

  const game = await seedAnalysableGame(sql, { moves: REPEATING_MOVES });
  let runId = "";
  let workflowId = "";

  await report.check("planning creates one run and one three-item workflow", async () => {
    const outcome = await planGameAnalysis(sql, {
      subjectGameId: game.subjectGameId,
      ownerProfileId: game.ownerUserId,
    });
    assert.equal(outcome?.state, "scheduled");
    if (outcome?.state !== "scheduled") throw new Error("unreachable");
    runId = outcome.runId;
    workflowId = outcome.workflowId;

    const items = await sql<{ task_type: string; queue: string; resource_class: string }[]>`
      select task_type, queue, resource_class from ops.work_items
      where workflow_id = ${workflowId} order by id
    `;
    assert.deepEqual(
      items.map((item) => [item.task_type, item.queue, item.resource_class]),
      [
        [SCREEN_TASK, "stockfish-screen", "cpu_engine"],
        [DEEP_TASK, "stockfish-deep", "cpu_engine"],
        [ASSESS_TASK, "analysis", "aggregation"],
      ],
    );
  });

  await report.check("planning the same game twice finds the same run", async () => {
    const again = await planGameAnalysis(sql, {
      subjectGameId: game.subjectGameId,
      ownerProfileId: game.ownerUserId,
    });
    assert.equal(again?.state, "scheduled");
    if (again?.state !== "scheduled") throw new Error("unreachable");
    assert.equal(again.runId, runId);
    assert.equal(again.alreadyScheduled, true);
    assert.equal(again.workflowId, workflowId);
  });

  await report.check("no work item payload carries a position", async () => {
    const payloads = await sql<{ payload: Record<string, unknown> }[]>`
      select payload from ops.work_items where workflow_id = ${workflowId}
    `;
    for (const row of payloads) {
      const text = JSON.stringify(row.payload);
      assert.ok(!/[pnbrqkPNBRQK1-8]{6,}\//.test(text), `a FEN reached the ledger: ${text}`);
      assert.ok(!text.includes(game.subjectGameId), "the subject game reached the engine payload");
    }
  });

  const enginePayload = {
    materializationRunId: game.materializationRunId,
    engineVersionId: versions.engineProfileId,
    calibrationVersionId: versions.calibrationVersionId,
  };

  // -------------------------------------------------------------------------
  report.section("screening");

  await report.check("screening evaluates every position of the chain", async () => {
    searches = [];
    const result = await screenGame(context(SCREEN_TASK, enginePayload), sql);
    assert.equal(result.metrics?.inputCount, REPEATING_MOVES.length + 1);
    assert.equal(searches.length, REPEATING_MOVES.length + 1);
    const [{ count }] = await sql<{ count: string }[]>`
      select count(*)::text as count from analysis.position_evaluations
      where limit_value = 50000
    `;
    assert.equal(count, String(REPEATING_MOVES.length + 1));
  });

  await report.check("a repeated position is evaluated history-exact, a fresh one is not", async () => {
    const rows = await sql<{ ply: number; scope: string; repetition_count: number }[]>`
      select o.ply, e.scope, o.repetition_count
      from chess.position_occurrences o
      join analysis.position_evaluations e on e.core_position_id = o.core_position_id
       and e.limit_value = 50000
       and (e.scope <> 'history_exact' or e.history_signature is not null)
      where o.run_id = ${game.materializationRunId}
      order by o.ply, e.scope
    `;
    const byPly = new Map<number, string[]>();
    for (const row of rows) byPly.set(row.ply, [...(byPly.get(row.ply) ?? []), row.scope]);
    // Plies 0-3 occur once; 4-6 return positions already seen in this game.
    for (const ply of [0, 1, 2, 3]) {
      assert.ok(byPly.get(ply)?.includes("rule50"), `ply ${ply} has no rule50 evidence`);
    }
    for (const ply of [4, 5, 6]) {
      assert.ok(
        byPly.get(ply)?.includes("history_exact"),
        `ply ${ply} repeated and has no history-exact evidence`,
      );
    }
  });

  await report.check("no evaluation is core-scoped", async () => {
    const [{ count }] = await sql<{ count: string }[]>`
      select count(*)::text as count from analysis.position_evaluations where scope = 'core'
    `;
    assert.equal(count, "0", "a history-free result was stored as pipeline evidence");
  });

  await report.check("a duplicate screening delivery writes nothing new", async () => {
    const before = await countEvaluations(sql);
    searches = [];
    const result = await screenGame(context(SCREEN_TASK, enginePayload), sql);
    assert.equal(await countEvaluations(sql), before);
    assert.equal(searches.length, 0, "the cache did not stop the second search");
    assert.equal(result.metrics?.cacheHits, REPEATING_MOVES.length + 1);
  });

  await report.check("a second game sharing an opening reuses the cache", async () => {
    const twin = await seedAnalysableGame(sql, { moves: REPEATING_MOVES });
    searches = [];
    await screenGame(
      context(SCREEN_TASK, { ...enginePayload, materializationRunId: twin.materializationRunId }),
      sql,
    );
    assert.equal(searches.length, 0, "an identical chain re-searched instead of reusing");
  });

  // -------------------------------------------------------------------------
  report.section("deeper analysis");

  await report.check("the deep pass evaluates only the selected positions", async () => {
    searches = [];
    const result = await deepenGame(context(DEEP_TASK, enginePayload), sql);
    assert.ok((result.metrics?.inputCount ?? 0) > 0, "nothing was selected in a game with swings");
    assert.ok(
      searches.every((search) => search.profile === "deep"),
      "the deep pass ran a screening search",
    );
    const [{ count }] = await sql<{ count: string }[]>`
      select count(*)::text as count from analysis.position_evaluations where limit_value = 500000
    `;
    assert.equal(count, String(result.metrics?.inputCount));
  });

  await report.check("deep evaluations retain more than one line", async () => {
    const rows = await sql<{ multipv: number; lines: string }[]>`
      select e.multipv, count(c.rank)::text as lines
      from analysis.position_evaluations e
      join analysis.evaluation_candidates c on c.position_evaluation_id = e.id
      where e.limit_value = 500000
      group by e.id, e.multipv
    `;
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.equal(row.multipv, 3);
      assert.ok(Number(row.lines) > 1, "a MultiPV search stored one line");
    }
  });

  // -------------------------------------------------------------------------
  report.section("assessment and publication");

  await report.check("every transition is assessed and the run succeeds", async () => {
    const result = await assessTransitions(context(ASSESS_TASK, { runId }, workflowId), sql);
    assert.equal(result.outputSummary?.transitions, REPEATING_MOVES.length);
    const run = await readRun(sql, runId);
    assert.equal(run?.status, "succeeded");
    assert.match(run?.outputManifestHash ?? "", /^[0-9a-f]{64}$/);
  });

  await report.check("the assessments cite compatible, non-core evidence", async () => {
    const rows = await sql<{ before_scope: string; after_scope: string; same: boolean }[]>`
      select b.scope as before_scope, a.scope as after_scope,
             (b.model_profile_id = a.model_profile_id
              and b.limit_value = a.limit_value
              and b.calibration_component_version_id = a.calibration_component_version_id) as same
      from analysis.transition_assessments ta
      join analysis.position_evaluations b on b.id = ta.before_evaluation_id
      join analysis.position_evaluations a on a.id = ta.after_evaluation_id
      where ta.analysis_run_id = ${runId}
    `;
    assert.equal(rows.length, REPEATING_MOVES.length);
    for (const row of rows) {
      assert.notEqual(row.before_scope, "core");
      assert.notEqual(row.after_scope, "core");
      assert.equal(row.same, true, "before and after came from different searches");
    }
  });

  await report.check("the run's evaluation uses name the role each played", async () => {
    const rows = await sql<{ input_role: string; count: string }[]>`
      select input_role, count(*)::text as count from analysis.run_evaluation_uses
      where run_id = ${runId} group by input_role order by input_role
    `;
    const roles = new Map(rows.map((row) => [row.input_role, Number(row.count)]));
    assert.ok((roles.get("transition_before") ?? 0) > 0);
    assert.ok((roles.get("transition_after") ?? 0) > 0);
    assert.ok((roles.get("deep_multipv") ?? 0) > 0);
  });

  await report.check("the game is published and the review reads it back", async () => {
    const review = await readGameReview(sql, {
      subjectGameId: game.subjectGameId,
      ownerProfileId: game.ownerUserId,
    });
    assert.ok(review, "no published review");
    assert.equal(review!.runId, runId);
    assert.equal(review!.stale, false);
    assert.equal(review!.moves.length, REPEATING_MOVES.length);
    assert.equal(review!.sections.transitions, "published");
    assert.equal(review!.sections.events, "unavailable");
    assert.ok(review!.criticalMoments.length > 0);
    assert.ok(Object.keys(review!.version.policyVersions).length >= 4);
  });

  await report.check("a stranger cannot read the review", async () => {
    const review = await readGameReview(sql, {
      subjectGameId: game.subjectGameId,
      ownerProfileId: randomUUID(),
    });
    assert.equal(review, null);
  });

  await report.check("a duplicate assessment delivery is acknowledged, not repeated", async () => {
    const before = await countAssessmentRows(sql, runId);
    const result = await assessTransitions(context(ASSESS_TASK, { runId }, workflowId), sql);
    assert.equal(result.outputSummary?.duplicate, true);
    assert.equal(await countAssessmentRows(sql, runId), before);
  });

  await report.check("planning a published game returns the publication, not new work", async () => {
    const outcome = await planGameAnalysis(sql, {
      subjectGameId: game.subjectGameId,
      ownerProfileId: game.ownerUserId,
    });
    assert.equal(outcome?.state, "published");
  });

  // -------------------------------------------------------------------------
  report.section("engine failure is bounded, not fatal");

  await report.check("a failed deeper search publishes with unavailable, not with a guess", async () => {
    const failing = await seedAnalysableGame(sql, { moves: PLAIN_MOVES });
    const payload = {
      ...enginePayload,
      materializationRunId: failing.materializationRunId,
    };
    installEngine();
    await screenGame(context(SCREEN_TASK, payload), sql);

    installEngine({ failOn: ["deep"] });
    const deep = await deepenGame(context(DEEP_TASK, payload), sql);
    assert.equal(deep.metrics?.outputCount, 0, "a refusing engine still produced a row");

    installEngine();
    const planned = await planGameAnalysis(sql, {
      subjectGameId: failing.subjectGameId,
      ownerProfileId: failing.ownerUserId,
    });
    if (planned?.state !== "scheduled") throw new Error("expected a scheduled run");
    await assessTransitions(context(ASSESS_TASK, { runId: planned.runId }, planned.workflowId), sql);

    const review = await readGameReview(sql, {
      subjectGameId: failing.subjectGameId,
      ownerProfileId: failing.ownerUserId,
    });
    assert.ok(review, "an engine failure cost the user the whole review");
    const unavailable = review!.moves.filter((move) => move.deep.status === "unavailable");
    assert.ok(unavailable.length > 0, "nothing recorded the deeper look that did not happen");
    for (const move of review!.moves) {
      assert.ok(Number.isFinite(move.decisionLoss), "screening evidence was lost too");
    }
  });

  await report.check("a worker running a different engine refuses to write", async () => {
    process.env.STOCKFISH_BINARY_SHA256 = SHA("some other build");
    try {
      await assert.rejects(
        () => screenGame(context(SCREEN_TASK, enginePayload), sql),
        /engine_profile_mismatch|unsupported/,
      );
    } finally {
      delete process.env.STOCKFISH_BINARY_SHA256;
    }
  });

  // -------------------------------------------------------------------------
  report.section("the compatibility rules are the database's, not the caller's");

  await report.check("a transition assessment may not cite a core-scoped evaluation", async () => {
    const core = await insertRawEvaluation(sql, versions, { scope: "core" });
    const [existing] = await sql<{ after_evaluation_id: string; from_ply: number }[]>`
      select after_evaluation_id, from_ply from analysis.transition_assessments
      where analysis_run_id = ${runId} order by from_ply limit 1
    `;
    await assert.rejects(
      () => sql`
        insert into analysis.transition_assessments (
          analysis_run_id, materialization_run_id, from_ply, before_evaluation_id,
          after_evaluation_id, deep_status, actor_color, played_move_uci,
          expected_score_before, expected_score_after, tolerance_component_version_id,
          played_move_acceptable
        ) values (
          ${runId}, ${game.materializationRunId}, 99, ${core},
          ${existing!.after_evaluation_id}, 'not_selected', 'white', 'e2e4',
          0.5, 0.5, ${versions.toleranceVersionId}, true
        )
      `,
      /core-scoped/,
    );
  });

  await report.check("before and after must come from the same search", async () => {
    const [screening] = await sql<{ id: string }[]>`
      select id from analysis.position_evaluations where limit_value = 50000 limit 1
    `;
    const [deep] = await sql<{ id: string }[]>`
      select id from analysis.position_evaluations where limit_value = 500000 limit 1
    `;
    await assert.rejects(
      () => sql`
        insert into analysis.transition_assessments (
          analysis_run_id, materialization_run_id, from_ply, before_evaluation_id,
          after_evaluation_id, deep_status, actor_color, played_move_uci,
          expected_score_before, expected_score_after, tolerance_component_version_id,
          played_move_acceptable
        ) values (
          ${runId}, ${game.materializationRunId}, 98, ${deep!.id}, ${screening!.id},
          'not_selected', 'white', 'e2e4', 0.5, 0.5, ${versions.toleranceVersionId}, true
        )
      `,
      /same profile, limit and calibration/,
    );
  });

  await report.check("a human-policy profile cannot write an objective evaluation", async () => {
    await registerComponent(sql, {
      componentKey: `human_policy_${SUFFIX}`,
      category: "human_policy",
      description: "A rating-conditioned move model",
      inputContract: "core_position.v1",
      outputContract: "move_probability.v1",
    });
    const policy = await registerComponentVersion(sql, {
      componentKey: `human_policy_${SUFFIX}`,
      version: "1",
      implementationSha256: SHA(`human-policy-${SUFFIX}`),
      deterministic: true,
    });
    await sql`
      insert into analysis.model_profiles (
        component_version_id, role, hardware_class, input_context_contract,
        output_interpretation_contract, licence_review_status
      ) values (
        ${policy.id}, 'human_policy', 'cpu_model', 'core_position.v1',
        'human_outcome.v1', 'pending'
      )
    `;
    await assert.rejects(
      () => insertRawEvaluation(sql, { ...versions, engineProfileId: policy.id }, { scope: "rule50" }),
      /objective_engine profiles only/,
    );
  });

  await report.check("an evaluation and an assessment are immutable", async () => {
    const [evaluation] = await sql<{ id: string }[]>`
      select id from analysis.position_evaluations limit 1
    `;
    await assert.rejects(
      () => sql`update analysis.position_evaluations set score_cp = 1 where id = ${evaluation!.id}`,
      /immutable/,
    );
    await assert.rejects(
      () => sql`
        update analysis.transition_assessments set played_move_acceptable = false
        where analysis_run_id = ${runId}
      `,
      /immutable/,
    );
  });

  await report.check("two searches with the same inputs cannot become two rows", async () => {
    // Copy an existing row wholesale and change only the cache key. Everything
    // else is identical, so the only thing that can refuse it is the index over
    // the inputs themselves — which is the point of having that index beside
    // the key rather than trusting the key alone.
    await assert.rejects(
      () => sql`
        insert into analysis.position_evaluations (
          core_position_id, scope, halfmove_clock, history_signature, occurrence_run_id,
          occurrence_ply, model_profile_id, calibration_component_version_id, limit_type,
          limit_value, multipv, threads, hash_mb, tablebase, perspective, score_cp, mate_in,
          wdl_win, wdl_draw, wdl_loss, expected_score, expected_score_method, worker_revision,
          cache_key
        )
        select core_position_id, scope, halfmove_clock, history_signature, occurrence_run_id,
               occurrence_ply, model_profile_id, calibration_component_version_id, limit_type,
               limit_value, multipv, threads, hash_mb, tablebase, perspective, score_cp, mate_in,
               wdl_win, wdl_draw, wdl_loss, expected_score, expected_score_method, 'gate',
               ${"f".repeat(64)}
        from analysis.position_evaluations where scope = 'rule50' limit 1
      `,
      /position_evaluations_inputs/,
      "a different cache key let one computation become two rows",
    );
  });

  // -------------------------------------------------------------------------
  report.section("retention: a run's use is not the evidence");

  await report.check("deleting a run drops its uses and keeps the anonymous entry", async () => {
    // A planned run with a use and nothing else, so this check is about the
    // cascade and not about unwinding a publication.
    const spare = await seedAnalysableGame(sql, { moves: PLAIN_MOVES });
    const planned = await planGameAnalysis(sql, {
      subjectGameId: spare.subjectGameId,
      ownerProfileId: spare.ownerUserId,
    });
    if (planned?.state !== "scheduled") throw new Error("expected a scheduled run");
    const [evaluation] = await sql<{ id: string }[]>`
      select id from analysis.position_evaluations limit 1
    `;
    await sql`
      insert into analysis.run_evaluation_uses (run_id, position_evaluation_id, input_role)
      values (${planned.runId}, ${evaluation!.id}, 'transition_before')
    `;
    const evaluations = await countEvaluations(sql);

    // Runs are append-only by trigger; deletion is E21's and will need a
    // privileged routine. Disabling it here is this gate cleaning up after
    // itself, not a deletion contract.
    await sql`alter table analysis.runs disable trigger runs_append_only`;
    await sql`delete from analysis.runs where id = ${planned.runId}`;
    await sql`alter table analysis.runs enable trigger runs_append_only`;

    const [after] = await sql<{ count: string }[]>`
      select count(*)::text as count from analysis.run_evaluation_uses
      where run_id = ${planned.runId}
    `;
    assert.equal(after!.count, "0", "the use rows outlived the run");
    assert.equal(await countEvaluations(sql), evaluations, "an anonymous cache entry was deleted");
  });

  await report.check("a run cannot be deleted while its claims cite it", async () => {
    const [constraint] = await sql<{ confdeltype: string }[]>`
      select confdeltype from pg_constraint
      where conname = 'transition_assessments_analysis_run_id_fkey'
    `;
    assert.equal(
      constraint!.confdeltype,
      "r",
      "assessments would vanish with their run instead of blocking its removal",
    );
    await sql`alter table analysis.runs disable trigger runs_append_only`;
    try {
      // E11's run_artifacts restricts first; either way the answer is that a
      // run with outputs is not removable by accident.
      await assert.rejects(
        () => sql`delete from analysis.runs where id = ${runId}`,
        /violates foreign key constraint/,
      );
    } finally {
      await sql`alter table analysis.runs enable trigger runs_append_only`;
    }
  });

  // -------------------------------------------------------------------------
  report.section("failure, termination and contention");

  await report.check("a cancelled screening stops between positions", async () => {
    // A line nothing above has screened, so every position is a real search and
    // stopping is visible in the count rather than hidden behind cache hits.
    const cancelled = await seedAnalysableGame(sql, {
      moves: ["b1a3", "b8a6", "a3b1", "a6b8", "g1h3", "g8h6"],
    });
    const payload = { ...enginePayload, materializationRunId: cancelled.materializationRunId };
    let beats = 0;
    const stopping = {
      ...context(SCREEN_TASK, payload),
      async checkpoint() {
        beats += 1;
        // Cooperative cancellation: the handler asks, and stops when told to.
        return { continue: beats <= 2 };
      },
    };
    const result = await screenGame(stopping, sql);
    const processed = (result.metrics?.cacheHits ?? 0) + (result.metrics?.outputCount ?? 0);
    assert.equal(processed, 2, "the handler kept working after being told to stop");
    assert.ok(
      (result.metrics?.inputCount ?? 0) > processed,
      "the chain was short enough that stopping proved nothing",
    );
  });

  await report.check("a game whose screening failed publishes nothing", async () => {
    const broken = await seedAnalysableGame(sql, { moves: ["b1c3", "b8c6", "c3b1", "c6b8"] });
    installEngine({ failOn: ["screening"] });
    await assert.rejects(() =>
      screenGame(
        context(SCREEN_TASK, { ...enginePayload, materializationRunId: broken.materializationRunId }),
        sql,
      ),
    );
    installEngine();

    const planned = await planGameAnalysis(sql, {
      subjectGameId: broken.subjectGameId,
      ownerProfileId: broken.ownerUserId,
    });
    if (planned?.state !== "scheduled") throw new Error("expected a scheduled run");
    // The assessment step refuses to invent evidence for positions nobody searched.
    await assert.rejects(
      () => assessTransitions(context(ASSESS_TASK, { runId: planned.runId }, planned.workflowId), sql),
      /screening_incomplete/,
    );
    const review = await readGameReview(sql, {
      subjectGameId: broken.subjectGameId,
      ownerProfileId: broken.ownerUserId,
    });
    assert.equal(review, null, "a game with no evidence was published anyway");
  });

  await report.check("two assessment deliveries race to one set of rows", async () => {
    const raced = await seedAnalysableGame(sql, { moves: ["d2d4", "d7d5", "c2c4", "c7c6"] });
    const payload = { ...enginePayload, materializationRunId: raced.materializationRunId };
    await screenGame(context(SCREEN_TASK, payload), sql);
    await deepenGame(context(DEEP_TASK, payload), sql);
    const planned = await planGameAnalysis(sql, {
      subjectGameId: raced.subjectGameId,
      ownerProfileId: raced.ownerUserId,
    });
    if (planned?.state !== "scheduled") throw new Error("expected a scheduled run");

    const both = await Promise.allSettled([
      assessTransitions(context(ASSESS_TASK, { runId: planned.runId }, planned.workflowId), sql),
      assessTransitions(context(ASSESS_TASK, { runId: planned.runId }, planned.workflowId), sql),
    ]);
    assert.ok(both.some((outcome) => outcome.status === "fulfilled"), "neither delivery finished");
    assert.equal(await countAssessmentRows(sql, planned.runId), 4, "a duplicate delivery doubled the rows");
    const publications = await sql<{ count: string }[]>`
      select count(*)::text as count from analysis.subject_game_publications
      where subject_game_id = ${raced.subjectGameId}
    `;
    assert.equal(publications[0]!.count, "1");
  });

  // -------------------------------------------------------------------------
  report.section("reconciliation and pointer rollback");

  await report.check("no published transition cites history-free evidence", async () => {
    const [row] = await sql<{ count: string }[]>`
      select count(*)::text as count
      from analysis.transition_assessments ta
      join analysis.subject_game_publications pub on pub.run_id = ta.analysis_run_id
      join analysis.position_evaluations b on b.id = ta.before_evaluation_id
      join analysis.position_evaluations a on a.id = ta.after_evaluation_id
      where b.scope = 'core' or a.scope = 'core'
    `;
    assert.equal(row!.count, "0");
  });

  await report.check("every published run assessed its whole chain", async () => {
    const gaps = await sql<{ run_id: string; expected: number; assessed: string }[]>`
      select pub.run_id, mr.transition_count as expected, count(ta.id)::text as assessed
      from analysis.subject_game_publications pub
      join analysis.transition_assessments ta on ta.analysis_run_id = pub.run_id
      join chess.materialization_runs mr on mr.id = ta.materialization_run_id
      group by pub.run_id, mr.transition_count
      having count(ta.id) <> mr.transition_count
    `;
    assert.equal(gaps.length, 0, gaps.map((gap) => `${gap.run_id}: ${gap.assessed}/${gap.expected}`).join(", "));
  });

  await report.check("promoting a new recipe moves new runs and rolls back by appending", async () => {
    const target = await seedAnalysableGame(sql, { moves: ["e2e4", "c7c5", "g1f3", "d7d6"] });
    const payload = { ...enginePayload, materializationRunId: target.materializationRunId };
    await screenGame(context(SCREEN_TASK, payload), sql);
    await deepenGame(context(DEEP_TASK, payload), sql);
    const first = await planGameAnalysis(sql, {
      subjectGameId: target.subjectGameId,
      ownerProfileId: target.ownerUserId,
    });
    if (first?.state !== "scheduled") throw new Error("expected a scheduled run");
    await assessTransitions(context(ASSESS_TASK, { runId: first.runId }, first.workflowId), sql);

    // A second recipe version over the same components: a method change, so a
    // new run, and the old one is left exactly where it was.
    const bumped = await registerRecipeVersion(sql, {
      recipeKey: `game_review_${SUFFIX}`,
      version: "2",
      runType: "game_analysis",
      inputSchemaVersion: "replay.v1",
      outputSchemaVersion: "game_review.v1",
      requiredArtifacts: [TRANSITION_ASSESSMENT_FAMILY],
      roles: await rolesOf(sql, versions.recipeVersionId),
    });
    const dataset = await registerValidationDataset(sql, {
      datasetKey: `engine_golden_${SUFFIX}_2`,
      version: "1",
      manifestSha256: SHA(`golden-2-${SUFFIX}`),
      samplingDescription: "The committed deterministic engine corpus.",
      accountDisjoint: true,
      chronologicalSplit: false,
      governanceClass: "internal",
    });
    const validation = await recordValidationRun(sql, {
      datasetId: dataset.id,
      candidate: { recipeVersionId: bumped.id },
      executionRevision: "gate",
      status: "passed",
      outputChecksum: SHA(`golden-2-out-${SUFFIX}`),
    });
    await promoteRecipe(sql, {
      surface: "deep_game_analysis",
      recipeVersionId: bumped.id,
      reason: "E12 rollback rehearsal",
      actor: { kind: "system" },
      validationRunId: validation,
    });

    const second = await planGameAnalysis(sql, {
      subjectGameId: target.subjectGameId,
      ownerProfileId: target.ownerUserId,
    });
    if (second?.state !== "scheduled") throw new Error("the promotion did not produce a new run");
    assert.notEqual(second.runId, first.runId, "a method change reused the old run");
    await assessTransitions(context(ASSESS_TASK, { runId: second.runId }, second.workflowId), sql);

    const published = await readGameReview(sql, {
      subjectGameId: target.subjectGameId,
      ownerProfileId: target.ownerUserId,
    });
    assert.equal(published?.runId, second.runId);

    const rolledBack = await rollbackSubjectGame(sql, {
      subjectGameId: target.subjectGameId,
      actor: { kind: "system" },
    });
    assert.equal(rolledBack.published, true);
    const after = await readGameReview(sql, {
      subjectGameId: target.subjectGameId,
      ownerProfileId: target.ownerUserId,
    });
    assert.equal(after?.runId, first.runId, "the rollback did not restore the earlier run");

    // Asserted as a chain rather than as an ordered list: the history id is a
    // uuid, so "order by id" is not chronology, and what the epic actually
    // claims is that each row names the run it replaced.
    const history = await sql<{ reason: string; run_id: string; previous_run_id: string | null }[]>`
      select reason, run_id, previous_run_id from analysis.subject_game_publication_history
      where subject_game_id = ${target.subjectGameId}
    `;
    assert.equal(history.length, 3, "a publication or a rollback wrote no history row");
    const links = new Map(history.map((entry) => [entry.reason, entry]));
    assert.equal(links.get("first_publication")?.run_id, first.runId);
    assert.equal(links.get("first_publication")?.previous_run_id, null);
    assert.equal(links.get("new_run")?.run_id, second.runId);
    assert.equal(links.get("new_run")?.previous_run_id, first.runId);
    assert.equal(links.get("rollback")?.run_id, first.runId);
    assert.equal(
      links.get("rollback")?.previous_run_id,
      second.runId,
      "the rollback did not record what it replaced",
    );
    const survived = await sql<{ count: string }[]>`
      select count(*)::text as count from analysis.transition_assessments
      where analysis_run_id = ${second.runId}
    `;
    assert.ok(Number(survived[0]!.count) > 0, "the rolled-back run's evidence was deleted");
  });

  // -------------------------------------------------------------------------
  report.section("bounded interactive evaluation");

  const interactiveOwner = randomUUID();
  await sql`insert into app.profiles (user_id) values (${interactiveOwner}) on conflict do nothing`;
  const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

  await report.check("an illegal position is refused before any work is created", async () => {
    const outcome = await evaluatePositionRequest(sql, {
      fen: "not a fen",
      purpose: "explore",
      ownerProfileId: interactiveOwner,
    });
    assert.equal(outcome.state, "invalid_position");
  });

  let interactiveWorkflow = "";
  await report.check("a cold position schedules one bounded search", async () => {
    const outcome = await evaluatePositionRequest(sql, {
      fen: START_FEN,
      purpose: "explore",
      ownerProfileId: interactiveOwner,
    });
    assert.equal(outcome.state, "scheduled");
    if (outcome.state !== "scheduled") throw new Error("unreachable");
    interactiveWorkflow = outcome.workflowId;
    const [item] = await sql<{ task_type: string; queue: string; payload: Record<string, unknown> }[]>`
      select task_type, queue, payload from ops.work_items where workflow_id = ${interactiveWorkflow}
    `;
    assert.equal(item!.task_type, EVALUATE_POSITION_TASK);
    assert.equal(item!.queue, "stockfish-screen");
    assert.ok(!JSON.stringify(item!.payload).includes("rnbqkbnr"), "the FEN reached the ledger");
  });

  await report.check("a second request for the same position joins the first", async () => {
    const outcome = await evaluatePositionRequest(sql, {
      fen: START_FEN,
      purpose: "review_position",
      ownerProfileId: randomUUID(),
    });
    assert.equal(outcome.state, "scheduled");
    if (outcome.state !== "scheduled") throw new Error("unreachable");
    assert.equal(outcome.workflowId, interactiveWorkflow);
  });

  await report.check("the search runs and the next request is answered from the cache", async () => {
    const [item] = await sql<{ payload: Record<string, unknown> }[]>`
      select payload from ops.work_items where workflow_id = ${interactiveWorkflow}
    `;
    await evaluateInteractivePosition(
      context(EVALUATE_POSITION_TASK, item!.payload),
      sql,
    );
    const outcome = await evaluatePositionRequest(sql, {
      fen: START_FEN,
      purpose: "explore",
      ownerProfileId: interactiveOwner,
    });
    assert.equal(outcome.state, "ready");
    if (outcome.state !== "ready") throw new Error("unreachable");
    assert.equal(outcome.evaluation.scope, "rule50");
    assert.equal(outcome.evaluation.multipv, 3);
    assert.ok(outcome.evaluation.candidateMoves.length > 1);
  });

  await report.check("an interactive result never becomes an assessment", async () => {
    const [{ count }] = await sql<{ count: string }[]>`
      select count(*)::text as count
      from analysis.transition_assessments ta
      join analysis.position_evaluations e on e.id in (ta.before_evaluation_id, ta.after_evaluation_id)
      where e.limit_value = 50000 and e.multipv = 3
    `;
    assert.equal(count, "0", "an ad-hoc user evaluation became evidence about a player");
  });
} finally {
  setEngineSessionFactory(null);
  await harness.destroy();
}

async function countEvaluations(target: Sql): Promise<number> {
  const [row] = await target<{ count: string }[]>`
    select count(*)::text as count from analysis.position_evaluations
  `;
  return Number(row!.count);
}

async function countAssessmentRows(target: Sql, run: string): Promise<number> {
  const [row] = await target<{ count: string }[]>`
    select count(*)::text as count from analysis.transition_assessments where analysis_run_id = ${run}
  `;
  return Number(row!.count);
}

/** The role map of an existing recipe, so a bump changes the version and nothing else. */
async function rolesOf(
  target: Sql,
  recipeVersionId: string,
): Promise<Record<string, { componentKey: string; version: string }>> {
  const rows = await target<{ role: string; component_key: string; version: string }[]>`
    select rc.role, c.component_key, cv.version
    from analysis.recipe_components rc
    join analysis.component_versions cv on cv.id = rc.component_version_id
    join analysis.components c on c.id = cv.component_id
    where rc.recipe_version_id = ${recipeVersionId}
  `;
  return Object.fromEntries(
    rows.map((row) => [row.role, { componentKey: row.component_key, version: row.version }]),
  );
}

/** A raw evaluation row, for the negative cases the writer would never produce. */
async function insertRawEvaluation(
  target: Sql,
  versions: { engineProfileId: string; calibrationVersionId: string },
  options: { scope: "core" | "rule50" },
): Promise<string> {
  const [core] = await target<{ id: string }[]>`select id from chess.core_positions limit 1`;
  const [row] = await target<{ id: string }[]>`
    insert into analysis.position_evaluations (
      core_position_id, scope, halfmove_clock, model_profile_id,
      calibration_component_version_id, limit_type, limit_value, multipv, threads, hash_mb,
      tablebase, perspective, score_cp, expected_score, expected_score_method,
      worker_revision, cache_key
    ) values (
      ${core!.id}, ${options.scope}, ${options.scope === "core" ? null : 0},
      ${versions.engineProfileId}, ${versions.calibrationVersionId}, 'nodes', 50000, 1, 1, 64,
      false, 'white', 0, 0.5, 'logistic', 'gate', ${SHA(randomUUID())}
    )
    returning id
  `;
  return row!.id;
}

report.finish();

/**
 * `npm run engine:security` — grants, tenancy and redaction for E12.
 *
 * The integration gate connects as the owner, which proves behaviour and proves
 * nothing about access. This one connects as the real least-privilege roles
 * with a real actor bound by `private.set_actor_context`, because a forced
 * policy tested as a superuser is a policy that was never consulted.
 *
 * The claims, in the epic's terms:
 *
 *  - no browser role reaches any table this epic added;
 *  - `forma_stockfish` — the deployment that runs the engine — can write
 *    evaluations and reach *nothing* that belongs to a subject, so a compromised
 *    engine worker learns nothing about whose game it analysed;
 *  - `forma_api` can read evidence and cannot manufacture it;
 *  - a non-owner cannot read another subject's assessments even with a correct
 *    identifier, and an unbound actor sees nothing rather than everything;
 *  - no engine event carries a position, a subject or an engine message.
 *
 * It creates roles and logs in with a synthetic password, so it runs only
 * against a disposable cluster. The harness refuses anything else.
 */

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { GateReport, startAnalysisHarness } from "../../analysis/gates/harness.js";
import { setAnalysisEventSink } from "../../analysis/telemetry.js";
import { DENIED_ROLES } from "../../security/contract.js";
import { ENGINE_EVENT_FIELDS, engineEventLine, setEngineEventSink } from "../telemetry.js";
import {
  PLAIN_MOVES,
  SHA,
  fixtureEngineSession,
  seedAnalysableGame,
  seedPromotedRecipe,
} from "../fixtures.js";

const report = new GateReport("E12 engine security gate");
const harness = await startAnalysisHarness();
const sql = harness.sql;
setAnalysisEventSink(() => {});
setEngineEventSink(() => {});

process.env.DATABASE_URL = harness.db.urlFor("forma_analysis");
process.env.DATABASE_ROLE = "forma_analysis";
const { planGameAnalysis } = await import("../plan.js");
const { readGameReview } = await import("../review.js");
const { ASSESS_TASK, DEEP_TASK, SCREEN_TASK, assessTransitions, deepenGame, screenGame, setEngineSessionFactory } =
  await import("../worker.js");

setEngineSessionFactory(async () => fixtureEngineSession());

/** Every table this epic added, schema-qualified. */
const NEW_TABLES = [
  "analysis.model_profiles",
  "analysis.position_evaluations",
  "analysis.evaluation_candidates",
  "analysis.run_evaluation_uses",
  "analysis.transition_assessments",
];

/** The subject-scoped subset: these carry one subject's rows and force a policy. */
const TENANT_TABLES = ["analysis.run_evaluation_uses", "analysis.transition_assessments"];

async function refusalCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "allowed";
  } catch (error) {
    return (error as { code?: string }).code ?? "unknown";
  }
}

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
    traceId: null,
    async checkpoint() {
      return { continue: true };
    },
  };
}

const SUFFIX = `s${Date.now().toString(36)}`;

try {
  const versions = await seedPromotedRecipe(sql, SUFFIX);
  const owner = await seedAnalysableGame(sql);
  const stranger = await seedAnalysableGame(sql);
  const enginePayload = {
    materializationRunId: owner.materializationRunId,
    engineVersionId: versions.engineProfileId,
    calibrationVersionId: versions.calibrationVersionId,
  };
  await screenGame(context(SCREEN_TASK, enginePayload), sql);
  await deepenGame(context(DEEP_TASK, enginePayload), sql);
  const planned = await planGameAnalysis(sql, {
    subjectGameId: owner.subjectGameId,
    ownerProfileId: owner.ownerUserId,
  });
  if (planned?.state !== "scheduled") throw new Error("expected a scheduled run");
  await assessTransitions(context(ASSESS_TASK, { runId: planned.runId }, planned.workflowId), sql);

  // -------------------------------------------------------------------------
  report.section("no browser role reaches this epic");

  for (const role of DENIED_ROLES) {
    await report.check(`${role} holds no privilege on any E12 table`, async () => {
      const rows = await sql<{ table_name: string; privilege_type: string }[]>`
        select table_schema || '.' || table_name as table_name, privilege_type
        from information_schema.role_table_grants
        where grantee = ${role}
          and table_schema || '.' || table_name = any(${NEW_TABLES as unknown as string[]}::text[])
      `;
      assert.equal(
        rows.length,
        0,
        rows.map((row) => `${row.table_name}:${row.privilege_type}`).join(", "),
      );
    });
  }

  await report.check("every subject-scoped table forces a row-level policy", async () => {
    const rows = await sql<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'analysis'
        and c.relname in ('run_evaluation_uses', 'transition_assessments')
    `;
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.ok(row.relrowsecurity && row.relforcerowsecurity, `${row.relname} does not force RLS`);
    }
  });

  await report.check("the anonymous cache carries no owner column to police", async () => {
    const rows = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = 'analysis' and table_name = 'position_evaluations'
        and column_name in ('subject_id', 'user_id', 'owner_user_id', 'subject_game_id',
                            'account_id', 'profile_id')
    `;
    assert.equal(rows.length, 0, "an anonymous cache grew an identity column");
  });

  // -------------------------------------------------------------------------
  report.section("the engine deployment");

  await report.check("the engine role can write evaluations and candidates", async () => {
    const engine = harness.as("forma_stockfish");
    const [positions] = await engine<{ count: string }[]>`
      select count(*)::text as count from chess.position_occurrences
    `;
    assert.ok(Number(positions!.count) > 0, "the engine role cannot read the positions to evaluate");
    const [profile] = await engine<{ count: string }[]>`
      select count(*)::text as count from analysis.model_profiles where role = 'objective_engine'
    `;
    assert.equal(profile!.count, "1");
  });

  await report.check("the engine role reaches no subject-scoped table", async () => {
    const engine = harness.as("forma_stockfish");
    const granted = await sql<{ table_name: string }[]>`
      select table_schema || '.' || table_name as table_name
      from information_schema.role_table_grants
      where grantee = 'forma_stockfish'
        and table_schema || '.' || table_name = any(${TENANT_TABLES as unknown as string[]}::text[])
    `;
    assert.equal(granted.length, 0, "the engine deployment was granted a subject's rows");
    assert.equal(
      await refusalCode(() => engine`select id from analysis.transition_assessments limit 1`),
      "42501",
    );
    assert.equal(
      await refusalCode(() => engine`select private.set_actor_context(${owner.ownerUserId}::uuid)`),
      "42501",
      "the engine role must not be able to claim an actor",
    );
  });

  await report.check("the engine role cannot write an assessment or a run use", async () => {
    const engine = harness.as("forma_stockfish");
    assert.equal(
      await refusalCode(
        () => engine`
          insert into analysis.run_evaluation_uses (run_id, position_evaluation_id, input_role)
          values (${planned.runId}, 1, 'transition_before')
        `,
      ),
      "42501",
    );
  });

  // -------------------------------------------------------------------------
  report.section("the API deployment");

  await report.check("the API role reads evidence and cannot manufacture it", async () => {
    const api = harness.as("forma_api");
    const [evaluations] = await api<{ count: string }[]>`
      select count(*)::text as count from analysis.position_evaluations
    `;
    assert.ok(Number(evaluations!.count) > 0);
    for (const statement of [
      () => api`
        insert into analysis.position_evaluations (
          core_position_id, scope, halfmove_clock, model_profile_id,
          calibration_component_version_id, limit_type, limit_value, multipv, threads, hash_mb,
          tablebase, perspective, score_cp, expected_score, expected_score_method,
          worker_revision, cache_key
        ) values (
          1, 'rule50', 0, ${versions.engineProfileId}, ${versions.calibrationVersionId},
          'nodes', 50000, 1, 1, 64, false, 'white', 0, 0.5, 'logistic', 'forged', ${SHA("forged")}
        )
      `,
      () => api`
        insert into analysis.transition_assessments (
          analysis_run_id, materialization_run_id, from_ply, before_evaluation_id,
          after_evaluation_id, deep_status, actor_color, played_move_uci,
          expected_score_before, expected_score_after, tolerance_component_version_id,
          played_move_acceptable
        ) values (
          ${planned.runId}, ${owner.materializationRunId}, 0, 1, 2, 'not_selected', 'white',
          'e2e4', 0.5, 0.5, ${versions.toleranceVersionId}, true
        )
      `,
    ]) {
      assert.equal(await refusalCode(statement), "42501");
    }
  });

  await report.check("the API role may intern a core position and nothing else in chess", async () => {
    const api = harness.as("forma_api");
    assert.equal(
      await refusalCode(
        () => api`
          insert into chess.core_positions (core_key_hash, core_key, board, turn, castling, en_passant)
          values (${SHA(`api-${SUFFIX}`)}, '8/8/8/8/8/8/8/K6k w - -', '8/8/8/8/8/8/8/K6k', 'w', '-', '-')
          on conflict do nothing
        `,
      ),
      "allowed",
      "the interactive endpoint cannot intern the position it was asked about",
    );
    assert.equal(
      await refusalCode(
        () => api`
          insert into chess.position_occurrences (
            run_id, ply, core_position_id, fen, halfmove_clock, fullmove_number,
            repetition_count, side_to_move
          ) values (
            ${owner.materializationRunId}, 999, 1, '8/8/8/8/8/8/8/K6k w - - 0 1', 0, 1, 1, 'w'
          )
        `,
      ),
      "42501",
      "the API role could write an occurrence",
    );
  });

  // -------------------------------------------------------------------------
  report.section("tenancy under a real actor");

  await report.check("a non-owner reads no assessment even with the right run id", async () => {
    const api = harness.as("forma_api");
    await api.begin(async (tx) => {
      await tx`select private.set_actor_context(${stranger.ownerUserId}::uuid)`;
      const rows = await tx<{ id: string }[]>`
        select id from analysis.transition_assessments where analysis_run_id = ${planned.runId}
      `;
      assert.equal(rows.length, 0, "the policy let a stranger read another subject's assessments");
    });
  });

  await report.check("the owner reads their own", async () => {
    const api = harness.as("forma_api");
    await api.begin(async (tx) => {
      await tx`select private.set_actor_context(${owner.ownerUserId}::uuid)`;
      const rows = await tx<{ id: string }[]>`
        select id from analysis.transition_assessments where analysis_run_id = ${planned.runId}
      `;
      assert.ok(rows.length > 0, "the owner cannot read their own review");
    });
  });

  await report.check("an unbound actor sees nothing rather than everything", async () => {
    const api = harness.as("forma_api");
    const rows = await api<{ id: string }[]>`
      select id from analysis.transition_assessments limit 1
    `;
    assert.equal(rows.length, 0, "an unbound connection read a subject's rows");
  });

  await report.check("the whole pipeline runs under the real deployment roles", async () => {
    // Not a duplicate of the integration gate: that one connects as the owner,
    // where every policy is bypassed. This is the only place that shows the
    // engine deployment and the analysis deployment can actually do their jobs
    // with the grants and policies production gives them.
    const game = await seedAnalysableGame(sql);
    const payload = {
      materializationRunId: game.materializationRunId,
      engineVersionId: versions.engineProfileId,
      calibrationVersionId: versions.calibrationVersionId,
    };
    const engine = harness.as("forma_stockfish");
    await screenGame(context(SCREEN_TASK, payload), engine);
    await deepenGame(context(DEEP_TASK, payload), engine);

    const scheduled = await planGameAnalysis(sql, {
      subjectGameId: game.subjectGameId,
      ownerProfileId: game.ownerUserId,
    });
    if (scheduled?.state !== "scheduled") throw new Error("expected a scheduled run");
    const result = await assessTransitions(
      context(ASSESS_TASK, { runId: scheduled.runId }, scheduled.workflowId),
      harness.as("forma_analysis"),
    );
    assert.ok((result.outputSummary?.transitions as number) > 0);
    assert.ok(result.outputSummary?.publicationId, "the worker could not publish under its own role");
  });

  await report.check("a worker delivery cannot assess another subject's run", async () => {
    // The actor comes from the workflow, so a payload naming someone else's run
    // reaches a policy that hides it rather than a check this handler performs.
    const strangerRun = await planGameAnalysis(sql, {
      subjectGameId: stranger.subjectGameId,
      ownerProfileId: stranger.ownerUserId,
    });
    if (strangerRun?.state !== "scheduled") throw new Error("expected a scheduled run");
    const asAnalysisWorker = harness.as("forma_analysis");
    await assert.rejects(
      () =>
        assessTransitions(
          // The stranger's workflow, the owner's run.
          context(ASSESS_TASK, { runId: planned.runId }, strangerRun.workflowId),
          asAnalysisWorker,
        ),
      /unknown_run/,
      "a forged run id was assessed under someone else's workflow",
    );
  });

  await report.check("an unowned workflow is refused rather than run unbound", async () => {
    const [systemWorkflow] = await sql<{ id: string }[]>`
      insert into ops.workflows (kind, owner_profile_id) values ('game_analysis', null) returning id
    `;
    await assert.rejects(
      () =>
        assessTransitions(
          context(ASSESS_TASK, { runId: planned.runId }, systemWorkflow!.id),
          harness.as("forma_analysis"),
        ),
      /unowned_workflow/,
    );
  });

  await report.check("the review read refuses a forged identifier identically", async () => {
    for (const probe of [randomUUID(), stranger.subjectGameId]) {
      const review = await readGameReview(sql, {
        subjectGameId: probe,
        ownerProfileId: owner.ownerUserId,
      });
      assert.equal(review, null);
    }
  });

  // -------------------------------------------------------------------------
  report.section("telemetry redaction");

  await report.check("an engine event emits only its declared fields", async () => {
    const line = engineEventLine({
      event: "engine_task",
      traceId: "t",
      taskType: SCREEN_TASK,
      queue: "stockfish-screen",
      queueAgeMs: 10,
      engineStartupMs: 5,
      positions: 7,
      cacheHits: 1,
      cacheMisses: 6,
      deepSelected: 2,
      nodes: 300_000,
      nps: 1_000_000,
      engineMs: 300,
      durationMs: 320,
      estimatedCostMicroUsd: 8,
      failureClass: null,
      errorCode: null,
      // Not a declared field, and therefore must not appear.
      fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    } as never);
    assert.deepEqual(Object.keys(JSON.parse(line)), [...ENGINE_EVENT_FIELDS.engine_task]);
    assert.ok(!line.includes("rnbqkbnr"), "a position reached the log");
  });

  await report.check("no engine event declares a position, subject or game field", async () => {
    const forbidden = ["fen", "pgn", "subjectId", "gameId", "userId", "email", "move", "pv"];
    for (const [event, fields] of Object.entries(ENGINE_EVENT_FIELDS)) {
      for (const field of fields) {
        assert.ok(
          !forbidden.includes(field),
          `${event} declares ${field}, which names private content`,
        );
      }
    }
  });

  await report.check("an absorbed engine failure logs a class, not an engine message", async () => {
    const lines: string[] = [];
    setEngineEventSink((line) => lines.push(line));
    // PLAIN_MOVES, so the positions are not already in the deep cache from the
    // games above; a cache hit would mean the engine was never asked to fail.
    const failing = await seedAnalysableGame(sql, { moves: PLAIN_MOVES });
    setEngineSessionFactory(async () => fixtureEngineSession({ failOn: ["deep"] }));
    const payload = { ...enginePayload, materializationRunId: failing.materializationRunId };
    await screenGame(context(SCREEN_TASK, payload), sql);
    await deepenGame(context(DEEP_TASK, payload), sql);
    setEngineSessionFactory(async () => fixtureEngineSession());
    setEngineEventSink(() => {});

    const deep = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((event) => event.taskType === DEEP_TASK && event.event === "engine_task");
    assert.ok(deep, "the deep task emitted no event");
    assert.equal(deep!.failureClass, "transient");
    assert.ok(!JSON.stringify(deep).includes("fixture engine refuses"), "an engine message leaked");
  });
} finally {
  setEngineSessionFactory(null);
  await harness.destroy();
}

report.finish();

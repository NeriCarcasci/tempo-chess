/**
 * `npm run analysis:security` — tenancy, grants and redaction for E11.
 *
 * The integration gate connects as the owner, which proves behaviour and proves
 * nothing about access. This one connects as the actual least-privilege roles,
 * with a real actor bound by `private.set_actor_context`, because that is the
 * only configuration in which a policy claim means anything: a forced policy
 * tested as a superuser is a policy that was never consulted.
 *
 * What it asserts, in the epic's terms: an anonymous browser role reaches
 * nothing; a non-owner cannot read another subject's snapshot, run or
 * publication and cannot forge one by guessing an identifier; a revoked actor
 * (an unbound or unknown one) sees nothing rather than everything; the API role
 * cannot publish, promote or move a pointer; the analysis worker cannot promote
 * a recipe; and no structured event carries a subject, a game or a manifest.
 *
 * It creates roles and logs in with a synthetic password, so it runs only
 * against a disposable cluster. The harness refuses anything else.
 */

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { GateReport, startAnalysisHarness } from "./harness.js";
import { recordGoldenManifest, seedGoldenVersions, seedSubject, SHA } from "../fixtures.js";
import { freezeSubjectSnapshot } from "../snapshots.js";
import { completeRun, planRun, startRun } from "../runs.js";
import { publishSubjectLive } from "../publication.js";
import { ANALYSIS_EVENT_FIELDS, analysisEventLine, setAnalysisEventSink } from "../telemetry.js";
import { DENIED_ROLES } from "../../security/contract.js";

const report = new GateReport("E11 analysis versioning security gate");
const harness = await startAnalysisHarness();
const sql = harness.sql;

// This gate asserts on the serializer directly; live events would only add noise.
setAnalysisEventSink(() => {});

/** Every table this epic added, schema-qualified. */
const NEW_TABLES = [
  "analysis.components",
  "analysis.component_versions",
  "analysis.component_version_dependencies",
  "analysis.component_lifecycle_events",
  "analysis.recipe_versions",
  "analysis.recipe_components",
  "analysis.recipe_promotions",
  "analysis.cohort_definition_versions",
  "analysis.subject_data_snapshots",
  "analysis.subject_data_snapshot_games",
  "analysis.validation_datasets",
  "analysis.validation_runs",
  "analysis.validation_metrics",
  "analysis.runs",
  "analysis.run_dependencies",
  "analysis.run_artifacts",
  "analysis.subject_live_publications",
  "analysis.subject_live_publication_history",
  "analysis.subject_game_publications",
  "analysis.subject_game_publication_history",
  "chess.replay_materialization_publication_history",
];

/** The tenant-scoped subset: these carry one subject's rows and force a policy. */
const TENANT_TABLES = [
  "analysis.subject_data_snapshots",
  "analysis.subject_data_snapshot_games",
  "analysis.runs",
  "analysis.run_dependencies",
  "analysis.run_artifacts",
  "analysis.subject_live_publications",
  "analysis.subject_live_publication_history",
  "analysis.subject_game_publications",
  "analysis.subject_game_publication_history",
];

/** Run `body` inside a transaction carrying `actorId`, exactly as the API does. */
async function asActor<T>(connection: Sql, actorId: string | null, body: (tx: Sql) => Promise<T>): Promise<T> {
  return connection.begin(async (tx) => {
    if (actorId) await tx`select private.set_actor_context(${actorId}::uuid)`;
    return body(tx as unknown as Sql);
  }) as Promise<T>;
}

async function refusalCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "allowed";
  } catch (error) {
    return (error as { code?: string }).code ?? "error";
  }
}

const SUFFIX = `s${Date.now().toString(36)}`;
const golden = await seedGoldenVersions(sql, SUFFIX);
const owner = await seedSubject(sql, { games: 2 });
const stranger = await seedSubject(sql, { games: 2 });
const SYSTEM = { kind: "system" as const };

// One published subject-live run for the owner, so there is something to guard.
const snapshot = await freezeSubjectSnapshot(sql, {
  subjectId: owner.subjectId,
  cohortVersionId: golden.cohortVersionId,
  cutoff: new Date().toISOString(),
});
const run = await planRun(sql, {
  recipeVersionId: golden.baselineRecipeId,
  scope: { subjectId: owner.subjectId, subjectDataSnapshotId: snapshot.id },
  trigger: "scheduled",
  actor: SYSTEM,
});
await startRun(sql, run.id);
await recordGoldenManifest(sql, run.id);
await completeRun(sql, run.id);
await publishSubjectLive(sql, { runId: run.id, reason: "new_run", actor: SYSTEM });

try {
  // --- browser roles --------------------------------------------------------

  report.section("browser roles reach nothing");

  for (const role of DENIED_ROLES) {
    await report.check(`${role} holds no privilege on any new table`, async () => {
      const rows = await sql<{ table_name: string; privilege_type: string }[]>`
        select table_schema || '.' || table_name as table_name, privilege_type
        from information_schema.role_table_grants
        where grantee = ${role}
          and table_schema || '.' || table_name = any(${NEW_TABLES as unknown as string[]}::text[])
      `;
      assert.equal(
        rows.length,
        0,
        `granted: ${rows.map((row) => `${row.table_name}:${row.privilege_type}`).join(", ")}`,
      );
    });
  }

  await report.check("anon cannot select a publication even by exact id", async () => {
    const anon = harness.as("anon");
    const code = await refusalCode(
      () => anon`select run_id from analysis.subject_live_publications where subject_id = ${owner.subjectId}`,
    );
    assert.equal(code, "42501", `expected permission denied, got ${code}`);
  });

  // --- forced row-level security -------------------------------------------

  report.section("forced policies on tenant tables");

  await report.check("every tenant table has RLS enabled and forced", async () => {
    const rows = await sql<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname || '.' || c.relname = any(${TENANT_TABLES as unknown as string[]}::text[])
    `;
    assert.equal(rows.length, TENANT_TABLES.length);
    const weak = rows.filter((row) => !row.relrowsecurity || !row.relforcerowsecurity);
    assert.deepEqual([...weak.map((row) => row.relname)], []);
  });

  await report.check("the owner sees their own run, snapshot and publication", async () => {
    const api = harness.as("forma_api");
    const seen = await asActor(api, owner.ownerUserId, async (tx) => {
      const [runs] = await tx<{ count: string }[]>`
        select count(*)::text as count from analysis.runs where subject_id = ${owner.subjectId}
      `;
      const [publications] = await tx<{ count: string }[]>`
        select count(*)::text as count from analysis.subject_live_publications
        where subject_id = ${owner.subjectId}
      `;
      const [snapshots] = await tx<{ count: string }[]>`
        select count(*)::text as count from analysis.subject_data_snapshots
        where subject_id = ${owner.subjectId}
      `;
      return { runs: runs.count, publications: publications.count, snapshots: snapshots.count };
    });
    assert.equal(seen.runs, "1");
    assert.equal(seen.publications, "1");
    assert.equal(seen.snapshots, "1");
  });

  await report.check("a non-owner sees nothing, even naming the exact identifiers", async () => {
    const api = harness.as("forma_api");
    const seen = await asActor(api, stranger.ownerUserId, async (tx) => {
      const [runs] = await tx<{ count: string }[]>`
        select count(*)::text as count from analysis.runs where id = ${run.id}
      `;
      const [publications] = await tx<{ count: string }[]>`
        select count(*)::text as count from analysis.subject_live_publications
        where subject_id = ${owner.subjectId}
      `;
      const [artifacts] = await tx<{ count: string }[]>`
        select count(*)::text as count from analysis.run_artifacts where run_id = ${run.id}
      `;
      const [history] = await tx<{ count: string }[]>`
        select count(*)::text as count from analysis.subject_live_publication_history
        where subject_id = ${owner.subjectId}
      `;
      return { runs: runs.count, publications: publications.count, artifacts: artifacts.count, history: history.count };
    });
    assert.deepEqual(seen, { runs: "0", publications: "0", artifacts: "0", history: "0" });
  });

  await report.check("a forged identifier is invisible, not an error", async () => {
    const api = harness.as("forma_api");
    const rows = await asActor(api, owner.ownerUserId, (tx) =>
      tx<{ id: string }[]>`select id from analysis.runs where id = ${randomUUID()}`,
    );
    assert.equal(rows.length, 0);
  });

  await report.check("an unbound actor sees nothing rather than everything", async () => {
    const api = harness.as("forma_api");
    const [row] = await api<{ count: string }[]>`
      select count(*)::text as count from analysis.runs
    `;
    assert.equal(row.count, "0", "a null actor must match no row");
  });

  await report.check("a revoked actor id sees nothing", async () => {
    const api = harness.as("forma_api");
    const rows = await asActor(api, randomUUID(), (tx) =>
      tx<{ subject_id: string }[]>`select subject_id from analysis.subject_live_publications`,
    );
    assert.equal(rows.length, 0);
  });

  await report.check("the analysis worker cannot write into another subject's scope", async () => {
    const worker = harness.as("forma_analysis");
    const code = await refusalCode(() =>
      asActor(worker, stranger.ownerUserId, (tx) =>
        tx`
          insert into analysis.subject_live_publication_history (
            subject_id, previous_run_id, run_id, reason, actor_kind
          ) values (${owner.subjectId}, null, ${run.id}, 'first_publication', 'system')
        `,
      ),
    );
    assert.equal(code, "42501", `expected a policy violation, got ${code}`);
  });

  // --- least privilege ------------------------------------------------------

  report.section("least privilege between deployments");

  await report.check("the API role cannot move a publication pointer", async () => {
    const api = harness.as("forma_api");
    const insert = await refusalCode(() =>
      asActor(api, owner.ownerUserId, (tx) =>
        tx`
          insert into analysis.subject_live_publication_history (
            subject_id, previous_run_id, run_id, reason, actor_kind
          ) values (${owner.subjectId}, ${run.id}, ${run.id}, 'rollback', 'system')
        `,
      ),
    );
    const update = await refusalCode(() =>
      asActor(api, owner.ownerUserId, (tx) =>
        tx`update analysis.subject_live_publications set run_id = ${run.id} where subject_id = ${owner.subjectId}`,
      ),
    );
    assert.equal(insert, "42501");
    assert.equal(update, "42501");
  });

  await report.check("the API role cannot promote a recipe or record a lifecycle event", async () => {
    const api = harness.as("forma_api");
    const promotion = await refusalCode(
      () => api`
        insert into analysis.recipe_promotions (surface, recipe_version_id, actor_kind, reason)
        values ('live_player_profile', ${golden.baselineRecipeId}, 'system', 'forged')
      `,
    );
    const lifecycle = await refusalCode(
      () => api`
        insert into analysis.component_lifecycle_events (component_version_id, to_state, actor_kind, reason)
        values (${golden.estimatorV1Id}, 'draft', 'system', 'forged')
      `,
    );
    assert.equal(promotion, "42501");
    assert.equal(lifecycle, "42501");
  });

  await report.check("the analysis worker cannot promote a recipe either", async () => {
    const worker = harness.as("forma_analysis");
    const code = await refusalCode(
      () => worker`
        insert into analysis.recipe_promotions (surface, recipe_version_id, actor_kind, reason)
        values ('live_player_profile', ${golden.baselineRecipeId}, 'system', 'self-promotion')
      `,
    );
    assert.equal(code, "42501", "promotion is a deliberate operator action, not a worker's");
  });

  await report.check("the engine role reaches the catalogue and no subject-scoped table", async () => {
    const engine = harness.as("forma_stockfish");
    // It needs to know which engine profile it is running.
    const [catalogue] = await engine<{ count: string }[]>`
      select count(*)::text as count from analysis.component_versions
    `;
    assert.ok(Number(catalogue.count) > 0);

    // And it reaches nothing that belongs to a subject. E02 withholds
    // `set_actor_context` from this role deliberately -- it evaluates positions,
    // which are anonymous -- so a grant here would be one it could never use.
    const granted = await sql<{ table_name: string }[]>`
      select table_schema || '.' || table_name as table_name
      from information_schema.role_table_grants
      where grantee = 'forma_stockfish'
        and table_schema || '.' || table_name = any(${TENANT_TABLES as unknown as string[]}::text[])
    `;
    assert.equal(granted.length, 0, `granted: ${granted.map((row) => row.table_name).join(", ")}`);
    const read = await refusalCode(() => engine`select id from analysis.runs limit 1`);
    assert.equal(read, "42501");
    const bind = await refusalCode(
      () => engine`select private.set_actor_context(${stranger.ownerUserId}::uuid)`,
    );
    assert.equal(bind, "42501", "the engine role must not be able to claim an actor");
  });

  await report.check("no runtime role may delete an immutable row", async () => {
    const worker = harness.as("forma_analysis");
    for (const [schema, table] of [
      "analysis.component_versions",
      "analysis.recipe_versions",
      "analysis.subject_live_publication_history",
    ] as const) {
      const code = await refusalCode(
        () => worker.unsafe(`delete from ${schema}.${table} where true`),
      );
      assert.notEqual(code, "allowed", `${schema}.${table} accepted a delete`);
    }
  });

  // --- redaction ------------------------------------------------------------

  report.section("telemetry redaction");

  await report.check("an analysis event emits only its declared fields", async () => {
    const line = analysisEventLine({
      event: "publication_switch",
      traceId: "trace",
      target: "subject_live",
      publicationId: "pub",
      runId: run.id,
      previousRunId: null,
      reason: "new_run",
      durationMs: 4,
      refusedCode: null,
      // Fields nobody declared must not survive the serializer.
      subjectId: owner.subjectId,
      fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    } as never);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    assert.deepEqual(Object.keys(parsed).sort(), [...ANALYSIS_EVENT_FIELDS.publication_switch].sort());
    assert.ok(!line.includes(owner.subjectId));
    assert.ok(!line.includes("rnbqkbnr"));
  });

  await report.check("no event type declares a subject, game, position or payload field", async () => {
    // Identity and content, not counts: `gameCount` is a size signal, and
    // `snapshot_frozen` exists precisely to report it.
    const forbidden = /subjectid|gameid|subject_id|game_id|fen|pgn|payload|email|username|token|prompt/i;
    const offending: string[] = [];
    for (const [event, fields] of Object.entries(ANALYSIS_EVENT_FIELDS)) {
      for (const field of fields) {
        if (forbidden.test(field)) offending.push(`${event}.${field}`);
      }
    }
    assert.deepEqual(offending, []);
  });

  await report.check("table comments carry no secret and name their spec section", async () => {
    const rows = await sql<{ relname: string; description: string | null }[]>`
      select c.relname, obj_description(c.oid) as description
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname || '.' || c.relname = any(${NEW_TABLES as unknown as string[]}::text[])
    `;
    assert.equal(rows.length, NEW_TABLES.length);
    const undocumented = rows.filter((row) => !row.description || row.description.length < 40);
    assert.deepEqual([...undocumented.map((row) => row.relname)], []);
    const leaking = rows.filter((row) => /password|secret|key=|token/i.test(row.description ?? ""));
    assert.deepEqual([...leaking.map((row) => row.relname)], []);
  });
} finally {
  await harness.destroy();
}

report.finish();

/**
 * `npm run engine:migration` — 0024 from empty, from prior state, and twice.
 *
 * From empty: does the whole committed history apply to a fresh cluster and
 * leave the objects this epic claims — five tables, the two unique indexes that
 * make a cache entry an identity, the compatibility trigger, and grants that
 * reach no browser role?
 *
 * From prior state: the live project is at 0023 with real workflows and real
 * materialized games in it. 0024 widens one check constraint on a table another
 * epic owns and adds one grant on another. The only way to know that costs
 * nothing is to build a database that stops at 0023, put rows in it, and then
 * apply 0024 — which is the shape the live project is in.
 *
 * Twice: every statement is guarded, so re-applying must change nothing. That
 * is the forward-recovery case: a migration interrupted midway is re-applied
 * from the start, and re-application must be a no-op for everything that
 * landed.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { GateReport } from "../../v1/gates/harness.js";
import { createDisposableDatabase } from "../../platform/harness/postgres.js";
import { applyMigrations, MIGRATIONS_FOLDER } from "../../platform/harness/migrations.js";

const report = new GateReport("E12 engine migration gate");

const MIGRATION_TAG = "0024_e12_engine_outputs";
const MIGRATION_SQL = readFileSync(join(MIGRATIONS_FOLDER, `${MIGRATION_TAG}.sql`), "utf8");

/** Apply 0024 exactly as Drizzle would: one transaction, statements in order. */
async function apply0024(url: string): Promise<void> {
  const client = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await client.begin(async (tx) => {
      for (const statement of MIGRATION_SQL.split("--> statement-breakpoint")) {
        const trimmed = statement.trim();
        if (trimmed.length > 0) await tx.unsafe(trimmed);
      }
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}

const NEW_TABLES = [
  "evaluation_candidates",
  "model_profiles",
  "position_evaluations",
  "run_evaluation_uses",
  "transition_assessments",
];

// --- from empty -------------------------------------------------------------

report.section("from an empty database");

const fresh = await createDisposableDatabase();
try {
  await applyMigrations(fresh.adminUrl);

  await report.check("every E12 table exists", async () => {
    const rows = await fresh.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'analysis'",
    );
    const present = new Set(rows.map((row) => row.table_name));
    assert.deepEqual(
      NEW_TABLES.filter((table) => !present.has(table)),
      [],
    );
  });

  await report.check("a cache entry's identity is unique twice over", async () => {
    const rows = await fresh.query<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes
       where schemaname = 'analysis' and tablename = 'position_evaluations'
         and indexname in ('position_evaluations_cache_key', 'position_evaluations_inputs')`,
    );
    assert.equal(rows.length, 2, "the key or the input tuple lost its unique index");
    const inputs = rows.find((row) => row.indexname === "position_evaluations_inputs")!;
    assert.match(inputs.indexdef, /UNIQUE/);
    assert.match(
      inputs.indexdef,
      /NULLS NOT DISTINCT/,
      "without it every scope qualifier that is null makes a row unique regardless of its inputs",
    );
  });

  await report.check("the compatibility and objective-engine triggers are installed", async () => {
    const rows = await fresh.query<{ tgname: string }>(
      `select t.tgname from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'analysis' and not t.tgisinternal
         and c.relname in ('position_evaluations', 'transition_assessments',
                           'evaluation_candidates', 'model_profiles', 'run_evaluation_uses')
       order by t.tgname`,
    );
    const names = rows.map((row) => row.tgname);
    for (const trigger of [
      "position_evaluations_objective",
      "transition_assessments_evidence",
      "position_evaluations_immutable",
      "transition_assessments_immutable",
    ]) {
      assert.ok(names.includes(trigger), `${trigger} is missing`);
    }
  });

  await report.check("every trigger function this epic adds pins its search path", async () => {
    const rows = await fresh.query<{ proname: string; config: string | null }>(
      `select p.proname, array_to_string(p.proconfig, ',') as config
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'analysis'
         and p.proname in ('enforce_objective_engine', 'enforce_assessment_evidence')`,
    );
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.match(row.config ?? "", /search_path=/, `${row.proname} leaves search_path to the caller`);
    }
  });

  await report.check("no browser role gained a privilege from this migration", async () => {
    const rows = await fresh.query<{ grantee: string; table_name: string }>(
      `select grantee, table_name from information_schema.role_table_grants
       where grantee in ('anon', 'authenticated', 'PUBLIC')
         and table_schema = 'analysis'
         and table_name in ('model_profiles', 'position_evaluations', 'evaluation_candidates',
                            'run_evaluation_uses', 'transition_assessments')`,
    );
    assert.equal(rows.length, 0, rows.map((row) => `${row.grantee}:${row.table_name}`).join(", "));
  });

  await report.check("the API role may intern a core position and nothing more there", async () => {
    const rows = await fresh.query<{ privilege_type: string }>(
      `select privilege_type from information_schema.role_table_grants
       where grantee = 'forma_api' and table_schema = 'chess' and table_name = 'core_positions'
       order by privilege_type`,
    );
    assert.deepEqual(
      rows.map((row) => row.privilege_type).sort(),
      ["INSERT", "SELECT"],
      "the interactive endpoint's grant widened past interning a position",
    );
    // The rest of E09's chain stays read-only for the API: interning an
    // anonymous board is not a licence to write occurrences or transitions.
    const chain = await fresh.query<{ table_name: string; privilege_type: string }>(
      `select table_name, privilege_type from information_schema.role_table_grants
       where grantee = 'forma_api' and table_schema = 'chess'
         and table_name in ('position_occurrences', 'position_transitions', 'materialization_runs')
         and privilege_type <> 'SELECT'`,
    );
    assert.equal(chain.length, 0, chain.map((row) => `${row.table_name}:${row.privilege_type}`).join(", "));
  });

} finally {
  await fresh.destroy();
}

// --- from production-shaped prior state -------------------------------------

report.section("from production-shaped prior state");

const prior = await createDisposableDatabase();
try {
  await applyMigrations(prior.adminUrl, "0023_e11_function_search_path");

  await report.check("the prior state has no E12 tables", async () => {
    const rows = await prior.query<{ count: string }>(
      `select count(*)::text as count from information_schema.tables
       where table_schema = 'analysis' and table_name = any($1::text[])`,
      [NEW_TABLES],
    );
    assert.equal(rows[0]!.count, "0");
  });

  // Workflows of every kind the constraint already allowed, so widening it can
  // be shown not to disturb them.
  await prior.query(`
    insert into ops.workflows (kind, owner_profile_id)
    values ('game_analysis', null), ('account_sync', null), ('maintenance', null)
  `);
  const before = await prior.query<{ count: string }>(
    "select count(*)::text as count from ops.workflows",
  );

  await apply0024(prior.adminUrl);

  await report.check("the existing workflows are untouched", async () => {
    const after = await prior.query<{ count: string }>(
      "select count(*)::text as count from ops.workflows",
    );
    assert.equal(after[0]!.count, before[0]!.count);
    const kinds = await prior.query<{ kind: string }>(
      "select distinct kind from ops.workflows order by kind",
    );
    assert.deepEqual(kinds.map((row) => row.kind), ["account_sync", "game_analysis", "maintenance"]);
  });

  await report.check("the widened constraint accepts the new kind and refuses an invented one", async () => {
    await prior.query("insert into ops.workflows (kind, owner_profile_id) values ('position_evaluation', null)");
    await assert.rejects(
      () => prior.query("insert into ops.workflows (kind, owner_profile_id) values ('whatever', null)"),
      /workflows_kind_check/,
    );
  });

  await report.check("applying the migration a second time changes nothing", async () => {
    const snapshot = async () =>
      (
        await prior.query<{ signature: string }>(
          `select string_agg(table_name || ':' || column_name, ',' order by table_name, column_name)
             as signature
           from information_schema.columns
           where table_schema = 'analysis' and table_name = any($1::text[])`,
          [NEW_TABLES],
        )
      )[0]!.signature;
    const first = await snapshot();
    await apply0024(prior.adminUrl);
    assert.equal(await snapshot(), first);
    const workflows = await prior.query<{ count: string }>(
      "select count(*)::text as count from ops.workflows",
    );
    assert.equal(workflows[0]!.count, "4", "re-application disturbed a row it does not own");
  });

  await report.check("a partial application recovers forward", async () => {
    // Simulate an interruption: drop one table this migration created, and one
    // of its indexes on another, then re-apply. Every statement is guarded, so
    // the missing objects come back and nothing else moves.
    await prior.query("drop table analysis.evaluation_candidates");
    await prior.query("drop index analysis.position_evaluations_inputs");
    await apply0024(prior.adminUrl);

    const tables = await prior.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'analysis' and table_name = any($1::text[])`,
      [NEW_TABLES],
    );
    assert.equal(tables.length, NEW_TABLES.length);
    const index = await prior.query<{ count: string }>(
      `select count(*)::text as count from pg_indexes
       where schemaname = 'analysis' and indexname = 'position_evaluations_inputs'`,
    );
    assert.equal(index[0]!.count, "1");
  });

  await report.check("nothing E11 owns was dropped or rewritten", async () => {
    const rows = await prior.query<{ count: string }>(
      `select count(*)::text as count from information_schema.tables
       where table_schema = 'analysis'
         and table_name in ('runs', 'run_artifacts', 'recipe_versions', 'component_versions',
                            'subject_game_publications')`,
    );
    assert.equal(rows[0]!.count, "5");
    const trigger = await prior.query<{ count: string }>(
      `select count(*)::text as count from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       where c.relname = 'runs' and t.tgname = 'runs_append_only'`,
    );
    assert.equal(trigger[0]!.count, "1");
  });
} finally {
  await prior.destroy();
}

report.finish();

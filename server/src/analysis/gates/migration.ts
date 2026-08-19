/**
 * `npm run analysis:migration` — 0022 from empty, from prior state, and twice.
 *
 * Three questions, and none of them can be answered by reading the file.
 *
 * From empty: does the whole committed history apply to a fresh cluster and
 * leave the objects this epic claims — tables, forced policies, immutability
 * triggers, the durable-idempotency index, and the composite keys that make a
 * run's scope a constraint rather than a convention?
 *
 * From prior state: 0022 backfills publication history for the materialization
 * runs E09 already published. The only way to test that is to build a database
 * that stops at 0021, put published runs in it, and then apply 0022 — which is
 * the shape the live project is in.
 *
 * Twice: every statement in 0022 is guarded, so applying it again must change
 * nothing. Drizzle's ledger would normally prevent a second run; this gate
 * executes the file directly to prove the guards, not the ledger. That is the
 * forward-recovery case — a migration interrupted midway is re-applied from the
 * start, and re-application must be a no-op for everything that landed.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { GateReport } from "../../v1/gates/harness.js";
import { createDisposableDatabase } from "../../platform/harness/postgres.js";
import { applyMigrations, MIGRATIONS_FOLDER } from "../../platform/harness/migrations.js";

const report = new GateReport("E11 analysis versioning migration gate");

const MIGRATION_TAG = "0022_e11_analysis_versions";
const MIGRATION_SQL = readFileSync(join(MIGRATIONS_FOLDER, `${MIGRATION_TAG}.sql`), "utf8");

/** Apply 0022 exactly as Drizzle would: one transaction, statements in order. */
async function apply0022(url: string): Promise<void> {
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

const EXPECTED_TABLES = 20;

// --- from empty -------------------------------------------------------------

report.section("from an empty database");

const fresh = await createDisposableDatabase();
try {
  await applyMigrations(fresh.adminUrl);

  await report.check("every analysis table exists", async () => {
    const rows = await fresh.query<{ count: string }>(
      "select count(*)::text as count from information_schema.tables where table_schema = 'analysis'",
    );
    assert.equal(rows[0].count, String(EXPECTED_TABLES));
  });

  await report.check("the materialization history table exists beside E09's pointer", async () => {
    const rows = await fresh.query<{ count: string }>(
      `select count(*)::text as count from information_schema.tables
       where table_schema = 'chess' and table_name = 'replay_materialization_publication_history'`,
    );
    assert.equal(rows[0].count, "1");
    // E09's pointer is untouched: still one published run per revision.
    const index = await fresh.query<{ count: string }>(
      `select count(*)::text as count from pg_indexes
       where schemaname = 'chess' and indexname = 'materialization_runs_one_published'`,
    );
    assert.equal(index[0].count, "1");
  });

  await report.check("every trigger function pins its search path", async () => {
    // A SECURITY INVOKER function that resolves an unqualified name does so
    // through the caller's schema list. These qualify everything, so pinning
    // the path is belt to that brace -- and it keeps the platform's security
    // linter clean, which is what makes a real finding visible later.
    const rows = await fresh.query<{ proname: string }>(
      `select p.proname
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('analysis', 'chess')
         and p.prokind = 'f' and p.prorettype = 'trigger'::regtype
         and (p.proconfig is null or not exists (
           select 1 from unnest(p.proconfig) as c where c like 'search_path=%'
         ))
       order by 1`,
    );
    assert.deepEqual(rows.map((row) => row.proname), []);
  });

  await report.check("immutability triggers are installed on every append-only table", async () => {
    const rows = await fresh.query<{ tablename: string }>(
      `select c.relname as tablename
       from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
       join pg_proc p on p.oid = t.tgfoid
       where p.proname in ('refuse_mutation', 'refuse_run_rewrite') and not t.tgisinternal
       order by 1`,
    );
    const guarded = new Set(rows.map((row) => row.tablename));
    for (const table of [
      "components",
      "component_versions",
      "component_version_dependencies",
      "component_lifecycle_events",
      "recipe_versions",
      "recipe_components",
      "recipe_promotions",
      "cohort_definition_versions",
      "subject_data_snapshots",
      "subject_data_snapshot_games",
      "validation_datasets",
      "validation_runs",
      "validation_metrics",
      "runs",
      "run_dependencies",
      "run_artifacts",
      "subject_live_publication_history",
      "subject_game_publication_history",
      "replay_materialization_publication_history",
    ]) {
      assert.ok(guarded.has(table), `${table} has no immutability trigger`);
    }
  });

  await report.check("the durable idempotency index is partial, not total", async () => {
    const rows = await fresh.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
       where schemaname = 'analysis' and indexname = 'runs_input_manifest_live'`,
    );
    assert.equal(rows.length, 1);
    assert.match(rows[0].indexdef, /UNIQUE/);
    // Total would make a retry after a genuine failure impossible.
    assert.match(rows[0].indexdef, /WHERE .*'planned'.*'running'.*'succeeded'/);
  });

  await report.check("a run's scope is a foreign key, not a convention", async () => {
    const rows = await fresh.query<{ conname: string }>(
      `select conname from pg_constraint
       where conrelid = 'analysis.runs'::regclass and contype = 'f'
         and conname in ('runs_game_belongs_to_subject', 'runs_snapshot_belongs_to_subject')
       order by 1`,
    );
    assert.deepEqual(rows.map((row) => row.conname), [
      "runs_game_belongs_to_subject",
      "runs_snapshot_belongs_to_subject",
    ]);
  });

  await report.check("every foreign key in analysis and chess is indexed", async () => {
    // Platform spec §10, using E02's rule rather than a looser one: a composite
    // key needs an index that *leads* with its columns in the constraint's
    // order. An index over the same columns reversed does not serve the path.
    const rows = await fresh.query<{ table_name: string; conname: string }>(
      `with fk as (
         select con.oid, con.conrelid, con.conname, con.conkey as cols,
                array_length(con.conkey, 1) as width
         from pg_constraint con
         join pg_class c on c.oid = con.conrelid
         join pg_namespace n on n.oid = c.relnamespace
         where con.contype = 'f' and n.nspname in ('analysis', 'chess')
       ), covered as (
         select distinct fk.oid
         from fk join pg_index i on i.indrelid = fk.conrelid
         where (
           select array_agg(key order by ord)
           from unnest(string_to_array(i.indkey::text, ' ')::smallint[]) with ordinality as k(key, ord)
           where ord <= fk.width
         ) = fk.cols
       )
       select (fk.conrelid::regclass)::text as table_name, fk.conname as conname
       from fk where fk.oid not in (select oid from covered) order by 1, 2`,
    );
    assert.deepEqual(rows.map((row) => `${row.table_name}.${row.conname}`), []);
  });

  await report.check("no browser role gained a privilege from this migration", async () => {
    const rows = await fresh.query<{ grantee: string; table_name: string }>(
      `select grantee, table_name from information_schema.role_table_grants
       where grantee in ('PUBLIC', 'anon', 'authenticated')
         and table_schema in ('analysis')`,
    );
    assert.deepEqual(rows.map((row) => `${row.grantee}:${row.table_name}`), []);
  });
} finally {
  await fresh.destroy();
}

// --- from prior state, then again -------------------------------------------

report.section("from production-shaped prior state");

const prior = await createDisposableDatabase();
try {
  await applyMigrations(prior.adminUrl, "0021_e10_backfill");

  await report.check("the prior state has no analysis tables", async () => {
    const rows = await prior.query<{ count: string }>(
      "select count(*)::text as count from information_schema.tables where table_schema = 'analysis'",
    );
    assert.equal(rows[0].count, "0");
  });

  // Two published materialization runs and one superseded, exactly the shape
  // E09 leaves behind and the live project is in.
  const seeded = await prior.query<{ id: string }>(`
    with game as (
      insert into chess.provider_games (provider_id, provider_game_id)
      values (2, 'migration-gate-1'), (2, 'migration-gate-2')
      returning id
    ), revision as (
      insert into chess.game_replay_revisions (
        provider_game_id, revision_no, normalizer_component_version_id, normalized_replay,
        normalized_sha256, played_at, result, ply_count, revision_reason
      )
      select g.id, 1, 'norm-v1', '{"moves":[]}'::jsonb, md5(g.id::text) || md5(g.id::text),
             now(), 'white', 4, 'first_seen'
      from game g
      returning id
    )
    insert into chess.materialization_runs (
      replay_revision_id, materializer_version, checksum, state, occurrence_count,
      transition_count, published_at
    )
    select r.id, 'core-key-v1', md5(r.id::text) || md5(r.id::text), 'published', 5, 4, now()
    from revision r
    returning id
  `);
  assert.equal(seeded.length, 2);
  await prior.query(`
    insert into chess.materialization_runs (
      replay_revision_id, materializer_version, checksum, state, occurrence_count, transition_count
    )
    select replay_revision_id, 'core-key-v0', md5(id::text || 'old') || md5(id::text || 'old'),
           'superseded', 5, 4
    from chess.materialization_runs where state = 'published' limit 1
  `);

  await apply0022(prior.adminUrl);

  await report.check("the backfill records one history row per published run", async () => {
    const rows = await prior.query<{ count: string; reasons: string }>(
      `select count(*)::text as count, string_agg(distinct reason, ',') as reasons
       from chess.replay_materialization_publication_history`,
    );
    assert.equal(rows[0].count, "2", "one per published run, and none for the superseded one");
    assert.equal(rows[0].reasons, "reconciliation", "it records what was found, not a promotion nobody made");
  });

  await report.check("the backfill takes the run's own published_at, not now()", async () => {
    const rows = await prior.query<{ mismatched: string }>(
      `select count(*)::text as mismatched
       from chess.replay_materialization_publication_history h
       join chess.materialization_runs r on r.id = h.run_id
       where h.published_at is distinct from coalesce(r.published_at, r.created_at)`,
    );
    assert.equal(rows[0].mismatched, "0");
  });

  await report.check("no existing row was modified", async () => {
    const rows = await prior.query<{ count: string }>(
      `select count(*)::text as count from chess.materialization_runs where state = 'published'`,
    );
    assert.equal(rows[0].count, "2");
    const superseded = await prior.query<{ count: string }>(
      `select count(*)::text as count from chess.materialization_runs where state = 'superseded'`,
    );
    assert.equal(superseded[0].count, "1");
  });

  await report.check("applying the migration a second time changes nothing", async () => {
    const before = await prior.query<{ history: string; tables: string }>(
      `select
         (select count(*)::text from chess.replay_materialization_publication_history) as history,
         (select count(*)::text from information_schema.tables where table_schema = 'analysis') as tables`,
    );
    await apply0022(prior.adminUrl);
    const after = await prior.query<{ history: string; tables: string }>(
      `select
         (select count(*)::text from chess.replay_materialization_publication_history) as history,
         (select count(*)::text from information_schema.tables where table_schema = 'analysis') as tables`,
    );
    assert.deepEqual({ ...after[0] }, { ...before[0] });
  });

  await report.check("a partial application recovers forward", async () => {
    // Simulate an interruption: drop one table this migration created and
    // re-apply. Every statement is guarded, so the missing object comes back
    // and nothing else moves.
    await prior.query("drop table analysis.validation_metrics");
    await apply0022(prior.adminUrl);
    const rows = await prior.query<{ count: string }>(
      "select count(*)::text as count from information_schema.tables where table_schema = 'analysis'",
    );
    assert.equal(rows[0].count, String(EXPECTED_TABLES));
    const history = await prior.query<{ count: string }>(
      "select count(*)::text as count from chess.replay_materialization_publication_history",
    );
    assert.equal(history[0].count, "2", "recovery did not duplicate the backfill");
  });

  await report.check("the pointer can be rolled back after the migration", async () => {
    const [{ id: revisionId }] = await prior.query<{ id: string }>(
      `select replay_revision_id as id from chess.materialization_runs where state = 'superseded' limit 1`,
    );
    const client = postgres(prior.adminUrl, { max: 1, prepare: false, onnotice: () => {} });
    try {
      const { publishRun, rollbackMaterialization, materializationHistory } = await import(
        "../../positions/materialize.js"
      );
      const [superseded] = await client<{ id: string }[]>`
        select id from chess.materialization_runs
        where replay_revision_id = ${revisionId} and state = 'superseded'
      `;
      const forward = await publishRun(client, superseded.id, { reason: "new_run" });
      assert.equal(forward.published, true);
      const back = await rollbackMaterialization(client, revisionId);
      assert.equal(back.published, true);
      const history = await materializationHistory(client, revisionId);
      assert.equal(history[0].reason, "rollback");
      assert.equal(history.length, 3, "the backfilled row, the switch, and the rollback");
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  await report.check("the new composite unique key did not disturb subject games", async () => {
    const rows = await prior.query<{ conname: string }>(
      `select conname from pg_constraint
       where conrelid = 'chess.subject_games'::regclass and conname = 'subject_games_id_subject_unique'`,
    );
    assert.equal(rows.length, 1);
    const primary = await prior.query<{ conname: string }>(
      `select conname from pg_constraint
       where conrelid = 'chess.subject_games'::regclass and contype = 'p'`,
    );
    assert.equal(primary.length, 1, "the primary key is still the primary key");
  });
} finally {
  await prior.destroy();
}

report.finish();

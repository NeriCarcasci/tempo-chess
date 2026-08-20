/**
 * `npm run models:migration` — 0027 from empty, from prior state, and twice.
 *
 * From empty: does the whole committed history apply to a fresh cluster and
 * leave what this epic claims — eight tables, the triggers that make the
 * separation hold, and grants that reach no browser role?
 *
 * From prior state: the live project was at 0026 with real runs and real
 * assessments in it when 0027 landed. 0027 adds tables and one trigger on a
 * table E12 owns. The only way to know that costs nothing is to build a
 * database that stops at 0026, put rows in it, and then apply 0027.
 *
 * Twice: every statement is guarded, so re-applying must change nothing. That
 * is the forward-recovery case — a migration interrupted midway is re-applied
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

const report = new GateReport("E14 human context migration gate");

const MIGRATION_TAG = "0027_e14_practical_context";
const MIGRATION_SQL = readFileSync(join(MIGRATIONS_FOLDER, `${MIGRATION_TAG}.sql`), "utf8");

/** Apply 0027 exactly as Drizzle would: one transaction, statements in order. */
async function apply0027(url: string): Promise<void> {
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
  "model_agreement_assessments",
  "model_assets",
  "model_calibration_slices",
  "model_inferences",
  "model_licence_reviews",
  "model_move_probabilities",
  "practical_context_assessments",
  "run_model_inference_uses",
];

const NEW_TRIGGERS = [
  "model_profiles_licence_reviewed",
  "model_inferences_source",
  "practical_context_evidence",
];

// --- from empty -------------------------------------------------------------

report.section("from an empty database");

{
  const db = await createDisposableDatabase();
  try {
    await applyMigrations(db.adminUrl);
    const sql = postgres(db.adminUrl, { max: 1, prepare: false, onnotice: () => {} });
    try {
      await report.check("every table this epic claims exists", async () => {
        const rows = await sql<{ table_name: string }[]>`
          select table_name from information_schema.tables
          where table_schema = 'analysis' and table_name = any(${NEW_TABLES})
          order by table_name
        `;
        assert.deepEqual(
          rows.map((row) => row.table_name),
          NEW_TABLES,
        );
      });

      await report.check("the separation triggers exist", async () => {
        const rows = await sql<{ tgname: string }[]>`
          select tgname from pg_trigger where tgname = any(${NEW_TRIGGERS}) and not tgisinternal
          order by tgname
        `;
        assert.deepEqual(
          rows.map((row) => row.tgname).sort(),
          [...NEW_TRIGGERS].sort(),
        );
      });

      await report.check("the practical pressure bounds are generated, not written", async () => {
        const rows = await sql<{ column_name: string; is_generated: string }[]>`
          select column_name, is_generated from information_schema.columns
          where table_schema = 'analysis' and table_name = 'practical_context_assessments'
            and column_name in ('practical_pressure_lower', 'practical_pressure_upper')
          order by column_name
        `;
        assert.equal(rows.length, 2);
        for (const row of rows) assert.equal(row.is_generated, "ALWAYS", row.column_name);
      });

      await report.check("no browser role reaches any of it", async () => {
        const rows = await sql<{ table_name: string; grantee: string }[]>`
          select table_name, grantee from information_schema.role_table_grants
          where table_schema = 'analysis' and table_name = any(${NEW_TABLES})
            and grantee in ('anon', 'authenticated', 'public', 'PUBLIC')
        `;
        assert.deepEqual([...rows], [], "a browser role can reach a human-context table");
      });

      await report.check("the API reads and the analysis worker writes", async () => {
        const rows = await sql<{ grantee: string; privilege_type: string }[]>`
          select distinct grantee, privilege_type from information_schema.role_table_grants
          where table_schema = 'analysis' and table_name = 'practical_context_assessments'
            and grantee in ('forma_api', 'forma_analysis')
          order by grantee, privilege_type
        `;
        const byRole = new Map<string, string[]>();
        for (const row of rows) {
          byRole.set(row.grantee, [...(byRole.get(row.grantee) ?? []), row.privilege_type]);
        }
        assert.deepEqual(byRole.get("forma_api")?.sort(), ["SELECT"]);
        assert.deepEqual(byRole.get("forma_analysis")?.sort(), ["INSERT", "SELECT"]);
      });

      await report.check("re-applying 0027 changes nothing", async () => {
        const before = await objectFingerprint(sql);
        await apply0027(db.adminUrl);
        const after = await objectFingerprint(sql);
        assert.deepEqual(after, before);
      });
    } finally {
      await sql.end({ timeout: 5 });
    }
  } finally {
    await db.destroy();
  }
}

// --- from production-shaped prior state -------------------------------------

report.section("from a database that stopped at 0026 and has rows in it");

{
  const db = await createDisposableDatabase();
  try {
    await applyMigrations(db.adminUrl, "0026_e13_roles_cardinality");
    const sql = postgres(db.adminUrl, { max: 1, prepare: false, onnotice: () => {} });
    try {
      await report.check("the prior state has the objects 0027 will build on", async () => {
        const [row] = await sql<{ count: string }[]>`
          select count(*)::text as count from information_schema.tables
          where table_schema = 'analysis'
            and table_name in ('model_profiles', 'transition_assessments', 'validation_runs')
        `;
        assert.equal(row?.count, "3");
      });

      await report.check("a cleared profile written before 0027 is left alone", async () => {
        // The live project already had one: E12's Stockfish profile, cleared
        // with no review row, because the review table did not exist yet. The
        // new trigger fires before insert only, so an existing row cannot be
        // invalidated by a migration — which is what makes 0027 safe to apply
        // to a database with history in it.
        const componentVersionId = await seedObjectiveProfile(sql);
        await apply0027(db.adminUrl);
        const [row] = await sql<{ licence_review_status: string }[]>`
          select licence_review_status from analysis.model_profiles
          where component_version_id = ${componentVersionId}
        `;
        assert.equal(row?.licence_review_status, "cleared");
      });

      await report.check("and a new cleared profile now needs its review", async () => {
        await assert.rejects(
          () => sql`
            insert into analysis.model_profiles (
              component_version_id, role, hardware_class, input_context_contract,
              output_interpretation_contract, licence_review_status
            )
            select gen_random_uuid(), 'human_policy', 'cpu_model', 'human_policy_context.v1',
                   'human_policy_distribution.v1', 'cleared'
          `,
          /cleared without a cleared licence review|violates foreign key/,
        );
      });
    } finally {
      await sql.end({ timeout: 5 });
    }
  } finally {
    await db.destroy();
  }
}

report.finish();

// ---------------------------------------------------------------------------

async function objectFingerprint(sql: postgres.Sql): Promise<unknown[]> {
  const rows = await sql<
    { table_name: string; column_name: string; data_type: string; is_nullable: string }[]
  >`
    select table_name, column_name, data_type, is_nullable
    from information_schema.columns
    where table_schema = 'analysis' and table_name = any(${NEW_TABLES})
    order by table_name, column_name
  `;
  return [...rows];
}

/**
 * An objective-engine profile in the shape E12 wrote it: cleared, with no
 * licence review, because that table did not exist when the row was made.
 */
async function seedObjectiveProfile(sql: postgres.Sql): Promise<string> {
  const [component] = await sql<{ id: string }[]>`
    insert into analysis.components (
      component_key, category, description, input_contract, output_contract
    ) values (
      'gate_engine', 'engine_profile', 'A gate fixture.', 'core_position.v1',
      'objective_evaluation.v1'
    )
    returning id
  `;
  const [version] = await sql<{ id: string }[]>`
    insert into analysis.component_versions (
      component_id, version, implementation_sha256, configuration, configuration_hash,
      content_hash, deterministic
    ) values (
      ${component!.id}, '1', repeat('a', 64), '{}'::jsonb, repeat('b', 64), repeat('c', 64), true
    )
    returning id
  `;
  await sql`
    insert into analysis.model_profiles (
      component_version_id, role, hardware_class, input_context_contract,
      output_interpretation_contract, licence_review_status, licence_note
    ) values (
      ${version!.id}, 'objective_engine', 'cpu_engine', 'core_position.v1',
      'objective_evaluation.v1', 'cleared', 'GPL-3.0-or-later'
    )
  `;
  return version!.id;
}

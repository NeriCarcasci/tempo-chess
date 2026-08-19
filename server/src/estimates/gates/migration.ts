/**
 * `npm run estimates:migration` — 0028 from empty, from prior state, and twice.
 *
 * From empty: does the committed history apply to a fresh cluster and leave the
 * nine tables and the deferred evidence trigger this epic claims?
 *
 * From prior state: the live project was at 0027 with real runs in it. 0028 is
 * purely additive, so the check is that a database with rows in it takes it
 * without touching them.
 *
 * Twice: every statement is guarded, so re-applying must change nothing — the
 * forward-recovery case where a migration interrupted midway is re-applied from
 * the start.
 */

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { GateReport } from "../../v1/gates/harness.js";
import { createDisposableDatabase } from "../../platform/harness/postgres.js";
import { applyMigrations, MIGRATIONS_FOLDER } from "../../platform/harness/migrations.js";

const report = new GateReport("E15 estimates migration gate");

const MIGRATION_TAG = "0028_e15_estimates_findings";
const MIGRATION_SQL = readFileSync(join(MIGRATIONS_FOLDER, `${MIGRATION_TAG}.sql`), "utf8");

async function apply0028(url: string): Promise<void> {
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
  "finding_evidence",
  "findings",
  "player_skill_estimates",
  "player_trajectory_bins",
  "player_trajectory_snapshots",
  "rating_pool_calibration_versions",
  "rendered_explanations",
  "skill_dimensions",
  "subject_rating_scale_estimates",
];

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
        assert.deepEqual(rows.map((row) => row.table_name), NEW_TABLES);
      });

      await report.check("the evidence trigger is deferred, not immediate", async () => {
        const [row] = await sql<{ tgdeferrable: boolean; tginitdeferred: boolean }[]>`
          select tgdeferrable, tginitdeferred from pg_trigger
          where tgname = 'findings_have_evidence'
        `;
        assert.ok(row, "the trigger is missing");
        assert.equal(row!.tgdeferrable, true);
        assert.equal(row!.tginitdeferred, true, "a finding and its evidence cannot land together");
      });

      await report.check("a factual finding with no evidence is refused at commit", async () => {
        const runId = await seedRun(sql);
        await assert.rejects(
          () =>
            sql.begin(async (tx) => {
              await tx`
                insert into analysis.findings (
                  analysis_run_id, subject_id, finding_type, priority, confidence_tier,
                  claim, claim_family
                )
                select ${runId}, r.subject_id, 'strength', 50, 'high', '{}'::jsonb,
                       'concept_success'
                from analysis.runs r where r.id = ${runId}
              `;
            }),
          /no supporting evidence/,
        );
      });

      await report.check("no browser role reaches any of it", async () => {
        const rows = await sql<{ table_name: string }[]>`
          select table_name from information_schema.role_table_grants
          where table_schema = 'analysis' and table_name = any(${NEW_TABLES})
            and grantee in ('anon', 'authenticated', 'public', 'PUBLIC')
        `;
        assert.deepEqual([...rows], []);
      });

      await report.check("the API reads and the analysis worker writes", async () => {
        const rows = await sql<{ grantee: string; privilege_type: string }[]>`
          select distinct grantee, privilege_type from information_schema.role_table_grants
          where table_schema = 'analysis' and table_name = 'findings'
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

      await report.check("re-applying 0028 changes nothing", async () => {
        const before = await fingerprint(sql);
        await apply0028(db.adminUrl);
        assert.deepEqual(await fingerprint(sql), before);
      });
    } finally {
      await sql.end({ timeout: 5 });
    }
  } finally {
    await db.destroy();
  }
}

report.section("from a database that stopped at 0027 and has rows in it");

{
  const db = await createDisposableDatabase();
  try {
    await applyMigrations(db.adminUrl, "0027_e14_practical_context");
    const sql = postgres(db.adminUrl, { max: 1, prepare: false, onnotice: () => {} });
    try {
      let runId = "";
      await report.check("the prior state has rows 0028 must not disturb", async () => {
        runId = await seedRun(sql);
        const [row] = await sql<{ count: string }[]>`
          select count(*)::text as count from analysis.runs where id = ${runId}
        `;
        assert.equal(row?.count, "1");
      });

      await report.check("0028 applies and leaves them alone", async () => {
        await apply0028(db.adminUrl);
        const [row] = await sql<{ count: string }[]>`
          select count(*)::text as count from analysis.runs where id = ${runId}
        `;
        assert.equal(row?.count, "1");
        const [table] = await sql<{ count: string }[]>`
          select count(*)::text as count from information_schema.tables
          where table_schema = 'analysis' and table_name = 'findings'
        `;
        assert.equal(table?.count, "1");
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

async function fingerprint(sql: postgres.Sql): Promise<unknown[]> {
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

/** The smallest real run: a profile, a subject, a recipe and a planned run. */
async function seedRun(sql: postgres.Sql): Promise<string> {
  const [profile] = await sql<{ user_id: string }[]>`
    insert into app.profiles (user_id) values (gen_random_uuid()) returning user_id
  `;
  const [subject] = await sql<{ id: string }[]>`
    insert into app.analysis_subjects (kind, owner_user_id, display_label)
    values ('personal', ${profile!.user_id}, 'migration gate') returning id
  `;
  const [component] = await sql<{ id: string }[]>`
    insert into analysis.components (
      component_key, category, description, input_contract, output_contract
    ) values (
      'gate_estimator', 'estimator', 'A gate fixture.', 'a.v1', 'b.v1'
    )
    on conflict (component_key) do update set component_key = excluded.component_key
    returning id
  `;
  const [version] = await sql<{ id: string }[]>`
    insert into analysis.component_versions (
      component_id, version, implementation_sha256, configuration, configuration_hash,
      content_hash, deterministic
    ) values (
      ${component!.id}, ${randomHex().slice(0, 8)}, ${randomHex()}, '{}'::jsonb,
      ${randomHex()}, ${randomHex()}, true
    )
    returning id
  `;
  const [recipe] = await sql<{ id: string }[]>`
    insert into analysis.recipe_versions (
      recipe_key, version, run_type, input_schema_version, output_schema_version,
      required_artifacts, deterministic, manifest_sha256
    ) values (
      'gate_report', ${randomHex().slice(0, 8)}, 'subject_live', 'a.v1', 'b.v1',
      array['skill_estimates']::text[], true, ${randomHex()}
    )
    returning id
  `;
  await sql`
    insert into analysis.recipe_components (recipe_version_id, role, component_version_id)
    values (${recipe!.id}, 'estimator', ${version!.id})
  `;
  // A subject-level run is scoped by its frozen snapshot, not by a game:
  // `runs_scope_by_type` refuses one without it, which is the constraint that
  // makes "which evidence did this report see" answerable.
  const [cohort] = await sql<{ id: string }[]>`
    insert into analysis.cohort_definition_versions (
      cohort_key, version, definition, definition_hash
    ) values ('gate_cohort', '1', '{}'::jsonb, repeat('f', 64))
    on conflict (cohort_key, version) do update set cohort_key = excluded.cohort_key
    returning id
  `;
  const [snapshot] = await sql<{ id: string }[]>`
    insert into analysis.subject_data_snapshots (
      subject_id, cohort_definition_version_id, cutoff, snapshot_hash, game_count,
      under_covered
    ) values (
      ${subject!.id}, ${cohort!.id}, now(), ${randomHex()}, 0, true
    )
    returning id
  `;
  const [run] = await sql<{ id: string }[]>`
    insert into analysis.runs (
      run_type, recipe_version_id, subject_id, subject_data_snapshot_id, status,
      input_manifest_hash, trigger_kind, actor_kind
    ) values (
      'subject_live', ${recipe!.id}, ${subject!.id}, ${snapshot!.id}, 'planned',
      ${randomHex()}, 'scheduled', 'system'
    )
    returning id
  `;
  return run!.id;
}

/** A distinct 64-hex string, so two seeded runs never collide on a hash. */
function randomHex(): string {
  return (randomUUID() + randomUUID()).replace(/-/g, "");
}

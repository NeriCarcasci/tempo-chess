/**
 * `npm run onboarding:migration` — 0029 from empty, from prior state, and twice.
 *
 * The checks that matter are the three promises the schema makes: a baseline
 * pins what it was built from, a coverage item cannot be redacted, and
 * activation cannot be recorded without the three things it requires. Each is
 * attempted against a real database rather than asserted about the DDL text.
 */

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { GateReport } from "../../v1/gates/harness.js";
import { createDisposableDatabase } from "../../platform/harness/postgres.js";
import { applyMigrations, MIGRATIONS_FOLDER } from "../../platform/harness/migrations.js";

const report = new GateReport("E16 onboarding migration gate");

const MIGRATION_TAG = "0029_e16_onboarding_baseline";
const MIGRATION_SQL = readFileSync(join(MIGRATIONS_FOLDER, `${MIGRATION_TAG}.sql`), "utf8");

async function apply0029(url: string): Promise<void> {
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
  "baseline_report_items",
  "baseline_reports",
  "data_coverage_dimensions",
  "data_coverage_snapshots",
  "diagnostic_attempts",
  "diagnostic_session_items",
  "diagnostic_sessions",
  "onboarding_runs",
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
          where table_schema = 'coaching' and table_name = any(${NEW_TABLES})
          order by table_name
        `;
        assert.deepEqual(rows.map((row) => row.table_name), NEW_TABLES);
      });

      const seeded = await seedRun(sql);

      await report.check("activation without the three preconditions is refused", async () => {
        await assert.rejects(
          () => sql`
            update coaching.onboarding_runs
            set activated_at = now(), status = 'activated', stage = 'activated',
                completed_at = now()
            where id = ${seeded.runId}
          `,
          /onboarding_activation_requires_all_three/,
        );
      });

      await report.check("activation with all three is allowed", async () => {
        await sql`
          update coaching.onboarding_runs
          set report_viewed_at = now(), goal_selected_at = now(),
              commitment_accepted_at = now()
          where id = ${seeded.runId}
        `;
        await sql`
          update coaching.onboarding_runs
          set activated_at = now(), status = 'activated', stage = 'activated',
              completed_at = now()
          where id = ${seeded.runId}
        `;
        const [row] = await sql<{ status: string }[]>`
          select status from coaching.onboarding_runs where id = ${seeded.runId}
        `;
        assert.equal(row?.status, "activated");
      });

      await report.check("a second active run for the same subject is refused", async () => {
        // The first run is activated now, so a new one is legal. A third while
        // that one is active is not.
        await sql`
          insert into coaching.onboarding_runs (user_id, subject_id)
          values (${seeded.userId}, ${seeded.subjectId})
        `;
        await assert.rejects(
          () => sql`
            insert into coaching.onboarding_runs (user_id, subject_id)
            values (${seeded.userId}, ${seeded.subjectId})
          `,
          /onboarding_one_active_per_subject/,
        );
      });

      await report.check("a coverage decision short of sufficient must say why", async () => {
        await assert.rejects(
          () => sql`
            insert into coaching.data_coverage_snapshots (
              subject_data_snapshot_id, policy_component_version_id, overall_state,
              total_games, eligible_games, decision_count
            ) values (
              ${seeded.snapshotId}, ${seeded.componentVersionId}, 'limited', 10, 10, 4
            )
          `,
          /coverage_limitation_stated/,
        );
      });

      await report.check("a coverage report item cannot be put behind a plan", async () => {
        const coverageId = await seedCoverage(sql, seeded);
        const reportId = await seedBaseline(sql, seeded, coverageId);
        await assert.rejects(
          () => sql`
            insert into coaching.baseline_report_items (
              baseline_report_id, section, display_order, item_kind,
              coverage_dimension_key, entitlement_key
            ) values (
              ${reportId}, 'coverage', 0, 'coverage', 'few_games', 'pro_detail'
            )
          `,
          /baseline_items_coverage_is_always_visible/,
        );
      });

      await report.check("a baseline is immutable once published", async () => {
        await assert.rejects(
          () => sql`update coaching.baseline_reports set manifest_sha256 = repeat('0', 64)`,
          /immutable|refuse/i,
        );
      });

      await report.check("one attempt per diagnostic item, forever", async () => {
        const itemId = await seedDiagnosticItem(sql, seeded);
        await sql`
          insert into coaching.diagnostic_attempts (
            session_item_id, client_attempt_id, move_uci, correct, score,
            rubric_component_version_id
          ) values (
            ${itemId}, 'attempt-one-1234', 'e2e4', true, 1, ${seeded.componentVersionId}
          )
        `;
        await assert.rejects(
          () => sql`
            insert into coaching.diagnostic_attempts (
              session_item_id, client_attempt_id, move_uci, correct, score,
              rubric_component_version_id
            ) values (
              ${itemId}, 'attempt-two-1234', 'd2d4', false, 0, ${seeded.componentVersionId}
            )
          `,
          /diagnostic_attempts_one_per_item/,
        );
      });

      await report.check("no browser role reaches any of it", async () => {
        const rows = await sql<{ table_name: string }[]>`
          select table_name from information_schema.role_table_grants
          where table_schema = 'coaching' and table_name = any(${NEW_TABLES})
            and grantee in ('anon', 'authenticated', 'public', 'PUBLIC')
        `;
        assert.deepEqual([...rows], []);
      });

      await report.check("re-applying 0029 changes nothing", async () => {
        const before = await fingerprint(sql);
        await apply0029(db.adminUrl);
        assert.deepEqual(await fingerprint(sql), before);
      });
    } finally {
      await sql.end({ timeout: 5 });
    }
  } finally {
    await db.destroy();
  }
}

report.section("from a database that stopped at 0028");

{
  const db = await createDisposableDatabase();
  try {
    await applyMigrations(db.adminUrl, "0028_e15_estimates_findings");
    const sql = postgres(db.adminUrl, { max: 1, prepare: false, onnotice: () => {} });
    try {
      await report.check("the coaching schema exists and is empty", async () => {
        const [row] = await sql<{ count: string }[]>`
          select count(*)::text as count from information_schema.tables
          where table_schema = 'coaching'
        `;
        assert.equal(row?.count, "0", "0029 is not the first migration to use coaching");
      });

      await report.check("0029 applies to it", async () => {
        await apply0029(db.adminUrl);
        const [row] = await sql<{ count: string }[]>`
          select count(*)::text as count from information_schema.tables
          where table_schema = 'coaching' and table_name = any(${NEW_TABLES})
        `;
        assert.equal(row?.count, String(NEW_TABLES.length));
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
    where table_schema = 'coaching' and table_name = any(${NEW_TABLES})
    order by table_name, column_name
  `;
  return [...rows];
}

interface Seeded {
  userId: string;
  subjectId: string;
  runId: string;
  snapshotId: string;
  analysisRunId: string;
  componentVersionId: string;
}

function hex(): string {
  return (randomUUID() + randomUUID()).replace(/-/g, "");
}

async function seedRun(sql: postgres.Sql): Promise<Seeded> {
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
    ) values ('gate_coverage', 'projection', 'A gate fixture.', 'a.v1', 'b.v1')
    returning id
  `;
  const [version] = await sql<{ id: string }[]>`
    insert into analysis.component_versions (
      component_id, version, implementation_sha256, configuration, configuration_hash,
      content_hash, deterministic
    ) values (${component!.id}, '1', ${hex()}, '{}'::jsonb, ${hex()}, ${hex()}, true)
    returning id
  `;
  const [recipe] = await sql<{ id: string }[]>`
    insert into analysis.recipe_versions (
      recipe_key, version, run_type, input_schema_version, output_schema_version,
      required_artifacts, deterministic, manifest_sha256
    ) values (
      'gate_examination', '1', 'subject_live', 'a.v1', 'b.v1',
      array['skill_estimates']::text[], true, ${hex()}
    )
    returning id
  `;
  const [cohort] = await sql<{ id: string }[]>`
    insert into analysis.cohort_definition_versions (cohort_key, version, definition, definition_hash)
    values ('gate_cohort', '1', '{}'::jsonb, ${hex()})
    returning id
  `;
  const [snapshot] = await sql<{ id: string }[]>`
    insert into analysis.subject_data_snapshots (
      subject_id, cohort_definition_version_id, cutoff, snapshot_hash, game_count, under_covered
    ) values (${subject!.id}, ${cohort!.id}, now(), ${hex()}, 0, true)
    returning id
  `;
  const [run] = await sql<{ id: string }[]>`
    insert into analysis.runs (
      run_type, recipe_version_id, subject_id, subject_data_snapshot_id, status,
      input_manifest_hash, output_manifest_hash, started_at, completed_at,
      trigger_kind, actor_kind
    ) values (
      'subject_live', ${recipe!.id}, ${subject!.id}, ${snapshot!.id}, 'succeeded',
      ${hex()}, ${hex()}, now(), now(), 'scheduled', 'system'
    )
    returning id
  `;
  const [onboarding] = await sql<{ id: string }[]>`
    insert into coaching.onboarding_runs (
      user_id, subject_id, subject_data_snapshot_id, examination_run_id
    ) values (${profile!.user_id}, ${subject!.id}, ${snapshot!.id}, ${run!.id})
    returning id
  `;
  return {
    userId: profile!.user_id,
    subjectId: subject!.id,
    runId: onboarding!.id,
    snapshotId: snapshot!.id,
    analysisRunId: run!.id,
    componentVersionId: version!.id,
  };
}

async function seedCoverage(sql: postgres.Sql, seeded: Seeded): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into coaching.data_coverage_snapshots (
      subject_data_snapshot_id, policy_component_version_id, overall_state,
      total_games, eligible_games, decision_count, limitations
    ) values (
      ${seeded.snapshotId}, ${seeded.componentVersionId}, 'limited', 10, 10, 4,
      array['few_games']::text[]
    )
    returning id
  `;
  return row!.id;
}

async function seedBaseline(
  sql: postgres.Sql,
  seeded: Seeded,
  coverageId: string,
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into coaching.baseline_reports (
      subject_id, onboarding_run_id, subject_data_snapshot_id, analysis_run_id,
      coverage_snapshot_id, layout_component_version_id, manifest_sha256
    )
    select ${seeded.subjectId}, r.id, ${seeded.snapshotId}, ${seeded.analysisRunId},
           ${coverageId}, ${seeded.componentVersionId}, ${hex()}
    from coaching.onboarding_runs r
    where r.subject_id = ${seeded.subjectId} and r.status = 'active'
    limit 1
    returning id
  `;
  return row!.id;
}

async function seedDiagnosticItem(sql: postgres.Sql, seeded: Seeded): Promise<string> {
  const [position] = await sql<{ id: string }[]>`
    insert into chess.core_positions (core_key_hash, core_key, board, turn, castling, en_passant)
    values (
      ${hex().slice(0, 64)}, 'board w KQkq -', 'board', 'w', 'KQkq', '-'
    )
    returning id
  `;
  const [session] = await sql<{ id: string }[]>`
    insert into coaching.diagnostic_sessions (
      onboarding_run_id, subject_id, selection_component_version_id,
      rubric_component_version_id, item_count
    )
    select r.id, ${seeded.subjectId}, ${seeded.componentVersionId},
           ${seeded.componentVersionId}, 1
    from coaching.onboarding_runs r
    where r.subject_id = ${seeded.subjectId} and r.status = 'active'
    limit 1
    returning id
  `;
  const [item] = await sql<{ id: string }[]>`
    insert into coaching.diagnostic_session_items (
      session_id, ordinal, purpose, core_position_id, fen, investigates_dimension_key,
      expected_uci
    ) values (
      ${session!.id}, 0, 'earlier_mishandled', ${position!.id},
      'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'fork_recognize', 'e2e4'
    )
    returning id
  `;
  return item!.id;
}

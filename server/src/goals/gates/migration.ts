/**
 * `npm run goals:migration` — 0030 from empty, from prior state, and twice.
 *
 * The four checks that matter are the promises: a cycle cannot be edited, a
 * target must move the bar, a commitment must be confirmed, and practice cannot
 * complete a goal. Each is attempted against a real database.
 */

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { GateReport } from "../../v1/gates/harness.js";
import { createDisposableDatabase } from "../../platform/harness/postgres.js";
import { applyMigrations, MIGRATIONS_FOLDER } from "../../platform/harness/migrations.js";

const report = new GateReport("E17 goals migration gate");

const MIGRATION_TAG = "0030_e17_goals_cycles";
const MIGRATION_SQL = readFileSync(join(MIGRATIONS_FOLDER, `${MIGRATION_TAG}.sql`), "utf8");

async function apply0030(url: string): Promise<void> {
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
  "coaching_cycles",
  "goal_commitments",
  "goal_metric_targets",
  "goal_progress_snapshots",
  "goal_requirements",
  "goal_template_versions",
  "goal_templates",
  "goals",
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

      await report.check("E16's onboarding run now references a goal", async () => {
        const [row] = await sql<{ column_name: string }[]>`
          select column_name from information_schema.columns
          where table_schema = 'coaching' and table_name = 'onboarding_runs'
            and column_name = 'goal_id'
        `;
        assert.ok(row, "E16's follow-through did not land");
      });

      const seeded = await seedGoal(sql);

      await report.check("a target inside the noise floor is refused", async () => {
        await assert.rejects(
          () => sql`
            insert into coaching.goal_metric_targets (
              cycle_id, metric_key, baseline_value, target_value, direction,
              meaningful_change, required_evidence_count
            ) values (
              ${seeded.cycleId}, 'inside_noise', 0.5, 0.52, 'increase', 0.05, 3
            )
          `,
          /metric_targets_moves_the_bar/,
        );
      });

      await report.check("a target that moves the bar is allowed", async () => {
        await sql`
          insert into coaching.goal_metric_targets (
            cycle_id, metric_key, baseline_value, target_value, direction,
            meaningful_change, required_evidence_count
          ) values (
            ${seeded.cycleId}, 'fork_recognize', 0.4, 0.7, 'increase', 0.05, 3
          )
        `;
        const [row] = await sql<{ count: string }[]>`
          select count(*)::text as count from coaching.goal_metric_targets
          where cycle_id = ${seeded.cycleId}
        `;
        assert.equal(row?.count, "1");
      });

      await report.check("a cycle cannot be deleted, so a baseline cannot vanish", async () => {
        await assert.rejects(
          () => sql`delete from coaching.coaching_cycles where id = ${seeded.cycleId}`,
          /immutable|refuse/i,
        );
      });

      await report.check("a rebasing must say why", async () => {
        await assert.rejects(
          () => sql`
            insert into coaching.coaching_cycles (
              goal_id, sequence_no, baseline_analysis_run_id, baseline_snapshot_id,
              estimator_component_version_id, plan_generator_component_version_id,
              starts_on, rebased_from_cycle_id, status, completed_at
            ) values (
              ${seeded.goalId}, 2, ${seeded.analysisRunId}, ${seeded.snapshotId},
              ${seeded.componentVersionId}, ${seeded.componentVersionId}, current_date,
              ${seeded.cycleId}, 'completed', now()
            )
          `,
          /cycles_rebase_explained/,
        );
      });

      await report.check("a requirement without a rationale is refused", async () => {
        await assert.rejects(
          () => sql`
            insert into coaching.goal_requirements (
              cycle_id, requirement_key, kind, quantity, unit, window_days, essential,
              rationale, generator_component_version_id, display_rank
            ) values (
              ${seeded.cycleId}, 'play_more', 'play_games', 3, 'games', 7, true,
              'do it', ${seeded.componentVersionId}, 0
            )
          `,
          /requirements_rationale_present/,
        );
      });

      await report.check("a commitment must be confirmed by the user", async () => {
        await assert.rejects(
          () => sql`
            insert into coaching.goal_commitments (
              cycle_id, commitment_key, revision, target, cadence, unit, effective_from
            ) values (
              ${seeded.cycleId}, 'games_per_week', 1, 3, 'weekly', 'games', current_date
            )
          `,
          /confirmed_at/,
        );
      });

      await report.check("practice cannot complete a goal", async () => {
        await assert.rejects(
          () => sql`
            insert into coaching.goal_progress_snapshots (
              cycle_id, analysis_run_id, metric_key, current_value, interval_low,
              interval_high, readiness, adherence_ratio, real_game_evidence_count,
              practice_evidence_count, coverage_state, claim_state, target_achieved
            ) values (
              ${seeded.cycleId}, ${seeded.analysisRunId}, 'fork_recognize', 0.8, 0.75, 0.85,
              1, 1, 0, 500, 'sufficient', 'target_met', true
            )
          `,
          /progress_completion_needs_real_games/,
        );
      });

      await report.check("real-game evidence at the target completes it", async () => {
        await sql`
          insert into coaching.goal_progress_snapshots (
            cycle_id, analysis_run_id, metric_key, current_value, interval_low,
            interval_high, readiness, adherence_ratio, real_game_evidence_count,
            practice_evidence_count, coverage_state, claim_state, target_achieved
          ) values (
            ${seeded.cycleId}, ${seeded.analysisRunId}, 'fork_recognize', 0.8, 0.75, 0.85,
            1, 0, 6, 0, 'sufficient', 'target_met', true
          )
        `;
        const [row] = await sql<{ target_achieved: boolean; adherence_ratio: string }[]>`
          select target_achieved, adherence_ratio from coaching.goal_progress_snapshots
          where cycle_id = ${seeded.cycleId}
        `;
        assert.equal(row?.target_achieved, true);
        // Zero adherence and the target still met: doing the exercises is not
        // what completes a goal, and skipping them is not what prevents it.
        assert.equal(Number(row!.adherence_ratio), 0);
      });

      await report.check("a second active goal for the same subject is refused", async () => {
        await assert.rejects(
          () => sql`
            insert into coaching.goals (
              subject_id, stated_objective, comparison_frame, status, activated_at
            ) values (
              ${seeded.subjectId}, 'another goal entirely', 'objective', 'active', now()
            )
          `,
          /goals_one_active_per_subject/,
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

      await report.check("re-applying 0030 changes nothing", async () => {
        const before = await fingerprint(sql);
        await apply0030(db.adminUrl);
        assert.deepEqual(await fingerprint(sql), before);
      });
    } finally {
      await sql.end({ timeout: 5 });
    }
  } finally {
    await db.destroy();
  }
}

report.section("from a database that stopped at 0029");

{
  const db = await createDisposableDatabase();
  try {
    await applyMigrations(db.adminUrl, "0029_e16_onboarding_baseline");
    const sql = postgres(db.adminUrl, { max: 1, prepare: false, onnotice: () => {} });
    try {
      await report.check("E16's tables are there and the goal column is not", async () => {
        const [tables] = await sql<{ count: string }[]>`
          select count(*)::text as count from information_schema.tables
          where table_schema = 'coaching' and table_name = 'onboarding_runs'
        `;
        assert.equal(tables?.count, "1");
        const [column] = await sql<{ count: string }[]>`
          select count(*)::text as count from information_schema.columns
          where table_schema = 'coaching' and table_name = 'onboarding_runs'
            and column_name = 'goal_id'
        `;
        assert.equal(column?.count, "0");
      });

      await report.check("0030 adds the column without touching the rows", async () => {
        const [profile] = await sql<{ user_id: string }[]>`
          insert into app.profiles (user_id) values (gen_random_uuid()) returning user_id
        `;
        const [subject] = await sql<{ id: string }[]>`
          insert into app.analysis_subjects (kind, owner_user_id, display_label)
          values ('personal', ${profile!.user_id}, 'gate') returning id
        `;
        const [run] = await sql<{ id: string }[]>`
          insert into coaching.onboarding_runs (user_id, subject_id)
          values (${profile!.user_id}, ${subject!.id})
          returning id
        `;
        await apply0030(db.adminUrl);
        const [after] = await sql<{ goal_id: string | null }[]>`
          select goal_id from coaching.onboarding_runs where id = ${run!.id}
        `;
        assert.equal(after?.goal_id, null, "an existing run was disturbed");
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
  subjectId: string;
  goalId: string;
  cycleId: string;
  analysisRunId: string;
  snapshotId: string;
  componentVersionId: string;
}

function hex(): string {
  return (randomUUID() + randomUUID()).replace(/-/g, "");
}

async function seedGoal(sql: postgres.Sql): Promise<Seeded> {
  const [profile] = await sql<{ user_id: string }[]>`
    insert into app.profiles (user_id) values (gen_random_uuid()) returning user_id
  `;
  const [subject] = await sql<{ id: string }[]>`
    insert into app.analysis_subjects (kind, owner_user_id, display_label)
    values ('personal', ${profile!.user_id}, 'goals gate') returning id
  `;
  const [component] = await sql<{ id: string }[]>`
    insert into analysis.components (
      component_key, category, description, input_contract, output_contract
    ) values ('gate_planner', 'projection', 'A gate fixture.', 'a.v1', 'b.v1')
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
      'gate_goal_recipe', '1', 'subject_live', 'a.v1', 'b.v1',
      array['skill_estimates']::text[], true, ${hex()}
    )
    returning id
  `;
  const [cohort] = await sql<{ id: string }[]>`
    insert into analysis.cohort_definition_versions (cohort_key, version, definition, definition_hash)
    values ('gate_goal_cohort', '1', '{}'::jsonb, ${hex()})
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
  const [goal] = await sql<{ id: string }[]>`
    insert into coaching.goals (
      subject_id, stated_objective, comparison_frame, status, activated_at
    ) values (
      ${subject!.id}, 'get more reliable at forks', 'personal_current', 'active', now()
    )
    returning id
  `;
  const [cycle] = await sql<{ id: string }[]>`
    insert into coaching.coaching_cycles (
      goal_id, sequence_no, baseline_analysis_run_id, baseline_snapshot_id,
      estimator_component_version_id, plan_generator_component_version_id, starts_on
    ) values (
      ${goal!.id}, 1, ${run!.id}, ${snapshot!.id}, ${version!.id}, ${version!.id},
      current_date
    )
    returning id
  `;
  return {
    subjectId: subject!.id,
    goalId: goal!.id,
    cycleId: cycle!.id,
    analysisRunId: run!.id,
    snapshotId: snapshot!.id,
    componentVersionId: version!.id,
  };
}

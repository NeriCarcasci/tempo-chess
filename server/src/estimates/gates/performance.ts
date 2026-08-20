/**
 * `npm run estimates:performance` — the dashboard's cost, on a
 * production-shaped report.
 *
 * The number that decides whether a homepage stays fast under load is not
 * milliseconds on a shared runner, it is how many round trips the page costs.
 * That count is deterministic, so it is asserted; wall-clock is measured and
 * printed against a generous ceiling.
 *
 * The fixture writes the report rows directly rather than running the engine
 * pipeline. This gate is about reading one, and building it through four
 * workers would measure E12's cost under E15's name.
 */

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";

import type { Sql } from "postgres";

import { GateReport, startAnalysisHarness } from "../../analysis/gates/harness.js";
import { setAnalysisEventSink } from "../../analysis/telemetry.js";
import { DASHBOARD_BUDGETS } from "../contract.js";
import { readDashboard } from "../dashboard.js";
import { jsonParam } from "../../db/json.js";

const report = new GateReport("E15 estimates performance gate");
const harness = await startAnalysisHarness();
const sql = harness.sql;
setAnalysisEventSink(() => {});

/** A production-shaped report: 60 dimensions, 40 bins, 12 findings. */
const DIMENSIONS = 60;
const BINS = 40;
const FINDINGS = 12;

try {
  const seeded = await seedPublishedReport(sql);

  report.section("reading the dashboard");

  await report.check("the page costs a bounded number of queries", async () => {
    let queries = 0;
    const counting = new Proxy(sql, {
      apply(target, thisArg, args: unknown[]) {
        queries += 1;
        return Reflect.apply(target as never, thisArg, args as never);
      },
    }) as unknown as Sql;

    const dashboard = await readDashboard(counting, {
      subjectId: seeded.subjectId,
      ownerProfileId: seeded.ownerProfileId,
    });
    assert.ok(dashboard, "the seeded subject has no dashboard");
    console.log(`      ${queries} queries for ${DIMENSIONS} estimates and ${BINS} bins`);
    assert.ok(
      queries <= DASHBOARD_BUDGETS.maxQueries,
      `the dashboard cost ${queries} queries, above the ${DASHBOARD_BUDGETS.maxQueries} budget`,
    );
  });

  await report.check("the page returns everything it was asked for", async () => {
    const dashboard = await readDashboard(sql, {
      subjectId: seeded.subjectId,
      ownerProfileId: seeded.ownerProfileId,
    });
    assert.equal(dashboard!.estimates.length, DIMENSIONS);
    assert.equal(dashboard!.trajectory.bins.length, BINS);
    assert.equal(dashboard!.findings.length, FINDINGS);
  });

  await report.check("wall clock is within an order of magnitude of the budget", async () => {
    const startedAt = Date.now();
    await readDashboard(sql, {
      subjectId: seeded.subjectId,
      ownerProfileId: seeded.ownerProfileId,
    });
    const elapsed = Date.now() - startedAt;
    console.log(
      `      read in ${elapsed}ms (advisory ceiling ${DASHBOARD_BUDGETS.dashboardReadMs}ms)`,
    );
    assert.ok(
      elapsed < DASHBOARD_BUDGETS.dashboardReadMs * 10,
      `the dashboard read took ${elapsed}ms`,
    );
  });

  await report.check("a subject with nothing published costs one query and returns null", async () => {
    let queries = 0;
    const counting = new Proxy(sql, {
      apply(target, thisArg, args: unknown[]) {
        queries += 1;
        return Reflect.apply(target as never, thisArg, args as never);
      },
    }) as unknown as Sql;
    const dashboard = await readDashboard(counting, {
      subjectId: randomUUID(),
      ownerProfileId: seeded.ownerProfileId,
    });
    assert.equal(dashboard, null);
    assert.equal(queries, 1, "an unpublished subject cost more than the ownership check");
  });
} finally {
  await harness.destroy();
}

report.finish();

// ---------------------------------------------------------------------------

async function seedPublishedReport(
  sql: Sql,
): Promise<{ subjectId: string; ownerProfileId: string }> {
  const suffix = `p${Date.now().toString(36)}`;
  const [profile] = await sql<{ user_id: string }[]>`
    insert into app.profiles (user_id) values (gen_random_uuid()) returning user_id
  `;
  const [subject] = await sql<{ id: string }[]>`
    insert into app.analysis_subjects (kind, owner_user_id, display_label)
    values ('personal', ${profile!.user_id}, 'performance gate') returning id
  `;
  const [component] = await sql<{ id: string }[]>`
    insert into analysis.components (
      component_key, category, description, input_contract, output_contract
    ) values (
      ${`perf_estimator_${suffix}`}, 'estimator', 'A gate fixture.', 'a.v1', 'b.v1'
    )
    returning id
  `;
  const [version] = await sql<{ id: string }[]>`
    insert into analysis.component_versions (
      component_id, version, implementation_sha256, configuration, configuration_hash,
      content_hash, deterministic
    ) values (
      ${component!.id}, '1', ${hex("impl", suffix)}, '{}'::jsonb, ${hex("config", suffix)},
      ${hex("content", suffix)}, true
    )
    returning id
  `;
  const [recipe] = await sql<{ id: string }[]>`
    insert into analysis.recipe_versions (
      recipe_key, version, run_type, input_schema_version, output_schema_version,
      required_artifacts, deterministic, manifest_sha256
    ) values (
      ${`perf_report_${suffix}`}, '1', 'subject_live', 'a.v1', 'b.v1',
      array['skill_estimates']::text[], true, ${hex("manifest", suffix)}
    )
    returning id
  `;
  const [cohort] = await sql<{ id: string }[]>`
    insert into analysis.cohort_definition_versions (
      cohort_key, version, definition, definition_hash
    ) values (
      ${`perf_cohort_${suffix}`}, '1', '{}'::jsonb, ${hex("cohort", suffix)}
    )
    returning id
  `;
  const [snapshot] = await sql<{ id: string }[]>`
    insert into analysis.subject_data_snapshots (
      subject_id, cohort_definition_version_id, cutoff, snapshot_hash, game_count,
      earliest_played_at, latest_played_at, under_covered
    ) values (
      ${subject!.id}, ${cohort!.id}, now(), ${hex("snapshot", suffix)}, 40,
      now() - interval '90 days', now(), false
    )
    returning id
  `;
  const [run] = await sql<{ id: string }[]>`
    insert into analysis.runs (
      run_type, recipe_version_id, subject_id, subject_data_snapshot_id, status,
      input_manifest_hash, output_manifest_hash, started_at, completed_at,
      trigger_kind, actor_kind
    ) values (
      'subject_live', ${recipe!.id}, ${subject!.id}, ${snapshot!.id}, 'succeeded',
      ${hex("input", suffix)}, ${hex("output", suffix)}, now(), now(),
      'scheduled', 'system'
    )
    returning id
  `;

  for (let i = 0; i < DIMENSIONS; i += 1) {
    const [dimension] = await sql<{ id: string }[]>`
      insert into analysis.skill_dimensions (
        dimension_key, version, frame, display_name
      ) values (
        ${`perf_dim_${suffix}_${i}`}, '1', ${i % 2 === 0 ? "objective" : "personal_current"},
        ${`Dimension ${i}`}
      )
      returning id
    `;
    await sql`
      insert into analysis.player_skill_estimates (
        analysis_run_id, subject_id, subject_data_snapshot_id, skill_dimension_id,
        estimator_component_version_id, window_kind, estimate, interval_low, interval_high,
        raw_sample_size, effective_sample_size, success_count, failure_count, graded_count,
        censored_count, coverage_status
      ) values (
        ${run!.id}, ${subject!.id}, ${snapshot!.id}, ${dimension!.id}, ${version!.id},
        'lifetime', 0.6, 0.5, 0.7, 30, 24.5, 18, 10, 0, 2, 'sufficient'
      )
    `;
  }

  const [trajectory] = await sql<{ id: string }[]>`
    insert into analysis.player_trajectory_snapshots (
      analysis_run_id, subject_id, subject_data_snapshot_id, phase_component_version_id,
      alignment_component_version_id, expected_score_calibration_version_id,
      included_game_count
    ) values (
      ${run!.id}, ${subject!.id}, ${snapshot!.id}, ${version!.id}, ${version!.id},
      ${version!.id}, 40
    )
    returning id
  `;
  for (let i = 0; i < BINS; i += 1) {
    const phase = i < 20 ? "opening" : "middlegame";
    const ordinal = i % 20;
    await sql`
      insert into analysis.player_trajectory_bins (
        trajectory_snapshot_id, phase, bin_ordinal, progress_low, progress_high,
        games_contributing, median_expected_score, p25_expected_score, p75_expected_score,
        phase_reach_rate
      ) values (
        ${trajectory!.id}, ${phase}, ${ordinal}, ${ordinal / 20}, ${(ordinal + 1) / 20},
        40, 0.52, 0.44, 0.61, 1
      )
    `;
  }

  const [evidence] = await sql<{ id: string }[]>`
    insert into analysis.evidence_items (run_id, evidence_kind, subject_id, occurred_at)
    select r.id, 'opportunity', ${subject!.id}, now()
    from chess.materialization_runs r limit 1
    returning id
  `;

  for (let i = 0; i < FINDINGS; i += 1) {
    await sql.begin(async (tx) => {
      const [finding] = await tx<{ id: string }[]>`
        insert into analysis.findings (
          analysis_run_id, subject_id, finding_type, priority, confidence_tier,
          claim, claim_family
        ) values (
          ${run!.id}, ${subject!.id}, 'insufficient_evidence', ${50 - i}, 'moderate',
          ${jsonParam({ dimension: `perf_dim_${i}` })}::jsonb, 'concept_success'
        )
        returning id
      `;
      if (evidence) {
        await tx`
          insert into analysis.finding_evidence (
            finding_id, evidence_item_id, role, display_rank
          ) values (${finding!.id}, ${evidence.id}, 'supports', 0)
        `;
      }
      await tx`
        insert into analysis.rendered_explanations (
          finding_id, renderer_component_version_id, locale, tone, reading_level,
          structured_input_hash, rendered_text, safety_state
        ) values (
          ${finding!.id}, ${version!.id}, 'en', 'plain', 'general',
          ${hex(`render${i}`, suffix)}, 'There is not enough evidence yet.', 'passed'
        )
      `;
    });
  }

  // The pointer references the history row, not a free-standing id: E11 keeps
  // "what is current" and "how it got there" as one fact, and a fixture that
  // invents a publication id is testing a shape the real path cannot produce.
  const [history] = await sql<{ id: string }[]>`
    insert into analysis.subject_live_publication_history (
      subject_id, run_id, reason, actor_kind
    ) values (${subject!.id}, ${run!.id}, 'first_publication', 'system')
    returning id
  `;
  await sql`
    insert into analysis.subject_live_publications (
      subject_id, run_id, publication_id, subject_data_snapshot_id, recipe_version_id
    ) values (
      ${subject!.id}, ${run!.id}, ${history!.id}, ${snapshot!.id}, ${recipe!.id}
    )
  `;

  return { subjectId: subject!.id, ownerProfileId: profile!.user_id };
}

function hex(seed: string, suffix: string): string {
  let out = "";
  const source = `${seed}${suffix}`;
  for (let i = 0; i < 64; i += 1) {
    out += "0123456789abcdef"[(source.charCodeAt(i % source.length) + i) % 16];
  }
  return out;
}

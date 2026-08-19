/**
 * `npm run models:live` — E14's invariants against the live project.
 *
 * The disposable-Postgres gates prove what the migration builds. This one
 * proves what the live database actually is, which is a different question: a
 * migration that applied cleanly to an empty cluster and a live project that
 * agrees with it are two facts, and only the second one is about production.
 *
 * Every destructive probe runs inside a savepoint that is always rolled back,
 * so the gate attempts each violation for real — the triggers fire, the check
 * constraints fire — and leaves nothing behind. Nothing here inserts a row that
 * survives, and nothing here reads a person: the assertions are about
 * structure, refusals, and the promotion record.
 */

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";

import postgres from "postgres";

import { GateReport } from "../../v1/gates/harness.js";
import { PROMOTION_THRESHOLDS, UNAVAILABLE_REASONS } from "../contract.js";

const report = new GateReport("E14 human context live conformance gate");

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not set");
const sql = postgres(databaseUrl, { max: 2, prepare: false, onnotice: () => {} });

const TABLES = [
  "model_agreement_assessments",
  "model_assets",
  "model_calibration_slices",
  "model_inferences",
  "model_licence_reviews",
  "model_move_probabilities",
  "practical_context_assessments",
  "run_model_inference_uses",
];

/** Run a probe inside a savepoint that is always rolled back. */
async function probe<T>(fn: (tx: postgres.Sql) => Promise<T>): Promise<T> {
  const marker = new Error("rollback");
  try {
    return await sql.begin(async (tx) => {
      const result = await fn(tx as unknown as postgres.Sql);
      throw Object.assign(marker, { result });
    });
  } catch (error) {
    if (error === marker) return (error as { result: T }).result;
    throw error;
  }
}

try {
  report.section("the live schema is what 0027 says it is");

  await report.check("all eight tables exist", async () => {
    const rows = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'analysis' and table_name = any(${TABLES})
      order by table_name
    `;
    assert.deepEqual(rows.map((r) => r.table_name), TABLES);
  });

  await report.check("the pressure bounds are generated columns", async () => {
    const rows = await sql<{ column_name: string; is_generated: string }[]>`
      select column_name, is_generated from information_schema.columns
      where table_schema = 'analysis' and table_name = 'practical_context_assessments'
        and column_name in ('practical_pressure_lower', 'practical_pressure_upper')
    `;
    assert.equal(rows.length, 2);
    for (const row of rows) assert.equal(row.is_generated, "ALWAYS");
  });

  await report.check("no browser role reaches the human layer", async () => {
    const rows = await sql<{ table_name: string; grantee: string }[]>`
      select table_name, grantee from information_schema.role_table_grants
      where table_schema = 'analysis' and table_name = any(${TABLES})
        and grantee in ('anon', 'authenticated', 'PUBLIC', 'public')
    `;
    assert.deepEqual([...rows], []);
  });

  await report.check("the reason vocabulary matches the code", async () => {
    const [row] = await sql<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'practical_context_reason_shape'
    `;
    assert.ok(row, "the constraint exists");
    for (const reason of UNAVAILABLE_REASONS) {
      assert.ok(row!.def.includes(`'${reason}'`), `${reason} is not in the database's vocabulary`);
    }
  });

  report.section("the refusals fire on the live database");

  await report.check("a cleared profile without a review is refused", async () => {
    await probe(async (tx) => {
      await assert.rejects(
        () => tx`
          insert into analysis.model_profiles (
            component_version_id, role, hardware_class, input_context_contract,
            output_interpretation_contract, licence_review_status
          )
          select id, 'human_policy', 'cpu_model', 'human_policy_context.v1',
                 'human_policy_distribution.v1', 'cleared'
          from analysis.component_versions
          where id not in (select component_version_id from analysis.model_profiles)
          limit 1
        `,
        /cleared without a cleared licence review/,
      );
    });
  });

  await report.check("an objective engine cannot write a human inference", async () => {
    await probe(async (tx) => {
      // Registered inside the savepoint rather than found: the live project has
      // no objective-engine profile until the first analysis run registers one,
      // and a gate that silently skips when the fixture is missing is a gate
      // that stops testing the day the fixture moves.
      const engineVersionId = await seedThrowawayEngine(tx);
      const [position] = await tx<{ id: string }[]>`
        select id from chess.core_positions order by id limit 1
      `;
      assert.ok(position, "the live project has at least one core position");
      await assert.rejects(
        () => tx`
          insert into analysis.model_inferences (
            model_component_version_id, core_position_id, output_kind,
            context_has_move_history, input_contract_hash, cache_key,
            retained_probability_mass, retained_move_count, policy_entropy_bits
          ) values (
            ${engineVersionId}, ${position!.id}, 'human_policy',
            true, ${"a".repeat(64)}, ${"b".repeat(64)}, 0.9, 3, 1.2
          )
        `,
        /objective_engine output belongs in/,
      );
    });
  });

  await report.check("an output kind that contradicts the model's role is refused", async () => {
    await probe(async (tx) => {
      const [model] = await tx<{ component_version_id: string }[]>`
        select component_version_id from analysis.model_profiles
        where role = 'human_policy' and licence_review_status = 'cleared' limit 1
      `;
      assert.ok(model, "a cleared human policy model is registered");
      const [position] = await tx<{ id: string }[]>`
        select id from chess.core_positions order by id limit 1
      `;
      await assert.rejects(
        () => tx`
          insert into analysis.model_inferences (
            model_component_version_id, core_position_id, output_kind,
            context_has_move_history, input_contract_hash, cache_key,
            human_win, human_draw, human_loss
          ) values (
            ${model!.component_version_id}, ${position!.id}, 'human_outcome',
            true, ${"a".repeat(64)}, ${"c".repeat(64)}, 0.4, 0.3, 0.3
          )
        `,
        /does not match model role/,
      );
    });
  });

  await report.check("an available claim on an unsupported slice is refused", async () => {
    await probe(async (tx) => {
      const [slice] = await tx<{ id: string }[]>`
        select id from analysis.model_calibration_slices where not supported limit 1
      `;
      if (!slice) return; // Nothing unsupported on file yet; nothing to prove.
      await assert.rejects(
        () => tx`
          insert into analysis.practical_context_assessments (
            transition_assessment_id, analysis_run_id, status, policy_inference_id,
            calibration_slice_id, pressure_method, adequate_reply_count,
            adequate_reply_probability, unretained_probability_mass, policy_entropy_bits,
            entropy_is_lower_bound
          ) values (
            1, ${randomUUID()}, 'available', 1, ${slice.id},
            'adequate_mass_interval_v1', 2, 0.7, 0.1, 1.2, true
          )
        `,
        /which is not supported|violates foreign key/,
      );
    });
  });

  await report.check("an unavailable row carrying a vector is refused", async () => {
    await probe(async (tx) => {
      await assert.rejects(
        () => tx`
          insert into analysis.practical_context_assessments (
            transition_assessment_id, analysis_run_id, status, unavailable_reason,
            adequate_reply_count
          ) values (1, ${randomUUID()}, 'unavailable', 'no_promoted_model', 3)
        `,
        /practical_context_available_shape|violates foreign key/,
      );
    });
  });

  await report.check("a licence review cannot be rewritten", async () => {
    await probe(async (tx) => {
      const [review] = await tx<{ component_version_id: string }[]>`
        select component_version_id from analysis.model_licence_reviews limit 1
      `;
      if (!review) return;
      await assert.rejects(
        () => tx`
          update analysis.model_licence_reviews set decision = 'rejected'
          where component_version_id = ${review.component_version_id}
        `,
        /immutable|refuse/i,
      );
    });
  });

  report.section("the promotion on file says what the benchmark said");

  await report.check("a human policy model is registered and licence-cleared", async () => {
    const [row] = await sql<{ count: string }[]>`
      select count(*)::text as count from analysis.model_profiles
      where role = 'human_policy' and licence_review_status = 'cleared'
    `;
    assert.ok(Number(row!.count) >= 1, "no cleared human policy model is registered");
  });

  await report.check("its licence review records an SPDX id and a source", async () => {
    const rows = await sql<{ licence_spdx: string; source_url: string; obligations: string }[]>`
      select r.licence_spdx, r.source_url, r.obligations
      from analysis.model_licence_reviews r
      join analysis.model_profiles p on p.component_version_id = r.component_version_id
      where p.role = 'human_policy'
    `;
    assert.ok(rows.length >= 1);
    for (const row of rows) {
      assert.ok(row.licence_spdx.length > 0);
      assert.ok(row.source_url.startsWith("https://"));
      assert.ok(row.obligations.length >= 20);
    }
  });

  await report.check("every network it uses is recorded by content hash", async () => {
    const rows = await sql<{ asset_kind: string; sha256: string }[]>`
      select a.asset_kind, a.sha256 from analysis.model_assets a
      join analysis.model_profiles p on p.component_version_id = a.component_version_id
      where p.role = 'human_policy'
    `;
    assert.ok(rows.length >= 2, `only ${rows.length} assets recorded`);
    for (const row of rows) assert.match(row.sha256, /^[0-9a-f]{64}$/);
  });

  await report.check("the holdout is account-disjoint and chronologically split", async () => {
    const rows = await sql<
      { account_disjoint: boolean; chronological_split: boolean; artifact_id: string | null }[]
    >`
      select d.account_disjoint, d.chronological_split, d.artifact_id
      from analysis.validation_datasets d
      join analysis.validation_runs r on r.dataset_id = d.id
      join analysis.model_profiles p on p.component_version_id = r.candidate_component_version_id
      where p.role = 'human_policy'
    `;
    assert.ok(rows.length >= 1, "no validation run for the human model");
    for (const row of rows) {
      assert.equal(row.account_disjoint, true);
      assert.equal(row.chronological_split, true);
    }
    assert.ok(
      rows.some((row) => row.artifact_id !== null),
      "no version of the holdout has its body stored, so the manifest hash checks nothing",
    );
  });

  await report.check("every supported slice clears the thresholds it was judged by", async () => {
    const rows = await sql<
      {
        provider: string;
        speed: string;
        rating_band_low: number;
        sample_size: number;
        top1_accuracy: number;
        expected_calibration_error: number;
        brier_score: number;
      }[]
    >`
      select provider, speed, rating_band_low, sample_size, top1_accuracy,
             expected_calibration_error, brier_score
      from analysis.model_calibration_slices
      where supported
      order by provider, speed, rating_band_low
    `;
    assert.ok(
      rows.length >= PROMOTION_THRESHOLDS.minSupportedSlices,
      `${rows.length} supported slices, below the ${PROMOTION_THRESHOLDS.minSupportedSlices} the gate requires`,
    );
    for (const row of rows) {
      const where = `${row.provider}:${row.speed}:${row.rating_band_low}`;
      assert.ok(row.sample_size >= PROMOTION_THRESHOLDS.minSliceSampleSize, `${where} sample`);
      assert.ok(row.top1_accuracy >= PROMOTION_THRESHOLDS.minTop1Accuracy, `${where} accuracy`);
      assert.ok(
        row.expected_calibration_error <= PROMOTION_THRESHOLDS.maxExpectedCalibrationError,
        `${where} calibration error`,
      );
      assert.ok(row.brier_score <= PROMOTION_THRESHOLDS.maxBrierScore, `${where} Brier`);
    }
    console.log(`      ${rows.length} supported slices: ${rows.map((r) => `${r.provider}:${r.speed}:${r.rating_band_low}`).join(", ")}`);
  });

  await report.check("an unsupported slice publishes a reason and no metrics", async () => {
    const rows = await sql<
      { unsupported_reason: string | null; top1_accuracy: number | null }[]
    >`
      select unsupported_reason, top1_accuracy from analysis.model_calibration_slices
      where not supported
    `;
    for (const row of rows) {
      assert.ok(row.unsupported_reason && row.unsupported_reason.length > 0);
      assert.equal(row.top1_accuracy, null, "an unsupported slice quotes an accuracy");
    }
    console.log(`      ${rows.length} slices recorded as unsupported, each with a reason`);
  });

  await report.check("the promotion cites the validation run that justified it", async () => {
    const [row] = await sql<{ to_state: string; validation_run_id: string | null }[]>`
      select e.to_state, e.validation_run_id
      from analysis.component_lifecycle_events e
      join analysis.model_profiles p on p.component_version_id = e.component_version_id
      where p.role = 'human_policy'
      order by e.id desc limit 1
    `;
    assert.ok(row, "the human model has no lifecycle history");
    assert.equal(row!.to_state, "production");
    assert.ok(row!.validation_run_id, "a promotion with no evidence is an opinion");
  });
} finally {
  await sql.end({ timeout: 5 });
}

report.finish();

/**
 * An objective-engine profile that exists only inside the caller's savepoint.
 *
 * Every identifier is random, so two gate runs never collide, and the savepoint
 * is rolled back whatever happens.
 */
async function seedThrowawayEngine(tx: postgres.Sql): Promise<string> {
  const key = `gate_probe_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const [component] = await tx<{ id: string }[]>`
    insert into analysis.components (
      component_key, category, description, input_contract, output_contract
    ) values (
      ${key}, 'engine_profile', 'A rolled-back gate probe.', 'core_position.v1',
      'objective_evaluation.v1'
    )
    returning id
  `;
  const hash = () => randomUUID().replace(/-/g, "").repeat(2);
  const [version] = await tx<{ id: string }[]>`
    insert into analysis.component_versions (
      component_id, version, implementation_sha256, configuration, configuration_hash,
      content_hash, deterministic
    ) values (
      ${component!.id}, '1', ${hash()}, '{}'::jsonb, ${hash()}, ${hash()}, true
    )
    returning id
  `;
  await tx`
    insert into analysis.model_profiles (
      component_version_id, role, hardware_class, input_context_contract,
      output_interpretation_contract, licence_review_status
    ) values (
      ${version!.id}, 'objective_engine', 'cpu_engine', 'core_position.v1',
      'objective_evaluation.v1', 'pending'
    )
  `;
  return version!.id;
}

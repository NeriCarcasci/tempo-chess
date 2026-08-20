/**
 * `npm run models:security` — grants, tenancy and redaction for E14.
 *
 * The integration gate connects as the owner, which proves behaviour and proves
 * nothing about access. This one connects as the real least-privilege roles,
 * because a grant tested as a superuser is a grant that was never consulted.
 *
 * What it asserts in the epic's terms: no browser role reaches a human-context
 * table; the API role can read the practical layer and cannot write, promote or
 * withdraw any part of it; the analysis worker can write inferences and context
 * and cannot rewrite either; a human-policy inference carries no account, user
 * or subject reference; and no telemetry line carries a rating, a position or a
 * player — a rating is the entire input to a human-policy inference and is
 * exactly what would make one of these lines identifying.
 */

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";

import { GateReport, startAnalysisHarness } from "../../analysis/gates/harness.js";
import { DENIED_ROLES } from "../../security/contract.js";
import { MODELS_EVENT_FIELDS, modelsEventLine } from "../telemetry.js";

const report = new GateReport("E14 human context security gate");
const harness = await startAnalysisHarness();
const sql = harness.sql;

const TABLES = [
  "analysis.model_licence_reviews",
  "analysis.model_assets",
  "analysis.model_inferences",
  "analysis.model_move_probabilities",
  "analysis.model_agreement_assessments",
  "analysis.run_model_inference_uses",
  "analysis.model_calibration_slices",
  "analysis.practical_context_assessments",
];

try {
  report.section("browser roles reach nothing");

  await report.check("no denied role holds any privilege on any new table", async () => {
    const rows = await sql<{ table_name: string; grantee: string; privilege_type: string }[]>`
      select table_name, grantee, privilege_type
      from information_schema.role_table_grants
      where table_schema = 'analysis'
        and ('analysis.' || table_name) = any(${TABLES})
        and grantee = any(${[...DENIED_ROLES]})
    `;
    assert.deepEqual([...rows], []);
  });

  await report.check("nor does PUBLIC, which is the grant nobody writes on purpose", async () => {
    const rows = await sql<{ table_name: string }[]>`
      select table_name from information_schema.role_table_grants
      where table_schema = 'analysis'
        and ('analysis.' || table_name) = any(${TABLES})
        and grantee in ('PUBLIC', 'public')
    `;
    assert.deepEqual([...rows], []);
  });

  await report.check("the trigger functions are not executable by PUBLIC", async () => {
    const rows = await sql<{ proname: string }[]>`
      select p.proname from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'analysis'
        and p.proname in (
          'enforce_licence_review', 'enforce_model_inference_source', 'enforce_practical_context'
        )
        and has_function_privilege('public', p.oid, 'execute')
    `;
    assert.deepEqual([...rows], []);
  });

  report.section("the API role reads and cannot write");

  const api = harness.as("forma_api");

  await report.check("it can read the practical layer", async () => {
    const rows = await api`
      select count(*)::text as count from analysis.practical_context_assessments
    `;
    assert.equal(rows.length, 1);
  });

  await report.check("it cannot insert a practical claim", async () => {
    await assert.rejects(
      () => api`
        insert into analysis.practical_context_assessments (
          transition_assessment_id, analysis_run_id, status, unavailable_reason
        ) values (1, ${randomUUID()}, 'unavailable', 'no_promoted_model')
      `,
      /permission denied/,
    );
  });

  await report.check("it cannot record a licence review", async () => {
    await assert.rejects(
      () => api`
        insert into analysis.model_licence_reviews (
          component_version_id, decision, licence_spdx, source_url, obligations,
          distribution_posture, reviewer
        ) values (
          ${randomUUID()}, 'cleared', 'MIT', 'https://example.com/x',
          'no obligations worth twenty characters', 'server_side_only', 'someone'
        )
      `,
      /permission denied/,
    );
  });

  await report.check("it cannot mark a slice supported", async () => {
    await assert.rejects(
      () => api`
        update analysis.model_calibration_slices set supported = true
      `,
      /permission denied/,
    );
  });

  await report.check("it cannot promote a component", async () => {
    await assert.rejects(
      () => api`
        insert into analysis.component_lifecycle_events (
          component_version_id, from_state, to_state, actor_kind, reason
        ) values (${randomUUID()}, 'validated', 'production', 'system', 'not mine to do')
      `,
      /permission denied/,
    );
  });

  report.section("the analysis worker writes once and cannot restate");

  const analysis = harness.as("forma_analysis");

  await report.check("it cannot rewrite an inference", async () => {
    await assert.rejects(
      () => analysis`update analysis.model_inferences set policy_entropy_bits = 0`,
      /permission denied|immutable|refuse/i,
    );
  });

  await report.check("it cannot delete a practical claim it does not like", async () => {
    await assert.rejects(
      () => analysis`delete from analysis.practical_context_assessments`,
      /permission denied|immutable|refuse/i,
    );
  });

  report.section("an inference names no person");

  await report.check("the table has no account, user or subject column", async () => {
    const rows = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = 'analysis' and table_name = 'model_inferences'
        and (column_name like '%account%' or column_name like '%user%'
             or column_name like '%subject%' or column_name like '%username%')
    `;
    assert.deepEqual([...rows], [], "an inference can be traced to a person by column");
  });

  await report.check("anonymity is generated from the occurrence, not asserted", async () => {
    const [row] = await sql<{ is_generated: string }[]>`
      select is_generated from information_schema.columns
      where table_schema = 'analysis' and table_name = 'model_inferences'
        and column_name = 'anonymous'
    `;
    assert.equal(row?.is_generated, "ALWAYS");
  });

  report.section("telemetry carries no rating, position or player");

  await report.check("the serializer emits exactly the declared fields", () => {
    const line = modelsEventLine({
      event: "practical_context_written",
      traceId: "t",
      runId: "r",
      written: 10,
      available: 3,
      unavailableReasons: "slice_not_calibrated",
      inferencesComputed: 3,
      inferencesReused: 0,
      // A field nobody declared. It must not survive serialization.
      ...({ opponentRating: 1450 } as Record<string, unknown>),
    } as never);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(parsed).sort(),
      [...MODELS_EVENT_FIELDS.practical_context_written].sort(),
    );
    assert.equal("opponentRating" in parsed, false);
  });

  await report.check("no declared field name suggests a rating or a position", () => {
    for (const fields of Object.values(MODELS_EVENT_FIELDS)) {
      for (const field of fields) {
        assert.ok(
          !/rating|fen|position_key|username|account|subject/i.test(field),
          `${field} would carry identifying input`,
        );
      }
    }
  });

  await report.check("the inference event names a slice, never the rating", () => {
    const line = modelsEventLine({
      event: "model_inference",
      traceId: null,
      slice: "lichess:blitz:1400",
      positions: 40,
      failures: 0,
      latencyP95Ms: 12,
      meanRetainedMass: 0.92,
      meanEntropyBits: 1.8,
      outOfDomain: 0,
    });
    const parsed = JSON.parse(line) as Record<string, unknown>;
    assert.equal(parsed.slice, "lichess:blitz:1400");
    assert.equal("actorRating" in parsed, false);
  });
} finally {
  await harness.destroy();
}

report.finish();

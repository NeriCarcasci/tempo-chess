/**
 * `npm run estimates:security` — grants, tenancy and redaction for E15.
 *
 * This epic is the first that stores a judgement about a named person, so the
 * assertions are about who can read one, who can write one, and what a log line
 * is allowed to contain.
 *
 * The telemetry rule is the one worth stating plainly: an event saying "subject
 * X scores 0.21 on blunder avoidance" would put an assessment of a real person
 * into a log pipeline nobody consented to be assessed in. The events carry
 * counts, the serializer knows only the declared fields, and this gate checks
 * both.
 */

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";

import { GateReport, startAnalysisHarness } from "../../analysis/gates/harness.js";
import { DENIED_ROLES } from "../../security/contract.js";
import { ESTIMATES_EVENT_FIELDS, estimatesEventLine } from "../telemetry.js";

const report = new GateReport("E15 estimates security gate");
const harness = await startAnalysisHarness();
const sql = harness.sql;

const TABLES = [
  "skill_dimensions",
  "player_skill_estimates",
  "rating_pool_calibration_versions",
  "subject_rating_scale_estimates",
  "player_trajectory_snapshots",
  "player_trajectory_bins",
  "findings",
  "finding_evidence",
  "rendered_explanations",
];

try {
  report.section("browser roles reach nothing");

  await report.check("no denied role holds a privilege on any new table", async () => {
    const rows = await sql<{ table_name: string; grantee: string }[]>`
      select table_name, grantee from information_schema.role_table_grants
      where table_schema = 'analysis' and table_name = any(${TABLES})
        and grantee = any(${[...DENIED_ROLES]})
    `;
    assert.deepEqual([...rows], []);
  });

  await report.check("nor does PUBLIC", async () => {
    const rows = await sql<{ table_name: string }[]>`
      select table_name from information_schema.role_table_grants
      where table_schema = 'analysis' and table_name = any(${TABLES})
        and grantee in ('PUBLIC', 'public')
    `;
    assert.deepEqual([...rows], []);
  });

  await report.check("the evidence trigger function is not executable by PUBLIC", async () => {
    const rows = await sql<{ proname: string }[]>`
      select p.proname from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'analysis' and p.proname = 'enforce_finding_evidence'
        and has_function_privilege('public', p.oid, 'execute')
    `;
    assert.deepEqual([...rows], []);
  });

  report.section("the API role reads and cannot write a judgement");

  const api = harness.as("forma_api");

  await report.check("it can read findings", async () => {
    const rows = await api`select count(*)::text as count from analysis.findings`;
    assert.equal(rows.length, 1);
  });

  await report.check("it cannot write a finding about anybody", async () => {
    await assert.rejects(
      () => api`
        insert into analysis.findings (
          analysis_run_id, subject_id, finding_type, priority, confidence_tier,
          claim, claim_family
        ) values (
          ${randomUUID()}, ${randomUUID()}, 'strength', 50, 'high',
          '{}'::jsonb, 'concept_success'
        )
      `,
      /permission denied/,
    );
  });

  await report.check("it cannot write or edit an estimate", async () => {
    await assert.rejects(
      () => api`update analysis.player_skill_estimates set estimate = 1`,
      /permission denied/,
    );
  });

  await report.check("it cannot rewrite an explanation to say something else", async () => {
    await assert.rejects(
      () => api`update analysis.rendered_explanations set rendered_text = 'anything'`,
      /permission denied/,
    );
  });

  report.section("the analysis worker writes once and cannot restate");

  const analysis = harness.as("forma_analysis");

  await report.check("it cannot revise an estimate it already published", async () => {
    await assert.rejects(
      () => analysis`update analysis.player_skill_estimates set estimate = 0.99`,
      /permission denied|immutable|refuse/i,
    );
  });

  await report.check("it cannot delete a contradicting piece of evidence", async () => {
    await assert.rejects(
      () => analysis`delete from analysis.finding_evidence where role = 'contradicts'`,
      /permission denied|immutable|refuse/i,
    );
  });

  report.section("no log line assesses a named person");

  await report.check("the serializer emits exactly the declared fields", () => {
    const line = estimatesEventLine({
      event: "subject_report_built",
      traceId: "t",
      runId: "r",
      estimates: 12,
      unavailableEstimates: 3,
      trajectoryBins: 40,
      findingsPublished: 5,
      findingsWithheld: 7,
      explanationsHeld: 0,
      includedGames: 30,
      durationMs: 900,
      // Fields nobody declared. Neither may survive serialization.
      ...({ subjectId: "s-1", estimate: 0.21 } as Record<string, unknown>),
    } as never);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(parsed).sort(),
      [...ESTIMATES_EVENT_FIELDS.subject_report_built].sort(),
    );
    assert.equal("subjectId" in parsed, false);
    assert.equal("estimate" in parsed, false);
  });

  await report.check("no declared field could carry a person or a score", () => {
    for (const fields of Object.values(ESTIMATES_EVENT_FIELDS)) {
      for (const field of fields) {
        assert.ok(
          !/subject|user|account|username|estimate$|score|concept$|dimension/i.test(field),
          `${field} would carry an assessment of a person`,
        );
      }
    }
  });

  await report.check("the renderer event counts refusals without quoting them", () => {
    const parsed = JSON.parse(
      estimatesEventLine({
        event: "renderer_safety",
        traceId: null,
        runId: "r",
        findingType: "strength",
        state: "held",
        unsupportedCount: 2,
      }),
    ) as Record<string, unknown>;
    assert.equal(parsed.unsupportedCount, 2);
    assert.equal("unsupported" in parsed, false, "model output reached a log line");
  });

  report.section("the schema refuses a single number for a person");

  await report.check("there is no column that collapses the pools", async () => {
    const rows = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = 'analysis' and table_name = 'subject_rating_scale_estimates'
        and (column_name like '%overall%' or column_name like '%combined%'
             or column_name like '%composite%')
    `;
    assert.deepEqual([...rows], [], "the schema offers a single ability number");
  });

  await report.check("an estimate outside the supported range carries no number", async () => {
    const [row] = await sql<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'rating_scale_range_gates_estimate'
    `;
    assert.ok(row, "the constraint that suppresses extrapolation is missing");
    assert.ok(row!.def.includes("in_supported_range"));
  });
} finally {
  await harness.destroy();
}

report.finish();

/**
 * `npm run onboarding:security` — grants, tenancy and redaction for E16.
 *
 * This epic gives the API role write access, which none of the analysis epics
 * did, because linking a run and answering a diagnostic item are synchronous
 * things a person does rather than background work. That widening is the thing
 * most worth checking: the API may start a journey and record an answer, and it
 * may not write a coverage decision, publish a baseline, or set the activation
 * flag on a run whose preconditions are not met.
 */

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";

import { GateReport, startAnalysisHarness } from "../../analysis/gates/harness.js";
import { DENIED_ROLES } from "../../security/contract.js";
import { ONBOARDING_EVENT_FIELDS, onboardingEventLine } from "../telemetry.js";
import { PLAN_ENTITLEMENTS } from "../contract.js";
import { buildReport, redactForPlan } from "../baseline.js";
import { decideCoverage } from "../coverage.js";

const report = new GateReport("E16 onboarding security gate");
const harness = await startAnalysisHarness();
const sql = harness.sql;

const TABLES = [
  "baseline_report_items",
  "baseline_reports",
  "data_coverage_dimensions",
  "data_coverage_snapshots",
  "diagnostic_attempts",
  "diagnostic_session_items",
  "diagnostic_sessions",
  "onboarding_runs",
];

try {
  report.section("browser roles reach nothing");

  await report.check("no denied role holds a privilege on any new table", async () => {
    const rows = await sql<{ table_name: string; grantee: string }[]>`
      select table_name, grantee from information_schema.role_table_grants
      where table_schema = 'coaching' and table_name = any(${TABLES})
        and grantee = any(${[...DENIED_ROLES]})
    `;
    assert.deepEqual([...rows], []);
  });

  await report.check("nor does PUBLIC", async () => {
    const rows = await sql<{ table_name: string }[]>`
      select table_name from information_schema.role_table_grants
      where table_schema = 'coaching' and table_name = any(${TABLES})
        and grantee in ('PUBLIC', 'public')
    `;
    assert.deepEqual([...rows], []);
  });

  report.section("the API writes what a person does, and nothing else");

  const api = harness.as("forma_api");

  await report.check("it may start a run and record an answer", async () => {
    const grants = await sql<{ table_name: string; privilege_type: string }[]>`
      select table_name, privilege_type from information_schema.role_table_grants
      where table_schema = 'coaching' and grantee = 'forma_api'
        and table_name in ('onboarding_runs', 'diagnostic_attempts')
        and privilege_type = 'INSERT'
      order by table_name
    `;
    assert.deepEqual(
      grants.map((row) => row.table_name),
      ["diagnostic_attempts", "onboarding_runs"],
    );
  });

  await report.check("it cannot write a coverage decision", async () => {
    await assert.rejects(
      () => api`
        insert into coaching.data_coverage_snapshots (
          subject_data_snapshot_id, policy_component_version_id, overall_state,
          total_games, eligible_games, decision_count
        ) values (${randomUUID()}, ${randomUUID()}, 'sufficient', 100, 100, 40)
      `,
      /permission denied/,
    );
  });

  await report.check("it cannot publish a baseline", async () => {
    await assert.rejects(
      () => api`
        insert into coaching.baseline_reports (
          subject_id, onboarding_run_id, subject_data_snapshot_id, analysis_run_id,
          coverage_snapshot_id, layout_component_version_id, manifest_sha256
        ) values (
          ${randomUUID()}, ${randomUUID()}, ${randomUUID()}, ${randomUUID()},
          ${randomUUID()}, ${randomUUID()}, ${"a".repeat(64)}
        )
      `,
      /permission denied/,
    );
  });

  await report.check("it cannot write a report item, so it cannot change a redaction", async () => {
    await assert.rejects(
      () => api`
        insert into coaching.baseline_report_items (
          baseline_report_id, section, display_order, item_kind, coverage_dimension_key,
          entitlement_key
        ) values (${randomUUID()}, 'coverage', 0, 'coverage', 'few_games', 'pro_detail')
      `,
      /permission denied/,
    );
  });

  await report.check("its update on diagnostic items is column-scoped", async () => {
    const columns = await sql<{ column_name: string }[]>`
      select column_name from information_schema.column_privileges
      where table_schema = 'coaching' and table_name = 'diagnostic_session_items'
        and grantee = 'forma_api' and privilege_type = 'UPDATE'
      order by column_name
    `;
    assert.deepEqual(
      columns.map((row) => row.column_name),
      ["presented_at"],
      "the API can rewrite the expected move of an item it is about to ask",
    );
  });

  report.section("redaction removes depth and never removes doubt");

  const coverage = decideCoverage(
    [
      {
        playedAt: new Date(),
        speed: "blitz",
        hasClock: false,
        reachedMiddlegame: false,
        reachedEndgame: false,
        eligible: true,
      },
    ],
    [
      {
        dimensionKey: "fork_recognize",
        observationCount: 1,
        effectiveCount: 1,
        earliestPlayedAt: null,
        latestPlayedAt: null,
      },
    ],
    { providerRating: 2600 },
  );

  await report.check("a thin, out-of-range report still states every limitation", () => {
    assert.ok(coverage.limitations.includes("few_games"));
    assert.ok(coverage.limitations.includes("outside_calibrated_rating"));
    const items = buildReport({
      coverage,
      findings: [],
      estimates: [],
      trajectorySnapshotId: null,
      diagnosticSessionId: null,
    });
    const free = redactForPlan(items, "free");
    const pro = redactForPlan(items, "pro");
    const coverageCount = (list: readonly { itemKind: string }[]): number =>
      list.filter((item) => item.itemKind === "coverage").length;
    assert.ok(coverageCount(items) >= coverage.limitations.length);
    assert.equal(coverageCount(free.items), coverageCount(items));
    assert.equal(coverageCount(pro.items), coverageCount(items));
  });

  await report.check("every plan includes the always tier", () => {
    for (const plan of ["free", "pro"] as const) {
      assert.ok(PLAN_ENTITLEMENTS[plan].includes("always"), `${plan} could redact a limitation`);
    }
  });

  report.section("no log line identifies a person or leaks an answer");

  await report.check("the serializer emits exactly the declared fields", () => {
    const line = onboardingEventLine({
      event: "diagnostic_attempt",
      traceId: "t",
      sessionId: "s",
      purpose: "earlier_mishandled",
      correct: false,
      hintsUsed: 1,
      withinTimedWindow: true,
      // Neither may survive serialization.
      ...({ moveUci: "e2e4", userId: "u-1" } as Record<string, unknown>),
    } as never);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(parsed).sort(),
      [...ONBOARDING_EVENT_FIELDS.diagnostic_attempt].sort(),
    );
    assert.equal("moveUci" in parsed, false);
    assert.equal("userId" in parsed, false);
  });

  await report.check("no declared field could carry a person, a move or a position", () => {
    for (const fields of Object.values(ONBOARDING_EVENT_FIELDS)) {
      for (const field of fields) {
        assert.ok(
          !/user|account|subject|username|uci|fen|move|email/i.test(field),
          `${field} would identify a person or leak an answer`,
        );
      }
    }
  });
} finally {
  await harness.destroy();
}

report.finish();

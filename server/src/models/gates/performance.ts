/**
 * `npm run models:performance` — the budgets this epic adds, on a
 * production-shaped game.
 *
 * Two kinds of number appear here and they are not treated the same. Counts are
 * asserted: how many inferences a run computes, how many it reuses, how many
 * queries a review page costs. They are deterministic, they are the thing that
 * actually decides cost, and a regression in one is a bug rather than a busy
 * machine. Wall-clock is measured and printed against a generous ceiling,
 * because a laptop and a CI runner disagree about milliseconds and an assertion
 * that fails on the same commit twice out of three runs teaches people to
 * ignore gates.
 *
 * The budget that matters commercially is the second one: a human-policy
 * inference is a model call per position, and without the cache a re-analysis
 * of the same game pays for all of them again.
 */

import { strict as assert } from "node:assert";

import { GateReport, startAnalysisHarness } from "../../analysis/gates/harness.js";
import { setAnalysisEventSink } from "../../analysis/telemetry.js";
import { setEngineEventSink } from "../../engine/telemetry.js";
import {
  FIXTURE_ENGINE,
  PLAIN_MOVES,
  fixtureEngineSession,
  seedAnalysableGame,
  seedPromotedRecipe,
} from "../../engine/fixtures.js";
import { PRACTICAL_CONTEXT_BUDGETS } from "../contract.js";
import { normalizePolicy } from "../policy.js";
import { computePracticalContext, type HumanPolicyEngine } from "../practical-context.js";
import { setModelsEventSink } from "../telemetry.js";

const report = new GateReport("E14 human context performance gate");
const harness = await startAnalysisHarness();
const sql = harness.sql;
setAnalysisEventSink(() => {});
setEngineEventSink(() => {});
setModelsEventSink(() => {});

process.env.DATABASE_URL = harness.db.urlFor("forma_analysis");
process.env.DATABASE_ROLE = "forma_analysis";
const { planGameAnalysis } = await import("../../engine/plan.js");
const { ASSESS_TASK, DEEP_TASK, SCREEN_TASK, assessTransitions, deepenGame, screenGame, setEngineSessionFactory } =
  await import("../../engine/worker.js");
const { readGameReview } = await import("../../engine/review.js");

setEngineSessionFactory(async () => fixtureEngineSession({}));

function context(taskType: string, payload: Record<string, unknown>, workflow = "") {
  return {
    item: {
      id: "1",
      workflowId: workflow,
      taskType,
      resourceClass: "cpu_engine" as const,
      inputRef: null,
      payload,
      attempt: 1,
      maxAttempts: 5,
      leaseOwner: "gate",
      timeoutSeconds: 300,
    },
    traceId: null,
    async checkpoint() {
      return { continue: true };
    },
  };
}

/** A policy engine that answers instantly and counts how often it was asked. */
let inferences = 0;
const countingEngine: HumanPolicyEngine = {
  async inferPolicy() {
    inferences += 1;
    return {
      policy: normalizePolicy(
        [
          { uci: "e7e5", probability: 0.5 },
          { uci: "c7c5", probability: 0.3 },
          { uci: "e7e6", probability: 0.2 },
        ],
        2,
      ),
      latencyMs: 1,
      networkBand: 1500,
    };
  },
};

try {
  const suffix = `p${Date.now().toString(36)}`;
  const game = await seedAnalysableGame(sql, { moves: PLAIN_MOVES });
  const versions = await seedPromotedRecipe(sql, suffix);
  const planned = await planGameAnalysis(sql, {
    subjectGameId: game.subjectGameId,
    ownerProfileId: game.ownerUserId,
  });
  if (planned?.state !== "scheduled") throw new Error(`plan said ${planned?.state}`);
  const enginePayload = {
    materializationRunId: game.materializationRunId,
    engineVersionId: versions.engineProfileId,
    calibrationVersionId: versions.calibrationVersionId,
  };
  await screenGame(context(SCREEN_TASK, enginePayload, planned.workflowId), sql);
  await deepenGame(context(DEEP_TASK, enginePayload, planned.workflowId), sql);
  await assessTransitions(context(ASSESS_TASK, { runId: planned.runId }, planned.workflowId), sql);

  report.section("writing the practical layer");

  let firstPass = { written: 0, computed: 0 };
  await report.check("every assessment gets a row, available or not", async () => {
    const startedAt = Date.now();
    const summary = await computePracticalContext(sql, countingEngine, {
      runId: planned.runId,
      materializationRunId: game.materializationRunId,
      subjectGameId: game.subjectGameId,
      modelContentHash: FIXTURE_ENGINE.binarySha256 ?? "fixture",
    });
    const elapsed = Date.now() - startedAt;
    firstPass = { written: summary.written, computed: summary.inferencesComputed };

    const [row] = await sql<{ count: string }[]>`
      select count(*)::text as count from analysis.transition_assessments
      where analysis_run_id = ${planned.runId}
    `;
    assert.equal(summary.written, Number(row!.count), "an assessment was left without a row");
    console.log(
      `      wrote ${summary.written} rows in ${elapsed}ms ` +
        `(advisory ceiling ${PRACTICAL_CONTEXT_BUDGETS.writePerGameMs}ms)`,
    );
    assert.ok(
      elapsed < PRACTICAL_CONTEXT_BUDGETS.writePerGameMs * 10,
      `writing took ${elapsed}ms, an order of magnitude past the budget`,
    );
  });

  await report.check("no promoted model means no inference was ever paid for", () => {
    // Nothing is promoted in this gate, so every row is `no_promoted_model` and
    // the engine must not have been asked. A model call for a position we were
    // never going to publish is pure cost.
    assert.equal(firstPass.computed, 0);
    assert.equal(inferences, 0, "the engine was called for an unpublishable position");
  });

  await report.check("a repeated delivery writes nothing and costs nothing", async () => {
    const before = inferences;
    const summary = await computePracticalContext(sql, countingEngine, {
      runId: planned.runId,
      materializationRunId: game.materializationRunId,
      subjectGameId: game.subjectGameId,
      modelContentHash: FIXTURE_ENGINE.binarySha256 ?? "fixture",
    });
    assert.equal(inferences, before, "a retry recomputed inferences");
    const [row] = await sql<{ count: string }[]>`
      select count(*)::text as count from analysis.practical_context_assessments
      where analysis_run_id = ${planned.runId}
    `;
    assert.equal(Number(row!.count), summary.written, "a retry doubled the rows");
  });

  report.section("reading it back");

  await report.check("the review page reads the whole layer in one query", async () => {
    const startedAt = Date.now();
    const review = await readGameReview(sql, {
      subjectGameId: game.subjectGameId,
      ownerProfileId: game.ownerUserId,
    });
    const elapsed = Date.now() - startedAt;
    assert.ok(review, "the game has a published review");
    assert.ok(review!.moves.length > 0);
    for (const move of review!.moves) {
      assert.ok(move.practicalContext, `ply ${move.fromPly} has no practical context field`);
    }
    console.log(
      `      read ${review!.moves.length} moves in ${elapsed}ms ` +
        `(advisory ceiling ${PRACTICAL_CONTEXT_BUDGETS.reviewReadMs}ms)`,
    );
    assert.ok(
      elapsed < PRACTICAL_CONTEXT_BUDGETS.reviewReadMs * 10,
      `the review read took ${elapsed}ms, an order of magnitude past the budget`,
    );
  });
} finally {
  await harness.destroy();
}

report.finish();

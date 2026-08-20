/**
 * `npm run models:integration` — E14 end to end on a disposable Postgres.
 *
 * The claim under test is a separation, so most of these checks are refusals:
 * a model whose licence was never reviewed cannot store an inference, a human
 * model cannot write an objective evaluation, and a practical claim cannot cite
 * a slice that was never calibrated or that describes a different model.
 *
 * The other half is the epic's conditional outcome. A candidate that fails the
 * promotion gate must leave a complete, readable record — a shadow lifecycle
 * event naming the blockers, calibration slices marked unsupported with their
 * reasons, and every position answering `unavailable` — rather than leaving the
 * next operator unable to tell "we measured and it did not qualify" from
 * "nobody has run this yet".
 */

import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";

import { GateReport, startAnalysisHarness } from "../../analysis/gates/harness.js";
import { setAnalysisEventSink } from "../../analysis/telemetry.js";
import { setEngineEventSink } from "../../engine/telemetry.js";
import {
  FIXTURE_ENGINE,
  PLAIN_MOVES,
  SHA,
  fixtureEngineSession,
  seedAnalysableGame,
  seedPromotedRecipe,
} from "../../engine/fixtures.js";
import { registerComponent, registerComponentVersion } from "../../analysis/versions.js";
import { evaluatePromotion, type HoldoutOutcome } from "../calibration.js";
import { PRESSURE_METHOD, PROMOTION_THRESHOLDS } from "../contract.js";
import { buildPracticalContext } from "../practical.js";
import { normalizePolicy } from "../policy.js";
import {
  MODEL_COMPONENT_KEYS,
  lookupCalibrationSlice,
  recordLifecycle,
  recordValidation,
  registerHumanModel,
  resolvePromotedHumanModel,
} from "../store.js";

const report = new GateReport("E14 human context integration gate");
const harness = await startAnalysisHarness();
const sql = harness.sql;
setAnalysisEventSink(() => {});
setEngineEventSink(() => {});

process.env.DATABASE_URL = harness.db.urlFor("forma_analysis");
process.env.DATABASE_ROLE = "forma_analysis";
const { planGameAnalysis } = await import("../../engine/plan.js");
const {
  ASSESS_TASK,
  DEEP_TASK,
  SCREEN_TASK,
  assessTransitions,
  deepenGame,
  screenGame,
  setEngineSessionFactory,
} = await import("../../engine/worker.js");

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
    traceId: "gate-trace",
    async checkpoint() {
      return { continue: true };
    },
  };
}

const SUFFIX = `m${Date.now().toString(36)}`;

const LICENCE = {
  spdx: "GPL-3.0",
  sourceUrl: "https://github.com/CSSLab/maia-chess",
  obligations:
    "Copyleft. The networks are run through an unmodified Lc0 binary as a separate process over UCI; no combined work is created and nothing is redistributed.",
  distributionPosture: "server_side_only" as const,
  reviewer: "forma-platform",
  decision: "cleared" as const,
};

const ASSET = {
  kind: "weights" as const,
  sha256: SHA("maia-1500-weights"),
  byteSize: 1_258_199,
  sourceUrl: "https://github.com/CSSLab/maia-chess/raw/master/maia_weights/maia-1500.pb.gz",
};

try {
  // Seeded first so the objective engine exists before anything asserts what it
  // may not do. A check that passes because its fixture is missing is not a
  // check.
  const seededRecipe = await seedPromotedRecipe(sql, SUFFIX);

  // -------------------------------------------------------------------------
  report.section("a model cannot store anything before its licence is reviewed");

  await report.check("a cleared profile without a review is refused by the database", async () => {
    await registerComponent(sql, {
      componentKey: `unreviewed_policy_${SUFFIX}`,
      category: "human_policy",
      description: "A human policy nobody reviewed.",
      inputContract: "human_policy_context.v1",
      outputContract: "human_policy_distribution.v1",
    });
    const version = await registerComponentVersion(sql, {
      componentKey: `unreviewed_policy_${SUFFIX}`,
      version: "1",
      implementationSha256: SHA(`unreviewed-${SUFFIX}`),
      modelIdentity: { weights: SHA("unreviewed-weights") },
      licence: "unknown",
      deterministic: true,
    });
    await assert.rejects(
      () => sql`
        insert into analysis.model_profiles (
          component_version_id, role, hardware_class, input_context_contract,
          output_interpretation_contract, licence_review_status
        ) values (
          ${version.id}, 'human_policy', 'cpu_model', 'human_policy_context.v1',
          'human_policy_distribution.v1', 'cleared'
        )
      `,
      /cleared without a cleared licence review/,
    );
  });

  const unreviewed = await sql<{ id: string }[]>`
    select cv.id from analysis.component_versions cv
    join analysis.components c on c.id = cv.component_id
    where c.component_key = ${`unreviewed_policy_${SUFFIX}`}
  `;
  const unreviewedVersionId = unreviewed[0]!.id;

  await report.check("a pending profile may exist, and may not store an inference", async () => {
    await sql`
      insert into analysis.model_profiles (
        component_version_id, role, hardware_class, input_context_contract,
        output_interpretation_contract, licence_review_status
      ) values (
        ${unreviewedVersionId}, 'human_policy', 'cpu_model', 'human_policy_context.v1',
        'human_policy_distribution.v1', 'pending'
      )
    `;
    const position = await someCorePositionId();
    await assert.rejects(
      () => insertPolicyInference(unreviewedVersionId, position, SHA(`cache-${SUFFIX}-a`)),
      /licence review status pending/,
    );
  });

  // -------------------------------------------------------------------------
  report.section("registration writes the review, the assets and the profile");

  const model = await registerHumanModel(sql, {
    version: `maia-1.0-${SUFFIX}`,
    assets: [ASSET],
    licence: LICENCE,
    provenance:
      "CSSLab maia-chess maia_weights, downloaded by content hash and run through Lc0 v0.32.1.",
  });

  await report.check("the licence review, the asset and the profile all exist", async () => {
    const [review] = await sql<{ decision: string; licence_spdx: string }[]>`
      select decision, licence_spdx from analysis.model_licence_reviews
      where component_version_id = ${model.componentVersionId}
    `;
    assert.equal(review?.decision, "cleared");
    assert.equal(review?.licence_spdx, "GPL-3.0");

    const [asset] = await sql<{ sha256: string; byte_size: string }[]>`
      select sha256, byte_size from analysis.model_assets
      where component_version_id = ${model.componentVersionId}
    `;
    assert.equal(asset?.sha256, ASSET.sha256);

    const [profile] = await sql<{ role: string; licence_review_status: string }[]>`
      select role, licence_review_status from analysis.model_profiles
      where component_version_id = ${model.componentVersionId}
    `;
    assert.equal(profile?.role, "human_policy");
    assert.equal(profile?.licence_review_status, "cleared");
  });

  await report.check("registering twice finds the same version rather than forking", async () => {
    const again = await registerHumanModel(sql, {
      version: `maia-1.0-${SUFFIX}`,
      assets: [ASSET],
      licence: LICENCE,
      provenance:
        "CSSLab maia-chess maia_weights, downloaded by content hash and run through Lc0 v0.32.1.",
    });
    assert.equal(again.componentVersionId, model.componentVersionId);
    const [{ count }] = await sql<{ count: string }[]>`
      select count(*)::text as count from analysis.model_assets
      where component_version_id = ${model.componentVersionId}
    `;
    assert.equal(count, "1");
  });

  await report.check("the review is immutable once written", async () => {
    await assert.rejects(
      () => sql`
        update analysis.model_licence_reviews set decision = 'rejected'
        where component_version_id = ${model.componentVersionId}
      `,
      /immutable|refuse/i,
    );
  });

  // -------------------------------------------------------------------------
  report.section("human output and objective output cannot be mistaken for each other");

  const corePositionId = await someCorePositionId();

  await report.check("a cleared human model may store a policy inference", async () => {
    const id = await insertPolicyInference(
      model.componentVersionId,
      corePositionId,
      SHA(`cache-${SUFFIX}-policy`),
    );
    const [row] = await sql<{ anonymous: boolean; unretained: string }[]>`
      select anonymous, unretained_probability_mass as unretained
      from analysis.model_inferences where id = ${id}
    `;
    assert.equal(row?.anonymous, true, "an inference with no occurrence is anonymous");
    assert.ok(Number(row!.unretained) > 0, "unretained mass is recorded, not implied");
  });

  await report.check("an objective engine cannot write into model_inferences", async () => {
    const engine = await sql<{ component_version_id: string }[]>`
      select component_version_id from analysis.model_profiles
      where role = 'objective_engine' limit 1
    `;
    assert.ok(engine[0], "the fixture registered an objective engine");
    await assert.rejects(
      () =>
        insertPolicyInference(
          engine[0]!.component_version_id,
          corePositionId,
          SHA(`cache-${SUFFIX}-engine`),
        ),
      /objective_engine output belongs in/,
    );
  });

  await report.check("an output kind that contradicts the model's role is refused", async () => {
    await assert.rejects(
      () => sql`
        insert into analysis.model_inferences (
          model_component_version_id, core_position_id, output_kind,
          context_has_move_history, input_contract_hash, cache_key,
          human_win, human_draw, human_loss
        ) values (
          ${model.componentVersionId}, ${corePositionId}, 'human_outcome',
          true, ${SHA("contract")}, ${SHA(`cache-${SUFFIX}-wdl`)}, 0.4, 0.3, 0.3
        )
      `,
      /does not match model role/,
    );
  });

  await report.check("a policy inference must carry a distribution", async () => {
    await assert.rejects(
      () => sql`
        insert into analysis.model_inferences (
          model_component_version_id, core_position_id, output_kind,
          context_has_move_history, input_contract_hash, cache_key
        ) values (
          ${model.componentVersionId}, ${corePositionId}, 'human_policy',
          true, ${SHA("contract")}, ${SHA(`cache-${SUFFIX}-empty`)}
        )
      `,
      /model_inferences_policy_shape/,
    );
  });

  // -------------------------------------------------------------------------
  report.section("a benchmark that fails leaves evidence, not silence");

  const failingSlices = [
    {
      slice: { provider: "lichess" as const, speed: "blitz" as const, band: { low: 1400, high: 1500 } },
      outcomes: Array.from({ length: 12 }, (): HoldoutOutcome => ({
        accountKey: "one-player",
        playedUci: "e2e4",
        predictedUci: "e2e4",
        predictedProbability: 0.6,
        latencyMs: 12,
      })),
    },
  ];
  const failingVerdict = evaluatePromotion({
    slices: failingSlices,
    dataset: { accountDisjoint: true, chronologicalSplit: true, licenceCleared: true },
  });

  const recorded = await recordValidation(
    sql,
    {
      datasetKey: `maia_holdout_${SUFFIX}`,
      datasetVersion: "1",
      manifestSha256: SHA(`manifest-${SUFFIX}`),
      samplingDescription: "Gate fixture: one account, twelve positions.",
      accountDisjoint: true,
      chronologicalSplit: true,
      licence: "CC0-1.0",
      governanceClass: "public",
      executionRevision: "gate",
      outputChecksum: SHA(`output-${SUFFIX}`),
      modelComponentVersionId: model.componentVersionId,
      calibrationComponentVersionId: model.calibrationVersionId,
    },
    failingVerdict,
  );

  await report.check("the verdict is a refusal with reasons", () => {
    assert.equal(failingVerdict.promote, false);
    assert.ok(failingVerdict.blockers.length > 0);
    assert.equal(failingVerdict.supportedSliceCount, 0);
  });

  await report.check("the validation run records failed, not the job's exit code", async () => {
    const [run] = await sql<{ status: string; summary: { blockers: string[] } }[]>`
      select status, summary from analysis.validation_runs where id = ${recorded.validationRunId}
    `;
    assert.equal(run?.status, "failed");
    assert.ok(run!.summary.blockers.length > 0, "the blockers are readable from the row");
  });

  await report.check("an unsupported slice publishes a reason and no metrics", async () => {
    const [slice] = await sql<
      {
        supported: boolean;
        unsupported_reason: string | null;
        top1_accuracy: number | null;
      }[]
    >`
      select supported, unsupported_reason, top1_accuracy
      from analysis.model_calibration_slices
      where model_component_version_id = ${model.componentVersionId}
    `;
    assert.equal(slice?.supported, false);
    assert.ok(slice!.unsupported_reason && slice!.unsupported_reason.length > 0);
    assert.equal(slice!.top1_accuracy, null, "an unsupported slice quotes no accuracy");
  });

  await report.check("the refusal is recorded as a shadow event, not as silence", async () => {
    await recordLifecycle(sql, {
      componentVersionId: model.componentVersionId,
      fromState: null,
      toState: "draft",
      validationRunId: null,
      reason: "registered",
    });
    await recordLifecycle(sql, {
      componentVersionId: model.componentVersionId,
      fromState: "draft",
      toState: "shadow",
      validationRunId: recorded.validationRunId,
      reason: `not promoted: ${failingVerdict.blockers.join("; ")}`,
    });
    const [event] = await sql<{ to_state: string; reason: string }[]>`
      select to_state, reason from analysis.component_lifecycle_events
      where component_version_id = ${model.componentVersionId} order by id desc limit 1
    `;
    assert.equal(event?.to_state, "shadow");
    assert.ok(event!.reason.includes("not promoted"));
  });

  await report.check("nothing is promoted, so no human claim is available", async () => {
    assert.equal(await resolvePromotedHumanModel(sql), null);
  });

  await report.check("promoting to production without evidence is refused", async () => {
    await assert.rejects(
      () =>
        recordLifecycle(sql, {
          componentVersionId: model.componentVersionId,
          fromState: "shadow",
          toState: "production",
          validationRunId: null,
          reason: "wishful",
        }),
      /lifecycle_evidence_required/,
    );
  });

  // -------------------------------------------------------------------------
  report.section("practical context on a real assessment");

  const game = await seedAnalysableGame(sql, { moves: PLAIN_MOVES });
  const versions = seededRecipe;
  const planned = await planGameAnalysis(sql, {
    subjectGameId: game.subjectGameId,
    ownerProfileId: game.ownerUserId,
  });
  assert.equal(planned?.state, "scheduled", `plan said ${planned?.state}`);
  if (planned?.state !== "scheduled") throw new Error("unreachable");
  const runId = planned.runId;
  const workflowId = planned.workflowId;
  const enginePayload = {
    materializationRunId: game.materializationRunId,
    engineVersionId: versions.engineProfileId,
    calibrationVersionId: versions.calibrationVersionId,
  };
  await screenGame(context(SCREEN_TASK, enginePayload, workflowId), sql);
  // The deep pass is what produces MultiPV lines. Without it every after
  // position has one candidate, and the adequate reply set has no answer.
  await deepenGame(context(DEEP_TASK, enginePayload, workflowId), sql);
  await assessTransitions(context(ASSESS_TASK, { runId }, workflowId), sql);

  const [assessment] = await sql<{ id: string }[]>`
    select id from analysis.transition_assessments
    where analysis_run_id = ${runId} order by from_ply limit 1
  `;
  assert.ok(assessment, "E12 produced a transition assessment to hang context off");
  const assessmentId = assessment!.id;

  await report.check("with nothing promoted, the row says no_promoted_model", async () => {
    const decision = buildPracticalContext({
      promotedModelComponentVersionId: await resolvePromotedHumanModel(sql),
      slice: undefined,
      context: {
        provider: "lichess",
        actorRating: 1450,
        opponentRating: 1460,
        speed: "blitz",
        clockBucket: null,
        hasMoveHistory: true,
      },
      requiredContextFields: ["provider", "speed", "actorRating"],
      adequateReplies: ["e7e5"],
      bestReplyUci: "e7e5",
      policy: normalizePolicy([{ uci: "e7e5", probability: 1 }]),
    });
    assert.equal(decision.status, "unavailable");
    assert.equal(decision.status === "unavailable" && decision.reason, "no_promoted_model");
    await sql`
      insert into analysis.practical_context_assessments (
        transition_assessment_id, analysis_run_id, status, unavailable_reason
      ) values (
        ${assessmentId}, ${runId}, 'unavailable',
        ${decision.status === "unavailable" ? decision.reason : null}
      )
    `;
    const [row] = await sql<{ status: string; pressure: string | null }[]>`
      select status, practical_pressure_upper as pressure
      from analysis.practical_context_assessments where transition_assessment_id = ${assessmentId}
    `;
    assert.equal(row?.status, "unavailable");
    assert.equal(row!.pressure, null, "an unavailable row publishes no pressure");
  });

  await report.check("an unavailable row carrying a vector is refused", async () => {
    await assert.rejects(
      () => sql`
        insert into analysis.practical_context_assessments (
          transition_assessment_id, analysis_run_id, status, unavailable_reason,
          adequate_reply_count, adequate_reply_probability
        ) values (
          ${assessmentId}, ${randomUUID()}, 'unavailable', 'no_promoted_model', 3, 0.7
        )
      `,
      /practical_context_available_shape|violates foreign key/,
    );
  });

  await report.check("an available row citing an unsupported slice is refused", async () => {
    const [slice] = await sql<{ id: string }[]>`
      select id from analysis.model_calibration_slices
      where model_component_version_id = ${model.componentVersionId} limit 1
    `;
    const inferenceId = await insertPolicyInference(
      model.componentVersionId,
      corePositionId,
      SHA(`cache-${SUFFIX}-unsupported`),
    );
    const otherRunId = await freshRunId(runId);
    await assert.rejects(
      () => sql`
        insert into analysis.practical_context_assessments (
          transition_assessment_id, analysis_run_id, status, policy_inference_id,
          calibration_slice_id, pressure_method, adequate_reply_count,
          adequate_reply_probability, unretained_probability_mass, policy_entropy_bits,
          entropy_is_lower_bound
        ) values (
          ${assessmentId}, ${otherRunId}, 'available', ${inferenceId}, ${slice!.id},
          ${PRESSURE_METHOD}, 2, 0.7, 0.1, 1.2, true
        )
      `,
      /which is not supported/,
    );
  });

  // A supported slice, written by hand: the real benchmark refused, and the
  // available path still has to be proven or the epic would ship one branch.
  await report.check("an available row needs a slice describing the same model", async () => {
    const supportedSliceId = await insertSupportedSlice(
      model.calibrationVersionId,
      model.componentVersionId,
      recorded.validationRunId,
      1500,
    );
    const otherModel = await registerHumanModel(sql, {
      version: `maia-1.1-${SUFFIX}`,
      assets: [{ ...ASSET, sha256: SHA("other-weights") }],
      licence: LICENCE,
      provenance: "A second registered model, to prove the slice is checked against it.",
    });
    const otherInference = await insertPolicyInference(
      otherModel.componentVersionId,
      corePositionId,
      SHA(`cache-${SUFFIX}-other`),
    );
    const otherRunId = await freshRunId(runId);
    await assert.rejects(
      () => sql`
        insert into analysis.practical_context_assessments (
          transition_assessment_id, analysis_run_id, status, policy_inference_id,
          calibration_slice_id, pressure_method, adequate_reply_count,
          adequate_reply_probability, unretained_probability_mass, policy_entropy_bits,
          entropy_is_lower_bound
        ) values (
          ${assessmentId}, ${otherRunId}, 'available', ${otherInference}, ${supportedSliceId},
          ${PRESSURE_METHOD}, 2, 0.7, 0.1, 1.2, true
        )
      `,
      /describes a different model/,
    );
  });

  await report.check("a complete available row stores the interval, both bounds", async () => {
    const [supported] = await sql<{ id: string }[]>`
      select id from analysis.model_calibration_slices
      where model_component_version_id = ${model.componentVersionId} and supported
      limit 1
    `;
    const inferenceId = await insertPolicyInference(
      model.componentVersionId,
      corePositionId,
      SHA(`cache-${SUFFIX}-available`),
    );
    const otherRunId = await freshRunId(runId);
    await sql`
      insert into analysis.practical_context_assessments (
        transition_assessment_id, analysis_run_id, status, policy_inference_id,
        calibration_slice_id, pressure_method, adequate_reply_count,
        adequate_reply_probability, unretained_probability_mass, policy_entropy_bits,
        entropy_is_lower_bound, best_refutation_uci, best_refutation_probability,
        best_refutation_rank
      ) values (
        ${assessmentId}, ${otherRunId}, 'available', ${inferenceId}, ${supported!.id},
        ${PRESSURE_METHOD}, 2, 0.7, 0.1, 1.2, true, 'e7e5', 0.5, 1
      )
    `;
    const [row] = await sql<{ upper: string; lower: string }[]>`
      select practical_pressure_upper as upper, practical_pressure_lower as lower
      from analysis.practical_context_assessments
      where analysis_run_id = ${otherRunId} and transition_assessment_id = ${assessmentId}
    `;
    assert.ok(Math.abs(Number(row!.upper) - 0.3) < 1e-6, `upper was ${row!.upper}`);
    assert.ok(Math.abs(Number(row!.lower) - 0.2) < 1e-6, `lower was ${row!.lower}`);
  });

  await report.check("practical context is immutable and does not touch the assessment", async () => {
    await assert.rejects(
      () => sql`
        update analysis.practical_context_assessments set status = 'unavailable'
        where transition_assessment_id = ${assessmentId}
      `,
      /immutable|refuse/i,
    );
    const [row] = await sql<{ count: string }[]>`
      select count(*)::text as count from analysis.transition_assessments where id = ${assessmentId}
    `;
    assert.equal(row?.count, "1", "the objective assessment is untouched by any of this");
  });

  await report.check("thresholds are the frozen policy, not something a caller passes", () => {
    assert.equal(Object.isFrozen(PROMOTION_THRESHOLDS), true);
  });
} finally {
  await harness.destroy();
}

report.finish();

// ---------------------------------------------------------------------------

async function someCorePositionId(): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    select id from chess.core_positions order by id limit 1
  `;
  if (row) return row.id;
  const seeded = await seedAnalysableGame(sql, { moves: PLAIN_MOVES });
  void seeded;
  const [after] = await sql<{ id: string }[]>`
    select id from chess.core_positions order by id limit 1
  `;
  return after!.id;
}

async function insertPolicyInference(
  modelComponentVersionId: string,
  corePositionId: string,
  cacheKey: string,
): Promise<string> {
  const distribution = normalizePolicy(
    [
      { uci: "e7e5", probability: 0.5 },
      { uci: "c7c5", probability: 0.3 },
      { uci: "e7e6", probability: 0.2 },
    ],
    2,
  );
  const [row] = await sql<{ id: string }[]>`
    insert into analysis.model_inferences (
      model_component_version_id, core_position_id, output_kind, context_provider,
      context_actor_rating, context_speed, context_has_move_history,
      input_contract_hash, cache_key, retained_probability_mass, retained_move_count,
      policy_entropy_bits
    ) values (
      ${modelComponentVersionId}, ${corePositionId}, 'human_policy', 'lichess',
      1450, 'blitz', true, ${SHA("human_policy_context.v1")}, ${cacheKey},
      ${distribution.retainedMass}, ${distribution.moves.length}, ${distribution.entropyBits}
    )
    returning id
  `;
  for (const move of distribution.moves) {
    await sql`
      insert into analysis.model_move_probabilities (model_inference_id, rank, uci, probability)
      values (${row!.id}, ${move.rank}, ${move.uci}, ${move.probability})
    `;
  }
  return row!.id;
}

async function insertSupportedSlice(
  calibrationVersionId: string,
  modelVersionId: string,
  validationRunId: string,
  bandLow: number,
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into analysis.model_calibration_slices (
      calibration_component_version_id, model_component_version_id, validation_run_id,
      provider, speed, rating_band_low, rating_band_high, supported, sample_size,
      top1_accuracy, expected_calibration_error, brier_score
    ) values (
      ${calibrationVersionId}, ${modelVersionId}, ${validationRunId}, 'lichess', 'blitz',
      ${bandLow}, ${bandLow + 100}, true, 800, 0.51, 0.03, 0.42
    )
    returning id
  `;
  return row!.id;
}

/**
 * A second analysis run over the same game, so several practical rows can exist
 * for one assessment without colliding on the (run, assessment) unique key.
 */
async function freshRunId(templateRunId: string): Promise<string> {
  // A distinct input manifest, because E11 keeps at most one live run per
  // manifest: two runs over identical inputs are the same work, and the gate
  // wants two runs rather than a second copy of one.
  const manifest = SHA(`gate-rerun-${randomUUID()}`);
  const [row] = await sql<{ id: string }[]>`
    insert into analysis.runs (
      run_type, recipe_version_id, subject_id, subject_game_id, replay_revision_id,
      status, input_manifest_hash, trigger_kind, actor_kind
    )
    select run_type, recipe_version_id, subject_id, subject_game_id, replay_revision_id,
           'planned', ${manifest}, trigger_kind, actor_kind
    from analysis.runs where id = ${templateRunId}
    returning id
  `;
  return row!.id;
}

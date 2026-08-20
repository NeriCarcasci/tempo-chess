import { createHash } from "node:crypto";

import type { Sql } from "postgres";
import type { Queryable } from "../db/queryable.js";
import { registerComponent, registerComponentVersion } from "../analysis/versions.js";
import {
  CALIBRATION_POLICY_VERSION,
  PROMOTION_THRESHOLDS,
  RETAINED_MOVE_LIMIT,
  type Provider,
  type Speed,
} from "./contract.js";
import type { PromotionVerdict } from "./calibration.js";
import { calibrationRowsFor } from "./calibration.js";
import type { SupportedSlice } from "./practical.js";

/**
 * Persistence for the human-context layer.
 *
 * The ordering in `registerHumanModel` is the load-bearing part: the licence
 * review is written before the profile, because the profile's trigger refuses to
 * claim a cleared licence without one. That is deliberate duplication of intent
 * between code and schema — the code says what we mean, the trigger says it to
 * anyone who bypasses the code.
 */

export const MODEL_COMPONENT_KEYS = {
  humanPolicy: "maia_human_policy",
  calibration: "human_policy_calibration",
  agreement: "oracle_agreement",
} as const;

export interface ModelAsset {
  kind: "binary" | "weights" | "network" | "config";
  sha256: string;
  byteSize: number;
  sourceUrl: string;
}

export interface HumanModelRegistration {
  /** Version string for this model build, e.g. "maia-1.0". */
  version: string;
  /** Networks and binary, by content hash. */
  assets: readonly ModelAsset[];
  licence: {
    spdx: string;
    sourceUrl: string;
    obligations: string;
    distributionPosture: "server_side_only" | "redistributed" | "not_deployed";
    reviewer: string;
    decision: "cleared" | "restricted" | "rejected";
    note?: string;
  };
  /** Human-readable provenance: where the weights came from and what they are. */
  provenance: string;
}

export interface RegisteredHumanModel {
  componentVersionId: string;
  contentHash: string;
  calibrationVersionId: string;
  licenceCleared: boolean;
}

/**
 * Register the human model, its licence review, its assets and its profile.
 *
 * Everything is keyed by content hash, so re-running this after a failed
 * benchmark finds the same rows rather than forking a second "maia-1.0" whose
 * results nobody can compare to the first.
 */
export async function registerHumanModel(
  sql: Sql,
  input: HumanModelRegistration,
): Promise<RegisteredHumanModel> {
  await registerComponent(sql, {
    componentKey: MODEL_COMPONENT_KEYS.humanPolicy,
    category: "human_policy",
    description:
      "Rating-conditioned human move policy. Predicts what a player of a stated strength plays, never what is objectively best.",
    inputContract: "human_policy_context.v1",
    outputContract: "human_policy_distribution.v1",
  });
  await registerComponent(sql, {
    componentKey: MODEL_COMPONENT_KEYS.calibration,
    category: "calibration",
    description:
      "Per-slice calibration of a human policy model against a frozen holdout, and the thresholds that decide which slices it may speak on.",
    inputContract: "human_policy_distribution.v1",
    outputContract: "human_policy_calibration.v1",
  });

  const assetDigest = createHash("sha256");
  for (const asset of [...input.assets].sort((a, b) => a.sha256.localeCompare(b.sha256))) {
    assetDigest.update(`${asset.kind}:${asset.sha256}\n`);
  }

  const model = await registerComponentVersion(sql, {
    componentKey: MODEL_COMPONENT_KEYS.humanPolicy,
    version: input.version,
    implementationSha256: assetDigest.digest("hex"),
    configuration: { retainedMoveLimit: RETAINED_MOVE_LIMIT, policySoftmaxTemp: 1 },
    modelIdentity: {
      assets: input.assets.map((a) => ({ kind: a.kind, sha256: a.sha256 })),
    },
    licence: input.licence.spdx,
    provenance: input.provenance,
    // One node, no search, fixed weights: the same position and network give the
    // same distribution, which is what makes an inference cacheable at all.
    deterministic: true,
  });

  const calibration = await registerComponentVersion(sql, {
    componentKey: MODEL_COMPONENT_KEYS.calibration,
    version: CALIBRATION_POLICY_VERSION,
    implementationSha256: createHash("sha256")
      .update(JSON.stringify(PROMOTION_THRESHOLDS))
      .digest("hex"),
    configuration: PROMOTION_THRESHOLDS,
    deterministic: true,
    dependencies: [
      {
        componentKey: MODEL_COMPONENT_KEYS.humanPolicy,
        version: input.version,
        requiredContract: "human_policy_distribution.v1",
      },
    ],
  });

  // Before the profile, not after: analysis.enforce_licence_review() refuses a
  // cleared profile that has no review behind it.
  await sql`
    insert into analysis.model_licence_reviews (
      component_version_id, decision, licence_spdx, source_url, obligations,
      distribution_posture, reviewer, note
    ) values (
      ${model.id}, ${input.licence.decision}, ${input.licence.spdx}, ${input.licence.sourceUrl},
      ${input.licence.obligations}, ${input.licence.distributionPosture},
      ${input.licence.reviewer}, ${input.licence.note ?? null}
    )
    on conflict (component_version_id) do nothing
  `;

  for (const asset of input.assets) {
    await sql`
      insert into analysis.model_assets (
        component_version_id, asset_kind, sha256, byte_size, source_url
      ) values (
        ${model.id}, ${asset.kind}, ${asset.sha256}, ${asset.byteSize}, ${asset.sourceUrl}
      )
      on conflict (component_version_id, asset_kind, sha256) do nothing
    `;
  }

  const weights = input.assets.find((a) => a.kind === "weights") ?? null;
  const binary = input.assets.find((a) => a.kind === "binary") ?? null;
  await sql`
    insert into analysis.model_profiles (
      component_version_id, role, binary_sha256, weights_sha256, hardware_class,
      input_context_contract, output_interpretation_contract, licence_review_status, licence_note
    ) values (
      ${model.id}, 'human_policy', ${binary?.sha256 ?? null}, ${weights?.sha256 ?? null},
      'cpu_model', 'human_policy_context.v1', 'human_policy_distribution.v1',
      ${input.licence.decision === "cleared" ? "cleared" : "restricted"},
      ${input.licence.spdx}
    )
    on conflict (component_version_id) do nothing
  `;

  return {
    componentVersionId: model.id,
    contentHash: model.contentHash,
    calibrationVersionId: calibration.id,
    licenceCleared: input.licence.decision === "cleared",
  };
}

export interface ValidationEvidence {
  datasetKey: string;
  datasetVersion: string;
  manifestSha256: string;
  samplingDescription: string;
  accountDisjoint: boolean;
  chronologicalSplit: boolean;
  licence: string;
  governanceClass: "public" | "licensed" | "internal" | "restricted";
  executionRevision: string;
  outputChecksum: string;
  modelComponentVersionId: string;
  calibrationComponentVersionId: string;
  /** The stored corpus, when it was uploaded. Null keeps the dataset a hash. */
  artifactId?: string | null;
}

export interface RecordedValidation {
  datasetId: string;
  validationRunId: string;
  supportedSliceIds: readonly string[];
}

/**
 * Write the benchmark evidence: the dataset, the run, the metrics and the slices.
 *
 * The validation run's status follows the verdict rather than the exit code of
 * the process that produced it. A run that completed successfully and found the
 * model wanting is `failed`, because what the row records is the evaluation's
 * answer, not the job's.
 */
export async function recordValidation(
  sql: Sql,
  evidence: ValidationEvidence,
  verdict: PromotionVerdict,
): Promise<RecordedValidation> {
  return sql.begin(async (tx) => {
    // Insert-or-find rather than upsert: the dataset table is immutable, so a
    // `do update` — even a no-op one written only to get the id back — trips the
    // mutation trigger and fails the whole retry.
    const [inserted] = await tx<{ id: string }[]>`
      insert into analysis.validation_datasets (
        dataset_key, version, manifest_sha256, artifact_id, sampling_description,
        account_disjoint, chronological_split, licence, governance_class
      ) values (
        ${evidence.datasetKey}, ${evidence.datasetVersion}, ${evidence.manifestSha256},
        ${evidence.artifactId ?? null}, ${evidence.samplingDescription},
        ${evidence.accountDisjoint}, ${evidence.chronologicalSplit}, ${evidence.licence},
        ${evidence.governanceClass}
      )
      on conflict (dataset_key, version) do nothing
      returning id
    `;
    let dataset = inserted;
    if (!dataset) {
      const [existing] = await tx<{ id: string; manifest_sha256: string }[]>`
        select id, manifest_sha256 from analysis.validation_datasets
        where dataset_key = ${evidence.datasetKey} and version = ${evidence.datasetVersion}
      `;
      if (!existing) throw new Error("the dataset neither inserted nor exists");
      // Reusing a key for a different corpus would silently re-label old
      // evidence as being about new data. That is a new version, not a retry.
      if (existing.manifest_sha256 !== evidence.manifestSha256) {
        throw new Error(
          `dataset ${evidence.datasetKey}@${evidence.datasetVersion} already names a different corpus; use a new version`,
        );
      }
      dataset = { id: existing.id };
    }

    const [run] = await tx<{ id: string }[]>`
      insert into analysis.validation_runs (
        dataset_id, candidate_component_version_id, execution_revision, status,
        output_checksum, summary
      ) values (
        ${dataset!.id}, ${evidence.modelComponentVersionId}, ${evidence.executionRevision},
        ${verdict.promote ? "passed" : "failed"}, ${evidence.outputChecksum},
        ${tx.json({
          promote: verdict.promote,
          blockers: verdict.blockers,
          supportedSliceCount: verdict.supportedSliceCount,
          totalSampleSize: verdict.totalSampleSize,
        })}
      )
      returning id
    `;

    for (const slice of verdict.slices) {
      const sliceJson = tx.json({
        provider: slice.slice.provider,
        speed: slice.slice.speed,
        rating_band_low: slice.slice.band.low,
      });
      const metrics = slice.metrics;
      const named: [string, number | null][] = [
        ["top1_accuracy", slice.supported ? metrics.top1Accuracy : null],
        ["expected_calibration_error", slice.supported ? metrics.expectedCalibrationError : null],
        ["brier_score", slice.supported ? metrics.brierScore : null],
        ["failure_rate", metrics.failureRate],
        ["distinct_accounts", metrics.distinctAccounts],
        ["latency_p95_ms", metrics.latencyP95Ms],
      ];
      for (const [key, value] of named) {
        await tx`
          insert into analysis.validation_metrics (
            validation_run_id, metric_key, slice, sample_size, value, unavailable_reason
          ) values (
            ${run!.id}, ${key}, ${sliceJson}, ${metrics.sampleSize},
            ${value}, ${value === null ? (slice.supported ? "not measured" : "slice is not supported") : null}
          )
        `;
      }
    }

    const supportedSliceIds: string[] = [];
    for (const row of calibrationRowsFor(verdict)) {
      const [inserted] = await tx<{ id: string }[]>`
        insert into analysis.model_calibration_slices (
          calibration_component_version_id, model_component_version_id, validation_run_id,
          provider, speed, rating_band_low, rating_band_high, supported, unsupported_reason,
          sample_size, top1_accuracy, expected_calibration_error, brier_score
        ) values (
          ${evidence.calibrationComponentVersionId}, ${evidence.modelComponentVersionId},
          ${run!.id}, ${row.slice.provider}, ${row.slice.speed}, ${row.slice.band.low},
          ${row.slice.band.high}, ${row.supported}, ${row.unsupportedReason},
          ${row.sampleSize}, ${row.top1Accuracy}, ${row.expectedCalibrationError},
          ${row.brierScore}
        )
        on conflict (calibration_component_version_id, provider, speed, rating_band_low)
          do nothing
        returning id
      `;
      if (inserted && row.supported) supportedSliceIds.push(inserted.id);
    }

    return { datasetId: dataset!.id, validationRunId: run!.id, supportedSliceIds };
  });
}

/**
 * Move the model's lifecycle pointer.
 *
 * A refused candidate still gets an event: `shadow` records that it ran and was
 * not promoted, with the blockers as the reason. Silence would leave the next
 * operator unable to tell "we tried and it failed" from "nobody has looked".
 */
export async function recordLifecycle(
  sql: Queryable,
  input: {
    componentVersionId: string;
    fromState: string | null;
    toState: "draft" | "shadow" | "validated" | "production" | "retired";
    validationRunId: string | null;
    reason: string;
  },
): Promise<void> {
  await sql`
    insert into analysis.component_lifecycle_events (
      component_version_id, from_state, to_state, validation_run_id, actor_kind, reason
    ) values (
      ${input.componentVersionId}, ${input.fromState}, ${input.toState},
      ${input.validationRunId}, 'system', ${input.reason}
    )
  `;
}

/**
 * The human policy model currently in production, or null.
 *
 * Null is the normal answer until a candidate passes, and every caller has to
 * handle it: that is the `no_promoted_model` path, and it is the state v1 ships
 * in if nothing qualifies.
 */
export async function resolvePromotedHumanModel(sql: Queryable): Promise<string | null> {
  const [row] = await sql<{ component_version_id: string }[]>`
    select distinct on (e.component_version_id) e.component_version_id, e.to_state
    from analysis.component_lifecycle_events e
    join analysis.model_profiles p on p.component_version_id = e.component_version_id
    where p.role = 'human_policy' and p.licence_review_status = 'cleared'
    order by e.component_version_id, e.id desc
  `.then((rows) =>
    (rows as unknown as { component_version_id: string; to_state: string }[]).filter(
      (r) => r.to_state === "production",
    ),
  );
  return row?.component_version_id ?? null;
}

/** The calibration slice covering a context, or undefined when none was recorded. */
export async function lookupCalibrationSlice(
  sql: Queryable,
  input: {
    modelComponentVersionId: string;
    provider: Provider;
    speed: Speed;
    rating: number;
  },
): Promise<SupportedSlice | undefined> {
  const [row] = await sql<
    {
      id: string;
      provider: Provider;
      speed: Speed;
      rating_band_low: number;
      rating_band_high: number;
      supported: boolean;
      model_component_version_id: string;
    }[]
  >`
    select id, provider, speed, rating_band_low, rating_band_high, supported,
           model_component_version_id
    from analysis.model_calibration_slices
    where model_component_version_id = ${input.modelComponentVersionId}
      and provider = ${input.provider}
      and speed = ${input.speed}
      and ${input.rating} >= rating_band_low
      and ${input.rating} < rating_band_high
    order by created_at desc
    limit 1
  `;
  if (!row) return undefined;
  return {
    id: row.id,
    provider: row.provider,
    speed: row.speed,
    ratingBandLow: row.rating_band_low,
    ratingBandHigh: row.rating_band_high,
    supported: row.supported,
    modelComponentVersionId: row.model_component_version_id,
  };
}

import { createHash } from "node:crypto";

import type { Sql } from "postgres";

import type { Queryable } from "../db/queryable.js";
import { registerComponent, registerComponentVersion } from "../analysis/versions.js";
import { PHASE_CLASSIFIER_VERSION } from "../analysis/phase.js";
import {
  ALIGNMENT_POLICY,
  ESTIMATOR_POLICY,
  FINDING_POLICY,
  type Frame,
  type WindowKind,
} from "./contract.js";
import type { EstimateResult } from "./estimator.js";
import type { CandidateFinding } from "./findings.js";
import { structuredInputHash } from "./findings.js";
import type { TrajectoryBin } from "./trajectory.js";
import { checkRendering, renderTemplate } from "./render.js";
import { jsonParam } from "../db/json.js";

/**
 * Persistence for the estimate, trajectory and finding layer.
 *
 * The whole report is written in one transaction, because a dashboard that has
 * findings but no estimates, or findings whose evidence rows did not land, is a
 * page that says something nobody can check. The deferred evidence trigger from
 * 0028 enforces the second half of that at commit.
 */

export const ESTIMATE_COMPONENT_KEYS = {
  estimator: "skill_estimator",
  alignment: "trajectory_aligner",
  findingRules: "finding_rules",
  correction: "multiple_comparison_control",
  renderer: "explanation_renderer",
  /**
   * E12's phase classifier, registered here because E12 never registered it.
   *
   * A trajectory snapshot has to name the detector that produced its phase
   * labels — a curve computed under two different classifiers is two different
   * curves. E12 computes phases deterministically and versions the policy in
   * code (`PHASE_CLASSIFIER_VERSION`) but never wrote the catalogue row, so the
   * attribution had nowhere to point. Registering it here from that same
   * constant is the repair; it belongs in E12 and should move there.
   */
  phase: "phase_classifier",
} as const;

export interface RegisteredEstimateVersions {
  estimatorVersionId: string;
  alignmentVersionId: string;
  findingRulesVersionId: string;
  correctionVersionId: string;
  rendererVersionId: string;
  phaseVersionId: string;
}

/** Register the components this epic's output is attributed to. */
export async function registerEstimateComponents(sql: Sql): Promise<RegisteredEstimateVersions> {
  const catalogue: [string, string, string, string, string][] = [
    [
      ESTIMATE_COMPONENT_KEYS.estimator,
      "estimator",
      "Discounted Beta skill estimator with exponential time weighting and credible intervals.",
      "concept_opportunity.v1",
      "skill_estimate.v1",
    ],
    [
      ESTIMATE_COMPONENT_KEYS.alignment,
      "trajectory_aligner",
      "Phase-aligned trajectory: each reached phase normalized independently, no imputation.",
      "transition_assessment.v1",
      "trajectory_bins.v1",
    ],
    [
      ESTIMATE_COMPONENT_KEYS.findingRules,
      "finding_rules",
      "Derives structured findings from estimates and their coverage.",
      "skill_estimate.v1",
      "finding.v1",
    ],
    [
      ESTIMATE_COMPONENT_KEYS.correction,
      "finding_rules",
      "Benjamini-Hochberg false-discovery control across a claim family.",
      "finding.v1",
      "finding.v1",
    ],
    [
      ESTIMATE_COMPONENT_KEYS.renderer,
      "renderer",
      "Renders a finding into prose and refuses text that introduces a fact.",
      "finding.v1",
      "rendered_explanation.v1",
    ],
    [
      ESTIMATE_COMPONENT_KEYS.phase,
      "phase_detector",
      "Deterministic opening/middlegame/endgame classifier, versioned in E12's phase module.",
      "replay.v1",
      "phase_labels.v1",
    ],
  ];
  for (const [key, category, description, input, output] of catalogue) {
    await registerComponent(sql, {
      componentKey: key,
      category: category as never,
      description,
      inputContract: input,
      outputContract: output,
    });
  }

  const hash = (name: string, policy: unknown): string =>
    createHash("sha256").update(`${name}:${JSON.stringify(policy)}`).digest("hex");

  const estimator = await registerComponentVersion(sql, {
    componentKey: ESTIMATE_COMPONENT_KEYS.estimator,
    version: ESTIMATOR_POLICY.version,
    implementationSha256: hash("estimator", ESTIMATOR_POLICY),
    configuration: ESTIMATOR_POLICY,
    deterministic: true,
  });
  const alignment = await registerComponentVersion(sql, {
    componentKey: ESTIMATE_COMPONENT_KEYS.alignment,
    version: ALIGNMENT_POLICY.version,
    implementationSha256: hash("alignment", ALIGNMENT_POLICY),
    configuration: ALIGNMENT_POLICY,
    // Deterministic despite the bootstrap: the resampler is seeded, so two runs
    // over the same bins produce the same interval.
    deterministic: true,
  });
  const findingRules = await registerComponentVersion(sql, {
    componentKey: ESTIMATE_COMPONENT_KEYS.findingRules,
    version: FINDING_POLICY.version,
    implementationSha256: hash("findings", FINDING_POLICY),
    configuration: FINDING_POLICY,
    deterministic: true,
    dependencies: [
      {
        componentKey: ESTIMATE_COMPONENT_KEYS.estimator,
        version: ESTIMATOR_POLICY.version,
        requiredContract: "skill_estimate.v1",
      },
    ],
  });
  const correction = await registerComponentVersion(sql, {
    componentKey: ESTIMATE_COMPONENT_KEYS.correction,
    version: "benjamini_hochberg_v1",
    implementationSha256: hash("correction", { q: FINDING_POLICY.falseDiscoveryRate }),
    configuration: { falseDiscoveryRate: FINDING_POLICY.falseDiscoveryRate },
    deterministic: true,
  });
  const renderer = await registerComponentVersion(sql, {
    componentKey: ESTIMATE_COMPONENT_KEYS.renderer,
    version: "template_renderer_v1",
    implementationSha256: hash("renderer", { templates: "v1" }),
    configuration: { templates: "v1", model: null },
    deterministic: true,
  });

  const phase = await registerComponentVersion(sql, {
    componentKey: ESTIMATE_COMPONENT_KEYS.phase,
    version: PHASE_CLASSIFIER_VERSION,
    implementationSha256: hash("phase", { version: PHASE_CLASSIFIER_VERSION }),
    configuration: { version: PHASE_CLASSIFIER_VERSION },
    deterministic: true,
  });

  return {
    estimatorVersionId: estimator.id,
    alignmentVersionId: alignment.id,
    findingRulesVersionId: findingRules.id,
    correctionVersionId: correction.id,
    rendererVersionId: renderer.id,
    phaseVersionId: phase.id,
  };
}

export interface DimensionSpec {
  dimensionKey: string;
  version: string;
  conceptVersionId: string | null;
  role: string | null;
  speed: string | null;
  phase: string | null;
  frame: Frame;
  displayName: string;
}

/** Register a skill dimension, or find the one already registered for that slice. */
export async function ensureDimension(sql: Queryable, spec: DimensionSpec): Promise<string> {
  const [existing] = await sql<{ id: string }[]>`
    select id from analysis.skill_dimensions
    where dimension_key = ${spec.dimensionKey} and version = ${spec.version}
  `;
  if (existing) return existing.id;
  const [row] = await sql<{ id: string }[]>`
    insert into analysis.skill_dimensions (
      dimension_key, version, concept_version_id, role, speed, phase, frame, display_name
    ) values (
      ${spec.dimensionKey}, ${spec.version}, ${spec.conceptVersionId}, ${spec.role},
      ${spec.speed}, ${spec.phase}, ${spec.frame}, ${spec.displayName}
    )
    on conflict (dimension_key, version) do nothing
    returning id
  `;
  if (row) return row.id;
  const [after] = await sql<{ id: string }[]>`
    select id from analysis.skill_dimensions
    where dimension_key = ${spec.dimensionKey} and version = ${spec.version}
  `;
  if (!after) throw new Error(`dimension ${spec.dimensionKey} neither inserted nor exists`);
  return after.id;
}

export interface EstimateWrite {
  skillDimensionId: string;
  windowKind: WindowKind;
  result: EstimateResult;
  comparisonEstimateId: string | null;
  delta: number | null;
  improvementProbability: number | null;
}

export async function writeEstimate(
  sql: Queryable,
  input: {
    analysisRunId: string;
    subjectId: string;
    subjectDataSnapshotId: string;
    estimatorComponentVersionId: string;
  },
  write: EstimateWrite,
): Promise<string> {
  const result = write.result;
  const coverage = result.coverage;
  const [row] = await sql<{ id: string }[]>`
    insert into analysis.player_skill_estimates (
      analysis_run_id, subject_id, subject_data_snapshot_id, skill_dimension_id,
      estimator_component_version_id, window_kind, estimate, interval_low, interval_high,
      raw_sample_size, effective_sample_size, success_count, failure_count, graded_count,
      censored_count, evidence_from, evidence_to, comparison_estimate_id, delta,
      improvement_probability, coverage_status, unavailable_reason
    ) values (
      ${input.analysisRunId}, ${input.subjectId}, ${input.subjectDataSnapshotId},
      ${write.skillDimensionId}, ${input.estimatorComponentVersionId}, ${write.windowKind},
      ${result.status === "available" ? result.estimate : null},
      ${result.status === "available" ? result.intervalLow : null},
      ${result.status === "available" ? result.intervalHigh : null},
      ${coverage.raw}, ${coverage.effective}, ${coverage.success}, ${coverage.failure},
      ${coverage.graded}, ${coverage.censored}, ${coverage.from}, ${coverage.to},
      ${write.comparisonEstimateId}, ${write.delta}, ${write.improvementProbability},
      ${result.coverageStatus},
      ${result.status === "unavailable" ? result.reason : null}
    )
    returning id
  `;
  return row!.id;
}

export async function writeTrajectory(
  sql: Queryable,
  input: {
    analysisRunId: string;
    subjectId: string;
    subjectDataSnapshotId: string;
    phaseComponentVersionId: string;
    alignmentComponentVersionId: string;
    expectedScoreCalibrationVersionId: string;
    includedGameCount: number;
    speed: string | null;
    color: string | null;
  },
  bins: readonly TrajectoryBin[],
): Promise<string> {
  const [snapshot] = await sql<{ id: string }[]>`
    insert into analysis.player_trajectory_snapshots (
      analysis_run_id, subject_id, subject_data_snapshot_id, phase_component_version_id,
      alignment_component_version_id, expected_score_calibration_version_id,
      included_game_count, speed, color
    ) values (
      ${input.analysisRunId}, ${input.subjectId}, ${input.subjectDataSnapshotId},
      ${input.phaseComponentVersionId}, ${input.alignmentComponentVersionId},
      ${input.expectedScoreCalibrationVersionId}, ${input.includedGameCount},
      ${input.speed}, ${input.color}
    )
    returning id
  `;
  for (const bin of bins) {
    await sql`
      insert into analysis.player_trajectory_bins (
        trajectory_snapshot_id, phase, bin_ordinal, progress_low, progress_high,
        games_contributing, median_expected_score, p25_expected_score, p75_expected_score,
        interval_low, interval_high, phase_reach_rate, adverse_change_rate, recovery_slope
      ) values (
        ${snapshot!.id}, ${bin.phase}, ${bin.binOrdinal}, ${bin.progressLow},
        ${bin.progressHigh}, ${bin.gamesContributing}, ${bin.medianExpectedScore},
        ${bin.p25ExpectedScore}, ${bin.p75ExpectedScore}, ${bin.intervalLow},
        ${bin.intervalHigh}, ${bin.phaseReachRate}, ${bin.adverseChangeRate},
        ${bin.recoverySlope}
      )
    `;
  }
  return snapshot!.id;
}

export interface FindingWrite {
  candidate: CandidateFinding;
  playerSkillEstimateId: string | null;
  conceptVersionId: string | null;
  role: string | null;
  /** Evidence items, with the role each plays. Contradictions are kept. */
  evidence: readonly { evidenceItemId: string; role: string; weight: number | null }[];
}

/**
 * Write one finding, its evidence and its rendered prose.
 *
 * The renderer runs here rather than in a later pass so that the safety check
 * and the finding land in the same transaction: text that invented a number is
 * stored as `held` beside the facts that contradict it, which is what makes the
 * boundary auditable instead of merely asserted.
 */
export async function writeFinding(
  sql: Queryable,
  input: {
    analysisRunId: string;
    subjectId: string;
    correctionComponentVersionId: string;
    rendererComponentVersionId: string;
    locale?: string;
  },
  write: FindingWrite,
): Promise<{ findingId: string; safetyState: string }> {
  const candidate = write.candidate;
  const [finding] = await sql<{ id: string }[]>`
    insert into analysis.findings (
      analysis_run_id, subject_id, player_skill_estimate_id, finding_type,
      concept_version_id, role, context, priority, confidence_tier, claim,
      claim_family, correction_component_version_id, adjusted_probability
    ) values (
      ${input.analysisRunId}, ${input.subjectId}, ${write.playerSkillEstimateId},
      ${candidate.findingType}, ${write.conceptVersionId}, ${write.role},
      ${jsonParam({})}::jsonb, ${candidate.priority}, ${candidate.confidenceTier},
      ${jsonParam(candidate.claim)}::jsonb, ${candidate.claimFamily},
      ${candidate.adjustedProbability === null ? null : input.correctionComponentVersionId},
      ${candidate.adjustedProbability}
    )
    returning id
  `;

  let rank = 0;
  for (const item of write.evidence) {
    await sql`
      insert into analysis.finding_evidence (
        finding_id, evidence_item_id, role, weight, display_rank
      ) values (
        ${finding!.id}, ${item.evidenceItemId}, ${item.role}, ${item.weight}, ${rank++}
      )
      on conflict do nothing
    `;
  }

  const improvementAllowed =
    candidate.findingType === "established_improvement" ||
    candidate.findingType === "early_improvement_signal";
  const text = renderTemplate({ findingType: candidate.findingType, claim: candidate.claim });
  const check = checkRendering(text, candidate.claim, {
    improvementClaimAllowed: improvementAllowed,
  });

  await sql`
    insert into analysis.rendered_explanations (
      finding_id, renderer_component_version_id, locale, tone, reading_level,
      structured_input_hash, rendered_text, safety_state, safety_note
    ) values (
      ${finding!.id}, ${input.rendererComponentVersionId}, ${input.locale ?? "en"},
      'plain', 'general',
      ${structuredInputHash({
        findingType: candidate.findingType,
        claim: candidate.claim,
        evidenceIds: write.evidence.map((item) => item.evidenceItemId),
      })},
      ${text}, ${check.state}, ${check.note}
    )
    on conflict do nothing
  `;

  return { findingId: finding!.id, safetyState: check.state };
}

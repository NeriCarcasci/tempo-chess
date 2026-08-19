/**
 * Registering the engine, calibration, tolerance and selector versions, and the
 * model profile that projects the engine.
 *
 * Everything this epic computes is attributed to a component version, so the
 * versions have to exist before a worker can write a row. Registration is
 * idempotent by content hash — E11's `registerComponentVersion` returns the
 * existing row when the content matches — which is what lets a worker call this
 * on start-up without forking history on every deploy.
 *
 * The engine version's identity includes the binary and NNUE hashes. That is
 * the load-bearing part: platform spec §6.4 requires the engine binary hash,
 * NNUE hash, profile, limits and worker revision on every result, and if the
 * binary changed then the numbers can change, so it must be a different version
 * and therefore a different cache key. A deployment that upgrades Stockfish
 * does not silently reinterpret yesterday's evaluations; it starts filling a
 * new cache beside them.
 *
 * Sources: plans/database-architecture.md §§15.1, 12.2; plans/v1-platform-spec.md §§6.4, 12.
 */

import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import type { Queryable } from "../db/queryable.js";
import { registerComponent, registerComponentVersion } from "../analysis/versions.js";
import {
  ENGINE_COMPONENT_KEYS,
  ENGINE_PROFILES,
  EXPECTED_SCORE_CALIBRATION,
  TOLERANCE_RULE,
  type EngineProfileKey,
  type EngineProfileSpec,
} from "./contract.js";
import { DEFAULT_CRITICAL_POSITION_POLICY } from "./critical-position.js";

/** The Stockfish build a deployment is actually running. */
export interface EngineIdentity {
  engineName: string;
  engineVersion: string | null;
  binarySha256: string | null;
  networkHash: string | null;
}

export interface RegisteredEngineVersions {
  /** The model profile row: also the engine component version id. */
  engineProfileId: string;
  engineContentHash: string;
  calibrationVersionId: string;
  calibrationContentHash: string;
  toleranceVersionId: string;
  selectorVersionId: string;
}

/**
 * A version string that changes when the executable changes.
 *
 * `18` alone would not: two deployments running different builds of Stockfish
 * 18 with different networks would register the same version and then disagree
 * about what a cached number means. The digest suffix makes the version name
 * the executable rather than the marketing number.
 */
export function engineVersionLabel(identity: EngineIdentity): string {
  const base = identity.engineVersion ?? "unknown";
  const digest = createHash("sha256")
    .update(`${identity.engineName}|${identity.binarySha256 ?? ""}|${identity.networkHash ?? ""}`)
    .digest("hex")
    .slice(0, 12);
  return `${base}+${digest}`;
}

/**
 * Register the four component versions this epic's outputs cite, and project
 * the engine one into `analysis.model_profiles`.
 *
 * Called by the worker at start-up and by the gates. Idempotent: the same
 * engine build, calibration, tolerance and selector policy produce the same
 * content hashes and therefore the same rows.
 */
export async function registerEngineVersions(
  sql: Sql,
  identity: EngineIdentity,
): Promise<RegisteredEngineVersions> {
  await registerComponent(sql, {
    componentKey: ENGINE_COMPONENT_KEYS.objectiveEngine,
    category: "engine_profile",
    description: "Stockfish objective evaluation, run in the isolated engine worker",
    inputContract: "core_position.v1",
    outputContract: "position_evaluation.v1",
  });
  await registerComponent(sql, {
    componentKey: ENGINE_COMPONENT_KEYS.expectedScore,
    category: "calibration",
    description: "Objective engine output to expected score",
    inputContract: "position_evaluation.v1",
    outputContract: "expected_score.v1",
  });
  await registerComponent(sql, {
    componentKey: ENGINE_COMPONENT_KEYS.tolerance,
    category: "feature_extractor",
    description: "Objective adequate-move tolerance rule",
    inputContract: "expected_score.v1",
    outputContract: "transition_assessment.v1",
  });
  await registerComponent(sql, {
    componentKey: ENGINE_COMPONENT_KEYS.criticalSelector,
    category: "feature_extractor",
    description: "Selects transitions that warrant a deeper MultiPV search",
    inputContract: "transition_assessment.v1",
    outputContract: "critical_selection.v1",
  });

  const engine = await registerComponentVersion(sql, {
    componentKey: ENGINE_COMPONENT_KEYS.objectiveEngine,
    version: engineVersionLabel(identity),
    // The binary is the implementation. When it is not readable — a fixture
    // engine, or a container where the path is not resolvable — the identity
    // still has to be a hash of *something* stable, so it is derived from the
    // name and network and the absence is visible in `binary_sha256`.
    implementationSha256:
      identity.binarySha256 ??
      createHash("sha256").update(`unhashed:${identity.engineName}:${identity.networkHash ?? ""}`).digest("hex"),
    configuration: { profiles: ENGINE_PROFILES },
    modelIdentity: {
      engineName: identity.engineName,
      engineVersion: identity.engineVersion,
      binarySha256: identity.binarySha256,
      networkHash: identity.networkHash,
    },
    // GPL-3.0 and invoked as a separate process over UCI, which is what makes
    // it usable here. Recorded because §15.1 makes licence review a state.
    licence: "GPL-3.0-or-later",
    provenance: "official Stockfish build invoked over UCI by forma-stockfish-worker",
    deterministic: true,
  });

  const calibration = await registerComponentVersion(sql, {
    componentKey: ENGINE_COMPONENT_KEYS.expectedScore,
    version: EXPECTED_SCORE_CALIBRATION.version,
    implementationSha256: sourceHash("expected-score", EXPECTED_SCORE_CALIBRATION),
    configuration: EXPECTED_SCORE_CALIBRATION,
    deterministic: true,
    dependencies: [
      {
        componentKey: ENGINE_COMPONENT_KEYS.objectiveEngine,
        version: engineVersionLabel(identity),
        requiredContract: "position_evaluation.v1",
      },
    ],
  });

  const tolerance = await registerComponentVersion(sql, {
    componentKey: ENGINE_COMPONENT_KEYS.tolerance,
    version: TOLERANCE_RULE.version,
    implementationSha256: sourceHash("tolerance", TOLERANCE_RULE),
    configuration: TOLERANCE_RULE,
    deterministic: true,
    dependencies: [
      {
        componentKey: ENGINE_COMPONENT_KEYS.expectedScore,
        version: EXPECTED_SCORE_CALIBRATION.version,
        requiredContract: "expected_score.v1",
      },
    ],
  });

  const selector = await registerComponentVersion(sql, {
    componentKey: ENGINE_COMPONENT_KEYS.criticalSelector,
    version: "1",
    implementationSha256: sourceHash("critical-selector", DEFAULT_CRITICAL_POSITION_POLICY),
    configuration: DEFAULT_CRITICAL_POSITION_POLICY,
    deterministic: true,
    dependencies: [
      {
        componentKey: ENGINE_COMPONENT_KEYS.tolerance,
        version: TOLERANCE_RULE.version,
        requiredContract: "transition_assessment.v1",
      },
    ],
  });

  await sql`
    insert into analysis.model_profiles (
      component_version_id, role, binary_sha256, network_hash, hardware_class,
      input_context_contract, output_interpretation_contract, licence_review_status, licence_note
    ) values (
      ${engine.id}, 'objective_engine', ${identity.binarySha256}, ${identity.networkHash},
      'cpu_engine', 'core_position.v1', 'objective_evaluation.v1', 'cleared',
      'GPL-3.0-or-later; invoked as a separate process over UCI, not linked.'
    )
    on conflict (component_version_id) do nothing
  `;

  return {
    engineProfileId: engine.id,
    engineContentHash: engine.contentHash,
    calibrationVersionId: calibration.id,
    calibrationContentHash: calibration.contentHash,
    toleranceVersionId: tolerance.id,
    selectorVersionId: selector.id,
  };
}

/** A stable digest of a frozen policy object, standing in for its source. */
function sourceHash(name: string, policy: unknown): string {
  return createHash("sha256").update(`${name}:${JSON.stringify(policy)}`).digest("hex");
}

export interface ResolvedProfile {
  modelProfileId: string;
  profileContentHash: string;
  calibrationVersionId: string;
  calibrationContentHash: string;
  spec: EngineProfileSpec;
}

/**
 * The profile and calibration a search should attribute its result to.
 *
 * Read from the database rather than assumed, because the cache key uses the
 * *registered* content hashes: a worker that computed a key from its own
 * constants while the row said something else would write entries nothing ever
 * finds again.
 */
export async function resolveProfile(
  sql: Queryable,
  input: { engineVersionId: string; calibrationVersionId: string; profile: EngineProfileKey },
): Promise<ResolvedProfile> {
  const [row] = await sql<{ engine_hash: string; calibration_hash: string }[]>`
    select engine.content_hash as engine_hash, calibration.content_hash as calibration_hash
    from analysis.component_versions engine
    join analysis.model_profiles profile on profile.component_version_id = engine.id
    join analysis.component_versions calibration on calibration.id = ${input.calibrationVersionId}
    where engine.id = ${input.engineVersionId} and profile.role = 'objective_engine'
  `;
  if (!row) throw new Error("no registered objective engine profile for that component version");
  return {
    modelProfileId: input.engineVersionId,
    profileContentHash: row.engine_hash,
    calibrationVersionId: input.calibrationVersionId,
    calibrationContentHash: row.calibration_hash,
    spec: ENGINE_PROFILES[input.profile],
  };
}

/**
 * The engine build this deployment declares it is running.
 *
 * From configuration rather than from the binary, because the process that
 * *registers* the version is the analysis planner and the process that *runs*
 * the engine is a different, less privileged deployment. The image sets these
 * when it is built; `verifyEngineMatchesProfile` is what stops the declaration
 * from being taken on trust.
 */
export function configuredEngineIdentity(): EngineIdentity {
  return {
    engineName: process.env.STOCKFISH_ENGINE_NAME ?? "Stockfish",
    engineVersion: process.env.STOCKFISH_ENGINE_VERSION ?? null,
    binarySha256: process.env.STOCKFISH_BINARY_SHA256 ?? null,
    networkHash: process.env.STOCKFISH_NETWORK_HASH ?? null,
  };
}

export interface ProfileIdentityRow {
  binarySha256: string | null;
  networkHash: string | null;
  licenceReviewStatus: string;
}

export async function readModelProfile(
  sql: Queryable,
  modelProfileId: string,
): Promise<ProfileIdentityRow | null> {
  const [row] = await sql<
    { binary_sha256: string | null; network_hash: string | null; licence_review_status: string }[]
  >`
    select binary_sha256, network_hash, licence_review_status
    from analysis.model_profiles where component_version_id = ${modelProfileId}
  `;
  return row
    ? {
        binarySha256: row.binary_sha256,
        networkHash: row.network_hash,
        licenceReviewStatus: row.licence_review_status,
      }
    : null;
}

/**
 * Refuse to write results under a profile this process is not actually running.
 *
 * The worker is told which profile to attribute its output to; it is not told
 * what binary it has. If those disagree, every row it writes would be a false
 * provenance claim and would poison a cache other players read. The mismatch is
 * `unsupported` rather than transient: retrying the same message on the same
 * image fails identically, and an operator needs to see the routing or image
 * mistake rather than five more attempts.
 *
 * A null hash on either side means "not known here" and does not fail: a
 * deployment that cannot hash its binary is a weaker provenance claim, not a
 * false one, and `binary_sha256 is null` on the profile records exactly that.
 */
export function engineProfileMismatch(
  live: EngineIdentity,
  profile: ProfileIdentityRow,
): string | null {
  if (profile.licenceReviewStatus !== "cleared") {
    return `profile licence review is ${profile.licenceReviewStatus}`;
  }
  if (
    profile.binarySha256 != null &&
    live.binarySha256 != null &&
    profile.binarySha256 !== live.binarySha256
  ) {
    return "engine binary hash does not match the profile";
  }
  if (
    profile.networkHash != null &&
    live.networkHash != null &&
    profile.networkHash !== live.networkHash
  ) {
    return "engine network hash does not match the profile";
  }
  return null;
}

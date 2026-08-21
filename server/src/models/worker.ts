import type { Sql } from "postgres";

import { registerHandler, type WorkContext, type WorkResult } from "../ops/handlers.js";
import { WorkFailure } from "../ops/retry.js";
import { withActor } from "../db/actor.js";
import { MaiaEngine, type MaiaNetwork } from "./maia.js";
import { Maia3Engine } from "./maia3.js";
import { computePracticalContext, type HumanPolicyEngine } from "./practical-context.js";
import { recordModelsEvent } from "./telemetry.js";
import {
  CONTINUATION_RATING_MAX,
  CONTINUATION_RATING_MIN,
  CONTINUATION_TASK,
  resolveContinuationEngine,
  storeContinuationPolicy,
} from "./continuation.js";

/**
 * The practical-context step of a game analysis.
 *
 * It runs on `cpu_model`, which E05 gave to `forma-analysis` with the
 * `model_inference` capability — the human model is not an engine and does not
 * belong on the deployment that owns Stockfish. No topology change was needed
 * for this, which is the point of having written the table down.
 */

export const PRACTICAL_TASK = "analysis_practical_context";

let engineFactory: (() => HumanPolicyEngine | null) | null = null;
const resolvedPolicyEngines = new Map<string, HumanPolicyEngine | null>();

/** Replace the policy engine, for gates. */
export function setHumanPolicyEngineFactory(factory: () => HumanPolicyEngine | null): void {
  engineFactory = factory;
  resolvedPolicyEngines.clear();
}

/**
 * The configured Maia engine, or null.
 *
 * Null when the deployment does not carry the binary and the weights. That is a
 * deliberate, visible state rather than a crash: every position it touches
 * becomes `inference_failed`, the run still succeeds, and the objective review
 * is unaffected — which is exactly the behaviour delivery plan E14 requires of
 * a human layer that is not there.
 */
export function resolveHumanPolicyEngine(family: "maia1" | "maia3" = "maia1"): HumanPolicyEngine | null {
  if (resolvedPolicyEngines.has(family)) return resolvedPolicyEngines.get(family) ?? null;
  if (engineFactory) {
    const engine = engineFactory();
    resolvedPolicyEngines.set(family, engine);
    return engine;
  }
  if (family === "maia3") {
    const pythonPath = process.env.MAIA3_PYTHON_PATH;
    const bridgePath = process.env.MAIA3_BRIDGE_PATH;
    const checkpointPath = process.env.MAIA3_CHECKPOINT_PATH;
    const engine = pythonPath && bridgePath && checkpointPath
      ? new Maia3Engine({ pythonPath, bridgePath, checkpointPath })
      : null;
    resolvedPolicyEngines.set(family, engine);
    return engine;
  }
  const enginePath = process.env.MAIA_ENGINE_PATH;
  const weightsSpec = process.env.MAIA_WEIGHTS;
  if (!enginePath || !weightsSpec) {
    resolvedPolicyEngines.set(family, null);
    return null;
  }
  const networks: MaiaNetwork[] = [];
  for (const entry of weightsSpec.split(",")) {
    const [band, weightsPath] = entry.split("=");
    if (!band || !weightsPath) continue;
    const parsed = Number(band);
    if (Number.isFinite(parsed)) networks.push({ band: parsed, weightsPath });
  }
  if (networks.length === 0) {
    resolvedPolicyEngines.set(family, null);
    return null;
  }
  const engine = new MaiaEngine({ enginePath, networks });
  resolvedPolicyEngines.set(family, engine);
  return engine;
}

interface Payload {
  runId?: unknown;
}

interface ContinuationPayload {
  corePositionId?: unknown;
  halfmoveClock?: unknown;
  rating?: unknown;
  modelComponentVersionId?: unknown;
  cacheKey?: unknown;
}

export async function writeContinuationPolicy(
  context: WorkContext,
  sql: Sql,
): Promise<WorkResult> {
  const payload = context.item.payload as ContinuationPayload;
  const corePositionId = typeof payload.corePositionId === "string" ? payload.corePositionId : null;
  const halfmoveClock = typeof payload.halfmoveClock === "number" ? payload.halfmoveClock : null;
  const rating = typeof payload.rating === "number" ? payload.rating : null;
  const modelComponentVersionId =
    typeof payload.modelComponentVersionId === "string" ? payload.modelComponentVersionId : null;
  const cacheKey = typeof payload.cacheKey === "string" ? payload.cacheKey : null;
  if (
    corePositionId === null ||
    halfmoveClock === null ||
    !Number.isInteger(halfmoveClock) ||
    halfmoveClock < 0 ||
    rating === null ||
    !Number.isInteger(rating) ||
    rating < CONTINUATION_RATING_MIN ||
    rating > CONTINUATION_RATING_MAX ||
    modelComponentVersionId === null ||
    cacheKey === null ||
    !/^[0-9a-f]{64}$/.test(cacheKey)
  ) {
    throw new WorkFailure("invalid_input", "invalid_continuation_payload", "invalid continuation input");
  }

  const [position] = await sql<{ core_key: string }[]>`
    select core_key from chess.core_positions where id = ${corePositionId}::bigint
  `;
  if (!position) {
    throw new WorkFailure("invalid_input", "unknown_position", "no such core position");
  }
  const [model] = await sql<{ family: string | null }[]>`
    select coalesce(
      cv.model_identity ->> 'family',
      ((cv.model_identity #>> '{}')::jsonb) ->> 'family'
    ) as family
    from analysis.component_versions cv
    join analysis.model_profiles p on p.component_version_id = cv.id
    where cv.id = ${modelComponentVersionId}
      and p.role = 'human_policy' and p.licence_review_status = 'cleared'
  `;
  if (model?.family !== "maia3") {
    throw new WorkFailure("unsupported", "maia3_model_unavailable", "the selected Maia-3 model is unavailable");
  }

  const existing = await sql<{ id: string }[]>`
    select id from analysis.model_inferences
    where model_component_version_id = ${modelComponentVersionId} and cache_key = ${cacheKey}
  `;
  if (existing[0]) {
    return {
      outputRef: `modelInference:${existing[0].id}`,
      outputSummary: { reused: true },
      metrics: { inputCount: 1, outputCount: 1 },
    };
  }

  const engine = resolveContinuationEngine();
  if (!engine) {
    throw new WorkFailure("permanent", "maia3_runtime_unavailable", "Maia-3 is not configured");
  }
  const fen = `${position.core_key} ${halfmoveClock} 1`;
  let inference;
  try {
    inference = await engine.inferPolicy(fen, rating);
  } catch {
    throw new WorkFailure("transient", "maia3_inference_failed", "Maia-3 inference failed");
  }
  const inferenceId = await storeContinuationPolicy(sql, {
    modelComponentVersionId,
    corePositionId,
    rating,
    cacheKey,
    policy: inference.policy,
    latencyMs: inference.latencyMs,
  });
  return {
    outputRef: `modelInference:${inferenceId}`,
    outputSummary: { reused: false, rating, moveCount: inference.policy.moves.length },
    metrics: { inputCount: 1, outputCount: 1 },
  };
}

/**
 * Write practical context for every assessment of one run.
 *
 * The payload carries the run and nothing else, matching E12's assessment step:
 * the materialization, the game and the model are resolved from the run, so a
 * work item never carries a position, a rating or a subject into the ledger.
 */
export async function writePracticalContext(
  context: WorkContext,
  sql: Sql,
): Promise<WorkResult> {
  const payload = context.item.payload as Payload;
  const runId = typeof payload.runId === "string" ? payload.runId : null;
  if (runId === null) {
    throw new WorkFailure("invalid_input", "invalid_payload", "the payload names no run");
  }

  // The owner is resolved before anything reads a tenant table, not after.
  // `ops.workflows` is role-scoped so it can be read unbound; `analysis.runs`
  // is not, and reading it anonymously returned no row -- reported as
  // `unknown_run`, "no such analysis run", for a run that had just been written
  // three steps earlier. The compute below was already bound; the lookup that
  // decides whether to reach it was not.
  const [workflow] = await sql<{ owner_profile_id: string | null }[]>`
    select owner_profile_id from ops.workflows where id = ${context.item.workflowId}
  `;
  if (!workflow?.owner_profile_id) {
    throw new WorkFailure("invalid_input", "unowned_workflow", "the workflow names no owner");
  }
  const ownerProfileId = workflow.owner_profile_id;

  const [run] = await withActor(sql, ownerProfileId, (tx) =>
    tx<{ subject_game_id: string | null; replay_revision_id: string | null }[]>`
      select subject_game_id, replay_revision_id from analysis.runs where id = ${runId}
    `,
  );
  if (!run?.subject_game_id) {
    throw new WorkFailure("invalid_input", "unknown_run", "no such analysis run");
  }

  const [materialization] = await sql<{ id: string }[]>`
    select run_id as id from chess.replay_materialization_publication_history
    where replay_revision_id = ${run.replay_revision_id}
    order by id desc limit 1
  `;
  if (!materialization) {
    throw new WorkFailure("invalid_input", "no_published_materialization", "nothing to read");
  }

  const [model] = await sql<{ content_hash: string; family: string | null }[]>`
    select cv.content_hash, coalesce(
      cv.model_identity ->> 'family',
      ((cv.model_identity #>> '{}')::jsonb) ->> 'family'
    ) as family
    from analysis.component_versions cv
    join analysis.model_profiles p on p.component_version_id = cv.id
    join lateral (
      select e.to_state from analysis.component_lifecycle_events e
      where e.component_version_id = cv.id order by e.id desc limit 1
    ) lifecycle on true
    where p.role = 'human_policy' and p.licence_review_status = 'cleared'
      and lifecycle.to_state = 'production'
    order by cv.created_at desc, cv.id desc limit 1
  `;

  // The actor comes from the workflow the API created, never from the payload,
  // so the forced owner policies apply on the real worker path exactly as they
  // do in E12's assessment step.
  const engine = model?.family === "maia3"
    ? resolveHumanPolicyEngine("maia3")
    : resolveHumanPolicyEngine("maia1");
  const summary = await withActor(sql, ownerProfileId, (tx) =>
    computePracticalContext(tx, engine, {
      runId,
      materializationRunId: materialization.id,
      subjectGameId: run.subject_game_id!,
      modelContentHash: model?.content_hash ?? "none",
    }),
  );

  recordModelsEvent({
    event: "practical_context_written",
    traceId: context.traceId,
    runId,
    written: summary.written,
    available: summary.available,
    unavailableReasons: Object.keys(summary.unavailable).sort().join(","),
    inferencesComputed: summary.inferencesComputed,
    inferencesReused: summary.inferencesReused,
  });

  return {
    outputRef: `run:${runId}`,
    outputSummary: {
      written: summary.written,
      available: summary.available,
      unavailable: summary.unavailable,
    },
    metrics: { inputCount: summary.written, outputCount: summary.written },
  };
}

/**
 * The runtime connection, resolved lazily.
 *
 * `db/client.js` refuses to load without a database identity (E01), so an
 * offline gate that only wants the handler function must not pull it in at
 * import time.
 */
async function runtimeSql(): Promise<Sql> {
  const { client } = await import("../db/client.js");
  return client as unknown as Sql;
}

let practicalRegistered = false;
let continuationRegistered = false;

export function registerContinuationHandlers(): void {
  if (continuationRegistered) return;
  continuationRegistered = true;
  registerHandler(CONTINUATION_TASK, async (context) =>
    writeContinuationPolicy(context, await runtimeSql()),
  );
}

export function registerModelHandlers(): void {
  if (practicalRegistered) return;
  practicalRegistered = true;
  registerHandler(PRACTICAL_TASK, async (context) =>
    writePracticalContext(context, await runtimeSql()),
  );
}

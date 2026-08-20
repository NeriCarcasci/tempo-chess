import type { Sql } from "postgres";

import { registerHandler, type WorkContext, type WorkResult } from "../ops/handlers.js";
import { WorkFailure } from "../ops/retry.js";
import { withActor } from "../db/actor.js";
import { MaiaEngine, type MaiaNetwork } from "./maia.js";
import { computePracticalContext, type HumanPolicyEngine } from "./practical-context.js";
import { recordModelsEvent } from "./telemetry.js";

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

/** Replace the policy engine, for gates. */
export function setHumanPolicyEngineFactory(factory: () => HumanPolicyEngine | null): void {
  engineFactory = factory;
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
export function resolveHumanPolicyEngine(): HumanPolicyEngine | null {
  if (engineFactory) return engineFactory();
  const enginePath = process.env.MAIA_ENGINE_PATH;
  const weightsSpec = process.env.MAIA_WEIGHTS;
  if (!enginePath || !weightsSpec) return null;
  const networks: MaiaNetwork[] = [];
  for (const entry of weightsSpec.split(",")) {
    const [band, weightsPath] = entry.split("=");
    if (!band || !weightsPath) continue;
    const parsed = Number(band);
    if (Number.isFinite(parsed)) networks.push({ band: parsed, weightsPath });
  }
  if (networks.length === 0) return null;
  return new MaiaEngine({ enginePath, networks });
}

interface Payload {
  runId?: unknown;
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

  const [model] = await sql<{ content_hash: string }[]>`
    select cv.content_hash from analysis.component_versions cv
    join analysis.model_profiles p on p.component_version_id = cv.id
    where p.role = 'human_policy' and p.licence_review_status = 'cleared'
    order by cv.created_at desc limit 1
  `;

  // The actor comes from the workflow the API created, never from the payload,
  // so the forced owner policies apply on the real worker path exactly as they
  // do in E12's assessment step.
  const engine = resolveHumanPolicyEngine();
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

let registered = false;

export function registerModelHandlers(): void {
  if (registered) return;
  registered = true;
  registerHandler(PRACTICAL_TASK, async (context) =>
    writePracticalContext(context, await runtimeSql()),
  );
}

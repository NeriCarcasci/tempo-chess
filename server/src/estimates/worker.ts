import { createHash } from "node:crypto";

import type { Sql } from "postgres";

import { registerHandler, type WorkContext, type WorkResult } from "../ops/handlers.js";
import { WorkFailure } from "../ops/retry.js";
import { withActor } from "../db/actor.js";
import { completeRun, recordArtifact, startRun } from "../analysis/runs.js";
import { publishSubjectLive } from "../analysis/publication.js";
import { ENGINE_COMPONENT_KEYS } from "../engine/contract.js";
import { aggregateSubjectReport } from "./aggregate.js";
import { registerEstimateComponents } from "./store.js";
import { recordEstimatesEvent } from "./telemetry.js";

/**
 * The subject-report step.
 *
 * One run produces estimates, the trajectory and the findings, and then asks
 * E11 to move the live pointer. Publication is the last thing that happens and
 * is refused unless the run's manifest is complete, so a half-built report
 * cannot become the page a user sees.
 */

export const SUBJECT_REPORT_TASK = "analysis_subject_report";

/** The artifact families a subject-live run must produce to be publishable. */
export const SUBJECT_REPORT_FAMILIES = [
  "skill_estimates",
  "trajectory_bins",
  "findings",
] as const;

interface Payload {
  runId?: unknown;
}

export async function buildSubjectReport(
  context: WorkContext,
  sql: Sql,
): Promise<WorkResult> {
  const payload = context.item.payload as Payload;
  const runId = typeof payload.runId === "string" ? payload.runId : null;
  if (runId === null) {
    throw new WorkFailure("invalid_input", "invalid_payload", "the payload names no run");
  }

  const [workflow] = await sql<{ owner_profile_id: string | null }[]>`
    select owner_profile_id from ops.workflows where id = ${context.item.workflowId}
  `;
  if (!workflow?.owner_profile_id) {
    throw new WorkFailure("invalid_input", "unowned_workflow", "the workflow names no owner");
  }

  const startedAt = Date.now();
  // Component registration is outside the actor transaction: it writes to the
  // shared catalogue, which is not subject-scoped, and doing it inside would
  // make every report's first statement a write to a table other subjects
  // share.
  const versions = await registerEstimateComponents(sql);

  const summary = await withActor(sql, workflow.owner_profile_id, async (tx) => {
    const [run] = await tx<
      { subject_id: string; subject_data_snapshot_id: string | null; status: string }[]
    >`
      select subject_id, subject_data_snapshot_id, status from analysis.runs
      where id = ${runId}
    `;
    if (!run) throw new WorkFailure("invalid_input", "unknown_run", "no such analysis run");
    if (!run.subject_data_snapshot_id) {
      throw new WorkFailure(
        "invalid_input",
        "no_frozen_snapshot",
        "a subject report needs a frozen snapshot to read",
      );
    }
    if (run.status === "succeeded") {
      // A duplicate delivery after the run completed. Recomputing would be
      // refused by the immutability triggers anyway; acknowledging is honest.
      return null;
    }

    await startRun(tx, runId);

    // The expected-score calibration belongs to E12 and must already exist: a
    // trajectory drawn from scores calibrated by an unknown version is a curve
    // nobody can reproduce.
    const [calibration] = await tx<{ id: string }[]>`
      select cv.id from analysis.component_versions cv
      join analysis.components c on c.id = cv.component_id
      where c.component_key = ${ENGINE_COMPONENT_KEYS.expectedScore}
      order by cv.created_at desc limit 1
    `;
    if (!calibration) {
      throw new WorkFailure(
        "invalid_input",
        "missing_upstream_versions",
        "the expected-score calibration a trajectory is attributed to is not registered",
      );
    }

    const result = await aggregateSubjectReport(tx, {
      analysisRunId: runId,
      subjectId: run.subject_id,
      subjectDataSnapshotId: run.subject_data_snapshot_id,
      versions,
      phaseComponentVersionId: versions.phaseVersionId,
      expectedScoreCalibrationVersionId: calibration.id,
      cutoff: new Date(),
    });

    // The manifest is what publication checks. A checksum over the counts is
    // enough to make a rerun that produced different output detectable, and it
    // does not require hashing every row a second time.
    for (const family of SUBJECT_REPORT_FAMILIES) {
      const count =
        family === "skill_estimates"
          ? result.estimates
          : family === "trajectory_bins"
            ? result.trajectoryBins
            : result.findingsPublished;
      await recordArtifact(tx, runId, {
        family,
        count,
        checksum: createHash("sha256").update(`${runId}:${family}:${count}`).digest("hex"),
      });
    }
    return result;
  });

  if (summary === null) {
    return { outputRef: `run:${runId}`, outputSummary: { duplicate: true } };
  }

  await completeRun(sql, runId);
  const publication = await publishSubjectLive(sql, {
    runId,
    reason: "new_run",
    actor: { kind: "system" },
    traceId: context.traceId,
  });
  if (!publication.published && publication.refusedCode !== "ALREADY_PUBLISHED") {
    throw new WorkFailure("permanent", "publication_refused", publication.refusedCode ?? "unknown");
  }

  recordEstimatesEvent({
    event: "subject_report_built",
    traceId: context.traceId,
    runId,
    estimates: summary.estimates,
    unavailableEstimates: summary.unavailableEstimates,
    trajectoryBins: summary.trajectoryBins,
    findingsPublished: summary.findingsPublished,
    findingsWithheld: summary.findingsWithheld,
    explanationsHeld: summary.explanationsHeld,
    includedGames: summary.includedGames,
    durationMs: Date.now() - startedAt,
  });

  return {
    outputRef: `run:${runId}`,
    outputSummary: {
      estimates: summary.estimates,
      findings: summary.findingsPublished,
      trajectoryBins: summary.trajectoryBins,
      publicationId: publication.publicationId,
    },
    metrics: {
      inputCount: summary.includedGames,
      outputCount: summary.estimates + summary.findingsPublished,
      computeMs: Date.now() - startedAt,
    },
  };
}

let registered = false;

export function registerEstimateHandlers(): void {
  if (registered) return;
  registered = true;
  registerHandler(SUBJECT_REPORT_TASK, async (context) =>
    buildSubjectReport(context, await runtimeSql()),
  );
}

/**
 * The runtime connection, resolved lazily.
 *
 * `db/client.js` gates the connection at module load (E01), so an offline gate
 * that only wants the handler function must not pull it in at import time.
 */
async function runtimeSql(): Promise<Sql> {
  const { client } = await import("../db/client.js");
  return client as unknown as Sql;
}

import { planPendingWork } from "../analysis/planner.js";
import { planStaleProgress } from "../goals/progress-worker.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ProblemError } from "../v1/problem.js";
import type { RouteDefinition } from "../v1/registry.js";
import { LEASE_RECOVERY_BATCH, OUTBOX_DISPATCH_BATCH } from "../ops/contract.js";
import { dispatchOutbox, outboxHealth, readyWorkDepth } from "../ops/dispatch.js";
import { executeWorkItem } from "../ops/executor.js";
import { allowedTaskTypes } from "../ops/handlers.js";
import { recoverExpiredLeases } from "../ops/ledger.js";
import { recordOpsEvent } from "../ops/telemetry.js";
import { taskTransport } from "../ops/tasks.js";
import { client } from "../db/client.js";

/**
 * `/internal/v1`, per plans/v1-api-contract.md §15.
 *
 * Private ingress, Google OIDC, service-account allowlists, no browser CORS.
 * They are declared through the same registry as `/v1` so they inherit the
 * kernel's identifiers, validation, problem details and structured logging —
 * an internal endpoint that answered with a stack trace would be exactly as bad
 * as a public one that did.
 *
 * They are not in the OpenAPI document. §15 is a contract between our own
 * deployments; publishing it in the document a browser client generates from
 * would be advertising the surface that has no browser authentication.
 */

/** This process's worker identity. Unique per instance: it becomes the lease owner. */
const WORKER = {
  deployment: process.env.K_SERVICE ?? "forma-local-worker",
  revision: process.env.K_REVISION ?? null,
  instance: `${process.pid}-${randomUUID().slice(0, 8)}`,
};

const executeBody = z.object({
  /** Proves which dispatch this delivery is for. Not authentication. */
  attemptToken: z.string().min(16).max(256),
  traceparent: z.string().max(200).optional(),
});

const executeRoute: RouteDefinition<never, z.infer<typeof executeBody>, null> = {
  method: "POST",
  path: "/internal/v1/work-items/:workItemId/execute",
  operationId: "executeWorkItem",
  summary: "Shared worker entry point",
  kind: "command",
  auth: "internal",
  surface: "internal",
  serviceRole: "worker",
  // The duplicate this transport will eventually deliver is stopped by the
  // conditional claim in `ops.work_items`, not by a header Cloud Tasks has no
  // way to supply.
  idempotency: "ledger",
  envelope: "raw",
  successStatus: 204,
  bodySchema: executeBody,
  async handler({ body, params, traceId }) {
    const workItemId = params.workItemId;
    if (!/^\d{1,19}$/.test(workItemId)) {
      // Never "not found": an internal caller that cannot form an identifier is
      // a bug in the dispatcher, and 404 would send an operator hunting for a
      // deleted row instead.
      throw new ProblemError("VALIDATION_FAILED", {
        detail: "workItemId must be a work item identity.",
        errors: [{ path: "path.workItemId", code: "MALFORMED", message: "not a work item id" }],
      });
    }

    const startedAt = performance.now();
    const outcome = await executeWorkItem({
      workItemId,
      attemptToken: body.attemptToken,
      worker: WORKER,
      traceId,
    });

    recordOpsEvent({
      event: "work_item_transition",
      traceId,
      workItemId,
      workflowId: "",
      taskType: "",
      resourceClass: "",
      from: "leased",
      to: outcome.status,
      attempt: 0,
      maxAttempts: 0,
      retryClass: outcome.status === "failed" ? outcome.retryClass : null,
      errorCode: outcome.status === "noop" ? outcome.reason : null,
      durationMs: Math.round(performance.now() - startedAt),
      duplicateDelivery:
        outcome.status === "noop" &&
        (outcome.reason === "already_leased" ||
          outcome.reason === "terminal" ||
          outcome.reason === "stale_attempt"),
    });

    if (outcome.status === "retry_later") {
      throw new ProblemError("WORK_NOT_READY", { retryAfterSeconds: outcome.afterSeconds });
    }
    // Everything else has committed an authoritative transition, or established
    // that there is none to make. Only now is the delivery acknowledged.
    return { data: null, status: 204 };
  },
};

const dispatchReportSchema = z.object({
  claimed: z.number().int(),
  published: z.number().int(),
  duplicates: z.number().int(),
  superseded: z.number().int(),
  retrying: z.number().int(),
  deadLettered: z.number().int(),
  pending: z.number().int(),
  oldestPendingAgeSeconds: z.number().int().nullable(),
});

const dispatchRoute: RouteDefinition<never, Record<string, never>, z.infer<typeof dispatchReportSchema>> = {
  method: "POST",
  path: "/internal/v1/outbox/dispatch",
  operationId: "dispatchOutbox",
  summary: "Drain committed outbox rows into Cloud Tasks",
  kind: "command",
  auth: "internal",
  surface: "internal",
  serviceRole: "ops",
  idempotency: "ledger",
  envelope: "resource",
  successStatus: 200,
  bodySchema: z.object({}).strict(),
  dataSchema: dispatchReportSchema,
  async handler({ traceId }) {
    const built = taskTransport();
    if ("findings" in built) {
      // Refusing is the honest answer. A dispatcher that "succeeded" while
      // sending nothing would mark rows published that no queue ever received.
      throw new ProblemError("PROVIDER_UNAVAILABLE", {
        detail: "Task dispatch is not configured on this deployment.",
      });
    }
    const startedAt = performance.now();
    const report = await dispatchOutbox(built.transport, OUTBOX_DISPATCH_BATCH);
    const health = await outboxHealth();
    // §19's "queue depth and oldest ready-item age by class". Emitted on the
    // dispatch pass because that is the one scheduled job that already looks at
    // the whole ledger, so the signal costs nothing extra to produce.
    for (const depth of await readyWorkDepth()) {
      recordOpsEvent({ event: "work_depth", traceId, ...depth });
    }
    recordOpsEvent({
      event: "outbox_dispatch",
      traceId,
      ...report,
      pending: health.pending,
      oldestPendingAgeSeconds: health.oldestPendingAgeSeconds,
      durationMs: Math.round(performance.now() - startedAt),
    });
    return {
      data: {
        ...report,
        pending: health.pending,
        oldestPendingAgeSeconds: health.oldestPendingAgeSeconds,
      },
    };
  },
};

const recoveryReportSchema = z.object({
  examined: z.number().int(),
  reconciledSucceeded: z.number().int(),
  requeued: z.number().int(),
  deadLettered: z.number().int(),
});

const recoverLeasesRoute: RouteDefinition<never, Record<string, never>, z.infer<typeof recoveryReportSchema>> = {
  method: "POST",
  path: "/internal/v1/work-items/recover-leases",
  operationId: "recoverLeases",
  summary: "Reconcile and requeue work whose lease expired",
  kind: "command",
  auth: "internal",
  surface: "internal",
  serviceRole: "ops",
  idempotency: "ledger",
  envelope: "resource",
  successStatus: 200,
  bodySchema: z.object({}).strict(),
  dataSchema: recoveryReportSchema,
  async handler({ traceId }) {
    const startedAt = performance.now();
    const report = await recoverExpiredLeases(LEASE_RECOVERY_BATCH);
    recordOpsEvent({
      event: "lease_recovery",
      traceId,
      ...report,
      durationMs: Math.round(performance.now() - startedAt),
    });
    return { data: report };
  },
};

const sweepSchema = z.object({
  materializations: z.number().int(),
  analyses: z.number().int(),
  alreadyPlanned: z.number().int(),
  progressReadings: z.number().int(),
});

/**
 * The sweep that moves the pipeline forward.
 *
 * Everything before this endpoint existed and nothing connected it: a synced
 * game was never materialized, a materialized game was never analysed, and a
 * goal was never re-measured when new evidence landed. The reason it is a sweep
 * on the ops deployment rather than a step inside each worker is E04's grant:
 * only `forma_api` and `forma_ops` may create work, because a worker that can
 * create work can create unbounded work.
 *
 * Bounded, idempotent and safe to run every few minutes. A sweep that finds
 * nothing to do is the normal case.
 */
const sweepRoute: RouteDefinition<never, Record<string, never>, z.infer<typeof sweepSchema>> = {
  method: "POST",
  path: "/internal/v1/work/sweep",
  operationId: "sweepPendingWork",
  summary: "Plan materialization, analysis and progress that nothing has planned yet",
  kind: "command",
  auth: "internal",
  surface: "internal",
  serviceRole: "ops",
  idempotency: "ledger",
  envelope: "resource",
  successStatus: 200,
  bodySchema: z.object({}).strict(),
  dataSchema: sweepSchema,
  async handler({ traceId }) {
    const startedAt = performance.now();
    const work = await planPendingWork(client, {});
    const progress = await planStaleProgress(client, {});
    recordOpsEvent({
      event: "work_sweep",
      traceId,
      materializations: work.materializations,
      analyses: work.analyses,
      progressReadings: progress.queued,
      durationMs: Math.round(performance.now() - startedAt),
    });
    return {
      data: {
        materializations: work.materializations,
        analyses: work.analyses,
        alreadyPlanned: work.skipped,
        progressReadings: progress.queued,
      },
    };
  },
};

const readySchema = z.object({
  ready: z.boolean(),
  database: z.enum(["ok", "unavailable"]),
  dispatch: z.enum(["configured", "unconfigured"]),
  handlers: z.array(z.string()),
});

const readyRoute: RouteDefinition<never, never, z.infer<typeof readySchema>> = {
  method: "GET",
  path: "/internal/v1/ready",
  operationId: "internalReady",
  summary: "Private readiness with dependency checks",
  kind: "read",
  auth: "internal",
  surface: "internal",
  serviceRole: "any",
  envelope: "resource",
  successStatus: 200,
  dataSchema: readySchema,
  cacheControl: "no-store",
  async handler() {
    let database: "ok" | "unavailable" = "ok";
    try {
      await client`select 1`;
    } catch {
      database = "unavailable";
    }
    const dispatch = "findings" in taskTransport() ? "unconfigured" : "configured";
    return {
      data: {
        // A readiness probe reports readiness; it does not decide that an
        // unconfigured dispatcher is acceptable. That judgement is the
        // deployment's, and it needs the detail to make it.
        ready: database === "ok",
        database,
        dispatch,
        handlers: allowedTaskTypes(),
      },
    };
  },
};

export const INTERNAL_ROUTES: readonly RouteDefinition<never, never, never>[] = [
  executeRoute,
  dispatchRoute,
  recoverLeasesRoute,
  readyRoute,
  sweepRoute,
] as unknown as readonly RouteDefinition<never, never, never>[];

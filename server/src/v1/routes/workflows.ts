import { z } from "zod";
import { recordAuditEvent } from "../audit.js";
import { decodeCursor, encodeCursor, resolveLimit, type CursorScope } from "../cursor.js";
import { ProblemError } from "../problem.js";
import { routeKey, type RouteDefinition } from "../registry.js";
import { WORKFLOW_KINDS, WORKFLOW_STATES } from "../../ops/contract.js";
import { listWorkflows, readWorkflow, requestCancellation, type WorkflowRecord } from "../../ops/ledger.js";
import { requestLegacyImportCancellation } from "../../ops/legacy-shadow.js";

/**
 * `/v1/workflows`, per plans/v1-api-contract.md §§2.1 and 6.
 *
 * The three endpoints the contract names, and nothing else. In particular there
 * is no endpoint that exposes work items, attempts, payloads or lease state:
 * §16 of the platform spec says no endpoint mirrors raw internal tables, and
 * the operator diagnostic those rows exist for is read through the internal
 * surface, not by the owner's browser.
 *
 * Ownership is not a filter a handler remembers to apply. `readWorkflow` and
 * `listWorkflows` take the owner as an argument and have no overload that
 * omits it, so a workflow belonging to someone else is indistinguishable from
 * one that does not exist — which is what stops an identifier being probed.
 */

const progressSchema = z.object({
  completedWeight: z.number().int(),
  totalWeight: z.number().int(),
  /** Null until the total is known, per §2.1. Not zero: that would be a claim. */
  percent: z.number().int().nullable(),
  stage: z.string().nullable(),
  message: z.string().nullable(),
});

const workflowSchema = z.object({
  id: z.string(),
  kind: z.enum(WORKFLOW_KINDS),
  state: z.enum(WORKFLOW_STATES),
  progress: progressSchema,
  resource: z.object({ type: z.string(), id: z.string() }).nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  cancellable: z.boolean(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  updatedAt: z.string(),
});

type Workflow = z.infer<typeof workflowSchema>;

/**
 * `message` is null rather than invented.
 *
 * §2.1 gives progress a human `message`, and E04 has no copy to put in it: the
 * stage is the task type of the oldest outstanding item, which is a fact, and a
 * sentence describing it would be one this epic made up. A truthful null is the
 * contract's own answer for "not known".
 */
function toWire(record: WorkflowRecord): Workflow {
  return {
    id: record.id,
    kind: record.kind,
    state: record.state,
    progress: {
      completedWeight: record.progress.completedWeight,
      totalWeight: record.progress.totalWeight,
      percent: record.progress.percent,
      stage: record.progress.stage,
      message: null,
    },
    resource: record.resource,
    error: record.error,
    cancellable: record.cancellable,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    updatedAt: record.updatedAt,
  };
}

const listQuery = z.object({
  state: z.enum(WORKFLOW_STATES).optional(),
  kind: z.enum(WORKFLOW_KINDS).optional(),
  cursor: z.string().max(2_048).optional(),
  limit: z.string().max(4).optional(),
});

const WORKFLOW_ID = z.uuid();

/** A malformed id is a validation failure; a valid id you do not own is a 404. */
function workflowIdOf(params: Record<string, string>): string {
  const parsed = WORKFLOW_ID.safeParse(params.workflowId);
  if (!parsed.success) {
    throw new ProblemError("NOT_FOUND", { detail: "No such workflow." });
  }
  return parsed.data;
}

const listWorkflowsRoute: RouteDefinition<z.infer<typeof listQuery>, never, Workflow[]> = {
  method: "GET",
  path: "/v1/workflows",
  operationId: "listWorkflows",
  summary: "Durable operations owned by the signed-in account",
  description:
    "Keyset paginated, newest first. Only workflows owned by the caller are visible; there is no parameter that selects another owner.",
  kind: "read",
  auth: "required",
  envelope: "collection",
  successStatus: 200,
  querySchema: listQuery,
  dataSchema: z.array(workflowSchema),
  // Private and uncached: a workflow list is per-account and changes while the
  // caller is looking at it, so a shared cache must never hold it and a private
  // one has nothing useful to keep.
  cacheControl: "private, no-store",
  async handler({ query, auth }) {
    const owner = auth!.profileId;
    const limit = resolveLimit(query.limit);
    const scope: CursorScope = {
      routeKey: routeKey(listWorkflowsRoute),
      sortKey: "createdAt:id",
      filters: { state: query.state ?? null, kind: query.kind ?? null },
    };
    const anchor = query.cursor ? decodeCursor(query.cursor, scope).a : null;

    // One extra row is the cheapest honest answer to "is there another page":
    // a `hasMore` derived from a count is a second query that can disagree with
    // the first.
    const rows = await listWorkflows({
      ownerProfileId: owner,
      state: query.state ?? null,
      kind: query.kind ?? null,
      after: anchor ? { createdAt: String(anchor[0]), id: String(anchor[1]) } : null,
      limit: limit + 1,
    });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      data: page.map(toWire),
      page: {
        hasMore,
        nextCursor: hasMore && last ? encodeCursor(scope, [last.createdAt, last.id]) : null,
      },
    };
  },
};

const getWorkflowRoute: RouteDefinition<never, never, Workflow> = {
  method: "GET",
  path: "/v1/workflows/:workflowId",
  operationId: "getWorkflow",
  summary: "One durable operation",
  kind: "read",
  auth: "required",
  envelope: "resource",
  successStatus: 200,
  dataSchema: workflowSchema,
  // ETagged and revalidated rather than uncached. A client watching a workflow
  // polls this endpoint, and most polls find nothing changed — `must-revalidate`
  // with an ETag turns those into a 304 instead of a full body, without ever
  // serving a stale state.
  etag: true,
  cacheControl: "private, max-age=0, must-revalidate",
  async handler({ auth, params, requestId, traceId }) {
    const workflowId = workflowIdOf(params);
    const record = await readWorkflow(workflowId, auth!.profileId);
    if (!record) {
      // Audited because "someone asked for a workflow that is not theirs" is
      // exactly the signal an incident review needs, and the 404 deliberately
      // does not carry it to the caller.
      await recordAuditEvent({
        actorKind: "user",
        actorRef: auth!.profileId,
        action: "workflow.access_denied",
        targetType: "workflow",
        targetRef: workflowId,
        requestId,
        traceId,
        result: "denied",
        reasonCode: "not_owned_or_absent",
      });
      throw new ProblemError("NOT_FOUND", { detail: "No such workflow." });
    }
    return { data: toWire(record) };
  },
};

const cancelWorkflowRoute: RouteDefinition<never, Record<string, never>, Workflow> = {
  method: "POST",
  path: "/v1/workflows/:workflowId/cancel",
  operationId: "cancelWorkflow",
  summary: "Ask a durable operation to stop",
  description:
    "Returns 202 while cancellation drains, or 409 when the workflow already finished. Cancellation does not undo work that has already been published.",
  kind: "command",
  auth: "required",
  envelope: "resource",
  successStatus: 202,
  bodySchema: z.object({}).strict(),
  dataSchema: workflowSchema,
  async handler({ auth, params, requestId, traceId }) {
    const workflowId = workflowIdOf(params);
    const result = await requestCancellation(workflowId, auth!.profileId);
    if (result.outcome === "not_found") {
      await recordAuditEvent({
        actorKind: "user",
        actorRef: auth!.profileId,
        action: "workflow.access_denied",
        targetType: "workflow",
        targetRef: workflowId,
        requestId,
        traceId,
        result: "denied",
        reasonCode: "not_owned_or_absent",
      });
      throw new ProblemError("NOT_FOUND", { detail: "No such workflow." });
    }
    if (result.outcome === "already_terminal") {
      throw new ProblemError("WORKFLOW_NOT_CANCELLABLE", {
        detail: "That work has already finished.",
      });
    }

    const record = (await readWorkflow(workflowId, auth!.profileId))!;
    // A shadow workflow's execution still lives in the legacy pipeline, so the
    // cancellation has to reach it too. Ordered after the ledger commit: the
    // ledger is the record of what was asked for, and it must not be possible
    // to stop the legacy run without that record existing.
    if (record.resource?.type === "analysisImport") {
      await requestLegacyImportCancellation(record.resource.id, auth!.profileId);
    }
    await recordAuditEvent({
      actorKind: "user",
      actorRef: auth!.profileId,
      action: "workflow.cancel_requested",
      targetType: "workflow",
      targetRef: workflowId,
      requestId,
      traceId,
      result: "allowed",
      metadata: { state: record.state },
    });
    return { data: toWire(record), resource: { type: "workflow", id: workflowId } };
  },
};

export const WORKFLOW_ROUTES = [
  listWorkflowsRoute,
  getWorkflowRoute,
  cancelWorkflowRoute,
] as const;

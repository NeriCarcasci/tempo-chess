import { client } from "../db/client.js";
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_TIMEOUT_SECONDS,
  LEASE_RECOVERY_BATCH,
  type DispatchMode,
  type Queue,
  type ResourceClass,
  type RetryClass,
  type WorkItemStatus,
  type WorkflowKind,
  type WorkflowState,
} from "./contract.js";
import { safeWorkflowError } from "./errors.js";
import { classifyFailure } from "./retry.js";
import {
  deriveProgress,
  deriveWorkflowState,
  emptyTally,
  workflowTransitionAllowed,
  type ItemTally,
  type Progress,
} from "./state.js";
import { attemptTokenMatches } from "./tokens.js";

/**
 * The durable work ledger.
 *
 * Every function here is a *short* transaction over the ledger tables and
 * nothing else. Platform spec §8 and the epic both forbid a provider, storage,
 * or model call inside a database transaction, so the executor calls these
 * functions around the work rather than wrapping the work in one of them: claim,
 * commit; run, no transaction; complete, commit.
 *
 * Three properties are the reason this file exists rather than a handful of
 * statements at each call site:
 *
 *  - a committed command cannot be lost, because the workflow, its items and
 *    the outbox row that will wake them are written in one transaction;
 *  - a duplicate delivery has one effect, because every mutation is conditional
 *    on the state it read — a second caller updates zero rows and is told so;
 *  - a terminal state is final, because the derived state is checked against
 *    the transition table here and against a trigger in the database.
 */

type Sql = typeof client;

/**
 * Lock ordering, stated once because a deadlock is the failure it prevents.
 *
 * Every transaction that mutates the ledger takes the `ops.workflows` row
 * first and the `ops.work_items` rows second. Cancellation naturally starts at
 * the workflow and completion naturally starts at the item, so without a stated
 * order those two paths would take the same pair of locks in opposite
 * directions and occasionally deadlock under exactly the concurrency this epic
 * exists to support. Dependency edges are always within one workflow, so the
 * workflow lock serialises every item transition inside it.
 */
async function lockWorkflow(tx: Sql, workflowId: string): Promise<boolean> {
  const rows = await tx<{ id: string }[]>`
    select id from ops.workflows where id = ${workflowId}::uuid for update`;
  return rows.length > 0;
}

/** The workflow a work item belongs to, read without taking a lock. */
async function workflowIdOf(sql: Sql, workItemId: string): Promise<string | null> {
  const rows = await sql<{ workflow_id: string }[]>`
    select workflow_id from ops.work_items where id = ${workItemId}::bigint`;
  return rows[0]?.workflow_id ?? null;
}

// --- creation --------------------------------------------------------------

export interface WorkItemInput {
  taskType: string;
  resourceClass: ResourceClass;
  /** Stable per side effect and scoped to the handler version. */
  idempotencyKey: string;
  inputRef?: string | null;
  payload?: Record<string, unknown>;
  weight?: number;
  priority?: number;
  maxAttempts?: number;
  timeoutSeconds?: number;
  availableAt?: Date | null;
  dispatchMode?: DispatchMode;
  /** Required when `dispatchMode` is `queue`; forbidden otherwise. */
  queue?: Queue | null;
  /** Indices into the same `items` array. Must be earlier than this item. */
  dependsOn?: readonly number[];
}

export interface CreateWorkflowInput {
  kind: WorkflowKind;
  ownerProfileId: string | null;
  resource?: { type: string; id: string } | null;
  costBudgetUsd?: number | null;
  items: readonly WorkItemInput[];
}

export interface CreatedWorkflow {
  workflowId: string;
  itemIds: readonly string[];
}

/** A work item whose idempotency key is already in the ledger. */
export class DuplicateWorkError extends Error {
  constructor(
    readonly idempotencyKey: string,
    readonly existingWorkflowId: string | null,
  ) {
    super(`work item ${idempotencyKey} already exists`);
    this.name = "DuplicateWorkError";
  }
}

/**
 * A JSON document, encoded here and parsed by PostgreSQL.
 *
 * Every use casts `::text::jsonb` rather than `::jsonb`. The intermediate cast
 * is not decoration: postgres.js reads the trailing cast in the template to
 * choose a serializer, and a bare `::jsonb` makes it JSON-encode the string we
 * already encoded — storing the *string* `"{}"` instead of an empty object, and
 * failing the `jsonb_typeof(...) = 'object'` constraint. Naming `text` first
 * removes the inference and leaves the parse where it belongs.
 */
function jsonb(value: unknown): string {
  return JSON.stringify(value ?? {});
}

/**
 * Write a workflow, its items, its dependency edges and the outbox rows that
 * will wake them — all inside the caller's transaction.
 *
 * The caller supplies the transaction on purpose. A command that creates a
 * workflow almost always has its own row to write in the same commit (the
 * legacy import shadow is exactly that), and the guarantee the epic is about
 * only holds if those land together.
 */
export async function insertWorkflow(
  tx: Sql,
  input: CreateWorkflowInput,
): Promise<CreatedWorkflow> {
  const workflowRows = await tx<{ id: string }[]>`
    insert into ops.workflows (kind, owner_profile_id, resource_type, resource_id, cost_budget_usd)
    values (
      ${input.kind}, ${input.ownerProfileId}, ${input.resource?.type ?? null},
      ${input.resource?.id ?? null}, ${input.costBudgetUsd ?? null}
    )
    returning id`;
  const workflowId = workflowRows[0]!.id;

  const itemIds: string[] = [];
  for (const [index, item] of input.items.entries()) {
    for (const dependency of item.dependsOn ?? []) {
      if (dependency >= index) {
        // The database refuses a backward edge too, but only after the rows
        // exist; catching it here names the offending index instead of an id.
        throw new Error(
          `work item ${index} depends on ${dependency}, which is not an earlier item`,
        );
      }
    }
    const dispatchMode = item.dispatchMode ?? "queue";
    const status: WorkItemStatus = (item.dependsOn?.length ?? 0) > 0 ? "blocked" : "ready";
    const rows = await tx<{ id: string }[]>`
      insert into ops.work_items (
        workflow_id, task_type, resource_class, input_ref, payload, idempotency_key,
        weight, priority, available_at, status, dispatch_mode, queue, max_attempts,
        timeout_seconds
      ) values (
        ${workflowId}, ${item.taskType}, ${item.resourceClass}, ${item.inputRef ?? null},
        ${jsonb(item.payload)}::text::jsonb, ${item.idempotencyKey},
        ${item.weight ?? 1}, ${item.priority ?? 100},
        coalesce(${item.availableAt ? item.availableAt.toISOString() : null}::timestamptz, now()),
        ${status}, ${dispatchMode}, ${dispatchMode === "queue" ? (item.queue ?? null) : null},
        ${item.maxAttempts ?? DEFAULT_MAX_ATTEMPTS}, ${item.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS}
      )
      on conflict (idempotency_key) do nothing
      returning id`;
    if (!rows[0]) {
      const existing = await tx<{ workflow_id: string }[]>`
        select workflow_id from ops.work_items where idempotency_key = ${item.idempotencyKey}`;
      throw new DuplicateWorkError(item.idempotencyKey, existing[0]?.workflow_id ?? null);
    }
    itemIds.push(rows[0].id);
  }

  for (const [index, item] of input.items.entries()) {
    for (const dependency of item.dependsOn ?? []) {
      await tx`
        insert into ops.work_item_dependencies (work_item_id, depends_on_work_item_id)
        values (${itemIds[index]!}, ${itemIds[dependency]!})
        on conflict do nothing`;
    }
  }

  for (const [index, item] of input.items.entries()) {
    const dispatchMode = item.dispatchMode ?? "queue";
    if (dispatchMode !== "queue") continue;
    if ((item.dependsOn?.length ?? 0) > 0) continue;
    await enqueueDispatch(tx, itemIds[index]!, 0);
  }

  return { workflowId, itemIds };
}

/** Open a transaction and write the workflow in it. */
export async function createWorkflow(input: CreateWorkflowInput): Promise<CreatedWorkflow> {
  return client.begin(async (tx) => insertWorkflow(tx as unknown as Sql, input)) as Promise<CreatedWorkflow>;
}

/**
 * The outbox row that will wake one work item.
 *
 * The dedup key carries the dispatch epoch, so a retry's message is a different
 * message rather than a duplicate the unique index would swallow, and the same
 * string becomes the Cloud Tasks task name — which is what makes a redelivered
 * dispatch a no-op at the queue as well as here.
 */
async function enqueueDispatch(tx: Sql, workItemId: string, dispatchEpoch: number): Promise<void> {
  // `available_at` is now, not the item's own future time: the row should be
  // *sent* immediately and the delay carried by the queue's schedule time. A
  // row that waited for the retry moment would add a dispatcher poll interval
  // to every backoff, and would leave an unsent message sitting in the outbox
  // for as long as the backoff lasted.
  await tx`
    insert into ops.outbox_events (aggregate_type, aggregate_id, event_type, dedup_key, payload)
    values ('work_item', ${workItemId}, 'work_item.ready',
      ${`wi-${workItemId}-${dispatchEpoch}`},
      ${jsonb({ workItemId, dispatchEpoch })}::text::jsonb)
    on conflict (dedup_key) do nothing`;
}

// --- reading ---------------------------------------------------------------

export interface WorkflowRecord {
  id: string;
  kind: WorkflowKind;
  ownerProfileId: string | null;
  state: WorkflowState;
  resource: { type: string; id: string } | null;
  progress: Progress & { stage: string | null };
  error: { code: string; message: string } | null;
  cancellable: boolean;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

interface WorkflowRow {
  id: string;
  kind: WorkflowKind;
  owner_profile_id: string | null;
  state: WorkflowState;
  resource_type: string | null;
  resource_id: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
  tally: Record<string, { count: number; weight: number }> | null;
  stage: string | null;
}

/**
 * One aggregate per workflow rather than one row per item.
 *
 * A workflow can hold hundreds of items; a list endpoint that loaded them all
 * to compute a percentage would read the whole ledger to render a page. The
 * `case`/`sum` here only counts — every rule about what the counts *mean* is in
 * `state.ts`, so there is still one implementation of the contract.
 */
const WORKFLOW_SELECT = (sql: Sql) => sql`
  select w.id, w.kind, w.owner_profile_id, w.state, w.resource_type, w.resource_id,
         w.error_code, w.error_message, w.created_at, w.started_at, w.completed_at, w.updated_at,
         (
           select jsonb_object_agg(t.status, jsonb_build_object('count', t.count, 'weight', t.weight))
           from (
             select status, count(*)::int as count, sum(weight)::int as weight
             from ops.work_items i where i.workflow_id = w.id group by status
           ) t
         ) as tally,
         (
           select i.task_type from ops.work_items i
           where i.workflow_id = w.id
             and i.status in ('blocked', 'ready', 'leased', 'retry_wait')
           order by i.priority desc, i.id limit 1
         ) as stage
  from ops.workflows w`;

function toTally(raw: WorkflowRow["tally"]): ItemTally {
  const result = emptyTally();
  for (const [status, value] of Object.entries(raw ?? {})) {
    if (status in result) {
      result[status as WorkItemStatus] = {
        count: Number(value.count ?? 0),
        weight: Number(value.weight ?? 0),
      };
    }
  }
  return result;
}

function toRecord(row: WorkflowRow): WorkflowRecord {
  const progress = deriveProgress(toTally(row.tally));
  const terminal = row.completed_at !== null;
  return {
    id: row.id,
    kind: row.kind,
    ownerProfileId: row.owner_profile_id,
    state: row.state,
    resource:
      row.resource_type && row.resource_id
        ? { type: row.resource_type, id: row.resource_id }
        : null,
    progress: { ...progress, stage: row.stage },
    error:
      row.error_code !== null
        ? { code: row.error_code, message: row.error_message ?? "" }
        : null,
    cancellable: !terminal,
    createdAt: new Date(row.created_at).toISOString(),
    startedAt: row.started_at ? new Date(row.started_at).toISOString() : null,
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/**
 * Read one workflow *as its owner*.
 *
 * The owner is a parameter rather than a filter the caller may forget: there is
 * no overload of this function that returns a workflow without checking who is
 * asking. A workflow that exists but belongs to someone else is reported the
 * same way as one that does not exist, so an identifier cannot be probed.
 */
export async function readWorkflow(
  workflowId: string,
  ownerProfileId: string,
  sql: Sql = client,
): Promise<WorkflowRecord | null> {
  const rows = await sql<WorkflowRow[]>`
    ${WORKFLOW_SELECT(sql)}
    where w.id = ${workflowId}::uuid and w.owner_profile_id = ${ownerProfileId}::uuid`;
  return rows[0] ? toRecord(rows[0]) : null;
}

export interface ListWorkflowsQuery {
  ownerProfileId: string;
  state?: WorkflowState | null;
  kind?: WorkflowKind | null;
  /** Keyset anchor: the last row's `(createdAt, id)`. */
  after?: { createdAt: string; id: string } | null;
  limit: number;
}

export async function listWorkflows(
  query: ListWorkflowsQuery,
  sql: Sql = client,
): Promise<WorkflowRecord[]> {
  const rows = await sql<WorkflowRow[]>`
    ${WORKFLOW_SELECT(sql)}
    where w.owner_profile_id = ${query.ownerProfileId}::uuid
      and (${query.state ?? null}::text is null or w.state = ${query.state ?? null})
      and (${query.kind ?? null}::text is null or w.kind = ${query.kind ?? null})
      and (
        ${query.after?.createdAt ?? null}::timestamptz is null
        or (w.created_at, w.id) < (${query.after?.createdAt ?? null}::timestamptz, ${query.after?.id ?? null}::uuid)
      )
    order by w.created_at desc, w.id desc
    limit ${query.limit}`;
  return rows.map(toRecord);
}

// --- workflow settlement ---------------------------------------------------

/**
 * Recompute a workflow's state from its items.
 *
 * Called inside the same transaction as every item transition, so the workflow
 * a reader sees is never a stale summary of the items it is a summary of. The
 * derived state is checked against the transition table before it is written:
 * the trigger would refuse a regression anyway, but refusing here says which
 * transition was attempted.
 */
export async function refreshWorkflow(tx: Sql, workflowId: string): Promise<WorkflowState> {
  const rows = await tx<
    {
      state: WorkflowState;
      cancel_requested: boolean;
      tally: WorkflowRow["tally"];
      dead_error_class: RetryClass | null;
    }[]
  >`
    select w.state,
           (w.cancel_requested_at is not null) as cancel_requested,
           (
             select jsonb_object_agg(t.status, jsonb_build_object('count', t.count, 'weight', t.weight))
             from (
               select status, count(*)::int as count, sum(weight)::int as weight
               from ops.work_items i where i.workflow_id = w.id group by status
             ) t
           ) as tally,
           (
             select i.error_class from ops.work_items i
             where i.workflow_id = w.id and i.status = 'dead'
             order by i.completed_at, i.id limit 1
           ) as dead_error_class
    from ops.workflows w where w.id = ${workflowId}::uuid for update`;
  const row = rows[0];
  if (!row) throw new Error("workflow disappeared while settling");

  const next = deriveWorkflowState(row.state, toTally(row.tally), row.cancel_requested);
  if (next === row.state) {
    await tx`update ops.workflows set updated_at = now() where id = ${workflowId}::uuid`;
    return row.state;
  }
  if (!workflowTransitionAllowed(row.state, next)) {
    throw new Error(`refusing workflow transition ${row.state} -> ${next}`);
  }

  const error = next === "failed" ? safeWorkflowError(row.dead_error_class) : null;
  const terminal = next === "succeeded" || next === "failed" || next === "cancelled";
  await tx`
    update ops.workflows
    set state = ${next},
        started_at = coalesce(started_at, case when ${next} <> 'queued' then now() end),
        completed_at = case when ${terminal} then now() else completed_at end,
        error_code = ${error?.code ?? null},
        error_message = ${error?.message ?? null},
        updated_at = now()
    where id = ${workflowId}::uuid`;
  return next;
}

// --- claiming and completion ----------------------------------------------

export interface WorkerIdentity {
  /** The deployment that answered, e.g. `forma-ingestion-worker`. */
  deployment: string;
  revision: string | null;
  /** Instance-unique. Becomes the lease owner, so it must not be shared. */
  instance: string;
}

export interface LeasedWorkItem {
  id: string;
  workflowId: string;
  taskType: string;
  resourceClass: ResourceClass;
  inputRef: string | null;
  payload: Record<string, unknown>;
  attempt: number;
  maxAttempts: number;
  leaseOwner: string;
  timeoutSeconds: number;
}

export type ClaimRejection =
  | "not_found"
  | "terminal"
  | "already_leased"
  | "blocked"
  | "cancelled"
  | "stale_attempt"
  | "attempts_exhausted";

export type ClaimResult =
  | { outcome: "claimed"; item: LeasedWorkItem }
  | { outcome: "noop"; reason: ClaimRejection }
  /** Not due yet: the caller should let the transport redeliver, not acknowledge. */
  | { outcome: "retry_later"; afterSeconds: number };

interface ClaimRow {
  id: string;
  workflow_id: string;
  task_type: string;
  resource_class: ResourceClass;
  status: WorkItemStatus;
  dispatch_epoch: number;
  attempt_count: number;
  max_attempts: number;
  timeout_seconds: number;
  input_ref: string | null;
  payload: Record<string, unknown>;
  due_in_seconds: number;
  cancel_requested: boolean;
}

/**
 * Take the lease on one named item.
 *
 * Conditional from end to end: the row is locked, the presented token is
 * checked against the epoch the row currently carries, and the update names the
 * status it read. Two deliveries of the same message race here and exactly one
 * of them gets `claimed`; the other is told `already_leased` and does nothing,
 * which is what "duplicate delivery produces one effect" means in practice.
 */
export async function claimWorkItem(
  request: { workItemId: string; attemptToken: string; worker: WorkerIdentity; traceId?: string | null },
  sql: Sql = client,
): Promise<ClaimResult> {
  const workflowId = await workflowIdOf(sql, request.workItemId);
  if (workflowId === null) return { outcome: "noop", reason: "not_found" };

  return sql.begin(async (tx) => {
    if (!(await lockWorkflow(tx as unknown as Sql, workflowId))) {
      return { outcome: "noop", reason: "not_found" } as ClaimResult;
    }
    const rows = await tx<ClaimRow[]>`
      select i.id, i.workflow_id, i.task_type, i.resource_class, i.status, i.dispatch_epoch,
             i.attempt_count, i.max_attempts, i.timeout_seconds, i.input_ref, i.payload,
             greatest(0, extract(epoch from (i.available_at - now())))::int as due_in_seconds,
             (w.cancel_requested_at is not null) as cancel_requested
      from ops.work_items i
      join ops.workflows w on w.id = i.workflow_id
      where i.id = ${request.workItemId}::bigint
      for update of i`;
    const row = rows[0];
    if (!row) return { outcome: "noop", reason: "not_found" } as ClaimResult;

    if (row.status === "succeeded" || row.status === "dead" || row.status === "cancelled") {
      return { outcome: "noop", reason: "terminal" } as ClaimResult;
    }
    if (row.status === "leased") return { outcome: "noop", reason: "already_leased" } as ClaimResult;
    if (row.status === "blocked") return { outcome: "noop", reason: "blocked" } as ClaimResult;

    // The token is checked before anything is written, and before cancellation
    // is acted on: a delivery that cannot prove which attempt it is for must not
    // be able to move the row at all.
    if (
      !attemptTokenMatches(
        { workItemId: row.id, dispatchEpoch: row.dispatch_epoch },
        request.attemptToken,
      )
    ) {
      return { outcome: "noop", reason: "stale_attempt" } as ClaimResult;
    }

    if (row.cancel_requested) {
      await tx`
        update ops.work_items
        set status = 'cancelled', lease_owner = null, lease_expires_at = null, heartbeat_at = null,
            completed_at = now(), updated_at = now()
        where id = ${row.id}::bigint and status in ('ready', 'retry_wait')`;
      await refreshWorkflow(tx as unknown as Sql, row.workflow_id);
      return { outcome: "noop", reason: "cancelled" } as ClaimResult;
    }

    if (row.due_in_seconds > 0) {
      return { outcome: "retry_later", afterSeconds: row.due_in_seconds } as ClaimResult;
    }

    if (row.attempt_count >= row.max_attempts) {
      await settleDead(tx as unknown as Sql, row.id, "permanent", "attempts_exhausted", null);
      await refreshWorkflow(tx as unknown as Sql, row.workflow_id);
      return { outcome: "noop", reason: "attempts_exhausted" } as ClaimResult;
    }

    const leaseOwner = `${request.worker.deployment}:${request.worker.instance}`;
    const claimed = await tx<{ attempt_count: number }[]>`
      update ops.work_items
      set status = 'leased', lease_owner = ${leaseOwner},
          lease_expires_at = now() + make_interval(secs => timeout_seconds),
          heartbeat_at = now(), attempt_count = attempt_count + 1,
          started_at = coalesce(started_at, now()), updated_at = now()
      where id = ${row.id}::bigint
        and status = ${row.status}
        and dispatch_epoch = ${row.dispatch_epoch}
      returning attempt_count`;
    if (!claimed[0]) return { outcome: "noop", reason: "already_leased" } as ClaimResult;

    await tx`
      insert into ops.work_attempts (
        work_item_id, attempt_number, deployment, revision, worker_instance, started_at, trace_id
      ) values (
        ${row.id}::bigint, ${claimed[0].attempt_count}, ${request.worker.deployment},
        ${request.worker.revision}, ${request.worker.instance}, now(), ${request.traceId ?? null}
      )`;
    await refreshWorkflow(tx as unknown as Sql, row.workflow_id);

    return {
      outcome: "claimed",
      item: {
        id: row.id,
        workflowId: row.workflow_id,
        taskType: row.task_type,
        resourceClass: row.resource_class,
        inputRef: row.input_ref,
        payload: row.payload ?? {},
        attempt: claimed[0].attempt_count,
        maxAttempts: row.max_attempts,
        leaseOwner,
        timeoutSeconds: row.timeout_seconds,
      },
    } as ClaimResult;
  }) as Promise<ClaimResult>;
}

/**
 * Extend a lease and ask whether the work should stop.
 *
 * Cancellation of leased work is cooperative by contract (platform spec §8): a
 * handler checks between bounded units, and this is the check. A heartbeat that
 * updates no row means the lease was already recovered by someone else, which
 * the handler must treat exactly like a cancellation — its result is no longer
 * wanted and will not be accepted.
 */
export async function heartbeat(
  workItemId: string,
  leaseOwner: string,
  sql: Sql = client,
): Promise<{ held: boolean; cancelRequested: boolean }> {
  const rows = await sql<{ cancel_requested: boolean }[]>`
    update ops.work_items i
    set lease_expires_at = now() + make_interval(secs => i.timeout_seconds),
        heartbeat_at = now(), updated_at = now()
    from ops.workflows w
    where i.id = ${workItemId}::bigint and i.workflow_id = w.id
      and i.status = 'leased' and i.lease_owner = ${leaseOwner}
    returning (w.cancel_requested_at is not null) as cancel_requested`;
  return rows[0]
    ? { held: true, cancelRequested: rows[0].cancel_requested }
    : { held: false, cancelRequested: true };
}

export interface CompletionMetrics {
  inputCount?: number | null;
  outputCount?: number | null;
  cacheHits?: number | null;
  computeMs?: number | null;
  billedUnits?: number | null;
}

/**
 * Record success, release whatever was waiting on it, and settle the workflow —
 * in one transaction, so the acknowledgement the caller sends afterwards is an
 * acknowledgement of something that is already true.
 */
export async function completeWorkItem(
  input: {
    workItemId: string;
    leaseOwner: string;
    attempt: number;
    outputRef?: string | null;
    outputSummary?: Record<string, unknown> | null;
    metrics?: CompletionMetrics;
  },
  sql: Sql = client,
): Promise<{ applied: boolean; releasedItemIds: readonly string[] }> {
  const workflowId = await workflowIdOf(sql, input.workItemId);
  if (workflowId === null) return { applied: false, releasedItemIds: [] };

  return sql.begin(async (tx) => {
    await lockWorkflow(tx as unknown as Sql, workflowId);
    const updated = await tx<{ workflow_id: string }[]>`
      update ops.work_items
      set status = 'succeeded', lease_owner = null, lease_expires_at = null, heartbeat_at = null,
          output_ref = ${input.outputRef ?? null},
          output_summary = ${input.outputSummary ? jsonb(input.outputSummary) : null}::text::jsonb,
          error_class = null, error_code = null, error_detail = null,
          completed_at = now(), updated_at = now()
      where id = ${input.workItemId}::bigint and status = 'leased'
        and lease_owner = ${input.leaseOwner}
      returning workflow_id`;
    if (!updated[0]) return { applied: false, releasedItemIds: [] };

    await finishAttempt(tx as unknown as Sql, input.workItemId, input.attempt, {
      outcome: "succeeded",
      metrics: input.metrics,
    });
    const released = await releaseDependents(tx as unknown as Sql, input.workItemId);
    await refreshWorkflow(tx as unknown as Sql, updated[0].workflow_id);
    return { applied: true, releasedItemIds: released };
  }) as Promise<{ applied: boolean; releasedItemIds: readonly string[] }>;
}

export interface FailureInput {
  workItemId: string;
  leaseOwner: string;
  attempt: number;
  retryClass: RetryClass;
  errorCode: string;
  errorDetail?: string | null;
  retryAfterSeconds?: number | null;
  metrics?: CompletionMetrics;
}

/**
 * Record a failed attempt and decide the item's fate.
 *
 * The decision is `retry.ts`'s, not this file's; what happens here is durable —
 * the next attempt time is a column, not a timer in a process that is about to
 * be scaled to zero.
 */
export async function failWorkItem(
  input: FailureInput,
  sql: Sql = client,
): Promise<{ applied: boolean; status: "retry_wait" | "dead" | null }> {
  const workflowId = await workflowIdOf(sql, input.workItemId);
  if (workflowId === null) return { applied: false, status: null };

  return sql.begin(async (tx) => {
    await lockWorkflow(tx as unknown as Sql, workflowId);
    const current = await tx<{ workflow_id: string; attempt_count: number; max_attempts: number }[]>`
      select workflow_id, attempt_count, max_attempts from ops.work_items
      where id = ${input.workItemId}::bigint and status = 'leased' and lease_owner = ${input.leaseOwner}
      for update`;
    if (!current[0]) return { applied: false, status: null };

    const decision = classifyFailure({
      workItemId: input.workItemId,
      attempt: current[0].attempt_count,
      maxAttempts: current[0].max_attempts,
      retryClass: input.retryClass,
      retryAfterSeconds: input.retryAfterSeconds ?? null,
    });

    if (decision.status === "retry_wait") {
      await tx`
        update ops.work_items
        set status = 'retry_wait', lease_owner = null, lease_expires_at = null, heartbeat_at = null,
            available_at = now() + make_interval(secs => ${decision.delaySeconds}),
            dispatch_epoch = dispatch_epoch + 1,
            error_class = ${input.retryClass}, error_code = ${input.errorCode},
            error_detail = ${truncateDetail(input.errorDetail)}, updated_at = now()
        where id = ${input.workItemId}::bigint`;
      await scheduleRedispatch(tx as unknown as Sql, input.workItemId);
    } else {
      await settleDead(
        tx as unknown as Sql,
        input.workItemId,
        input.retryClass,
        input.errorCode,
        input.errorDetail ?? null,
      );
    }

    await finishAttempt(tx as unknown as Sql, input.workItemId, input.attempt, {
      outcome: "failed",
      retryClass: input.retryClass,
      errorCode: input.errorCode,
      metrics: input.metrics,
    });
    await refreshWorkflow(tx as unknown as Sql, current[0].workflow_id);
    return { applied: true, status: decision.status };
  }) as Promise<{ applied: boolean; status: "retry_wait" | "dead" | null }>;
}

function truncateDetail(detail: string | null | undefined): string | null {
  if (!detail) return null;
  return detail.length > 500 ? detail.slice(0, 500) : detail;
}

/**
 * Mark an item dead, and take its blocked descendants with it.
 *
 * Without the cascade a dead item leaves its dependents `blocked` forever: the
 * workflow never settles, the owner sees a bar that never moves, and no alert
 * fires because nothing failed. They are marked `dead` rather than `cancelled`
 * on purpose — cancelled work leaves the progress denominator, and a workflow
 * that shows 100% because the rest of it can never run would be a lie.
 */
async function settleDead(
  tx: Sql,
  workItemId: string,
  retryClass: RetryClass,
  errorCode: string,
  errorDetail: string | null,
): Promise<void> {
  await tx`
    update ops.work_items
    set status = 'dead', lease_owner = null, lease_expires_at = null, heartbeat_at = null,
        error_class = ${retryClass}, error_code = ${errorCode},
        error_detail = ${truncateDetail(errorDetail)},
        completed_at = now(), updated_at = now()
    where id = ${workItemId}::bigint and status <> 'dead'`;
  await tx`
    with recursive blocked_descendants as (
      select d.work_item_id as id
      from ops.work_item_dependencies d
      where d.depends_on_work_item_id = ${workItemId}::bigint
      union
      select d.work_item_id
      from ops.work_item_dependencies d
      join blocked_descendants b on b.id = d.depends_on_work_item_id
    )
    update ops.work_items i
    set status = 'dead', error_class = 'permanent', error_code = 'dependency_failed',
        completed_at = now(), updated_at = now()
    from blocked_descendants b
    where i.id = b.id and i.status = 'blocked'`;
}

/** Every blocked dependent of `workItemId` whose upstream items have all succeeded. */
async function releaseDependents(tx: Sql, workItemId: string): Promise<string[]> {
  const released = await tx<{ id: string; dispatch_epoch: number; dispatch_mode: DispatchMode }[]>`
    update ops.work_items c
    set status = 'ready', dispatch_epoch = c.dispatch_epoch + 1, updated_at = now()
    where c.status = 'blocked'
      and c.id in (
        select d.work_item_id from ops.work_item_dependencies d
        where d.depends_on_work_item_id = ${workItemId}::bigint
      )
      and not exists (
        select 1 from ops.work_item_dependencies d2
        join ops.work_items u on u.id = d2.depends_on_work_item_id
        where d2.work_item_id = c.id and u.status <> 'succeeded'
      )
    returning c.id, c.dispatch_epoch, c.dispatch_mode`;
  for (const item of released) {
    if (item.dispatch_mode === "queue") {
      await enqueueDispatch(tx, item.id, item.dispatch_epoch);
    }
  }
  return released.map((item) => item.id);
}

/** Enqueue the outbox row for an item that has just been given a new epoch. */
async function scheduleRedispatch(tx: Sql, workItemId: string): Promise<void> {
  const rows = await tx<{ dispatch_epoch: number; dispatch_mode: DispatchMode }[]>`
    select dispatch_epoch, dispatch_mode from ops.work_items where id = ${workItemId}::bigint`;
  if (rows[0]?.dispatch_mode === "queue") {
    await enqueueDispatch(tx, workItemId, rows[0].dispatch_epoch);
  }
}

async function finishAttempt(
  tx: Sql,
  workItemId: string,
  attemptNumber: number,
  result: {
    outcome: "succeeded" | "failed" | "abandoned" | "cancelled";
    retryClass?: RetryClass | null;
    errorCode?: string | null;
    metrics?: CompletionMetrics;
  },
): Promise<void> {
  await tx`
    update ops.work_attempts
    set finished_at = now(), outcome = ${result.outcome},
        error_class = ${result.retryClass ?? null}, error_code = ${result.errorCode ?? null},
        input_count = ${result.metrics?.inputCount ?? null},
        output_count = ${result.metrics?.outputCount ?? null},
        cache_hits = ${result.metrics?.cacheHits ?? null},
        compute_ms = ${result.metrics?.computeMs ?? null},
        billed_units = ${result.metrics?.billedUnits ?? null}
    where work_item_id = ${workItemId}::bigint and attempt_number = ${attemptNumber}
      and finished_at is null`;
}

// --- cancellation ----------------------------------------------------------

export type CancelOutcome = "accepted" | "already_terminal" | "not_found";

/**
 * Request cancellation, and stop everything that can be stopped now.
 *
 * Leased attempts are not killed: platform spec §8 makes cancellation
 * cooperative, and a handler that is halfway through a bounded unit is left to
 * finish it. That is why the workflow lands in `cancelling` rather than
 * `cancelled` when an attempt is in flight — the state says what is true.
 */
export async function requestCancellation(
  workflowId: string,
  ownerProfileId: string,
  sql: Sql = client,
): Promise<{ outcome: CancelOutcome; state: WorkflowState | null }> {
  return sql.begin(async (tx) => {
    const rows = await tx<{ state: WorkflowState }[]>`
      select state from ops.workflows
      where id = ${workflowId}::uuid and owner_profile_id = ${ownerProfileId}::uuid
      for update`;
    if (!rows[0]) return { outcome: "not_found" as const, state: null };
    if (rows[0].state === "succeeded" || rows[0].state === "failed" || rows[0].state === "cancelled") {
      return { outcome: "already_terminal" as const, state: rows[0].state };
    }

    await tx`
      update ops.workflows set cancel_requested_at = coalesce(cancel_requested_at, now()), updated_at = now()
      where id = ${workflowId}::uuid`;
    await tx`
      update ops.work_items
      set status = 'cancelled', completed_at = now(), updated_at = now()
      where workflow_id = ${workflowId}::uuid and status in ('blocked', 'ready', 'retry_wait')`;
    const state = await refreshWorkflow(tx as unknown as Sql, workflowId);
    return { outcome: "accepted" as const, state };
  }) as Promise<{ outcome: CancelOutcome; state: WorkflowState | null }>;
}

// --- lease recovery --------------------------------------------------------

export interface RecoveryReport {
  examined: number;
  reconciledSucceeded: number;
  requeued: number;
  deadLettered: number;
}

/**
 * Reconcile expired leases, then decide whether to retry.
 *
 * The order is the contract. Platform spec §8: "lease expiry does not imply
 * side effects did not occur; retry rechecks output." An item that recorded an
 * output before the process died *did* the work, and requeueing it would do it
 * twice — so the output reference is checked first and a reconciled item is
 * completed rather than retried.
 */
export async function recoverExpiredLeases(
  limit = LEASE_RECOVERY_BATCH,
  sql: Sql = client,
): Promise<RecoveryReport> {
  // Candidates are read without a lock and then settled one at a time. A single
  // transaction over the whole batch would hold every workflow lock it touched
  // for the length of the sweep, and it would take those locks in item order —
  // the opposite of the order cancellation takes them.
  const candidates = await sql<{ id: string; workflow_id: string }[]>`
    select id, workflow_id from ops.work_items
    where status = 'leased' and lease_expires_at < now()
    order by lease_expires_at
    limit ${limit}`;

  const report: RecoveryReport = {
    examined: 0,
    reconciledSucceeded: 0,
    requeued: 0,
    deadLettered: 0,
  };

  for (const candidate of candidates) {
    const outcome = (await sql.begin(async (tx) => {
      await lockWorkflow(tx as unknown as Sql, candidate.workflow_id);
      const rows = await tx<
        { id: string; output_ref: string | null; attempt_count: number; max_attempts: number }[]
      >`
        select id, output_ref, attempt_count, max_attempts from ops.work_items
        where id = ${candidate.id}::bigint and status = 'leased' and lease_expires_at < now()
        for update`;
      const item = rows[0];
      // The worker finished, or another sweep got there first. Either way this
      // is no longer an expired lease and nothing should be done to it.
      if (!item) return null;

      await finishAttempt(tx as unknown as Sql, item.id, item.attempt_count, {
        outcome: "abandoned",
        retryClass: "transient",
        errorCode: "lease_expired",
      });

      if (item.output_ref !== null) {
        await tx`
          update ops.work_items
          set status = 'succeeded', lease_owner = null, lease_expires_at = null, heartbeat_at = null,
              error_class = null, error_code = null, error_detail = null,
              completed_at = now(), updated_at = now()
          where id = ${item.id}::bigint and status = 'leased'`;
        await releaseDependents(tx as unknown as Sql, item.id);
        await refreshWorkflow(tx as unknown as Sql, candidate.workflow_id);
        return "reconciled" as const;
      }

      const decision = classifyFailure({
        workItemId: item.id,
        attempt: item.attempt_count,
        maxAttempts: item.max_attempts,
        retryClass: "transient",
      });
      if (decision.status === "retry_wait") {
        await tx`
          update ops.work_items
          set status = 'retry_wait', lease_owner = null, lease_expires_at = null, heartbeat_at = null,
              available_at = now() + make_interval(secs => ${decision.delaySeconds}),
              dispatch_epoch = dispatch_epoch + 1,
              error_class = 'transient', error_code = 'lease_expired', updated_at = now()
          where id = ${item.id}::bigint`;
        await scheduleRedispatch(tx as unknown as Sql, item.id);
        await refreshWorkflow(tx as unknown as Sql, candidate.workflow_id);
        return "requeued" as const;
      }

      await settleDead(tx as unknown as Sql, item.id, "transient", "lease_expired", null);
      await refreshWorkflow(tx as unknown as Sql, candidate.workflow_id);
      return "dead" as const;
    })) as "reconciled" | "requeued" | "dead" | null;

    if (outcome === null) continue;
    report.examined += 1;
    if (outcome === "reconciled") report.reconciledSucceeded += 1;
    else if (outcome === "requeued") report.requeued += 1;
    else report.deadLettered += 1;
  }

  return report;
}

/**
 * Stop a leased item because its workflow was cancelled while it ran.
 *
 * Distinct from a failure: the attempt is recorded as `cancelled` rather than
 * `failed`, so an operator reading attempt history sees a handler that stopped
 * when asked and not a fault that never happened.
 */
export async function cancelLeasedWorkItem(
  input: { workItemId: string; leaseOwner: string; attempt: number },
  sql: Sql = client,
): Promise<{ applied: boolean }> {
  const workflowId = await workflowIdOf(sql, input.workItemId);
  if (workflowId === null) return { applied: false };

  return sql.begin(async (tx) => {
    await lockWorkflow(tx as unknown as Sql, workflowId);
    const updated = await tx<{ id: string }[]>`
      update ops.work_items
      set status = 'cancelled', lease_owner = null, lease_expires_at = null, heartbeat_at = null,
          completed_at = now(), updated_at = now()
      where id = ${input.workItemId}::bigint and status = 'leased'
        and lease_owner = ${input.leaseOwner}
      returning id`;
    if (!updated[0]) return { applied: false };
    await finishAttempt(tx as unknown as Sql, input.workItemId, input.attempt, {
      outcome: "cancelled",
    });
    await refreshWorkflow(tx as unknown as Sql, workflowId);
    return { applied: true };
  }) as Promise<{ applied: boolean }>;
}

/**
 * Claim the next ready in-process item of a given task type.
 *
 * The `FOR UPDATE SKIP LOCKED` claim of database architecture §14.6, for the
 * runner that lives beside the ledger rather than behind a queue. Push-based
 * workers use `claimWorkItem`, which names the item; this one goes looking,
 * which is what a co-located runner has to do because nothing delivered it a
 * message.
 */
export async function claimNextInProcess(
  input: { taskTypes: readonly string[]; worker: WorkerIdentity; traceId?: string | null },
  sql: Sql = client,
): Promise<LeasedWorkItem | null> {
  const candidates = await sql<{ id: string; workflow_id: string }[]>`
    select id, workflow_id from ops.work_items
    where dispatch_mode = 'in_process'
      and status in ('ready', 'retry_wait')
      and available_at <= now()
      and task_type = any(${[...input.taskTypes]}::text[])
    order by priority desc, available_at, id
    limit 10`;

  for (const candidate of candidates) {
    const result = await claimInProcessCandidate(sql, candidate, input);
    if (result) return result;
  }
  return null;
}

async function claimInProcessCandidate(
  sql: Sql,
  candidate: { id: string; workflow_id: string },
  input: { worker: WorkerIdentity; traceId?: string | null },
): Promise<LeasedWorkItem | null> {
  return sql.begin(async (tx) => {
    await lockWorkflow(tx as unknown as Sql, candidate.workflow_id);
    const rows = await tx<ClaimRow[]>`
      select i.id, i.workflow_id, i.task_type, i.resource_class, i.status, i.dispatch_epoch,
             i.attempt_count, i.max_attempts, i.timeout_seconds, i.input_ref, i.payload,
             0 as due_in_seconds,
             (w.cancel_requested_at is not null) as cancel_requested
      from ops.work_items i
      join ops.workflows w on w.id = i.workflow_id
      where i.id = ${candidate.id}::bigint
        and i.status in ('ready', 'retry_wait')
        and i.available_at <= now()
      for update of i skip locked`;
    const row = rows[0];
    if (!row) return null;

    if (row.cancel_requested) {
      await tx`
        update ops.work_items
        set status = 'cancelled', completed_at = now(), updated_at = now()
        where id = ${row.id}::bigint and status in ('ready', 'retry_wait')`;
      await refreshWorkflow(tx as unknown as Sql, row.workflow_id);
      return null;
    }
    if (row.attempt_count >= row.max_attempts) {
      await settleDead(tx as unknown as Sql, row.id, "permanent", "attempts_exhausted", null);
      await refreshWorkflow(tx as unknown as Sql, row.workflow_id);
      return null;
    }

    const leaseOwner = `${input.worker.deployment}:${input.worker.instance}`;
    const claimed = await tx<{ attempt_count: number }[]>`
      update ops.work_items
      set status = 'leased', lease_owner = ${leaseOwner},
          lease_expires_at = now() + make_interval(secs => timeout_seconds),
          heartbeat_at = now(), attempt_count = attempt_count + 1,
          started_at = coalesce(started_at, now()), updated_at = now()
      where id = ${row.id}::bigint and status = ${row.status}
      returning attempt_count`;
    if (!claimed[0]) return null;

    await tx`
      insert into ops.work_attempts (
        work_item_id, attempt_number, deployment, revision, worker_instance, started_at, trace_id
      ) values (
        ${row.id}::bigint, ${claimed[0].attempt_count}, ${input.worker.deployment},
        ${input.worker.revision}, ${input.worker.instance}, now(), ${input.traceId ?? null}
      )`;
    await refreshWorkflow(tx as unknown as Sql, row.workflow_id);

    return {
      id: row.id,
      workflowId: row.workflow_id,
      taskType: row.task_type,
      resourceClass: row.resource_class,
      inputRef: row.input_ref,
      payload: row.payload ?? {},
      attempt: claimed[0].attempt_count,
      maxAttempts: row.max_attempts,
      leaseOwner,
      timeoutSeconds: row.timeout_seconds,
    };
  }) as Promise<LeasedWorkItem | null>;
}

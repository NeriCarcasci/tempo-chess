import { client } from "../db/client.js";
import { OUTBOX_DISPATCH_BATCH, type DispatchMode, type Queue, type WorkItemStatus } from "./contract.js";
import { buildTaskPayload } from "./tokens.js";
import type { TaskTransport } from "./tasks.js";

/**
 * The outbox dispatcher.
 *
 * This is the half of "a committed command is never lost" that runs after the
 * commit. The command wrote a row; this reads it and sends a message; nothing
 * in between can drop the work, because the row survives every process that
 * dies while holding it.
 *
 * Three transactions, deliberately, with the network call between them:
 *
 *  1. claim a batch, pushing each row's `available_at` forward — the claim *is*
 *     the lease, so a dispatcher that dies mid-batch releases its rows by
 *     timeout rather than by a cleanup nobody runs;
 *  2. create the tasks, outside any transaction, because a provider call inside
 *     one is the thing the epic forbids and the thing that pins a connection
 *     for the length of a network timeout;
 *  3. record the outcome.
 *
 * A crash between 2 and 3 redelivers the row later and recreates the task under
 * the same deterministic name, which Cloud Tasks refuses. That is why the
 * duplicate is counted rather than treated as an error.
 */

type Sql = typeof client;

/** After this many failed sends a row is a dead letter an operator must see. */
export const MAX_PUBLISH_ATTEMPTS = 10;

export interface DispatchReport {
  claimed: number;
  published: number;
  duplicates: number;
  superseded: number;
  retrying: number;
  deadLettered: number;
}

interface ClaimedRow {
  id: string;
  dedup_key: string;
  payload: { workItemId?: string; dispatchEpoch?: number };
  publish_attempts: number;
  item_status: WorkItemStatus | null;
  item_epoch: number | null;
  item_queue: Queue | null;
  item_dispatch_mode: DispatchMode | null;
  item_available_at: string | null;
}

/** Backoff for a dispatch that could not reach the queue. Bounded and durable. */
function dispatchBackoffSeconds(attempts: number): number {
  return Math.min(300, 5 * 2 ** Math.min(attempts, 6));
}

export async function dispatchOutbox(
  transport: TaskTransport,
  limit = OUTBOX_DISPATCH_BATCH,
  sql: Sql = client,
): Promise<DispatchReport> {
  const claimed = (await sql.begin(async (tx) => {
    // The claim *is* the lease: pushing `available_at` forward means a
    // dispatcher that dies holding these rows releases them by timeout rather
    // than by a cleanup nobody runs.
    const rows = await tx<
      { id: string; dedup_key: string; payload: ClaimedRow["payload"]; publish_attempts: number }[]
    >`
      with claimed as (
        select o.id from ops.outbox_events o
        where o.state = 'pending' and o.available_at <= now()
        order by o.available_at, o.id
        limit ${limit}
        for update skip locked
      )
      update ops.outbox_events o
      set publish_attempts = o.publish_attempts + 1,
          available_at = now() + make_interval(secs => ${dispatchBackoffSeconds(0)})
      from claimed c
      where o.id = c.id
      returning o.id, o.dedup_key, o.payload, o.publish_attempts`;
    if (rows.length === 0) return [] as ClaimedRow[];

    const itemIds = rows
      .map((row) => row.payload?.workItemId)
      .filter((id): id is string => typeof id === "string");
    const items = itemIds.length
      ? await tx<
          {
            id: string;
            status: WorkItemStatus;
            dispatch_epoch: number;
            queue: Queue | null;
            dispatch_mode: DispatchMode;
            available_at: string;
          }[]
        >`
          select id, status, dispatch_epoch, queue, dispatch_mode, available_at
          from ops.work_items where id = any(${itemIds}::bigint[])`
      : [];
    const byId = new Map(items.map((item) => [String(item.id), item]));
    return rows.map((row) => {
      const item = byId.get(String(row.payload?.workItemId ?? ""));
      return {
        ...row,
        item_status: item?.status ?? null,
        item_epoch: item?.dispatch_epoch ?? null,
        item_queue: item?.queue ?? null,
        item_dispatch_mode: item?.dispatch_mode ?? null,
        item_available_at: item?.available_at ?? null,
      } satisfies ClaimedRow;
    });
  })) as ClaimedRow[];

  const report: DispatchReport = {
    claimed: claimed.length,
    published: 0,
    duplicates: 0,
    superseded: 0,
    retrying: 0,
    deadLettered: 0,
  };

  const published: string[] = [];
  const superseded: string[] = [];
  const failed: { id: string; attempts: number; code: string }[] = [];

  for (const row of claimed) {
    const workItemId = row.payload?.workItemId;
    const epoch = row.payload?.dispatchEpoch;
    if (typeof workItemId !== "string" || typeof epoch !== "number") {
      // A row whose payload cannot name an item can never be sent. It is a dead
      // letter immediately rather than ten failed sends from now.
      failed.push({ id: row.id, attempts: MAX_PUBLISH_ATTEMPTS, code: "malformed_payload" });
      continue;
    }

    // The item moved on: retried (new epoch), cancelled, already finished, or
    // rerouted to an in-process runner. Sending now would deliver a message for
    // an attempt that no longer exists, and the claim would reject it anyway.
    const stale =
      row.item_status === null ||
      row.item_epoch !== epoch ||
      row.item_dispatch_mode !== "queue" ||
      row.item_status === "succeeded" ||
      row.item_status === "dead" ||
      row.item_status === "cancelled";
    if (stale) {
      superseded.push(row.id);
      continue;
    }
    if (!row.item_queue) {
      failed.push({ id: row.id, attempts: MAX_PUBLISH_ATTEMPTS, code: "no_queue" });
      continue;
    }

    try {
      const result = await transport.createTask({
        queue: row.item_queue,
        name: row.dedup_key,
        payload: buildTaskPayload({ workItemId, dispatchEpoch: epoch }),
        scheduleAt: row.item_available_at ? new Date(row.item_available_at) : null,
      });
      published.push(row.id);
      if (result === "duplicate") report.duplicates += 1;
    } catch {
      // The reason is deliberately not recorded: a transport error message can
      // contain a URL with a token in it. The counter and the row are enough to
      // diagnose "the queue is unreachable", which is the only actionable case.
      failed.push({ id: row.id, attempts: row.publish_attempts, code: "transport_error" });
    }
  }

  await sql.begin(async (tx) => {
    if (published.length > 0) {
      await tx`
        update ops.outbox_events
        set state = 'published', published_at = now(), last_error_code = null
        where id = any(${published}::bigint[]) and state = 'pending'`;
    }
    if (superseded.length > 0) {
      await tx`
        update ops.outbox_events
        set state = 'superseded', last_error_code = 'superseded'
        where id = any(${superseded}::bigint[]) and state = 'pending'`;
    }
    for (const entry of failed) {
      if (entry.attempts >= MAX_PUBLISH_ATTEMPTS) {
        await tx`
          update ops.outbox_events set state = 'dead', last_error_code = ${entry.code}
          where id = ${entry.id}::bigint and state = 'pending'`;
      } else {
        await tx`
          update ops.outbox_events
          set available_at = now() + make_interval(secs => ${dispatchBackoffSeconds(entry.attempts)}),
              last_error_code = ${entry.code}
          where id = ${entry.id}::bigint and state = 'pending'`;
      }
    }
  });

  report.published = published.length;
  report.superseded = superseded.length;
  report.deadLettered = failed.filter((entry) => entry.attempts >= MAX_PUBLISH_ATTEMPTS).length;
  report.retrying = failed.length - report.deadLettered;
  return report;
}

export interface ClassDepth {
  resourceClass: string;
  ready: number;
  /** Seconds since the oldest ready item of this class became available. */
  oldestReadyAgeSeconds: number | null;
}

/**
 * Queue depth and oldest-ready-item age by class — platform spec §19's second
 * question, asked exactly the way its partial index is shaped so the answer
 * costs an index scan rather than a pass over the ledger.
 */
export async function readyWorkDepth(sql: Sql = client): Promise<ClassDepth[]> {
  const rows = await sql<{ resource_class: string; ready: number; oldest: number | null }[]>`
    select resource_class,
           count(*)::int as ready,
           max(extract(epoch from (now() - available_at)))
             filter (where available_at <= now())::int as oldest
    from ops.work_items
    where status = 'ready'
    group by resource_class
    order by resource_class`;
  return rows.map((row) => ({
    resourceClass: row.resource_class,
    ready: row.ready,
    oldestReadyAgeSeconds: row.oldest,
  }));
}

export interface OutboxHealth {
  pending: number;
  /** Seconds since the oldest due-but-unpublished row became due. */
  oldestPendingAgeSeconds: number | null;
  dead: number;
}

/** The dispatch-lag signal platform spec §19 asks for, as one bounded query. */
export async function outboxHealth(sql: Sql = client): Promise<OutboxHealth> {
  const rows = await sql<{ pending: number; oldest: number | null; dead: number }[]>`
    select
      count(*) filter (where state = 'pending')::int as pending,
      max(extract(epoch from (now() - available_at)))
        filter (where state = 'pending' and available_at <= now())::int as oldest,
      count(*) filter (where state = 'dead')::int as dead
    from ops.outbox_events`;
  return {
    pending: rows[0]?.pending ?? 0,
    oldestPendingAgeSeconds: rows[0]?.oldest ?? null,
    dead: rows[0]?.dead ?? 0,
  };
}

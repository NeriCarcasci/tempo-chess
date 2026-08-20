import { client } from "../db/client.js";
import { logSafeError } from "../security/redaction.js";
import type { LeasedWorkItem } from "./ledger.js";
import {
  cancelLeasedWorkItem,
  claimNextInProcess,
  completeWorkItem,
  failWorkItem,
  heartbeat,
  insertWorkflow,
  requestCancellation,
} from "./ledger.js";

/**
 * The ledger beside the legacy pipeline.
 *
 * The epic's migration contract is "add ledger beside legacy tasks; shadow and
 * reconcile current operations without deleting them". This module is that
 * shadow, and it is deliberately the smallest thing that makes the claim
 * checkable rather than a second execution engine.
 *
 * Two halves, with different failure rules, because they are different
 * promises:
 *
 *  - `createImportShadow` runs *inside* the transaction that creates the legacy
 *    import row. It is the durable record that the command committed, which is
 *    the whole point of the epic, so if it fails the import fails too.
 *  - `mirrorImportStatus` runs afterwards and only observes. The legacy
 *    pipeline still executes the work; a mirror that could not keep up must not
 *    take a user's analysis down with it, so it logs and returns.
 *
 * Nothing here routes work. The shadow item is `in_process` — it is claimed by
 * the runner already executing beside it, never dispatched — which is also the
 * rollback position for the whole epic: routing is a column, not a rewrite.
 */

export const SHADOW_TASK_TYPE = "legacy_import_shadow";
export const SHADOW_RESOURCE_TYPE = "analysisImport";

/** Long enough that an ordinary import never loses its lease mid-run. */
const SHADOW_TIMEOUT_SECONDS = 3_600;

const worker = {
  deployment: "forma-api-legacy-pipeline",
  revision: process.env.K_REVISION ?? null,
  instance: `${process.env.K_SERVICE ?? "local"}-${process.pid}`,
};

type Sql = typeof client;

/**
 * Record the committed import in the ledger, in the caller's transaction.
 *
 * `weight` is 1 because a legacy import is one opaque unit of work to the
 * ledger: the position-level progress lives in `analysis_imports` and this
 * epic does not migrate it. Progress on the shadow workflow is therefore
 * 0% or 100%, which is honest — a percentage copied from a legacy counter
 * would be a derived figure pretending to be a derived figure.
 */
export async function createImportShadow(
  tx: Sql,
  input: { importId: string; ownerProfileId: string },
): Promise<string> {
  const created = await insertWorkflow(tx, {
    kind: "game_import",
    ownerProfileId: input.ownerProfileId,
    resource: { type: SHADOW_RESOURCE_TYPE, id: input.importId },
    items: [
      {
        taskType: SHADOW_TASK_TYPE,
        resourceClass: "ingestion",
        idempotencyKey: `legacy_import:${input.importId}:v1`,
        inputRef: `${SHADOW_RESOURCE_TYPE}:${input.importId}`,
        dispatchMode: "in_process",
        timeoutSeconds: SHADOW_TIMEOUT_SECONDS,
        weight: 1,
      },
    ],
  });
  return created.workflowId;
}

type LegacyStatus = "queued" | "ingesting" | "analyzing" | "completed" | "failed" | "cancelled";

interface ShadowRow {
  workflow_id: string;
  item_id: string;
  status: string;
  lease_owner: string | null;
  attempt_count: number;
}

async function findShadow(importId: string, sql: Sql): Promise<ShadowRow | null> {
  const rows = await sql<ShadowRow[]>`
    select w.id as workflow_id, i.id as item_id, i.status, i.lease_owner, i.attempt_count
    from ops.workflows w
    join ops.work_items i on i.workflow_id = w.id
    where w.resource_type = ${SHADOW_RESOURCE_TYPE} and w.resource_id = ${importId}
      and i.task_type = ${SHADOW_TASK_TYPE}
    limit 1`;
  return rows[0] ?? null;
}

/**
 * Move the shadow to wherever the legacy import now is.
 *
 * It drives the item through the ordinary ledger API rather than writing the
 * status column directly, so the shadow exercises the same claim, heartbeat,
 * completion and failure paths a real worker will — which is the only reason a
 * shadow is worth having. Every transition is conditional, so calling this
 * twice for the same legacy status changes nothing the second time.
 */
export async function mirrorImportStatus(
  importId: string,
  status: LegacyStatus,
  sql: Sql = client,
): Promise<void> {
  try {
    const shadow = await findShadow(importId, sql);
    if (!shadow) return;

    if (status === "cancelled") {
      await requestCancellation(shadow.workflow_id, await ownerOf(shadow.workflow_id, sql), sql);
      if (shadow.status === "leased" && shadow.lease_owner) {
        await cancelLeasedWorkItem(
          { workItemId: shadow.item_id, leaseOwner: shadow.lease_owner, attempt: shadow.attempt_count },
          sql,
        );
      }
      return;
    }

    const leased = await ensureLeased(shadow, sql);
    if (!leased) return;

    if (status === "completed") {
      await completeWorkItem(
        {
          workItemId: leased.id,
          leaseOwner: leased.leaseOwner,
          attempt: leased.attempt,
          outputRef: `${SHADOW_RESOURCE_TYPE}:${importId}`,
        },
        sql,
      );
      return;
    }
    if (status === "failed") {
      await failWorkItem(
        {
          workItemId: leased.id,
          leaseOwner: leased.leaseOwner,
          attempt: leased.attempt,
          // The legacy pipeline has already exhausted its own retries by the
          // time it records `failed`, so a ledger retry would be a second,
          // uncoordinated retry policy over the same work.
          retryClass: "permanent",
          errorCode: "legacy_import_failed",
        },
        sql,
      );
      return;
    }
    // 'ingesting' or 'analyzing': still running. The heartbeat is what keeps the
    // lease alive across a long import, and losing it is not an error here —
    // the recovery sweep requeues the item and the next call re-claims it.
    await heartbeat(leased.id, leased.leaseOwner, sql);
  } catch (error) {
    logSafeError("legacy import shadow could not be mirrored", error);
  }
}

async function ownerOf(workflowId: string, sql: Sql): Promise<string> {
  const rows = await sql<{ owner_profile_id: string | null }[]>`
    select owner_profile_id from ops.workflows where id = ${workflowId}::uuid`;
  return rows[0]?.owner_profile_id ?? "";
}

/** Claim the shadow item if it is claimable, or describe the lease we hold. */
async function ensureLeased(shadow: ShadowRow, sql: Sql): Promise<LeasedWorkItem | null> {
  if (shadow.status === "leased" && shadow.lease_owner) {
    return {
      id: shadow.item_id,
      workflowId: shadow.workflow_id,
      taskType: SHADOW_TASK_TYPE,
      resourceClass: "ingestion",
      inputRef: null,
      payload: {},
      attempt: shadow.attempt_count,
      maxAttempts: 5,
      leaseOwner: shadow.lease_owner,
      timeoutSeconds: SHADOW_TIMEOUT_SECONDS,
    };
  }
  if (shadow.status === "ready" || shadow.status === "retry_wait") {
    return claimNextInProcess({ taskTypes: [SHADOW_TASK_TYPE], worker }, sql);
  }
  return null;
}

/**
 * Ask the legacy pipeline to stop, from a `/v1` cancellation.
 *
 * The same two statements the legacy route runs, rather than an import of the
 * pipeline module: the `/v1` route graph should not pull the engine, the
 * providers and the opening catalogue into every process that serves an API
 * request.
 */
export async function requestLegacyImportCancellation(
  importId: string,
  ownerProfileId: string,
  sql: Sql = client,
): Promise<void> {
  await sql`
    update analysis_imports set cancel_requested = true, updated_at = now()
    where id = ${importId}::uuid and user_id = ${ownerProfileId}::uuid
      and status in ('queued', 'ingesting', 'analyzing')`;
  await sql`
    update analysis_tasks set status = 'cancelled', completed_at = now(), updated_at = now()
    where import_id = ${importId}::uuid and status = 'queued'
      and exists (
        select 1 from analysis_imports i
        where i.id = ${importId}::uuid and i.user_id = ${ownerProfileId}::uuid
      )`;
}

export interface ReconciliationReport {
  legacyImports: number;
  shadowWorkflows: number;
  missingShadow: number;
  /** Legacy terminal, ledger still open, or the reverse. */
  stateDisagreements: number;
  examples: readonly { importId: string; legacyStatus: string; ledgerState: string | null }[];
}

/**
 * Compare the legacy pipeline with its shadow.
 *
 * The report is the evidence the epic asks for: it says how many committed
 * legacy operations have a durable ledger record and where the two disagree.
 * It is bounded and read-only — it never repairs, because a reconciliation that
 * silently fixes what it measures cannot be used to decide whether a cutover is
 * safe.
 */
export async function reconcileLegacyImports(sql: Sql = client): Promise<ReconciliationReport> {
  const rows = await sql<
    { import_id: string; legacy_status: string; ledger_state: string | null }[]
  >`
    select i.id as import_id, i.status::text as legacy_status, w.state as ledger_state
    from analysis_imports i
    left join ops.workflows w
      on w.resource_type = ${SHADOW_RESOURCE_TYPE} and w.resource_id = i.id::text`;

  const terminalLegacy = new Set(["completed", "failed", "cancelled"]);
  const terminalLedger = new Set(["succeeded", "failed", "cancelled"]);
  const disagreements: ReconciliationReport["examples"][number][] = [];
  let missing = 0;
  let shadowed = 0;

  for (const row of rows) {
    if (row.ledger_state === null) {
      missing += 1;
      if (disagreements.length < 10) {
        disagreements.push({
          importId: row.import_id,
          legacyStatus: row.legacy_status,
          ledgerState: null,
        });
      }
      continue;
    }
    shadowed += 1;
    if (terminalLegacy.has(row.legacy_status) !== terminalLedger.has(row.ledger_state)) {
      if (disagreements.length < 10) {
        disagreements.push({
          importId: row.import_id,
          legacyStatus: row.legacy_status,
          ledgerState: row.ledger_state,
        });
      }
    }
  }

  return {
    legacyImports: rows.length,
    shadowWorkflows: shadowed,
    missingShadow: missing,
    stateDisagreements: disagreements.filter((entry) => entry.ledgerState !== null).length,
    examples: disagreements,
  };
}

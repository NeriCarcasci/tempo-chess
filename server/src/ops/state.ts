import {
  WORK_ITEM_STATUSES,
  isTerminalWorkflowState,
  type WorkItemStatus,
  type WorkflowState,
} from "./contract.js";

/**
 * The state machines, as data.
 *
 * Platform spec §8 states the rules in prose; this file is the executable form,
 * and `0014_e04_work_ledger.sql`'s triggers are the form the database enforces
 * when a duplicate delivery or a late sweep tries to break them. Neither is
 * redundant: the trigger cannot tell a caller *why* a transition is wrong, and
 * this table cannot stop a statement written by a future call site.
 */

const WORKFLOW_TRANSITIONS: Record<WorkflowState, readonly WorkflowState[]> = {
  queued: ["running", "cancelling", "cancelled", "failed", "succeeded"],
  running: ["succeeded", "failed", "cancelling", "cancelled"],
  // A cancellation that finds no leased attempt settles immediately; one that
  // finds a leased attempt waits for it, which is why 'succeeded' and 'failed'
  // remain reachable — a handler that finished its final unit before noticing
  // the request produced a real result, and destroying it would be a lie.
  cancelling: ["cancelled", "succeeded", "failed"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

const WORK_ITEM_TRANSITIONS: Record<WorkItemStatus, readonly WorkItemStatus[]> = {
  blocked: ["ready", "cancelled"],
  ready: ["leased", "cancelled"],
  // 'ready' from 'leased' is deliberate: lease recovery requeues an abandoned
  // attempt without an intervening wait when the item still has attempts left
  // and the failure is not classified.
  leased: ["succeeded", "retry_wait", "dead", "cancelled", "ready"],
  retry_wait: ["ready", "leased", "cancelled", "dead"],
  succeeded: [],
  dead: [],
  cancelled: [],
};

export function workflowTransitionAllowed(from: WorkflowState, to: WorkflowState): boolean {
  return from === to || WORKFLOW_TRANSITIONS[from].includes(to);
}

export function workItemTransitionAllowed(from: WorkItemStatus, to: WorkItemStatus): boolean {
  return from === to || WORK_ITEM_TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(subject: string, from: string, to: string) {
    super(`invalid ${subject} transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function assertWorkflowTransition(from: WorkflowState, to: WorkflowState): void {
  if (!workflowTransitionAllowed(from, to)) throw new InvalidTransitionError("workflow", from, to);
}

export function assertWorkItemTransition(from: WorkItemStatus, to: WorkItemStatus): void {
  if (!workItemTransitionAllowed(from, to)) throw new InvalidTransitionError("work item", from, to);
}

/** One item's contribution to a workflow's progress and settlement. */
export interface ItemSnapshot {
  status: WorkItemStatus;
  weight: number;
}

/**
 * Items reduced to per-status counts and weights.
 *
 * The reduction exists so the database can produce it with one aggregate
 * instead of returning every row of a workflow that may hold hundreds of
 * items — and so there is still exactly one implementation of the rules, in
 * TypeScript, rather than a SQL `case` expression that drifts from this file.
 */
export type ItemTally = Record<WorkItemStatus, { count: number; weight: number }>;

export function emptyTally(): ItemTally {
  return {
    blocked: { count: 0, weight: 0 },
    ready: { count: 0, weight: 0 },
    leased: { count: 0, weight: 0 },
    succeeded: { count: 0, weight: 0 },
    retry_wait: { count: 0, weight: 0 },
    dead: { count: 0, weight: 0 },
    cancelled: { count: 0, weight: 0 },
  };
}

export function tally(items: readonly ItemSnapshot[]): ItemTally {
  const result = emptyTally();
  for (const item of items) {
    result[item.status].count += 1;
    result[item.status].weight += item.weight;
  }
  return result;
}

/**
 * Weighted progress, per platform spec §8: "progress is derived from item
 * weights/states, not mutable counters alone".
 *
 * Cancelled items leave both the numerator and the denominator. That keeps the
 * figure monotonic — dropping an incomplete item from the total can only raise
 * the percentage — and it keeps it honest: work that will never run is not work
 * that is still outstanding.
 *
 * `percent` is null when the total is zero, which is §2.1's "null when total
 * work is not yet known" rather than a 0% that claims we know nothing happened.
 */
export interface Progress {
  completedWeight: number;
  totalWeight: number;
  percent: number | null;
}

export function deriveProgress(items: ItemTally): Progress {
  let total = 0;
  for (const status of WORK_ITEM_STATUSES) {
    if (status === "cancelled") continue;
    total += items[status].weight;
  }
  const completed = items.succeeded.weight;
  return {
    completedWeight: completed,
    totalWeight: total,
    percent: total === 0 ? null : Math.min(100, Math.round((completed / total) * 100)),
  };
}

/**
 * The state a workflow's items say it is in.
 *
 * Derived rather than tracked, for the same reason progress is: a counter
 * updated by whichever worker finished last is a counter that disagrees with
 * the rows after a crash. The caller never *applies* a derived state that would
 * break terminal monotonicity — `workflowTransitionAllowed` is the check, and
 * the database trigger is the backstop.
 */
export function deriveWorkflowState(
  current: WorkflowState,
  items: ItemTally,
  cancelRequested: boolean,
): WorkflowState {
  if (isTerminalWorkflowState(current)) return current;

  const total = WORK_ITEM_STATUSES.reduce((sum, status) => sum + items[status].count, 0);
  if (total === 0) return current;

  const outstanding =
    items.blocked.count + items.ready.count + items.leased.count + items.retry_wait.count;
  if (outstanding > 0) {
    // The operator asked for this to stop, and every item that could stop
    // already has. What remains is a leased attempt draining.
    //
    // `current === "cancelling"` is part of the condition, not a redundancy:
    // the database makes a cancelling workflow one that has a request time, but
    // a derivation that trusted the flag alone would step a cancelling workflow
    // back to `queued` if the two were ever read apart.
    if (cancelRequested || current === "cancelling") return "cancelling";
    const started =
      items.leased.count + items.succeeded.count + items.dead.count + items.retry_wait.count > 0;
    return started || current === "running" ? "running" : "queued";
  }

  // Everything is terminal, so the workflow settles now.
  //
  // Cancellation outranks a dead item when the cancellation is what stopped the
  // work: reporting "failed" for work an operator deliberately stopped sends
  // them looking for a fault that is not there. A workflow whose items all
  // succeeded before the request landed is still 'succeeded', because §6 of the
  // API contract says cancellation does not undo already published facts.
  if (cancelRequested && items.cancelled.count > 0) return "cancelled";
  if (items.dead.count > 0) return "failed";
  if (items.cancelled.count === total) return "cancelled";
  return "succeeded";
}

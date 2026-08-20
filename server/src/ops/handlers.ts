import type { CompletionMetrics, LeasedWorkItem } from "./ledger.js";

/**
 * The handler allowlist, per plans/v1-platform-spec.md §7: the worker
 * "verifies task kind matches its allowlist".
 *
 * The registry *is* the allowlist. A deployment registers the handlers it can
 * run and nothing else, so a message routed to the wrong service cannot be
 * executed there by accident — it is dead-lettered with `unsupported`, which is
 * a routing bug an operator can see rather than a silent success in a process
 * that had no business doing the work.
 *
 * E04 registers no product handler. That is not a gap: this epic ships the
 * ledger, and provider sync, Stockfish and analysis handlers are explicitly the
 * scope of later epics. What is here is the boundary they plug into.
 */

export interface WorkCheckpoint {
  /** False when the lease was lost or the workflow was cancelled. */
  continue: boolean;
}

export interface WorkContext {
  item: LeasedWorkItem;
  traceId: string | null;
  /**
   * Called between bounded units of work. It extends the lease and reports
   * whether to carry on, which is how platform spec §8's cooperative
   * cancellation is actually cooperative: a handler that never checks is a
   * handler that cannot be cancelled.
   */
  checkpoint(): Promise<WorkCheckpoint>;
}

export interface WorkResult {
  /** A typed pointer to what was produced. Recorded before the lease is released. */
  outputRef?: string | null;
  outputSummary?: Record<string, unknown> | null;
  metrics?: CompletionMetrics;
}

export type WorkHandler = (context: WorkContext) => Promise<WorkResult>;

const handlers = new Map<string, WorkHandler>();

export function registerHandler(taskType: string, handler: WorkHandler): void {
  if (handlers.has(taskType)) throw new Error(`handler for ${taskType} is already registered`);
  handlers.set(taskType, handler);
}

export function unregisterHandler(taskType: string): void {
  handlers.delete(taskType);
}

export function handlerFor(taskType: string): WorkHandler | null {
  return handlers.get(taskType) ?? null;
}

/** What this deployment says it can run. Reported by the readiness endpoint. */
export function allowedTaskTypes(): string[] {
  return [...handlers.keys()].sort();
}

import { WorkFailure } from "./retry.js";
import {
  cancelLeasedWorkItem,
  claimWorkItem,
  completeWorkItem,
  failWorkItem,
  heartbeat,
  type ClaimRejection,
  type LeasedWorkItem,
  type WorkerIdentity,
} from "./ledger.js";
import { handlerFor, type WorkContext } from "./handlers.js";
import { logSafeError, redactError } from "../security/redaction.js";

/**
 * Run one claimed work item.
 *
 * The shape is the acknowledgement contract from plans/v1-platform-spec.md §8:
 * "queue delivery acknowledgement occurs only after the authoritative
 * work-item transition commits." Every path that returns something the caller
 * turns into a 2xx has already committed a transition. Every path that has not
 * asks the transport to try again.
 *
 * The handler runs outside any transaction. That is not an optimisation: a
 * provider or model call inside a database transaction is forbidden by the
 * epic, and it would hold a connection for the length of someone else's
 * timeout.
 */

export type ExecuteOutcome =
  | { status: "succeeded" }
  | { status: "failed"; retryClass: string; next: "retry_wait" | "dead" }
  | { status: "cancelled" }
  | { status: "noop"; reason: ClaimRejection }
  | { status: "retry_later"; afterSeconds: number }
  /** The lease was lost mid-flight; the recovery sweep owns the item now. */
  | { status: "lease_lost" };

export interface ExecuteRequest {
  workItemId: string;
  attemptToken: string;
  worker: WorkerIdentity;
  traceId?: string | null;
}

export async function executeWorkItem(request: ExecuteRequest): Promise<ExecuteOutcome> {
  const claim = await claimWorkItem({
    workItemId: request.workItemId,
    attemptToken: request.attemptToken,
    worker: request.worker,
    traceId: request.traceId ?? null,
  });
  if (claim.outcome === "noop") return { status: "noop", reason: claim.reason };
  if (claim.outcome === "retry_later") {
    return { status: "retry_later", afterSeconds: claim.afterSeconds };
  }
  return runClaimed(claim.item, request.traceId ?? null);
}

/** Run an item this process has already leased, by either claim path. */
export async function runClaimed(
  item: LeasedWorkItem,
  traceId: string | null,
): Promise<ExecuteOutcome> {
  const handler = handlerFor(item.taskType);
  if (!handler) {
    // Routed to a deployment that cannot run it. Dead rather than retried: the
    // same message would reach the same wrong service every time.
    const result = await failWorkItem({
      workItemId: item.id,
      leaseOwner: item.leaseOwner,
      attempt: item.attempt,
      retryClass: "unsupported",
      errorCode: "no_handler",
    });
    return result.applied
      ? { status: "failed", retryClass: "unsupported", next: "dead" }
      : { status: "lease_lost" };
  }

  let cancelled = false;
  const context: WorkContext = {
    item,
    traceId,
    async checkpoint() {
      const beat = await heartbeat(item.id, item.leaseOwner);
      if (!beat.held || beat.cancelRequested) cancelled = true;
      return { continue: beat.held && !beat.cancelRequested };
    },
  };

  try {
    const result = await handler(context);
    if (cancelled) {
      const stopped = await cancelLeasedWorkItem({
        workItemId: item.id,
        leaseOwner: item.leaseOwner,
        attempt: item.attempt,
      });
      return stopped.applied ? { status: "cancelled" } : { status: "lease_lost" };
    }
    const completion = await completeWorkItem({
      workItemId: item.id,
      leaseOwner: item.leaseOwner,
      attempt: item.attempt,
      outputRef: result.outputRef ?? null,
      outputSummary: result.outputSummary ?? null,
      metrics: result.metrics,
    });
    return completion.applied ? { status: "succeeded" } : { status: "lease_lost" };
  } catch (error) {
    // A handler that threw something other than a `WorkFailure` did not say
    // whether a retry could work. `transient` is the safe reading: the attempt
    // ceiling still stops it, and the alternative silently abandons work on the
    // first unexpected exception.
    // The detail is the redacted throw site, not `null`.
    //
    // A `WorkFailure` names itself; anything else used to record the code
    // `handler_error` and nothing more, so an item that exhausted five attempts
    // left behind no trace of what threw. The only record was one
    // `console.error` per attempt, which is gone the moment a log buffer rolls
    // -- and on a dead item that is precisely when somebody comes looking.
    //
    // `redactError` is already the safe form: an error's name, its class and
    // the throw site, never its message, its cause's message, or anything a
    // provider or a payload put in it. That is exactly what an operator needs
    // to find the line and nothing a reader would ever see -- the detail is not
    // rendered on any screen.
    const failure =
      error instanceof WorkFailure
        ? error
        : new WorkFailure("transient", "handler_error", redactError(error), null);
    if (!(error instanceof WorkFailure)) logSafeError("work handler failed", error);

    const result = await failWorkItem({
      workItemId: item.id,
      leaseOwner: item.leaseOwner,
      attempt: item.attempt,
      retryClass: failure.retryClass,
      errorCode: failure.code,
      errorDetail: failure.detail,
      retryAfterSeconds: failure.retryAfterSeconds,
    });
    if (!result.applied) return { status: "lease_lost" };
    return { status: "failed", retryClass: failure.retryClass, next: result.status! };
  }
}

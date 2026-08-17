import { sign, signatureMatches, type KernelEnv } from "../v1/signing.js";

/**
 * The attempt token, and the Cloud Tasks payload it travels in.
 *
 * Platform spec §7 fixes the payload: `workItemId`, `attemptToken`, and trace
 * metadata. No PGN, no FEN list, no model output, no email, no provider
 * credential, and — the one people forget — no authorization truth. The worker
 * does not learn who owns the work from the message; it loads that from
 * Postgres after it has claimed the row.
 *
 * The token binds the work item to a *dispatch epoch*. Cloud Tasks is
 * at-least-once, and an item that failed, backed off and was dispatched again
 * has two live messages in the world. Without the epoch both would be equally
 * valid and the retry could run twice; with it, the superseded message
 * identifies itself as stale and is acknowledged without executing.
 *
 * The token is not authentication. The caller is authenticated by Google-signed
 * OIDC at the ingress; the token says *which* attempt this delivery is for, and
 * the conditional claim in the database is what actually prevents two workers
 * from running the same item.
 */

export interface AttemptTokenScope {
  workItemId: string;
  dispatchEpoch: number;
}

export function attemptToken(scope: AttemptTokenScope, env?: KernelEnv): string {
  return sign("attempt-token", [scope.workItemId, String(scope.dispatchEpoch)], env);
}

export function attemptTokenMatches(
  scope: AttemptTokenScope,
  presented: string,
  env?: KernelEnv,
): boolean {
  return signatureMatches(attemptToken(scope, env), presented);
}

/** Exactly the fields platform spec §7 allows on the wire. */
export interface TaskPayload {
  workItemId: string;
  attemptToken: string;
  /** W3C trace context, so the attempt joins the trace that created it. */
  traceparent?: string;
}

export const TASK_PAYLOAD_FIELDS = ["workItemId", "attemptToken", "traceparent"] as const;

export function buildTaskPayload(
  scope: AttemptTokenScope,
  traceparent?: string | null,
  env?: KernelEnv,
): TaskPayload {
  const payload: TaskPayload = {
    workItemId: scope.workItemId,
    attemptToken: attemptToken(scope, env),
  };
  if (traceparent) payload.traceparent = traceparent;
  return payload;
}

/**
 * Refuse a payload carrying anything else.
 *
 * A guard rather than a comment, because the way a PGN ends up in a queue
 * message is someone adding a "small" field to a builder in an unrelated epic.
 * The dispatcher runs this on every message it sends.
 */
export function assertMinimalTaskPayload(payload: Record<string, unknown>): void {
  const extra = Object.keys(payload).filter(
    (key) => !(TASK_PAYLOAD_FIELDS as readonly string[]).includes(key),
  );
  if (extra.length > 0) {
    throw new Error(
      `task payload may only carry ${TASK_PAYLOAD_FIELDS.join(", ")}; found ${extra.join(", ")}`,
    );
  }
}

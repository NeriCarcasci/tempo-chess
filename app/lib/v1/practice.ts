/**
 * The practice loop's client: queue, attempt, refill.
 *
 * Three rules from `docs/frontend/pages.md#practice`, kept here so no screen
 * has to remember them:
 *
 *   * the queue never contains the solution — it arrives only in the attempt's
 *     response, after the person has committed;
 *   * `clientAttemptId` is generated once per attempt and reused on retry,
 *     because the endpoint is idempotent on it and a double submission must
 *     not double-advance the schedule;
 *   * a revealed answer is never a success, whatever move follows it.
 */

import { newIdempotencyKey, v1 } from "./client";
import type { PracticeAttempt, PracticeItem, PracticeQueue, PracticeRefill } from "./types";

export type { PracticeAttempt, PracticeItem, PracticeQueue, PracticeRefill };

export async function getPracticeQueue(): Promise<PracticeQueue> {
  return (await v1<PracticeQueue>("/v1/practice/queue")).data;
}

export async function refillPractice(): Promise<PracticeRefill> {
  return (
    await v1<PracticeRefill>("/v1/practice/refill", {
      method: "POST",
      json: {},
      idempotencyKey: newIdempotencyKey(),
    })
  ).data;
}

export interface AttemptInput {
  assignmentId: string;
  /** One id per attempt, reused across retries of the same submission. */
  clientAttemptId: string;
  moves: string[];
  responseTimeMs?: number;
  hintsUsed?: number;
  revealed?: boolean;
}

/**
 * Record one attempt. The response is the only place the expected moves exist
 * client-side, which is what makes the drill a test rather than a rendering of
 * its own answer.
 */
export async function recordAttempt(input: AttemptInput): Promise<PracticeAttempt> {
  return (
    await v1<PracticeAttempt>("/v1/practice/attempts", {
      method: "POST",
      json: input,
      // The idempotency key and the attempt id carry the same intent: one
      // submission. Reusing the attempt id keeps the two in step on a retry.
      idempotencyKey: input.clientAttemptId,
    })
  ).data;
}

/**
 * Giving up, as an attempt.
 *
 * The queue never ships the solution, so "show me" has to ask the server, and
 * the only honest way to ask is an attempt marked `revealed` — which the
 * server records as not a success whatever moves travel with it. The literal
 * move is a placeholder the schema accepts; the flag is the content.
 */
export async function revealAnswer(
  assignmentId: string,
  clientAttemptId: string,
): Promise<PracticeAttempt> {
  return recordAttempt({
    assignmentId,
    clientAttemptId,
    moves: ["0000"],
    revealed: true,
  });
}

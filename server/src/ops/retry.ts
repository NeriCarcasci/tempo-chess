import { createHmac } from "node:crypto";
import { RETRY_CLASSES, type RetryClass } from "./contract.js";

/**
 * Retry classification and durable backoff, per plans/v1-platform-spec.md §8.
 *
 * The classification is the interesting half. "Retry on failure" spends money
 * and provider budget re-running work that cannot succeed — an unsupported
 * variant is unsupported on the fifth attempt too — so the class decides
 * whether there is a next attempt at all, and only then does the backoff decide
 * when.
 *
 * The backoff is deterministic. Jitter matters (a hundred items failing on one
 * provider outage must not return together), but `Math.random()` would make a
 * failed attempt unreproducible in an incident review, so the spread is derived
 * from the item identity and the attempt number instead. Same item, same
 * attempt, same delay, every time — and different items on the same tick get
 * different delays, which is the entire purpose of jitter.
 */

/** Whether a class permits another attempt at all. */
export type RetryableClass = Extract<RetryClass, "transient" | "rate_limit">;

export function isRetryable(retryClass: RetryClass): retryClass is RetryableClass {
  return retryClass === "transient" || retryClass === "rate_limit";
}

export interface BackoffPolicy {
  baseSeconds: number;
  factor: number;
  maxSeconds: number;
  /** Fraction of the computed delay the deterministic spread may add. */
  jitterFraction: number;
}

/**
 * Transient failures return quickly; a rate limit does not. Platform spec §7
 * puts a Lichess 429 at ">=60s", so the rate-limit floor is that number rather
 * than a general-purpose two seconds that would walk straight back into the
 * limit.
 */
export const BACKOFF: Readonly<Record<RetryableClass, BackoffPolicy>> = {
  transient: { baseSeconds: 2, factor: 2, maxSeconds: 900, jitterFraction: 0.25 },
  rate_limit: { baseSeconds: 60, factor: 2, maxSeconds: 1_800, jitterFraction: 0.25 },
};

/** A stable fraction in [0, 1) from the item identity and attempt number. */
function deterministicSpread(workItemId: string | number, attempt: number): number {
  const digest = createHmac("sha256", "forma-ops-backoff")
    .update(`${workItemId}:${attempt}`)
    .digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

export interface BackoffInput {
  workItemId: string | number;
  /** The attempt that just failed, 1-based. */
  attempt: number;
  retryClass: RetryClass;
  /** A provider's own `Retry-After`, when it gave one. Seconds. */
  retryAfterSeconds?: number | null;
}

/**
 * Seconds until the next attempt may run.
 *
 * A provider that told us how long to wait is believed over our own curve, but
 * only upwards and only to the policy ceiling: a `Retry-After: 0` is not a
 * licence to hammer, and a `Retry-After: 86400` must not park an item for a day
 * without an operator seeing it as a dead letter first.
 */
export function backoffSeconds(input: BackoffInput): number {
  if (!isRetryable(input.retryClass)) {
    throw new Error(`retry class ${input.retryClass} does not schedule another attempt`);
  }
  const policy = BACKOFF[input.retryClass];
  const exponential = policy.baseSeconds * policy.factor ** Math.max(0, input.attempt - 1);
  const capped = Math.min(policy.maxSeconds, exponential);
  const floor =
    input.retryAfterSeconds != null && Number.isFinite(input.retryAfterSeconds)
      ? Math.min(policy.maxSeconds, Math.max(0, input.retryAfterSeconds))
      : 0;
  const base = Math.max(capped, floor);
  const spread = base * policy.jitterFraction * deterministicSpread(input.workItemId, input.attempt);
  return Math.round(base + spread);
}

export interface FailureDecision {
  /** `retry_wait` schedules another attempt; `dead` never runs again. */
  status: "retry_wait" | "dead";
  delaySeconds: number;
}

/**
 * What a failed attempt does to the item.
 *
 * The exhaustion rule is stated once, here, rather than at each call site: an
 * item that has spent its attempts is dead even when the class is retryable,
 * and an item whose class is not retryable is dead on the first attempt even
 * when attempts remain.
 */
export function classifyFailure(input: BackoffInput & { maxAttempts: number }): FailureDecision {
  if (!isRetryable(input.retryClass) || input.attempt >= input.maxAttempts) {
    return { status: "dead", delaySeconds: 0 };
  }
  return { status: "retry_wait", delaySeconds: backoffSeconds(input) };
}

/**
 * Read a class off an untrusted string.
 *
 * A worker reporting an unrecognised class is a bug in the worker, and the safe
 * reading of "I do not know why this failed" is `transient`: it retries, so the
 * work is not silently abandoned, and the attempt ceiling still stops it.
 */
export function toRetryClass(value: unknown): RetryClass {
  return (RETRY_CLASSES as readonly string[]).includes(value as string)
    ? (value as RetryClass)
    : "transient";
}

/** The one error a handler throws to name its own failure class. */
export class WorkFailure extends Error {
  constructor(
    readonly retryClass: RetryClass,
    readonly code: string,
    /** A short operator-facing detail. Never a provider body or a payload. */
    readonly detail: string | null = null,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(`${retryClass}:${code}`);
    this.name = "WorkFailure";
  }
}

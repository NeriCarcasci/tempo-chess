import { BILLING_POLICY, type BillingPolicy, type ReleaseReason } from "./contract.js";
import type { Resolution } from "./resolve.js";

/**
 * Reserving, settling and releasing quota.
 *
 * The shape is a two-phase reservation rather than a counter, for one reason:
 * work fails. A person whose analysis crashed should not have paid for it out
 * of their monthly allowance, and a counter incremented at the start cannot
 * give it back without a compensating write that somebody has to remember.
 *
 * Every decision here is pure. The atomicity lives in the ledger's unique
 * constraint on `(user, feature, idempotency_key)` and in the conditional write
 * the caller performs; this module decides *whether* and *why*.
 */

export interface LedgerEntry {
  state: "reserved" | "settled" | "released";
  quantity: number;
  occurredAt: Date;
}

export interface ReservationRequest {
  featureKey: string;
  quantity: number;
  /** The caller's own key. Two attempts at one unit of work share it. */
  idempotencyKey: string;
}

export type ReservationDecision =
  | { allowed: true; remainingAfter: number | null }
  | { allowed: false; code: "quota_exhausted"; limit: number; used: number; resetsAt: Date | null }
  | { allowed: false; code: "feature_unavailable"; detail: string };

/**
 * What is already consumed in the window.
 *
 * Reserved and settled both count; released does not. Counting a released
 * reservation would mean a failed job permanently cost somebody a game, which
 * is the exact failure the two-phase shape exists to avoid.
 */
export function consumed(entries: readonly LedgerEntry[]): number {
  return entries
    .filter((entry) => entry.state !== "released")
    .reduce((sum, entry) => sum + entry.quantity, 0);
}

/**
 * Whether a reservation may proceed.
 *
 * A limit of zero is a denial rather than an exhausted quota, and says so: "you
 * have used all ten" and "this is not part of your plan" are different messages
 * and lead to different next actions.
 */
export function mayReserve(input: {
  request: ReservationRequest;
  resolution: Resolution;
  existing: readonly LedgerEntry[];
  windowResetsAt: Date | null;
}): ReservationDecision {
  const limit = input.resolution.limit;
  if (limit === 0) {
    return {
      allowed: false,
      code: "feature_unavailable",
      detail: "this is not part of your plan",
    };
  }
  if (limit === null) return { allowed: true, remainingAfter: null };

  const used = consumed(input.existing);
  if (used + input.request.quantity > limit) {
    return {
      allowed: false,
      code: "quota_exhausted",
      limit,
      used,
      resetsAt: input.windowResetsAt,
    };
  }
  return { allowed: true, remainingAfter: limit - used - input.request.quantity };
}

/**
 * Reservations old enough to release.
 *
 * A worker that died mid-job leaves a reservation behind. Without this sweep it
 * would consume somebody's quota until the billing window rolled over, which
 * from their side is indistinguishable from being charged for nothing.
 */
export function expiredReservations(
  entries: readonly (LedgerEntry & { id: string })[],
  now: Date,
  policy: BillingPolicy = BILLING_POLICY,
): { id: string; reason: ReleaseReason }[] {
  const cutoff = new Date(now.getTime() - policy.reservationTtlMinutes * 60_000);
  return entries
    .filter((entry) => entry.state === "reserved" && entry.occurredAt < cutoff)
    .map((entry) => ({ id: entry.id, reason: "reservation_expired" as const }));
}

/** The billing window a moment belongs to. Calendar months, in UTC. */
export function billingWindow(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/** When the current window rolls over. What a user is told to wait for. */
export function windowResetsAt(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
}

export interface UsageProjection {
  featureKey: string;
  limit: number | null;
  used: number;
  remaining: number | null;
  resetsAt: Date | null;
}

/**
 * The counter the product shows.
 *
 * A projection over the ledger rather than a stored number, so it cannot drift
 * from what was actually charged. If the two ever disagree, the ledger is
 * right and the number on the screen is a bug — which is only a meaningful
 * statement if the number on the screen is derived.
 */
export function projectUsage(input: {
  featureKey: string;
  resolution: Resolution;
  entries: readonly LedgerEntry[];
  at: Date;
}): UsageProjection {
  const used = consumed(input.entries);
  const limit = input.resolution.limit;
  return {
    featureKey: input.featureKey,
    limit,
    used,
    remaining: limit === null ? null : Math.max(0, limit - used),
    resetsAt: limit === null ? null : windowResetsAt(input.at),
  };
}

/**
 * What a user is told when a reservation is refused.
 *
 * Never a dead end: platform spec asks for truthful states that are also
 * actionable, and "you have hit a limit" without a date or an alternative is
 * neither.
 */
export function describeRefusal(decision: ReservationDecision): string | null {
  if (decision.allowed) return null;
  if (decision.code === "feature_unavailable") {
    return "This is part of a paid plan. Nothing already in your account changes.";
  }
  const resets = decision.resetsAt
    ? ` This resets on ${decision.resetsAt.toISOString().slice(0, 10)}.`
    : "";
  return `You have used ${decision.used} of ${decision.limit} this month.${resets}`;
}

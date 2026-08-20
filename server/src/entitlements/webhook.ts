import { createHmac, timingSafeEqual } from "node:crypto";

import { BILLING_POLICY, type BillingPolicy } from "./contract.js";

/**
 * Verifying and ordering billing webhooks.
 *
 * Three properties, each of which has burned somebody:
 *
 * 1. **The signature is checked against the raw body.** Parsing first and
 *    re-serializing changes bytes, and a signature that passes over
 *    re-serialized JSON is a signature that proves nothing.
 * 2. **Redelivery is harmless.** Providers retry, and the same event arrives
 *    two or five times. The unique constraint on `(provider, external_event_id)`
 *    is what makes that safe; this module's job is to recognise it rather than
 *    to fail.
 * 3. **Arrival order is not truth.** Events overtake each other. A
 *    `subscription.updated` describing yesterday's state can land after one
 *    describing today's, and a system that applies the last one to arrive will
 *    downgrade somebody who has just paid.
 */

export interface SignatureCheck {
  valid: boolean;
  reason: string | null;
}

/**
 * Verify a Stripe-style `t=...,v1=...` signature over the raw body.
 *
 * Compared with `timingSafeEqual`, and the timestamp is checked against a
 * tolerance so a captured request cannot be replayed a week later.
 */
export function verifySignature(input: {
  rawBody: string;
  header: string;
  secret: string;
  now: Date;
  policy?: BillingPolicy;
}): SignatureCheck {
  const policy = input.policy ?? BILLING_POLICY;
  const parts = new Map<string, string[]>();
  for (const segment of input.header.split(",")) {
    const [key, value] = segment.split("=");
    if (!key || value === undefined) continue;
    parts.set(key.trim(), [...(parts.get(key.trim()) ?? []), value.trim()]);
  }

  const timestamp = parts.get("t")?.[0];
  const signatures = parts.get("v1") ?? [];
  if (!timestamp || signatures.length === 0) {
    return { valid: false, reason: "malformed_signature_header" };
  }

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) return { valid: false, reason: "malformed_timestamp" };
  const ageSeconds = Math.abs(input.now.getTime() / 1000 - sentAt);
  if (ageSeconds > policy.webhookToleranceSeconds) {
    // A captured request replayed later. The signature is genuine and the
    // request is not.
    return { valid: false, reason: "timestamp_outside_tolerance" };
  }

  const expected = createHmac("sha256", input.secret)
    .update(`${timestamp}.${input.rawBody}`)
    .digest("hex");
  const expectedBuffer = Buffer.from(expected, "utf8");

  for (const candidate of signatures) {
    const candidateBuffer = Buffer.from(candidate, "utf8");
    if (
      candidateBuffer.length === expectedBuffer.length &&
      timingSafeEqual(candidateBuffer, expectedBuffer)
    ) {
      return { valid: true, reason: null };
    }
  }
  return { valid: false, reason: "signature_mismatch" };
}

export interface IncomingEvent {
  externalEventId: string;
  eventType: string;
  providerCreatedAt: Date;
  /** The provider's own version of the object this event describes. */
  objectVersion: Date;
  externalSubscriptionId: string | null;
}

export interface StoredSubscription {
  externalSubscriptionId: string;
  providerObjectVersion: Date;
}

export type EventDecision =
  | { action: "apply"; reason: string }
  | { action: "ignore"; reason: string }
  | { action: "duplicate"; reason: string };

/**
 * What to do with an event, given what is already stored.
 *
 * `ignore` rather than `apply` for a stale event, and it is recorded as
 * processed rather than failed: the event was handled correctly, and what it
 * described was simply older than what we already knew.
 */
export function decideEvent(input: {
  event: IncomingEvent;
  alreadySeen: boolean;
  current: StoredSubscription | null;
}): EventDecision {
  if (input.alreadySeen) {
    return { action: "duplicate", reason: "this event has already been received" };
  }
  if (input.current === null) return { action: "apply", reason: "nothing is stored yet" };
  if (input.event.externalSubscriptionId !== input.current.externalSubscriptionId) {
    return { action: "apply", reason: "a different subscription" };
  }
  if (input.event.objectVersion > input.current.providerObjectVersion) {
    return { action: "apply", reason: "newer than what is stored" };
  }
  // Equal counts as stale: re-applying an identical version is harmless but
  // pointless, and treating it as newer would let two events with the same
  // stamp ping-pong the record.
  return {
    action: "ignore",
    reason: "an event describing state at or before what is already stored",
  };
}

export interface ReconciliationDrift {
  externalSubscriptionId: string;
  field: "status" | "current_period_end" | "cancel_at_period_end" | "missing_locally";
  local: string | null;
  provider: string | null;
}

export interface LocalSubscription {
  externalSubscriptionId: string;
  status: string;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

/**
 * Compare what we believe against what the provider says.
 *
 * Run daily, because webhooks are best-effort. A missed `canceled` leaves
 * somebody entitled to something they stopped paying for; a missed `active`
 * leaves a paying customer locked out, which is the worse of the two and the
 * one nobody notices until they complain.
 *
 * This reports drift and does not fix it. Applying a correction is a decision
 * with a person's money attached, and it belongs in a handler that can log it.
 */
export function reconcile(
  local: readonly LocalSubscription[],
  provider: readonly LocalSubscription[],
): ReconciliationDrift[] {
  const byId = new Map(local.map((row) => [row.externalSubscriptionId, row]));
  const drift: ReconciliationDrift[] = [];

  for (const remote of provider) {
    const ours = byId.get(remote.externalSubscriptionId);
    if (!ours) {
      drift.push({
        externalSubscriptionId: remote.externalSubscriptionId,
        field: "missing_locally",
        local: null,
        provider: remote.status,
      });
      continue;
    }
    if (ours.status !== remote.status) {
      drift.push({
        externalSubscriptionId: remote.externalSubscriptionId,
        field: "status",
        local: ours.status,
        provider: remote.status,
      });
    }
    if (ours.cancelAtPeriodEnd !== remote.cancelAtPeriodEnd) {
      drift.push({
        externalSubscriptionId: remote.externalSubscriptionId,
        field: "cancel_at_period_end",
        local: String(ours.cancelAtPeriodEnd),
        provider: String(remote.cancelAtPeriodEnd),
      });
    }
    const localEnd = ours.currentPeriodEnd?.toISOString() ?? null;
    const remoteEnd = remote.currentPeriodEnd?.toISOString() ?? null;
    if (localEnd !== remoteEnd) {
      drift.push({
        externalSubscriptionId: remote.externalSubscriptionId,
        field: "current_period_end",
        local: localEnd,
        provider: remoteEnd,
      });
    }
  }

  return drift.sort(
    (a, b) =>
      a.externalSubscriptionId.localeCompare(b.externalSubscriptionId) ||
      a.field.localeCompare(b.field),
  );
}

/**
 * The fields of a webhook payload that may be logged.
 *
 * Everything else is dropped. A Stripe event body carries the last four digits
 * of a card, a billing address and an email; none of that belongs in a log
 * pipeline, and an allowlist is the only version of this rule that survives
 * somebody adding a debug line at 2am.
 */
export const LOGGABLE_EVENT_FIELDS = [
  "id",
  "type",
  "created",
  "livemode",
  "api_version",
] as const;

export function sanitizeEvent(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of LOGGABLE_EVENT_FIELDS) {
    if (field in payload) out[field] = payload[field];
  }
  return out;
}

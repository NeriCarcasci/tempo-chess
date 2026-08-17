/**
 * Structured operational events for the work ledger, per
 * plans/v1-platform-spec.md §19.
 *
 * Same discipline as `v1/telemetry.ts`: a closed field list and a serializer
 * that knows only those fields, so a field nobody thought about cannot leak.
 * Identifiers are opaque ledger ids — §19 asks "what failed permanently and for
 * whom (opaque IDs only)" — and the payload, the input reference, the owner and
 * the error detail are absent by construction rather than by filtering.
 *
 * The questions these answer are §19's, in order: queue depth and oldest ready
 * age, dispatch lag, attempts and retry class, lease expiry, duplicate
 * delivery, dead letters, cancellation, and trace continuity.
 */

export interface WorkItemEvent {
  event: "work_item_transition";
  traceId: string | null;
  workItemId: string;
  workflowId: string;
  taskType: string;
  resourceClass: string;
  from: string;
  to: string;
  attempt: number;
  maxAttempts: number;
  retryClass: string | null;
  errorCode: string | null;
  durationMs: number | null;
  /** True when this delivery found the work already claimed or already done. */
  duplicateDelivery: boolean;
}

export interface WorkflowEvent {
  event: "workflow_state";
  traceId: string | null;
  workflowId: string;
  kind: string;
  state: string;
  percent: number | null;
  cancelRequested: boolean;
}

export interface DispatchEvent {
  event: "outbox_dispatch";
  traceId: string | null;
  claimed: number;
  published: number;
  duplicates: number;
  superseded: number;
  retrying: number;
  deadLettered: number;
  pending: number;
  oldestPendingAgeSeconds: number | null;
  durationMs: number;
}

export interface RecoveryEvent {
  event: "lease_recovery";
  traceId: string | null;
  examined: number;
  reconciledSucceeded: number;
  requeued: number;
  deadLettered: number;
  durationMs: number;
}

export interface WorkDepthEvent {
  event: "work_depth";
  traceId: string | null;
  resourceClass: string;
  ready: number;
  oldestReadyAgeSeconds: number | null;
}

export type OpsEvent =
  | WorkItemEvent
  | WorkflowEvent
  | DispatchEvent
  | RecoveryEvent
  | WorkDepthEvent;

/** Every key an ops event may emit. The security gate asserts against this. */
export const OPS_EVENT_FIELDS = {
  work_item_transition: [
    "event", "traceId", "workItemId", "workflowId", "taskType", "resourceClass",
    "from", "to", "attempt", "maxAttempts", "retryClass", "errorCode", "durationMs",
    "duplicateDelivery",
  ],
  workflow_state: ["event", "traceId", "workflowId", "kind", "state", "percent", "cancelRequested"],
  outbox_dispatch: [
    "event", "traceId", "claimed", "published", "duplicates", "superseded", "retrying",
    "deadLettered", "pending", "oldestPendingAgeSeconds", "durationMs",
  ],
  lease_recovery: [
    "event", "traceId", "examined", "reconciledSucceeded", "requeued", "deadLettered", "durationMs",
  ],
  work_depth: ["event", "traceId", "resourceClass", "ready", "oldestReadyAgeSeconds"],
} as const satisfies Record<OpsEvent["event"], readonly string[]>;

export function opsEventLine(event: OpsEvent): string {
  const allowed = OPS_EVENT_FIELDS[event.event] as readonly string[];
  const out: Record<string, unknown> = {};
  const source = event as unknown as Record<string, unknown>;
  for (const field of allowed) out[field] = source[field] ?? null;
  return JSON.stringify(out);
}

let sink: (line: string) => void = (line) => console.log(line);

/** Test seam: capture lines instead of printing them. */
export function setOpsEventSink(next: ((line: string) => void) | null): void {
  sink = next ?? ((line) => console.log(line));
}

export function recordOpsEvent(event: OpsEvent): void {
  sink(opsEventLine(event));
}

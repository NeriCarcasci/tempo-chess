import { client } from "../db/client.js";
import { logSafeError } from "../security/redaction.js";

/**
 * Append-only security audit, per plans/database-architecture.md §14.8.
 *
 * This is not the request log. The request log answers "what is the service
 * doing"; an audit row answers "who was refused what, and when" — the questions
 * asked after an incident, when the request log has already rotated.
 *
 * §14.8's constraint is that rows are content-free: they carry opaque
 * references and reason codes, never the thing that was refused. That is
 * enforced by the shape of this module — `metadata` takes scalars from a closed
 * set of call sites, and there is no path that accepts a request body.
 *
 * `ops.audit_events` grants the API role `insert` and `select` and nothing
 * else, so a row cannot be rewritten by the process that wrote it.
 */

export type AuditActorKind = "user" | "anonymous" | "service" | "system";
export type AuditResult = "allowed" | "denied" | "error";

/** The recorded actions. A new action is a code change, not a free string. */
export type AuditAction =
  | "auth.token_rejected"
  | "auth.subject_denied"
  | "command.idempotency_conflict"
  | "request.rate_limited"
  // E04.
  | "internal.caller_rejected"
  | "workflow.access_denied"
  | "workflow.cancel_requested"
  | "work_item.stale_delivery"
  // E11.
  | "game.access_denied"
  // E12.
  | "game_review.access_denied"
  | "game_analysis.access_denied"
  // E16.
  | "onboarding.access_denied"
  | "diagnostic_attempt.rejected";

export interface AuditEvent {
  actorKind: AuditActorKind;
  /** Opaque profile reference, or null when there is no verified actor. */
  actorRef?: string | null;
  action: AuditAction;
  targetType?: string | null;
  targetRef?: string | null;
  requestId: string;
  traceId?: string | null;
  result: AuditResult;
  reasonCode?: string | null;
  /** Scalars only. Anything else is dropped rather than serialized. */
  metadata?: Record<string, string | number | boolean>;
}

/** Drop anything that is not a plain scalar, and cap the row's size. */
function safeMetadata(input: AuditEvent["metadata"]): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!input) return out;
  for (const [key, value] of Object.entries(input)) {
    const type = typeof value;
    if (type !== "string" && type !== "number" && type !== "boolean") continue;
    if (type === "number" && !Number.isFinite(value as number)) continue;
    out[key.slice(0, 48)] = type === "string" ? (value as string).slice(0, 128) : value;
  }
  return out;
}

/**
 * Write one audit row.
 *
 * Failure to audit never fails the request. That is a deliberate trade: the
 * alternative is a database hiccup turning every authorization denial into a
 * `500`, which would make an outage look like a security event. The failure is
 * logged through the redaction layer so it is still visible.
 */
export async function recordAuditEvent(event: AuditEvent, sql = client): Promise<void> {
  try {
    // Encoded here rather than through the driver's `json` helper, and cast
    // `::text::jsonb` rather than `::jsonb`: postgres.js reads the trailing
    // cast to pick a serializer, and a bare `::jsonb` makes it JSON-encode the
    // string we already encoded — which would store the *string* "{}" and fail
    // this column's `jsonb_typeof(...) = 'object'` constraint.
    await sql`
      insert into ops.audit_events (
        actor_kind, actor_ref, action, target_type, target_ref,
        request_id, trace_id, result, reason_code, metadata
      ) values (
        ${event.actorKind}, ${event.actorRef ?? null}, ${event.action},
        ${event.targetType ?? null}, ${event.targetRef ?? null},
        ${event.requestId}, ${event.traceId ?? null}, ${event.result},
        ${event.reasonCode ?? null}, ${JSON.stringify(safeMetadata(event.metadata))}::text::jsonb
      )`;
  } catch (error) {
    logSafeError("audit event could not be written", error);
  }
}

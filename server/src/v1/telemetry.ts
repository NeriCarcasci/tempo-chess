import type { ProblemCode } from "./problem.js";
import type { IdempotencyOutcome } from "./idempotency.js";
import type { RateLimitStatus } from "./rate-limit.js";

/**
 * One structured line per request, per plans/v1-platform-spec.md §19.
 *
 * The field list is closed and the serializer only knows about these fields.
 * That is the whole design: an allowlist cannot leak a field nobody thought
 * about, whereas "log the request and strip the secrets" leaks the first thing
 * that does not match a pattern — which is the lesson E01 already learned in
 * `security/redaction.ts`.
 *
 * Absent by construction, not by filtering: tokens, emails, request bodies,
 * PGN/FEN, signed URLs, client addresses, subject and actor identifiers, and
 * exception messages. `actorPresent` is a boolean because "was this
 * authenticated" is an operational question and "who was it" is not.
 */

export type ApiSurface = "v1" | "legacy";
export type AuthMode = "anonymous" | "jwks" | "fallback";

export interface RequestObservation {
  requestId: string;
  traceId: string;
  /** The registered route template, never the raw path: paths carry ids. */
  route: string;
  method: string;
  status: number;
  durationMs: number;
  surface: ApiSurface;
  authMode: AuthMode;
  actorPresent: boolean;
  problemCode: ProblemCode | null;
  idempotency: IdempotencyOutcome | "none";
  cursorRejected: boolean;
  rateLimit: RateLimitStatus;
  redactions: number;
  deprecated: boolean;
}

/** Build the line. Exported separately so a test can assert the field set. */
export function observationLine(observation: RequestObservation): string {
  return JSON.stringify({
    event: "http_request",
    requestId: observation.requestId,
    traceId: observation.traceId,
    route: observation.route,
    method: observation.method,
    status: observation.status,
    durationMs: Math.round(observation.durationMs),
    surface: observation.surface,
    authMode: observation.authMode,
    actorPresent: observation.actorPresent,
    problemCode: observation.problemCode,
    idempotency: observation.idempotency,
    cursorRejected: observation.cursorRejected,
    rateLimit: observation.rateLimit,
    redactions: observation.redactions,
    deprecated: observation.deprecated,
  });
}

/** Every key `observationLine` may emit. The security gate asserts against this. */
export const OBSERVATION_FIELDS = [
  "event",
  "requestId",
  "traceId",
  "route",
  "method",
  "status",
  "durationMs",
  "surface",
  "authMode",
  "actorPresent",
  "problemCode",
  "idempotency",
  "cursorRejected",
  "rateLimit",
  "redactions",
  "deprecated",
] as const;

let sink: (line: string) => void = (line) => console.log(line);

/** Test seam: capture lines instead of printing them. */
export function setObservationSink(next: ((line: string) => void) | null): void {
  sink = next ?? ((line) => console.log(line));
}

export function observeRequest(observation: RequestObservation): void {
  sink(observationLine(observation));
}

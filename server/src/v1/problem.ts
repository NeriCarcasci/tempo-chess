import { CuratedError, safeClientMessage } from "../security/redaction.js";

/**
 * `application/problem+json` for `/v1`, per plans/v1-api-contract.md §1.3.
 *
 * The code table is closed. A handler chooses a code from this list or it does
 * not produce a problem at all — which is what stops the prototype's habit of
 * mapping an unrelated exception onto whatever status was nearest (audit §10).
 * Status, title, and retryability are properties of the code, not decisions a
 * call site makes, so two endpoints cannot disagree about what `CONFLICT` means.
 *
 * Nothing here formats an exception. `detail` is either a string written for the
 * caller or absent; the E01 redaction allowlist is the only thing allowed to
 * turn a thrown value into caller-visible text.
 */

export const PROBLEM_TYPE_BASE = "https://docs.formachess.com/problems";

interface CodeSpec {
  readonly status: number;
  readonly title: string;
  readonly retryable: boolean;
}

/**
 * §1.3's list plus three codes it leaves undefined. `IDEMPOTENCY_IN_PROGRESS`
 * is not `IDEMPOTENCY_CONFLICT`: the first says "your own retry arrived before
 * the original finished", the second says "this key already means something
 * else", and a client's correct reaction differs. The two precondition codes
 * are what §1.6's `If-Match` rule needs to be expressible at all. §1.3 says
 * codes "include" its list, so this is additive.
 */
export const PROBLEM_CODES = {
  AUTH_REQUIRED: { status: 401, title: "Sign in to continue", retryable: false },
  FORBIDDEN: { status: 403, title: "Not allowed", retryable: false },
  NOT_FOUND: { status: 404, title: "Not found", retryable: false },
  VALIDATION_FAILED: { status: 400, title: "The request could not be accepted", retryable: false },
  CONFLICT: { status: 409, title: "That conflicts with the current state", retryable: false },
  IDEMPOTENCY_CONFLICT: {
    status: 409,
    title: "This idempotency key was already used for a different request",
    retryable: false,
  },
  IDEMPOTENCY_IN_PROGRESS: {
    status: 409,
    title: "The original request is still running",
    retryable: true,
  },
  PRECONDITION_REQUIRED: { status: 428, title: "If-Match is required", retryable: false },
  PRECONDITION_FAILED: { status: 412, title: "The resource has changed", retryable: false },
  RATE_LIMITED: { status: 429, title: "Too many requests", retryable: true },
  ENTITLEMENT_REQUIRED: { status: 402, title: "This needs a different plan", retryable: false },
  PROVIDER_UNAVAILABLE: { status: 503, title: "A provider did not respond", retryable: true },
  PROVIDER_RATE_LIMITED: { status: 429, title: "A provider is rate limiting us", retryable: true },
  UNSUPPORTED_GAME: { status: 422, title: "That game is not supported", retryable: false },
  INSUFFICIENT_COVERAGE: { status: 409, title: "More game evidence is needed", retryable: false },
  WORKFLOW_NOT_CANCELLABLE: { status: 409, title: "That work can no longer be cancelled", retryable: false },
  /**
   * Internal only. A delivery arrived before the work item's `available_at`,
   * so the transport should hold it rather than acknowledge it. Distinct from
   * `PROVIDER_UNAVAILABLE`, which would put "a provider did not respond" in an
   * operator's log for a clock-skew event that has nothing to do with one.
   */
  WORK_NOT_READY: { status: 503, title: "That work is not due yet", retryable: true },
  INTERNAL_ERROR: { status: 500, title: "Something went wrong", retryable: true },
} as const satisfies Record<string, CodeSpec>;

export type ProblemCode = keyof typeof PROBLEM_CODES;

export const PROBLEM_CODE_LIST = Object.keys(PROBLEM_CODES) as readonly ProblemCode[];

/** One field-level failure inside a `VALIDATION_FAILED`. Never echoes the value. */
export interface ProblemFieldError {
  path: string;
  code: string;
  message: string;
}

export interface ProblemDocument {
  type: string;
  title: string;
  status: number;
  code: ProblemCode;
  detail: string | null;
  instance: string;
  requestId: string;
  errors: ProblemFieldError[] | null;
  retryable: boolean;
  retryAfterSeconds: number | null;
}

/** `IDEMPOTENCY_CONFLICT` -> `idempotency-conflict`. */
export function problemTypeUri(code: ProblemCode): string {
  return `${PROBLEM_TYPE_BASE}/${code.toLowerCase().replace(/_/g, "-")}`;
}

export interface ProblemOptions {
  /** Written for the caller. Anything else is dropped rather than leaked. */
  detail?: string;
  errors?: ProblemFieldError[];
  retryAfterSeconds?: number;
}

/**
 * The one error `/v1` handlers throw. Extends `CuratedError` so the E01 layer
 * treats its message as caller-safe, and so `classifyError` keeps working for
 * the log line.
 */
export class ProblemError extends CuratedError {
  readonly code: ProblemCode;
  readonly detail: string | null;
  readonly fieldErrors: ProblemFieldError[] | null;
  readonly retryAfterSeconds: number | null;

  constructor(code: ProblemCode, options: ProblemOptions = {}) {
    super(options.detail ?? PROBLEM_CODES[code].title);
    this.name = "ProblemError";
    this.code = code;
    this.detail = options.detail ?? null;
    this.fieldErrors = options.errors ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }

  get status(): number {
    return PROBLEM_CODES[this.code].status;
  }
}

/**
 * Build the wire document.
 *
 * `instance` is the path only. A query string can carry a cursor or an email,
 * and a problem body is a place those get copied into logs and bug reports.
 *
 * `detail` goes through the redaction allowlist even though it is meant to be
 * curated: the usual way a secret reaches a caller is a curated sentence with
 * an untrusted value interpolated into it.
 */
export function problemDocument(
  error: ProblemError,
  context: { path: string; requestId: string },
): ProblemDocument {
  const spec = PROBLEM_CODES[error.code];
  return {
    type: problemTypeUri(error.code),
    title: spec.title,
    status: spec.status,
    code: error.code,
    detail: error.detail === null ? null : safeClientMessage(error),
    instance: context.path,
    requestId: context.requestId,
    errors: error.fieldErrors && error.fieldErrors.length > 0 ? error.fieldErrors : null,
    retryable: spec.retryable,
    retryAfterSeconds: error.retryAfterSeconds,
  };
}

/**
 * Anything a handler threw that is not already a problem becomes
 * `INTERNAL_ERROR` with no detail. This is the boundary the acceptance criteria
 * mean by "no internal exception escapes": the original value is classified for
 * the log and then discarded.
 */
export function toProblemError(error: unknown): ProblemError {
  return error instanceof ProblemError ? error : new ProblemError("INTERNAL_ERROR");
}

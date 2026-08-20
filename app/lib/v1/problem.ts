/**
 * A `/v1` failure, as something the UI can act on.
 *
 * The API answers failures with RFC 9457 problem details, and the useful field
 * is `code` — a closed vocabulary that says what happened, as distinct from
 * `detail`, which is prose for a human and may be absent or deliberately vague.
 * Every branch in the interface should be on `code`.
 *
 * `detail` from a 500 is never shown: it is the one case where the server
 * refuses to say more, and a client that renders it anyway is rendering
 * whatever leaked. Show the request id instead — it is what support can find.
 */

export const PROBLEM_CODES = [
  "AUTH_REQUIRED",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION_FAILED",
  "CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "IDEMPOTENCY_IN_PROGRESS",
  "PRECONDITION_REQUIRED",
  "PRECONDITION_FAILED",
  "RATE_LIMITED",
  "ENTITLEMENT_REQUIRED",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_RATE_LIMITED",
  "UNSUPPORTED_GAME",
  "INSUFFICIENT_COVERAGE",
  "WORKFLOW_NOT_CANCELLABLE",
  "WORK_NOT_READY",
  "INTERNAL_ERROR",
] as const;

export type ProblemCode = (typeof PROBLEM_CODES)[number];

export interface FieldError {
  path: string;
  code: string;
  message: string;
}

export interface ProblemDocument {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string | null;
  instance?: string;
  requestId?: string;
  retryable?: boolean;
  errors?: FieldError[] | null;
}

export class ProblemError extends Error {
  readonly code: ProblemCode | string;
  readonly status: number;
  readonly retryable: boolean;
  readonly requestId: string | null;
  readonly fieldErrors: FieldError[];
  /** Seconds the server asked us to wait, on a 429. */
  readonly retryAfterSeconds: number | null;

  constructor(document: ProblemDocument, retryAfterSeconds: number | null = null) {
    super(document.detail ?? document.title);
    this.name = "ProblemError";
    this.code = document.code;
    this.status = document.status;
    this.retryable = document.retryable ?? false;
    this.requestId = document.requestId ?? null;
    this.fieldErrors = document.errors ?? [];
    this.retryAfterSeconds = retryAfterSeconds;
  }

  is(code: ProblemCode): boolean {
    return this.code === code;
  }

  /** The field errors keyed by path, for attaching messages to inputs. */
  byField(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const error of this.fieldErrors) out[error.path] = error.message;
    return out;
  }
}

/**
 * What to say to the person.
 *
 * One place, so the same failure reads the same everywhere, and so a code the
 * UI has not thought about still produces a sentence rather than an exception
 * message. Nothing here apologises or blames them; each says what happened and,
 * where there is one, what to do.
 */
export function describeProblem(error: ProblemError): { title: string; detail: string } {
  switch (error.code) {
    case "AUTH_REQUIRED":
      return { title: "Please sign in", detail: "Your session has ended." };
    case "FORBIDDEN":
      return { title: "Not available", detail: "This is not yours to open." };
    case "NOT_FOUND":
      return { title: "Not found", detail: "There is nothing here." };
    case "VALIDATION_FAILED":
      return {
        title: "That could not be accepted",
        detail: error.fieldErrors[0]?.message ?? "Check the highlighted fields.",
      };
    case "CONFLICT":
      return {
        title: "This changed while you were looking",
        detail: "Reload to see the current version.",
      };
    case "IDEMPOTENCY_IN_PROGRESS":
      return { title: "Still working", detail: "This is already running. Give it a moment." };
    case "IDEMPOTENCY_CONFLICT":
      return {
        title: "That request was already made",
        detail: "The same action was submitted with different details.",
      };
    case "PRECONDITION_REQUIRED":
    case "PRECONDITION_FAILED":
      return {
        title: "This changed while you were editing",
        detail: "Reload, check what is different, and try again.",
      };
    case "RATE_LIMITED":
      return {
        title: "Too many requests",
        detail:
          error.retryAfterSeconds === null
            ? "Wait a moment and try again."
            : `Wait ${error.retryAfterSeconds} seconds and try again.`,
      };
    case "ENTITLEMENT_REQUIRED":
      // Not a failure of theirs, and not a failure of ours.
      return { title: "Not on your plan", detail: "Upgrading unlocks this." };
    case "PROVIDER_UNAVAILABLE":
      return {
        title: "Your chess site is not responding",
        detail: "Lichess or Chess.com is unavailable. Nothing is lost; we will pick up where we left off.",
      };
    case "PROVIDER_RATE_LIMITED":
      return {
        title: "Your chess site is asking us to slow down",
        detail: "We will keep going shortly.",
      };
    case "INSUFFICIENT_COVERAGE":
      return {
        title: "Not enough to say yet",
        detail: "There is not enough evidence behind this to answer honestly.",
      };
    case "UNSUPPORTED_GAME":
      return {
        title: "This game is not supported",
        detail: "Variants and unfinished games are outside what Forma reads.",
      };
    case "WORKFLOW_NOT_CANCELLABLE":
      return { title: "Too late to stop", detail: "This has already finished or is past stopping." };
    case "INTERNAL_ERROR":
      return {
        title: "Something went wrong on our side",
        // The request id is rendered beside this, so it is not repeated here.
        detail: "Try again in a moment. If it keeps happening, quote the reference below.",
      };
    default:
      return { title: "Something went wrong", detail: "Try again in a moment." };
  }
}

import type { ZodType, ZodError } from "zod";
import { ProblemError, type ProblemFieldError } from "./problem.js";

/**
 * Schema validation into `VALIDATION_FAILED`, per plans/v1-api-contract.md §1.3.
 *
 * The rule that matters: an error entry names the *path* and a *code*, and its
 * message describes the rule. It never contains the value that failed. A
 * validation message is one of the easiest ways for a password typed into the
 * wrong field, or an email, to end up echoed into a client log — so the value
 * simply never leaves the validator.
 */

/** Zod's issue codes are stable identifiers; upper-snake them for the wire. */
function fieldCode(issue: { code: string }): string {
  return issue.code.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

/**
 * Zod issue messages describe the rule ("Too small: expected string to have
 * >=2 characters"), not the input — with one exception: `invalid_value` and
 * `unrecognized_keys` name the offending key or the allowed set. Keys are
 * schema-defined, so those are safe; the received value never appears.
 */
export function toFieldErrors(error: ZodError): ProblemFieldError[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
    code: fieldCode(issue),
    message: issue.message,
  }));
}

export function parseOrProblem<T>(schema: ZodType<T>, input: unknown, location: string): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new ProblemError("VALIDATION_FAILED", {
    detail: `The ${location} did not match what this endpoint accepts.`,
    errors: toFieldErrors(result.error),
  });
}

/**
 * A JSON body, or a validation failure.
 *
 * A malformed body is a validation failure, not a `500`. Hono's `req.json()`
 * throws a `SyntaxError` carrying a fragment of the input, which is precisely
 * the kind of text that must not reach a caller — so it is caught here and the
 * fragment discarded.
 */
export async function readJsonBody(request: {
  json: () => Promise<unknown>;
  header: (name: string) => string | undefined;
}): Promise<unknown> {
  const contentType = request.header("content-type") ?? "";
  if (contentType && !/^application\/(problem\+)?json\b/i.test(contentType)) {
    throw new ProblemError("VALIDATION_FAILED", {
      detail: "This endpoint accepts application/json.",
      errors: [
        { path: "header.Content-Type", code: "UNSUPPORTED_MEDIA_TYPE", message: "expected application/json" },
      ],
    });
  }
  try {
    return await request.json();
  } catch {
    throw new ProblemError("VALIDATION_FAILED", {
      detail: "The request body is not valid JSON.",
      errors: [{ path: "(root)", code: "MALFORMED_JSON", message: "the body is not valid JSON" }],
    });
  }
}

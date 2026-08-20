import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";
import { ProblemError } from "./problem.js";

/**
 * ETags and conditional requests, per plans/v1-api-contract.md §1.6.
 *
 * The tag is computed from the response body with `meta` removed. `meta` holds
 * the request ID, which is different on every request — including a request
 * that returns byte-identical data — so hashing the whole body would produce a
 * tag that never matches and a validator that never saves anything.
 *
 * Strong tags: the bytes either represent the same resource state or they do
 * not. There is no "semantically equivalent" case in a JSON API we generate.
 */

/** Hash the response payload, ignoring per-request metadata. */
export function computeEtag(body: unknown): string {
  const payload =
    body !== null && typeof body === "object" && !Array.isArray(body)
      ? Object.fromEntries(Object.entries(body as Record<string, unknown>).filter(([k]) => k !== "meta"))
      : body;
  const digest = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  return `"${digest.slice(0, 32)}"`;
}

/** Split an `If-None-Match` / `If-Match` header into its candidate tags. */
function candidates(header: string): string[] {
  return header
    .split(",")
    .map((part) => part.trim())
    // A weak validator cannot satisfy a strong comparison, and we never issue
    // one; stripping `W/` here would quietly turn a weak match into a strong one.
    .filter((part) => part.length > 0);
}

/** §1.6: a matching `If-None-Match` means the caller's copy is current. */
export function ifNoneMatchSatisfied(header: string | null | undefined, etag: string): boolean {
  if (!header) return false;
  const tags = candidates(header);
  return tags.includes("*") || tags.includes(etag);
}

/**
 * §1.6's update precondition.
 *
 * Missing header on a route that requires one is `428`, not a silent
 * unconditional write: "the client forgot to be careful" and "the client
 * checked and the resource is current" must not produce the same outcome.
 */
export function assertIfMatch(header: string | null | undefined, etag: string): void {
  if (!header) {
    throw new ProblemError("PRECONDITION_REQUIRED", {
      detail: "This update needs an If-Match header carrying the ETag you last read.",
    });
  }
  const tags = candidates(header);
  if (tags.includes("*") || tags.includes(etag)) return;
  throw new ProblemError("PRECONDITION_FAILED", {
    detail: "This resource changed since you last read it. Read it again and reapply your change.",
  });
}

import { canonicalJson } from "./canonical-json.js";
import { ProblemError } from "./problem.js";
import { sign, signatureMatches, type KernelEnv } from "./signing.js";

/**
 * Opaque, signed, keyset pagination cursors, per plans/v1-api-contract.md §1.5.
 *
 * Two properties matter and neither is decoration.
 *
 * *Opaque*: the client cannot construct one. An offset a caller can edit is an
 * arbitrary filter by another name, and §16 of the platform spec forbids those.
 *
 * *Bound*: the cursor carries a digest of the route and the exact filter set it
 * was issued for, so page 2 of one query cannot be replayed as page 2 of a
 * different one. Without that binding a cursor is a way to walk a keyset under
 * filters the server never authorized.
 *
 * Wire form is `base64url(payload).base64url(signature)`. The payload is
 * readable by anyone who cares to decode it — it contains a sort anchor and
 * nothing private — but it is not *editable*, which is the property being
 * bought.
 */

export const CURSOR_VERSION = 1;

/** §1.5: default 25, cap 100. */
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

/** A cursor a caller cannot fix by retrying; the reason is never disclosed. */
function invalidCursor(): ProblemError {
  return new ProblemError("VALIDATION_FAILED", {
    detail: "The pagination cursor is not valid. Start the list again without it.",
    errors: [{ path: "cursor", code: "CURSOR_INVALID", message: "cursor is not valid" }],
  });
}

export interface CursorPayload {
  /** Format version. A future change bumps it and old cursors stop verifying. */
  v: number;
  /** Route key, e.g. `GET /v1/games`. */
  k: string;
  /** Digest of the filter set the cursor was issued under. */
  f: string;
  /** Sort key name, so a cursor from one ordering cannot be used under another. */
  s: string;
  /** The keyset anchor: the last row's sort columns, ending with its id. */
  a: readonly (string | number | null)[];
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input as never).toString("base64url");
}

/**
 * A stable digest of the filters in play. Sorted and canonically encoded, so a
 * caller reordering query parameters gets the same digest and keeps their page.
 */
export function filterDigest(filters: Record<string, unknown>): string {
  return sign("cursor", ["filters", canonicalJson(filters)]).slice(0, 32);
}

export interface CursorScope {
  routeKey: string;
  sortKey: string;
  filters: Record<string, unknown>;
}

export function encodeCursor(
  scope: CursorScope,
  anchor: readonly (string | number | null)[],
  env?: KernelEnv,
): string {
  const payload: CursorPayload = {
    v: CURSOR_VERSION,
    k: scope.routeKey,
    f: filterDigest(scope.filters),
    s: scope.sortKey,
    a: [...anchor],
  };
  const encoded = base64url(canonicalJson(payload));
  const signature = sign("cursor", [encoded], env);
  return `${encoded}.${base64url(Buffer.from(signature, "hex"))}`;
}

/**
 * Verify and decode. Every failure — malformed, bad signature, wrong version,
 * wrong route, wrong filters — raises the identical problem, because telling a
 * caller *which* check failed is telling them how to get closer.
 */
export function decodeCursor(
  cursor: string,
  scope: CursorScope,
  env?: KernelEnv,
): CursorPayload {
  const separator = cursor.lastIndexOf(".");
  if (separator <= 0 || separator === cursor.length - 1) throw invalidCursor();
  const encoded = cursor.slice(0, separator);
  const presented = Buffer.from(cursor.slice(separator + 1), "base64url").toString("hex");
  if (!signatureMatches(sign("cursor", [encoded], env), presented)) throw invalidCursor();

  let payload: CursorPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as CursorPayload;
  } catch {
    throw invalidCursor();
  }
  // Signature-verified, so these can only disagree if the cursor is genuinely
  // from another query — a replay attempt, or a client that changed its filters
  // without dropping the cursor.
  if (
    payload?.v !== CURSOR_VERSION ||
    payload.k !== scope.routeKey ||
    payload.s !== scope.sortKey ||
    payload.f !== filterDigest(scope.filters) ||
    !Array.isArray(payload.a)
  ) {
    throw invalidCursor();
  }
  return payload;
}

/** §1.5's limit rule, in one place so no endpoint invents a different cap. */
export function resolveLimit(raw: string | undefined, max = MAX_LIMIT): number {
  if (raw === undefined || raw === "") return DEFAULT_LIMIT;
  if (!/^\d{1,4}$/.test(raw)) {
    throw new ProblemError("VALIDATION_FAILED", {
      detail: "limit must be a whole number.",
      errors: [{ path: "limit", code: "NOT_AN_INTEGER", message: "limit must be a whole number" }],
    });
  }
  const value = Number(raw);
  if (value < 1) {
    throw new ProblemError("VALIDATION_FAILED", {
      detail: "limit must be at least 1.",
      errors: [{ path: "limit", code: "OUT_OF_RANGE", message: "limit must be at least 1" }],
    });
  }
  return Math.min(value, max);
}

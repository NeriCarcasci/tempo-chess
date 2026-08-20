import { randomBytes } from "node:crypto";

/**
 * Request and trace identifiers, per plans/v1-platform-spec.md §19 and
 * plans/v1-api-contract.md §1.2.
 *
 * A caller may supply `X-Request-Id` so a browser can correlate its own retries
 * with our logs, but only if it looks like an identifier. An unvalidated
 * caller-supplied string ends up in a log line, a problem body, and — the part
 * that actually matters — in whatever a downstream system does with it, so the
 * accepted shape is narrow and the value is never used as a database key.
 *
 * Trace context comes from either W3C `traceparent` or Cloud Run's
 * `X-Cloud-Trace-Context`, so a request that crossed a Google load balancer
 * keeps its trace rather than starting a new one at our edge.
 */

/** Caller-supplied request IDs must look like this or they are replaced. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

const BASE32 = "0123456789abcdefghjkmnpqrstvwxyz";

/** `req_` plus 26 base32 characters: 130 bits, URL-safe, no ambiguous glyphs. */
export function mintRequestId(): string {
  const bytes = randomBytes(17);
  let out = "";
  for (let i = 0; i < 26; i += 1) {
    out += BASE32[bytes[i % bytes.length] % 32];
  }
  return `req_${out}`;
}

export function resolveRequestId(supplied: string | null | undefined): string {
  return supplied && REQUEST_ID_PATTERN.test(supplied) ? supplied : mintRequestId();
}

/** 32 lowercase hex characters, the shape both trace formats use. */
export const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;

export function mintTraceId(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Pull a trace id out of whichever header carries one.
 *
 * `traceparent` is `version-traceid-spanid-flags`; the all-zero trace id is
 * explicitly invalid in the W3C spec and is treated as absent.
 * `X-Cloud-Trace-Context` is `TRACE_ID/SPAN_ID;o=1`.
 */
export function resolveTraceId(headers: {
  traceparent?: string | null;
  cloudTrace?: string | null;
}): string {
  const w3c = headers.traceparent?.split("-");
  if (w3c && w3c.length >= 3) {
    const candidate = w3c[1]?.toLowerCase() ?? "";
    if (TRACE_ID_PATTERN.test(candidate) && !/^0+$/.test(candidate)) return candidate;
  }
  const gcp = headers.cloudTrace?.split("/")[0]?.toLowerCase() ?? "";
  if (TRACE_ID_PATTERN.test(gcp) && !/^0+$/.test(gcp)) return gcp;
  return mintTraceId();
}

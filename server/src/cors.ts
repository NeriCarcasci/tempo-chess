/**
 * CORS for E01.
 *
 * The deployed API answers exactly three browser origins. There is no wildcard
 * fallback: a deployed process whose allowlist is empty or contains `*` refuses
 * to start rather than quietly serving `Access-Control-Allow-Origin: *`, which
 * is how the previous configuration behaved when its origin variable was unset.
 *
 * Requests without an `Origin` header are server-to-server calls. They keep
 * working and simply receive no CORS headers, because there is no browser to
 * grant anything to.
 */

import type { Context, MiddlewareHandler, Next } from "hono";
import { ALLOWED_ORIGINS } from "./security/contract.js";

export class CorsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorsConfigError";
  }
}

export interface CorsEnv {
  WEB_ORIGINS?: string;
  WEB_ORIGIN?: string;
}

/**
 * The allowlist this process will serve.
 *
 * The contract names three origins exactly, so a deployed process gets set
 * equality, not a validity check. Rejecting `*` and rejecting empty is not
 * enough: an explicit list of one unrelated origin, or the approved three plus a
 * fourth, are both perfectly well-formed and both violate the contract. A
 * deployed process therefore accepts only the exact set, in any order, and
 * refuses to start otherwise.
 *
 * Outside a deployed process the list is still explicit and still wildcard-free,
 * but it may differ, so a developer can point a local SPA at the API.
 */
export function resolveAllowedOrigins(env: CorsEnv, deployed: boolean): string[] {
  const raw = env.WEB_ORIGINS ?? env.WEB_ORIGIN;
  if (raw === undefined) return [...ALLOWED_ORIGINS];

  const origins = raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  if (origins.includes("*")) {
    throw new CorsConfigError(
      "WEB_ORIGINS may not contain '*'; E01 forbids a wildcard CORS fallback",
    );
  }
  if (origins.length === 0) {
    throw new CorsConfigError("WEB_ORIGINS is empty; E01 requires an explicit CORS allowlist");
  }
  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new CorsConfigError("WEB_ORIGINS contains an entry that is not an absolute origin");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new CorsConfigError("WEB_ORIGINS contains an entry with an unsupported scheme");
    }
    if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
      throw new CorsConfigError("WEB_ORIGINS entries must be bare origins with no path or query");
    }
  }

  if (deployed) {
    const configured = [...new Set(origins)].sort();
    const contract = [...ALLOWED_ORIGINS].sort();
    const missing = contract.filter((origin) => !configured.includes(origin));
    const extra = configured.filter((origin) => !contract.includes(origin as never));
    if (missing.length > 0 || extra.length > 0) {
      throw new CorsConfigError(
        `WEB_ORIGINS must equal the contract allowlist exactly; missing ${missing.length}, unexpected ${extra.length}`,
      );
    }
    return contract;
  }
  return origins;
}

/** True when a preflight is being negotiated rather than a plain OPTIONS request. */
function isPreflight(c: Context): boolean {
  return c.req.method === "OPTIONS" && c.req.header("Access-Control-Request-Method") !== undefined;
}

/**
 * `Vary: Origin` goes on every response that passes through here, allowed or
 * not, so a shared cache can never hand one origin's response to another. It is
 * set rather than appended, which keeps it present exactly once.
 */
function applyVary(headers: Headers): void {
  headers.set("Vary", "Origin");
}

export function cors(allowedOrigins: readonly string[]): MiddlewareHandler {
  const allowed = new Set(allowedOrigins);
  return async (c: Context, next: Next) => {
    const origin = c.req.header("Origin");
    const originAllowed = origin !== undefined && allowed.has(origin);

    if (isPreflight(c)) {
      const headers = new Headers();
      applyVary(headers);
      if (!originAllowed) {
        // A disallowed preflight is refused outright rather than answered with a
        // 204 that happens to omit the header.
        return new Response(null, { status: 403, headers });
      }
      headers.set("Access-Control-Allow-Origin", origin!);
      headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
      headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
      headers.set("Access-Control-Max-Age", "86400");
      return new Response(null, { status: 204, headers });
    }

    await next();

    // Re-wrap so the headers are mutable regardless of how the handler built its
    // response.
    c.res = new Response(c.res.body, c.res);
    applyVary(c.res.headers);
    if (originAllowed) {
      c.res.headers.set("Access-Control-Allow-Origin", origin!);
    } else {
      c.res.headers.delete("Access-Control-Allow-Origin");
    }
  };
}

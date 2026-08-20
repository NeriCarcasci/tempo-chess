import type { Context, MiddlewareHandler, Next } from "hono";
import { resolveRequestId, resolveTraceId } from "./identifiers.js";
import { observeRequest } from "./telemetry.js";

/**
 * The legacy compatibility adapter, per plans/v1-api-contract.md §16.
 *
 * The prototype's unversioned routes are what the shipped frontend calls. They
 * keep working, byte for byte: same paths, same statuses, same `{ error }`
 * bodies. Breaking them without a measured deprecation is explicitly out of
 * scope for this epic, and the frontend migration belongs to the epics that own
 * each endpoint.
 *
 * What they gain is measurement. §16 says legacy writes stop only after shadow
 * reads and reconciliation pass, and deprecated endpoints "emit
 * `Deprecation`/`Sunset` headers and metrics" — so the sunset date is a
 * decision made from a usage count rather than from optimism about who has
 * migrated.
 *
 * The adapter deliberately does not add problem details, request-id envelopes,
 * or idempotency to legacy routes. Adding them would change the contract the
 * current client is written against, which is the one thing this middleware
 * exists to avoid.
 */

/**
 * The date after which the legacy surface is expected to be gone.
 *
 * It is an announcement, not an enforcement: nothing here starts refusing
 * requests. Moving it is a contract decision recorded in the runbook, and the
 * usage metric is what informs it.
 */
export const LEGACY_SUNSET = new Date("2026-12-31T00:00:00Z");

/** Where a legacy path's traffic is meant to go. Absent until a successor ships. */
export const LEGACY_SUCCESSORS: Readonly<Record<string, string>> = {
  "/stats/reach": "/v1/public/stats",
  "/billing/plans": "/v1/public/plans",
  "/beta-signups": "/v1/public/beta-signups",
};

/** Paths that are not part of the deprecated product surface. */
const EXEMPT = new Set(["/health"]);

function isLegacyPath(path: string): boolean {
  // `/internal` is E04's private surface. It was never part of the prototype,
  // so a `Deprecation` header on it would announce a sunset for something that
  // has no consumer to warn.
  return (
    !path.startsWith("/v1/") &&
    path !== "/v1" &&
    !path.startsWith("/internal/") &&
    !EXEMPT.has(path)
  );
}

/**
 * Collapse a concrete path to its route template so the metric has bounded
 * cardinality and carries no identifier. `/imports/9f3c.../cancel` must not
 * become its own metric series, and it must not put an import id in a log line.
 */
export function legacyRouteTemplate(path: string): string {
  return path
    .split("/")
    .map((segment) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)
        ? ":id"
        : /^\d+$/.test(segment)
          ? ":n"
          : segment,
    )
    .join("/");
}

/** Per-route hit counts since process start, for the deprecation decision. */
const usage = new Map<string, number>();

export function legacyUsage(): ReadonlyMap<string, number> {
  return usage;
}

export function resetLegacyUsage(): void {
  usage.clear();
}

export function legacyCompatibility(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    if (!isLegacyPath(c.req.path)) return next();

    const requestId = resolveRequestId(c.req.header("x-request-id"));
    const traceId = resolveTraceId({
      traceparent: c.req.header("traceparent"),
      cloudTrace: c.req.header("x-cloud-trace-context"),
    });
    const template = legacyRouteTemplate(c.req.path);
    const startedAt = performance.now();

    try {
      await next();
    } finally {
      const key = `${c.req.method} ${template}`;
      usage.set(key, (usage.get(key) ?? 0) + 1);

      // RFC 8594 / RFC 9110: `Deprecation: true` and an HTTP-date `Sunset`.
      c.res.headers.set("Deprecation", "true");
      c.res.headers.set("Sunset", LEGACY_SUNSET.toUTCString());
      c.res.headers.set("X-Request-Id", requestId);
      const successor = LEGACY_SUCCESSORS[template];
      if (successor) {
        c.res.headers.set("Link", `<${successor}>; rel="successor-version"`);
      }

      observeRequest({
        requestId,
        traceId,
        route: template,
        method: c.req.method,
        status: c.res.status,
        durationMs: performance.now() - startedAt,
        surface: "legacy",
        // The legacy routes verify tokens through the same kernel verifier, but
        // they do not report which path they took; claiming a mode here would
        // be a guess, and `anonymous` is the truthful default for a line that
        // does not know.
        authMode: "anonymous",
        actorPresent: Boolean(c.req.header("authorization")),
        problemCode: null,
        idempotency: "none",
        cursorRejected: false,
        rateLimit: "ok",
        redactions: 0,
        deprecated: true,
      });
    }
  };
}

import type { Context, Env, Hono } from "hono";
import { recordAuditEvent } from "./audit.js";
import { buildAuthorizationContext, assertNoClientIdentity, type AuthorizationContext } from "./auth/context.js";
import { bearerToken, tokenVerifier } from "./auth/verifier.js";
import { collection, resource, type Redaction } from "./envelope.js";
import { computeEtag, ifNoneMatchSatisfied } from "./etag.js";
import { resolveRequestId, resolveTraceId } from "./identifiers.js";
import {
  beginCommand,
  completeCommand,
  failCommand,
  requestDigest,
  requireIdempotencyKey,
  type IdempotencyOutcome,
} from "./idempotency.js";
import { verifyServiceCaller, type ServiceCaller } from "./auth/oidc.js";
import { ProblemError, problemDocument, toProblemError, type ProblemCode } from "./problem.js";
import { clientAddress, consume, type RateLimitStatus } from "./rate-limit.js";
import { routeKey, requiresIdempotencyKey, type RouteDefinition } from "./registry.js";
import { observeRequest, type AuthMode } from "./telemetry.js";
import { parseOrProblem, readJsonBody } from "./validation.js";
import { logSafeError } from "../security/redaction.js";

/**
 * The `/v1` kernel.
 *
 * One function turns a route declaration into a mounted handler with every
 * shared behaviour applied in a fixed order. The order is the design:
 *
 *   identifiers -> authentication -> address rate limits -> validation ->
 *   body-derived rate limits -> idempotency -> handler -> envelope -> caching
 *
 * Authentication precedes rate limiting so an authenticated caller is counted
 * as themselves. Address limits precede validation so a flood of malformed
 * bodies is still counted. Body-derived limits follow validation because they
 * need a parsed body. Idempotency is last before the handler so a duplicate is
 * detected only once the request is known to be well-formed — otherwise a
 * client could burn a key on a request that never ran.
 *
 * Every exit goes through `problemDocument`. There is no path where a thrown
 * value reaches the wire.
 */

interface RequestState {
  requestId: string;
  traceId: string;
  authMode: AuthMode;
  actorPresent: boolean;
  idempotency: IdempotencyOutcome | "none";
  cursorRejected: boolean;
  rateLimit: RateLimitStatus;
  redactions: number;
}

/** Cleared per request; a leaked field here would be a cross-request leak. */
function newState(c: Context): RequestState {
  return {
    requestId: resolveRequestId(c.req.header("x-request-id")),
    traceId: resolveTraceId({
      traceparent: c.req.header("traceparent"),
      cloudTrace: c.req.header("x-cloud-trace-context"),
    }),
    authMode: "anonymous",
    actorPresent: false,
    idempotency: "none",
    cursorRejected: false,
    rateLimit: "ok",
    redactions: 0,
  };
}

function problemResponse(c: Context, state: RequestState, error: ProblemError): Response {
  const document = problemDocument(error, { path: c.req.path, requestId: state.requestId });
  c.header("Content-Type", "application/problem+json");
  c.header("X-Request-Id", state.requestId);
  c.header("Cache-Control", "no-store");
  if (error.retryAfterSeconds !== null) c.header("Retry-After", String(error.retryAfterSeconds));
  return c.body(JSON.stringify(document), document.status as never);
}

/**
 * Authenticate a private-ingress caller, per plans/v1-api-contract.md §15.
 *
 * A failure is `AUTH_REQUIRED` with no detail whichever way it failed: an
 * internal endpoint tells a caller nothing about why it was refused, because
 * the only callers that should ever reach it already know they belong. The
 * audit row is where the distinction lives.
 */
async function authenticateService(
  c: Context,
  route: RouteDefinition<never, never, never>,
  state: RequestState,
): Promise<ServiceCaller> {
  const token = bearerToken(c.req.header("Authorization"));
  const result = await verifyServiceCaller(token, route.serviceRole ?? "worker");
  if (result.ok) {
    state.authMode = "service";
    state.actorPresent = true;
    return result.caller;
  }
  await recordAuditEvent({
    actorKind: "service",
    action: "internal.caller_rejected",
    requestId: state.requestId,
    traceId: state.traceId,
    result: "denied",
    reasonCode: result.reason,
    metadata: { route: routeKey(route), required: route.serviceRole ?? "worker" },
  });
  throw new ProblemError(
    result.reason === "unavailable" ? "PROVIDER_UNAVAILABLE" : "AUTH_REQUIRED",
  );
}

async function authenticate(
  c: Context,
  route: RouteDefinition<never, never, never>,
  state: RequestState,
): Promise<AuthorizationContext | null> {
  const token = bearerToken(c.req.header("Authorization"));
  if (!token) {
    if (route.auth === "public") return null;
    throw new ProblemError("AUTH_REQUIRED", { detail: "Sign in to continue." });
  }

  const verified = await tokenVerifier().verify(token, {
    revocationSensitive: route.revocationSensitive === true,
  });
  if (!verified.ok) {
    // A public route with a bad token is served anonymously rather than
    // refused: the token is not required, and rejecting it would make an
    // expired session break the landing page. The rejection is still audited.
    await recordAuditEvent({
      actorKind: "anonymous",
      action: "auth.token_rejected",
      requestId: state.requestId,
      traceId: state.traceId,
      result: "denied",
      reasonCode: verified.reason,
      metadata: { route: routeKey(route) },
    });
    if (route.auth === "public") return null;
    throw new ProblemError(
      verified.reason === "unavailable" ? "PROVIDER_UNAVAILABLE" : "AUTH_REQUIRED",
      {
        detail:
          verified.reason === "unavailable"
            ? "We could not verify your session just now. Try again in a moment."
            : "Sign in to continue.",
      },
    );
  }

  state.authMode = verified.token.mode;
  state.actorPresent = true;
  return buildAuthorizationContext(verified.token);
}

async function applyRateLimits(
  route: RouteDefinition<never, never, never>,
  state: RequestState,
  identityFor: (rule: NonNullable<RouteDefinition["rateLimits"]>[number]) => string | null,
  phase: "address" | "body",
  auth: AuthorizationContext | null,
): Promise<void> {
  for (const rule of route.rateLimits ?? []) {
    const isBodyRule = typeof rule.source === "function";
    if ((phase === "body") !== isBodyRule) continue;
    const identity = identityFor(rule);
    if (identity === null) continue;
    const decision = await consume(rule.policy, identity, {
      // A command must not become a free write channel when the counter store
      // is down; a public read must not black out the landing page for the same
      // reason. The two genuinely differ.
      failClosed: route.kind === "command",
    });
    if (decision.status !== "ok") state.rateLimit = decision.status;
    if (decision.status === "limited" || (decision.status === "degraded" && route.kind === "command")) {
      await recordAuditEvent({
        actorKind: auth ? "user" : "anonymous",
        actorRef: auth?.profileId ?? null,
        action: "request.rate_limited",
        requestId: state.requestId,
        traceId: state.traceId,
        result: "denied",
        reasonCode: rule.policy.name,
        metadata: { route: routeKey(route), degraded: decision.status === "degraded" },
      });
      throw new ProblemError("RATE_LIMITED", {
        detail: "Too many requests. Try again shortly.",
        retryAfterSeconds: decision.retryAfterSeconds,
      });
    }
  }
}

/** Mount one declared route onto the app with every kernel behaviour applied. */
export function mountRoute<E extends Env>(
  app: Hono<E>,
  route: RouteDefinition<never, never, never>,
): void {
  const key = routeKey(route);
  const method = route.method.toLowerCase() as "get" | "post" | "patch" | "put" | "delete";

  app[method](route.path, async (c: Context) => {
    const state = newState(c);
    const startedAt = performance.now();
    let status = 500;
    let problemCode: ProblemCode | null = null;
    let recordId: string | null = null;

    try {
      const service = route.auth === "internal" ? await authenticateService(c, route, state) : null;
      const auth = route.auth === "internal" ? null : await authenticate(c, route, state);

      await applyRateLimits(
        route,
        state,
        (rule) => (rule.source === "actor" ? (auth?.profileId ?? null) : addressOf(c)),
        "address",
        auth,
      );

      const query = route.querySchema
        ? (() => {
            const raw = c.req.query();
            assertNoClientIdentity(raw, "query");
            return parseOrProblem(route.querySchema!, raw, "query string");
          })()
        : (undefined as never);

      let body: unknown = undefined;
      if (route.bodySchema) {
        const raw = await readJsonBody(c.req);
        assertNoClientIdentity(raw, "body");
        body = parseOrProblem(route.bodySchema, raw, "request body");
      }

      await applyRateLimits(
        route,
        state,
        (rule) => (typeof rule.source === "function" ? rule.source(body) : null),
        "body",
        auth,
      );

      if (requiresIdempotencyKey(route)) {
        const idempotencyKey = requireIdempotencyKey(c.req.header("idempotency-key"));
        const scope = {
          routeKey: key,
          method: route.method,
          actorProfileId: auth?.profileId ?? null,
        };
        const digest = requestDigest(scope, body ?? null);
        let claim;
        try {
          claim = await beginCommand(scope, idempotencyKey, digest);
        } catch (error) {
          if (error instanceof ProblemError && error.code === "IDEMPOTENCY_CONFLICT") {
            state.idempotency = "conflict";
            await recordAuditEvent({
              actorKind: auth ? "user" : "anonymous",
              actorRef: auth?.profileId ?? null,
              action: "command.idempotency_conflict",
              requestId: state.requestId,
              traceId: state.traceId,
              result: "denied",
              reasonCode: "digest_mismatch",
              metadata: { route: key },
            });
          } else if (error instanceof ProblemError && error.code === "IDEMPOTENCY_IN_PROGRESS") {
            state.idempotency = "in_progress";
          }
          throw error;
        }
        if (claim.kind === "replay") {
          state.idempotency = "replayed";
          status = claim.response.status;
          c.header("Content-Type", "application/json");
          c.header("X-Request-Id", state.requestId);
          c.header("Idempotency-Replayed", "true");
          c.header("Cache-Control", "no-store");
          return c.body(JSON.stringify(claim.response.body), status as never);
        }
        recordId = claim.recordId;
        state.idempotency = "stored";
      }

      const result = await route.handler({
        query,
        body: body as never,
        auth,
        service,
        requestId: state.requestId,
        traceId: state.traceId,
        params: c.req.param() as Record<string, string>,
      });

      status = result.status ?? route.successStatus;
      state.redactions = result.redactions?.length ?? 0;
      const payload = buildBody(route, result, state.requestId, result.redactions);

      if (recordId) {
        await completeCommand(recordId, { status, body: payload }, result.resource ?? null);
      }

      c.header("X-Request-Id", state.requestId);
      c.header(
        "Cache-Control",
        route.kind === "command" ? "no-store" : (result.cacheControl ?? route.cacheControl ?? "no-store"),
      );

      if (route.etag && route.kind === "read") {
        const etag = computeEtag(payload);
        c.header("ETag", etag);
        if (ifNoneMatchSatisfied(c.req.header("if-none-match"), etag)) {
          status = 304;
          return c.body(null, 304);
        }
      }

      // A 204 carries no body by definition, and an internal worker
      // acknowledgement is the only place `/v1` produces one.
      if (status === 204) return c.body(null, 204);

      c.header("Content-Type", "application/json");
      return c.body(JSON.stringify(payload), status as never);
    } catch (error) {
      const problem = toProblemError(error);
      if (problem.code === "INTERNAL_ERROR") logSafeError(`v1 handler failed: ${key}`, error);
      if (problem.code === "VALIDATION_FAILED") {
        state.cursorRejected =
          problem.fieldErrors?.some((entry) => entry.code === "CURSOR_INVALID") ?? false;
      }
      // Release the key so the client's retry can run. A failed command must
      // not be remembered as a completed one.
      if (recordId) await failCommand(recordId).catch(() => {});
      problemCode = problem.code;
      status = problem.status;
      return problemResponse(c, state, problem);
    } finally {
      observeRequest({
        requestId: state.requestId,
        traceId: state.traceId,
        route: route.path,
        method: route.method,
        status,
        durationMs: performance.now() - startedAt,
        surface: route.surface === "internal" ? "internal" : "v1",
        authMode: state.authMode,
        actorPresent: state.actorPresent,
        problemCode,
        idempotency: state.idempotency,
        cursorRejected: state.cursorRejected,
        rateLimit: state.rateLimit,
        redactions: state.redactions,
        deprecated: false,
      });
    }
  });
}

function addressOf(c: Context): string {
  return clientAddress({
    cfConnectingIp: c.req.header("cf-connecting-ip"),
    forwardedFor: c.req.header("x-forwarded-for"),
  });
}

function buildBody(
  route: RouteDefinition<never, never, never>,
  result: { data: unknown; page?: { nextCursor: string | null; hasMore: boolean } },
  requestId: string,
  redactions: readonly Redaction[] | undefined,
): unknown {
  if (route.envelope === "raw") return result.data;
  if (route.envelope === "collection") {
    return collection(
      (result.data as unknown[]) ?? [],
      result.page ?? { nextCursor: null, hasMore: false },
      requestId,
      redactions,
    );
  }
  return resource(result.data, requestId, redactions);
}

/**
 * Mount the private surface, and its own catch-all.
 *
 * Separate from `mountV1` because the two surfaces answer different questions
 * about an unknown path: `/v1/nonsense` is a client using an endpoint we do not
 * have, and `/internal/v1/nonsense` is one of our own deployments calling
 * something that no longer exists. Both get problem details; keeping the mounts
 * apart is what stops an internal route from ever being reachable under `/v1`.
 */
export function mountInternal<E extends Env>(
  app: Hono<E>,
  routes: readonly RouteDefinition<never, never, never>[],
): void {
  for (const route of routes) mountRoute(app, route);

  app.all("/internal/*", (c: Context) => {
    const state = newState(c);
    const problem = new ProblemError("NOT_FOUND", { detail: "No such endpoint." });
    observeRequest({
      requestId: state.requestId,
      traceId: state.traceId,
      route: "/internal/*",
      method: c.req.method,
      status: 404,
      durationMs: 0,
      surface: "internal",
      authMode: "anonymous",
      actorPresent: false,
      problemCode: "NOT_FOUND",
      idempotency: "none",
      cursorRejected: false,
      rateLimit: "ok",
      redactions: 0,
      deprecated: false,
    });
    return problemResponse(c, state, problem);
  });
}

/** Mount every declared route, and the `/v1` catch-all that keeps 404s in contract. */
export function mountV1<E extends Env>(
  app: Hono<E>,
  routes: readonly RouteDefinition<never, never, never>[],
): void {
  for (const route of routes) mountRoute(app, route);

  // Without this, an unknown `/v1/...` path falls through to Hono's default
  // 404, which is `text/plain` — a caller parsing `application/problem+json`
  // would get an unparseable body from the one API that promised not to do that.
  app.all("/v1/*", (c: Context) => {
    const state = newState(c);
    const problem = new ProblemError("NOT_FOUND", { detail: "No such endpoint." });
    observeRequest({
      requestId: state.requestId,
      traceId: state.traceId,
      route: "/v1/*",
      method: c.req.method,
      status: 404,
      durationMs: 0,
      surface: "v1",
      authMode: "anonymous",
      actorPresent: false,
      problemCode: "NOT_FOUND",
      idempotency: "none",
      cursorRejected: false,
      rateLimit: "ok",
      redactions: 0,
      deprecated: false,
    });
    return problemResponse(c, state, problem);
  });
}

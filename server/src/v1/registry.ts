import type { ZodType } from "zod";
import type { AuthorizationContext } from "./auth/context.js";
import type { ServiceCaller, ServiceRole } from "./auth/oidc.js";
import type { PageBlock, Redaction } from "./envelope.js";
import type { RateLimitPolicy } from "./rate-limit.js";

/**
 * The route registry.
 *
 * Every `/v1` route is declared as data before it is mounted, because three
 * separate things need the same description and they must not drift: the
 * middleware that enforces auth, validation, idempotency and caching; the
 * OpenAPI document; and the structured log's route template.
 *
 * The alternative — decorating handlers, or hand-writing the OpenAPI beside the
 * code — is exactly how an API ends up with a document that describes what
 * someone meant to build. Here the document is generated from the same object
 * the router uses, and a gate fails if the committed file disagrees.
 */

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** A read is cacheable and safe. A command changes state and needs a key. */
export type RouteKind = "read" | "command";

/**
 * `internal` is E04's addition: a route on `/internal/v1` whose caller is a
 * Google-signed service account on a named allowlist rather than a user.
 */
export type RouteAuth = "public" | "required" | "internal";

/**
 * What an authenticated caller must additionally hold to reach a route.
 *
 * `approved` is the default and is never written out: Forma is in closed beta,
 * so an account that has not been let in reaches nothing. Default-deny is the
 * point. A route added next month is gated by having said nothing, and the only
 * way to open one is to say so in the declaration where a reviewer sees it.
 *
 * `self` is the narrow exception: a route about the caller's own access, which
 * an unapproved account has to be able to reach or it can never learn why it is
 * stuck or argue its case. Nothing under `self` may read or write anything but
 * the caller's own access request.
 *
 * `operator` is the admin surface. It still requires approval — an operator is
 * an approved account with an extra grant, not a way around the gate — and the
 * grant itself is checked by the database inside `withOperatorContext`, not
 * here. This value exists so the declaration says what the route is for.
 */
export type RouteAccess = "approved" | "self" | "operator";

/** `v1` is the browser-facing product surface; `internal` is private ingress. */
export type RouteSurface = "v1" | "internal";

/** Where a rate-limit policy gets the identity it counts against. */
export type RateLimitSource =
  | "address"
  | "actor"
  /** Derived from the validated body, e.g. a normalized email. */
  | ((body: unknown) => string | null);

export interface RouteRateLimit {
  policy: RateLimitPolicy;
  source: RateLimitSource;
}

export interface HandlerInput<TQuery, TBody> {
  query: TQuery;
  body: TBody;
  /** Null on a public route with no bearer token, and on an internal route. */
  auth: AuthorizationContext | null;
  /** The verified service account on an internal route; null everywhere else. */
  service: ServiceCaller | null;
  requestId: string;
  traceId: string;
  /** Raw path parameters, already matched by the router. */
  params: Record<string, string>;
}

export interface HandlerResult<TData> {
  /** Defaults to the route's declared success status. */
  status?: number;
  data: TData;
  /** Present only on a collection route. */
  page?: PageBlock;
  redactions?: readonly Redaction[];
  /** Recorded on the idempotency record so a replay can name what it made. */
  resource?: { type: string; id: string } | null;
  /** Per-response override of the route's cache directive. */
  cacheControl?: string;
}

export interface RouteDefinition<TQuery = unknown, TBody = unknown, TData = unknown> {
  method: HttpMethod;
  /** Full path including `/v1`, in Hono's syntax: `/v1/games/:gameId`. */
  path: string;
  operationId: string;
  summary: string;
  description?: string;
  kind: RouteKind;
  auth: RouteAuth;
  /** Defaults to `v1`. An `internal` route is not in the OpenAPI document. */
  surface?: RouteSurface;
  /** Which internal allowlist may call this. Required when `auth` is `internal`. */
  serviceRole?: ServiceRole;
  /**
   * Defaults to `approved`. Only meaningful when `auth` is `required`: a public
   * route has no account to judge, and an internal route's caller is a service.
   */
  access?: RouteAccess;
  /**
   * `ledger` says this command's idempotency is enforced by the durable work
   * ledger's conditional transitions rather than by an `Idempotency-Key`
   * record. Legal only on an internal route — see `requiresIdempotencyKey`.
   */
  idempotency?: "key" | "ledger";
  /** Force the `getUser` fallback so the answer reflects revocation. */
  revocationSensitive?: boolean;
  /** `resource` and `collection` are enveloped; `raw` is the body verbatim. */
  envelope: "resource" | "collection" | "raw";
  /** Success status when the handler does not override it. */
  successStatus: number;
  querySchema?: ZodType<TQuery>;
  bodySchema?: ZodType<TBody>;
  /**
   * Schema of the `data` member exactly as it appears on the wire, used by the
   * OpenAPI document. For a collection route that is the array, not the item.
   */
  dataSchema?: ZodType<TData>;
  rateLimits?: readonly RouteRateLimit[];
  /** Emit an `ETag` and honour `If-None-Match`. Reads only. */
  etag?: boolean;
  cacheControl?: string;
  handler: (input: HandlerInput<TQuery, TBody>) => Promise<HandlerResult<TData>>;
}

/** `GET /v1/public/stats` — the uniqueness scope for cursors and idempotency. */
export function routeKey(route: Pick<RouteDefinition, "method" | "path">): string {
  return `${route.method} ${route.path}`;
}

/**
 * A command must be idempotent.
 *
 * There is still no per-route switch on the product surface: "this command does
 * not need a key" is a judgement that is wrong the first time a client's
 * connection drops mid-request, so every `/v1` command requires one.
 *
 * An internal route may declare `idempotency: "ledger"` instead, and only an
 * internal route may. The caller there is Cloud Tasks, which has no key to
 * offer and needs none: the duplicate it will eventually deliver is stopped by
 * the conditional claim in `ops.work_items`, which is a stronger guarantee than
 * a header, not a waiver of one. Asserted rather than assumed, because the
 * value of the `/v1` rule is that it has no exceptions.
 */
export function requiresIdempotencyKey(
  route: Pick<RouteDefinition, "kind" | "idempotency" | "surface">,
): boolean {
  if (route.kind !== "command") return false;
  if (route.idempotency !== "ledger") return true;
  if (route.surface !== "internal") {
    throw new Error("idempotency: 'ledger' is only available on an internal route");
  }
  return false;
}

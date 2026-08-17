import type { ZodType } from "zod";
import type { AuthorizationContext } from "./auth/context.js";
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

export type RouteAuth = "public" | "required";

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
  /** Null on a public route with no bearer token. */
  auth: AuthorizationContext | null;
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
 * A command must be idempotent. There is no per-route switch, because "this
 * command does not need a key" is a judgement that is wrong the first time a
 * client's connection drops mid-request.
 */
export function requiresIdempotencyKey(route: Pick<RouteDefinition, "kind">): boolean {
  return route.kind === "command";
}

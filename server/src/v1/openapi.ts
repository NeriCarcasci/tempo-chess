import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { PROBLEM_CODE_LIST, PROBLEM_CODES, PROBLEM_TYPE_BASE, type ProblemCode } from "./problem.js";
import { DEFAULT_LIMIT, MAX_LIMIT } from "./cursor.js";
import { MAX_KEY_LENGTH } from "./idempotency.js";
import { requiresIdempotencyKey, type RouteDefinition } from "./registry.js";

/**
 * OpenAPI 3.1, generated from the route registry.
 *
 * Generated rather than written, per plans/v1-platform-spec.md §16, because a
 * hand-maintained document describes the API someone meant to build. Every
 * field below comes from the same declaration the router uses, so the document
 * cannot describe a route that is not mounted or omit one that is.
 *
 * Schemas come from zod's own `toJSONSchema`, which emits JSON Schema 2020-12 —
 * the dialect OpenAPI 3.1 adopted. No converter of our own, and no second
 * schema language to keep in step with the first.
 */

export const OPENAPI_VERSION = "3.1.0";
export const API_VERSION = "1.0.0";

type JsonSchema = Record<string, unknown>;

function schemaOf(schema: z.ZodType | undefined): JsonSchema | undefined {
  if (!schema) return undefined;
  // `io: "input"` describes what a caller sends: a field with a default is
  // optional on the wire even though it is always present after parsing.
  return z.toJSONSchema(schema, { io: "input", target: "draft-2020-12" }) as JsonSchema;
}

function outputSchemaOf(schema: z.ZodType | undefined): JsonSchema | undefined {
  if (!schema) return undefined;
  return z.toJSONSchema(schema, { io: "output", target: "draft-2020-12" }) as JsonSchema;
}

/** `/v1/games/:gameId` in Hono is `/v1/games/{gameId}` in OpenAPI. */
function openApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function pathParameters(path: string): JsonSchema[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => ({
    name: match[1],
    in: "path",
    required: true,
    schema: { type: "string" },
  }));
}

/**
 * A query schema becomes one parameter per property.
 *
 * Only object schemas are supported, and that is deliberate: a query string is
 * a flat map of strings, so anything else would be a shape the transport cannot
 * carry.
 */
function queryParameters(schema: z.ZodType | undefined): JsonSchema[] {
  const json = schemaOf(schema);
  if (!json || json.type !== "object") return [];
  const properties = (json.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((json.required as string[] | undefined) ?? []);
  return Object.entries(properties).map(([name, property]) => ({
    name,
    in: "query",
    required: required.has(name),
    schema: property,
  }));
}

const META_SCHEMA: JsonSchema = {
  type: "object",
  required: ["requestId"],
  properties: {
    requestId: { type: "string" },
    redactions: {
      type: "array",
      items: {
        type: "object",
        required: ["path", "reason"],
        properties: {
          path: { type: "string" },
          reason: { type: "string", enum: ["entitlement", "projection"] },
        },
      },
    },
  },
};

const PAGE_SCHEMA: JsonSchema = {
  type: "object",
  required: ["nextCursor", "hasMore"],
  properties: {
    nextCursor: { type: ["string", "null"] },
    hasMore: { type: "boolean" },
  },
};

const PROBLEM_SCHEMA: JsonSchema = {
  type: "object",
  required: ["type", "title", "status", "code", "instance", "requestId", "retryable"],
  properties: {
    type: { type: "string", format: "uri" },
    title: { type: "string" },
    status: { type: "integer" },
    code: { type: "string", enum: [...PROBLEM_CODE_LIST] },
    detail: { type: ["string", "null"] },
    instance: { type: "string" },
    requestId: { type: "string" },
    errors: {
      type: ["array", "null"],
      items: {
        type: "object",
        required: ["path", "code", "message"],
        properties: {
          path: { type: "string" },
          code: { type: "string" },
          message: { type: "string" },
        },
      },
    },
    retryable: { type: "boolean" },
    retryAfterSeconds: { type: ["integer", "null"] },
  },
};

function problemResponse(code: ProblemCode): JsonSchema {
  return {
    description: PROBLEM_CODES[code].title,
    content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } },
  };
}

/**
 * The problems every route can produce, plus the ones its own declaration
 * implies. Listing them per route rather than globally is what lets a client
 * generator produce an honest error union.
 */
function problemsFor(route: RouteDefinition<never, never, never>): ProblemCode[] {
  const codes: ProblemCode[] = ["INTERNAL_ERROR"];
  if (route.auth === "required") codes.unshift("AUTH_REQUIRED", "FORBIDDEN");
  if (route.querySchema || route.bodySchema) codes.unshift("VALIDATION_FAILED");
  if ((route.rateLimits?.length ?? 0) > 0) codes.push("RATE_LIMITED");
  if (requiresIdempotencyKey(route)) {
    codes.push("IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_IN_PROGRESS");
    if (!route.bodySchema) codes.unshift("VALIDATION_FAILED");
  }
  return [...new Set(codes)].sort((a, b) => PROBLEM_CODES[a].status - PROBLEM_CODES[b].status);
}

function successResponse(route: RouteDefinition<never, never, never>): JsonSchema {
  const data = outputSchemaOf(route.dataSchema) ?? {};
  if (route.envelope === "raw") {
    return {
      description: route.summary,
      content: { "application/json": { schema: data } },
    };
  }
  const schema: JsonSchema =
    route.envelope === "collection"
      ? {
          type: "object",
          required: ["data", "page", "meta"],
          // A collection route's `dataSchema` is the array itself, so the
          // document says exactly what the handler returns rather than
          // re-deriving a container the generator guessed at.
          properties: { data, page: PAGE_SCHEMA, meta: META_SCHEMA },
        }
      : {
          type: "object",
          required: ["data", "meta"],
          properties: { data, meta: META_SCHEMA },
        };
  const headers: Record<string, JsonSchema> = {
    "X-Request-Id": { schema: { type: "string" }, description: "Correlates with the structured log." },
  };
  if (route.etag) {
    headers.ETag = { schema: { type: "string" }, description: "Strong validator for If-None-Match." };
  }
  return {
    description: route.summary,
    headers,
    content: { "application/json": { schema } },
  };
}

export function generateOpenApiDocument(
  routes: readonly RouteDefinition<never, never, never>[],
): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of routes) {
    const path = openApiPath(route.path);
    const parameters: JsonSchema[] = [
      ...pathParameters(route.path),
      ...queryParameters(route.querySchema),
    ];
    if (requiresIdempotencyKey(route)) {
      parameters.push({
        name: "Idempotency-Key",
        in: "header",
        required: true,
        description:
          "Opaque client-generated value. An identical retry replays the original response; a different request under the same key is a conflict.",
        schema: { type: "string", maxLength: MAX_KEY_LENGTH },
      });
    }
    if (route.etag) {
      parameters.push({
        name: "If-None-Match",
        in: "header",
        required: false,
        schema: { type: "string" },
      });
    }

    const responses: Record<string, unknown> = {
      [String(route.successStatus)]: successResponse(route),
    };
    if (route.etag) responses["304"] = { description: "The caller's copy is current." };
    for (const code of problemsFor(route)) {
      responses[String(PROBLEM_CODES[code].status)] ??= problemResponse(code);
    }

    paths[path] ??= {};
    paths[path][route.method.toLowerCase()] = {
      operationId: route.operationId,
      summary: route.summary,
      ...(route.description ? { description: route.description } : {}),
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(route.bodySchema
        ? {
            requestBody: {
              required: true,
              content: { "application/json": { schema: schemaOf(route.bodySchema) } },
            },
          }
        : {}),
      responses,
      security: route.auth === "required" ? [{ supabaseBearer: [] }] : [],
    };
  }

  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: "Forma v1 API",
      version: API_VERSION,
      description:
        "Generated from the route registry in server/src/v1. The normative contract is plans/v1-api-contract.md; this document is checked against the implementation in CI.",
    },
    servers: [{ url: "https://api.formachess.com", description: "Production" }],
    components: {
      securitySchemes: {
        supabaseBearer: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description:
            "Supabase access token. The API derives actor, profile and subject from it; a client never selects a subject.",
        },
      },
      schemas: { Problem: PROBLEM_SCHEMA },
      parameters: {
        cursor: {
          name: "cursor",
          in: "query",
          required: false,
          description:
            "Opaque signed keyset cursor bound to the route and filter set it was issued for.",
          schema: { type: "string" },
        },
        limit: {
          name: "limit",
          in: "query",
          required: false,
          schema: { type: "integer", minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
        },
      },
    },
    externalDocs: { url: PROBLEM_TYPE_BASE, description: "Problem type registry" },
    paths,
  };
}

/** The bytes the committed artifact holds, so a diff is meaningful. */
export function serializeOpenApiDocument(document: Record<string, unknown>): string {
  return `${JSON.stringify(JSON.parse(canonicalJson(document)), null, 2)}\n`;
}

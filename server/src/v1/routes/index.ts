import { z } from "zod";
import { generateOpenApiDocument } from "../openapi.js";
import type { RouteDefinition } from "../registry.js";
import { ACCESS_ROUTES } from "./access.js";
import { ADMIN_ROUTES } from "./admin.js";
import { ARTIFACT_ROUTES } from "./artifacts.js";
import { CASE_STUDY_ROUTES } from "./case-studies.js";
import { DASHBOARD_ROUTES } from "./dashboard.js";
import { CONTINUATION_ROUTES } from "./continuations.js";
import { DIRECTORY_ROUTES } from "./directory.js";
import { GAME_ROUTES } from "./games.js";
import { IDENTITY_ROUTES } from "./identity.js";
import { GOAL_ROUTES } from "./goals.js";
import { ONBOARDING_ROUTES } from "./onboarding.js";
import { OPENING_BOOK_ROUTES } from "./opening-book.js";
import { OPENING_ROUTES } from "./openings.js";
import { PHASE_ROUTES } from "./phases.js";
import { PLAY_ROUTES } from "./play.js";
import { PRACTICE_ROUTES } from "./practice.js";
import { PUBLIC_ROUTES } from "./public.js";
import { REVIEW_ROUTES } from "./review.js";
import { WORKFLOW_ROUTES } from "./workflows.js";

/**
 * Every mounted `/v1` route, in one list.
 *
 * The list is the input to both the router and the OpenAPI generator, so the
 * document is a description of what is running rather than a parallel artifact.
 */

const PRODUCT_ROUTES = [
  ...PUBLIC_ROUTES,
  // Before every product route, because these are the two an account that has
  // not been let in may still reach, and the admin surface that decides it.
  ...ACCESS_ROUTES,
  ...ADMIN_ROUTES,
  ...DIRECTORY_ROUTES,
  ...CASE_STUDY_ROUTES,
  ...IDENTITY_ROUTES,
  ...ARTIFACT_ROUTES,
  ...WORKFLOW_ROUTES,
  ...GAME_ROUTES,
  ...REVIEW_ROUTES,
  ...ONBOARDING_ROUTES,
  ...GOAL_ROUTES,
  ...PRACTICE_ROUTES,
  ...PLAY_ROUTES,
  ...OPENING_ROUTES,
  ...OPENING_BOOK_ROUTES,
  ...DASHBOARD_ROUTES,
  ...PHASE_ROUTES,
  ...CONTINUATION_ROUTES,
] as unknown as RouteDefinition<never, never, never>[];

/**
 * `GET /v1/openapi.json` — the generated contract.
 *
 * Served raw rather than enveloped: it is a standard document with its own
 * media type, and wrapping it in `{ data, meta }` would make it unreadable to
 * every tool that consumes OpenAPI.
 *
 * The document is built once at module load. It is a pure function of the
 * registry, so rebuilding it per request would spend CPU to produce the same
 * bytes, and serving a stale copy is impossible — the registry cannot change
 * while the process runs.
 */
const document = generateOpenApiDocument(PRODUCT_ROUTES);

const openApiRoute: RouteDefinition<never, never, Record<string, unknown>> = {
  method: "GET",
  path: "/v1/openapi.json",
  operationId: "getOpenApiDocument",
  summary: "The generated OpenAPI 3.1 document for this API",
  kind: "read",
  auth: "public",
  envelope: "raw",
  successStatus: 200,
  dataSchema: z.record(z.string(), z.unknown()),
  etag: true,
  cacheControl: "public, max-age=300",
  async handler() {
    return { data: document };
  },
};

export const V1_ROUTES: readonly RouteDefinition<never, never, never>[] = [
  ...PRODUCT_ROUTES,
  openApiRoute as unknown as RouteDefinition<never, never, never>,
];

/**
 * The document as the committed artifact holds it.
 *
 * Deliberately excludes `/v1/openapi.json` itself: a document that described
 * the endpoint serving it would have to contain its own schema, and the
 * self-reference buys nothing a client needs.
 */
export function openApiDocument(): Record<string, unknown> {
  return document;
}

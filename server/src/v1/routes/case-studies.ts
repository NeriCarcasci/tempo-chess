import { z } from "zod";
import { CASE_STUDY_DEFAULT_LIMIT, CASE_STUDY_MAX_LIMIT, isValidSlug } from "../../public/contract.js";
import { listPublishedCaseStudies, readPublishedCaseStudy } from "../../public/editorial.js";
import {
  caseStudyRedactions,
  caseStudySummary,
  caseStudyView,
  isServable,
} from "../../public/projection.js";
import type { CaseStudySummaryView, CaseStudyView } from "../../public/projection.js";
import { type CursorScope, decodeCursor, encodeCursor } from "../cursor.js";
import { ProblemError } from "../problem.js";
import { POLICIES } from "../rate-limit.js";
import { routeKey, type RouteDefinition } from "../registry.js";

/**
 * `GET /v1/case-studies` and `GET /v1/case-studies/{slug}`, per §3.
 *
 * The public examples. §3 requires each one to identify "source/permission
 * basis, analysis publication/version, generated date, caveats, and redaction
 * status", and every one of those is a column somebody had to fill in before the
 * study could be published — the endpoint is the last step of E20's workflow,
 * not a renderer that hopes the data is there.
 *
 * Two things are checked twice on purpose. A row-level policy lets this
 * deployment see published studies only, *and* both queries say
 * `public_state = 'published'`. Consent is filtered in the query, *and*
 * `isServable` re-checks withdrawal and expiry against the clock. Neither
 * duplicate is defensive programming for its own sake: the first is the rule a
 * future feature will loosen, and the second is the difference between "we take
 * it down when the job runs" and "we take it down".
 */

const summarySchema = z.object({
  slug: z.string(),
  title: z.string(),
  summary: z.string(),
  publishedAt: z.string(),
  editorial: z.literal(true),
  permissionBasis: z.enum(["public_domain", "licence", "consent", "own_material"]),
});

const detailSchema = summarySchema.extend({
  subject: z.object({
    label: z.string(),
    kind: z.enum(["editorial", "case_study"]),
  }),
  caveats: z.array(z.string()),
  source: z.object({
    kind: z.enum([
      "historic_archive",
      "provider_public_profile",
      "licensed_dataset",
      "player_submission",
    ]),
    title: z.string(),
    publisher: z.string().nullable(),
    url: z.string().nullable(),
    retrievedAt: z.string().nullable(),
    licence: z.object({ key: z.string(), url: z.string() }).nullable(),
    attribution: z.string().nullable(),
  }),
  version: z.object({
    publicationId: z.string(),
    runId: z.string(),
    generatedAt: z.string(),
    recipeVersionId: z.string().nullable(),
    redactionPolicyVersion: z.string(),
  }),
  contentChecksum: z.string(),
});

const listQuery = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(CASE_STUDY_MAX_LIMIT).optional(),
});

const listRoute: RouteDefinition<z.infer<typeof listQuery>, never, CaseStudySummaryView[]> = {
  method: "GET",
  path: "/v1/case-studies",
  operationId: "listCaseStudies",
  summary: "Published editorial case studies, newest first",
  description:
    "Public. Only studies that are currently published and whose consent, where one underpins them, still stands. Withdrawing a study or its consent removes it from this list on the next request.",
  kind: "read",
  auth: "public",
  envelope: "collection",
  successStatus: 200,
  querySchema: listQuery,
  dataSchema: z.array(summarySchema),
  // Public and cacheable: a shared cache in front of this is the point of an
  // editorial surface. Five minutes bounds how long a withdrawal takes to
  // reach a reader through a CDN, which the runbook states rather than hides.
  cacheControl: "public, max-age=300",
  rateLimits: [{ policy: POLICIES.publicRead, source: "address" }],
  async handler({ query }) {
    const limit = query.limit ?? CASE_STUDY_DEFAULT_LIMIT;
    const scope: CursorScope = {
      routeKey: routeKey(listRoute),
      sortKey: "publishedAt:id",
      filters: {},
    };
    const anchor = query.cursor ? decodeCursor(query.cursor, scope).a : null;
    const rows = await listPublishedCaseStudies({
      after: anchor ? { publishedAt: String(anchor[0]), id: String(anchor[1]) } : null,
      limit: limit + 1,
    });
    const hasMore = rows.length > limit;
    // The page is a window over the keyset, and a study whose consent has just
    // been withdrawn drops out of it. That leaves a short page rather than a
    // shifted one, which is the right trade: a cursor that stayed consistent by
    // serving a withdrawn study is not a cursor problem.
    const window = rows.slice(0, limit);
    const last = window.at(-1);
    return {
      data: window
        .filter((row) => isServable(row.record))
        .map((row) => caseStudySummary(row.record)),
      page: {
        hasMore,
        nextCursor:
          hasMore && last
            ? encodeCursor(scope, [last.record.publishedAt!.toISOString(), last.id])
            : null,
      },
    };
  },
};

const detailRoute: RouteDefinition<never, never, CaseStudyView> = {
  method: "GET",
  path: "/v1/case-studies/:slug",
  operationId: "getCaseStudy",
  summary: "One published case study, with its source, permission basis and version",
  description:
    "Public. Carries the editorial source and the basis on which it may be republished, the exact analysis publication behind the claims, the caveats a reader needs, and a redaction block naming what this surface does not carry.",
  kind: "read",
  auth: "public",
  envelope: "resource",
  successStatus: 200,
  dataSchema: detailSchema,
  etag: true,
  cacheControl: "public, max-age=300",
  rateLimits: [{ policy: POLICIES.publicRead, source: "address" }],
  async handler({ params }) {
    const slug = params.slug ?? "";
    // A malformed slug is not a hint that a well-formed one would have worked,
    // and it is not a reason to run a query either.
    if (!isValidSlug(slug)) {
      throw new ProblemError("NOT_FOUND", { detail: "No such case study." });
    }
    const record = await readPublishedCaseStudy(slug);
    if (!record || !isServable(record)) {
      // Withdrawn, never published, and never existed are one answer. A 410 on
      // a withdrawal would tell a reader there used to be a study about a
      // person who has since asked us to stop talking about them.
      throw new ProblemError("NOT_FOUND", { detail: "No such case study." });
    }
    return { data: caseStudyView(record), redactions: caseStudyRedactions(record) };
  },
};

export const CASE_STUDY_ROUTES = [listRoute, detailRoute] as const;

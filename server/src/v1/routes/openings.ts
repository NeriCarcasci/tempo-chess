import { z } from "zod";
import { resolveAnalysisSubject, withActorContext } from "../auth/context.js";
import { ProblemError } from "../problem.js";
import { POLICIES } from "../rate-limit.js";
import type { RouteDefinition } from "../registry.js";
import {
  NO_FILTERS,
  readSubjectExplorer,
  type ExplorerFilters,
} from "../../openings/subject-explorer.js";

/**
 * The opening surface.
 *
 * `plans/v1-api-contract.md` §12 specifies five opening endpoints; this is the
 * first, and the only read the explorer screen needs. The other four are
 * repertoire and drill *commands*, which belong with the practice model rather
 * than beside a graph read.
 *
 * The whole graph ships in one response, on purpose. Walking a line is the
 * interaction, and a request per branch would put a network round trip inside a
 * keypress. The ply bound is what keeps that affordable, and it is enforced in
 * the query rather than by trimming the answer afterwards.
 *
 * Two honesty properties this route has to preserve, because the screen is
 * about to make claims from it:
 *
 *   - **An unanalysed game is not a clean game.** `coverage.playerDecisions`
 *     minus `coverage.scoredDecisions` is the number of the caller's own moves
 *     nobody has judged. Reporting only the failures would render that gap as
 *     an absence of mistakes.
 *   - **An empty sample is not an empty graph.** `graph` is null when there is
 *     nothing to walk, so the client renders a reason instead of a board with
 *     no branches under it.
 */

const explorerQuery = z.object({
  /** Provider slug. Absent means every linked provider. */
  provider: z.enum(["lichess", "chesscom"]).optional(),
  speed: z.enum(["bullet", "blitz", "rapid", "classical", "correspondence"]).optional(),
  color: z.enum(["white", "black"]).optional(),
  /** ISO instant. Games before it are excluded. */
  since: z.iso.datetime().optional(),
  family: z.string().trim().min(1).max(120).optional(),
});

const graphNodeSchema = z.object({
  k: z.string(),
  p: z.number().int(),
  g: z.number().int(),
  o: z.number().int(),
  f: z.number().int(),
  t: z.number().int(),
  x: z.union([z.literal(0), z.literal(1)]),
  nm: z.string().optional(),
});

const graphEdgeSchema = z.object({
  a: z.number().int(),
  b: z.number().int(),
  u: z.string(),
  s: z.string(),
  g: z.number().int(),
  sh: z.number().int(),
  ac: z.enum(["p", "o", "m"]),
  op: z.number().int(),
  fa: z.number().int(),
  /** Mean expected-score loss, 0..1. Not centipawns; see subject-explorer.ts. */
  dl: z.number().optional(),
  lb: z.string().optional(),
  /** Screening evaluation of the resulting position, White's perspective, cp. */
  ev: z.number().int().optional(),
  bm: z.literal(1).optional(),
});

const graphSchema = z.object({
  games: z.number().int(),
  root: z.number().int(),
  nodes: z.array(graphNodeSchema),
  edges: z.array(graphEdgeSchema),
});

const coverageSchema = z.object({
  games: z.number().int(),
  observations: z.number().int(),
  scoredDecisions: z.number().int(),
  playerDecisions: z.number().int(),
  unanalysedGames: z.number().int(),
});

const familySchema = z.object({
  family: z.string(),
  games: z.number().int(),
  playerDecisions: z.number().int(),
  scoredDecisions: z.number().int(),
  failures: z.number().int(),
});

const explorerSchema = z.object({
  /**
   * The newest publication behind this answer, not the time the query ran.
   * Null when nothing is published yet. Deriving it from the data rather than
   * from a clock is what lets the ETag on this route ever match.
   */
  asOf: z.string().nullable(),
  filters: z.object({
    provider: z.string().nullable(),
    speed: z.string().nullable(),
    color: z.enum(["white", "black"]).nullable(),
    since: z.string().nullable(),
    family: z.string().nullable(),
  }),
  coverage: coverageSchema,
  families: z.array(familySchema),
  /** Null when the filtered sample contains no move. */
  graph: graphSchema.nullable(),
});

function filtersOf(query: z.infer<typeof explorerQuery>): ExplorerFilters {
  return {
    ...NO_FILTERS,
    provider: query.provider ?? null,
    speed: query.speed ?? null,
    color: query.color ?? null,
    since: query.since ?? null,
    family: query.family ?? null,
  };
}

const explorerRoute: RouteDefinition<
  z.infer<typeof explorerQuery>,
  never,
  z.infer<typeof explorerSchema>
> = {
  method: "GET",
  path: "/v1/openings/explorer",
  operationId: "getOpeningExplorer",
  summary: "Your opening tree, from the positions your games actually reached",
  description:
    "The transposition-aware position graph for your own games, bounded to the opening. Every node is a core position, so two move orders reaching the same board are one node. Decision verdicts are cited from the published analysis of each game, and games with no published analysis are counted in coverage rather than treated as clean.",
  kind: "read",
  auth: "required",
  envelope: "resource",
  successStatus: 200,
  querySchema: explorerQuery,
  dataSchema: explorerSchema,
  // The graph changes only when a sync or an analysis publication lands, and
  // walking a line re-reads it, so an ETag turns most of those reads into a 304.
  etag: true,
  cacheControl: "private, max-age=0, must-revalidate",
  rateLimits: [{ policy: POLICIES.onboardingRead, source: "actor" }],
  async handler({ auth, query }) {
    if (!auth) throw new ProblemError("AUTH_REQUIRED");
    const filters = filtersOf(query);

    return withActorContext(auth.profileId, async (sql) => {
      // Not `auth.subjects[0]` — that is the profile id, always. See
      // `resolveAnalysisSubject`.
      const subjectId = await resolveAnalysisSubject(sql, auth.profileId);
      if (!subjectId) {
        // An actor with no subject has not been through onboarding. That is an
        // empty account, not a missing resource: answering 404 would make a new
        // signup look like a broken URL.
        return {
          data: {
            asOf: null,
            filters,
            coverage: {
              games: 0,
              observations: 0,
              scoredDecisions: 0,
              playerDecisions: 0,
              unanalysedGames: 0,
            },
            families: [],
            graph: null,
          },
        };
      }
      return { data: await readSubjectExplorer(sql, subjectId, filters) };
    });
  },
};

export const OPENING_ROUTES = [explorerRoute] as const;

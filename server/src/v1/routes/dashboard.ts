import { z } from "zod";
import { resolveAnalysisSubject, withActorContext } from "../auth/context.js";
import { ProblemError } from "../problem.js";
import { POLICIES } from "../rate-limit.js";
import type { RouteDefinition } from "../registry.js";
import { readDashboard } from "../../estimates/dashboard.js";

/**
 * Everything Forma has measured about you, as one published answer.
 *
 * `estimates/dashboard.ts` has been complete since E15: one atomic live
 * publication, every section named even when empty, and an absent section
 * saying `unavailable` with a reason rather than going missing. It was called
 * from five gates and from no route, so none of it could be read by anything
 * outside a test.
 *
 * That gap was invisible from the API and very visible from the product. The
 * baseline report ships its items as *identifiers* -- a finding id, an estimate
 * id, a trajectory snapshot id -- on the reasonable assumption that a client
 * would dereference them somewhere. There was nowhere. So a subject with
 * sixty-three skill estimates, twelve findings and a sixty-bin trajectory had
 * no endpoint that would return a single number of it, and a profile screen
 * could only render the shape of an answer.
 *
 * ## Why this is a read of a publication, not a query
 *
 * The dashboard is the report that was published, not a fresh computation. Two
 * people looking at the same subject on the same day must see the same claims,
 * and a re-derivation that disagreed with the findings stored beside it would
 * be worse than a stale one. `readDashboard` reads through E11's publication
 * pointer for exactly that reason, and this route adds nothing on top.
 *
 * ## What a 404 means here
 *
 * `readDashboard` answers null for "no such subject", "not yours" and "nothing
 * published yet" alike, and the route turns all three into one 404. That is
 * deliberate: distinguishing them is how an identifier becomes probeable. The
 * one case that is *not* a 404 is an actor with no analysis subject at all --
 * a new signup is an empty account, not a missing resource.
 */

const coverageSchema = z.object({
  success: z.number(),
  failure: z.number(),
  graded: z.number(),
  /** Chances the player never got. Never counted as failures. */
  censored: z.number(),
});

const estimateSchema = z.object({
  dimensionKey: z.string(),
  displayName: z.string(),
  /**
   * The words for this measurement, resolved from the promoted catalogue.
   *
   * `narrative` is nullable on purpose: a detector can be promoted ahead of the
   * code that reads it, and the honest answer then is the label and nothing
   * more rather than an invented sentence.
   */
  copy: z.object({
    conceptSlug: z.string().nullable(),
    role: z.string().nullable(),
    definition: z.string(),
    narrative: z.object({
      opportunity: z.string(),
      succeeded: z.string(),
      missed: z.string(),
    }).nullable(),
  }),
  frame: z.string(),
  /** Set on the pooled per-phase rows, null on the per-concept ones. */
  phase: z.string().nullable(),
  windowKind: z.string(),
  /**
   * Null with a reason, never a placeholder. A dimension nobody has enough
   * evidence for reports `unavailableReason` and no number, because rendering
   * an unknown rate as zero says the player always fails.
   */
  estimate: z.number().nullable(),
  intervalLow: z.number().nullable(),
  intervalHigh: z.number().nullable(),
  rawSampleSize: z.number(),
  effectiveSampleSize: z.number(),
  coverage: coverageSchema,
  coverageStatus: z.string(),
  unavailableReason: z.string().nullable(),
  delta: z.number().nullable(),
  improvementProbability: z.number().nullable(),
});

const findingSchema = z.object({
  id: z.string(),
  findingType: z.string(),
  priority: z.number(),
  confidenceTier: z.string(),
  claim: z.record(z.string(), z.unknown()),
  adjustedProbability: z.number().nullable(),
  evidence: z.array(
    z.object({ evidenceItemId: z.string(), role: z.string(), displayRank: z.number() }),
  ),
  /** Null when the renderer's own check refused the text it produced. */
  explanation: z.string().nullable(),
  explanationState: z.string().nullable(),
});

/**
 * The three phase cards.
 *
 * A pooled hit rate per phase, with the interval and the counts it came from,
 * plus how many games in the cohort reached the phase at all. Every field
 * except the rate exists so the card cannot be read as more than it is: an
 * endgame figure over eighty games and an opening figure over three hundred
 * are not the same kind of number, and a client that only received the rate
 * would have no way to say so.
 */
const phasesSchema = z.object({
  state: z.enum(["published", "unavailable"]),
  /** The frozen cohort every count below is over, not the whole synced history. */
  gamesInCohort: z.number(),
  phases: z.array(
    z.object({
      phase: z.string(),
      chances: z.number(),
      observed: z.number(),
      taken: z.number(),
      /** Chances that ended before the player was on move. Never failures. */
      setAside: z.number(),
      rate: z.number().nullable(),
      intervalLow: z.number().nullable(),
      intervalHigh: z.number().nullable(),
      coverageStatus: z.string(),
      unavailableReason: z.string().nullable(),
      gamesReaching: z.number().nullable(),
      phaseReachRate: z.number().nullable(),
    }),
  ),
});

const trajectorySchema = z.object({
  state: z.enum(["published", "unavailable"]),
  snapshotId: z.string().nullable(),
  includedGameCount: z.number(),
  bins: z.array(
    z.object({
      phase: z.string(),
      binOrdinal: z.number(),
      progressLow: z.number(),
      progressHigh: z.number(),
      gamesContributing: z.number(),
      medianExpectedScore: z.number(),
      p25ExpectedScore: z.number(),
      p75ExpectedScore: z.number(),
      intervalLow: z.number().nullable(),
      intervalHigh: z.number().nullable(),
      phaseReachRate: z.number(),
    }),
  ),
  /** Phases with no bins, named so a client does not draw a flat line. */
  unreachedPhases: z.array(z.string()),
});

const ratingProfileSchema = z.object({
  state: z.enum(["published", "unavailable"]),
  pools: z.array(
    z.object({
      provider: z.string(),
      pool: z.string(),
      speed: z.string(),
      observedRating: z.number().nullable(),
      scaleEstimate: z.number().nullable(),
      intervalLow: z.number().nullable(),
      intervalHigh: z.number().nullable(),
      inSupportedRange: z.boolean(),
      suppressedReason: z.string().nullable(),
    }),
  ),
  note: z.string(),
});

const sectionState = z.enum(["published", "unavailable"]);

const dashboardSchema = z.object({
  subjectId: z.string(),
  publicationId: z.string(),
  runId: z.string(),
  /**
   * When this answer was published. Derived from the publication, never from a
   * clock: an `asOf` that moved on every request would make the ETag differ on
   * every request, which is the same as having no ETag.
   */
  publishedAt: z.string(),
  sections: z.object({
    estimates: sectionState,
    findings: sectionState,
    phases: sectionState,
    trajectory: sectionState,
    ratingProfile: sectionState,
    goal: sectionState,
    connections: sectionState,
  }),
  estimates: z.array(estimateSchema),
  findings: z.array(findingSchema),
  phases: phasesSchema,
  trajectory: trajectorySchema,
  ratingProfile: ratingProfileSchema,
  coverageWarnings: z.array(z.string()),
  version: z.object({
    recipeVersionId: z.string(),
    snapshotId: z.string(),
    estimatorVersions: z.array(z.string()),
  }),
});

const dashboardRoute: RouteDefinition<never, never, z.infer<typeof dashboardSchema>> = {
  method: "GET",
  path: "/v1/dashboard",
  operationId: "getDashboard",
  summary: "Every measurement behind your published profile",
  description:
    "The published dashboard for your own subject: skill estimates with their intervals and sample "
    + "sizes, findings with their evidence, a pooled rate per phase of the game, the trajectory bins, "
    + "and the rating profile. This is the report that was published rather than a fresh computation, "
    + "so it always agrees with the findings stored beside it. Estimates carry a null value and a "
    + "reason when the evidence is too thin, and censored chances are reported separately from "
    + "failures because a chance the player never got is not a chance they missed. Every count in "
    + "`phases` is over the frozen cohort named by `phases.gamesInCohort`, which is smaller than the "
    + "account's synced history.",
  kind: "read",
  auth: "required",
  envelope: "resource",
  successStatus: 200,
  dataSchema: dashboardSchema,
  // A publication changes only when a new one lands, and a profile screen
  // re-reads it on every visit, so an ETag turns most of those into a 304.
  etag: true,
  cacheControl: "private, max-age=0, must-revalidate",
  rateLimits: [{ policy: POLICIES.onboardingRead, source: "actor" }],
  async handler({ auth }) {
    if (!auth) throw new ProblemError("AUTH_REQUIRED");

    return withActorContext(auth.profileId, async (sql) => {
      // Not `auth.subjects[0]` — that is the profile id, always.
      const subjectId = await resolveAnalysisSubject(sql, auth.profileId);
      if (!subjectId) {
        throw new ProblemError("NOT_FOUND", { detail: "No published profile yet." });
      }
      const dashboard = await readDashboard(sql, { subjectId, ownerProfileId: auth.profileId });
      if (!dashboard) {
        throw new ProblemError("NOT_FOUND", { detail: "No published profile yet." });
      }
      return { data: dashboard };
    });
  },
};

export const DASHBOARD_ROUTES = [dashboardRoute] as const;

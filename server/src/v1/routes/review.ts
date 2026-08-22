/**
 * `GET /v1/games/{gameId}/review`, `POST /v1/games/{gameId}/analysis` and
 * `POST /v1/positions/evaluations`, per plans/v1-api-contract.md §§7 and 14.
 *
 * The routes are thin. Ownership is the caller's profile passed as an argument
 * into the query, so a game belonging to someone else returns the same 404 as
 * one that does not exist; the recipe and the search limits are resolved
 * server-side, so there is no request field that could carry a depth, a thread
 * count or a MultiPV; and every "not yet" is a named state rather than an empty
 * array.
 */

import { z } from "zod";
import { recordAuditEvent } from "../audit.js";
import { ProblemError } from "../problem.js";
import type { RouteDefinition } from "../registry.js";
import { POLICIES } from "../rate-limit.js";
import type { Sql } from "postgres";
import { withActor } from "../../db/actor.js";
import { withActorContext } from "../auth/context.js";
import { client } from "../../db/client.js";
import { readGameReview } from "../../engine/review.js";
import { planGameAnalysis } from "../../engine/plan.js";
import { EVALUATION_PURPOSES, evaluatePositionRequest } from "../../engine/interactive.js";
import { ENGINE_PROFILES } from "../../engine/contract.js";

const GAME_ID = z.uuid();

/** A malformed id is not a hint that a well-formed one would have worked. */
function gameIdOf(params: Record<string, string>): string {
  const parsed = GAME_ID.safeParse(params.gameId);
  if (!parsed.success) throw new ProblemError("NOT_FOUND", { detail: "No such game." });
  return parsed.data;
}

// ---------------------------------------------------------------------------
// GET /v1/games/{gameId}/review
// ---------------------------------------------------------------------------

const sectionState = z.enum(["published", "unavailable"]);

const reviewMoveSchema = z.object({
  fromPly: z.number().int(),
  uci: z.string(),
  san: z.string().nullable(),
  actorColor: z.enum(["white", "black"]),
  phase: z.string().nullable(),
  expectedScoreBefore: z.number(),
  expectedScoreAfter: z.number(),
  decisionLoss: z.number(),
  acceptable: z.boolean(),
  bestMoveUci: z.string().nullable(),
  playedMoveRank: z.number().int().nullable(),
  acceptableMoveCount: z.number().int().nullable(),
  onlyMove: z.boolean().nullable(),
  criticality: z.number().nullable(),
  evidence: z.object({ beforeScope: z.string(), afterScope: z.string() }),
  deep: z.object({
    status: z.enum(["not_selected", "selected", "completed", "unavailable"]),
    reasons: z.array(z.object({ code: z.string(), observed: z.union([z.number(), z.string()]) })),
    candidates: z.array(
      z.object({
        rank: z.number().int(),
        uci: z.string(),
        expectedScore: z.number(),
        pv: z.array(z.string()),
      }),
    ),
  }),
});

/**
 * One concept label as a client reads it.
 *
 * `success` is nullable and `censoredReason` sits beside it because the two are
 * one fact: a response nobody made is censored, not failed, and a client that
 * renders a null success as a loss would undo the constraint the database
 * enforces.
 */
const reviewConceptSchema = z.object({
  slug: z.string(),
  displayName: z.string(),
  definition: z.string(),
  conceptVersionId: z.string(),
  versionNo: z.number().int(),
  role: z.string(),
  color: z.string(),
  detectorVersion: z.string(),
  observed: z.boolean(),
  success: z.boolean().nullable(),
  censoredReason: z.string().nullable(),
  opportunityPly: z.number().int(),
  responsePly: z.number().int().nullable(),
  difficulty: z.record(z.string(), z.number()).nullable(),
  confidence: z.number().nullable(),
  evidenceSourceKind: z.string(),
  evidenceItemId: z.string().nullable(),
});

/**
 * One physical occurrence, with everything measured about it hanging off it.
 *
 * `facts` is bounded rather than open: the read model copies primitives and flat
 * arrays of primitives out of the detector's jsonb and drops the rest, so the
 * response shape is not whatever the last detector happened to write.
 */
const reviewEventSchema = z.object({
  eventType: z.string(),
  startPly: z.number().int(),
  focalPly: z.number().int(),
  endPly: z.number().int(),
  actorColor: z.string().nullable(),
  affectedColor: z.string().nullable(),
  completeness: z.string(),
  confidence: z.number().nullable(),
  facts: z.record(z.string(), z.unknown()),
  concepts: z.array(reviewConceptSchema),
});

const reviewSchema = z.object({
  gameId: z.string(),
  runId: z.string(),
  replayRevisionId: z.string(),
  stale: z.boolean(),
  sections: z.object({
    transitions: sectionState,
    criticalMoments: sectionState,
    events: sectionState,
    concepts: sectionState,
    explanations: sectionState,
    trajectory: sectionState,
  }),
  moves: z.array(reviewMoveSchema),
  events: z.array(reviewEventSchema),
  criticalMoments: z.array(
    z.object({
      fromPly: z.number().int(),
      criticality: z.number().nullable(),
      reasons: z.array(z.string()),
    }),
  ),
  version: z.object({
    publicationId: z.string(),
    generatedAt: z.string(),
    subjectSnapshotId: z.string().nullable(),
    recipeVersionId: z.string().nullable(),
    policyVersions: z.record(z.string(), z.string()),
  }),
});

const getReviewRoute: RouteDefinition<never, never, z.infer<typeof reviewSchema>> = {
  method: "GET",
  path: "/v1/games/:gameId/review",
  operationId: "getGameReview",
  summary: "The published objective review of one owned game",
  description:
    "Transition assessments, critical moments and detected concepts for the run the publication pointer currently names. `sections` states what each part of the review can say: `unavailable` means the component has not run, which is different from an empty result -- `events: published` with an empty array is a game that was measured and had nothing in it. Concept `success` is null exactly when `observed` is false, and `censoredReason` says why; a response nobody made is censored, never failed. `decisionLoss` is actor-perspective expected score given up, measured against the tolerance rule the run pinned; it is not a `mistake` label.",
  kind: "read",
  auth: "required",
  envelope: "resource",
  successStatus: 200,
  dataSchema: reviewSchema,
  // The body changes only when the pointer moves, and a client re-reads it
  // while stepping through a game, so an ETag turns most reads into a 304.
  etag: true,
  cacheControl: "private, max-age=0, must-revalidate",
  async handler({ auth, params, requestId, traceId }) {
    const gameId = gameIdOf(params);
    const owner = auth!.profileId;
    const review = await withActorContext(owner, (tx) =>
      readGameReview(tx, { subjectGameId: gameId, ownerProfileId: owner }),
    );
    if (!review) {
      await recordAuditEvent({
        actorKind: "user",
        actorRef: owner,
        action: "game_review.access_denied",
        targetType: "subject_game",
        targetRef: gameId,
        requestId,
        traceId,
        result: "denied",
        reasonCode: "not_owned_absent_or_unpublished",
      });
      throw new ProblemError("NOT_FOUND", { detail: "No published review for that game." });
    }
    return { data: review };
  },
};

// ---------------------------------------------------------------------------
// POST /v1/games/{gameId}/analysis
// ---------------------------------------------------------------------------

/**
 * §7: `{ reason: "user_request", recipe?: "current" }`.
 *
 * `recipe` accepts exactly the string `current` and nothing else. Keeping the
 * field means a client can be explicit; keeping its domain to one value means
 * being explicit cannot become choosing.
 */
const analysisBodySchema = z
  .object({
    reason: z.literal("user_request"),
    recipe: z.literal("current").optional(),
  })
  .strict();

const analysisResultSchema = z.object({
  state: z.enum(["published", "scheduled"]),
  runId: z.string().nullable(),
  workflowId: z.string().nullable(),
  publicationId: z.string().nullable(),
});

const requestAnalysisRoute: RouteDefinition<
  never,
  z.infer<typeof analysisBodySchema>,
  z.infer<typeof analysisResultSchema>
> = {
  method: "POST",
  path: "/v1/games/:gameId/analysis",
  operationId: "requestGameAnalysis",
  summary: "Analyse one owned game, or return the analysis that already covers it",
  description:
    "Returns 200 with the existing publication when the current replay revision is already analysed, and 202 with a workflow otherwise. The recipe and every search limit are selected server-side; there is no parameter for depth, threads or MultiPV.",
  kind: "command",
  auth: "required",
  idempotency: "key",
  envelope: "resource",
  successStatus: 202,
  bodySchema: analysisBodySchema,
  dataSchema: analysisResultSchema,
  async handler({ auth, params, requestId, traceId }) {
    const gameId = gameIdOf(params);
    const owner = auth!.profileId;
    // Inside the actor context: `analysis.runs` forces an owner policy whose
    // `with check` is what stops this command creating a run for a subject the
    // caller does not own, and an unbound connection would simply be refused.
    const outcome = await withActor(client as unknown as Sql, owner, (tx) =>
      planGameAnalysis(tx, { subjectGameId: gameId, ownerProfileId: owner }),
    );
    if (!outcome) {
      await recordAuditEvent({
        actorKind: "user",
        actorRef: owner,
        action: "game_analysis.access_denied",
        targetType: "subject_game",
        targetRef: gameId,
        requestId,
        traceId,
        result: "denied",
        reasonCode: "not_owned_or_absent",
      });
      throw new ProblemError("NOT_FOUND", { detail: "No such game." });
    }
    if (outcome.state === "unavailable") {
      // Truthful rather than optimistic. A 202 here would promise a workflow
      // that cannot run, and the user would wait for an analysis that never
      // arrives because nobody has promoted a recipe or published a chain.
      throw new ProblemError("CONFLICT", {
        detail:
          outcome.reason === "no_promoted_recipe"
            ? "No analysis recipe is currently promoted for game review."
            : "That game's replay has not been materialized yet.",
      });
    }
    if (outcome.state === "published") {
      return {
        status: 200,
        data: {
          state: "published",
          runId: outcome.runId,
          workflowId: null,
          publicationId: outcome.publicationId,
        },
        resource: { type: "analysis_run", id: outcome.runId },
      };
    }
    return {
      status: 202,
      data: {
        state: "scheduled",
        runId: outcome.runId,
        workflowId: outcome.workflowId,
        publicationId: null,
      },
      resource: { type: "workflow", id: outcome.workflowId },
    };
  },
};

// ---------------------------------------------------------------------------
// POST /v1/positions/evaluations
// ---------------------------------------------------------------------------

const evaluationBodySchema = z
  .object({
    // Long enough for any legal FEN and far too short for a PGN.
    fen: z.string().min(10).max(120),
    purpose: z.enum(EVALUATION_PURPOSES),
  })
  .strict();

const evaluationResultSchema = z.object({
  state: z.enum(["ready", "scheduled"]),
  workflowId: z.string().nullable(),
  evaluation: z
    .object({
      /** White's expected points, from the pinned calibration. */
      expectedScore: z.number(),
      scoreCp: z.number().int().nullable(),
      mateIn: z.number().int().nullable(),
      bestMoveUci: z.string().nullable(),
      candidates: z.array(z.object({ uci: z.string(), expectedScore: z.number() })),
      /** The bounded search that produced it. Fixed server-side. */
      profile: z.object({
        limitType: z.string(),
        limitValue: z.number().int(),
        multipv: z.number().int(),
      }),
      scope: z.string(),
    })
    .nullable(),
});

const evaluatePositionRoute: RouteDefinition<
  never,
  z.infer<typeof evaluationBodySchema>,
  z.infer<typeof evaluationResultSchema>
> = {
  method: "POST",
  path: "/v1/positions/evaluations",
  operationId: "evaluatePosition",
  summary: "One bounded engine evaluation of a supplied position",
  description:
    "Returns 200 with a cached result or 202 with a workflow. The server validates the FEN as a legal standard chess position and selects a fixed profile; depth, threads and MultiPV are not request parameters. The result is isolated from the historical-analysis pipeline and never becomes evidence about a player.",
  kind: "command",
  auth: "required",
  idempotency: "key",
  envelope: "resource",
  successStatus: 202,
  bodySchema: evaluationBodySchema,
  dataSchema: evaluationResultSchema,
  rateLimits: [{ policy: POLICIES.interactiveEvaluation, source: "actor" }],
  async handler({ auth, body }) {
    const outcome = await evaluatePositionRequest(client, {
      fen: body.fen,
      purpose: body.purpose,
      ownerProfileId: auth!.profileId,
    });
    if (outcome.state === "invalid_position") {
      throw new ProblemError("VALIDATION_FAILED", {
        detail: outcome.detail,
        errors: [{ path: "body.fen", code: "MALFORMED", message: outcome.detail }],
      });
    }
    if (outcome.state === "unavailable") {
      throw new ProblemError("CONFLICT", {
        detail: "No analysis recipe is currently promoted, so no engine profile is selectable.",
      });
    }
    if (outcome.state === "ready") {
      return {
        status: 200,
        data: {
          state: "ready",
          workflowId: null,
          evaluation: {
            expectedScore: outcome.evaluation.expectedScore,
            scoreCp: outcome.evaluation.scoreCp,
            mateIn: outcome.evaluation.mateIn,
            bestMoveUci: outcome.evaluation.bestMoveUci,
            candidates: outcome.evaluation.candidateMoves.map((uci, index) => ({
              uci,
              expectedScore: outcome.evaluation.candidateExpectedScores[index]!,
            })),
            profile: {
              limitType: ENGINE_PROFILES.interactive.limitType,
              limitValue: ENGINE_PROFILES.interactive.limitValue,
              multipv: ENGINE_PROFILES.interactive.multipv,
            },
            scope: outcome.evaluation.scope,
          },
        },
      };
    }
    return {
      status: 202,
      data: { state: "scheduled", workflowId: outcome.workflowId, evaluation: null },
      resource: { type: "workflow", id: outcome.workflowId },
    };
  },
};

export const REVIEW_ROUTES = [
  getReviewRoute,
  requestAnalysisRoute,
  evaluatePositionRoute,
] as const;

import { z } from "zod";

import { client } from "../../db/client.js";
import {
  CONTINUATION_RATING_MAX,
  CONTINUATION_RATING_MIN,
  requestContinuationMove,
} from "../../models/continuation.js";
import { ProblemError } from "../problem.js";
import { POLICIES } from "../rate-limit.js";
import type { RouteDefinition } from "../registry.js";

const continuationBodySchema = z
  .object({
    fen: z.string().min(10).max(120),
    rating: z.number().int().min(CONTINUATION_RATING_MIN).max(CONTINUATION_RATING_MAX),
    /** Stable for one game turn; used to make policy sampling retry-safe. */
    turnKey: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
  })
  .strict();

const continuationResultSchema = z.object({
  state: z.enum(["ready", "scheduled"]),
  workflowId: z.string().nullable(),
  moveUci: z.string().nullable(),
  rating: z.number().int(),
  candidates: z.array(z.object({ uci: z.string(), probability: z.number() })),
});

const requestContinuationRoute: RouteDefinition<
  never,
  z.infer<typeof continuationBodySchema>,
  z.infer<typeof continuationResultSchema>
> = {
  method: "POST",
  path: "/v1/positions/continuations",
  operationId: "requestPositionContinuation",
  summary: "Ask Maia for a human-style reply from a position",
  description:
    "Validates a standard-chess FEN and uses the promoted CPU Maia-3 policy at the requested rating. A cached policy returns immediately; a cache miss returns a durable workflow. Repeating a completed request with the same turnKey returns the same sampled move. This is a scenario continuation primitive, not the legacy play surface and not an objective engine evaluation.",
  kind: "command",
  auth: "required",
  idempotency: "key",
  envelope: "resource",
  successStatus: 202,
  bodySchema: continuationBodySchema,
  dataSchema: continuationResultSchema,
  rateLimits: [{ policy: POLICIES.maiaContinuation, source: "actor" }],
  async handler({ auth, body }) {
    const outcome = await requestContinuationMove(client, {
      ...body,
      ownerProfileId: auth!.profileId,
    });
    if (outcome.state === "invalid_position") {
      throw new ProblemError("VALIDATION_FAILED", {
        detail: outcome.detail,
        errors: [{ path: "body.fen", code: "MALFORMED", message: outcome.detail }],
      });
    }
    if (outcome.state === "terminal_position") {
      throw new ProblemError("CONFLICT", { detail: outcome.detail });
    }
    if (outcome.state === "unavailable") {
      throw new ProblemError("CONFLICT", {
        detail: "No calibrated Maia-3 model is currently promoted.",
      });
    }
    if (outcome.state === "scheduled") {
      return {
        status: 202,
        data: {
          state: "scheduled",
          workflowId: outcome.workflowId,
          moveUci: null,
          rating: body.rating,
          candidates: [],
        },
        resource: { type: "workflow", id: outcome.workflowId },
      };
    }
    return {
      status: 200,
      data: {
        state: "ready",
        workflowId: null,
        moveUci: outcome.moveUci,
        rating: outcome.rating,
        candidates: [...outcome.candidates],
      },
    };
  },
};

export const CONTINUATION_ROUTES = [requestContinuationRoute] as const;

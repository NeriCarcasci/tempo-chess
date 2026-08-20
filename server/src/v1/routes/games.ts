import { z } from "zod";
import { recordAuditEvent } from "../audit.js";
import { ProblemError } from "../problem.js";
import { POLICIES } from "../rate-limit.js";
import type { RouteDefinition } from "../registry.js";
import { readSubjectGame } from "../../analysis/game-view.js";
import {
  readRecentSubjectGames,
  RECENT_GAMES_DEFAULT_LIMIT,
  RECENT_GAMES_MAX_LIMIT,
  type RecentGames,
} from "../../analysis/recent-games.js";
import { resolveAnalysisSubject, withActorContext } from "../auth/context.js";

// ---------------------------------------------------------------------------
// GET /v1/games/{gameId}
// ---------------------------------------------------------------------------

/**
 * `GET /v1/games/{gameId}`, per plans/v1-api-contract.md §7.
 *
 * E11's version-bearing read, and only that. §7 gives this resource metadata,
 * participants, subject perspective, the current replay revision, and the
 * analysis/publication state; the review body — transition assessments,
 * critical moments, events, explanations — belongs to E12 and is deliberately
 * absent rather than stubbed. An endpoint that returned an empty `review`
 * object would be claiming to have analysed a game it has not, which is exactly
 * what this epic is not allowed to ship.
 *
 * What it does carry is the §1.2 version block, populated for the first time:
 * the publication id, when it was installed, the recipe, and every pinned
 * component version behind it. That is the point of the endpoint — a claim
 * whose provenance a client can read.
 *
 * Ownership is checked through the subject-game relationship inside the query,
 * with the caller's profile as an argument. There is no parameter that selects
 * another owner, and a game the caller does not own returns the same 404 as one
 * that does not exist.
 */

const participantSchema = z.object({
  color: z.enum(["white", "black"]),
  username: z.string().nullable(),
  title: z.string().nullable(),
  rating: z.number().int().nullable(),
  ratingChange: z.number().int().nullable(),
  outcome: z.enum(["win", "loss", "draw"]),
  isBot: z.boolean().nullable(),
});

const versionBlockSchema = z.object({
  publicationId: z.string(),
  generatedAt: z.string(),
  subjectSnapshotId: z.string().nullable(),
  recipeVersionId: z.string().nullable(),
  policyVersions: z.record(z.string(), z.string()),
});

const gameSchema = z.object({
  id: z.string(),
  provider: z.string(),
  providerUrl: z.string().nullable(),
  playedAt: z.string(),
  rated: z.boolean().nullable(),
  speed: z.string().nullable(),
  timeControl: z.string().nullable(),
  result: z.enum(["white", "black", "draw"]),
  termination: z.string().nullable(),
  plyCount: z.number().int(),
  subject: z.object({
    color: z.enum(["white", "black"]).nullable(),
    status: z.string(),
  }),
  replayRevision: z.object({
    id: z.string(),
    revisionNo: z.number().int(),
    reason: z.string(),
  }),
  analysis: z.object({
    /**
     * `stale` means a publication exists but the provider has since corrected
     * the replay, so the published analysis was computed from a revision that
     * is no longer current. Calling that `published` would attach a claim to
     * evidence that moved underneath it.
     */
    state: z.enum(["published", "stale", "running", "failed", "unavailable"]),
    runId: z.string().nullable(),
    publishedRevisionId: z.string().nullable(),
  }),
  version: versionBlockSchema.nullable(),
  participants: z.array(participantSchema),
});

type Game = z.infer<typeof gameSchema>;

const GAME_ID = z.uuid();

/** A malformed id is not a hint that a well-formed one would have worked. */
function gameIdOf(params: Record<string, string>): string {
  const parsed = GAME_ID.safeParse(params.gameId);
  if (!parsed.success) throw new ProblemError("NOT_FOUND", { detail: "No such game." });
  return parsed.data;
}

const getGameRoute: RouteDefinition<never, never, Game> = {
  method: "GET",
  path: "/v1/games/:gameId",
  operationId: "getGame",
  summary: "One owned game, with the version block of its published analysis",
  description:
    "Metadata, participants, subject perspective, current replay revision and publication state. `version` is null until an analysis has been published for this game, and `analysis.state` is `stale` when the published run read an older replay revision than the current one.",
  kind: "read",
  auth: "required",
  envelope: "resource",
  successStatus: 200,
  dataSchema: gameSchema,
  // The body changes only when a pointer moves or a correction lands, and a
  // client re-reads it often, so an ETag turns most reads into a 304. Private,
  // because it is one account's game.
  etag: true,
  cacheControl: "private, max-age=0, must-revalidate",
  async handler({ auth, params, requestId, traceId }) {
    const gameId = gameIdOf(params);
    const owner = auth!.profileId;
    // Read inside the actor context, so the forced row-level policies on the
    // publication tables are exercised on the real request path rather than
    // only in a gate.
    const view = await withActorContext(owner, (tx) =>
      readSubjectGame(tx, { subjectGameId: gameId, ownerProfileId: owner }),
    );
    if (!view) {
      await recordAuditEvent({
        actorKind: "user",
        actorRef: owner,
        action: "game.access_denied",
        targetType: "subject_game",
        targetRef: gameId,
        requestId,
        traceId,
        result: "denied",
        reasonCode: "not_owned_or_absent",
      });
      throw new ProblemError("NOT_FOUND", { detail: "No such game." });
    }
    return { data: view };
  },
};

// ---------------------------------------------------------------------------
// GET /v1/games/recent
// ---------------------------------------------------------------------------

const moveSchema = z.object({
  uci: z.string(),
  san: z.string().nullable(),
  clockMs: z.number().nullable(),
});

const recentGameSchema = z.object({
  id: z.string(),
  playedAt: z.string(),
  speed: z.string().nullable(),
  result: z.enum(["white", "black", "draw"]),
  color: z.enum(["white", "black"]).nullable(),
  outcome: z.enum(["win", "loss", "draw"]).nullable(),
  opponent: z.object({
    username: z.string().nullable(),
    title: z.string().nullable(),
    rating: z.number().int().nullable(),
  }),
  providerUrl: z.string().nullable(),
  /** Null means the standard starting position. */
  initialFen: z.string().nullable(),
  moves: z.array(moveSchema),
});

const recentGamesSchema = z.object({
  /** The newest sync behind this answer, not the time the query ran. */
  asOf: z.string().nullable(),
  games: z.array(recentGameSchema),
});

const recentQuery = z.object({
  limit: z.coerce.number().int().min(1).max(RECENT_GAMES_MAX_LIMIT).optional(),
});

/**
 * `GET /v1/games/recent` — the newest owned games, moves included.
 *
 * A resource rather than a collection, because the body carries `asOf` beside
 * the list and the collection envelope's `data` is the bare array. It is also
 * not a paginated surface: the whole point is a bounded handful of boards to
 * animate, and a cursor would advertise a walk of the entire history that this
 * endpoint has no intention of serving.
 */
const recentGamesRoute: RouteDefinition<z.infer<typeof recentQuery>, never, RecentGames> = {
  method: "GET",
  path: "/v1/games/recent",
  operationId: "listRecentGames",
  summary: "Your newest synced games, with the moves in them",
  description:
    "Newest first by when the game was played. Each game carries its full move list, so a client can replay the board without a second request. `initialFen` is null for the standard starting position. `asOf` is when the newest of these games was last written by a sync, so the ETag matches until something actually changes. Nothing here depends on analysis having run.",
  kind: "read",
  auth: "required",
  envelope: "resource",
  successStatus: 200,
  querySchema: recentQuery,
  dataSchema: recentGamesSchema,
  // The onboarding screen re-reads this while it waits, and the answer only
  // changes when a sync writes, so an ETag turns most of those polls into a 304
  // instead of resending every move of every game.
  etag: true,
  cacheControl: "private, max-age=0, must-revalidate",
  rateLimits: [{ policy: POLICIES.onboardingRead, source: "actor" }],
  async handler({ auth, query }) {
    if (!auth) throw new ProblemError("AUTH_REQUIRED");
    const limit = query.limit ?? RECENT_GAMES_DEFAULT_LIMIT;

    return withActorContext(auth.profileId, async (sql) => {
      // Not `auth.subjects[0]` — that is the profile id, always, and querying
      // `subject_id = <profile uuid>` matches nothing while looking exactly
      // like an account with no games. See `resolveAnalysisSubject`.
      const subjectId = await resolveAnalysisSubject(sql, auth.profileId);
      // No subject means the account has not been through onboarding. That is
      // an empty account, not a missing resource: a 404 here would make a fresh
      // signup look like a broken URL.
      if (!subjectId) return { data: { asOf: null, games: [] } };
      return { data: await readRecentSubjectGames(sql, { subjectId, limit }) };
    });
  },
};

// `/v1/games/recent` is registered before `/v1/games/:gameId` because Hono runs
// matched handlers in registration order and stops at the first that answers.
// With the parameterised route first, `recent` is matched as a game id, fails
// the uuid parse, and the endpoint 404s.
export const GAME_ROUTES = [recentGamesRoute, getGameRoute] as const;

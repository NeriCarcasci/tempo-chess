/**
 * Rating a pasted game as durable work, across two chained workflows.
 *
 * The chain exists because a work ledger fixes a workflow's items when the
 * workflow is created, and the second half of a rating cannot be described
 * until the first half has run: which positions deserve the human policy
 * depends on what the engine said about them.
 *
 *   workflow one   game_rating_prepare       cpu_engine     stockfish-screen
 *                    screens every position, picks the deep set and the policy
 *                    plies, runs the deeper searches, and creates:
 *   workflow two   maia3_generate_continuation_policy (xN)
 *                                            cpu_interactive_model  maia-rating
 *                  game_rating_assemble      aggregation    analysis
 *
 * Both carry `resource_type = 'game_rating'` and the game's key, so the API can
 * find an in-flight rating without knowing the chain exists. A caller polls one
 * key and never sees a workflow id.
 *
 * Two things are deliberately *not* new here.
 *
 * The policy items are the play feature's own task, on a different queue. The
 * work is identical — one inference at one position for one rung — and only the
 * scheduling differs, so a second task type would have been a second thing to
 * keep correct. And the cache they read and write is the same cache, keyed by
 * position and rating, which is what makes a famous game cheap the second time
 * and what makes an opening warm for everybody.
 *
 * The engine side is one item rather than fifty. Screening is cheap, the deep
 * selection needs the screening answers in the same process, and `forma-stockfish`
 * has fifteen minutes to do both. Fifty items would have bought queue overhead
 * and a second dependency stage for nothing.
 */

import type { Sql } from "postgres";

import { parsePgn } from "../ingest/pgn.js";
import { analyzeFens } from "../engine/stockfish.js";
import { expectedScore } from "../engine/contract.js";
import {
  CONTINUATION_TASK,
  lookupContinuation,
  readContinuationPolicy,
} from "../models/continuation.js";
import type { PolicyDistribution } from "../models/policy.js";
import {
  DuplicateWorkError,
  insertWorkflow,
  readWorkflow,
  type WorkItemInput,
} from "../ops/ledger.js";
import { registerHandler, type WorkContext, type WorkResult } from "../ops/handlers.js";
import { jsonParam } from "../db/json.js";
import { assembleRating, planRating, screeningPositions, type DeepResult, type RatingPlan } from "./phases.js";
import { ANALYSIS_BUDGET, PUBLIC_SEARCH, type EngineLine } from "./ports.js";
import { rateGame } from "./rating.js";
import { isCacheableRefusal, ratingMethodHash, RATING_METHOD } from "./contract.js";
import { toRatingView, type GameHeaders, type RatingView } from "./view.js";
import { RATING_RESOURCE_TYPE } from "./identity.js";

export const PREPARE_TASK = "game_rating_prepare";
export const ASSEMBLE_TASK = "game_rating_assemble";

export interface RatingRequest {
  gameKey: string;
  pgn: string;
  whiteRating: number | null;
  blackRating: number | null;
  /** The profile that pays for the compute. Cache reads need no owner. */
  ownerProfileId: string;
}

// ---------------------------------------------------------------------------
// Engine reads
// ---------------------------------------------------------------------------

async function evaluate(fen: string, multipv: number): Promise<EngineLine[]> {
  const depth = multipv > 1 ? PUBLIC_SEARCH.deepDepth : PUBLIC_SEARCH.screeningDepth;
  const [result] = await analyzeFens([fen], depth, multipv);
  if (!result) return [];
  const lines: EngineLine[] = [];
  for (const candidate of result.candidates) {
    const move = candidate.pv[0];
    if (!move) continue;
    lines.push({
      uci: move,
      expectedScoreWhite: expectedScore({
        scoreCp: candidate.evalCp ?? null,
        mateIn: candidate.mate ?? null,
        wdl: candidate.wdl ?? null,
      }).value,
    });
  }
  // A search that reported no line but did report a score is a terminal
  // position or an exhausted budget. Reporting the position's own value keeps
  // screening honest without inventing an alternative nobody examined.
  if (lines.length === 0 && result.best) {
    lines.push({
      uci: result.best,
      expectedScoreWhite: expectedScore({
        scoreCp: result.evalCp ?? null,
        mateIn: result.mate ?? null,
        wdl: result.wdl ?? null,
      }).value,
    });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Starting a rating
// ---------------------------------------------------------------------------

export async function startRating(sql: Sql, request: RatingRequest): Promise<{ workflowId: string }> {
  try {
    const workflow = await sql.begin(async (tx) =>
      insertWorkflow(tx as unknown as Sql, {
        kind: "game_rating",
        ownerProfileId: request.ownerProfileId,
        resource: { type: RATING_RESOURCE_TYPE, id: request.gameKey },
        items: [
          {
            taskType: PREPARE_TASK,
            resourceClass: "cpu_engine",
            queue: "stockfish-screen",
            // One rating per game and method, however many people paste it.
            idempotencyKey: `rating:${PREPARE_TASK}:${request.gameKey}:${ratingMethodHash()}`,
            inputRef: `gameRating:${request.gameKey}`,
            payload: {
              gameKey: request.gameKey,
              pgn: request.pgn,
              whiteRating: request.whiteRating,
              blackRating: request.blackRating,
              ownerProfileId: request.ownerProfileId,
            },
            timeoutSeconds: 900,
          },
        ],
      }),
    );
    return { workflowId: workflow.workflowId };
  } catch (error) {
    // Somebody else pasted the same game first. Their workflow is this one.
    if (error instanceof DuplicateWorkError && error.existingWorkflowId) {
      return { workflowId: error.existingWorkflowId };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Phase one: the engine, and the plan it makes possible
// ---------------------------------------------------------------------------

interface PreparePayload {
  gameKey: string;
  pgn: string;
  whiteRating: number | null;
  blackRating: number | null;
  ownerProfileId: string;
}

export async function prepareRating(context: WorkContext, sql: Sql): Promise<WorkResult> {
  const payload = context.item.payload as unknown as PreparePayload;
  const game = parsePgn(payload.pgn);
  if (game.moves.length === 0) throw new Error(game.warning ?? "that did not parse as a game");
  const moves = game.moves.slice(0, ANALYSIS_BUDGET.maxPlies);

  const screened = new Map<string, number>();
  for (const fen of screeningPositions(moves)) {
    const lines = await evaluate(fen, 1);
    if (lines[0]) screened.set(fen, lines[0].expectedScoreWhite);
    // Between bounded units, so a cancelled rating stops costing money.
    if (!(await context.checkpoint()).continue) return { outputSummary: { cancelled: true } };
  }

  const plan = planRating(moves, screened);

  const byPly = new Map(moves.map((move) => [move.ply, move]));
  const deep: Record<number, DeepResult> = {};
  for (const ply of plan.deepPlies) {
    const move = byPly.get(ply)!;
    deep[ply] = {
      before: await evaluate(move.fenBefore, ANALYSIS_BUDGET.deepMultipv),
      after: await evaluate(move.fenAfter, ANALYSIS_BUDGET.deepMultipv),
    };
    if (!(await context.checkpoint()).continue) return { outputSummary: { cancelled: true } };
  }

  // Only the misses become work. A game whose positions the play feature has
  // already seen can be almost free, which is the whole economics of the page.
  const items: WorkItemInput[] = [];
  let cached = 0;
  for (const request of plan.policyRequests) {
    const lookup = await lookupContinuation(sql, request.fen, request.rating);
    if (!lookup) continue;
    if (lookup.policy) {
      cached += 1;
      continue;
    }
    items.push({
      taskType: CONTINUATION_TASK,
      resourceClass: "cpu_interactive_model" as const,
      queue: "maia-rating" as const,
      idempotencyKey: `rating:${CONTINUATION_TASK}:${lookup.cacheKey}`,
      inputRef: `corePosition:${lookup.corePositionId}`,
      payload: {
        corePositionId: lookup.corePositionId,
        halfmoveClock: lookup.halfmoveClock,
        rating: request.rating,
        modelComponentVersionId: lookup.modelComponentVersionId,
        cacheKey: lookup.cacheKey,
      },
      timeoutSeconds: 90,
    });
  }

  const assembleIndex = items.length;
  const workflow = await sql.begin(async (tx) =>
    insertWorkflow(tx as unknown as Sql, {
      kind: "game_rating",
      ownerProfileId: payload.ownerProfileId,
      resource: { type: RATING_RESOURCE_TYPE, id: payload.gameKey },
      items: [
        ...items,
        {
          taskType: ASSEMBLE_TASK,
          resourceClass: "aggregation" as const,
          queue: "analysis" as const,
          idempotencyKey: `rating:${ASSEMBLE_TASK}:${payload.gameKey}:${ratingMethodHash()}`,
          inputRef: `gameRating:${payload.gameKey}`,
          dependsOn: items.map((_, index) => index),
          payload: {
            gameKey: payload.gameKey,
            pgn: payload.pgn,
            whiteRating: payload.whiteRating,
            blackRating: payload.blackRating,
            plan: plan as unknown as Record<string, unknown>,
            deep: deep as unknown as Record<string, unknown>,
          },
          timeoutSeconds: 900,
        },
      ],
    }),
  );

  return {
    outputRef: `workflow:${workflow.workflowId}`,
    outputSummary: {
      screened: screened.size,
      deepPositions: plan.deepPlies.length,
      policyPlies: plan.policyPlies.length,
      policyCached: cached,
      policyScheduled: assembleIndex,
    },
  };
}

// ---------------------------------------------------------------------------
// Phase two: the assembly
// ---------------------------------------------------------------------------

interface AssemblePayload {
  gameKey: string;
  pgn: string;
  whiteRating: number | null;
  blackRating: number | null;
  plan: RatingPlan;
  deep: Record<string, DeepResult>;
}

export async function assembleRatingItem(context: WorkContext, sql: Sql): Promise<WorkResult> {
  const payload = context.item.payload as unknown as AssemblePayload;
  const game = parsePgn(payload.pgn);
  const moves = game.moves.slice(0, ANALYSIS_BUDGET.maxPlies);

  // Read every policy the plan asked for. A miss here is not a failure: the
  // scorer already knows how to publish less, and a position whose inference
  // was dead-lettered should cost coverage rather than the whole rating.
  const policies = new Map<string, PolicyDistribution>();
  for (const request of payload.plan.policyRequests) {
    const lookup = await lookupContinuation(sql, request.fen, request.rating);
    if (!lookup) continue;
    const policy =
      lookup.policy ??
      (await readContinuationPolicy(sql, lookup.modelComponentVersionId, lookup.cacheKey));
    if (policy) policies.set(`${request.fen}|${request.rating}`, policy);
  }

  const deep = new Map<number, DeepResult>(
    Object.entries(payload.deep).map(([ply, result]) => [Number(ply), result]),
  );

  const assembled = assembleRating(
    moves,
    payload.plan,
    deep,
    (fen, rating) => policies.get(`${fen}|${rating}`),
    { whiteRating: payload.whiteRating, blackRating: payload.blackRating },
  );

  const headers: GameHeaders = {
    white: game.headers.White ?? null,
    black: game.headers.Black ?? null,
    event: game.headers.Event ?? null,
    date: game.headers.Date ?? null,
    result: game.headers.Result ?? null,
  };
  const view = toRatingView(rateGame(assembled.input), {
    game: headers,
    declared: {
      white: assembled.conditioning.white.declared,
      black: assembled.conditioning.black.declared,
    },
  });

  const stored = await writeRating(sql, payload.gameKey, context.item.workflowId, view);

  return {
    outputRef: `gameRating:${payload.gameKey}`,
    outputSummary: {
      status: view.status,
      stored,
      rating: view.status === "available" ? view.rating : null,
      policiesRead: policies.size,
      policiesAsked: payload.plan.policyRequests.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * Store a rating, unless the refusal was about us rather than about the game.
 *
 * Returns whether it was stored, so the work item can report it. A refusal that
 * names our own missing model is not an answer worth keeping: the row would be
 * immutable and keyed by game and method, so the game could never be rated
 * again under this method once the model arrived.
 */
export async function writeRating(
  sql: Sql,
  gameKey: string,
  workflowId: string,
  view: RatingView,
): Promise<boolean> {
  const available = view.status === "available";
  if (!available && !isCacheableRefusal(view.reason)) return false;
  await sql`
    insert into analysis.game_ratings (
      game_key, method_key, method_version, method_hash, workflow_id,
      status, unavailable_reason, rating, rating_low, rating_high, rating_view
    ) values (
      ${gameKey}, ${view.method.key}, ${view.method.version}, ${view.method.hash}, ${workflowId},
      ${view.status}, ${available ? null : view.reason},
      ${available ? view.rating : null},
      ${available ? view.ratingLow : null},
      ${available ? view.ratingHigh : null},
      ${jsonParam(view)}
    )
    on conflict (game_key, method_hash) do nothing`;
  return true;
}

export async function readRating(sql: Sql, gameKey: string): Promise<RatingView | null> {
  const [row] = await sql<{ rating_view: RatingView }[]>`
    select rating_view from analysis.game_ratings
    where game_key = ${gameKey} and method_hash = ${ratingMethodHash()}`;
  return row?.rating_view ?? null;
}

export type RatingProgress =
  | { state: "ready"; view: RatingView }
  | { state: "working"; workflowId: string; done: number; total: number }
  | { state: "failed"; workflowId: string }
  | { state: "absent" };

/**
 * Where a rating has got to, by game rather than by workflow.
 *
 * The chain is two workflows and the caller is told about neither. It asks
 * about a game, which is the only thing it knows, and gets a finished rating, a
 * count it can draw a bar with, or nothing.
 */
export async function ratingProgress(sql: Sql, gameKey: string): Promise<RatingProgress> {
  const view = await readRating(sql, gameKey);
  if (view) return { state: "ready", view };

  const [workflow] = await sql<{ id: string; state: string }[]>`
    select id, state from ops.workflows
    where resource_type = ${RATING_RESOURCE_TYPE} and resource_id = ${gameKey}
    order by created_at desc limit 1`;
  if (!workflow) return { state: "absent" };
  if (workflow.state === "failed" || workflow.state === "cancelled") {
    return { state: "failed", workflowId: workflow.id };
  }
  // Finished, and nothing was stored. That is the refusal we decline to cache:
  // the model was missing, or the deeper pass never ran. Reporting it as still
  // working would leave the page polling a bar at a hundred per cent forever.
  if (workflow.state === "succeeded") return { state: "failed", workflowId: workflow.id };

  // Counted across the whole chain, so a bar drawn from it does not restart
  // when the second workflow begins.
  const [counts] = await sql<{ done: string; total: string }[]>`
    select
      count(*) filter (where i.status = 'succeeded') as done,
      count(*) as total
    from ops.work_items i
    join ops.workflows w on w.id = i.workflow_id
    where w.resource_type = ${RATING_RESOURCE_TYPE} and w.resource_id = ${gameKey}`;
  return {
    state: "working",
    workflowId: workflow.id,
    done: Number(counts?.done ?? 0),
    total: Number(counts?.total ?? 0),
  };
}

// ---------------------------------------------------------------------------

/**
 * Register only what this deployment may run.
 *
 * The registry is the allowlist, so scope matters: preparing a rating is engine
 * work and belongs on `forma-stockfish`, and assembling one writes analysis rows
 * that the engine role has no grant for. A process that registered both would
 * accept a message it has no business executing, and would fail at the database
 * instead of at the router, which is a much worse place to find out.
 */
async function runtimeSql(): Promise<Sql> {
  // Imported on first use, the way the engine worker does it: these modules are
  // loaded by processes that have no DATABASE_URL and never claim an item.
  const { client } = await import("../db/client.js");
  return client as unknown as Sql;
}

export function registerRatingHandlers(scope: "engine" | "analysis" | "both" = "both"): void {
  if (scope !== "analysis") {
    registerHandler(PREPARE_TASK, async (context) => prepareRating(context, await runtimeSql()));
  }
  if (scope !== "engine") {
    registerHandler(ASSEMBLE_TASK, async (context) => assembleRatingItem(context, await runtimeSql()));
  }
}

export { RATING_METHOD, readWorkflow };

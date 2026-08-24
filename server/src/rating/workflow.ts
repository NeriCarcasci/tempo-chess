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
  lookupContinuations,
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

/**
 * How many ratings may be in flight at once, across everybody.
 *
 * The page is open to anybody, so the protection against a queue nobody can
 * drain is a ceiling rather than a login. One rating is a few hundred
 * inferences against a single rating worker, so three in flight is already
 * something like a quarter of an hour of backlog: past that, a new arrival is
 * better told to come back than added to a line that will not move.
 *
 * Games already in flight do not count against a *new* caller asking for the
 * same game: that returns the existing workflow and costs nothing.
 */
export const RATING_CAPACITY = { version: "1", maxInflight: 3 } as const;

export const PREPARE_TASK = "game_rating_prepare";
export const ASSEMBLE_TASK = "game_rating_assemble";

export interface RatingRequest {
  gameKey: string;
  pgn: string;
  whiteRating: number | null;
  blackRating: number | null;
  /**
   * The profile that asked, when there is one.
   *
   * Null for a visitor with no account, which is the ordinary case: this page
   * exists to show a stranger what Forma does before they have any reason to
   * sign up, so making them sign up first defeats the whole point of it. A
   * rating is about a game rather than about a person, so an ownerless workflow
   * is the honest shape and not a workaround. Cost is bounded by
   * `RATING_CAPACITY` and by the per-address rate limit instead.
   */
  ownerProfileId: string | null;
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

/** Ratings currently queued or running, across the whole platform. */
export async function inflightRatings(sql: Sql): Promise<number> {
  const [row] = await sql<{ count: string }[]>`
    select count(*) as count from ops.workflows
    where resource_type = ${RATING_RESOURCE_TYPE}
      and state in ('queued', 'running')`;
  return Number(row?.count ?? 0);
}

/** The game somebody asked about, read back by the engine and the assembler. */
export interface Submission {
  pgn: string;
  whiteRating: number | null;
  blackRating: number | null;
}

export async function readSubmission(sql: Sql, gameKey: string): Promise<Submission | null> {
  const [row] = await sql<{ pgn: string; white_rating: number | null; black_rating: number | null }[]>`
    select pgn, white_rating, black_rating from analysis.game_rating_submissions
    where game_key = ${gameKey}`;
  return row
    ? { pgn: row.pgn, whiteRating: row.white_rating, blackRating: row.black_rating }
    : null;
}

export async function startRating(sql: Sql, request: RatingRequest): Promise<{ workflowId: string }> {
  // The game goes in a table and the work item carries a key. A work item
  // payload is capped at four kilobytes, because the ledger routes work rather
  // than carrying cargo, and a real annotated export is bigger than that.
  await sql`
    insert into analysis.game_rating_submissions (game_key, pgn, white_rating, black_rating)
    values (${request.gameKey}, ${request.pgn}, ${request.whiteRating}, ${request.blackRating})
    on conflict (game_key) do nothing`;

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
            payload: { gameKey: request.gameKey, ownerProfileId: request.ownerProfileId },
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
  ownerProfileId: string | null;
}

export async function prepareRating(context: WorkContext, sql: Sql): Promise<WorkResult> {
  const payload = context.item.payload as unknown as PreparePayload;
  const submission = await readSubmission(sql, payload.gameKey);
  if (!submission) throw new Error("the submitted game is missing");
  const game = parsePgn(submission.pgn);
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

  // The engine schedules nothing. `forma_stockfish` holds no insert on
  // ops.workflows, because workers execute work and only the API creates it,
  // and that is a boundary worth keeping rather than working around. So the
  // plan is written down and the API picks it up on the next poll it is
  // already serving.
  await sql`
    insert into analysis.game_rating_plans (
      game_key, method_hash, workflow_id, plan, deep, pgn, white_rating, black_rating
    ) values (
      ${payload.gameKey}, ${ratingMethodHash()}, ${context.item.workflowId},
      ${jsonParam(plan)}, ${jsonParam(deep)}, ${submission.pgn},
      ${submission.whiteRating}, ${submission.blackRating}
    )
    on conflict (game_key, method_hash) do nothing`;

  return {
    outputRef: `gameRatingPlan:${payload.gameKey}`,
    outputSummary: {
      screened: screened.size,
      deepPositions: plan.deepPlies.length,
      policyPlies: plan.policyPlies.length,
      policyRequests: plan.policyRequests.length,
    },
  };
}

/** The engine's half of a rating, once it has finished, and the game it read. */
export interface StoredPlan {
  plan: RatingPlan;
  deep: Record<string, DeepResult>;
  pgn: string;
  whiteRating: number | null;
  blackRating: number | null;
}

export async function readRatingPlan(sql: Sql, gameKey: string): Promise<StoredPlan | null> {
  const [row] = await sql<
    {
      plan: RatingPlan;
      deep: Record<string, DeepResult>;
      pgn: string;
      white_rating: number | null;
      black_rating: number | null;
    }[]
  >`
    select plan, deep, pgn, white_rating, black_rating from analysis.game_rating_plans
    where game_key = ${gameKey} and method_hash = ${ratingMethodHash()}`;
  return row
    ? {
        plan: row.plan,
        deep: row.deep,
        pgn: row.pgn,
        whiteRating: row.white_rating,
        blackRating: row.black_rating,
      }
    : null;
}

/**
 * Turn a finished plan into the work that answers it.
 *
 * Runs on the API, because the API is the only role that may create a workflow.
 * Everything it needs in order to decide what to schedule it can already read:
 * the promoted model, the core positions, and the policy cache. Only the misses
 * become items, so a game whose positions the play feature has already inferred
 * can be almost free, which is the whole economics of the public page.
 */
export async function scheduleRatingPolicies(
  sql: Sql,
  gameKey: string,
): Promise<{ workflowId: string; scheduled: number; cached: number } | null> {
  const stored = await readRatingPlan(sql, gameKey);
  if (!stored) return null;

  // The poll runs on every tick, so the common case has to be one cheap query.
  // Once the second workflow exists there is nothing left to schedule.
  const [already] = await sql<{ id: string }[]>`
    select w.id from ops.workflows w
    join ops.work_items i on i.workflow_id = w.id
    where w.resource_type = ${RATING_RESOURCE_TYPE} and w.resource_id = ${gameKey}
      and i.task_type = ${ASSEMBLE_TASK}
    limit 1`;
  if (already) return { workflowId: already.id, scheduled: 0, cached: 0 };

  // Batched: one model read, one intern per distinct position, one question to
  // the cache about every key. The per-pair version cost over a thousand round
  // trips for a single game and timed the API out before it scheduled anything.
  const looked = await lookupContinuations(sql, stored.plan.policyRequests);
  const cached = looked.filter((entry) => entry.cached).length;
  const items: WorkItemInput[] = looked
    .filter((entry) => !entry.cached)
    .map((entry) => ({
      taskType: CONTINUATION_TASK,
      resourceClass: "cpu_interactive_model" as const,
      queue: "maia-rating" as const,
      idempotencyKey: `rating:${CONTINUATION_TASK}:${entry.cacheKey}`,
      inputRef: `corePosition:${entry.corePositionId}`,
      payload: {
        corePositionId: entry.corePositionId,
        halfmoveClock: entry.halfmoveClock,
        rating: entry.rating,
        modelComponentVersionId: entry.modelComponentVersionId,
        cacheKey: entry.cacheKey,
      },
      timeoutSeconds: 90,
    }));

  try {
    const workflow = await sql.begin(async (tx) =>
      insertWorkflow(tx as unknown as Sql, {
        kind: "game_rating",
        ownerProfileId: null,
        resource: { type: RATING_RESOURCE_TYPE, id: gameKey },
        items: [
          ...items,
          {
            taskType: ASSEMBLE_TASK,
            resourceClass: "aggregation",
            queue: "analysis",
            idempotencyKey: `rating:${ASSEMBLE_TASK}:${gameKey}:${ratingMethodHash()}`,
            inputRef: `gameRating:${gameKey}`,
            dependsOn: items.map((_, index) => index),
            payload: { gameKey },
            timeoutSeconds: 900,
          },
        ],
      }),
    );
    return { workflowId: workflow.workflowId, scheduled: items.length, cached };
  } catch (error) {
    // Another poll got here first. Theirs is the workflow.
    if (error instanceof DuplicateWorkError && error.existingWorkflowId) {
      return { workflowId: error.existingWorkflowId, scheduled: 0, cached };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Phase two: the assembly
// ---------------------------------------------------------------------------

interface AssemblePayload {
  gameKey: string;
}

export async function assembleRatingItem(context: WorkContext, sql: Sql): Promise<WorkResult> {
  const payload = context.item.payload as unknown as AssemblePayload;
  const stored = await readRatingPlan(sql, payload.gameKey);
  if (!stored) throw new Error("the engine plan for this game is missing");
  const game = parsePgn(stored.pgn);
  const moves = game.moves.slice(0, ANALYSIS_BUDGET.maxPlies);

  // Read every policy the plan asked for. A miss here is not a failure: the
  // scorer already knows how to publish less, and a position whose inference
  // was dead-lettered should cost coverage rather than the whole rating.
  const policies = new Map<string, PolicyDistribution>();
  for (const request of stored.plan.policyRequests) {
    const lookup = await lookupContinuation(sql, request.fen, request.rating);
    if (!lookup) continue;
    const policy =
      lookup.policy ??
      (await readContinuationPolicy(sql, lookup.modelComponentVersionId, lookup.cacheKey));
    if (policy) policies.set(`${request.fen}|${request.rating}`, policy);
  }

  const deep = new Map<number, DeepResult>(
    Object.entries(stored.deep).map(([ply, result]) => [Number(ply), result]),
  );

  const assembled = assembleRating(
    moves,
    stored.plan,
    deep,
    (fen, rating) => policies.get(`${fen}|${rating}`),
    { whiteRating: stored.whiteRating, blackRating: stored.blackRating },
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

  const wasStored = await writeRating(sql, payload.gameKey, context.item.workflowId, view);

  return {
    outputRef: `gameRating:${payload.gameKey}`,
    outputSummary: {
      status: view.status,
      reason: view.status === "unavailable" ? view.reason : null,
      stored: wasStored,
      rating: view.status === "available" ? view.rating : null,
      policiesRead: policies.size,
      policiesAsked: stored.plan.policyRequests.length,
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

/**
 * What the assembler recorded about a rating that produced nothing.
 *
 * Read from the work item rather than stored separately, because the ledger
 * already keeps it and a second copy would be a second thing to keep true.
 */
async function refusalDetail(sql: Sql, gameKey: string): Promise<string | null> {
  const [row] = await sql<{ summary: Record<string, unknown> | null; status: string }[]>`
    select i.output_summary as summary, i.status
    from ops.work_items i
    join ops.workflows w on w.id = i.workflow_id
    where w.resource_type = ${RATING_RESOURCE_TYPE} and w.resource_id = ${gameKey}
      and i.task_type = ${ASSEMBLE_TASK}
    order by i.id desc limit 1`;
  if (!row) return "the assembly step never ran";
  const summary = row.summary;
  if (!summary) return `assembly ended ${row.status} without recording anything`;
  const reason = summary.status === "unavailable" ? String(summary.reason ?? "unavailable") : null;
  const read = summary.policiesRead;
  const asked = summary.policiesAsked;
  const coverage = read != null && asked != null ? `, ${read} of ${asked} policies read` : "";
  // Whether it was written is the fact that separates "we refused" from "we
  // produced a rating and lost it", and the first version of this message left
  // it out, which cost a whole round of investigation.
  const kept = summary.stored === false ? ", and it was not stored" : "";
  return reason
    ? `${reason}${coverage}${kept}`
    : `assembly produced a ${String(summary.status)} rating${coverage}${kept}`;
}

export type RatingProgress =
  | { state: "ready"; view: RatingView }
  | {
      state: "working";
      workflowId: string;
      /**
       * Which half of the work is happening.
       *
       * The engine half is a single work item that runs for minutes, so a bar
       * driven by item counts sits at "0 of 1" the whole time and looks broken.
       * It is honest and it is unreadable. Naming the stage lets the page say
       * what is going on while the count still means something once counting
       * is the right thing to do.
       */
      stage: "screening" | "inferring";
      done: number;
      total: number;
    }
  | {
      state: "failed";
      workflowId: string;
      /**
       * What the assembler said, when it said anything.
       *
       * A workflow that finished and stored nothing is a refusal we decline to
       * cache, not a crash, and "that rating did not finish" is the least
       * useful sentence available about it. The assembler already records the
       * status and how many policies it managed to read; surfacing that turns a
       * mystery into a number, both for the reader and for whoever is debugging
       * it at the time.
       */
      detail: string | null;
    }
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
    return { state: "failed", workflowId: workflow.id, detail: await refusalDetail(sql, gameKey) };
  }
  // Finished, and nothing was stored. That is the refusal we decline to cache:
  // the model was missing, or the deeper pass never ran. Reporting it as still
  // working would leave the page polling a bar at a hundred per cent forever.
  if (workflow.state === "succeeded") {
    return { state: "failed", workflowId: workflow.id, detail: await refusalDetail(sql, gameKey) };
  }

  // Counted across the whole chain, so a bar drawn from it does not restart
  // when the second workflow begins.
  const [counts] = await sql<{ done: string; total: string }[]>`
    select
      count(*) filter (where i.status = 'succeeded') as done,
      count(*) as total
    from ops.work_items i
    join ops.workflows w on w.id = i.workflow_id
    where w.resource_type = ${RATING_RESOURCE_TYPE} and w.resource_id = ${gameKey}`;
  // The plan existing is exactly the line between the two halves: before it,
  // the engine is reading the game; after it, the policy queue is draining.
  const plan = await readRatingPlan(sql, gameKey);
  return {
    state: "working",
    workflowId: workflow.id,
    stage: plan ? "inferring" : "screening",
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

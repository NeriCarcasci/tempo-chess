/**
 * The three handlers a game analysis is made of.
 *
 * `stockfish_screen_game` and `stockfish_deep_game` run in the isolated engine
 * deployment (platform spec §6.4). They touch four tables — core positions,
 * occurrences, transitions and the evaluation cache — and no subject-scoped row
 * anywhere, which is not an accident of implementation: `forma_stockfish` has
 * no grant on `analysis.runs` and no actor helper, so a handler here *cannot*
 * read whose game it is analysing. Their input is a materialization run id and
 * two component version ids, all created server-side by the planner.
 *
 * `analysis_assess_transitions` runs in the analysis deployment. It is the only
 * one that knows about the run, and it is where the decision measurements, the
 * artifact manifest, the run completion and the publication happen.
 *
 * The division of failure is deliberate. Screening is the evidence: if it
 * cannot be produced the item fails, is retried, and eventually the workflow
 * fails with nothing published. The deep pass is an enhancement: an engine
 * error on an individual position is absorbed, that position's assessment says
 * `unavailable`, and the review still ships with complete screening evidence.
 * Calling a game unanalysable because one deeper search timed out would be a
 * worse answer than saying "we wanted a closer look here and did not get one".
 */

import { z } from "zod";
import type { Sql } from "postgres";
import { withActor } from "../db/actor.js";
import { registerHandler, type WorkContext, type WorkResult } from "../ops/handlers.js";
import { WorkFailure } from "../ops/retry.js";
import { logSafeError } from "../security/redaction.js";
import { classifyGamePhases, type GamePhase } from "../analysis/phase.js";
import { completeRun, failRun, recordArtifact, startRun } from "../analysis/runs.js";
import { publishSubjectGame } from "../analysis/publication.js";
import {
  BUDGETS,
  ENGINE_PROFILES,
  TRANSITION_ASSESSMENT_FAMILY,
  estimatedCostMicroUsd,
  type EngineProfileKey,
  type EvaluationScope,
  type TerminalOutcome,
} from "./contract.js";
import {
  cacheKeyFor,
  findCachedEvaluation,
  linkRunUse,
  storeEvaluation,
  storeTerminalEvaluation,
  type EvaluationRequest,
  type StoredEvaluation,
} from "./evaluations.js";
import { exactHistoryAt, scopeFor } from "./history.js";
import {
  configuredEngineIdentity,
  engineProfileMismatch,
  readModelProfile,
  resolveProfile,
  type ResolvedProfile,
} from "./profiles.js";
import { publishedMaterializationRun, readChain, readEngineRoles, type MaterializedChain } from "./recipe.js";
import { recordEngineEvent } from "./telemetry.js";
import { selectCriticalPositions, type CriticalPositionCandidate, type CriticalReasonDetail } from "./critical-position.js";
import { buildAssessment, writeAssessments, type AssessmentRow, type TransitionEvidence } from "./assessments.js";
import { Engine, type PositionEval, type SearchHistory } from "./stockfish.js";
import { Chess } from "chessops/chess";
import { parseFen } from "chessops/fen";

export const SCREEN_TASK = "stockfish_screen_game";
export const DEEP_TASK = "stockfish_deep_game";
export const ASSESS_TASK = "analysis_assess_transitions";
export const EVALUATE_POSITION_TASK = "stockfish_evaluate_position";

const WORKER_REVISION = process.env.K_REVISION ?? process.env.GIT_SHA ?? "local";

/**
 * The engine payload. Handles only — no FEN, no PGN, no subject, no game.
 *
 * `strict()` matters here: a payload with an extra key is a payload written by
 * something that disagrees with this file about what the task is, and running
 * it anyway is how an unnoticed contract drift becomes a silent behaviour
 * change in the one deployment that owns compute cost.
 */
const enginePayload = z
  .object({
    materializationRunId: z.uuid(),
    engineVersionId: z.uuid(),
    calibrationVersionId: z.uuid(),
  })
  .strict();

const assessPayload = z.object({ runId: z.uuid() }).strict();

const positionPayload = z
  .object({
    corePositionId: z.string().regex(/^\d{1,19}$/),
    halfmoveClock: z.int().min(0).max(200),
    engineVersionId: z.uuid(),
    calibrationVersionId: z.uuid(),
  })
  .strict();

// ---------------------------------------------------------------------------
// The engine session
// ---------------------------------------------------------------------------

export interface EngineSession {
  startupMs: number;
  search(input: {
    fen: string;
    profile: EngineProfileKey;
    history: SearchHistory | null;
  }): Promise<PositionEval>;
  close(): Promise<void>;
}

export type EngineSessionFactory = () => Promise<EngineSession>;

/**
 * One Stockfish process for the duration of one task.
 *
 * Per task rather than per process: platform spec §6.4 puts concurrency at 1
 * per instance, so there is no throughput to gain from a long-lived engine, and
 * a fresh process cannot carry hash table state from someone else's game into
 * this one — which would make a "deterministic" cached result depend on what
 * ran before it.
 */
async function spawnEngineSession(): Promise<EngineSession> {
  const startedAt = Date.now();
  const engine = new Engine();
  // The first search resolves the UCI handshake; measuring it separately would
  // need a private hook, and this is the number an operator cares about anyway.
  return {
    startupMs: Date.now() - startedAt,
    async search({ fen, profile, history }) {
      const spec = ENGINE_PROFILES[profile];
      return engine.analyze(
        fen,
        {
          id: spec.key,
          version: 1,
          limit: { type: spec.limitType as "nodes" | "depth", value: spec.limitValue },
          multiPv: spec.multipv,
        },
        history ?? undefined,
      );
    },
    async close() {
      engine.quit();
    },
  };
}

let sessionFactory: EngineSessionFactory = spawnEngineSession;

/** Test seam: the gates run a deterministic fixture engine instead of Stockfish. */
export function setEngineSessionFactory(next: EngineSessionFactory | null): void {
  sessionFactory = next ?? spawnEngineSession;
}

// ---------------------------------------------------------------------------
// Shared: evaluating a set of positions under one profile
// ---------------------------------------------------------------------------

interface SearchTally {
  positions: number;
  hits: number;
  misses: number;
  nodes: number;
  engineMs: number;
  byScope: Map<EvaluationScope, { hits: number; misses: number }>;
}

function emptyTally(): SearchTally {
  return { positions: 0, hits: 0, misses: 0, nodes: 0, engineMs: 0, byScope: new Map() };
}

function tallyScope(tally: SearchTally, scope: EvaluationScope, hit: boolean): void {
  const bucket = tally.byScope.get(scope) ?? { hits: 0, misses: 0 };
  if (hit) bucket.hits += 1;
  else bucket.misses += 1;
  tally.byScope.set(scope, bucket);
}

/** The request describing one occurrence's evidence at one profile. */
function requestFor(
  chain: MaterializedChain,
  ply: number,
  profile: ResolvedProfile,
): EvaluationRequest {
  const occurrence = chain.occurrences.find((entry) => entry.ply === ply)!;
  const scope = scopeFor(occurrence);
  const history = scope === "history_exact" ? exactHistoryAt(chain, ply) : null;
  return {
    corePositionId: occurrence.corePositionId,
    corePositionKeyHash: occurrence.corePositionKeyHash,
    scope,
    fen: occurrence.fen,
    halfmoveClock: occurrence.halfmoveClock,
    history,
    occurrence: null,
    profile,
  };
}

/**
 * Evaluate one position, reading the cache first.
 *
 * The cache read is the whole economic argument for this epic: a screening pass
 * over a 1,000-game corpus revisits the same opening positions thousands of
 * times, and a hit costs one index probe instead of 50,000 nodes.
 */
async function evaluateOne(
  sql: Sql,
  session: EngineSession,
  request: EvaluationRequest,
  profileKey: EngineProfileKey,
  tally: SearchTally,
): Promise<StoredEvaluation> {
  tally.positions += 1;
  const cacheKey = cacheKeyFor(request);
  const cached = await findCachedEvaluation(sql, cacheKey);
  if (cached) {
    tally.hits += 1;
    tallyScope(tally, request.scope, true);
    return cached;
  }

  // A position the game already ended in is decided by the rules, not by a
  // search, and Stockfish says so by returning `bestmove (none)` with no score
  // at all. Asking anyway is what killed every game that finished in checkmate
  // or stalemate: the calibration is handed nothing to convert and refuses.
  const terminal = terminalOutcomeOf(request.fen);
  if (terminal) {
    const stored = await storeTerminalEvaluation(
      sql, request, terminal.outcome, terminal.sideToMove, WORKER_REVISION,
    );
    tally.misses += 1;
    tallyScope(tally, request.scope, false);
    return stored.evaluation;
  }

  // Outside every transaction, deliberately: a 500,000-node search inside one
  // would hold a connection for its whole duration.
  const result = await session.search({
    fen: request.fen,
    profile: profileKey,
    history: request.history,
  });
  assertSearchMatchesProfile(result, request);

  const stored = await storeEvaluation(sql, request, result, WORKER_REVISION);
  tally.misses += 1;
  tallyScope(tally, request.scope, false);
  tally.nodes += result.nodes ?? 0;
  tally.engineMs += result.engineTimeMs ?? 0;
  return stored.evaluation;
}

/**
 * Is the game over in this position, and how?
 *
 * Read from the position itself rather than from the game's recorded
 * termination: a game can be *resigned* in a position that is not terminal, and
 * a game can reach checkmate at a ply that is not the last one recorded. The
 * only thing that decides whether a position has a legal move is the position.
 *
 * Draws by agreement, resignation and flag-fall are deliberately absent -- they
 * end a *game*, not a position, and the position they end in is still one a
 * search has an opinion about. Only the outcomes the rules impose on the board
 * are here.
 *
 * An unparseable FEN returns null and the caller searches as before. This is
 * not the place to decide that a position is malformed; the engine will refuse
 * it and say so with its own error.
 */
function terminalOutcomeOf(
  fen: string,
): { outcome: TerminalOutcome; sideToMove: "white" | "black" } | null {
  const setup = parseFen(fen);
  if (setup.isErr) return null;
  const position = Chess.fromSetup(setup.unwrap());
  if (position.isErr) return null;
  const board = position.unwrap();
  if (!board.isEnd()) return null;
  const sideToMove = board.turn === "white" ? "white" : "black";
  return { outcome: board.isCheckmate() ? "checkmate" : "draw", sideToMove };
}

/**
 * Refuse to store a result the engine did not actually produce under the
 * profile it is about to be filed under.
 *
 * The row records the limit, MultiPV, threads and hash as provenance. If the
 * engine ran something else — a misconfigured deployment, a build that ignores
 * an option — then filing it under this cache key would poison an entry every
 * other player's transposition reads.
 */
function assertSearchMatchesProfile(result: PositionEval, request: EvaluationRequest): void {
  const spec = request.profile.spec;
  const provenance = result.provenance;
  const mismatch =
    provenance.limit.type !== spec.limitType ||
    provenance.limit.value !== spec.limitValue ||
    provenance.multiPv !== spec.multipv ||
    provenance.threads !== spec.threads ||
    provenance.hashMb !== spec.hashMb;
  if (mismatch) {
    throw new WorkFailure(
      "unsupported",
      "engine_profile_mismatch",
      "the engine ran a different search than the profile declares",
    );
  }
}

/** Resolve the profile and refuse to write under an engine we are not running. */
async function resolveAndVerify(
  sql: Sql,
  versions: { engineVersionId: string; calibrationVersionId: string },
  profile: EngineProfileKey,
): Promise<ResolvedProfile> {
  const row = await readModelProfile(sql, versions.engineVersionId);
  if (!row) {
    throw new WorkFailure("invalid_input", "unknown_model_profile", "no such objective engine profile");
  }
  const mismatch = engineProfileMismatch(configuredEngineIdentity(), row);
  if (mismatch) {
    // Unsupported, not transient: the same image will fail identically, and an
    // operator needs to see the routing or build mistake rather than five more
    // attempts against it.
    throw new WorkFailure("unsupported", "engine_profile_mismatch", mismatch);
  }
  return resolveProfile(sql, {
    engineVersionId: versions.engineVersionId,
    calibrationVersionId: versions.calibrationVersionId,
    profile,
  });
}

function emitTally(
  taskType: string,
  queue: string,
  traceId: string | null,
  tally: SearchTally,
  extra: {
    startupMs: number | null;
    durationMs: number;
    deepSelected: number;
    failureClass?: string | null;
    errorCode?: string | null;
    profile: EngineProfileKey;
  },
): void {
  recordEngineEvent({
    event: "engine_task",
    traceId,
    taskType,
    queue,
    queueAgeMs: null,
    engineStartupMs: extra.startupMs,
    positions: tally.positions,
    cacheHits: tally.hits,
    cacheMisses: tally.misses,
    deepSelected: extra.deepSelected,
    nodes: tally.nodes,
    nps: tally.engineMs > 0 ? Math.round((tally.nodes / tally.engineMs) * 1_000) : null,
    engineMs: tally.engineMs,
    durationMs: extra.durationMs,
    estimatedCostMicroUsd: estimatedCostMicroUsd(tally.nodes),
    failureClass: extra.failureClass ?? null,
    errorCode: extra.errorCode ?? null,
  });
  for (const [scope, counts] of tally.byScope) {
    recordEngineEvent({
      event: "engine_cache",
      traceId,
      taskType,
      scope,
      profile: extra.profile,
      hits: counts.hits,
      misses: counts.misses,
    });
  }
}

// ---------------------------------------------------------------------------
// 1. Screening: every position of the chain
// ---------------------------------------------------------------------------

export async function screenGame(context: WorkContext, sql: Sql): Promise<WorkResult> {
  const payload = parsePayload(enginePayload, context.item.payload);
  const startedAt = Date.now();
  const profile = await resolveAndVerify(sql, payload, "screening");
  const chain = await readChain(sql, payload.materializationRunId);
  if (chain.occurrences.length === 0) {
    throw new WorkFailure("invalid_input", "empty_chain", "the materialization run has no occurrences");
  }

  const session = await sessionFactory();
  const tally = emptyTally();
  try {
    for (const occurrence of chain.occurrences) {
      const beat = await context.checkpoint();
      if (!beat.continue) break;
      await evaluateOne(sql, session, requestFor(chain, occurrence.ply, profile), "screening", tally);
    }
  } finally {
    await session.close();
  }

  emitTally(SCREEN_TASK, "stockfish-screen", context.traceId, tally, {
    startupMs: session.startupMs,
    durationMs: Date.now() - startedAt,
    deepSelected: 0,
    profile: "screening",
  });
  return {
    outputRef: `materializationRun:${payload.materializationRunId}`,
    outputSummary: { positions: tally.positions, cacheHits: tally.hits },
    metrics: {
      inputCount: chain.occurrences.length,
      outputCount: tally.misses,
      cacheHits: tally.hits,
      computeMs: tally.engineMs,
      billedUnits: tally.nodes,
    },
  };
}

// ---------------------------------------------------------------------------
// 2. Deep: the selected positions, at MultiPV
// ---------------------------------------------------------------------------

/**
 * Which transitions warrant a deeper look, from the screening evidence alone.
 *
 * Deterministic and versioned by the selector component the recipe pins, which
 * is what lets the engine worker and the analysis worker reach the same answer
 * without either of them telling the other. The engine worker selects in order
 * to spend nodes; the analysis worker selects in order to know whether a
 * missing deep evaluation means "not wanted" or "not obtained".
 */
export function selectDeepPlies(
  chain: MaterializedChain,
  screening: ReadonlyMap<number, StoredEvaluation>,
  phases: ReadonlyMap<number, GamePhase>,
): Map<number, readonly CriticalReasonDetail[]> {
  const candidates: CriticalPositionCandidate[] = [];
  for (const transition of chain.transitions) {
    const before = screening.get(transition.fromPly);
    const after = screening.get(transition.fromPly + 1);
    if (!before || !after) continue;
    const occurrence = chain.occurrences.find((entry) => entry.ply === transition.fromPly)!;
    const actorColor = occurrence.sideToMove === "w" ? "white" : "black";
    candidates.push({
      gameId: chain.materializationRunId,
      ply: transition.fromPly,
      evaluationLossCp: Math.max(0, actorCentipawns(before, actorColor) - actorCentipawns(after, actorColor)),
      phaseBefore: phases.get(transition.fromPly),
      phaseAfter: phases.get(transition.fromPly + 1),
    });
  }
  const selection = selectCriticalPositions(candidates);
  return new Map(
    selection.selected.map((assessment) => [assessment.candidate.ply, assessment.reasons]),
  );
}

/**
 * The centipawn value the selector compares, from the actor's side.
 *
 * A mate score has no centipawn value, so it is mapped onto a scale above every
 * real evaluation with the distance preserved — mate in 1 outranks mate in 8.
 * This mapping exists only to *rank candidates for a deeper search*; it never
 * reaches an assessment, where the expected score does the work.
 */
const MATE_EQUIVALENT_CP = 10_000;

function actorCentipawns(evaluation: StoredEvaluation, actorColor: "white" | "black"): number {
  const white =
    evaluation.mateIn != null
      ? Math.sign(evaluation.mateIn) * (MATE_EQUIVALENT_CP - Math.min(Math.abs(evaluation.mateIn), 999))
      : (evaluation.scoreCp ?? 0);
  return actorColor === "white" ? white : -white;
}

export async function deepenGame(context: WorkContext, sql: Sql): Promise<WorkResult> {
  const payload = parsePayload(enginePayload, context.item.payload);
  const startedAt = Date.now();
  const screeningProfile = await resolveAndVerify(sql, payload, "screening");
  const deepProfile = await resolveProfile(sql, {
    engineVersionId: payload.engineVersionId,
    calibrationVersionId: payload.calibrationVersionId,
    profile: "deep",
  });
  const chain = await readChain(sql, payload.materializationRunId);

  const screening = new Map<number, StoredEvaluation>();
  for (const occurrence of chain.occurrences) {
    const cached = await findCachedEvaluation(sql, cacheKeyFor(requestFor(chain, occurrence.ply, screeningProfile)));
    if (cached) screening.set(occurrence.ply, cached);
  }
  const selected = selectDeepPlies(chain, screening, phasesOf(chain));

  const session = await sessionFactory();
  const tally = emptyTally();
  let absorbed: string | null = null;
  try {
    for (const ply of [...selected.keys()].sort((left, right) => left - right).slice(0, BUDGETS.maxDeepPositionsPerGame)) {
      const beat = await context.checkpoint();
      if (!beat.continue) break;
      try {
        await evaluateOne(sql, session, requestFor(chain, ply, deepProfile), "deep", tally);
      } catch (error) {
        // Absorbed on purpose: the screening evidence for this transition is
        // complete, and the assessment will say `unavailable` rather than
        // claiming a look nobody got. A failure here must not cost the user a
        // review they can otherwise have.
        absorbed = error instanceof WorkFailure ? error.code : "deep_search_failed";
        logSafeError("deep search failed for one position", error);
      }
    }
  } finally {
    await session.close();
  }

  emitTally(DEEP_TASK, "stockfish-deep", context.traceId, tally, {
    startupMs: session.startupMs,
    durationMs: Date.now() - startedAt,
    deepSelected: selected.size,
    errorCode: absorbed,
    failureClass: absorbed ? "transient" : null,
    profile: "deep",
  });
  return {
    outputRef: `materializationRun:${payload.materializationRunId}`,
    outputSummary: { selected: selected.size, evaluated: tally.positions },
    metrics: {
      inputCount: selected.size,
      outputCount: tally.misses,
      cacheHits: tally.hits,
      computeMs: tally.engineMs,
      billedUnits: tally.nodes,
    },
  };
}

function phasesOf(chain: MaterializedChain): ReadonlyMap<number, GamePhase> {
  return classifyGamePhases({
    positions: chain.occurrences.map((occurrence) => ({ ply: occurrence.ply, fen: occurrence.fen })),
  }).byPly;
}

// ---------------------------------------------------------------------------
// 3. Assess: the decision measurements, the manifest, and the publication
// ---------------------------------------------------------------------------

export async function assessTransitions(context: WorkContext, sql: Sql): Promise<WorkResult> {
  const payload = parsePayload(assessPayload, context.item.payload);
  const startedAt = Date.now();

  // The actor comes from the workflow the API created, never from the payload.
  // Everything below then runs under that actor, so the forced owner policies on
  // `analysis.runs` and `analysis.transition_assessments` apply on the real
  // worker path: a payload naming another subject's run finds no run at all,
  // which is a stronger answer than a check this handler could have forgotten.
  const [workflow] = await sql<{ owner_profile_id: string | null }[]>`
    select owner_profile_id from ops.workflows where id = ${context.item.workflowId}
  `;
  if (!workflow?.owner_profile_id) {
    throw new WorkFailure("invalid_input", "unowned_workflow", "the workflow names no owner");
  }
  return withActor(sql, workflow.owner_profile_id, (tx) =>
    assessUnderActor(context, tx, payload.runId, startedAt),
  );
}

async function assessUnderActor(
  context: WorkContext,
  sql: Sql,
  runId: string,
  startedAt: number,
): Promise<WorkResult> {
  const [run] = await sql<
    { recipe_version_id: string; replay_revision_id: string; status: string }[]
  >`
    select recipe_version_id, replay_revision_id, status from analysis.runs where id = ${runId}
  `;
  if (!run) throw new WorkFailure("invalid_input", "unknown_run", "no such analysis run");
  if (run.status === "succeeded") {
    // A duplicate delivery after the run already completed. Publishing again is
    // refused by `ALREADY_PUBLISHED`, so the honest answer is to acknowledge.
    return { outputRef: `run:${runId}`, outputSummary: { duplicate: true } };
  }

  const materializationRunId = await publishedMaterializationRun(sql, String(run.replay_revision_id));
  if (!materializationRunId) {
    await failRun(sql, runId, "invalid_input");
    throw new WorkFailure("invalid_input", "no_published_materialization", "the replay has no published chain");
  }

  const roles = await readEngineRoles(sql, run.recipe_version_id);
  const screeningProfile = await resolveProfile(sql, {
    engineVersionId: roles.engineVersionId,
    calibrationVersionId: roles.calibrationVersionId,
    profile: "screening",
  });
  const deepProfile = await resolveProfile(sql, {
    engineVersionId: roles.engineVersionId,
    calibrationVersionId: roles.calibrationVersionId,
    profile: "deep",
  });
  const chain = await readChain(sql, materializationRunId);

  await startRun(sql, runId);
  // The ledger link, written by the deployment that owns the run's outputs.
  // The planner cannot write it: the API creates the run before any work item
  // exists, and it holds insert on `analysis.runs` and nothing more.
  await sql`
    update analysis.runs set work_item_id = ${context.item.id}
    where id = ${runId} and work_item_id is null
  `;

  const screening = new Map<number, StoredEvaluation>();
  for (const occurrence of chain.occurrences) {
    const cached = await findCachedEvaluation(sql, cacheKeyFor(requestFor(chain, occurrence.ply, screeningProfile)));
    if (cached) screening.set(occurrence.ply, cached);
  }

  const missing = chain.occurrences.filter((occurrence) => !screening.has(occurrence.ply));
  if (missing.length > 0) {
    // Retryable: the screening item succeeded, so the evidence should be there.
    // Failing the run here instead would throw away a complete screening pass
    // because of a read that arrived early.
    throw new WorkFailure(
      "transient",
      "screening_incomplete",
      `${missing.length} of ${chain.occurrences.length} positions have no screening evidence`,
    );
  }

  const phases = phasesOf(chain);
  const selected = selectDeepPlies(chain, screening, phases);
  const rows: AssessmentRow[] = [];
  const used = new Set<string>();

  for (const transition of chain.transitions) {
    const occurrence = chain.occurrences.find((entry) => entry.ply === transition.fromPly)!;
    const before = screening.get(transition.fromPly)!;
    const after = screening.get(transition.fromPly + 1)!;
    const reasons = selected.get(transition.fromPly);
    const deep = reasons
      ? await findCachedEvaluation(sql, cacheKeyFor(requestFor(chain, transition.fromPly, deepProfile)))
      : null;

    const evidence: TransitionEvidence = {
      fromPly: transition.fromPly,
      playedUci: transition.uci,
      actorColor: occurrence.sideToMove === "w" ? "white" : "black",
      before,
      after,
      deep,
      deepStatus: !reasons ? "not_selected" : deep ? "completed" : "unavailable",
      deepSelectionReasons: reasons ?? [],
      phase: phases.get(transition.fromPly) ?? null,
    };
    rows.push(buildAssessment(evidence));
    used.add(`${before.id}:transition_before`);
    used.add(`${after.id}:transition_after`);
    if (deep) used.add(`${deep.id}:deep_multipv`);
  }

  const { checksum } = await writeAssessments(sql, {
    runId: runId,
    materializationRunId,
    toleranceVersionId: roles.toleranceVersionId,
    rows,
  });
  for (const entry of used) {
    const separator = entry.lastIndexOf(":");
    await linkRunUse(
      sql,
      runId,
      entry.slice(0, separator),
      entry.slice(separator + 1) as "transition_before" | "transition_after" | "deep_multipv",
    );
  }

  await recordArtifact(sql, runId, {
    family: TRANSITION_ASSESSMENT_FAMILY,
    count: rows.length,
    checksum,
  });
  const completion = await completeRun(sql, runId);
  if (completion.status !== "succeeded") {
    // The recipe declares families this epic does not produce. That is a real
    // configuration error, not a transient one, and publishing a partial run is
    // exactly what E11's manifest check exists to prevent.
    await failRun(sql, runId, "invalid_input");
    throw new WorkFailure(
      "invalid_input",
      "manifest_incomplete",
      `missing: ${completion.missing.join(",") || "none"}; undeclared: ${completion.undeclared.join(",") || "none"}`,
    );
  }

  const publication = await publishSubjectGame(sql, {
    runId: runId,
    reason: "new_run",
    actor: { kind: "system" },
    traceId: context.traceId,
  });
  if (!publication.published && publication.refusedCode !== "ALREADY_PUBLISHED") {
    throw new WorkFailure("permanent", "publication_refused", publication.refusedCode);
  }

  return {
    outputRef: `run:${runId}`,
    outputSummary: {
      transitions: rows.length,
      deepCompleted: rows.filter((row) => row.deepStatus === "completed").length,
      deepUnavailable: rows.filter((row) => row.deepStatus === "unavailable").length,
      publicationId: publication.publicationId,
    },
    metrics: { inputCount: chain.transitions.length, outputCount: rows.length, computeMs: Date.now() - startedAt },
  };
}

// ---------------------------------------------------------------------------
// 4. Interactive: one bounded ad-hoc search
// ---------------------------------------------------------------------------

/**
 * API contract §14's bounded search, in the same worker and the same cache.
 *
 * It reads the board back out of `chess.core_positions` and pairs it with the
 * halfmove clock the request carried, which is how a user's position reaches
 * the engine without a FEN ever entering the work ledger. The fullmove number
 * is 1 because it cannot change an evaluation, and varying it would split one
 * cache entry into as many entries as there are move numbers.
 */
export async function evaluateInteractivePosition(
  context: WorkContext,
  sql: Sql,
): Promise<WorkResult> {
  const payload = parsePayload(positionPayload, context.item.payload);
  const startedAt = Date.now();
  const profile = await resolveAndVerify(sql, payload, "interactive");

  const [core] = await sql<{ core_key: string; core_key_hash: string }[]>`
    select core_key, core_key_hash from chess.core_positions where id = ${payload.corePositionId}
  `;
  if (!core) {
    throw new WorkFailure("invalid_input", "unknown_core_position", "no such core position");
  }

  const session = await sessionFactory();
  const tally = emptyTally();
  try {
    await evaluateOne(
      sql,
      session,
      {
        corePositionId: payload.corePositionId,
        corePositionKeyHash: core.core_key_hash,
        scope: "rule50",
        fen: `${core.core_key} ${payload.halfmoveClock} 1`,
        halfmoveClock: payload.halfmoveClock,
        history: null,
        occurrence: null,
        profile,
      },
      "interactive",
      tally,
    );
  } finally {
    await session.close();
  }

  emitTally(EVALUATE_POSITION_TASK, "stockfish-screen", context.traceId, tally, {
    startupMs: session.startupMs,
    durationMs: Date.now() - startedAt,
    deepSelected: 0,
    profile: "interactive",
  });
  return {
    outputRef: `corePosition:${payload.corePositionId}`,
    outputSummary: { cacheHit: tally.hits === 1 },
    metrics: { inputCount: 1, outputCount: tally.misses, cacheHits: tally.hits, billedUnits: tally.nodes },
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function parsePayload<T>(schema: z.ZodType<T>, payload: unknown): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new WorkFailure("invalid_input", "malformed_payload", "the work item payload does not match the task");
  }
  return parsed.data;
}

/**
 * What this deployment says it can run (platform spec §7's allowlist).
 *
 * Split by deployment on purpose. The engine service registers the two engine
 * handlers and not the assessment one, so a message routed to the wrong service
 * is dead-lettered as `unsupported` rather than executed by a process that has
 * no grant to finish it. `both` exists for the single-process local and gate
 * topology, which is a deployment shape and not a permission change — the
 * database roles still decide what each connection may write.
 */
export function registerEngineHandlers(scope: "engine" | "analysis" | "both" = "both"): void {
  if (scope !== "analysis") {
    registerHandler(SCREEN_TASK, async (context) => screenGame(context, await runtimeSql()));
    registerHandler(DEEP_TASK, async (context) => deepenGame(context, await runtimeSql()));
    registerHandler(EVALUATE_POSITION_TASK, async (context) =>
      evaluateInteractivePosition(context, await runtimeSql()),
    );
  }
  if (scope !== "engine") {
    registerHandler(ASSESS_TASK, async (context) => assessTransitions(context, await runtimeSql()));
  }
}

/**
 * The deployment's own connection, imported on first use.
 *
 * Deferred rather than imported at the top of the file because `db/client.js`
 * resolves and *gates* the connection at module load — deliberately, since a
 * process that cannot prove its database identity must not serve. Importing it
 * here eagerly would make every offline gate that only wants the handler
 * functions require a live DATABASE_URL to load them.
 */
async function runtimeSql(): Promise<Sql> {
  const { client } = await import("../db/client.js");
  return client as unknown as Sql;
}

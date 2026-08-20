/**
 * The E12 objective-evidence contract, frozen in one place.
 *
 * Same discipline as `ops/contract.ts` and `analysis/contract.ts`: every closed
 * set here is also a check constraint in `0024_e12_engine_outputs.sql`, and the
 * hash and scoring functions are contract rather than helpers — they *define*
 * when two engine results are the same result, and what Forma means by "the
 * player lost this much by playing that move".
 *
 * Three ideas carry the epic.
 *
 * **Scope is what a cached evaluation is allowed to claim.** A core position is
 * history-free, so a result computed from it cannot be presented as exact
 * evidence about a position whose value depends on repetition or the fifty-move
 * clock. `rule50` is therefore the floor for anything a transition cites, and
 * `history_exact` is required the moment a position has occurred before in the
 * same game. This is not a preference — a core-scoped number offered as exact
 * evidence for a repetition-sensitive occurrence is a false claim about a
 * player's decision.
 *
 * **A cache key covers every compatibility-relevant input.** Profile, limit,
 * MultiPV, threads, hash, tablebase, perspective, calibration, and the scope's
 * own qualifiers. Two rows with the same key are interchangeable; two rows that
 * differ in any of those are not, however similar the numbers look.
 *
 * **Expected score is calibrated and named.** The engine reports centipawns,
 * mate distance and a WDL triplet. Converting those to "how much of a point do
 * you expect from here" is a method, so it has a version, it is pinned by the
 * evaluation that used it, and it is part of the cache key.
 *
 * Sources: plans/database-architecture.md §§10.5, 15–16, 29; plans/v1-platform-spec.md
 * §§6.4, 7, 10.1, 12, 19; plans/v1-api-contract.md §§7, 14.
 */

import { createHash } from "node:crypto";
import { canonicalJson } from "../v1/canonical-json.js";

/** Every hash in this epic is a lowercase hex SHA-256, as in E11. */
export const HASH_SHAPE = /^[0-9a-f]{64}$/;

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/**
 * Database architecture §10.5. What a cached evaluation was computed over, and
 * therefore what it may be presented as.
 *
 * `core` is the board, side to move, castling rights and a legal en-passant
 * square — reusable across every transposition, and useful for broad
 * comparison. `rule50` adds the halfmove clock. `history_exact` adds the exact
 * rule-relevant move history, which is what a repetition-sensitive position
 * needs. `occurrence` is tied to one occurrence of one materialization run and
 * is never shared.
 */
export const EVALUATION_SCOPES = ["core", "rule50", "history_exact", "occurrence"] as const;
export type EvaluationScope = (typeof EVALUATION_SCOPES)[number];

/**
 * Scopes that may be cited as exact evidence about one occurrence.
 *
 * A `core` result cannot: it was computed without the clock, so it cannot know
 * a draw was one move away. A `rule50` result can, for a position that has not
 * repeated — repetition is the only rule-relevant fact left that the clock does
 * not carry, and `requiredScope` is what decides when that matters.
 */
export const EXACT_EVIDENCE_SCOPES = ["rule50", "history_exact", "occurrence"] as const;

export function isExactEvidenceScope(scope: EvaluationScope): boolean {
  return (EXACT_EVIDENCE_SCOPES as readonly string[]).includes(scope);
}

/** Database architecture §15.1. What an executable component version *is*. */
export const MODEL_ROLES = [
  "objective_engine",
  "human_policy",
  "human_outcome",
  "secondary_oracle",
  "detector",
  "embedding",
] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

/**
 * Database architecture §15.1's licence-review status.
 *
 * `cleared` is the only state a production profile may hold. Stockfish is
 * GPL-3.0 and runs as a separate process invoked over UCI, which is why the
 * objective engine can be cleared here while platform spec §12.1's Maia-family
 * weights cannot be promoted without their own review — E14's problem, recorded
 * as a state rather than assumed.
 */
export const LICENCE_STATUSES = ["pending", "cleared", "restricted", "rejected"] as const;
export type LicenceStatus = (typeof LICENCE_STATUSES)[number];

/** The resource classes E04 already names. A profile declares what it needs. */
export const HARDWARE_CLASSES = ["cpu_engine", "cpu_model", "gpu_model"] as const;
export type HardwareClass = (typeof HARDWARE_CLASSES)[number];

/** How a search is bounded. Never chosen by a client (API contract §14). */
export const LIMIT_TYPES = ["nodes", "depth", "movetime"] as const;
export type LimitType = (typeof LIMIT_TYPES)[number];

/**
 * The typed role an evaluation played for a run (database architecture §15.2).
 *
 * The link table exists so deleting a run removes the *use* without deleting an
 * otherwise anonymous cache entry, and so "what did this run actually read"
 * stays answerable after the fact.
 */
export const EVALUATION_INPUT_ROLES = [
  "transition_before",
  "transition_after",
  "deep_multipv",
  "interactive",
] as const;
export type EvaluationInputRole = (typeof EVALUATION_INPUT_ROLES)[number];

/**
 * Whether a transition's position got the deeper MultiPV look, and if not, why.
 *
 * `unavailable` is the honest state after an engine failure or an exhausted
 * budget: the screening evidence still stands, and pretending the position was
 * never interesting would hide that Forma wanted a closer look and did not get
 * one.
 */
export const DEEP_STATUSES = ["not_selected", "selected", "completed", "unavailable"] as const;
export type DeepStatus = (typeof DEEP_STATUSES)[number];

/** How an expected score was produced. Named, so a number is never anonymous. */
export const EXPECTED_SCORE_METHODS = ["wdl", "mate", "logistic", "terminal"] as const;
export type ExpectedScoreMethod = (typeof EXPECTED_SCORE_METHODS)[number];

/**
 * A position where the game is already over.
 *
 * `terminal` is the one method that is not a reading of an engine's opinion. A
 * checkmate is not estimated at 0.99 and a stalemate is not estimated at 0.5 --
 * they are 0 and 0.5 by the rules, exactly, and no search can improve on that.
 * Naming it separately keeps that distinction visible in the data: a row whose
 * method is `terminal` was decided by the laws of chess, and a row whose method
 * is `logistic` was decided by a curve with a version number.
 */
export const TERMINAL_OUTCOMES = ["checkmate", "draw"] as const;
export type TerminalOutcome = (typeof TERMINAL_OUTCOMES)[number];

/**
 * The score the rules give, from White's perspective.
 *
 * Checkmate is stated relative to the side to move, because that is the side
 * that has been mated -- there is no other way for a position to be checkmate.
 * Every terminal draw is a half point regardless of how it was reached, which
 * is why stalemate, insufficient material, the seventy-five-move rule and
 * fivefold repetition collapse into one outcome here.
 */
export function terminalExpectedScore(
  outcome: TerminalOutcome,
  sideToMove: "white" | "black",
): ExpectedScore & { scoreCp: number | null; mateIn: number | null } {
  if (outcome === "checkmate") {
    // `mate_in = 0` is how the row says "mated, here, now"; the schema requires
    // exactly one of a centipawn score and a mate distance, and a mated
    // position has no centipawn score that means anything.
    return { value: sideToMove === "white" ? 0 : 1, method: "terminal", scoreCp: null, mateIn: 0 };
  }
  return { value: 0.5, method: "terminal", scoreCp: 0, mateIn: null };
}

// ---------------------------------------------------------------------------
// Component keys and profiles
// ---------------------------------------------------------------------------

/**
 * The component keys this epic registers in E11's catalogue.
 *
 * They are keys, not versions: the version is whatever `registerEngineVersions`
 * pins, and a recipe cites the version rather than the key. Naming them here
 * means the worker, the recipe fixtures and the API all resolve the same roles.
 */
export const ENGINE_COMPONENT_KEYS = {
  objectiveEngine: "objective_engine_sf",
  expectedScore: "expected_score_calibration",
  tolerance: "objective_tolerance",
  criticalSelector: "critical_position_selector",
} as const;

/** The recipe roles a game analysis must pin for this epic's outputs to exist. */
export const GAME_ANALYSIS_ROLES = [
  "engine",
  "expected_score",
  "tolerance",
  "critical_selector",
] as const;

/** The output family a game analysis run produces here. */
export const TRANSITION_ASSESSMENT_FAMILY = "transition_assessments";

export interface EngineProfileSpec {
  key: string;
  limitType: LimitType;
  limitValue: number;
  multipv: number;
  threads: number;
  hashMb: number;
  tablebase: boolean;
}

/**
 * The three bounded searches this epic runs. Server-side and closed.
 *
 * `screening` is what every transition gets: one line, enough nodes to rank a
 * decision, cheap enough to run 80 times per game. `deep` is what a selected
 * critical position gets: ten times the nodes and three lines, which is what
 * makes an adequate-move set and an only-move classification possible at all.
 * `interactive` is the bounded ad-hoc search behind API contract §14 — the same
 * shape as screening, kept separate so a user request can never be mistaken for
 * pipeline evidence and so its budget can move independently.
 *
 * Threads is 1 and hash is 64 MiB because platform spec §6.4 sizes the worker
 * at concurrency 1 on at least 2 vCPU: a second search thread makes the result
 * nondeterministic, and a nondeterministic result cannot be cached honestly.
 */
export const ENGINE_PROFILES = {
  screening: {
    key: "screening",
    limitType: "nodes",
    limitValue: 50_000,
    multipv: 1,
    threads: 1,
    hashMb: 64,
    tablebase: false,
  },
  deep: {
    key: "deep",
    limitType: "nodes",
    limitValue: 500_000,
    multipv: 3,
    threads: 1,
    hashMb: 64,
    tablebase: false,
  },
  interactive: {
    key: "interactive",
    limitType: "nodes",
    limitValue: 50_000,
    multipv: 3,
    threads: 1,
    hashMb: 64,
    tablebase: false,
  },
} as const satisfies Record<string, EngineProfileSpec>;

export type EngineProfileKey = keyof typeof ENGINE_PROFILES;

// ---------------------------------------------------------------------------
// Scope rules
// ---------------------------------------------------------------------------

/** The rule-relevant history facts of one occurrence, from E09's chain. */
export interface OccurrenceContext {
  halfmoveClock: number;
  repetitionCount: number;
}

/**
 * The weakest scope that may be cited as evidence about this occurrence.
 *
 * `rule50` is the floor, always: the halfmove clock changes what a position is
 * worth near a draw, and a core-only number cannot know it. It rises to
 * `history_exact` the moment the position has already occurred in this game,
 * because from there the engine's value depends on a repetition it can only see
 * if it is given the moves that produced it.
 *
 * Deliberately not "history_exact for everything": reconstructing history for
 * every ply would defeat the transposition cache that makes screening 80
 * positions per game affordable, and buys nothing for a position that has never
 * repeated.
 */
export function requiredScope(occurrence: OccurrenceContext): EvaluationScope {
  return occurrence.repetitionCount > 1 ? "history_exact" : "rule50";
}

/** The rule-relevant history handed to the engine for a `history_exact` search. */
export interface ExactHistory {
  /** The position at the last irreversible move: the root the moves replay from. */
  rootFen: string;
  /** UCI moves from `rootFen` to the position being evaluated. */
  moves: readonly string[];
}

/**
 * A stable identity for one reconstructed history.
 *
 * Two occurrences with the same root and the same moves are the same
 * repetition situation, wherever they came from — which is what lets a
 * history-exact result be cached at all rather than recomputed per game.
 */
export function historySignature(history: ExactHistory): string {
  return sha256({ rootFen: history.rootFen, moves: [...history.moves] });
}

// ---------------------------------------------------------------------------
// The cache key
// ---------------------------------------------------------------------------

export interface EvaluationCacheKeyInput {
  /** E09's core position identity: deterministic across deployments. */
  corePositionKeyHash: string;
  scope: EvaluationScope;
  /** Required for every scope except `core`. */
  halfmoveClock: number | null;
  /** Required for `history_exact` and `occurrence`. */
  historySignature: string | null;
  /** Required for `occurrence`, forbidden otherwise. */
  occurrence: { materializationRunId: string; ply: number } | null;
  /** The engine component version's content hash, not its row id. */
  profileContentHash: string;
  /** The expected-score calibration's content hash. */
  calibrationContentHash: string;
  limitType: LimitType;
  limitValue: number;
  multipv: number;
  threads: number;
  hashMb: number;
  tablebase: boolean;
  perspective: "white" | "black";
}

/** Bumped only when the key's *meaning* changes, which invalidates every row. */
export const CACHE_KEY_VERSION = "eval-cache-1";

/**
 * The deterministic identity of one engine computation.
 *
 * Everything that could change the numbers is in here, and nothing that
 * identifies a person is: no subject, user, game or account reference reaches
 * this function, which is what makes an anonymous cache entry anonymous
 * (database architecture §15.2). Occurrence-scoped rows carry a materialization
 * run id and are consequently *not* anonymous — they follow the occurrence's
 * retention, and the schema keeps them distinguishable for exactly that reason.
 */
export function evaluationCacheKey(input: EvaluationCacheKeyInput): string {
  return sha256({
    version: CACHE_KEY_VERSION,
    corePositionKeyHash: input.corePositionKeyHash,
    scope: input.scope,
    halfmoveClock: input.halfmoveClock,
    historySignature: input.historySignature,
    occurrence: input.occurrence
      ? { materializationRunId: input.occurrence.materializationRunId, ply: input.occurrence.ply }
      : null,
    profileContentHash: input.profileContentHash,
    calibrationContentHash: input.calibrationContentHash,
    limitType: input.limitType,
    limitValue: input.limitValue,
    multipv: input.multipv,
    threads: input.threads,
    hashMb: input.hashMb,
    tablebase: input.tablebase,
    perspective: input.perspective,
  });
}

/** The scope qualifiers a scope requires and forbids. Mirrors the DDL checks. */
export function scopeViolations(input: {
  scope: EvaluationScope;
  halfmoveClock: number | null;
  historySignature: string | null;
  occurrence: { materializationRunId: string; ply: number } | null;
}): string[] {
  const problems: string[] = [];
  const needsClock = input.scope !== "core";
  const needsHistory = input.scope === "history_exact" || input.scope === "occurrence";
  const needsOccurrence = input.scope === "occurrence";

  if (needsClock && input.halfmoveClock == null) problems.push(`${input.scope} requires halfmoveClock`);
  if (!needsClock && input.halfmoveClock != null) problems.push("core must not carry halfmoveClock");
  if (needsHistory && input.historySignature == null) {
    problems.push(`${input.scope} requires historySignature`);
  }
  if (!needsHistory && input.historySignature != null) {
    problems.push(`${input.scope} must not carry historySignature`);
  }
  if (needsOccurrence && input.occurrence == null) problems.push("occurrence requires an occurrence");
  if (!needsOccurrence && input.occurrence != null) {
    problems.push(`${input.scope} must not carry an occurrence`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Expected score
// ---------------------------------------------------------------------------

/**
 * The versioned conversion from engine output to expected score.
 *
 * `logisticScale` is used only when the engine gave centipawns without a WDL
 * triplet. It is a stated, testable assumption — the Elo-curve scale of 400 —
 * not a claim about Stockfish's internal model, which is why the preferred path
 * is the engine's own WDL and why the method that produced each number is
 * stored beside it.
 */
export const EXPECTED_SCORE_CALIBRATION = {
  version: "1",
  logisticScale: 400,
} as const;

export interface EngineValue {
  /** Centipawns from White's perspective. */
  scoreCp: number | null;
  /** Mate distance in moves from White's perspective; negative means White is mated. */
  mateIn: number | null;
  /** Win/draw/loss permille from White's perspective. */
  wdl: readonly [number, number, number] | null;
}

export interface ExpectedScore {
  /** White's expected points from this position, in [0, 1]. */
  value: number;
  method: ExpectedScoreMethod;
}

/**
 * White's expected score, by the calibration above.
 *
 * WDL first, because it is the engine's own answer to this exact question and
 * needs no curve. Mate second, because a forced mate is a decided game and a
 * logistic curve on a synthetic centipawn value would blur that. The logistic
 * is the fallback, and it is labelled as one.
 */
export function expectedScore(value: EngineValue): ExpectedScore {
  if (value.wdl) {
    const [win, draw] = value.wdl;
    return { value: clampUnit((win + draw / 2) / 1_000), method: "wdl" };
  }
  if (value.mateIn != null) {
    // Mate in 0 is not a position anyone is to move in; treat the sign as the
    // only information and refuse to invent a draw.
    return { value: value.mateIn >= 0 ? 1 : 0, method: "mate" };
  }
  if (value.scoreCp != null) {
    const exponent = -value.scoreCp / EXPECTED_SCORE_CALIBRATION.logisticScale;
    return { value: clampUnit(1 / (1 + 10 ** exponent)), method: "logistic" };
  }
  throw new RangeError("an engine value must carry a WDL triplet, a mate distance or centipawns");
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Numeric(6,5) in the schema: five decimals, and the same rounding everywhere. */
export function roundScore(value: number): number {
  return Math.round(value * 100_000) / 100_000;
}

/** Flip a White-perspective expected score into the actor's. */
export function fromActor(whiteExpectedScore: number, actorColor: "white" | "black"): number {
  return actorColor === "white" ? whiteExpectedScore : 1 - whiteExpectedScore;
}

// ---------------------------------------------------------------------------
// The tolerance rule
// ---------------------------------------------------------------------------

/**
 * The versioned objective tolerance (platform spec §12.2's "adequate move set").
 *
 * A move is acceptable when it costs no more than this much expected score
 * against the best line the same search found. Two hundredths of a point is
 * roughly the width of engine noise at screening depth, and it is a *stated*
 * threshold pinned by a component version, so changing it is a new method
 * rather than a quiet reclassification of every game ever analysed.
 *
 * Note what this is not: it is not "good", "mistake" or "blunder". Database
 * architecture §16.1 makes those optional presentation classifications derived
 * from measurements, and this epic deliberately stores the measurement.
 */
export const TOLERANCE_RULE = {
  version: "1",
  expectedScoreTolerance: 0.02,
} as const;

export function isAcceptableLoss(decisionLoss: number): boolean {
  return decisionLoss <= TOLERANCE_RULE.expectedScoreTolerance;
}

/**
 * The adequate-move set of one search, and what it says about the position.
 *
 * Every field is null when the search returned fewer than two lines. That is
 * not a gap to be filled with a default: a one-line search never looked at an
 * alternative, so "how many moves were adequate" and "was this the only move"
 * genuinely have no answer, and answering them anyway is how a screening result
 * gets quoted as if it were a deep one.
 */
export interface CandidateAssessment {
  acceptableMoveCount: number | null;
  onlyMove: boolean | null;
  /** Best minus worst retained candidate, in actor-perspective expected score. */
  criticality: number | null;
}

export function assessCandidates(
  actorExpectedScores: readonly number[],
): CandidateAssessment {
  if (actorExpectedScores.length < 2) {
    return { acceptableMoveCount: null, onlyMove: null, criticality: null };
  }
  const sorted = [...actorExpectedScores].sort((a, b) => b - a);
  const best = sorted[0]!;
  const acceptable = sorted.filter((score) => isAcceptableLoss(best - score)).length;
  return {
    acceptableMoveCount: acceptable,
    onlyMove: acceptable === 1,
    criticality: roundScore(best - sorted[sorted.length - 1]!),
  };
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

/**
 * Named budgets for the paths this epic adds, asserted by `engine:performance`
 * against production-shaped fixtures.
 *
 * The read budgets are absolute; the write budget is per 80-transition game,
 * which is database architecture §29.1's shape for one game. `perGameNodes` is
 * the capacity envelope the epic is accountable for: 80 screening searches plus
 * up to 12 deep ones, which is what the 1,000-game benchmark reports against.
 */
export const BUDGETS = {
  /** One cache lookup by key, p95. It runs once per position, twice per transition. */
  cacheLookupMs: 25,
  /** Writing 80 transition assessments with their evaluation-use links. */
  assessGameMs: 2_000,
  /** One published game review over its transitions, p95. */
  reviewReadMs: 250,
  /** Screening nodes for an 80-ply game, plus 12 deep searches. */
  perGameNodes: 80 * ENGINE_PROFILES.screening.limitValue + 12 * ENGINE_PROFILES.deep.limitValue,
  /** Deep searches one game may receive. Mirrors the selector policy cap. */
  maxDeepPositionsPerGame: 12,
} as const;

/**
 * What one game costs, for the cost-per-game signal platform spec §19 asks for.
 *
 * Nodes are the unit Forma controls; seconds are what Cloud Run bills. The rate
 * is a measured property of the worker shape, so it lives beside the budget it
 * explains rather than inside a dashboard nobody can test.
 */
export const COST_MODEL = {
  /** Measured on the benchmark corpus at 1 thread. Update with the benchmark. */
  nodesPerSecond: 1_000_000,
  /** Cloud Run 2 vCPU / 2 GiB, us-central1, in micro-USD per second. */
  microUsdPerSecond: 26,
} as const;

export function estimatedCostMicroUsd(nodes: number): number {
  return Math.round((nodes / COST_MODEL.nodesPerSecond) * COST_MODEL.microUsdPerSecond);
}

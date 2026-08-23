/**
 * Assembling a rating's evidence from a game nobody has analysed yet.
 *
 * The pipeline path reads a published review, which already has most of this.
 * The public path does not: somebody pastes a PGN of a game Forma has never
 * seen, and every number has to be produced on the spot. This module is that
 * path, written against two ports so it can be driven by a real Stockfish and
 * Maia in production and by fakes in a test.
 *
 * ## The budget is the design
 *
 * Screening every position is unavoidable and cheap. The two expensive reads
 * are deliberately not spent everywhere:
 *
 * - **MultiPV** runs at a bounded set of positions, chosen by how much of the
 *   game was in them. That set is what produces criticality, only-move and the
 *   whole practical reading, so it is also the set that decides how much of the
 *   rating rests on measurement rather than on refusal.
 * - **The policy ladder** is nine inferences per ply, which is affordable for
 *   one pasted game and not for an archive. `plyPolicyLimit` caps it, and the
 *   plies that get it are spread across the game rather than taken from the
 *   front, because the opening is the part that discriminates least.
 *
 * ## Two passes, because the second needs the answer to the first
 *
 * The practical reading has to condition on the opponent, so it needs to know
 * how strong the opponent is. A pasted PGN often has no ratings in it — famous
 * games especially — and guessing one would put a fabricated number underneath
 * every pressure figure in the output.
 *
 * So the strength estimate runs first, from the actor policies alone, and its
 * answer becomes the conditioning rating for the practical pass wherever the
 * headers do not supply one. That is a real inference rather than a default:
 * we do not know what the player was rated, but we do know how strongly they
 * played, and that is the better conditioning variable anyway.
 */

import { Chess } from "chess.js";

import { fromActor, isAcceptableLoss, assessCandidates, roundScore } from "../engine/contract.js";
import { CALIBRATED_RATING_CEILING, CALIBRATED_RATING_FLOOR } from "../models/contract.js";
import type { PolicyDistribution } from "../models/policy.js";
import type { ParsedPgnMove } from "../ingest/pgn.js";
import {
  STRENGTH_POLICY,
  type Color,
  type Decision,
  type GameRatingInput,
  type ReplyEvidence,
} from "./contract.js";
import { scoreDecision, liveness } from "./decisions.js";
import { estimateStrength } from "./strength.js";
import { likelihoodsFor, type RungPolicy } from "./likelihood.js";

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** One line of a search, valued from White's perspective after the move. */
export interface EngineLine {
  uci: string;
  expectedScoreWhite: number;
}

export interface EnginePort {
  /**
   * Evaluate one position, retaining `multipv` lines.
   *
   * Returning fewer lines than asked is allowed and meaningful: it is what a
   * position with three legal moves looks like, and the caller treats a
   * single-line answer as a search that never looked at an alternative.
   */
  evaluate(input: { fen: string; multipv: number }): Promise<readonly EngineLine[]>;
}

export interface PolicyPort {
  policy(input: { fen: string; rating: number }): Promise<PolicyDistribution>;
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/**
 * What one public rating is allowed to cost.
 *
 * Named and versioned rather than passed in ad hoc, because the budget changes
 * what the rating can claim: a game given four MultiPV positions has less
 * measured demand than the same game given twelve, and two ratings produced
 * under different budgets are not comparable. `deepPositions` matches the
 * pipeline's own cap so that a game rated here and a game rated there are.
 */
export const ANALYSIS_BUDGET = {
  version: "1",
  deepPositions: 12,
  deepMultipv: 3,
  /**
   * Plies that get the full policy ladder.
   *
   * Spread across the game rather than taken from the front. The opening is
   * where every rung agrees, so front-loading would spend the budget on the
   * plies that discriminate least.
   */
  plyPolicyLimit: 60,
  /** Longer than this and the game is truncated rather than refused. */
  maxPlies: 300,
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function legalMoveCount(fen: string): number | null {
  try {
    return new Chess(fen).moves().length;
  } catch {
    return null;
  }
}

function otherColor(color: Color): Color {
  return color === "white" ? "black" : "white";
}

/**
 * Which positions are worth a MultiPV search.
 *
 * Ranked by how much of the game was in the decision: the liveness of the
 * position multiplied by what the move gave away, with a floor so that a live
 * position still competes when nothing was given away at all. That floor is
 * what lets an only-move that was *found* enter the set — those positions cost
 * nothing in expected score and are exactly the ones demand is made of.
 */
function selectDeepPlies(
  moves: readonly { ply: number; liveness: number; loss: number }[],
  limit: number,
): Set<number> {
  const ranked = [...moves]
    .map((move) => ({ ply: move.ply, weight: move.liveness * (0.02 + Math.max(0, move.loss)) }))
    .sort((left, right) => right.weight - left.weight || left.ply - right.ply)
    .slice(0, limit);
  return new Set(ranked.map((entry) => entry.ply));
}

/** Plies that get the policy ladder, spread evenly rather than front-loaded. */
function selectPolicyPlies(plies: readonly number[], limit: number): Set<number> {
  if (plies.length <= limit) return new Set(plies);
  const step = plies.length / limit;
  const chosen = new Set<number>();
  for (let index = 0; index < limit; index += 1) {
    chosen.add(plies[Math.floor(index * step)]!);
  }
  return chosen;
}

/**
 * The conditioning rating for the practical pass.
 *
 * A declared rating wins, because it is a fact about the player rather than an
 * inference about the game. Outside the calibrated range it is clamped to the
 * nearest rung and the caller is told, which is the same treatment
 * `practical.ts` gives an out-of-domain slice: answer, but never claim it was
 * calibrated.
 */
function conditioningRating(
  declared: number | null,
  estimated: number | null,
): { rating: number | null; outOfDomain: boolean } {
  const source = declared ?? estimated;
  if (source === null) return { rating: null, outOfDomain: false };
  const outOfDomain = source < CALIBRATED_RATING_FLOOR || source >= CALIBRATED_RATING_CEILING;
  const nearest = STRENGTH_POLICY.ladder.reduce((best, rung) =>
    Math.abs(rung - source) < Math.abs(best - source) ? rung : best,
  );
  return { rating: nearest, outOfDomain };
}

// ---------------------------------------------------------------------------
// The assembler
// ---------------------------------------------------------------------------

export interface AnalyseOptions {
  engine: EnginePort;
  policy: PolicyPort;
  /** Declared ratings, when the PGN or the caller supplied them. */
  whiteRating?: number | null;
  blackRating?: number | null;
  canonicalGameId?: string | null;
  budget?: typeof ANALYSIS_BUDGET;
}

export interface AnalysisCost {
  screeningPositions: number;
  deepPositions: number;
  policyInferences: number;
}

export interface AnalysedGame {
  input: GameRatingInput;
  cost: AnalysisCost;
  /** The rating each side's practical reading was conditioned on, and how. */
  conditioning: Record<Color, { rating: number | null; declared: boolean; outOfDomain: boolean }>;
}

export async function analyseGame(
  moves: readonly ParsedPgnMove[],
  options: AnalyseOptions,
): Promise<AnalysedGame> {
  const budget = options.budget ?? ANALYSIS_BUDGET;
  const played = moves.slice(0, budget.maxPlies);
  const cost: AnalysisCost = { screeningPositions: 0, deepPositions: 0, policyInferences: 0 };

  // --- screening: one value per distinct position ---------------------------

  const positions = new Map<string, number>();
  const valueOf = async (fen: string): Promise<number> => {
    const cached = positions.get(fen);
    if (cached !== undefined) return cached;
    const lines = await options.engine.evaluate({ fen, multipv: 1 });
    cost.screeningPositions += 1;
    // An empty answer is a terminal position: the side to move has no move, and
    // the value is whatever the search would have said about a game that is
    // over. Half a point is wrong for checkmate, so refuse to guess and let the
    // caller's engine report it.
    const value = lines[0]?.expectedScoreWhite ?? 0.5;
    positions.set(fen, value);
    return value;
  };

  const screened = [];
  for (const move of played) {
    const before = await valueOf(move.fenBefore);
    const after = await valueOf(move.fenAfter);
    const actor = move.color as Color;
    const expectedScoreBefore = roundScore(fromActor(before, actor));
    const expectedScoreAfter = roundScore(fromActor(after, actor));
    screened.push({
      move,
      actor,
      expectedScoreBefore,
      expectedScoreAfter,
      loss: roundScore(expectedScoreBefore - expectedScoreAfter),
      liveness: liveness(expectedScoreBefore),
    });
  }

  // --- the policy ladder, and the strength it implies ------------------------

  const policyPlies = selectPolicyPlies(
    screened.map((entry) => entry.move.ply),
    budget.plyPolicyLimit,
  );

  const likelihoods = new Map<number, Readonly<Record<number, number>>>();
  for (const entry of screened) {
    if (!policyPlies.has(entry.move.ply)) continue;
    const rungs: RungPolicy[] = [];
    for (const rung of STRENGTH_POLICY.ladder) {
      rungs.push({ rating: rung, policy: await options.policy.policy({ fen: entry.move.fenBefore, rating: rung }) });
      cost.policyInferences += 1;
    }
    const result = likelihoodsFor(entry.move.uci, rungs, legalMoveCount(entry.move.fenBefore));
    if (result.status === "available") likelihoods.set(entry.move.ply, result.byRating);
  }

  const provisional: Decision[] = screened.map((entry) => ({
    ply: entry.move.ply,
    actor: entry.actor,
    playedUci: entry.move.uci,
    phase: null,
    expectedScoreBefore: entry.expectedScoreBefore,
    expectedScoreAfter: entry.expectedScoreAfter,
    criticality: null,
    onlyMove: null,
    deepSearched: false,
    book: false,
    legalMoveCount: legalMoveCount(entry.move.fenBefore),
    bandLogLikelihoods: likelihoods.get(entry.move.ply) ?? null,
    reply: null,
  }));

  const estimatedFor = (color: Color): number | null => {
    const estimate = estimateStrength(
      provisional.filter((decision) => decision.actor === color).map(scoreDecision),
    );
    return estimate.status === "available" ? estimate.rating : null;
  };

  const conditioning = {
    white: {
      ...conditioningRating(options.whiteRating ?? null, estimatedFor("white")),
      declared: options.whiteRating != null,
    },
    black: {
      ...conditioningRating(options.blackRating ?? null, estimatedFor("black")),
      declared: options.blackRating != null,
    },
  } satisfies AnalysedGame["conditioning"];

  // --- the deep set: criticality, only-move, and the practical reading -------

  const deepPlies = selectDeepPlies(
    screened.map((entry) => ({ ply: entry.move.ply, liveness: entry.liveness, loss: entry.loss })),
    budget.deepPositions,
  );

  const decisions: Decision[] = [];
  for (let index = 0; index < screened.length; index += 1) {
    const entry = screened[index]!;
    const decision = provisional[index]!;
    if (!deepPlies.has(entry.move.ply)) {
      decisions.push(decision);
      continue;
    }

    const before = await options.engine.evaluate({
      fen: entry.move.fenBefore,
      multipv: budget.deepMultipv,
    });
    cost.deepPositions += 1;
    const candidates = assessCandidates(
      before.map((line) => fromActor(line.expectedScoreWhite, entry.actor)),
    );

    const reply = await buildReply(entry, options, budget, conditioning, cost);

    decisions.push({
      ...decision,
      criticality: candidates.criticality,
      onlyMove: candidates.onlyMove,
      deepSearched: true,
      reply,
    });
  }

  return {
    input: {
      decisions,
      deepPassRan: deepPlies.size > 0,
      canonicalGameId: options.canonicalGameId ?? null,
    },
    cost,
    conditioning,
  };
}

/**
 * The reply evidence for one decision: how likely the opponent is to hold, and
 * what it costs them when they do not.
 *
 * Both halves come from the position the move created. The engine says which
 * replies are adequate under the tolerance rule, and the policy says how much
 * mass the opponent puts on them. Without a conditioning rating there is no
 * second half, and the reading is refused rather than completed with a default
 * opponent.
 */
async function buildReply(
  entry: { move: ParsedPgnMove; actor: Color },
  options: AnalyseOptions,
  budget: typeof ANALYSIS_BUDGET,
  conditioning: AnalysedGame["conditioning"],
  cost: AnalysisCost,
): Promise<ReplyEvidence | null> {
  const opponent = otherColor(entry.actor);
  const rating = conditioning[opponent].rating;
  if (rating === null) return null;

  const replies = await options.engine.evaluate({
    fen: entry.move.fenAfter,
    multipv: budget.deepMultipv,
  });
  cost.deepPositions += 1;
  if (replies.length < 2) return null;

  const valued = replies.map((line) => ({
    uci: line.uci,
    opponentValue: fromActor(line.expectedScoreWhite, opponent),
    actorValue: fromActor(line.expectedScoreWhite, entry.actor),
  }));
  const best = Math.max(...valued.map((line) => line.opponentValue));
  const adequate = valued.filter((line) => isAcceptableLoss(best - line.opponentValue));
  const inadequate = valued.filter((line) => !isAcceptableLoss(best - line.opponentValue));
  if (inadequate.length === 0) return null;

  // The opponent's best mistake, which is the conservative reading of what a
  // miss is worth: the likeliest wrong move is the least wrong one.
  const ifMissed = Math.min(...inadequate.map((line) => line.actorValue));

  const policy = await options.policy.policy({ fen: entry.move.fenAfter, rating });
  cost.policyInferences += 1;

  const adequateUcis = new Set(adequate.map((line) => line.uci));
  let mass = 0;
  for (const move of policy.moves) {
    if (adequateUcis.has(move.uci)) mass += move.probability;
  }

  return {
    adequateReplyProbability: Math.min(1, Math.max(0, mass)),
    unretainedProbabilityMass: policy.unretainedMass,
    expectedScoreIfMissed: roundScore(ifMissed),
    outOfDomain: conditioning[opponent].outOfDomain,
  };
}

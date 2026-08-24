/**
 * The rating, cut into pieces that survive a workflow boundary.
 *
 * `analyse.ts` runs the whole thing in one process against two ports, which is
 * what the tests and any future synchronous mode use. Production cannot: the
 * engine lives on `forma-stockfish`, the human policy on `forma-maia`, and the
 * work ledger fixes a workflow's item list when the workflow is created. So the
 * same computation has to be expressible as three pure steps with serialisable
 * things in between.
 *
 * 1. `screeningPositions` — every position the cheap pass must value. Known
 *    from the moves alone, so these items can be created immediately.
 * 2. `planRating` — given those values, which positions deserve a deeper look,
 *    which plies are worth asking the human policy about, and therefore exactly
 *    which `(position, rating)` pairs the second workflow needs.
 * 3. `assembleRating` — given the deeper look and the policies, the input the
 *    scorer takes.
 *
 * Step 2 needs step 1's answers, which is why this is two chained workflows
 * rather than one. That is not a workaround: a selection made before the engine
 * has spoken would spend the whole policy budget on dead positions, and the
 * budget is the thing that decides what the rating may claim.
 */

import { Chess } from "chess.js";

import { assessCandidates, fromActor, isAcceptableLoss, roundScore } from "../engine/contract.js";
import type { PolicyDistribution } from "../models/policy.js";
import type { ParsedPgnMove } from "../ingest/pgn.js";
import {
  CLEANLINESS_POLICY,
  STRENGTH_POLICY,
  type Color,
  type Decision,
  type GameRatingInput,
  LADDER_CEILING,
  LADDER_FLOOR,
} from "./contract.js";
import { liveness, scoreDecision } from "./decisions.js";
import { estimateStrength } from "./strength.js";
import { likelihoodsFor, type RungPolicy } from "./likelihood.js";
import { ANALYSIS_BUDGET, type EngineLine } from "./analyse.js";

// ---------------------------------------------------------------------------
// Step 1: what the cheap pass must value
// ---------------------------------------------------------------------------

/**
 * Every distinct position in the game, once.
 *
 * The position after one move is the position before the next, so a game of n
 * plies has n + 1 positions rather than 2n. Asking for the same FEN twice would
 * double the screening bill for no new information.
 */
export function screeningPositions(moves: readonly ParsedPgnMove[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const move of moves) {
    for (const fen of [move.fenBefore, move.fenAfter]) {
      if (seen.has(fen)) continue;
      seen.add(fen);
      out.push(fen);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Step 2: the plan
// ---------------------------------------------------------------------------

export interface PolicyRequest {
  fen: string;
  rating: number;
}

export interface RatingPlan {
  /** The skeleton: everything screening can say, and nulls for the rest. */
  decisions: Decision[];
  /** Plies whose before- and after-positions need a MultiPV search. */
  deepPlies: number[];
  /** Plies whose before-position needs the policy ladder. */
  policyPlies: number[];
  /**
   * Every `(position, rating)` pair the second workflow needs, deduplicated.
   *
   * Reply positions are asked for at every rung rather than at the opponent's
   * own, because the opponent's conditioning rating comes from the strength
   * estimate, which does not exist until the ladder has been answered. Asking
   * the whole ladder costs more inferences and removes a second dependency
   * stage; and since the cache is keyed by position and rating and shared with
   * the play feature, none of it is wasted.
   */
  policyRequests: PolicyRequest[];
}

function legalMoveCount(fen: string): number | null {
  try {
    return new Chess(fen).moves().length;
  } catch {
    return null;
  }
}

/**
 * Which plies are worth asking the human policy about.
 *
 * The estimate compares rungs, so a ply where every rung would agree adds the
 * same amount to all of them and cancels out of the comparison entirely. Book
 * moves, recaptures and shuffling in a decided position are exactly those
 * plies: paying nine inferences for one buys nothing.
 *
 * So the budget goes to plies with a real choice in a position that is still
 * alive, ranked by how much choice there was. `legalMoveCount` stands in for
 * breadth because it is free, and liveness for whether the game was still on.
 */
function selectPolicyPlies(
  candidates: readonly { ply: number; liveness: number; legal: number | null; book: boolean }[],
  limit: number,
): number[] {
  return candidates
    .filter((entry) => !entry.book && (entry.legal ?? 2) > 1 && entry.liveness > 0.05)
    .map((entry) => ({ ply: entry.ply, weight: entry.liveness * Math.min(entry.legal ?? 20, 40) }))
    .sort((left, right) => right.weight - left.weight || left.ply - right.ply)
    .slice(0, limit)
    .map((entry) => entry.ply)
    .sort((left, right) => left - right);
}

/**
 * Positions worth a MultiPV search: where the game was, and what it cost.
 *
 * The same liveness floor cleanliness uses, for the same reason and for one
 * more. A decided position tells us nothing about either player, and every deep
 * position also drags nine policy inferences behind it for its reply. Without
 * the floor a dead-won endgame would spend the whole Maia budget on positions
 * where the answer could not have mattered.
 */
function selectDeepPlies(
  candidates: readonly { ply: number; liveness: number; loss: number }[],
  limit: number,
): number[] {
  return candidates
    .filter((entry) => entry.liveness >= CLEANLINESS_POLICY.livenessFloor)
    .map((entry) => ({ ply: entry.ply, weight: entry.liveness * (0.02 + Math.max(0, entry.loss)) }))
    .sort((left, right) => right.weight - left.weight || left.ply - right.ply)
    .slice(0, limit)
    .map((entry) => entry.ply)
    .sort((left, right) => left - right);
}

export interface PlanOptions {
  /** Plies inside the opening book, which say nothing about strength. */
  bookPlies?: number;
  budget?: typeof ANALYSIS_BUDGET;
}

export function planRating(
  moves: readonly ParsedPgnMove[],
  screened: ReadonlyMap<string, number>,
  options: PlanOptions = {},
): RatingPlan {
  const budget = options.budget ?? ANALYSIS_BUDGET;
  const bookPlies = options.bookPlies ?? 0;
  const played = moves.slice(0, budget.maxPlies);

  const decisions: Decision[] = [];
  const shape: { ply: number; liveness: number; loss: number; legal: number | null; book: boolean }[] = [];

  for (const move of played) {
    const actor = move.color as Color;
    const before = screened.get(move.fenBefore);
    const after = screened.get(move.fenAfter);
    // A position the screening pass never valued cannot be scored. Defaulting
    // it to a half point would invent a balanced position out of a gap.
    if (before === undefined || after === undefined) continue;

    const expectedScoreBefore = roundScore(fromActor(before, actor));
    const expectedScoreAfter = roundScore(fromActor(after, actor));
    const legal = legalMoveCount(move.fenBefore);
    const book = move.ply <= bookPlies;

    decisions.push({
      ply: move.ply,
      actor,
      playedUci: move.uci,
      phase: null,
      expectedScoreBefore,
      expectedScoreAfter,
      criticality: null,
      onlyMove: null,
      deepSearched: false,
      book,
      legalMoveCount: legal,
      bandLogLikelihoods: null,
      reply: null,
    });

    shape.push({
      ply: move.ply,
      liveness: liveness(expectedScoreBefore),
      loss: roundScore(expectedScoreBefore - expectedScoreAfter),
      legal,
      book,
    });
  }

  const deepPlies = selectDeepPlies(shape, budget.deepPositions);
  const policyPlies = selectPolicyPlies(shape, budget.plyPolicyLimit);

  const byPly = new Map(played.map((move) => [move.ply, move]));
  const requests = new Map<string, PolicyRequest>();
  const ask = (fen: string): void => {
    for (const rating of STRENGTH_POLICY.ladder) {
      requests.set(`${fen}|${rating}`, { fen, rating });
    }
  };
  for (const ply of policyPlies) ask(byPly.get(ply)!.fenBefore);
  for (const ply of deepPlies) ask(byPly.get(ply)!.fenAfter);

  return { decisions, deepPlies, policyPlies, policyRequests: [...requests.values()] };
}

// ---------------------------------------------------------------------------
// Step 3: assembly
// ---------------------------------------------------------------------------

/** A MultiPV answer at one position, White's perspective. */
export interface DeepResult {
  before: readonly EngineLine[];
  after: readonly EngineLine[];
}

export type PolicyLookup = (fen: string, rating: number) => PolicyDistribution | undefined;

function otherColor(color: Color): Color {
  return color === "white" ? "black" : "white";
}

/** The rung nearest a rating, and whether that rating was inside the range. */
function nearestRung(rating: number): { rung: number; outOfDomain: boolean } {
  const rung = STRENGTH_POLICY.ladder.reduce((best, candidate) =>
    Math.abs(candidate - rating) < Math.abs(best - rating) ? candidate : best,
  );
  return {
    rung,
    // The ends of the *ladder*, not of the concept model's calibrated slice.
    // Those are different ranges and conflating them published a warning on
    // every strong game: the policy is conditioned up to 2400 and picks its
    // rung from the whole ladder, so a 2200 read is inside the domain, not
    // outside it. What is genuinely unknowable is anything above the top
    // rung, and that is a ceiling to report rather than a caveat to attach.
    outOfDomain: rating < LADDER_FLOOR || rating > LADDER_CEILING,
  };
}

export interface Conditioning {
  /** The rung the opponent model was conditioned on, or null when unknowable. */
  rung: number | null;
  /** True when the source rating sat outside the calibrated range. */
  outOfDomain: boolean;
  /** Whether that rating came from the game or from the strength estimate. */
  declared: boolean;
}

export interface AssembledRating {
  input: GameRatingInput;
  /**
   * What each side's opponent model was conditioned on, and on what basis.
   *
   * Returned rather than kept internal because the page has to be able to say
   * "no rating was declared, so we conditioned on how the game was played".
   * That is a real caveat about the pressure figures, and a reader who is not
   * told it would take an inference for a fact.
   */
  conditioning: Record<Color, Conditioning>;
}

export interface AssembleOptions {
  whiteRating?: number | null;
  blackRating?: number | null;
  canonicalGameId?: string | null;
  budget?: typeof ANALYSIS_BUDGET;
}

/**
 * Everything the workflow gathered, turned into the scorer's input.
 *
 * The two passes of `analyse.ts` survive here as two reads of the same policy
 * lookup: the ladder answers the strength estimate, and the estimate chooses
 * which rung to read at the reply positions. Nothing is inferred twice and
 * nothing is scheduled twice, because the whole ladder was asked for up front.
 */
export function assembleRating(
  moves: readonly ParsedPgnMove[],
  plan: RatingPlan,
  deep: ReadonlyMap<number, DeepResult>,
  policy: PolicyLookup,
  options: AssembleOptions = {},
): AssembledRating {
  const byPly = new Map(moves.map((move) => [move.ply, move]));
  const policyPlies = new Set(plan.policyPlies);

  // --- the ladder, and the strength it implies -----------------------------

  const withLikelihoods = plan.decisions.map((decision) => {
    if (!policyPlies.has(decision.ply)) return decision;
    const move = byPly.get(decision.ply);
    if (!move) return decision;

    const rungs: RungPolicy[] = [];
    for (const rating of STRENGTH_POLICY.ladder) {
      const distribution = policy(move.fenBefore, rating);
      if (!distribution) return decision;
      rungs.push({ rating, policy: distribution });
    }
    const result = likelihoodsFor(decision.playedUci, rungs, decision.legalMoveCount);
    return result.status === "available"
      ? { ...decision, bandLogLikelihoods: result.byRating }
      : decision;
  });

  const estimatedFor = (color: Color): number | null => {
    const estimate = estimateStrength(
      withLikelihoods.filter((decision) => decision.actor === color).map(scoreDecision),
    );
    return estimate.status === "available" ? estimate.rating : null;
  };

  const conditioning: Record<Color, Conditioning> = {
    white: { rung: null, outOfDomain: false, declared: false },
    black: { rung: null, outOfDomain: false, declared: false },
  };
  for (const color of ["white", "black"] as const) {
    const declared = color === "white" ? options.whiteRating : options.blackRating;
    const source = declared ?? estimatedFor(color);
    const nearest = source === null ? null : nearestRung(source);
    conditioning[color] = {
      rung: nearest?.rung ?? null,
      outOfDomain: nearest?.outOfDomain ?? false,
      declared: declared != null,
    };
  }

  // --- the deeper look, and the pressure it prices -------------------------

  const finished = withLikelihoods.map((decision) => {
    const result = deep.get(decision.ply);
    const move = byPly.get(decision.ply);
    if (!result || !move) return decision;

    const candidates = assessCandidates(
      result.before.map((line) => fromActor(line.expectedScoreWhite, decision.actor)),
    );

    const opponent = otherColor(decision.actor);
    const context = conditioning[opponent];
    let reply = null as Decision["reply"];

    if (context.rung !== null && result.after.length >= 2) {
      const valued = result.after.map((line) => ({
        uci: line.uci,
        opponentValue: fromActor(line.expectedScoreWhite, opponent),
        actorValue: fromActor(line.expectedScoreWhite, decision.actor),
      }));
      const best = Math.max(...valued.map((line) => line.opponentValue));
      const adequate = valued.filter((line) => isAcceptableLoss(best - line.opponentValue));
      const inadequate = valued.filter((line) => !isAcceptableLoss(best - line.opponentValue));
      const distribution = policy(move.fenAfter, context.rung);


      if (inadequate.length > 0 && distribution) {
        const adequateUcis = new Set(adequate.map((line) => line.uci));
        let mass = 0;
        for (const candidate of distribution.moves) {
          if (adequateUcis.has(candidate.uci)) mass += candidate.probability;
        }
        reply = {
          adequateReplyProbability: Math.min(1, Math.max(0, mass)),
          unretainedProbabilityMass: distribution.unretainedMass,
          // The opponent's best mistake: the likeliest wrong move is the least
          // wrong one, which is the conservative reading of what a miss costs.
          expectedScoreIfMissed: roundScore(Math.min(...inadequate.map((line) => line.actorValue))),
          outOfDomain: context.outOfDomain,
        };
      }
    }

    return {
      ...decision,
      criticality: candidates.criticality,
      onlyMove: candidates.onlyMove,
      deepSearched: true,
      reply,
    };
  });

  return {
    input: {
      decisions: finished,
      // True because a plan exists at all: the selector ran over screened
      // positions and reported what it chose. Choosing nothing is a finding
      // about the game, not a gap in the analysis, so a dead game gets low
      // demand rather than unknown demand.
      deepPassRan: true,
      canonicalGameId: options.canonicalGameId ?? null,
    },
    conditioning,
  };
}

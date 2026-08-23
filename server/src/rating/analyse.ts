/**
 * Rating a game in one process, by running the three phases back to back.
 *
 * This is not the production path. Production cuts the same computation across
 * two chained workflows, because the engine and the human policy live on
 * different services and a work ledger fixes a workflow's items when the
 * workflow is created (`phases.ts` says more about why).
 *
 * It is still worth having, and worth being the only other implementation. The
 * phases are pure and the ports are narrow, so composing them here gives the
 * tests something to exercise end to end without a database, a queue or a
 * binary, and gives any future synchronous mode somewhere to start. What it
 * must never become is a second version of the logic: everything below is
 * scheduling, and every judgement lives in `phases.ts`.
 */

import type { ParsedPgnMove } from "../ingest/pgn.js";
import type { GameRatingInput } from "./contract.js";
import type { PolicyDistribution } from "../models/policy.js";
import { ANALYSIS_BUDGET, type AnalysisBudget, type EnginePort, type PolicyPort } from "./ports.js";
import {
  assembleRating,
  planRating,
  screeningPositions,
  type AssembledRating,
  type DeepResult,
  type RatingPlan,
} from "./phases.js";

export { ANALYSIS_BUDGET } from "./ports.js";
export type { EngineLine, EnginePort, PolicyPort } from "./ports.js";

export interface AnalyseOptions {
  engine: EnginePort;
  policy: PolicyPort;
  /** Declared ratings, when the PGN or the caller supplied them. */
  whiteRating?: number | null;
  blackRating?: number | null;
  canonicalGameId?: string | null;
  /** Plies inside the opening book, which say nothing about strength. */
  bookPlies?: number;
  budget?: AnalysisBudget;
}

export interface AnalysisCost {
  screeningPositions: number;
  deepPositions: number;
  policyInferences: number;
}

export interface AnalysedGame {
  input: GameRatingInput;
  conditioning: AssembledRating["conditioning"];
  plan: RatingPlan;
  cost: AnalysisCost;
}

export async function analyseGame(
  moves: readonly ParsedPgnMove[],
  options: AnalyseOptions,
): Promise<AnalysedGame> {
  const budget = options.budget ?? ANALYSIS_BUDGET;
  const cost: AnalysisCost = { screeningPositions: 0, deepPositions: 0, policyInferences: 0 };
  const played = moves.slice(0, budget.maxPlies);

  // --- phase one: value every position once --------------------------------

  const screened = new Map<string, number>();
  for (const fen of screeningPositions(played)) {
    const lines = await options.engine.evaluate({ fen, multipv: 1 });
    cost.screeningPositions += 1;
    // An empty answer is a position with no move: the game ended there. Rather
    // than invent a value, leave it out and let `planRating` drop the decision,
    // which is the honest reading of a position nothing was measured about.
    if (lines[0]) screened.set(fen, lines[0].expectedScoreWhite);
  }

  // --- phase two: decide what the deeper look and the policy are spent on ---

  const plan = planRating(played, screened, { bookPlies: options.bookPlies, budget });

  // --- phase three's inputs: the deeper look, and the ladder ----------------

  const byPly = new Map(played.map((move) => [move.ply, move]));
  const deep = new Map<number, DeepResult>();
  for (const ply of plan.deepPlies) {
    const move = byPly.get(ply)!;
    const before = await options.engine.evaluate({ fen: move.fenBefore, multipv: budget.deepMultipv });
    const after = await options.engine.evaluate({ fen: move.fenAfter, multipv: budget.deepMultipv });
    cost.deepPositions += 2;
    deep.set(ply, { before, after });
  }

  const policies = new Map<string, PolicyDistribution>();
  for (const request of plan.policyRequests) {
    policies.set(`${request.fen}|${request.rating}`, await options.policy.policy(request));
    cost.policyInferences += 1;
  }

  const assembled = assembleRating(
    played,
    plan,
    deep,
    (fen, rating) => policies.get(`${fen}|${rating}`),
    {
      whiteRating: options.whiteRating,
      blackRating: options.blackRating,
      canonicalGameId: options.canonicalGameId,
      budget,
    },
  );

  return { input: assembled.input, conditioning: assembled.conditioning, plan, cost };
}

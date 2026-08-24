/**
 * What the game asked.
 *
 * This is the term that makes ten hard to reach, and it is here because
 * "played well" is meaningless without it. A game in which neither side was
 * ever tested cannot be a great game, however few mistakes it contains, because
 * there was nothing in it to get right. Without this term the top of the scale
 * would belong to short quiet draws, which is the failure mode every
 * accuracy-style metric already has.
 *
 * Three sub-terms, kept separate because a game can be demanding in different
 * ways and any one of them alone would be gameable:
 *
 * - **tension**, how much a single decision could swing;
 * - **narrowness**, how often exactly one move held;
 * - **duration**, how long the game stayed undecided at all.
 *
 * The first two read the deep-selected positions, because `criticality` and
 * `onlyMove` exist nowhere else. The third reads every ply, because liveness
 * does.
 *
 * Nothing here reads the result. A game that stayed balanced for sixty moves
 * and was then flagged scores the same demand as one that was won, because the
 * question is what the players were asked, not what they did with it.
 */

import { roundScore } from "../engine/contract.js";
import { DEMAND_POLICY } from "./contract.js";
import type { ScoredDecision } from "./decisions.js";

export interface DemandReading {
  status: "available";
  /** The weighted combination, in [0, 1]. */
  demand: number;
  tension: number;
  narrowness: number;
  duration: number;
  /** Positions the deep pass actually looked at. */
  criticalPositions: number;
  onlyMoves: number;
  /**
   * The counts each term was computed from.
   *
   * A bar reading 1.00 is unreadable on its own — it could mean "as sharp as
   * games get" or "the scale saturates early". Shipping the evidence beside it
   * lets a reader see which, and check the arithmetic if they care.
   */
  liveDecisions: number;
  totalDecisions: number;
  /** Mean point swing across the sharpest positions the tension term read. */
  meanTopCriticality: number;
}

export interface DemandUnavailable {
  status: "unavailable";
  reason: "not_deep_searched";
}

export type Demand = DemandReading | DemandUnavailable;

function saturate(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Read the demand of one game from all of its decisions, both sides together.
 *
 * Demand is a property of the game rather than of a player: both sides sat in
 * the same positions, and a sharp position is sharp for whoever is to move.
 */
export function readDemand(
  decisions: readonly ScoredDecision[],
  deepPassRan: boolean,
): Demand {
  if (!deepPassRan) return { status: "unavailable", reason: "not_deep_searched" };

  const deep = decisions.filter((entry) => entry.decision.deepSearched);

  const criticalities = deep
    .map((entry) => entry.decision.criticality)
    .filter((value): value is number => value !== null)
    .sort((left, right) => right - left)
    .slice(0, DEMAND_POLICY.topCriticalPositions);

  // Averaged over the policy's slot count rather than over what was found, so a
  // game with one sharp moment and nothing else does not read as sharp
  // throughout. The missing slots are genuinely zero tension: the selector
  // looked and there was nothing there.
  const tension = saturate(
    criticalities.reduce((sum, value) => sum + value, 0) /
      (DEMAND_POLICY.topCriticalPositions * DEMAND_POLICY.criticalityAtFull),
  );

  const onlyMoves = deep.filter((entry) => entry.decision.onlyMove === true).length;
  const narrowness = saturate(onlyMoves / DEMAND_POLICY.onlyMovesAtFull);

  const live = decisions.filter(
    (entry) => entry.liveness >= DEMAND_POLICY.liveLivenessThreshold,
  ).length;
  const duration = decisions.length === 0 ? 0 : saturate(live / decisions.length);

  const demand =
    DEMAND_POLICY.weights.tension * tension +
    DEMAND_POLICY.weights.narrowness * narrowness +
    DEMAND_POLICY.weights.duration * duration;

  return {
    status: "available",
    demand: roundScore(demand),
    tension: roundScore(tension),
    narrowness: roundScore(narrowness),
    duration: roundScore(duration),
    criticalPositions: deep.length,
    onlyMoves,
    liveDecisions: live,
    totalDecisions: decisions.length,
    meanTopCriticality: roundScore(
      criticalities.length === 0
        ? 0
        : criticalities.reduce((sum, value) => sum + value, 0) / criticalities.length,
    ),
  };
}

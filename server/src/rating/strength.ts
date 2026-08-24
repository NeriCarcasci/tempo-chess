/**
 * How strong one side's choices looked.
 *
 * This is the term that separates a rating from an accuracy score. Accuracy
 * says a move lost little expected score, which a player can achieve by never
 * being asked anything. A rating-conditioned human policy says something
 * different and more useful: of the players we can model, which strength does
 * this sequence of choices look like?
 *
 * The estimate is a maximum-likelihood one over the rungs of the ladder, and
 * the interval is the profile-likelihood interval around it. Neither is a
 * heuristic. Both fall out of the same log-likelihoods, which is why the
 * interval narrows on its own as a game gets longer instead of being widened by
 * hand for short games.
 *
 * What this does not claim: that the player *is* that strength. One game is one
 * game, and a strong player has bad ones. The claim is about the choices in
 * front of us, which is why the output is named for the game and not the person.
 */

import { LADDER_CEILING, LADDER_FLOOR, STRENGTH_POLICY } from "./contract.js";
import { countsTowardStrength, type ScoredDecision } from "./decisions.js";

export interface StrengthEstimate {
  status: "available";
  /** The maximising rung of the ladder. */
  rating: number;
  /** The rungs within the likelihood drop of the maximum. */
  intervalLow: number;
  intervalHigh: number;
  /** Decisions that carried a likelihood, after book and forced plies. */
  decisionsScored: number;
  /** Decisions the side faced at all, so coverage is readable. */
  decisionsFaced: number;
  /** Mean log-likelihood at the estimate. Comparable across game lengths. */
  meanLogLikelihood: number;
  /**
   * True when the estimate sits outside the range a slice was calibrated for.
   *
   * The number is still published, because a wide answer beats no answer for a
   * master game, but nothing downstream may quote it as calibrated. This is the
   * flag that keeps Forma from claiming a confident 2600.
   */
  outOfDomain: boolean;
}

export interface StrengthUnavailable {
  status: "unavailable";
  reason: "insufficient_decisions" | "indistinguishable";
  decisionsScored: number;
  decisionsFaced: number;
}

export type Strength = StrengthEstimate | StrengthUnavailable;

/**
 * The likelihood estimate over one side's decisions.
 *
 * Rungs the game never scored are absent rather than flat: a rung with no
 * evidence has no likelihood, and giving it zero would make it the maximum.
 * Ties go to the lower rung, because the ladder is a claim about strength and
 * the smaller claim is the one to make when the evidence cannot separate them.
 */
export function estimateStrength(decisions: readonly ScoredDecision[]): Strength {
  const scored = decisions.filter((entry) => countsTowardStrength(entry.decision));
  if (scored.length < STRENGTH_POLICY.minimumDecisions) {
    return {
      status: "unavailable",
      reason: "insufficient_decisions",
      decisionsScored: scored.length,
      decisionsFaced: decisions.length,
    };
  }

  const totals = new Map<number, number>();
  for (const rung of STRENGTH_POLICY.ladder) {
    let total = 0;
    let seen = 0;
    for (const entry of scored) {
      const value = entry.decision.bandLogLikelihoods?.[rung];
      if (value === undefined || !Number.isFinite(value)) continue;
      total += value;
      seen += 1;
    }
    // A rung the game could not score is not a rung with a likelihood of zero.
    // Zero is the best possible log-likelihood, so defaulting would hand the
    // estimate to whichever rung we happened not to compute.
    if (seen === scored.length) totals.set(rung, total);
  }

  if (totals.size === 0) {
    return {
      status: "unavailable",
      reason: "insufficient_decisions",
      decisionsScored: 0,
      decisionsFaced: decisions.length,
    };
  }

  let best = Number.NEGATIVE_INFINITY;
  let rating: number = STRENGTH_POLICY.ladder[0]!;
  for (const rung of STRENGTH_POLICY.ladder) {
    const total = totals.get(rung);
    if (total === undefined) continue;
    if (total > best) {
      best = total;
      rating = rung;
    }
  }

  const inside = [...totals.entries()]
    .filter(([, total]) => best - total <= STRENGTH_POLICY.intervalLogLikelihoodDrop)
    .map(([rung]) => rung)
    .sort((left, right) => left - right);

  // An interval covering the whole ladder is the estimator saying it cannot
  // separate an 800 from a 2400, and a point estimate on top of that is a claim
  // the evidence does not support. Publishing one is how a real run reported
  // Kasparov as an 800 with an interval that quietly spanned everything: a
  // reader takes the number and leaves the band behind.
  if (inside.length === STRENGTH_POLICY.ladder.length) {
    return {
      status: "unavailable",
      reason: "indistinguishable",
      decisionsScored: scored.length,
      decisionsFaced: decisions.length,
    };
  }

  return {
    status: "available",
    rating,
    intervalLow: inside[0]!,
    intervalHigh: inside[inside.length - 1]!,
    decisionsScored: scored.length,
    decisionsFaced: decisions.length,
    meanLogLikelihood: best / scored.length,
    // The ends of the *ladder*, not of the concept model's calibrated slice.
    // Those are different ranges and conflating them published a warning on
    // every strong game: the policy is conditioned up to 2400 and picks its
    // rung from the whole ladder, so a 2200 read is inside the domain, not
    // outside it. What is genuinely unknowable is anything above the top
    // rung, and that is a ceiling to report rather than a caveat to attach.
    outOfDomain: rating < LADDER_FLOOR || rating > LADDER_CEILING,
  };
}

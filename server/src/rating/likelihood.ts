/**
 * Turning policy inferences into the likelihoods the strength estimate reads.
 *
 * One inference per rung of the ladder, at the position the player was looking
 * at, conditioned on that rung. The likelihood of the move they actually chose,
 * under each of those, is the whole evidence base for "whose choices do these
 * look like".
 *
 * The subtlety is the move that is not in the retained set. Forma keeps the top
 * twelve moves of a distribution (`RETAINED_MOVE_LIMIT`) and records the mass it
 * dropped, so a player who chose the thirteenth-most-human move has a
 * probability that is known to be small and not known exactly. That case is not
 * rare — it is most of what a weak player does in front of a strong-rung model,
 * which makes it precisely the case the estimate must handle well rather than
 * around.
 *
 * Three ways to handle it, and the choice matters:
 *
 * 1. Give it the smallest retained probability. An upper bound, so every
 *    unretained move looks likelier than it was, and the estimate drifts toward
 *    whichever rung happened to retain fewer moves.
 * 2. Drop the decision. Loses the most informative plies in the whole game: "no
 *    2200 plays this" is exactly what tells you the player is not 2200.
 * 3. Spread the dropped mass evenly over the moves that were dropped, which
 *    needs the legal move count and gives a real number.
 *
 * The third is what this does, and the assumption is stated rather than buried:
 * the tail is treated as flat. It is wrong in detail — the thirteenth move is
 * likelier than the fortieth — but it is unbiased between rungs, which is the
 * property the comparison actually needs.
 */

import type { PolicyDistribution } from "../models/policy.js";

/** One rung's answer about one position. */
export interface RungPolicy {
  rating: number;
  policy: PolicyDistribution;
}

export interface Likelihoods {
  status: "available";
  /** `ln P(played | rating)`, complete across every rung asked. */
  byRating: Record<number, number>;
  /**
   * Rungs where the played move sat in the unretained tail, so its probability
   * came from the flat-tail assumption rather than from the model directly.
   *
   * Carried out so a caller can report how much of the estimate rests on it.
   * An estimate built entirely from tail assignments is a weaker claim than one
   * built from retained probabilities, even though both are numbers.
   */
  estimatedRungs: readonly number[];
}

export const LIKELIHOOD_REFUSALS = [
  "no_policies",
  "empty_distribution",
  "unretained_without_legal_move_count",
  "unretained_with_no_room",
] as const;
export type LikelihoodRefusal = (typeof LIKELIHOOD_REFUSALS)[number];

export interface LikelihoodsUnavailable {
  status: "unavailable";
  reason: LikelihoodRefusal;
  /** The rung that could not be answered, when one is to blame. */
  rating: number | null;
}

export type LikelihoodResult = Likelihoods | LikelihoodsUnavailable;

/**
 * The likelihood of one played move across the ladder.
 *
 * All or nothing on purpose. A decision scored on eight rungs and not the
 * ninth cannot be compared across the ladder, and the estimator's own rule is
 * that a rung missing from any ply is dropped from the estimate entirely — so
 * a partial answer here would silently delete a rung from the whole game
 * rather than one ply from the sample. Refusing the decision costs one ply and
 * keeps the ladder intact.
 */
export function likelihoodsFor(
  playedUci: string,
  rungs: readonly RungPolicy[],
  legalMoveCount: number | null,
): LikelihoodResult {
  if (rungs.length === 0) return { status: "unavailable", reason: "no_policies", rating: null };

  const byRating: Record<number, number> = {};
  const estimatedRungs: number[] = [];

  for (const rung of rungs) {
    // A distribution with no moves in it is not a distribution. Left to the
    // tail rule below it would hand every rung the same probability, and every
    // rung agreeing is exactly what the estimator reads as "no evidence either
    // way" — except it would read it as evidence, and publish the first rung on
    // the ladder as the answer. A real run against a game with no policy
    // configured reported Kasparov as an 800 that way.
    if (rung.policy.moves.length === 0) {
      return { status: "unavailable", reason: "empty_distribution", rating: rung.rating };
    }
    const retained = rung.policy.moves.find((move) => move.uci === playedUci);
    if (retained && retained.probability > 0) {
      byRating[rung.rating] = Math.log(retained.probability);
      continue;
    }

    // The move is in the tail, or was retained at a probability of zero, which
    // for this purpose is the same thing: the model did not put mass on it and
    // the log of nothing is not a number the estimate can carry.
    if (legalMoveCount === null) {
      return {
        status: "unavailable",
        reason: "unretained_without_legal_move_count",
        rating: rung.rating,
      };
    }
    const dropped = legalMoveCount - rung.policy.moves.length;
    if (dropped <= 0 || rung.policy.unretainedMass <= 0) {
      // The distribution says it covered every legal move, and this one is not
      // in it. Something upstream is inconsistent — a policy from a different
      // position, or a move list that does not match the board — and inventing
      // a probability here would launder that into a strength claim.
      return { status: "unavailable", reason: "unretained_with_no_room", rating: rung.rating };
    }

    byRating[rung.rating] = Math.log(rung.policy.unretainedMass / dropped);
    estimatedRungs.push(rung.rating);
  }

  return { status: "available", byRating, estimatedRungs };
}

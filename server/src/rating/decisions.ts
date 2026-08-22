/**
 * The two readings of one decision, and the difference between them.
 *
 * The objective reading is what the assessments table already holds: expected
 * score before the move minus expected score after it, where "after" assumes
 * the opponent replies best. It is the truth about the position and it is the
 * wrong question to ask about a sacrifice, because the person who had to answer
 * the sacrifice was not Stockfish.
 *
 * The practical reading asks the right one. It weights the opponent's replies
 * by what a human of that opponent's strength is actually likely to play, and
 * takes the expectation over what follows. A move that objectively gives away a
 * tenth of a point, into a position where nine tenths of the human policy mass
 * loses on the spot, gains under this reading. That is Tal, and it is also why
 * the same measure still convicts hope chess: when the refutation is the
 * natural move, the mass sits on it and the objective loss stands.
 *
 * Both readings are kept. The gap between them is the interesting quantity and
 * it is published as `pressure` rather than folded away.
 */

import { roundScore } from "../engine/contract.js";
import type { Decision, ReplyEvidence } from "./contract.js";

/**
 * How much of the game is still in the position, from the expected score.
 *
 * `4e(1-e)`: 1 at a balanced position, 0 at a decided one, symmetric about a
 * half. This is what weights the cleanliness term, and it is used instead of
 * `criticality` because criticality is null everywhere the search retained one
 * line — which is every ply except the twelve the deep selector picks.
 *
 * It is a stated formula over a number that always exists, not an estimate. The
 * claim it makes is narrow and defensible: a mistake at 0.5 costs more of the
 * game than the same mistake at 0.97.
 */
export function liveness(expectedScore: number): number {
  const clamped = Math.min(1, Math.max(0, expectedScore));
  return roundScore(4 * clamped * (1 - clamped));
}

export const PRACTICAL_WITHHELD_REASONS = [
  "no_reply_evidence",
  "no_inadequate_reply_retained",
  "empty_policy",
  "evidence_inconsistent",
] as const;
export type PracticalWithheldReason = (typeof PRACTICAL_WITHHELD_REASONS)[number];

export interface PracticalReading {
  status: "available";
  /**
   * Actor-perspective expected score of the position the move created, over the
   * replies the opponent is likely to choose rather than the one they should.
   */
  expectedScore: number;
  /** Bounds from the policy mass the model did not retain. */
  expectedScoreLow: number;
  expectedScoreHigh: number;
  /**
   * `expectedScore` less the objective `expectedScoreAfter`: what the move is
   * worth beyond what it is worth. Never negative, by construction.
   */
  pressure: number;
  /**
   * The point estimate of the opponent finding a reply that holds.
   *
   * The unretained mass is assumed to split like the retained mass, which is a
   * stated assumption and the reason the bounds are published beside it.
   */
  saveProbability: number;
  /** All unretained mass assumed to miss. */
  saveProbabilityLow: number;
  /** All unretained mass assumed to save. */
  saveProbabilityHigh: number;
  outOfDomain: boolean;
}

export interface PracticalWithheld {
  status: "withheld";
  reason: PracticalWithheldReason;
}

export type Practical = PracticalReading | PracticalWithheld;

/**
 * Read the pressure a move created, or say why it cannot be read.
 *
 * The refusals are ordered the way the reasons stop being true. No evidence at
 * all comes first; a policy with no mass cannot be asked anything; a search
 * that retained no inadequate reply never saw the mistake whose cost the whole
 * calculation turns on.
 *
 * The last refusal is the subtle one. `expectedScoreAfter` comes from the
 * screening pair and `expectedScoreIfMissed` comes from the deeper MultiPV at
 * the same position, so the two can disagree about which reply is better when
 * the position is beyond screening depth. When they do, the difference being
 * measured is the gap between two searches rather than the gap between two
 * outcomes, and publishing it as pressure would credit a player for our own
 * budget. Withheld, and the objective reading stands.
 */
export function readPractical(decision: Decision): Practical {
  const reply: ReplyEvidence | null = decision.reply;
  if (reply === null) return { status: "withheld", reason: "no_reply_evidence" };
  if (reply.policy.moves.length === 0 || reply.policy.retainedMass <= 0) {
    return { status: "withheld", reason: "empty_policy" };
  }
  if (reply.expectedScoreIfMissed === null) {
    return { status: "withheld", reason: "no_inadequate_reply_retained" };
  }

  const holds = decision.expectedScoreAfter;
  const misses = reply.expectedScoreIfMissed;
  if (misses < holds) return { status: "withheld", reason: "evidence_inconsistent" };

  const adequate = new Set(reply.adequateReplies);
  let retainedSaveMass = 0;
  for (const move of reply.policy.moves) {
    if (adequate.has(move.uci)) retainedSaveMass += move.probability;
  }
  retainedSaveMass = Math.min(reply.policy.retainedMass, Math.max(0, retainedSaveMass));

  const saveProbability = Math.min(1, retainedSaveMass / reply.policy.retainedMass);
  const saveProbabilityLow = Math.min(1, Math.max(0, retainedSaveMass));
  const saveProbabilityHigh = Math.min(1, retainedSaveMass + reply.policy.unretainedMass);

  // Decreasing in the save probability, because a save is the worst case for
  // the side that created the problem. So the low bound on saves gives the high
  // bound on the score, and the other way round.
  const at = (save: number): number => roundScore(save * holds + (1 - save) * misses);

  const expectedScore = at(saveProbability);
  return {
    status: "available",
    expectedScore,
    expectedScoreLow: at(saveProbabilityHigh),
    expectedScoreHigh: at(saveProbabilityLow),
    pressure: roundScore(expectedScore - holds),
    saveProbability: roundScore(saveProbability),
    saveProbabilityLow: roundScore(saveProbabilityLow),
    saveProbabilityHigh: roundScore(saveProbabilityHigh),
    outOfDomain: reply.outOfDomain,
  };
}

export interface ScoredDecision {
  decision: Decision;
  /** Expected score given away against best play. Negative when the search gained. */
  objectiveLoss: number;
  practical: Practical;
  /** The objective loss less any pressure the move created. */
  effectiveLoss: number;
  /**
   * What cleanliness is charged for: the effective loss, floored at zero.
   *
   * A move that gains is not credited, only left uncharged. Credit would let a
   * single sacrifice carry a careless game, and the gain is already published
   * as `pressure` and surfaced as a moment, which is where it belongs.
   */
  chargedLoss: number;
  /** How much of the game was still in the position before the move. */
  liveness: number;
}

export function scoreDecision(decision: Decision): ScoredDecision {
  const objectiveLoss = roundScore(decision.expectedScoreBefore - decision.expectedScoreAfter);
  const practical = readPractical(decision);
  const effectiveLoss =
    practical.status === "available"
      ? roundScore(objectiveLoss - practical.pressure)
      : objectiveLoss;
  return {
    decision,
    objectiveLoss,
    practical,
    effectiveLoss,
    chargedLoss: Math.max(0, effectiveLoss),
    liveness: liveness(decision.expectedScoreBefore),
  };
}

/**
 * Whether this decision says anything about how strong the player is.
 *
 * A book move is somebody else's idea and a position with one legal move is not
 * a decision. Both are excluded for the reason `estimator.ts` excludes censored
 * evidence: counting them inflates every player by the same amount, which makes
 * the number useless for exactly the comparison it exists to support.
 *
 * A null `legalMoveCount` is not treated as forced. The honest reading of "we
 * did not count the legal moves" is that this was probably a real decision, and
 * dropping it would silently shrink the sample.
 */
export function countsTowardStrength(decision: Decision): boolean {
  if (decision.book) return false;
  if (decision.legalMoveCount !== null && decision.legalMoveCount <= 1) return false;
  return decision.bandLogLikelihoods !== null;
}

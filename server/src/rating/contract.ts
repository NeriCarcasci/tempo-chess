/**
 * The game-rating contract: what the 0–10 is made of, and what it may claim.
 *
 * Same discipline as `engine/contract.ts` and `models/contract.ts`. Every
 * constant here is policy rather than a tuning knob: the numbers are hashed
 * into a method version, so moving one produces a new version rather than
 * quietly restating every rating ever published. A game rated 7.4 under
 * `game_rating/1` stays rated 7.4 under `game_rating/1` forever.
 *
 * What the rating claims: given the decisions both players faced, how strong
 * their choices looked against a rating-conditioned human policy, how much
 * expected score they gave away weighted by whether anything was at stake, and
 * how much the game asked of them.
 *
 * What it does not claim: that the better player won, that the game was
 * entertaining, or that a 7.4 and a 7.5 are distinguishable. The interval is
 * published for that last reason and should be read before the point.
 *
 * The rating is deliberately *not* a function of the result. A game decided by
 * a flag fall is rated on the moves that were played, and a sacrifice is rated
 * on the problem it posed rather than on whether it worked. Conditioning on the
 * outcome would be results-oriented thinking with a version number on it.
 */

import { createHash } from "node:crypto";

import { canonicalJson } from "../v1/canonical-json.js";
import { CONTINUATION_RATINGS } from "../models/continuation-rating.js";
import type { PolicyDistribution } from "../models/policy.js";
import type { GamePhase } from "../analysis/phase.js";

/** Lowercase hex SHA-256, as everywhere else. */
export const HASH_SHAPE = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * The likelihood estimate of how strong a side's choices looked.
 *
 * The ladder is `CONTINUATION_RATINGS` rather than a new list, because a rung
 * only exists here if a human policy can be conditioned on it. Inventing a
 * finer ladder would publish a precision the model cannot support.
 *
 * `intervalLogLikelihoodDrop` is half the 95% chi-square point on one degree of
 * freedom. Rungs within that of the maximum are inside the interval, which is
 * the textbook profile-likelihood interval and not a spread we chose for how it
 * looked. It narrows on its own as a game gets longer, which is the behaviour a
 * per-game number needs: a fifteen-move miniature should publish a wide band.
 */
export const STRENGTH_POLICY = {
  version: "1",
  ladder: CONTINUATION_RATINGS,
  intervalLogLikelihoodDrop: 1.920729,
  /**
   * Fewest scored decisions before a band is published at all.
   *
   * Below this the maximum wanders across the whole ladder and the interval
   * covers it, so the honest output is `unavailable` rather than a number with
   * an apology attached.
   */
  minimumDecisions: 8,
} as const;

/**
 * How much expected score a side gave away, weighted by whether the position
 * still had anything in it.
 *
 * Liveness is `4e(1-e)` on the expected score before the move: 1 at a balanced
 * position, 0 at a decided one. It is used instead of `criticality` because
 * criticality is null wherever the search retained one line, which is every ply
 * outside the twelve the deep selector picks. Liveness is computable at every
 * ply from a number that is always there, and it encodes the part that matters
 * here: an error in a game that was already over is not an error anyone should
 * be charged for.
 *
 * `livenessFloor` drops plies below it out of the weighting entirely. A player
 * shuffling in a dead-won position is not being measured, and letting those
 * plies carry weight would let a long trivial conversion wash out a real
 * middlegame error.
 */
export const CLEANLINESS_POLICY = {
  version: "1",
  livenessFloor: 0.05,
  /**
   * The weighted loss that scores zero cleanliness.
   *
   * A tenth of a point of expected score, given away on average across a live
   * game, is a thoroughly bad game. Above it the term is clamped rather than
   * continuing down, because the difference between very bad and much worse is
   * not a difference the rating needs to resolve.
   */
  lossAtZero: 0.1,
} as const;

/**
 * What the game asked.
 *
 * Every input here comes from the deep-selected positions, because criticality
 * and only-move exist nowhere else. That is the right sample anyway: those
 * twelve are the positions the selector already judged to be where the game was
 * decided.
 *
 * The three terms are separated because a game can be demanding in different
 * ways and a single one would be gameable. `tension` is how much a decision
 * could swing, `narrowness` is how often exactly one move held, and `duration`
 * is how long the game stayed undecided at all. A pre-arranged draw scores zero
 * on all three, which is the point.
 */
export const DEMAND_POLICY = {
  version: "1",
  /** How many of the sharpest positions the tension term reads. */
  topCriticalPositions: 6,
  /** The criticality that counts as fully tense: half a point on one decision. */
  criticalityAtFull: 0.5,
  /** Only-moves in one game that count as fully narrow. */
  onlyMovesAtFull: 4,
  /** Liveness above which a ply counts as part of a live game. */
  liveLivenessThreshold: 0.25,
  weights: { tension: 0.45, narrowness: 0.3, duration: 0.25 },
} as const;

/**
 * How the parts become one number.
 *
 * `strengthFloor` and `strengthCeiling` are the ends of the ladder, so a side
 * normalizes to 1 only when its choices looked like the strongest rung a human
 * policy can be conditioned on. That rung is already above
 * `CALIBRATED_RATING_CEILING`, which is the honest reason the top of this scale
 * is hard to reach: the measurement itself runs out before the scale does.
 *
 * `softMinLambda` is the sharpness of the log-sum-exp minimum. It is the
 * constant that makes "one incredible player and one bad player" a low rating
 * rather than a middling one, and it is a soft minimum rather than a hard one
 * so that two nearly equal sides are not decided by measurement noise on one of
 * them.
 *
 * `demandFloor` is why a flawless sterile game caps mid-scale. A game where
 * nothing was ever asked keeps 55% of its quality, and the remaining 45% has to
 * be earned by the game having had something in it.
 */
export const COMBINATION_POLICY = {
  version: "1",
  strengthFloor: 800,
  strengthCeiling: 2400,
  strengthWeight: 0.6,
  cleanlinessWeight: 0.4,
  softMinLambda: 6,
  qualityExponent: 1.4,
  demandFloor: 0.55,
  demandExponent: 1,
  scaleMax: 10,
} as const;

/**
 * Fewest decisions in the whole game before any rating is published.
 *
 * A ten-ply game is not a game that can be rated, however clean it was. The
 * refusal is the product: `unavailable` with a reason beats a confident 8.2
 * derived from six moves of theory.
 */
export const COVERAGE_POLICY = {
  version: "1",
  minimumDecisions: 20,
} as const;

/**
 * When a decision is worth naming beside the number.
 *
 * The rating is not allowed to ship alone, so the moments are part of the
 * contract rather than a renderer's garnish. Three is the cap because a list of
 * ten highlights is a move list, and the job here is to say what moved the
 * number.
 *
 * The thresholds are in expected score, the same unit as everything else.
 */
export const MOMENT_POLICY = {
  version: "1",
  maxMoments: 3,
  /** Pressure worth calling pressure: the move the engine dislikes and nobody refutes. */
  pressureAtNotable: 0.08,
  /** A live position handed back. */
  returnedAtNotable: 0.1,
  /** Enough given away in one move to decide the game. */
  collapseAt: 0.25,
} as const;

/** The method's identity. Everything above is hashed into it. */
export const RATING_METHOD = {
  key: "game_rating",
  version: "1",
} as const;

export function ratingMethodHash(): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        method: RATING_METHOD,
        strength: STRENGTH_POLICY,
        cleanliness: CLEANLINESS_POLICY,
        demand: DEMAND_POLICY,
        combination: COMBINATION_POLICY,
        coverage: COVERAGE_POLICY,
        moments: MOMENT_POLICY,
      }),
      "utf8",
    )
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export type Color = "white" | "black";

/**
 * What the opponent could do with the position a move created.
 *
 * This is the whole practical correction, and it needs exactly two things the
 * screening pass does not produce: a MultiPV search at the position *after* the
 * move, and a human-policy inference there conditioned on the opponent.
 *
 * Supplied per decision and nullable, because it will only ever exist for the
 * deep-selected positions. A game with none of it still rates; it rates on the
 * objective reading and says so in its coverage.
 */
export interface ReplyEvidence {
  /**
   * Replies within `TOLERANCE_RULE` of the best reply, in UCI.
   *
   * The opponent's saves. Empty means the search found no adequate reply, which
   * is a real and dramatic finding: the move left nothing that holds.
   */
  adequateReplies: readonly string[];
  /**
   * Actor-perspective expected score after the best retained reply that is
   * *outside* tolerance: what the actor gets when the opponent goes wrong.
   *
   * Null when every retained reply was adequate. That is not zero pressure to
   * be filled in with a default, it is a search that never saw a mistake, and
   * the practical claim is withheld for that decision.
   */
  expectedScoreIfMissed: number | null;
  /** The opponent's policy over replies, conditioned on the opponent. */
  policy: PolicyDistribution;
  /**
   * True when the policy answered outside its calibrated slice.
   *
   * The reading is still computed, because a wide answer beats no answer for a
   * master game, but it is carried through to the output so nothing downstream
   * can quote it as calibrated. This is the flag that stops Forma publishing a
   * confident practical number about a 2700.
   */
  outOfDomain: boolean;
}

/**
 * One decision, as the rating needs it.
 *
 * Deliberately not a database row. The pipeline and the public path assemble
 * this from `transition_assessments` plus the two extra reads above, and the
 * corpus assembles it from a fixture, so the scorer can be exercised with no
 * database at all.
 */
export interface Decision {
  ply: number;
  actor: Color;
  playedUci: string;
  phase: GamePhase | null;

  /** Actor-perspective expected score before the move. */
  expectedScoreBefore: number;
  /** Actor-perspective expected score after it, assuming the best reply. */
  expectedScoreAfter: number;

  /** From `assessCandidates`; null wherever the search retained one line. */
  criticality: number | null;
  onlyMove: boolean | null;
  /** True when the position was deep-searched, so demand may read it. */
  deepSearched: boolean;

  /** True for plies inside the opening book. Excluded from strength. */
  book: boolean;
  /**
   * Legal moves in the position. A position with one is not a decision, and
   * counting it as one inflates every player equally.
   */
  legalMoveCount: number | null;

  /**
   * `ln P(played | rating)` for each rung of the ladder.
   *
   * Null where no inference was made, which is expected: nine inferences a ply
   * is affordable for one pasted game and not for a whole archive. Coverage
   * reports how much of the game the estimate actually saw.
   */
  bandLogLikelihoods: Readonly<Record<number, number>> | null;

  /** The practical reading's inputs, when they were computed. */
  reply: ReplyEvidence | null;
}

export interface GameRatingInput {
  decisions: readonly Decision[];
  /**
   * Whether the deep pass ran on this game at all.
   *
   * This is the difference between "nothing was at stake" and "we did not
   * look", and it cannot be inferred from the decisions: a genuinely quiet game
   * and an unanalysed one both arrive with no criticality anywhere. The
   * selector is capped at twelve positions but is always *asked*, so once it
   * has run, a small selection is a fact about the game and demand is low
   * rather than unknown.
   */
  deepPassRan: boolean;
  /** Carried through to the output so a rating can be attributed to a game. */
  canonicalGameId: string | null;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export const UNAVAILABLE_REASONS = [
  "too_few_decisions",
  "no_live_positions",
  "not_deep_searched",
  "no_inference",
] as const;
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

/**
 * Why one decision is worth naming in the summary.
 *
 * These are the codes; the prose is a renderer's problem and a later version's.
 * They are outcome-free by construction: `only_move_found` says the player
 * found the move that held, not that they went on to win.
 */
export const MOMENT_CODES = [
  "only_move_found",
  "only_move_missed",
  "pressure_created",
  "advantage_returned",
  "collapse",
] as const;
export type MomentCode = (typeof MOMENT_CODES)[number];

export interface Moment {
  code: MomentCode;
  ply: number;
  actor: Color;
  playedUci: string;
  /** The quantity that earned the mention, in expected score. */
  magnitude: number;
}

export function isUnavailableReason(value: string): value is UnavailableReason {
  return (UNAVAILABLE_REASONS as readonly string[]).includes(value);
}

export function isMomentCode(value: string): value is MomentCode {
  return (MOMENT_CODES as readonly string[]).includes(value);
}

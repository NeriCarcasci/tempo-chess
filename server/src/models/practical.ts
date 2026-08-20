import {
  PRESSURE_METHOD,
  ratingBandFor,
  sliceKeyString,
  type CalibrationSliceKey,
  type Provider,
  type Speed,
  type UnavailableReason,
} from "./contract.js";
import type { InferenceContext, PolicyDistribution } from "./policy.js";

/**
 * Practical counterplay: how hard the position Forma just created is for the
 * *opponent*, given who the opponent actually is.
 *
 * The position under discussion is the one after the subject's move, and the
 * human being modelled is the side to move there. Stockfish supplies the
 * adequate reply set; the human model supplies how likely a player of that
 * strength is to find one. Neither is allowed to stand in for the other, and
 * where the human model has nothing calibrated to say, the answer is
 * `unavailable` rather than a Stockfish number wearing a human label.
 */

/** A supported slice, as the calibration table recorded it. */
export interface SupportedSlice {
  id: string;
  provider: Provider;
  speed: Speed;
  ratingBandLow: number;
  ratingBandHigh: number;
  supported: boolean;
  modelComponentVersionId: string;
}

export interface PracticalContextInput {
  /** Null when no human model is promoted at all. */
  promotedModelComponentVersionId: string | null;
  /** The slice lookup result: undefined means the slice was never calibrated. */
  slice: SupportedSlice | undefined;
  /** The opponent's declared context, as it will be stored on the inference. */
  context: InferenceContext;
  /** Fields the model's contract declares it uses. */
  requiredContextFields: readonly (keyof InferenceContext)[];
  /**
   * Adequate replies from the objective engine, under the tolerance rule.
   * Undefined when the search returned one line and therefore never looked at
   * an alternative: "how many replies were adequate" has no answer then, and
   * inventing one is how a screening result gets quoted as a deep one.
   */
  adequateReplies: readonly string[] | undefined;
  /** The objectively best reply, when the engine reported candidates. */
  bestReplyUci: string | undefined;
  /** The human policy over replies, or null when inference failed. */
  policy: PolicyDistribution | null;
}

export interface PracticalVector {
  status: "available";
  sliceId: string;
  pressureMethod: typeof PRESSURE_METHOD;
  adequateReplyCount: number;
  /** Retained mass sitting on adequate replies. A lower bound on the truth. */
  adequateReplyProbability: number;
  unretainedProbabilityMass: number;
  policyEntropyBits: number;
  entropyIsLowerBound: boolean;
  bestRefutationUci: string | null;
  bestRefutationProbability: number | null;
  bestRefutationRank: number | null;
  /**
   * `1 - adequateReplyProbability`: the pressure if every unretained move is a
   * bad one.
   */
  practicalPressureUpper: number;
  /** The pressure if every unretained move is an adequate one. */
  practicalPressureLower: number;
  outOfDomain: boolean;
}

export interface PracticalUnavailable {
  status: "unavailable";
  reason: UnavailableReason;
}

export type PracticalContext = PracticalVector | PracticalUnavailable;

/**
 * Decide whether a human claim may be made here, and if so, what it is.
 *
 * The order of the refusals is the order in which the reasons stop being true:
 * with no promoted model nothing else is even askable, an uncalibrated slice
 * cannot be rescued by a complete context, and a complete context cannot be
 * rescued by a successful inference.
 */
export function buildPracticalContext(input: PracticalContextInput): PracticalContext {
  if (input.promotedModelComponentVersionId === null) {
    return { status: "unavailable", reason: "no_promoted_model" };
  }
  if (input.slice === undefined) {
    return { status: "unavailable", reason: "slice_not_calibrated" };
  }
  if (!input.slice.supported) {
    return { status: "unavailable", reason: "slice_unsupported" };
  }
  if (input.slice.modelComponentVersionId !== input.promotedModelComponentVersionId) {
    // The calibration on file describes a different model than the one that
    // would answer. That is not a supported slice for this model, whatever the
    // row says.
    return { status: "unavailable", reason: "slice_not_calibrated" };
  }
  const missing = input.requiredContextFields.filter((field) => input.context[field] === null);
  if (missing.length > 0) {
    return { status: "unavailable", reason: "context_incomplete" };
  }
  if (input.adequateReplies === undefined || input.bestReplyUci === undefined) {
    return { status: "unavailable", reason: "objective_candidates_missing" };
  }
  if (input.policy === null) {
    return { status: "unavailable", reason: "inference_failed" };
  }

  const adequate = new Set(input.adequateReplies);
  const policy = input.policy;

  let adequateReplyProbability = 0;
  for (const move of policy.moves) {
    if (adequate.has(move.uci)) adequateReplyProbability += move.probability;
  }
  // Clamp before it reaches a numeric(9,8) column: summing a dozen floats can
  // land an ulp above 1.
  adequateReplyProbability = Math.min(1, Math.max(0, adequateReplyProbability));

  const best = policy.moves.find((move) => move.uci === input.bestReplyUci);

  const outOfDomain = isOutOfDomain(input.context, input.slice);

  return {
    status: "available",
    sliceId: input.slice.id,
    pressureMethod: PRESSURE_METHOD,
    adequateReplyCount: adequate.size,
    adequateReplyProbability,
    unretainedProbabilityMass: policy.unretainedMass,
    policyEntropyBits: policy.entropyBits,
    entropyIsLowerBound: policy.entropyIsLowerBound,
    // A best reply the model did not retain is a real answer: it means the
    // move is outside the opponent's top moves, which is exactly the finding.
    // Reporting rank null with probability null says "not in the retained set",
    // and the unretained mass bounds how wrong that can be.
    bestRefutationUci: best ? best.uci : null,
    bestRefutationProbability: best ? best.probability : null,
    bestRefutationRank: best ? best.rank : null,
    practicalPressureUpper: 1 - adequateReplyProbability,
    practicalPressureLower: Math.max(
      0,
      1 - adequateReplyProbability - policy.unretainedMass,
    ),
    outOfDomain,
  };
}

/**
 * Whether the position sits outside what the slice was calibrated on.
 *
 * Deliberately narrow. It is true when the rating that conditions the answer
 * falls outside the band the slice measured — which happens when a rating moves
 * between the assessment and the calibration lookup, or when a caller resolves
 * a slice by provider and speed alone. It is not a synonym for "we are unsure";
 * uncertainty is carried by the pressure interval, not by this flag.
 */
export function isOutOfDomain(context: InferenceContext, slice: SupportedSlice): boolean {
  if (context.actorRating === null) return true;
  return (
    context.actorRating < slice.ratingBandLow || context.actorRating >= slice.ratingBandHigh
  );
}

/**
 * The slice a context belongs to, or null when the rating is outside the
 * calibrated range entirely.
 */
export function sliceKeyFor(context: InferenceContext): CalibrationSliceKey | null {
  if (context.provider === null || context.speed === null || context.actorRating === null) {
    return null;
  }
  const band = ratingBandFor(context.actorRating);
  if (band === null) return null;
  return { provider: context.provider, speed: context.speed, band };
}

export { sliceKeyString };

/**
 * Whether the opponent conceded, and whether the subject used it.
 *
 * Separate evidence (platform spec 12.2). An opponent's later failure does not
 * make an objectively bad move brilliant in retrospect, so this is computed
 * from what happened next and stored beside the prediction rather than folded
 * into it.
 *
 * Both are null when the game ended: there was no next decision, so "did they
 * find the adequate reply" has no answer, and false would read as "they failed".
 */
export function observeConcession(next: {
  replyPlayed: boolean;
  replyWasAdequate: boolean | null;
  subjectExpectedScoreBefore: number | null;
  subjectExpectedScoreAfter: number | null;
}): { opponentConceded: boolean | null; subjectCapitalized: boolean | null } {
  if (!next.replyPlayed || next.replyWasAdequate === null) {
    return { opponentConceded: null, subjectCapitalized: null };
  }
  const opponentConceded = !next.replyWasAdequate;
  if (
    !opponentConceded ||
    next.subjectExpectedScoreBefore === null ||
    next.subjectExpectedScoreAfter === null
  ) {
    return { opponentConceded, subjectCapitalized: null };
  }
  return {
    opponentConceded,
    subjectCapitalized: next.subjectExpectedScoreAfter >= next.subjectExpectedScoreBefore,
  };
}

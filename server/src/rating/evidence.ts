/**
 * The seam between the published review and the rating.
 *
 * `rateGame` takes an explicit input shape rather than database rows so it can
 * be exercised offline, and this is the adapter that keeps that decision from
 * costing anything: it turns the review Forma already reads
 * (`engine/review.ts`) into that shape, so the rating is computed from exactly
 * the evidence the review screen displays. A second query over the same tables
 * would eventually disagree with the first, and then two screens would be
 * telling a player different things about one move.
 *
 * Two quantities the review does not carry have to be supplied beside it, and
 * both are genuinely new work rather than fields somebody forgot:
 *
 * - **`bandLogLikelihoods`**, one policy inference per rung of the ladder. E14
 *   stores a single inference conditioned on the opponent, which is what
 *   practical context needs; the strength estimate needs the *actor's* move
 *   scored under every rung, which is a different question and a different set
 *   of calls.
 * - **`expectedScoreIfMissed`**, a MultiPV search at the position the move
 *   created. `practical_context_assessments` already records how likely the
 *   opponent is to hold, but nothing records what it costs them when they do
 *   not, and the pressure calculation turns on that number.
 *
 * Where a supplement is missing the decision still arrives, carrying nulls. The
 * rating then reports lower coverage or refuses outright, which is the intended
 * behaviour: a game we have not paid for is not a game we get to rate.
 */

import type { ReviewMove } from "../engine/review.js";
import type { GamePhase } from "../analysis/phase.js";
import type { Decision, GameRatingInput, ReplyEvidence } from "./contract.js";

const PHASES: readonly string[] = ["opening", "middlegame", "endgame"];

function toPhase(value: string | null): GamePhase | null {
  return value !== null && PHASES.includes(value) ? (value as GamePhase) : null;
}

/**
 * What the review cannot say about one ply.
 *
 * Every field is optional and every default is the cautious one. In particular
 * `book` defaults to false and `legalMoveCount` to null, so an unsupplied ply
 * counts as a real decision: dropping plies we simply failed to annotate would
 * shrink the sample silently, which is worse than counting one recapture.
 */
export interface DecisionSupplement {
  book?: boolean;
  legalMoveCount?: number | null;
  /** `ln P(played | rating)` per rung, from inferences conditioned on the actor. */
  bandLogLikelihoods?: Readonly<Record<number, number>> | null;
  /** Actor-perspective value after the best retained reply outside tolerance. */
  expectedScoreIfMissed?: number | null;
}

/**
 * Build the reply evidence for one ply, or say there is none.
 *
 * Both halves are required. The stored practical context without the MultiPV
 * read gives a save probability and no idea what a miss is worth; the MultiPV
 * read without the context gives a cost and no idea how likely it is. Either
 * alone would have to be completed with an assumption, and an assumption
 * presented as a measurement is the thing this module exists not to do.
 */
function replyFrom(
  move: ReviewMove,
  supplement: DecisionSupplement | undefined,
): ReplyEvidence | null {
  const context = move.practicalContext;
  if (context.status !== "available") return null;
  const ifMissed = supplement?.expectedScoreIfMissed;
  if (ifMissed === undefined || ifMissed === null) return null;

  return {
    adequateReplyProbability: context.adequateReplyProbability,
    unretainedProbabilityMass: context.unretainedProbabilityMass,
    expectedScoreIfMissed: ifMissed,
    outOfDomain: context.outOfDomain,
  };
}

export interface FromReviewOptions {
  canonicalGameId: string | null;
  /**
   * Whether the deep pass ran, which the review reports for the whole game
   * rather than per ply. `sections.criticalMoments === "published"` is the
   * honest reading of it: the selector ran and published what it chose.
   */
  deepPassRan: boolean;
  supplements?: ReadonlyMap<number, DecisionSupplement>;
}

/**
 * Turn one published review into the rating's input.
 *
 * `deepSearched` is read from the transition's own deep status rather than from
 * whether criticality happens to be non-null, because those answer different
 * questions: a completed deep search that found a dead position reports a
 * criticality of zero, and treating that as "not searched" would let a quiet
 * game claim its demand was unknown.
 */
export function decisionsFromReview(
  moves: readonly ReviewMove[],
  options: FromReviewOptions,
): GameRatingInput {
  const supplements = options.supplements ?? new Map<number, DecisionSupplement>();

  const decisions: Decision[] = moves.map((move) => {
    const supplement = supplements.get(move.fromPly);
    return {
      ply: move.fromPly,
      actor: move.actorColor,
      playedUci: move.uci,
      phase: toPhase(move.phase),
      expectedScoreBefore: move.expectedScoreBefore,
      expectedScoreAfter: move.expectedScoreAfter,
      criticality: move.criticality,
      onlyMove: move.onlyMove,
      deepSearched: move.deep.status === "completed",
      book: supplement?.book ?? false,
      legalMoveCount: supplement?.legalMoveCount ?? null,
      bandLogLikelihoods: supplement?.bandLogLikelihoods ?? null,
      reply: replyFrom(move, supplement),
    };
  });

  return {
    decisions,
    deepPassRan: options.deepPassRan,
    canonicalGameId: options.canonicalGameId,
  };
}

/**
 * What is missing before this game can be rated, in words.
 *
 * The public path needs to be able to say "we have not run the policy over this
 * game yet" rather than returning an empty rating, and the operator path needs
 * to know what a backfill would have to compute. Both read this.
 */
export function missingEvidence(input: GameRatingInput): string[] {
  const missing: string[] = [];
  const withLikelihoods = input.decisions.filter(
    (decision) => decision.bandLogLikelihoods !== null,
  ).length;
  const withReply = input.decisions.filter((decision) => decision.reply !== null).length;

  if (withLikelihoods === 0) {
    missing.push("no policy inference on any ply: the strength estimate cannot be made");
  } else if (withLikelihoods < input.decisions.length) {
    missing.push(
      `policy inference on ${withLikelihoods} of ${input.decisions.length} plies`,
    );
  }
  if (!input.deepPassRan) missing.push("the deep pass has not run: demand is unknown");
  if (withReply === 0) {
    missing.push(
      "no reply evidence on any ply: every move is scored against the engine rather than the opponent",
    );
  }
  return missing;
}

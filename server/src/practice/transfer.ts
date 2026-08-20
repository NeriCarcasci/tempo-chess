import {
  TRANSFER_POLICY,
  type IncomparableReason,
  type TransferOutcome,
  type TransferPolicy,
} from "./contract.js";

/**
 * The transfer matcher: the only bridge between practice and real games.
 *
 * Everything about it is built to make a *negative* answer easy to reach. A
 * matcher that accepts loose resemblance will find transfer everywhere, and a
 * coaching product that reports transfer everywhere has a metric that means
 * nothing. So the default is `inconclusive`, incomparability is checked before
 * anything else, and the outcome is allowed to be negative — a player who
 * practised a motif and then missed it in a game is evidence, not a bug.
 *
 * A practice solve never appears in the output. What is matched is earlier
 * *work* against a later *real-game opportunity*, and the opportunity's own
 * result is what decides the outcome.
 */

export interface EarlierWork {
  assignmentId: string | null;
  interventionId: string | null;
  sourceFindingId: string | null;
  /** The concept the work was about. */
  conceptSlug: string;
  phase: string | null;
  speed: string | null;
  /** When the work was delivered. */
  occurredAt: Date;
  /** Whether the player actually engaged with it. */
  attempted: boolean;
}

export interface LaterOpportunity {
  opportunityId: string;
  conceptSlug: string;
  phase: string | null;
  speed: string | null;
  occurredAt: Date;
  /** How the player did. Null when the chance was censored. */
  success: boolean | null;
  censored: boolean;
  /** Structural resemblance to the practised position, when computed. */
  structuralSimilarity: number | null;
}

export interface TransferMatch {
  opportunityId: string;
  assignmentId: string | null;
  interventionId: string | null;
  sourceFindingId: string | null;
  exactSimilarity: number | null;
  structuralSimilarity: number | null;
  semanticSimilarity: number | null;
  comparableContext: boolean;
  incomparableReason: IncomparableReason | null;
  outcome: TransferOutcome;
  confidence: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Decide whether the two situations were comparable at all.
 *
 * Checked before the outcome, and returning a reason rather than a boolean,
 * because "these were not alike" is the answer most of the time and a user
 * deserves to be told which way they were not alike.
 */
export function comparability(
  earlier: EarlierWork,
  later: LaterOpportunity,
  policy: TransferPolicy = TRANSFER_POLICY,
): { comparable: true } | { comparable: false; reason: IncomparableReason } {
  if (later.censored) return { comparable: false, reason: "opportunity_censored" };
  if (earlier.conceptSlug !== later.conceptSlug) {
    return { comparable: false, reason: "different_concept" };
  }
  if (earlier.phase !== null && later.phase !== null && earlier.phase !== later.phase) {
    return { comparable: false, reason: "different_phase" };
  }
  if (earlier.speed !== null && later.speed !== null && earlier.speed !== later.speed) {
    // Blitz and classical are different games for the same motif. Treating a
    // classical solve as evidence about a bullet decision is how a transfer
    // metric quietly becomes a time-control metric.
    return { comparable: false, reason: "different_speed" };
  }

  const days = (later.occurredAt.getTime() - earlier.occurredAt.getTime()) / DAY_MS;
  if (days < policy.minDaysBetween) {
    return { comparable: false, reason: "too_distant_in_time" };
  }
  if (days > policy.maxDaysBetween) {
    return { comparable: false, reason: "too_distant_in_time" };
  }
  if (
    later.structuralSimilarity !== null &&
    later.structuralSimilarity < policy.minSimilarity
  ) {
    return { comparable: false, reason: "similarity_below_threshold" };
  }
  return { comparable: true };
}

/**
 * Match one piece of earlier work against one later opportunity.
 *
 * The outcome is read off the opportunity, not off the practice: the player
 * either handled the real chance or did not. Confidence falls with distance in
 * time and with weaker similarity, and a match below the confidence floor is
 * downgraded to `inconclusive` rather than published as a weak positive.
 */
export function matchTransfer(
  earlier: EarlierWork,
  later: LaterOpportunity,
  policy: TransferPolicy = TRANSFER_POLICY,
): TransferMatch {
  const base: Omit<TransferMatch, "outcome" | "confidence" | "comparableContext" | "incomparableReason"> = {
    opportunityId: later.opportunityId,
    assignmentId: earlier.assignmentId,
    interventionId: earlier.interventionId,
    sourceFindingId: earlier.sourceFindingId,
    exactSimilarity: earlier.conceptSlug === later.conceptSlug ? 1 : 0,
    structuralSimilarity: later.structuralSimilarity,
    semanticSimilarity: null,
  };

  const comparable = comparability(earlier, later, policy);
  if (!comparable.comparable) {
    return {
      ...base,
      comparableContext: false,
      incomparableReason: comparable.reason,
      // Not alike means nothing transferred either way. Recording a negative
      // here would blame somebody for failing a chance that was not the one
      // they practised.
      outcome: "inconclusive",
      confidence: 0,
    };
  }

  const days = (later.occurredAt.getTime() - earlier.occurredAt.getTime()) / DAY_MS;
  const recency = 1 - Math.min(1, days / policy.maxDaysBetween);
  const similarity = later.structuralSimilarity ?? policy.minSimilarity;
  // Work the player never engaged with is weaker evidence about learning than
  // work they actually did, even when the later game went well.
  const engagement = earlier.attempted ? 1 : 0.6;
  const confidence = round(Math.min(1, recency * similarity * engagement));

  if (later.success === null) {
    return {
      ...base,
      comparableContext: true,
      incomparableReason: null,
      outcome: "inconclusive",
      confidence,
    };
  }
  if (confidence < policy.minConfidence) {
    return {
      ...base,
      comparableContext: true,
      incomparableReason: null,
      // Comparable, but not confidently enough to make a claim either way.
      outcome: "inconclusive",
      confidence,
    };
  }

  return {
    ...base,
    comparableContext: true,
    incomparableReason: null,
    outcome: later.success ? "positive" : "negative",
    confidence,
  };
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

export interface TransferSummary {
  positive: number;
  negative: number;
  inconclusive: number;
  /** Real-game opportunities that were comparable at all. */
  comparable: number;
  total: number;
}

export function summarizeTransfer(matches: readonly TransferMatch[]): TransferSummary {
  return {
    positive: matches.filter((match) => match.outcome === "positive").length,
    negative: matches.filter((match) => match.outcome === "negative").length,
    inconclusive: matches.filter((match) => match.outcome === "inconclusive").length,
    comparable: matches.filter((match) => match.comparableContext).length,
    total: matches.length,
  };
}

/**
 * What a summary is allowed to say out loud.
 *
 * `null` when there is nothing honest to report, which is the common case early
 * on. The alternative — reporting "1 of 1 transferred" from a single comparable
 * chance — is the kind of statistic that makes a person trust a product right
 * up until they check it.
 */
export function describeTransfer(summary: TransferSummary): string | null {
  if (summary.comparable === 0) {
    return summary.total === 0
      ? null
      : "None of your recent games gave you a comparable chance yet, so there is nothing to report about whether this carried over.";
  }
  if (summary.comparable < 3) {
    return `You have had ${summary.comparable} comparable chance${summary.comparable === 1 ? "" : "s"} so far. That is not enough to say whether this has carried into your games.`;
  }
  const decided = summary.positive + summary.negative;
  if (decided === 0) {
    return `You have had ${summary.comparable} comparable chances, but none of them settled the question either way.`;
  }
  return `Of ${decided} comparable chances in your games, you handled ${summary.positive}.`;
}

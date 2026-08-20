import {
  DIAGNOSTIC_POLICY,
  type DiagnosticPolicy,
  type DiagnosticPurpose,
} from "./contract.js";

/**
 * The adaptive diagnostic: choosing what to ask, and scoring what comes back.
 *
 * The word doing the work is *adaptive*. This is not a puzzle set with a score
 * at the end; it is a short, bounded set of positions chosen because the report
 * is uncertain about something specific, and each item records which
 * uncertainty it was selected to reduce. An item that names no uncertainty
 * cannot update anything, which is why the database refuses one.
 *
 * Selection is deterministic. Two sessions built from the same report ask the
 * same questions, so a user who reloads mid-session is not quietly given a
 * different examination.
 */

/** A dimension the report is unsure about, and how unsure. */
export interface UncertainDimension {
  dimensionKey: string;
  /** Width of the estimate's interval. Wider means less is known. */
  intervalWidth: number;
  /** Where the estimate sits. Used to pick the item's purpose. */
  estimate: number;
  /** Positions from the player's own games that exercised this dimension. */
  candidates: readonly CandidatePosition[];
  findingId: string | null;
}

export interface CandidatePosition {
  corePositionId: string;
  fen: string;
  /** What the engine says is best here, and what else is acceptable. */
  expectedUci: string;
  acceptableUci: readonly string[];
  /** True when the player got this wrong in the real game. */
  playerMishandled: boolean;
}

export interface SelectedItem {
  ordinal: number;
  purpose: DiagnosticPurpose;
  dimensionKey: string;
  findingId: string | null;
  corePositionId: string;
  fen: string;
  expectedUci: string;
  acceptableUci: readonly string[];
}

/**
 * Choose the session's items.
 *
 * Widest interval first, because the point is to reduce uncertainty rather than
 * to confirm what is already known. The per-dimension cap stops one very
 * uncertain area from consuming the whole session: a diagnostic that asks eight
 * questions about forks has learned a lot about forks and nothing about the
 * player.
 */
export function selectItems(
  dimensions: readonly UncertainDimension[],
  policy: DiagnosticPolicy = DIAGNOSTIC_POLICY,
): SelectedItem[] {
  const ordered = [...dimensions].sort(
    (a, b) => b.intervalWidth - a.intervalWidth || a.dimensionKey.localeCompare(b.dimensionKey),
  );

  const items: SelectedItem[] = [];
  const takenPerDimension = new Map<string, number>();
  const usedPositions = new Set<string>();

  // Round-robin across dimensions rather than draining each in turn, so a
  // session cut short by a user who leaves still covers several areas.
  for (let round = 0; round < policy.maxItemsPerDimension; round += 1) {
    for (const dimension of ordered) {
      if (items.length >= policy.itemCount) break;
      const taken = takenPerDimension.get(dimension.dimensionKey) ?? 0;
      if (taken >= policy.maxItemsPerDimension) continue;

      const candidate = dimension.candidates.find(
        (position) => !usedPositions.has(position.corePositionId),
      );
      if (!candidate) continue;

      usedPositions.add(candidate.corePositionId);
      takenPerDimension.set(dimension.dimensionKey, taken + 1);
      items.push({
        ordinal: items.length,
        purpose: purposeFor(dimension, candidate, taken),
        dimensionKey: dimension.dimensionKey,
        findingId: dimension.findingId,
        corePositionId: candidate.corePositionId,
        fen: candidate.fen,
        expectedUci: candidate.expectedUci,
        acceptableUci: candidate.acceptableUci,
      });
    }
    if (items.length >= policy.itemCount) break;
  }

  return items;
}

/**
 * Why this item is being asked.
 *
 * The purpose is shown to the user before they answer (platform spec 14.7's
 * pre-explanation guarantee), so it has to be a true description of the reason
 * rather than a label chosen to sound encouraging.
 */
function purposeFor(
  dimension: UncertainDimension,
  candidate: CandidatePosition,
  alreadyTaken: number,
): DiagnosticPurpose {
  if (candidate.playerMishandled) return "earlier_mishandled";
  if (alreadyTaken > 0) return "transfer_variant";
  if (dimension.estimate >= 0.7) return "strength_confirmation";
  return "target_level";
}

export interface AttemptOutcome {
  correct: boolean;
  /** Graded, not binary: an acceptable-but-not-best move is partial credit. */
  score: number;
  /** True when the answer arrived inside the timed-decision window. */
  withinTimedWindow: boolean;
}

/**
 * Score one attempt against the item's immutable rubric.
 *
 * Three outcomes, not two. The best move scores 1, another move the engine
 * called acceptable scores 0.6, anything else scores 0 — because "found a good
 * move that was not the best one" is different information from "did not see
 * it", and collapsing them loses exactly what a diagnostic is for.
 *
 * Hints cost. A position solved after being shown the answer is evidence about
 * the hint, not about the player.
 */
export function scoreAttempt(
  item: { expectedUci: string; acceptableUci: readonly string[] },
  attempt: { moveUci: string; thinkTimeMs: number | null; hintsUsed: number },
  policy: DiagnosticPolicy = DIAGNOSTIC_POLICY,
): AttemptOutcome {
  const best = attempt.moveUci === item.expectedUci;
  const acceptable = item.acceptableUci.includes(attempt.moveUci);
  const base = best ? 1 : acceptable ? 0.6 : 0;
  // Each hint halves what the answer is worth. A fully hinted correct answer
  // still scores something, because the player did play the move.
  const score = base / Math.pow(2, Math.min(3, Math.max(0, attempt.hintsUsed)));

  return {
    correct: best || acceptable,
    score: Number(score.toFixed(3)),
    withinTimedWindow:
      attempt.thinkTimeMs !== null && attempt.thinkTimeMs <= policy.timedDecisionMs,
  };
}

export interface SessionProgress {
  total: number;
  answered: number;
  complete: boolean;
  /** The next unanswered item's ordinal, or null when the session is done. */
  nextOrdinal: number | null;
}

export function sessionProgress(
  items: readonly { ordinal: number }[],
  answeredOrdinals: readonly number[],
): SessionProgress {
  const answered = new Set(answeredOrdinals);
  const remaining = items
    .map((item) => item.ordinal)
    .filter((ordinal) => !answered.has(ordinal))
    .sort((a, b) => a - b);
  return {
    total: items.length,
    answered: answered.size,
    complete: remaining.length === 0 && items.length > 0,
    nextOrdinal: remaining[0] ?? null,
  };
}

/**
 * What the user is told about an item *before* answering it.
 *
 * Platform spec 14.7's pre-explanation guarantee. The point is that a
 * diagnostic is not a test the product is trying to win: telling someone what
 * is being investigated costs a little signal and buys the difference between
 * an examination and a trap.
 */
export function describePurpose(purpose: DiagnosticPurpose, dimensionKey: string): string {
  const area = dimensionKey.replace(/_/g, " ");
  switch (purpose) {
    case "earlier_mishandled":
      return `This is a position from one of your own games where ${area} did not go well. We want to see how you handle it now.`;
    case "transfer_variant":
      return `This is a variation on something we have already asked about ${area}, to see whether the idea carries across.`;
    case "strength_confirmation":
      return `Your games suggest ${area} is a strength. This checks that.`;
    case "target_level":
      return `This is a ${area} decision at the level you are working towards.`;
    case "timed_decision":
      return `This ${area} decision is about speed as much as accuracy. Answer as you would in a real game.`;
  }
}

import { QUEUE_POLICY, SCHEDULER_POLICY, type QueuePolicy, type SchedulerPolicy } from "./contract.js";

/**
 * Review scheduling and the practice queue.
 *
 * The scheduler is deliberately simple and deliberately versioned. Its state is
 * mutable current state; the attempts it was computed from are not, so
 * replacing it rebuilds the schedule without rewriting anybody's history. That
 * split is the whole design: a scheduler is a hypothesis about memory, and a
 * hypothesis should not be able to edit the evidence.
 *
 * Two judgements are encoded rather than tuned:
 *
 * - A hinted solve is worth less than an unaided one. Not nothing — the player
 *   did produce the move — but scheduling it as if it were unaided is how a
 *   review system convinces itself somebody knows something they do not.
 * - A revealed answer is not a success at all, and the schema agrees.
 */

export interface ScheduleState {
  intervalDays: number;
  stability: number | null;
  difficulty: number | null;
}

export interface AttemptOutcome {
  success: boolean;
  hintsUsed: number;
  revealed: boolean;
  retries: number;
}

export interface NextReview extends ScheduleState {
  dueAt: Date;
}

/**
 * The next review for one item.
 *
 * A lapse goes back to a short interval rather than to zero: same-day repetition
 * is cramming, which produces a solve that says nothing about tomorrow.
 */
export function nextReview(
  current: ScheduleState | null,
  outcome: AttemptOutcome,
  now: Date,
  policy: SchedulerPolicy = SCHEDULER_POLICY,
): NextReview {
  const previous = current?.intervalDays ?? 0;

  if (!outcome.success || outcome.revealed) {
    return {
      intervalDays: policy.lapseIntervalDays,
      stability: current?.stability ?? null,
      // A lapse makes an item harder, bounded so one bad day does not brand it
      // impossible forever.
      difficulty: clamp((current?.difficulty ?? 0.3) + 0.15),
      dueAt: addDays(now, policy.lapseIntervalDays),
    };
  }

  // A hinted success advances, less far. `hintPenalty` is applied per hint, so
  // three hints leave the interval barely moved.
  const credit = Math.pow(policy.hintPenalty, Math.min(3, outcome.hintsUsed));
  const grown =
    previous === 0
      ? policy.firstIntervalDays
      : previous * (1 + (policy.easeFactor - 1) * credit);
  const intervalDays = Math.min(policy.maxIntervalDays, round(grown));

  return {
    intervalDays,
    stability: round(intervalDays),
    difficulty: clamp((current?.difficulty ?? 0.3) - 0.05 * credit),
    dueAt: addDays(now, intervalDays),
  };
}

function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
}

function clamp(value: number): number {
  return Number(Math.min(1, Math.max(0, value)).toFixed(3));
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

export interface QueueCandidate {
  assignmentId: string;
  trainingItemVersionId: string;
  priority: number;
  dueAt: Date | null;
  assignedAt: Date;
}

export interface PracticeQueue {
  items: QueueCandidate[];
  /** How many were left behind, so the client can say "and N more". */
  remaining: number;
  /** Overdue items outstanding. The number that decides whether to add more. */
  overdue: number;
}

/**
 * Build the practice queue.
 *
 * Overdue work comes first, but only up to a share of the batch. A queue that
 * is nothing but a backlog is one a person closes: seeing only your failures,
 * ordered by how long you have been failing them, is not a study session.
 */
export function buildQueue(
  candidates: readonly QueueCandidate[],
  now: Date,
  policy: QueuePolicy = QUEUE_POLICY,
): PracticeQueue {
  const overdue = candidates
    .filter((item) => item.dueAt !== null && item.dueAt <= now)
    .sort(
      (a, b) =>
        (a.dueAt?.getTime() ?? 0) - (b.dueAt?.getTime() ?? 0) ||
        b.priority - a.priority ||
        a.assignmentId.localeCompare(b.assignmentId),
    );
  const fresh = candidates
    .filter((item) => item.dueAt === null || item.dueAt > now)
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        a.assignedAt.getTime() - b.assignedAt.getTime() ||
        a.assignmentId.localeCompare(b.assignmentId),
    );

  const overdueSlots = Math.min(
    overdue.length,
    Math.floor(policy.batchSize * policy.overdueShare),
  );
  const items = [...overdue.slice(0, overdueSlots)];
  for (const item of fresh) {
    if (items.length >= policy.batchSize) break;
    items.push(item);
  }
  // If there is nothing fresh, fill the rest with overdue rather than serving a
  // short queue.
  for (const item of overdue.slice(overdueSlots)) {
    if (items.length >= policy.batchSize) break;
    items.push(item);
  }

  return {
    items,
    remaining: Math.max(0, candidates.length - items.length),
    overdue: overdue.length,
  };
}

/**
 * Whether the selector should assign more work.
 *
 * A person with thirty outstanding assignments does not need a thirty-first;
 * they need to be left alone until they have cleared some. Adding work to a
 * backlog is how a coaching product becomes a source of guilt.
 */
export function shouldAssignMore(
  outstanding: number,
  policy: QueuePolicy = QUEUE_POLICY,
): boolean {
  return outstanding < policy.maxOutstanding;
}

/**
 * Score one practice attempt against the item's solution.
 *
 * Ordered solution: the first move is the answer and the rest are acceptable.
 * The same three-valued shape the diagnostic uses, for the same reason —
 * "played a reasonable move that was not the one" is different information
 * from "did not see it".
 */
export function scorePractice(
  solutionUci: readonly string[],
  submittedUci: readonly string[],
  outcome: { hintsUsed: number; revealed: boolean },
): { success: boolean; score: number } {
  const played = submittedUci[0] ?? "";
  const best = solutionUci[0] ?? "";
  const acceptable = solutionUci.includes(played);
  const base = played === best ? 1 : acceptable ? 0.6 : 0;
  // A revealed answer scores whatever the move was worth and is never a
  // success: the schema refuses `revealed and success` together, and this is
  // the code path that keeps them apart.
  const score = Number((base * Math.pow(0.5, Math.min(3, outcome.hintsUsed))).toFixed(3));
  return { success: !outcome.revealed && base > 0, score };
}

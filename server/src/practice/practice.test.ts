/**
 * `npm run practice:unit` — E18's invariants, offline.
 *
 * The load-bearing assertions are all about the same rule from two directions:
 * a practice solve is engagement rather than improvement, and the only thing
 * that can say otherwise is a comparable later real-game opportunity.
 */

import { strict as assert } from "node:assert";

import {
  INCOMPARABLE_REASONS,
  QUEUE_POLICY,
  SCHEDULER_POLICY,
  TRANSFER_OUTCOMES,
  TRANSFER_POLICY,
} from "./contract.js";
import {
  comparability,
  describeTransfer,
  matchTransfer,
  summarizeTransfer,
  type EarlierWork,
  type LaterOpportunity,
} from "./transfer.js";
import {
  buildQueue,
  nextReview,
  scorePractice,
  shouldAssignMore,
  type QueueCandidate,
} from "./scheduler.js";

const failures: string[] = [];
let passed = 0;

function test(name: string, run: () => void): void {
  try {
    run();
    passed += 1;
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const NOW = new Date("2026-08-01T00:00:00Z");
const daysAfter = (days: number): Date => new Date(NOW.getTime() + days * 86_400_000);

// ---------------------------------------------------------------------------
// Transfer
// ---------------------------------------------------------------------------

function work(over: Partial<EarlierWork> = {}): EarlierWork {
  return {
    assignmentId: "a1",
    interventionId: null,
    sourceFindingId: null,
    conceptSlug: "fork",
    phase: "middlegame",
    speed: "blitz",
    occurredAt: NOW,
    attempted: true,
    ...over,
  };
}

function opportunity(over: Partial<LaterOpportunity> = {}): LaterOpportunity {
  return {
    opportunityId: "o1",
    conceptSlug: "fork",
    phase: "middlegame",
    speed: "blitz",
    occurredAt: daysAfter(7),
    success: true,
    censored: false,
    structuralSimilarity: 0.9,
    ...over,
  };
}

test("a different concept is not comparable", () => {
  const result = comparability(work(), opportunity({ conceptSlug: "pin" }));
  assert.equal(result.comparable, false);
  if (result.comparable) return;
  assert.equal(result.reason, "different_concept");
});

test("a different time control is not comparable", () => {
  const result = comparability(work({ speed: "classical" }), opportunity({ speed: "bullet" }));
  assert.equal(result.comparable === false && result.reason, "different_speed");
});

test("a censored chance is not comparable", () => {
  const result = comparability(work(), opportunity({ censored: true, success: null }));
  assert.equal(result.comparable === false && result.reason, "opportunity_censored");
});

test("work from four months ago is too distant", () => {
  const result = comparability(work(), opportunity({ occurredAt: daysAfter(120) }));
  assert.equal(result.comparable === false && result.reason, "too_distant_in_time");
});

test("loose resemblance is below the threshold", () => {
  const result = comparability(work(), opportunity({ structuralSimilarity: 0.3 }));
  assert.equal(result.comparable === false && result.reason, "similarity_below_threshold");
});

test("an incomparable match is inconclusive, never negative", () => {
  for (const change of [
    { conceptSlug: "pin" },
    { speed: "bullet" as const },
    { censored: true, success: null },
    { structuralSimilarity: 0.1 },
  ]) {
    const match = matchTransfer(work(), opportunity({ ...change, success: false }));
    assert.equal(match.comparableContext, false);
    assert.equal(
      match.outcome,
      "inconclusive",
      `an incomparable chance was scored ${match.outcome}`,
    );
    assert.ok(match.incomparableReason !== null);
  }
});

test("a comparable chance the player handled is positive", () => {
  const match = matchTransfer(work(), opportunity({ success: true }));
  assert.equal(match.comparableContext, true);
  assert.equal(match.outcome, "positive");
  assert.ok(match.confidence >= TRANSFER_POLICY.minConfidence);
});

test("a comparable chance the player missed is negative, and is recorded", () => {
  const match = matchTransfer(work(), opportunity({ success: false }));
  assert.equal(match.outcome, "negative", "a failed transfer was hidden");
  assert.equal(match.incomparableReason, null);
});

test("a comparable chance with no outcome is inconclusive", () => {
  const match = matchTransfer(work(), opportunity({ success: null }));
  assert.equal(match.outcome, "inconclusive");
  assert.equal(match.comparableContext, true);
});

test("confidence falls with time, and a weak match is downgraded", () => {
  const soon = matchTransfer(work(), opportunity({ occurredAt: daysAfter(2) }));
  const late = matchTransfer(work(), opportunity({ occurredAt: daysAfter(80) }));
  assert.ok(soon.confidence > late.confidence);
  assert.equal(soon.outcome, "positive");
  assert.equal(late.outcome, "inconclusive", "a low-confidence match was published as positive");
});

test("work the player never engaged with is weaker evidence", () => {
  const done = matchTransfer(work({ attempted: true }), opportunity());
  const ignored = matchTransfer(work({ attempted: false }), opportunity());
  assert.ok(done.confidence > ignored.confidence);
});

test("a practice attempt never appears in a transfer match", () => {
  const match = matchTransfer(work(), opportunity());
  const keys = Object.keys(match);
  for (const key of keys) {
    assert.ok(
      !/practice|attempt/i.test(key),
      `${key} would let a practice solve stand in for a real game`,
    );
  }
  assert.ok(keys.includes("opportunityId"));
});

test("every incomparable reason is in the schema's vocabulary", () => {
  assert.equal(new Set(INCOMPARABLE_REASONS).size, INCOMPARABLE_REASONS.length);
  for (const reason of INCOMPARABLE_REASONS) assert.ok(/^[a-z_]+$/.test(reason));
});

test("all three outcomes exist, so a matcher can say no", () => {
  assert.deepEqual([...TRANSFER_OUTCOMES], ["positive", "negative", "inconclusive"]);
});

test("a single comparable chance is not reported as a rate", () => {
  const summary = summarizeTransfer([matchTransfer(work(), opportunity())]);
  const text = describeTransfer(summary);
  assert.ok(text !== null);
  assert.ok(!text!.includes("1 of 1"), "one chance was reported as a success rate");
  assert.ok(text!.includes("not enough"));
});

test("nothing comparable yet says so rather than saying nothing", () => {
  const summary = summarizeTransfer([
    matchTransfer(work(), opportunity({ conceptSlug: "pin", success: true })),
  ]);
  const text = describeTransfer(summary);
  assert.ok(text !== null && text.includes("comparable chance"));
});

test("enough comparable chances are reported as a count, not a percentage", () => {
  const matches = [
    matchTransfer(work(), opportunity({ opportunityId: "o1", success: true })),
    matchTransfer(work(), opportunity({ opportunityId: "o2", success: true })),
    matchTransfer(work(), opportunity({ opportunityId: "o3", success: false })),
  ];
  const text = describeTransfer(summarizeTransfer(matches));
  assert.ok(text !== null);
  assert.ok(text!.includes("3 comparable"));
  assert.ok(!text!.includes("%"), "a three-chance sample was rendered as a percentage");
});

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

test("a first success schedules tomorrow, not today", () => {
  const next = nextReview(null, { success: true, hintsUsed: 0, revealed: false, retries: 0 }, NOW);
  assert.equal(next.intervalDays, SCHEDULER_POLICY.firstIntervalDays);
  assert.ok(next.dueAt > NOW);
});

test("successes grow the interval", () => {
  const first = nextReview(null, { success: true, hintsUsed: 0, revealed: false, retries: 0 }, NOW);
  const second = nextReview(first, { success: true, hintsUsed: 0, revealed: false, retries: 0 }, NOW);
  assert.ok(second.intervalDays > first.intervalDays);
});

test("a hinted success advances less than an unaided one", () => {
  const state = { intervalDays: 10, stability: 10, difficulty: 0.3 };
  const clean = nextReview(state, { success: true, hintsUsed: 0, revealed: false, retries: 0 }, NOW);
  const hinted = nextReview(state, { success: true, hintsUsed: 2, revealed: false, retries: 0 }, NOW);
  assert.ok(hinted.intervalDays < clean.intervalDays, "a hinted solve was treated as unaided");
  assert.ok(hinted.intervalDays > state.intervalDays, "a hinted solve was treated as a failure");
});

test("a lapse comes back soon, and not the same day", () => {
  const next = nextReview(
    { intervalDays: 60, stability: 60, difficulty: 0.2 },
    { success: false, hintsUsed: 0, revealed: false, retries: 1 },
    NOW,
  );
  assert.equal(next.intervalDays, SCHEDULER_POLICY.lapseIntervalDays);
  assert.ok(next.intervalDays > 0, "a lapse was scheduled for the same session");
  assert.ok(next.difficulty! > 0.2);
});

test("a revealed answer is treated as a lapse", () => {
  const next = nextReview(
    { intervalDays: 30, stability: 30, difficulty: 0.2 },
    { success: true, hintsUsed: 0, revealed: true, retries: 0 },
    NOW,
  );
  assert.equal(next.intervalDays, SCHEDULER_POLICY.lapseIntervalDays);
});

test("the interval is capped", () => {
  let state = { intervalDays: 170, stability: 170, difficulty: 0.1 };
  for (let i = 0; i < 5; i += 1) {
    state = nextReview(state, { success: true, hintsUsed: 0, revealed: false, retries: 0 }, NOW);
  }
  assert.ok(state.intervalDays <= SCHEDULER_POLICY.maxIntervalDays);
});

test("one bad day does not brand an item impossible", () => {
  let state = { intervalDays: 10, stability: 10, difficulty: 0.3 };
  for (let i = 0; i < 20; i += 1) {
    state = nextReview(state, { success: false, hintsUsed: 0, revealed: false, retries: 0 }, NOW);
  }
  assert.ok(state.difficulty! <= 1);
});

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

test("the best move, an acceptable move and a bad move score differently", () => {
  const solution = ["e2e4", "d2d4"];
  assert.deepEqual(scorePractice(solution, ["e2e4"], { hintsUsed: 0, revealed: false }), {
    success: true,
    score: 1,
  });
  const acceptable = scorePractice(solution, ["d2d4"], { hintsUsed: 0, revealed: false });
  assert.equal(acceptable.success, true);
  assert.ok(acceptable.score > 0 && acceptable.score < 1);
  assert.deepEqual(scorePractice(solution, ["h2h3"], { hintsUsed: 0, revealed: false }), {
    success: false,
    score: 0,
  });
});

test("a revealed correct answer is never a success", () => {
  const result = scorePractice(["e2e4"], ["e2e4"], { hintsUsed: 0, revealed: true });
  assert.equal(result.success, false, "a revealed answer was recorded as a solve");
  assert.ok(result.score > 0, "the player did play the move");
});

test("hints reduce the score without erasing it", () => {
  const clean = scorePractice(["e2e4"], ["e2e4"], { hintsUsed: 0, revealed: false });
  const hinted = scorePractice(["e2e4"], ["e2e4"], { hintsUsed: 2, revealed: false });
  assert.ok(hinted.score < clean.score);
  assert.ok(hinted.score > 0);
  assert.equal(hinted.success, true);
});

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

function candidate(over: Partial<QueueCandidate> = {}): QueueCandidate {
  return {
    assignmentId: "a1",
    trainingItemVersionId: "v1",
    priority: 50,
    dueAt: null,
    assignedAt: NOW,
    ...over,
  };
}

test("the queue is bounded", () => {
  const queue = buildQueue(
    Array.from({ length: 50 }, (_, i) => candidate({ assignmentId: `a${i}` })),
    NOW,
  );
  assert.equal(queue.items.length, QUEUE_POLICY.batchSize);
  assert.equal(queue.remaining, 40);
});

test("a queue is never only a backlog", () => {
  const overdue = Array.from({ length: 30 }, (_, i) =>
    candidate({ assignmentId: `old${i}`, dueAt: daysAfter(-10) }),
  );
  const fresh = Array.from({ length: 10 }, (_, i) =>
    candidate({ assignmentId: `new${i}`, dueAt: daysAfter(5) }),
  );
  const queue = buildQueue([...overdue, ...fresh], NOW);
  const freshServed = queue.items.filter((item) => item.assignmentId.startsWith("new")).length;
  assert.ok(freshServed > 0, "the queue served nothing but failures");
  assert.equal(queue.overdue, 30);
});

test("overdue work still comes first", () => {
  const queue = buildQueue(
    [
      candidate({ assignmentId: "fresh", dueAt: daysAfter(5), priority: 99 }),
      candidate({ assignmentId: "overdue", dueAt: daysAfter(-3), priority: 1 }),
    ],
    NOW,
  );
  assert.equal(queue.items[0]!.assignmentId, "overdue");
});

test("with nothing fresh the queue fills with overdue rather than running short", () => {
  const queue = buildQueue(
    Array.from({ length: 20 }, (_, i) =>
      candidate({ assignmentId: `old${i}`, dueAt: daysAfter(-i - 1) }),
    ),
    NOW,
  );
  assert.equal(queue.items.length, QUEUE_POLICY.batchSize);
});

test("the queue is deterministic", () => {
  const candidates = Array.from({ length: 20 }, (_, i) =>
    candidate({ assignmentId: `a${i}`, priority: i % 5, dueAt: i % 2 ? daysAfter(-i) : null }),
  );
  assert.deepEqual(buildQueue(candidates, NOW), buildQueue(candidates, NOW));
});

test("a backlog stops the selector adding more", () => {
  assert.equal(shouldAssignMore(0), true);
  assert.equal(shouldAssignMore(QUEUE_POLICY.maxOutstanding - 1), true);
  assert.equal(shouldAssignMore(QUEUE_POLICY.maxOutstanding), false);
  assert.equal(shouldAssignMore(200), false);
});

test("the policies are frozen", () => {
  assert.equal(Object.isFrozen(SCHEDULER_POLICY), true);
  assert.equal(Object.isFrozen(TRANSFER_POLICY), true);
  assert.equal(Object.isFrozen(QUEUE_POLICY), true);
});

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`practice:unit — ${failures.length} failed, ${passed} passed`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`practice:unit — ${passed}/${passed} passed`);

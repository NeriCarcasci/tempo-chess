/**
 * `npm run onboarding:unit` — E16's invariants, offline.
 *
 * The journey, the coverage policy, the diagnostic and the redaction rule, all
 * as pure functions. The assertions that matter are the ones about what a user
 * is told: a thin report says it is thin, a withheld item is counted rather than
 * hidden, and a coverage limitation cannot be redacted by any plan.
 */

import { strict as assert } from "node:assert";

import {
  COVERAGE_POLICY,
  DIAGNOSTIC_POLICY,
  PLAN_ENTITLEMENTS,
  STAGES,
  TRANSITIONS,
} from "./contract.js";
import {
  canTransition,
  checkActivation,
  deriveStage,
  isRetryable,
  nextAction,
  type RunState,
} from "./state.js";
import { decideCoverage, LIMITATION_TEXT, type DimensionFacts, type GameFacts } from "./coverage.js";
import {
  describePurpose,
  scoreAttempt,
  selectItems,
  sessionProgress,
  type UncertainDimension,
} from "./diagnostic.js";
import { buildReport, headline, manifestHash, redactForPlan } from "./baseline.js";

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

// ---------------------------------------------------------------------------
// The journey
// ---------------------------------------------------------------------------

function runState(over: Partial<RunState> = {}): RunState {
  return {
    stage: "linking",
    status: "active",
    diagnosticChoice: "adaptive",
    hasLinkedAccount: false,
    syncComplete: false,
    analysisComplete: false,
    diagnosticComplete: false,
    diagnosticSessionId: null,
    baselineReportId: null,
    reportViewedAt: null,
    goalSelectedAt: null,
    commitmentAcceptedAt: null,
    ...over,
  };
}

test("an adaptive run with no diagnostic session does not wait for one", () => {
  // The default choice is `adaptive`, and nothing in the product creates a
  // session yet. Waiting for one that cannot arrive left every journey sitting
  // on `start_diagnostic` with its report built and unread.
  const state = runState({
    hasLinkedAccount: true,
    syncComplete: true,
    analysisComplete: true,
    diagnosticChoice: "adaptive",
    diagnosticSessionId: null,
    baselineReportId: "report-1",
  });
  assert.equal(deriveStage(state), "report_ready");
  assert.equal(nextAction(state).action, "view_report");
});

test("an adaptive run with a session still waits for it", () => {
  const state = runState({
    hasLinkedAccount: true,
    syncComplete: true,
    analysisComplete: true,
    diagnosticChoice: "adaptive",
    diagnosticSessionId: "session-1",
    diagnosticComplete: false,
    baselineReportId: "report-1",
  });
  assert.equal(deriveStage(state), "diagnostic");
  assert.equal(nextAction(state).action, "start_diagnostic");
});

const READY = runState({
  stage: "goal_setting",
  hasLinkedAccount: true,
  syncComplete: true,
  analysisComplete: true,
  diagnosticComplete: true,
  baselineReportId: "report-1",
  reportViewedAt: new Date(),
  goalSelectedAt: new Date(),
  commitmentAcceptedAt: new Date(),
});

test("the stage graph is forward-only and ends at activated", () => {
  for (const stage of STAGES) {
    for (const next of TRANSITIONS[stage]) {
      assert.ok(
        STAGES.indexOf(next) > STAGES.indexOf(stage),
        `${stage} -> ${next} goes backwards`,
      );
    }
  }
  assert.deepEqual(TRANSITIONS.activated, []);
});

test("the diagnostic can be skipped without leaving the graph", () => {
  assert.ok(canTransition("analysing", "diagnostic"));
  assert.ok(canTransition("analysing", "report_ready"), "a user who declines is stranded");
  assert.ok(!canTransition("report_ready", "diagnostic"));
});

test("the stage is derived from what happened, not from what was written", () => {
  assert.equal(deriveStage(runState()), "linking");
  assert.equal(deriveStage(runState({ hasLinkedAccount: true })), "syncing");
  assert.equal(
    deriveStage(runState({ hasLinkedAccount: true, syncComplete: true })),
    "analysing",
  );
  // A crashed worker left the row saying `analysing` with the work finished.
  assert.equal(
    deriveStage(
      runState({
        stage: "analysing",
        hasLinkedAccount: true,
        syncComplete: true,
        analysisComplete: true,
        diagnosticChoice: "skip",
        baselineReportId: "report-1",
      }),
    ),
    "report_ready",
  );
});

test("a user who declined the diagnostic is not asked to wait for it", () => {
  const state = runState({
    hasLinkedAccount: true,
    syncComplete: true,
    analysisComplete: true,
    diagnosticChoice: "skip",
    baselineReportId: "report-1",
  });
  assert.equal(deriveStage(state), "report_ready");
  assert.equal(nextAction(state).action, "view_report");
});

test("every waiting state says what it is waiting for", () => {
  const waiting = [
    runState({ hasLinkedAccount: true }),
    runState({ hasLinkedAccount: true, syncComplete: true }),
    runState({
      hasLinkedAccount: true,
      syncComplete: true,
      analysisComplete: true,
      diagnosticChoice: "skip",
    }),
  ];
  for (const state of waiting) {
    const action = nextAction(state);
    assert.equal(action.action, "wait");
    assert.ok(action.reason.length > 10, `a bare wait: "${action.reason}"`);
  }
});

test("activation names every missing precondition, not the first", () => {
  const result = checkActivation(runState({ baselineReportId: null }));
  assert.equal(result.activated, false);
  if (result.activated) return;
  assert.deepEqual([...result.missing], [
    "baseline_report",
    "report_viewed",
    "goal",
    "commitment",
  ]);
});

test("activation is refused when only the commitment is missing", () => {
  const result = checkActivation({ ...READY, commitmentAcceptedAt: null });
  assert.equal(result.activated, false);
  if (result.activated) return;
  assert.deepEqual([...result.missing], ["commitment"]);
});

test("nothing is created implicitly to make activation succeed", () => {
  // The state with a report and nothing else must ask for a goal, not invent
  // one. Platform spec 14: onboarding completion does not create missing
  // objects.
  const state = { ...READY, goalSelectedAt: null, commitmentAcceptedAt: null };
  assert.equal(nextAction(state).action, "select_goal");
  assert.equal(checkActivation(state).activated, false);
});

test("activation succeeds once everything is genuinely present", () => {
  assert.equal(checkActivation(READY).activated, true);
  assert.equal(nextAction(READY).action, "complete_onboarding");
});

test("a provider outage is retryable and a missing account is not", () => {
  assert.equal(isRetryable("provider_unavailable"), true);
  assert.equal(isRetryable("analysis_failed"), true);
  assert.equal(isRetryable("no_linked_account"), false);
  assert.equal(isRetryable("abandoned_by_user"), false);
});

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

const NOW = new Date("2026-08-01T00:00:00Z");
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * 86_400_000);

function game(over: Partial<GameFacts> = {}): GameFacts {
  return {
    playedAt: daysAgo(10),
    speed: "blitz",
    hasClock: true,
    reachedMiddlegame: true,
    reachedEndgame: true,
    eligible: true,
    ...over,
  };
}

function dimension(over: Partial<DimensionFacts> = {}): DimensionFacts {
  return {
    dimensionKey: "fork_recognize",
    observationCount: 30,
    effectiveCount: 25,
    earliestPlayedAt: daysAgo(60),
    latestPlayedAt: daysAgo(1),
    ...over,
  };
}

function spread(count: number, over: Partial<GameFacts> = {}): GameFacts[] {
  return Array.from({ length: count }, (_, i) =>
    game({ playedAt: daysAgo(i * 3), speed: i % 2 === 0 ? "blitz" : "rapid", ...over }),
  );
}

test("a healthy corpus is sufficient and states no limitation", () => {
  const decision = decideCoverage(spread(60), [dimension()], { providerRating: 1500 });
  assert.equal(decision.overallState, "sufficient");
  assert.deepEqual(decision.limitations, []);
});

test("a thin corpus is limited and says exactly what is thin", () => {
  const decision = decideCoverage(spread(20), [dimension()], { providerRating: 1500 });
  assert.equal(decision.overallState, "limited");
  assert.ok(decision.limitations.includes("few_games"));
});

test("anything short of sufficient names at least one limitation", () => {
  for (const count of [0, 3, 10, 49]) {
    const decision = decideCoverage(spread(count), [dimension()], { providerRating: 1500 });
    if (decision.overallState === "sufficient") continue;
    assert.ok(
      decision.limitations.length > 0,
      `${count} games produced ${decision.overallState} with no stated limitation`,
    );
  }
});

test("almost no games is insufficient rather than a confident small report", () => {
  const decision = decideCoverage(spread(2), [dimension()], { providerRating: 1500 });
  assert.equal(decision.overallState, "insufficient");
});

test("fifty games that measured nothing is not sufficient", () => {
  const decision = decideCoverage(
    spread(60),
    [dimension({ observationCount: 2, effectiveCount: 2 })],
    { providerRating: 1500 },
  );
  assert.equal(decision.overallState, "limited", "a lot of evidence about nothing passed");
  assert.ok(decision.limitations.includes("thin_dimensions"));
});

test("a rating outside the calibrated band is a stated limitation, not a refusal", () => {
  const decision = decideCoverage(spread(60), [dimension()], { providerRating: 2600 });
  assert.equal(decision.ratingInCalibratedRange, false);
  assert.ok(decision.limitations.includes("outside_calibrated_rating"));
  // The report still exists. Platform spec 3.2: such a player still sees
  // objective facts about their own games.
  assert.ok(decision.eligibleGames > 0);
});

test("an unknown rating is unknown, not assumed out of range", () => {
  const decision = decideCoverage(spread(60), [dimension()], { providerRating: null });
  assert.equal(decision.ratingInCalibratedRange, null);
  assert.ok(!decision.limitations.includes("outside_calibrated_rating"));
});

test("one time control and no clocks are named separately", () => {
  const decision = decideCoverage(
    Array.from({ length: 60 }, (_, i) =>
      game({ playedAt: daysAgo(i * 3), speed: "bullet", hasClock: false }),
    ),
    [dimension()],
    { providerRating: 1500 },
  );
  assert.ok(decision.limitations.includes("single_speed"));
  assert.ok(decision.limitations.includes("no_clock_data"));
});

test("a weekend of games is described as a period, not a habit", () => {
  const decision = decideCoverage(
    Array.from({ length: 60 }, () => game({ playedAt: daysAgo(1) })),
    [dimension()],
    { providerRating: 1500 },
  );
  assert.ok(decision.limitations.includes("narrow_date_range"));
});

test("phases nobody reached are named", () => {
  const decision = decideCoverage(
    spread(60, { reachedEndgame: false, reachedMiddlegame: false }),
    [dimension()],
    { providerRating: 1500 },
  );
  assert.ok(decision.limitations.includes("few_endgames"));
  assert.ok(decision.limitations.includes("few_middlegames"));
  assert.equal(decision.endgameReachCount, 0);
});

test("eligible games never exceed total, and reach never exceeds eligible", () => {
  const games = [...spread(40), ...spread(20, { eligible: false })];
  const decision = decideCoverage(games, [dimension()], { providerRating: 1500 });
  assert.ok(decision.eligibleGames <= decision.totalGames);
  assert.ok(decision.middlegameReachCount <= decision.eligibleGames);
  assert.ok(decision.clockAvailableGames <= decision.eligibleGames);
});

test("a thin dimension explains itself in observations, not in adjectives", () => {
  const decision = decideCoverage(
    spread(60),
    [dimension({ observationCount: 1, effectiveCount: 1 })],
    { providerRating: 1500 },
  );
  const thin = decision.dimensions[0]!;
  assert.equal(thin.state, "insufficient");
  assert.ok(thin.limitationReason?.includes("1"));
});

test("a sufficient dimension carries no limitation reason", () => {
  const decision = decideCoverage(spread(60), [dimension()], { providerRating: 1500 });
  assert.equal(decision.dimensions[0]!.state, "sufficient");
  assert.equal(decision.dimensions[0]!.limitationReason, null);
});

test("every limitation has a sentence a person can read", () => {
  for (const key of Object.keys(LIMITATION_TEXT)) {
    const text = LIMITATION_TEXT[key as keyof typeof LIMITATION_TEXT];
    assert.ok(text.length > 30, `${key} has no usable sentence`);
    assert.ok(!/\byou (avoid|refuse|never)\b/i.test(text), `${key} judges the player`);
  }
});

// ---------------------------------------------------------------------------
// The diagnostic
// ---------------------------------------------------------------------------

function uncertain(key: string, width: number, positions = 4): UncertainDimension {
  return {
    dimensionKey: key,
    intervalWidth: width,
    estimate: 0.5,
    findingId: null,
    candidates: Array.from({ length: positions }, (_, i) => ({
      corePositionId: `${key}-${i}`,
      fen: "8/8/8/8/8/8/8/K6k w - - 0 1",
      expectedUci: "a1b1",
      acceptableUci: ["a1b2"],
      playerMishandled: i === 0,
    })),
  };
}

test("the session is bounded by the policy", () => {
  const items = selectItems([
    uncertain("a", 0.5, 20),
    uncertain("b", 0.4, 20),
    uncertain("c", 0.3, 20),
    uncertain("d", 0.2, 20),
    uncertain("e", 0.1, 20),
  ]);
  assert.ok(items.length <= DIAGNOSTIC_POLICY.itemCount);
});

test("no single dimension consumes the session", () => {
  const items = selectItems([uncertain("a", 0.9, 20), uncertain("b", 0.8, 20)]);
  const perDimension = new Map<string, number>();
  for (const item of items) {
    perDimension.set(item.dimensionKey, (perDimension.get(item.dimensionKey) ?? 0) + 1);
  }
  for (const [key, count] of perDimension) {
    assert.ok(
      count <= DIAGNOSTIC_POLICY.maxItemsPerDimension,
      `${key} took ${count} of the session`,
    );
  }
});

test("the most uncertain dimension is asked about first", () => {
  const items = selectItems([uncertain("narrow", 0.05), uncertain("wide", 0.6)]);
  assert.equal(items[0]!.dimensionKey, "wide");
});

test("selection is deterministic, so a reload is the same examination", () => {
  const dimensions = [uncertain("a", 0.5), uncertain("b", 0.5), uncertain("c", 0.3)];
  assert.deepEqual(selectItems(dimensions), selectItems(dimensions));
});

test("no position is asked twice", () => {
  const items = selectItems([uncertain("a", 0.5), uncertain("b", 0.4)]);
  const ids = items.map((item) => item.corePositionId);
  assert.equal(new Set(ids).size, ids.length);
});

test("every item names the uncertainty it investigates", () => {
  for (const item of selectItems([uncertain("fork_recognize", 0.5)])) {
    assert.ok(item.dimensionKey.length > 0, "an item investigated nothing");
    assert.ok(describePurpose(item.purpose, item.dimensionKey).length > 20);
  }
});

test("a position the player got wrong is presented as exactly that", () => {
  const items = selectItems([uncertain("a", 0.5)]);
  assert.equal(items[0]!.purpose, "earlier_mishandled");
  assert.ok(describePurpose("earlier_mishandled", "a").includes("your own games"));
});

test("the best move, an acceptable move and a bad move score differently", () => {
  const item = { expectedUci: "e2e4", acceptableUci: ["d2d4"] };
  const best = scoreAttempt(item, { moveUci: "e2e4", thinkTimeMs: 5_000, hintsUsed: 0 });
  const okay = scoreAttempt(item, { moveUci: "d2d4", thinkTimeMs: 5_000, hintsUsed: 0 });
  const bad = scoreAttempt(item, { moveUci: "a2a3", thinkTimeMs: 5_000, hintsUsed: 0 });
  assert.equal(best.score, 1);
  assert.equal(best.correct, true);
  assert.ok(okay.score > 0 && okay.score < 1, "a good-but-not-best move was collapsed");
  assert.equal(okay.correct, true);
  assert.equal(bad.score, 0);
  assert.equal(bad.correct, false);
});

test("a hinted answer is worth less than an unhinted one", () => {
  const item = { expectedUci: "e2e4", acceptableUci: [] as string[] };
  const clean = scoreAttempt(item, { moveUci: "e2e4", thinkTimeMs: 1_000, hintsUsed: 0 });
  const hinted = scoreAttempt(item, { moveUci: "e2e4", thinkTimeMs: 1_000, hintsUsed: 2 });
  assert.ok(hinted.score < clean.score);
  assert.ok(hinted.score > 0, "the player did play the move");
});

test("the timed window is reported without changing the score", () => {
  const item = { expectedUci: "e2e4", acceptableUci: [] as string[] };
  const fast = scoreAttempt(item, { moveUci: "e2e4", thinkTimeMs: 1_000, hintsUsed: 0 });
  const slow = scoreAttempt(item, { moveUci: "e2e4", thinkTimeMs: 120_000, hintsUsed: 0 });
  assert.equal(fast.withinTimedWindow, true);
  assert.equal(slow.withinTimedWindow, false);
  assert.equal(fast.score, slow.score, "thinking longer was scored as a worse answer");
});

test("progress points at the next unanswered item", () => {
  const items = [{ ordinal: 0 }, { ordinal: 1 }, { ordinal: 2 }];
  assert.deepEqual(sessionProgress(items, [0]), {
    total: 3,
    answered: 1,
    complete: false,
    nextOrdinal: 1,
  });
  assert.deepEqual(sessionProgress(items, [0, 1, 2]), {
    total: 3,
    answered: 3,
    complete: true,
    nextOrdinal: null,
  });
});

// ---------------------------------------------------------------------------
// The baseline report
// ---------------------------------------------------------------------------

const COVERAGE = decideCoverage(spread(20), [dimension({ observationCount: 4, effectiveCount: 4 })], {
  providerRating: 1500,
});

const REPORT_INPUT = {
  coverage: COVERAGE,
  findings: [
    { id: "f1", findingType: "strength", priority: 80 },
    { id: "f2", findingType: "foundational_miss", priority: 90 },
    { id: "f3", findingType: "insufficient_evidence", priority: 10 },
  ],
  estimates: [{ id: "e1", dimensionKey: "fork_recognize", estimate: 0.6 }],
  trajectorySnapshotId: "t1",
  diagnosticSessionId: "d1",
};

test("coverage is laid out before the conclusions, not after them", () => {
  const items = buildReport(REPORT_INPUT);
  const firstCoverage = items.findIndex((item) => item.section === "coverage");
  const firstConclusion = items.findIndex(
    (item) => item.section === "strengths" || item.section === "constraints",
  );
  assert.ok(firstCoverage >= 0, "a limited report stated no limitation");
  assert.ok(firstCoverage < firstConclusion, "the limitations were buried below the findings");
});

test("every coverage item is always visible", () => {
  for (const item of buildReport(REPORT_INPUT)) {
    if (item.itemKind !== "coverage") continue;
    assert.equal(item.entitlementKey, "always", `${item.coverageDimensionKey} is redactable`);
  }
});

test("no plan can redact a coverage item", () => {
  const items = buildReport(REPORT_INPUT);
  const coverageCount = items.filter((item) => item.itemKind === "coverage").length;
  for (const plan of ["free", "pro"] as const) {
    const redacted = redactForPlan(items, plan);
    assert.equal(
      redacted.items.filter((item) => item.itemKind === "coverage").length,
      coverageCount,
      `${plan} lost a coverage item`,
    );
  }
});

test("a free reader is told that something was withheld, and how much", () => {
  const redacted = redactForPlan(buildReport(REPORT_INPUT), "free");
  assert.ok(redacted.items.length > 0);
  assert.ok(redacted.withheld.length > 0, "detail vanished with no sign it existed");
  for (const entry of redacted.withheld) {
    assert.ok(entry.count > 0);
    assert.ok(entry.section.length > 0);
  }
});

test("a pro reader is withheld nothing", () => {
  const redacted = redactForPlan(buildReport(REPORT_INPUT), "pro");
  assert.deepEqual(redacted.withheld, []);
});

test("every plan includes the always tier", () => {
  for (const plan of ["free", "pro"] as const) {
    assert.ok(PLAN_ENTITLEMENTS[plan].includes("always"));
  }
});

test("display order is unique within a section", () => {
  const seen = new Set<string>();
  for (const item of buildReport(REPORT_INPUT)) {
    const key = `${item.section}:${item.displayOrder}`;
    assert.ok(!seen.has(key), `two items at ${key}`);
    seen.add(key);
  }
});

test("the manifest hash ignores order and notices a changed reference", () => {
  const items = buildReport(REPORT_INPUT);
  assert.equal(manifestHash(items), manifestHash([...items].reverse()));
  const tampered = items.map((item, i) => (i === 0 ? { ...item, findingId: "other" } : item));
  assert.notEqual(manifestHash(items), manifestHash(tampered));
});

test("the headline leads with the sample size, not with a verdict", () => {
  const thin = decideCoverage(spread(3), [dimension()], { providerRating: 1500 });
  assert.ok(headline(thin).includes("3"));
  assert.ok(/not have enough/i.test(headline(thin)));
  const healthy = decideCoverage(spread(60), [dimension()], { providerRating: 1500 });
  assert.ok(headline(healthy).includes("60"));
});

test("the policies are frozen", () => {
  assert.equal(Object.isFrozen(COVERAGE_POLICY), true);
  assert.equal(Object.isFrozen(DIAGNOSTIC_POLICY), true);
});

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`onboarding:unit — ${failures.length} failed, ${passed} passed`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`onboarding:unit — ${passed}/${passed} passed`);

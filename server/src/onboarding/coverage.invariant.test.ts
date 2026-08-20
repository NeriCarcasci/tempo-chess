import assert from "node:assert/strict";
import { test } from "node:test";
import { COVERAGE_POLICY, LIMITATIONS } from "./contract.js";
import { LIMITATION_TEXT, decideCoverage, type GameFacts } from "./coverage.js";

function games(count: number): GameFacts[] {
  const speeds = ["bullet", "blitz", "rapid", "classical"];
  return Array.from({ length: count }, (_, index) => ({
    // Spread across months, so `narrow_date_range` does not fire.
    playedAt: new Date(Date.UTC(2026, 1, 1 + index)),
    speed: speeds[index % speeds.length]!,
    hasClock: true,
    reachedMiddlegame: true,
    reachedEndgame: true,
    eligible: true,
  }));
}

test("a plentiful archive with nothing measured still names why it is limited", () => {
  // This is the live shape: 98 eligible games, no concept detector, so no
  // dimension exists to be sufficient.
  const decision = decideCoverage(games(98), [], { providerRating: 1500 });
  assert.equal(decision.overallState, "limited");
  assert.deepEqual(decision.limitations, ["no_measured_dimensions"]);
});

test("a report that is not sufficient always names a limitation", () => {
  // `coverage_limitation_stated` in the schema: overall_state = 'sufficient'
  // OR cardinality(limitations) > 0. The decision has to satisfy it by
  // construction, not by luck.
  for (const count of [0, 1, 4, 5, 20, 49, 50, 98, 400]) {
    for (const rating of [null, 800, 1500, 4000]) {
      const decision = decideCoverage(games(count), [], { providerRating: rating });
      if (decision.overallState !== "sufficient") {
        assert.ok(
          decision.limitations.length > 0,
          `${count} games at rating ${rating} produced ${decision.overallState} with no limitation`,
        );
      }
    }
  }
});

test("every limitation the decision can emit has a sentence for a person", () => {
  for (const limitation of LIMITATIONS) {
    assert.equal(typeof LIMITATION_TEXT[limitation], "string");
    assert.ok(LIMITATION_TEXT[limitation].length > 0);
  }
});

test("thin dimensions and no dimensions are different answers", () => {
  const thin = decideCoverage(games(98), [{
    dimensionKey: "back_rank_defence",
    observationCount: 1,
    effectiveCount: 1,
    earliestPlayedAt: new Date(Date.UTC(2026, 1, 1)),
    latestPlayedAt: new Date(Date.UTC(2026, 3, 1)),
  }], { providerRating: 1500 });
  assert.ok(thin.limitations.includes("thin_dimensions"));
  assert.ok(!thin.limitations.includes("no_measured_dimensions"));
  assert.ok(COVERAGE_POLICY.minimumDimensionObservations > 1);
});

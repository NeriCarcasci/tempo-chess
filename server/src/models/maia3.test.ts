import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CONTINUATION_RATINGS, isContinuationRating } from "./continuation-rating.js";
import { Maia3Engine } from "./maia3.js";
import { normalizePolicy, stablePolicyMove } from "./policy.js";

const bridgePath = fileURLToPath(new URL("./fixtures/fake-maia3-bridge.mjs", import.meta.url));

test("continuation strengths are a closed set of cache-friendly rating bands", () => {
  assert.deepEqual(CONTINUATION_RATINGS, [800, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2400]);
  for (const rating of CONTINUATION_RATINGS) assert.equal(isContinuationRating(rating), true);
  for (const rating of [799, 801, 1500, 2399, 2401]) assert.equal(isContinuationRating(rating), false);
});

test("Maia-3 bridge starts once and serializes rating-conditioned requests", async () => {
  const engine = new Maia3Engine({
    pythonPath: process.execPath,
    bridgePath,
    checkpointPath: "unused-by-fixture",
    timeoutMs: 5_000,
  });
  try {
    const [lower, higher] = await Promise.all([
      engine.inferPolicy("8/8/8/8/8/8/8/K6k w - - 0 1", 1200),
      engine.inferPolicy("8/8/8/8/8/8/8/K6k w - - 0 1", 1800),
    ]);
    assert.equal(lower.policy.moves[0]?.uci, "d2d4");
    assert.equal(lower.modelRating, 1200);
    assert.equal(higher.policy.moves[0]?.uci, "e2e4");
    assert.equal(higher.modelRating, 1800);
  } finally {
    engine.stop();
  }
});

test("continuation sampling is stable for a turn and always selects a retained move", () => {
  const policy = normalizePolicy([
    { uci: "e2e4", probability: 0.5 },
    { uci: "d2d4", probability: 0.3 },
    { uci: "g1f3", probability: 0.2 },
  ]);
  const first = stablePolicyMove(policy, "position:turn_000001");
  assert.equal(stablePolicyMove(policy, "position:turn_000001"), first);
  assert.ok(policy.moves.some((move) => move.uci === first));
});

import assert from "node:assert/strict";
import {
  calculateMastery,
  canonicalPositionKey,
  classifyOpeningDecision,
  splitOpeningName,
} from "./model.js";

const transpositionA = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/2N5/PPPP1PPP/R1BQKBNR w KQkq - 2 3";
const transpositionB = "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/2N5/PPPP1PPP/R1BQKBNR w KQkq - 9 27";
assert.equal(canonicalPositionKey(transpositionA), canonicalPositionKey(transpositionB));

const tiny = calculateMastery({ opportunities: 1, acceptable: 0 });
assert.equal(tiny.status, "emerging");
assert.ok(tiny.mastery > 40, "small samples shrink toward the explicit positive prior");
assert.ok(tiny.evidence < 20);

const established = calculateMastery({
  opportunities: 12,
  acceptable: 3,
  weightedOpportunities: 10,
  weightedAcceptable: 2.5,
  recentOpportunities: 4,
  recentAcceptable: 1,
  historicalOpportunities: 8,
  historicalAcceptable: 6,
  averageLossCp: 118.6,
});
assert.equal(established.status, "decaying");
assert.ok(established.evidence > tiny.evidence);
assert.equal(established.averageLossCp, 119);

assert.deepEqual(splitOpeningName("Scotch Game: Schmidt Variation"), {
  family: "Scotch Game",
  variation: "Schmidt Variation",
});

assert.deepEqual(classifyOpeningDecision({
  actorIsPlayer: true,
  repertoireMove: true,
  catalogueMove: false,
  evaluationLossCp: 240,
}), { acceptable: true, reason: "saved_repertoire_move" });
assert.deepEqual(classifyOpeningDecision({
  actorIsPlayer: true,
  repertoireMove: false,
  catalogueMove: false,
  evaluationLossCp: 42,
}), { acceptable: true, reason: "within_90cp_tolerance" });
assert.deepEqual(classifyOpeningDecision({
  actorIsPlayer: true,
  repertoireMove: false,
  catalogueMove: false,
  evaluationLossCp: 112,
}), { acceptable: false, reason: "lost_112cp" });

console.log("opening mastery model tests passed");

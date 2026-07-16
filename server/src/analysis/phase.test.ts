import assert from "node:assert/strict";
import {
  classifyGamePhases,
  compareProviderDivisions,
  phaseComputationRecord,
  summarizePhaseValidation,
} from "./phase.js";

const positions = [
  { ply: 0, fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1" },
  { ply: 12, fen: "r1bqk2r/pppp1ppp/2n2n2/4p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 6 7" },
  { ply: 20, fen: "r2q1rk1/ppp2ppp/2npbn2/4p3/2B1P3/2NP1N2/PPP2PPP/R1BQR1K1 w - - 2 11" },
  { ply: 40, fen: "8/5pk1/6p1/3r4/3R4/5P2/5KPP/8 w - - 0 21" },
];

const classified = classifyGamePhases({
  positions,
  openingBoundaryPly: 18,
  inputRevision: "pgn:abc",
});
assert.deepEqual(classified.boundaries, [
  { phase: "middlegame", startsAtPly: 19, reason: "opening_book_boundary" },
  { phase: "endgame", startsAtPly: 40, reason: "endgame_low_material" },
]);
assert.equal(classified.byPly.get(12), "opening");
assert.equal(classified.byPly.get(20), "middlegame");
assert.equal(classified.byPly.get(40), "endgame");
assert.equal(classified.provenance.inputRevision, "pgn:abc");

const repeated = classifyGamePhases({ positions, openingBoundaryPly: 18, inputRevision: "pgn:abc" });
assert.deepEqual(repeated.boundaries, classified.boundaries);
assert.deepEqual([...repeated.byPly], [...classified.byPly]);

const comparison = compareProviderDivisions(classified, "lichess", {
  middlegamePly: 20,
  endgamePly: 38,
}, 2);
assert.deepEqual(comparison, {
  provider: "lichess",
  classifierVersion: "tempo-phase-v1",
  middlegameDeltaPly: -1,
  endgameDeltaPly: 2,
  middlegameWithinTolerance: true,
  endgameWithinTolerance: true,
  comparableBoundaryCount: 2,
  withinTolerance: true,
});
assert.deepEqual(summarizePhaseValidation([comparison]), {
  games: 1,
  comparableBoundaries: 2,
  boundariesWithinTolerance: 2,
  agreementRate: 1,
  meanAbsoluteDeltaPly: 1.5,
});

const firstRecord = phaseComputationRecord(classified, new Date("2026-07-16T12:00:00Z"));
const replacement = phaseComputationRecord(classified, new Date("2026-07-17T12:00:00Z"), firstRecord);
assert.equal(replacement.supersedesClassifierVersion, "tempo-phase-v1");
assert.equal(replacement.inputRevision, "pgn:abc");

const inferred = classifyGamePhases({ positions });
assert.deepEqual(inferred.boundaries[0], {
  phase: "middlegame",
  startsAtPly: 20,
  reason: "opening_position_developed",
});

assert.throws(() => classifyGamePhases({
  positions: [{ ply: 0, fen: "9/8/8/8/8/8/8/8 w - - 0 1" }],
}), /Invalid FEN/);
assert.throws(() => classifyGamePhases({ positions: [] }), /at least one position/);
assert.throws(() => classifyGamePhases({ positions, openingBoundaryPly: 41 }), /Invalid opening boundary/);
assert.throws(() => classifyGamePhases({
  positions: [{ ply: 0, fen: "8/8/8/8/8/8/8/8 w - - 0 1" }],
}), /Invalid FEN/);

console.log("phase tests passed");

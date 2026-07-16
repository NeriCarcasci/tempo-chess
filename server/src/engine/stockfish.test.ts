import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  ANALYSIS_PROFILES,
  Engine,
  analysisCacheKey,
  parseUciInfo,
  type EngineProvenance,
} from "./stockfish.js";

const primary = parseUciInfo(
  "info depth 18 seldepth 27 multipv 1 score cp 42 wdl 381 600 19 nodes 500000 nps 1250000 time 400 pv e2e4 e7e5",
);
assert.deepEqual(primary, {
  rank: 1,
  depth: 18,
  selDepth: 27,
  nodes: 500000,
  nps: 1250000,
  engineTimeMs: 400,
  evalCp: 42,
  mate: undefined,
  wdl: [381, 600, 19],
  pv: ["e2e4", "e7e5"],
});

const mate = parseUciInfo(
  "info depth 21 multipv 2 score mate -3 nodes 12345 nps 99999 time 123 pv h7h8q",
);
assert.equal(mate?.rank, 2);
assert.equal(mate?.mate, -3);
assert.equal(mate?.evalCp, undefined);
assert.deepEqual(mate?.pv, ["h7h8q"]);

assert.equal(parseUciInfo("bestmove e2e4"), undefined);
assert.equal(parseUciInfo("info string NNUE evaluation"), undefined);

const provenance: EngineProvenance = {
  engine: "stockfish",
  engineName: "Stockfish 18",
  engineVersion: "18",
  binarySha256: "abc",
  network: "nn-1234.nnue",
  networkHash: "1234",
  profileId: "screening",
  profileVersion: 1,
  limit: { type: "nodes", value: 50_000 },
  multiPv: 1,
  threads: 1,
  hashMb: 64,
  workerRevision: "revision-a",
  cacheProvenance: "tempo",
};
assert.equal(analysisCacheKey(provenance), analysisCacheKey({ ...provenance, workerRevision: "revision-b" }));
assert.notEqual(
  analysisCacheKey(provenance),
  analysisCacheKey({ ...provenance, profileVersion: 2 }),
  "incompatible profile versions must not share cache entries",
);
assert.notEqual(
  analysisCacheKey(provenance),
  analysisCacheKey({ ...provenance, binarySha256: "different" }),
  "different engine binaries must not share cache entries",
);

const fixture = fileURLToPath(new URL("./stockfish-fixture.cjs", import.meta.url));
const engine = new Engine(process.execPath, [fixture]);
try {
  const evaluation = await engine.analyze(
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1",
    ANALYSIS_PROFILES.deep,
  );
  assert.equal(evaluation.best, "e7e5");
  assert.equal(evaluation.evalCp, -35, "scores must be normalized to White's perspective");
  assert.deepEqual(evaluation.wdl, [50, 650, 300]);
  assert.equal(evaluation.nodes, 500000);
  assert.equal(evaluation.nps, 1000000);
  assert.equal(evaluation.engineTimeMs, 500);
  assert.equal(evaluation.candidates.length, 3);
  assert.equal(evaluation.candidates[2].mate, 4);
  assert.equal(evaluation.provenance.profileId, "deep");
  assert.equal(evaluation.provenance.profileVersion, 1);
  assert.equal(evaluation.provenance.binarySha256?.length, 64);
  assert.equal(evaluation.provenance.networkHash, "deadbeef");
  assert.equal(evaluation.cacheKey.length, 64);
} finally {
  engine.quit();
}

console.log("PASS  Stockfish UCI info contract");

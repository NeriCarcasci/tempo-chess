import assert from "node:assert/strict";
import {
  createCanonicalGameId,
  createPgnFingerprint,
  validateNormalizedGame,
} from "./canonical.js";
import type { NormalizedGame, NormalizedMove } from "./types.js";
import { classifyDuplicate, type StoredGameIdentity } from "./dedup.js";

const moves = [
  { ply: 1, uci: "e2e4", fenBefore: "standard-start" },
  { ply: 2, uci: "e7e5", fenBefore: "after-e4" },
];

const fingerprint = createPgnFingerprint({
  moves,
  whiteUsername: " Alice ",
  blackUsername: "BOB",
  result: "win",
  connectedColor: "white",
  playedAt: new Date("2026-07-16T12:00:00.000Z"),
});
assert.equal(
  fingerprint,
  createPgnFingerprint({
    moves: [...moves].reverse(),
    whiteUsername: "alice",
    blackUsername: "bob",
    result: "loss",
    connectedColor: "black",
    playedAt: new Date("2026-07-16T12:00:00.000Z"),
  }),
  "perspective and PGN ordering do not change identity",
);
assert.notEqual(
  fingerprint,
  createPgnFingerprint({
    moves: [moves[0], { ...moves[1], uci: "c7c5" }],
    whiteUsername: "alice",
    blackUsername: "bob",
    result: "win",
    connectedColor: "white",
    playedAt: new Date("2026-07-16T12:01:00.000Z"),
  }),
  "different normalized replays have different fingerprints",
);
assert.equal(
  fingerprint,
  createPgnFingerprint({
    moves,
    whiteUsername: "different-handle",
    blackUsername: "another-provider-handle",
    result: "win",
    connectedColor: "white",
    playedAt: new Date("2026-07-16T12:01:00.123Z"),
  }),
  "provider handles and timestamp semantics do not hide identical imported PGNs",
);

assert.equal(
  createCanonicalGameId("lichess", "abc123"),
  createCanonicalGameId("lichess", "abc123"),
);
assert.notEqual(
  createCanonicalGameId("lichess", "abc123"),
  createCanonicalGameId("chesscom", "abc123"),
);

const stored: StoredGameIdentity = {
  gameId: "game-1",
  userId: "user-1",
  accountId: "account-1",
  platform: "lichess",
  platformGameId: "abc123",
  canonicalGameId: createCanonicalGameId("lichess", "abc123"),
  pgnFingerprint: fingerprint,
};
assert.deepEqual(
  classifyDuplicate({ ...stored, accountId: "account-2" }, [stored]),
  { kind: "provider-reimport", gameId: "game-1", attachAccountSource: true },
);
assert.deepEqual(
  classifyDuplicate(
    {
      ...stored,
      accountId: "account-2",
      platform: "chesscom",
      platformGameId: "999",
      canonicalGameId: createCanonicalGameId("chesscom", "999"),
    },
    [stored],
  ),
  { kind: "fingerprint-candidate", gameId: "game-1", autoMerge: false },
  "same replay across providers is detected but not automatically merged",
);
assert.deepEqual(
  classifyDuplicate({ ...stored, userId: "user-2" }, [stored]),
  { kind: "new" },
  "deduplication never crosses Tempo users",
);

const normalizedMoves: NormalizedMove[] = [
  {
    ply: 1,
    moveNumber: 1,
    color: "white",
    uci: "e2e4",
    san: "e4",
    fenBefore: "8/8/8/8/8/8/8/8 w - - 0 1",
    fenAfter: "8/8/8/8/8/8/8/8 b - - 0 1",
    clockMs: null,
    thinkTimeMs: null,
    providerEvaluation: null,
    annotations: { comment: null, nags: [], raw: {} },
  },
  {
    ply: 2,
    moveNumber: 1,
    color: "black",
    uci: "e7e5",
    san: "e5",
    fenBefore: "8/8/8/8/8/8/8/8 b - - 0 1",
    fenAfter: "8/8/8/8/8/8/8/8 w - - 0 2",
    clockMs: 0,
    thinkTimeMs: 0,
    providerEvaluation: null,
    annotations: { comment: null, nags: [], raw: {} },
  },
];
const normalizedGame: NormalizedGame = {
  schemaVersion: 1,
  canonicalGameId: createCanonicalGameId("lichess", "abc123"),
  pgnFingerprint: createPgnFingerprint({
    moves: normalizedMoves,
    whiteUsername: "alice",
    blackUsername: "bob",
    result: "win",
    connectedColor: "white",
    playedAt: new Date("2026-07-16T12:00:00.000Z"),
  }),
  provenance: {
    provider: "lichess",
    platformGameId: "abc123",
    accountUsername: "Alice",
    accountProviderId: "alice",
    sourceUrl: null,
    fetchedAt: new Date("2026-07-16T12:01:00.000Z"),
  },
  players: {
    white: { username: "alice", providerId: "alice", rating: 1500 },
    black: { username: "bob", providerId: "bob", rating: 1500 },
  },
  providerAccuracy: null,
  moves: normalizedMoves,
  platform: "lichess",
  platformGameId: "abc123",
  url: null,
  playedAt: new Date("2026-07-16T12:00:00.000Z"),
  color: "white",
  result: "win",
  termination: null,
  speed: "rapid",
  timeControl: "600+0",
  userRating: 1500,
  opponentUsername: "bob",
  opponentRating: 1500,
  eco: null,
  openingName: null,
  plyCount: 2,
  pgn: "PGN",
};
assert.equal(validateNormalizedGame(normalizedGame), normalizedGame);
assert.throws(
  () => validateNormalizedGame({ ...normalizedGame, canonicalGameId: "wrong" }),
  /canonicalGameId is invalid/,
);

const blackInitialMove: NormalizedMove = {
  ...normalizedMoves[0],
  color: "black",
  moveNumber: 23,
  fenBefore: "8/8/8/8/8/8/8/8 b - - 0 23",
  fenAfter: "8/8/8/8/8/8/8/8 w - - 0 24",
};
const blackInitialGame: NormalizedGame = {
  ...normalizedGame,
  moves: [blackInitialMove],
  plyCount: 1,
  pgnFingerprint: createPgnFingerprint({
    moves: [blackInitialMove],
    whiteUsername: "alice",
    blackUsername: "bob",
    result: "win",
    connectedColor: "white",
    playedAt: normalizedGame.playedAt,
  }),
};
assert.equal(validateNormalizedGame(blackInitialGame), blackInitialGame);

console.log("canonical ingestion identity tests passed");

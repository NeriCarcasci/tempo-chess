/**
 * `npm run positions:unit` — the core key and the occurrence chain.
 *
 * Offline and deterministic. These are the chess-correctness cases the epic
 * names: legal en passant, castling rights, repetition over transpositions, the
 * 50/75-move counters, and a chain that is exactly ply+1 and unbroken.
 */

import { strict as assert } from "node:assert";
import { Chess } from "chessops/chess";
import { parseFen, INITIAL_FEN } from "chessops/fen";
import {
  chainIsSound,
  coreKey,
  coreKeyHash,
  materializeReplay,
  ReplayMaterializationError,
} from "./canonical.js";

let passed = 0;
const failures: string[] = [];

function check(name: string, body: () => string): void {
  try {
    const detail = body();
    passed += 1;
    console.log(`ok   ${name} — ${detail}`);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    console.log(`FAIL ${name}`);
  }
}

function positionFrom(fen: string): Chess {
  const setup = parseFen(fen);
  if (setup.isErr) throw new Error(`bad fen: ${fen}`);
  const position = Chess.fromSetup(setup.value);
  if (position.isErr) throw new Error(`illegal position: ${fen}`);
  return position.value;
}

console.log("cd server && npm run positions:unit\n");

check("a chain is exactly ply+1 and unbroken", () => {
  const replay = materializeReplay({
    moves: [{ uci: "e2e4" }, { uci: "e7e5" }, { uci: "g1f3" }],
  });
  assert.equal(replay.occurrences.length, 4);
  assert.equal(replay.transitions.length, 3);
  assert.equal(chainIsSound(replay, 3), true);
  assert.equal(replay.occurrences[0].ply, 0);
  assert.equal(replay.transitions[0].san, "e4");
  return "3 moves, 4 occurrences, 3 transitions, SAN from the position before the move";
});

check("the core key drops the clocks but keeps the board", () => {
  const position = positionFrom(INITIAL_FEN);
  const key = coreKey(position);
  assert.equal(key, "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -");
  assert.equal(key.split(" ").length, 4, "the key kept a clock field");
  return key.slice(0, 40) + "...";
});

check("an en-passant square is kept only when a capture is legal", () => {
  // Black pawn on d4 can take e3 en passant: the square is part of the position.
  const capturable = positionFrom("4k3/8/8/8/3pP3/8/8/4K3 b - e3 0 1");
  assert.equal(coreKey(capturable).endsWith(" e3"), true, "a legal en passant was dropped");

  // Same double-step, but no black pawn beside it: the FEN still records e3,
  // and treating it as part of the position would split one position in two.
  const notCapturable = positionFrom("4k3/8/8/8/4P3/8/8/4K3 b - e3 0 1");
  assert.equal(coreKey(notCapturable).endsWith(" -"), true, "an unusable en passant was kept");
  return "e3 kept when takeable, dropped when not";
});

check("a position reached with and without a spurious en passant is one position", () => {
  const withSquare = positionFrom("4k3/8/8/8/4P3/8/8/4K3 b - e3 0 1");
  const without = positionFrom("4k3/8/8/8/4P3/8/8/4K3 b - - 0 1");
  assert.equal(coreKey(withSquare), coreKey(without));
  assert.equal(coreKeyHash(coreKey(withSquare)), coreKeyHash(coreKey(without)));
  return "identical core key and hash";
});

check("castling rights are part of the position", () => {
  const both = positionFrom("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
  const none = positionFrom("r3k2r/8/8/8/8/8/8/R3K2R w - - 0 1");
  assert.notEqual(coreKey(both), coreKey(none));
  // Moving the king forfeits the right, so the same board is a different core.
  const replay = materializeReplay({
    initialFen: "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1",
    moves: [{ uci: "e1e2" }, { uci: "e8e7" }, { uci: "e2e1" }, { uci: "e7e8" }],
  });
  assert.notEqual(replay.occurrences[0].coreKey, replay.occurrences[4].coreKey);
  return "same board, different rights, different core key";
});

check("the same core reached twice counts as a repetition", () => {
  // Knights out and back: the position after 4 plies repeats the start.
  const replay = materializeReplay({
    moves: [{ uci: "g1f3" }, { uci: "g8f6" }, { uci: "f3g1" }, { uci: "f6g8" }],
  });
  assert.equal(replay.occurrences[0].coreKey, replay.occurrences[4].coreKey);
  assert.equal(replay.occurrences[0].repetitionCount, 1);
  assert.equal(replay.occurrences[4].repetitionCount, 2);
  assert.equal(replay.occurrences[4].threefold, false);
  return "occurrence 4 repeats occurrence 0; counts 1 then 2";
});

check("threefold is claimable on the third occurrence", () => {
  const shuffle = [
    "g1f3", "g8f6", "f3g1", "f6g8",
    "g1f3", "g8f6", "f3g1", "f6g8",
  ].map((uci) => ({ uci }));
  const replay = materializeReplay({ moves: shuffle });
  const start = replay.occurrences.filter((o) => o.coreKey === replay.occurrences[0].coreKey);
  assert.equal(start.length, 3);
  assert.deepEqual(start.map((o) => o.repetitionCount), [1, 2, 3]);
  assert.equal(start[2].threefold, true);
  assert.equal(start[1].threefold, false);
  return "3 occurrences of the start; threefold true only on the third";
});

check("the halfmove clock resets on a capture or a pawn move", () => {
  const replay = materializeReplay({
    moves: [{ uci: "g1f3" }, { uci: "g8f6" }, { uci: "e2e4" }],
  });
  assert.equal(replay.occurrences[1].halfmoveClock, 1);
  assert.equal(replay.occurrences[2].halfmoveClock, 2);
  // The pawn move resets it.
  assert.equal(replay.occurrences[3].halfmoveClock, 0);
  return "1, 2, then 0 after a pawn move";
});

check("the 50 and 75 move rules read off the halfmove clock", () => {
  const claimable = materializeReplay({
    initialFen: "4k3/8/8/8/8/8/8/4K2R w K - 99 60",
    moves: [{ uci: "h1h2" }],
  });
  assert.equal(claimable.occurrences[1].halfmoveClock, 100);
  assert.equal(claimable.occurrences[1].fiftyMoveAvailable, true);
  assert.equal(claimable.occurrences[1].seventyFiveMoveForced, false);
  const forced = materializeReplay({
    initialFen: "4k3/8/8/8/8/8/8/4K2R w K - 149 90",
    moves: [{ uci: "h1h2" }],
  });
  assert.equal(forced.occurrences[1].seventyFiveMoveForced, true);
  return "claimable at 100 halfmoves, forced at 150";
});

check("the same core with different history stays distinct in occurrence context", () => {
  const direct = materializeReplay({ moves: [{ uci: "g1f3" }, { uci: "g8f6" }] });
  const viaShuffle = materializeReplay({
    moves: [
      { uci: "g1f3" }, { uci: "g8f6" }, { uci: "f3g1" }, { uci: "f6g8" },
      { uci: "g1f3" }, { uci: "g8f6" },
    ],
  });
  const a = direct.occurrences[2];
  const b = viaShuffle.occurrences[6];
  // Same board, so the same core position -- findable as a transposition.
  assert.equal(a.coreKey, b.coreKey);
  // Different history, so different occurrence context.
  assert.notEqual(a.repetitionCount, b.repetitionCount);
  assert.notEqual(a.ply, b.ply);
  return `same core key; repetition ${a.repetitionCount} vs ${b.repetitionCount}, ply ${a.ply} vs ${b.ply}`;
});

check("a nonstandard start position is replayed from its own FEN", () => {
  const fen = "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1";
  const replay = materializeReplay({ initialFen: fen, moves: [{ uci: "e2e4" }] });
  assert.equal(replay.occurrences[0].fen, fen);
  assert.equal(replay.occurrences.length, 2);
  assert.equal(replay.occurrences[1].coreKey.endsWith(" -"), true);
  return "starts from the given FEN and produces ply+1";
});

check("an illegal move refuses the replay rather than skipping it", () => {
  assert.throws(
    () => materializeReplay({ moves: [{ uci: "e2e4" }, { uci: "e2e4" }] }),
    (error: unknown) =>
      error instanceof ReplayMaterializationError && error.ply === 2 && error.reason === "illegal_move",
  );
  assert.throws(
    () => materializeReplay({ moves: [{ uci: "zzzz" }] }),
    (error: unknown) => error instanceof ReplayMaterializationError,
  );
  assert.throws(
    () => materializeReplay({ initialFen: "not a fen", moves: [] }),
    (error: unknown) =>
      error instanceof ReplayMaterializationError && error.reason === "bad_initial_fen",
  );
  return "illegal, unparsable and bad-FEN all refuse; a chain never has a hole";
});

check("the checksum is deterministic and sensitive to the chain", () => {
  const a = materializeReplay({ moves: [{ uci: "e2e4" }, { uci: "e7e5" }] });
  const b = materializeReplay({ moves: [{ uci: "e2e4" }, { uci: "e7e5" }] });
  const c = materializeReplay({ moves: [{ uci: "d2d4" }, { uci: "d7d5" }] });
  assert.equal(a.checksum, b.checksum);
  assert.notEqual(a.checksum, c.checksum);
  // Clocks are not part of the chain's identity: a re-fetch with clock data
  // must rebuild to the same checksum.
  const withClocks = materializeReplay({
    moves: [{ uci: "e2e4", clockMs: 60_000 }, { uci: "e7e5", clockMs: 59_000 }],
  });
  assert.equal(a.checksum, withClocks.checksum);
  return "same replay same checksum; different moves differ; clocks do not affect it";
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
}

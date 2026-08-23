/**
 * What the play opponent must not get wrong.
 *
 * Three groups, and each is a way this feature could quietly become something
 * else: a client's word taken for the board, a family answered by an engine
 * nobody asked for, or an engine run in a process that is not allowed to.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  IN_PROCESS_ENGINE_ENV,
  MAIA3_LEVELS,
  MOVE_HISTORY_LIMIT,
  OpponentEngineError,
  PLAY_LEVELS,
  STOCKFISH_ELO_FLOOR,
  describeReply,
  levelByKey,
  maia3Level,
  opponentCatalogue,
  resolveGame,
  selectOpponent,
  stockfishOpponent,
} from "./opponent.js";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

// ---------------------------------------------------------------------------
// Move legality
// ---------------------------------------------------------------------------

test("a legal start position resolves with White to move", () => {
  const resolved = resolveGame(START, []);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(resolved.game.turn, "white");
  assert.equal(resolved.game.status, "in_play");
});

test("an unreadable FEN is rejected against the fen field", () => {
  const resolved = resolveGame("not a fen", []);
  assert.equal(resolved.ok, false);
  if (resolved.ok) return;
  assert.equal(resolved.rejection.field, "fen");
});

test("a readable but illegal position is rejected", () => {
  // Parses cleanly and is not chess: Black has no king.
  const resolved = resolveGame("rnbq1bnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQ - 0 1", []);
  assert.equal(resolved.ok, false);
  if (resolved.ok) return;
  assert.equal(resolved.rejection.field, "fen");
  assert.match(resolved.rejection.detail, /legal standard chess position/);
});

test("a position that could not have arisen is refused", () => {
  // Black to move while White is in check. It parses, and it is not a position
  // any game reaches, so an engine asked about it would answer confidently
  // about nothing.
  const resolved = resolveGame("4k3/8/8/8/8/8/4r3/4K3 b - - 0 1", []);
  assert.equal(resolved.ok, false);
  if (resolved.ok) return;
  assert.equal(resolved.rejection.field, "fen");
});

test("the position handed to the engine is the server's, not the client's string", () => {
  // Whatever the client sent, what reaches `position fen` is re-emitted from a
  // setup this server parsed and validated.
  const resolved = resolveGame(`  ${START}  `, []);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(resolved.game.rootFen, START);
});

test("legal moves are replayed and advance the position", () => {
  const resolved = resolveGame(START, ["e2e4", "e7e5", "g1f3"]);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(resolved.game.turn, "black");
  assert.match(resolved.game.fen, /^rnbqkbnr\/pppp1ppp/);
});

test("an illegal move is rejected and names which one", () => {
  const resolved = resolveGame(START, ["e2e4", "e7e5", "e4e6"]);
  assert.equal(resolved.ok, false);
  if (resolved.ok) return;
  assert.equal(resolved.rejection.field, "moves");
  assert.match(resolved.rejection.detail, /move 3/);
});

test("a move that is not even UCI is rejected rather than ignored", () => {
  const resolved = resolveGame(START, ["castle"]);
  assert.equal(resolved.ok, false);
});

test("castling arrives as king-to-g1 and is accepted", () => {
  // Engines emit `e1g1` in standard chess; refusing it would break every game
  // the moment somebody castles.
  const resolved = resolveGame(START, ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5", "e1g1"]);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.match(resolved.game.fen, /RNBQ1RK1/);
});

test("a move played after the game ended is refused", () => {
  // Fool's mate, then one more move.
  const resolved = resolveGame(START, ["f2f3", "e7e5", "g2g4", "d8h4", "e1f2"]);
  assert.equal(resolved.ok, false);
  if (resolved.ok) return;
  assert.equal(resolved.rejection.field, "moves");
});

test("more moves than any real game is refused before the engine starts", () => {
  const resolved = resolveGame(START, Array(MOVE_HISTORY_LIMIT + 1).fill("e2e4"));
  assert.equal(resolved.ok, false);
  if (resolved.ok) return;
  assert.equal(resolved.rejection.field, "moves");
});

test("each way a game ends is reported as itself", () => {
  const cases: Array<[string, string]> = [
    ["rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3", "checkmate"],
    ["7k/5Q2/6K1/8/8/8/8/8 b - - 0 1", "stalemate"],
    ["8/8/8/4k3/8/8/8/4K3 w - - 0 1", "insufficient_material"],
    ["4k3/8/8/8/8/8/3R4/4K3 w - - 100 60", "fifty_move"],
  ];
  for (const [fen, status] of cases) {
    const resolved = resolveGame(fen, []);
    assert.equal(resolved.ok, true, fen);
    if (!resolved.ok) continue;
    assert.equal(resolved.game.status, status, fen);
  }
});

test("an engine reply is checked against the board before it is served", () => {
  const resolved = resolveGame(START, []);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  assert.equal(describeReply(resolved.game.position, "e2e5").ok, false);
  assert.equal(describeReply(resolved.game.position, "wat").ok, false);

  const legal = describeReply(resolved.game.position, "e2e4");
  assert.equal(legal.ok, true);
  if (!legal.ok) return;
  assert.equal(legal.san, "e4");
  assert.match(legal.fen, /^rnbqkbnr\/pppppppp\/8\/8\/4P3/);
  assert.equal(legal.status, "in_play");
});

test("a reply that ends the game says so", () => {
  const resolved = resolveGame(START, ["f2f3", "e7e5", "g2g4"]);
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  const mate = describeReply(resolved.game.position, "d8h4");
  assert.equal(mate.ok, true);
  if (!mate.ok) return;
  assert.equal(mate.san, "Qh4#");
  assert.equal(mate.status, "checkmate");
});

// ---------------------------------------------------------------------------
// Adapter selection
// ---------------------------------------------------------------------------

test("Stockfish answers when nothing forbids it", () => {
  const selection = selectOpponent("stockfish", {});
  assert.equal(selection.ok, true);
  if (!selection.ok) return;
  assert.equal(selection.adapter.family, "stockfish");
});

test("Maia cannot be selected as an in-process opponent", () => {
  const selection = selectOpponent("maia", {});
  assert.equal(selection.ok, false);
  if (selection.ok) return;
  assert.equal(selection.family, "maia");
  assert.equal(selection.unavailable.reason, "not_permitted_here");
  assert.match(selection.unavailable.detail, /continuation service/);
});

test("a deployment without engine_analysis refuses to run an engine", () => {
  const selection = selectOpponent("stockfish", { FORMA_DEPLOYMENT: "forma-api" });
  assert.equal(selection.ok, false);
  if (selection.ok) return;
  assert.equal(selection.unavailable.reason, "not_permitted_here");
});

test("the deployment that owns engine_analysis may run one", () => {
  assert.equal(selectOpponent("stockfish", { FORMA_DEPLOYMENT: "forma-stockfish" }).ok, true);
});

test("another deployment may run one only by saying so explicitly", () => {
  const env = { FORMA_DEPLOYMENT: "forma-api", [IN_PROCESS_ENGINE_ENV]: "true" };
  assert.equal(selectOpponent("stockfish", env).ok, true);
  // Anything other than the exact opt-in leaves the boundary in place, so a
  // half-set or mistyped variable fails closed rather than quietly allowing it.
  assert.equal(
    selectOpponent("stockfish", { ...env, [IN_PROCESS_ENGINE_ENV]: "yes" }).ok,
    false,
  );
});

test("a deployed process that cannot name itself fails closed, override or not", () => {
  for (const env of [
    { K_SERVICE: "something" },
    { K_SERVICE: "something", [IN_PROCESS_ENGINE_ENV]: "true" },
  ]) {
    const selection = selectOpponent("stockfish", env);
    assert.equal(selection.ok, false, JSON.stringify(env));
    if (selection.ok) continue;
    assert.equal(selection.unavailable.reason, "not_permitted_here");
  }
});

// ---------------------------------------------------------------------------
// The level catalogue
// ---------------------------------------------------------------------------

test("Stockfish reports its floor instead of claiming the level", () => {
  const stockfish = stockfishOpponent({ command: "stockfish", env: {} });
  const low = stockfish.levelFor(levelByKey("800")!);
  assert.equal(low.playsAt, STOCKFISH_ELO_FLOOR);
  assert.equal(low.clamped, true);

  const high = stockfish.levelFor(levelByKey("2400")!);
  assert.equal(high.playsAt, 2400);
  assert.equal(high.clamped, false);
});

test("Maia-3 accepts exactly the continuation strengths without clamping", () => {
  assert.deepEqual(MAIA3_LEVELS, PLAY_LEVELS.map((level) => level.nominalRating));
  for (const level of PLAY_LEVELS) {
    assert.deepEqual(maia3Level(level), { ...level, playsAt: level.nominalRating, clamped: false });
  }
});

test("the catalogue describes every family, including the ones it cannot serve", () => {
  const catalogue = opponentCatalogue({});
  assert.deepEqual(
    catalogue.map((entry) => entry.family),
    ["stockfish", "maia"],
  );
  const maia = catalogue.find((entry) => entry.family === "maia")!;
  assert.equal(maia.available, false);
  assert.equal(maia.unavailableReason, "not_configured");
  // Still described: a screen has to be able to say what Maia would be.
  assert.equal(maia.levels.length, PLAY_LEVELS.length);
});

test("the catalogue advertises Maia only when a promoted Maia-3 model exists", () => {
  const maia = opponentCatalogue({}, true).find((entry) => entry.family === "maia")!;
  assert.equal(maia.available, true);
  assert.equal(maia.unavailableReason, null);
  assert.equal(maia.levels.every((level) => !level.clamped), true);
});

// ---------------------------------------------------------------------------
// The Stockfish conversation
// ---------------------------------------------------------------------------

const FIXTURE = fileURLToPath(new URL("./opponent-fixture.cjs", import.meta.url));

function fixtureAdapter(bestmove: string) {
  const log = join(mkdtempSync(join(tmpdir(), "forma-opponent-")), "uci.log");
  return {
    log,
    adapter: stockfishOpponent({ command: process.execPath, args: [FIXTURE, log, bestmove], env: {} }),
  };
}

test("the requested strength reaches the engine, clamped to what it can play", async () => {
  const { log, adapter } = fixtureAdapter("e7e5");
  const reply = await adapter.reply({
    rootFen: START,
    moves: ["e2e4"],
    level: levelByKey("800")!,
    budgetMs: 40,
  });

  assert.equal(reply.uci, "e7e5");
  assert.equal(reply.playsAt, STOCKFISH_ELO_FLOOR);
  assert.equal(reply.clamped, true);
  // Read from the handshake rather than assumed, so the response names the
  // binary that actually answered.
  assert.equal(reply.engine, "Stockfish 18 fixture");

  const said = readFileSync(log, "utf8").split("\n");
  assert.ok(said.includes("setoption name UCI_LimitStrength value true"));
  assert.ok(said.includes(`setoption name UCI_Elo value ${STOCKFISH_ELO_FLOOR}`));
  // The history is replayed rather than collapsed, so repetition and the
  // fifty-move rule stay visible to the search.
  assert.ok(said.includes(`position fen ${START} moves e2e4`));
  assert.ok(said.includes("go movetime 40"));
});

test("a stronger level is passed through unclamped", async () => {
  const { log, adapter } = fixtureAdapter("e7e5");
  const reply = await adapter.reply({
    rootFen: START,
    moves: [],
    level: levelByKey("2200")!,
    budgetMs: 40,
  });
  assert.equal(reply.playsAt, 2200);
  assert.equal(reply.clamped, false);
  const said = readFileSync(log, "utf8").split("\n");
  assert.ok(said.includes("setoption name UCI_Elo value 2200"));
  // No history: the position line carries the FEN alone.
  assert.ok(said.includes(`position fen ${START}`));
});

test("an engine with no move to offer is an engine error, not an empty reply", async () => {
  const { adapter } = fixtureAdapter("(none)");
  await assert.rejects(
    adapter.reply({ rootFen: START, moves: [], level: levelByKey("1200")!, budgetMs: 40 }),
    OpponentEngineError,
  );
});

test("an engine that cannot be started is an engine error", async () => {
  const adapter = stockfishOpponent({ command: "forma-no-such-engine", env: {} });
  await assert.rejects(
    adapter.reply({ rootFen: START, moves: [], level: levelByKey("1200")!, budgetMs: 40 }),
    OpponentEngineError,
  );
});

console.log("PASS  play opponent contract");

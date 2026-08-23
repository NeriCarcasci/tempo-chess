/**
 * `npm run rating:analyse` — the public path's assembler, against fake ports.
 *
 * There is no engine in a unit test and there should not be one: what needs
 * checking here is not Stockfish's opinion but Forma's bookkeeping around it.
 * Does the budget hold? Is a position evaluated once or twice? Does the
 * practical reading refuse when nobody told us who the opponent was, and does
 * it stop refusing when the strength estimate can answer that itself?
 *
 * The PGN is Morphy's opera-box game, used because it is thirty-three plies of
 * real chess with a forced finish, which exercises the terminal position and
 * the short-game path at once.
 */

import { strict as assert } from "node:assert";

import { Chess } from "chess.js";

import { parsePgn } from "../ingest/pgn.js";
import { normalizePolicy } from "../models/policy.js";
import { STRENGTH_POLICY } from "./contract.js";
import { ANALYSIS_BUDGET, analyseGame, type EngineLine, type EnginePort, type PolicyPort } from "./analyse.js";

const failures: string[] = [];
let passed = 0;

function test(name: string, run: () => Promise<void> | void): Promise<void> {
  return Promise.resolve()
    .then(run)
    .then(() => {
      passed += 1;
    })
    .catch((error: unknown) => {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    });
}

const OPERA_GAME = `[Event "Paris"]
[White "Morphy"]
[Black "Allies"]

1.e4 e5 2.Nf3 d6 3.d4 Bg4 4.dxe5 Bxf3 5.Qxf3 dxe5 6.Bc4 Nf6 7.Qb3 Qe7
8.Nc3 c6 9.Bg5 b5 10.Nxb5 cxb5 11.Bxb5+ Nbd7 12.O-O-O Rd8 13.Rxd7 Rxd7
14.Rd1 Qe6 15.Bxd7+ Nxd7 16.Qb8+ Nxb8 17.Rd8# 1-0`;

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * A deterministic engine.
 *
 * Values come from a hash of the position, so the same FEN always answers the
 * same way and a test can assert that a position was evaluated once. Extra
 * lines are spread below the first, which makes every multi-line answer look
 * like a position with a best move and worse alternatives.
 */
function fakeEngine(): EnginePort & { calls: { fen: string; multipv: number }[] } {
  const calls: { fen: string; multipv: number }[] = [];
  return {
    calls,
    async evaluate({ fen, multipv }) {
      calls.push({ fen, multipv });
      let hash = 0;
      for (const char of fen) hash = (hash * 31 + char.charCodeAt(0)) % 1000;
      const top = 0.3 + (hash / 1000) * 0.4;
      const lines: EngineLine[] = [];
      for (let index = 0; index < multipv; index += 1) {
        lines.push({ uci: `x${index}y${index}`, expectedScoreWhite: top - index * 0.12 });
      }
      return lines;
    },
  };
}

/**
 * A policy over the position's actual legal moves.
 *
 * The first version of this fake returned the same three invented moves for
 * every position, so the move the player actually chose was almost never in the
 * distribution and the estimate refused every ply. That is a fake failing, not
 * the estimator failing, and it is worth the extra lines to avoid: a policy
 * port that cannot produce a probability for the move that was played is not
 * exercising anything.
 *
 * Weights are a hash of move and position, raised to a power that grows with
 * the rung, so higher rungs concentrate mass and the ladder discriminates.
 * Nothing here models Maia.
 */
function fakePolicy(): PolicyPort & { calls: number } {
  const port = {
    calls: 0,
    async policy({ fen, rating }: { fen: string; rating: number }) {
      port.calls += 1;
      const legal = new Chess(fen).moves({ verbose: true });
      const sharpness = (rating - 800) / 1600;
      const raw = legal.map((move) => {
        const uci = `${move.from}${move.to}${move.promotion ?? ""}`;
        let hash = 0;
        for (const char of uci + fen) hash = (hash * 31 + char.charCodeAt(0)) % 997;
        return { uci, probability: ((hash % 100) + 1) ** (1 + sharpness * 2) };
      });
      return normalizePolicy(raw);
    },
  };
  return port;
}

// ---------------------------------------------------------------------------

await test("the opera game parses into thirty-three decisions", () => {
  const parsed = parsePgn(OPERA_GAME);
  assert.equal(parsed.warning, undefined);
  assert.equal(parsed.moves.length, 33);
});

await test("every distinct position is evaluated once for screening", async () => {
  const engine = fakeEngine();
  const parsed = parsePgn(OPERA_GAME);
  const result = await analyseGame(parsed.moves, { engine, policy: fakePolicy() });

  // 33 plies share positions: the FEN after one move is the FEN before the
  // next, so a game of n plies has n + 1 distinct positions, not 2n.
  assert.equal(result.cost.screeningPositions, 34);
  const screeningCalls = engine.calls.filter((call) => call.multipv === 1);
  assert.equal(new Set(screeningCalls.map((call) => call.fen)).size, screeningCalls.length);
});

await test("the deep budget is a cap, not a suggestion", async () => {
  const engine = fakeEngine();
  const parsed = parsePgn(OPERA_GAME);
  const result = await analyseGame(parsed.moves, { engine, policy: fakePolicy() });

  const deepSearched = result.input.decisions.filter((decision) => decision.deepSearched).length;
  assert.ok(
    deepSearched <= ANALYSIS_BUDGET.deepPositions,
    `${deepSearched} positions were deep-searched, over the cap`,
  );
  assert.equal(result.input.deepPassRan, true);
});

await test("the policy ladder is asked once per rung per chosen ply", async () => {
  const engine = fakeEngine();
  const policy = fakePolicy();
  const parsed = parsePgn(OPERA_GAME);
  const result = await analyseGame(parsed.moves, { engine, policy });

  // Exactly one inference per distinct (position, rating) pair the plan asked
  // for. Asserting against the plan rather than a hardcoded number keeps this
  // honest when the budget or the selection changes.
  assert.equal(policy.calls, result.plan.policyRequests.length);
  const distinct = new Set(result.plan.policyRequests.map((r) => `${r.fen}|${r.rating}`));
  assert.equal(distinct.size, result.plan.policyRequests.length, "a pair was asked for twice");
});

await test("a game with no declared ratings conditions on how it was played", async () => {
  const engine = fakeEngine();
  const parsed = parsePgn(OPERA_GAME);
  const result = await analyseGame(parsed.moves, { engine, policy: fakePolicy() });

  // Nothing was declared, so both sides fall back to the strength estimate
  // rather than to a default opponent.
  assert.equal(result.conditioning.white.declared, false);
  assert.equal(result.conditioning.black.declared, false);
  assert.ok(result.conditioning.white.rung !== null);
});

await test("a declared rating beats an inferred one", async () => {
  const engine = fakeEngine();
  const parsed = parsePgn(OPERA_GAME);
  const result = await analyseGame(parsed.moves, {
    engine,
    policy: fakePolicy(),
    whiteRating: 1500,
  });
  assert.equal(result.conditioning.white.declared, true);
  assert.equal(result.conditioning.white.rung, 1400);
  assert.equal(result.conditioning.white.outOfDomain, false);
});

await test("a declared rating outside the calibrated range answers and says so", async () => {
  const engine = fakeEngine();
  const parsed = parsePgn(OPERA_GAME);
  const result = await analyseGame(parsed.moves, {
    engine,
    policy: fakePolicy(),
    blackRating: 2700,
  });
  assert.equal(result.conditioning.black.rung, 2400);
  assert.equal(result.conditioning.black.outOfDomain, true);
});

await test("the practical reading is refused when every retained reply holds", async () => {
  // An engine whose lines are all equal has no inadequate reply to price.
  const flat: EnginePort = {
    async evaluate({ multipv }) {
      return Array.from({ length: multipv }, (_, index) => ({
        uci: `x${index}y${index}`,
        expectedScoreWhite: 0.5,
      }));
    },
  };
  const parsed = parsePgn(OPERA_GAME);
  const result = await analyseGame(parsed.moves, { engine: flat, policy: fakePolicy() });
  assert.equal(
    result.input.decisions.every((decision) => decision.reply === null),
    true,
    "a flat engine should price no pressure at all",
  );
});

await test("a truncated game is truncated, not refused", async () => {
  const engine = fakeEngine();
  const parsed = parsePgn(OPERA_GAME);
  const result = await analyseGame(parsed.moves, {
    engine,
    policy: fakePolicy(),
    budget: { ...ANALYSIS_BUDGET, maxPlies: 10 },
  });
  assert.equal(result.input.decisions.length, 10);
});

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`rating:analyse — ${failures.length} failed, ${passed} passed`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`rating:analyse — ${passed}/${passed} passed`);

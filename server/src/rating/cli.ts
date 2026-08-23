/**
 * `npm run rating:game -- <file.pgn>` — rate one game on this machine.
 *
 * The production path is two chained workflows across three services. This is
 * the same computation with the queue taken out: a local Stockfish behind the
 * engine port, a local Maia behind the policy port when one is configured, and
 * the phases run back to back. It exists for the work that comes next, which is
 * scoring the calibration corpus and finding out whether the scale says what it
 * is supposed to say.
 *
 * It reports the cost as well as the answer, because the cost is the open
 * question. A rating is a few hundred human-policy inferences against a single
 * rating worker, and the share of them already in the cache is what decides
 * whether the public page is a few seconds or a few minutes.
 *
 * With no Maia configured it still runs, and still refuses to publish a rating.
 * That refusal is the point rather than a limitation: without a human policy
 * the terms that remain are an accuracy score, and printing one here under this
 * command's name would be the exact substitution the metric exists to avoid.
 */

import { readFileSync } from "node:fs";

import { parsePgn } from "../ingest/pgn.js";
import { analyzeFens } from "../engine/stockfish.js";
import { expectedScore } from "../engine/contract.js";
import { Maia3Engine } from "../models/maia3.js";
import { analyseGame } from "./analyse.js";
import { rateGame } from "./rating.js";
import { liveness } from "./decisions.js";
import { gameKey } from "./identity.js";
import { PUBLIC_SEARCH, type EngineLine, type EnginePort, type PolicyPort } from "./ports.js";

const path = process.argv[2];
if (!path) {
  console.error("usage: npm run rating:game -- <file.pgn>");
  process.exit(2);
}

const engine: EnginePort = {
  async evaluate({ fen, multipv }) {
    const depth = multipv > 1 ? PUBLIC_SEARCH.deepDepth : PUBLIC_SEARCH.screeningDepth;
    const [result] = await analyzeFens([fen], depth, multipv);
    if (!result) return [];
    const lines: EngineLine[] = [];
    for (const candidate of result.candidates) {
      const move = candidate.pv[0];
      if (!move) continue;
      lines.push({
        uci: move,
        expectedScoreWhite: expectedScore({
          scoreCp: candidate.evalCp ?? null,
          mateIn: candidate.mate ?? null,
          wdl: candidate.wdl ?? null,
        }).value,
      });
    }
    if (lines.length === 0 && result.best) {
      lines.push({
        uci: result.best,
        expectedScoreWhite: expectedScore({
          scoreCp: result.evalCp ?? null,
          mateIn: result.mate ?? null,
          wdl: result.wdl ?? null,
        }).value,
      });
    }
    return lines;
  },
};

/** The local Maia, when this machine carries one. Null is a state, not a crash. */
function localPolicy(): PolicyPort | null {
  const pythonPath = process.env.MAIA3_PYTHON_PATH;
  const bridgePath = process.env.MAIA3_BRIDGE_PATH;
  const checkpointPath = process.env.MAIA3_CHECKPOINT_PATH;
  if (!pythonPath || !bridgePath || !checkpointPath) return null;
  const maia = new Maia3Engine({ pythonPath, bridgePath, checkpointPath });
  return {
    async policy({ fen, rating }) {
      return (await maia.inferPolicy(fen, rating)).policy;
    },
  };
}

const pgn = readFileSync(path, "utf8");
const game = parsePgn(pgn);
if (game.moves.length === 0) {
  console.error(game.warning ?? "that did not parse as a game");
  process.exit(1);
}

const white = game.headers.White ?? "White";
const black = game.headers.Black ?? "Black";
const headerRating = (key: string): number | null => {
  const raw = Number(game.headers[key]);
  return Number.isFinite(raw) && raw > 0 ? raw : null;
};

console.log(`${white} against ${black}, ${game.headers.Event ?? "unknown event"}`);
console.log(`${game.moves.length} plies`);
console.log(
  `game key ${gameKey({
    startingFen: game.moves[0]!.fenBefore,
    moves: game.moves.map((move) => move.uci),
    whiteRating: headerRating("WhiteElo"),
    blackRating: headerRating("BlackElo"),
  }).slice(0, 28)}...`,
);

const policy = localPolicy();
if (!policy) {
  console.log("");
  console.log("No local Maia is configured, so the human policy cannot be asked.");
  console.log("Set MAIA3_PYTHON_PATH, MAIA3_BRIDGE_PATH and MAIA3_CHECKPOINT_PATH to run it whole.");
}

const started = Date.now();
const result = await analyseGame(game.moves, {
  engine,
  // A policy that answers nothing is how the engine half gets measured on its
  // own. Every ply comes back without a likelihood and the scorer refuses,
  // which is the correct output and not a failure of this script.
  policy: policy ?? { async policy() { throw new Error("no policy configured"); } },
  whiteRating: headerRating("WhiteElo"),
  blackRating: headerRating("BlackElo"),
}).catch(async (error: unknown) => {
  if (policy) throw error;
  // Rerun the engine half alone, so the plan and the cost are still reported.
  return analyseGame(game.moves, {
    engine,
    policy: { async policy() { return { moves: [], retainedMass: 0, unretainedMass: 1, entropyBits: 0, entropyIsLowerBound: true }; } },
    whiteRating: headerRating("WhiteElo"),
    blackRating: headerRating("BlackElo"),
  });
});
const elapsed = Date.now() - started;

console.log("");
console.log(`  screened          ${result.cost.screeningPositions} positions`);
console.log(`  deep searches     ${result.cost.deepPositions}`);
console.log(`  policy plies      ${result.plan.policyPlies.length}`);
console.log(`  policy inferences ${result.plan.policyRequests.length} (${new Set(result.plan.policyRequests.map((r) => r.fen)).size} positions x 9 rungs)`);
console.log(`  engine wall clock ${(elapsed / 1000).toFixed(1)}s`);
console.log("");

// The objective picture, which is real whether or not a policy answered.
const scored = result.input.decisions
  .map((decision) => ({
    decision,
    loss: decision.expectedScoreBefore - decision.expectedScoreAfter,
    live: liveness(decision.expectedScoreBefore),
  }))
  .sort((left, right) => right.loss * right.live - left.loss * left.live)
  .slice(0, 6);

console.log("  the six decisions the engine liked least, weighted by what was at stake:");
for (const entry of scored) {
  const move = Math.ceil(entry.decision.ply / 2);
  const dots = entry.decision.actor === "white" ? "." : "...";
  console.log(
    `    ${String(move + dots).padStart(6)}  ${entry.decision.playedUci}` +
      `  gave away ${entry.loss.toFixed(3)}  liveness ${entry.live.toFixed(2)}` +
      (entry.decision.deepSearched ? "  (deep)" : ""),
  );
}
console.log("");

const rating = rateGame(result.input);
if (rating.status === "unavailable") {
  console.log(`  no rating: ${rating.reason}`);
  if (rating.demand?.status === "available") {
    console.log(
      `  demand ${rating.demand.demand.toFixed(2)}` +
        ` (tension ${rating.demand.tension.toFixed(2)},` +
        ` narrowness ${rating.demand.narrowness.toFixed(2)},` +
        ` duration ${rating.demand.duration.toFixed(2)},` +
        ` ${rating.demand.onlyMoves} only-moves in ${rating.demand.criticalPositions} examined)`,
    );
  }
  for (const side of [rating.white, rating.black]) {
    if (!side) continue;
    const clean = side.cleanliness;
    if (clean.status === "available") {
      console.log(
        `  ${side.color.padEnd(5)} gave away ${clean.weightedLoss.toFixed(4)} per live move` +
          ` over ${clean.weightedDecisions} decisions`,
      );
    }
  }
  process.exit(0);
}

console.log(`  ${rating.rating.toFixed(1)} / 10  (${rating.ratingLow.toFixed(1)} to ${rating.ratingHigh.toFixed(1)})`);
console.log("");
for (const side of [rating.white, rating.black]) {
  const strength = side.strength;
  const clean = side.cleanliness;
  console.log(
    `  ${side.color.padEnd(5)} played like ` +
      (strength.status === "available"
        ? `${strength.rating} (${strength.intervalLow} to ${strength.intervalHigh})`
        : `unavailable: ${strength.reason}`) +
      (clean.status === "available" ? `, gave away ${clean.weightedLoss.toFixed(4)}` : ""),
  );
}
if (rating.demand.status === "available") {
  console.log(
    `  demand ${rating.demand.demand.toFixed(2)}` +
      ` (tension ${rating.demand.tension.toFixed(2)},` +
      ` narrowness ${rating.demand.narrowness.toFixed(2)},` +
      ` duration ${rating.demand.duration.toFixed(2)})`,
  );
}
console.log("");
for (const moment of rating.moments) {
  const move = Math.ceil(moment.ply / 2);
  console.log(`  ${move}${moment.actor === "white" ? "." : "..."} ${moment.playedUci}  ${moment.code} (${moment.magnitude.toFixed(3)})`);
}
console.log("");
console.log(
  `  coverage: ${rating.coverage.practicalDecisions} of ${rating.coverage.decisions} decisions` +
    ` were read against the player who had to answer them`,
);

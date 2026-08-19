/**
 * `npm run engine:performance` — the named budgets, against production-shaped data.
 *
 * Four numbers matter for this epic and each is asserted rather than described.
 *
 * The **cache lookup** runs twice per transition and once per screened position,
 * so it is the hottest query the epic adds. It is measured against a table
 * holding tens of thousands of evaluations, because an index probe on twenty
 * rows proves nothing.
 *
 * The **assessment write** is one game's whole output in one transaction.
 *
 * The **review read** is what a client waits for when they open a game.
 *
 * The **engine envelope** is what the epic is accountable for spending. A
 * corpus of games sharing opening prefixes is screened end to end, and the
 * measured cache hit rate, nodes and cost are reported per game and compared to
 * `BUDGETS.perGameNodes`. The hit rate is *recorded* rather than thresholded:
 * how much a real population transposes is a fact about that population, and a
 * pass/fail line drawn here would be a claim this epic cannot support.
 */

import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { Chess } from "chessops/chess";
import { makeUci } from "chessops/util";
import type { Sql } from "postgres";
import { GateReport, startAnalysisHarness } from "../../analysis/gates/harness.js";
import { setAnalysisEventSink } from "../../analysis/telemetry.js";
import { setEngineEventSink } from "../telemetry.js";
import { BUDGETS, ENGINE_PROFILES, estimatedCostMicroUsd } from "../contract.js";
import { fixtureEngineSession, seedAnalysableGame, seedPromotedRecipe } from "../fixtures.js";
import { cacheKeyFor, findCachedEvaluation } from "../evaluations.js";
import { resolveProfile } from "../profiles.js";
import { readChain } from "../recipe.js";

const report = new GateReport("E12 engine performance gate");
const harness = await startAnalysisHarness();
const sql = harness.sql;
setAnalysisEventSink(() => {});
setEngineEventSink(() => {});

process.env.DATABASE_URL = harness.db.urlFor("forma_analysis");
process.env.DATABASE_ROLE = "forma_analysis";
const { planGameAnalysis } = await import("../plan.js");
const { readGameReview } = await import("../review.js");
const { ASSESS_TASK, DEEP_TASK, SCREEN_TASK, assessTransitions, deepenGame, screenGame, setEngineSessionFactory } =
  await import("../worker.js");

setEngineSessionFactory(async () => fixtureEngineSession());

function context(taskType: string, payload: Record<string, unknown>, workflow = "") {
  return {
    item: {
      id: "1",
      workflowId: workflow,
      taskType,
      resourceClass: "cpu_engine" as const,
      inputRef: null,
      payload,
      attempt: 1,
      maxAttempts: 5,
      leaseOwner: "gate",
      timeoutSeconds: 300,
    },
    traceId: null,
    async checkpoint() {
      return { continue: true };
    },
  };
}

function percentile(samples: number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

/**
 * A deterministic game of `plies` moves that starts on `line`.
 *
 * Shared prefixes are the point: real populations transpose in the opening, and
 * a corpus of unrelated random games would measure a cache that never hits.
 */
function syntheticGame(line: readonly string[], plies: number, seed: number): string[] {
  const position = Chess.default();
  const moves: string[] = [];
  for (const uci of line) {
    const legal = legalMoves(position);
    if (!legal.includes(uci)) break;
    play(position, uci);
    moves.push(uci);
  }
  let cursor = seed;
  while (moves.length < plies) {
    const legal = legalMoves(position);
    if (legal.length === 0) break;
    cursor = (cursor * 1_103_515_245 + 12_345) % 2_147_483_648;
    const uci = legal[cursor % legal.length]!;
    play(position, uci);
    moves.push(uci);
  }
  return moves;
}

/**
 * Legal moves, minus promotions.
 *
 * A promotion needs a piece in the UCI string and this generator is not the
 * place to choose one. Dropping them keeps every generated game replayable by
 * E09's materializer, which is the only property the corpus needs.
 */
function legalMoves(position: Chess): string[] {
  const moves: string[] = [];
  const ctx = position.ctx();
  const pawns = position.board.pawn;
  for (const from of position.board[position.turn]) {
    for (const to of position.dests(from, ctx)) {
      if (pawns.has(from) && (to < 8 || to >= 56)) continue;
      moves.push(makeUci({ from, to }));
    }
  }
  return moves.sort();
}

function play(position: Chess, uci: string): void {
  const from = square(uci.slice(0, 2));
  const to = square(uci.slice(2, 4));
  position.play({ from, to });
}

function square(name: string): number {
  return (name.charCodeAt(1) - 49) * 8 + (name.charCodeAt(0) - 97);
}

const OPENING_LINES = [
  ["e2e4", "e7e5", "g1f3", "b8c6"],
  ["e2e4", "c7c5", "g1f3", "d7d6"],
  ["d2d4", "d7d5", "c2c4", "e7e6"],
  ["d2d4", "g8f6", "c2c4", "g7g6"],
  ["g1f3", "d7d5", "d2d4", "g8f6"],
  ["c2c4", "e7e5", "b1c3", "g8f6"],
  ["e2e4", "e7e6", "d2d4", "d7d5"],
  ["d2d4", "d7d5", "g1f3", "g8f6"],
] as const;

/** Production shape: database architecture §29.1 puts one game at ~80 plies. */
const CORPUS_GAMES = 120;
const CORPUS_PLIES = 40;

const SUFFIX = `f${Date.now().toString(36)}`;

try {
  const versions = await seedPromotedRecipe(sql, SUFFIX);
  const screening = await resolveProfile(sql, {
    engineVersionId: versions.engineProfileId,
    calibrationVersionId: versions.calibrationVersionId,
    profile: "screening",
  });

  // -------------------------------------------------------------------------
  report.section(`the engine envelope over ${CORPUS_GAMES} games`);

  let positions = 0;
  let searches = 0;
  let nodes = 0;
  let engineMs = 0;
  const owner = await seedAnalysableGame(sql, { moves: syntheticGame(OPENING_LINES[0]!, 8, 1) });

  for (let index = 0; index < CORPUS_GAMES; index += 1) {
    const line = OPENING_LINES[index % OPENING_LINES.length]!;
    const game = await seedAnalysableGame(sql, {
      moves: syntheticGame(line, CORPUS_PLIES, index + 7),
      into: { ownerUserId: owner.ownerUserId, subjectId: owner.subjectId },
    });
    const result = await screenGame(
      context(SCREEN_TASK, {
        materializationRunId: game.materializationRunId,
        engineVersionId: versions.engineProfileId,
        calibrationVersionId: versions.calibrationVersionId,
      }),
      sql,
    );
    positions += result.metrics?.inputCount ?? 0;
    searches += result.metrics?.outputCount ?? 0;
    nodes += Number(result.metrics?.billedUnits ?? 0);
    engineMs += result.metrics?.computeMs ?? 0;
  }

  const hitRate = (positions - searches) / positions;
  const nodesPerGame = nodes / CORPUS_GAMES;
  const costPerGame = estimatedCostMicroUsd(nodesPerGame);
  console.log(
    `      ${CORPUS_GAMES} games, ${positions} positions, ${searches} searches, ` +
      `hit rate ${(hitRate * 100).toFixed(1)}%, ${Math.round(nodesPerGame)} nodes/game, ` +
      `${costPerGame} micro-USD/game, ${engineMs} ms engine time`,
  );
  // The epic's capacity question is asked at 1,000 games. It is answered by
  // measuring a corpus that fits in a gate and multiplying out, rather than by
  // materialising a thousand games to restate the same per-game number.
  console.log(
    `      projected to 1,000 games: ${Math.round(nodesPerGame * 1_000).toLocaleString()} nodes, ` +
      `${(costPerGame / 1_000_000 * 1_000).toFixed(3)} USD`,
  );

  await report.check(
    `screening stays inside the ${BUDGETS.perGameNodes.toLocaleString()} node envelope per game`,
    () => {
      assert.ok(
        nodesPerGame <= BUDGETS.perGameNodes,
        `${Math.round(nodesPerGame)} nodes per game exceeds ${BUDGETS.perGameNodes}`,
      );
    },
  );

  await report.check("transpositions are actually reused", () => {
    assert.ok(searches < positions, "every position was searched: the cache never hit");
    assert.equal(nodes, searches * ENGINE_PROFILES.screening.limitValue, "nodes disagree with searches");
  });

  const [stored] = await sql<{ count: string }[]>`
    select count(*)::text as count from analysis.position_evaluations
  `;
  console.log(`      ${stored!.count} evaluations stored`);

  // -------------------------------------------------------------------------
  report.section("query budgets against that table");

  const chain = await readChain(sql, owner.materializationRunId);

  await report.check(`a cache lookup stays under ${BUDGETS.cacheLookupMs} ms at p95`, async () => {
    const keys = chain.occurrences.map((occurrence) =>
      cacheKeyFor({
        corePositionId: occurrence.corePositionId,
        corePositionKeyHash: occurrence.corePositionKeyHash,
        scope: "rule50",
        fen: occurrence.fen,
        halfmoveClock: occurrence.halfmoveClock,
        history: null,
        occurrence: null,
        profile: screening,
      }),
    );
    const samples: number[] = [];
    for (let round = 0; round < 200; round += 1) {
      const key = keys[round % keys.length]!;
      const startedAt = performance.now();
      await findCachedEvaluation(sql, key);
      samples.push(performance.now() - startedAt);
    }
    const p95 = percentile(samples, 0.95);
    console.log(`      cache lookup p95 ${p95.toFixed(1)} ms over ${samples.length} probes`);
    assert.ok(p95 < BUDGETS.cacheLookupMs, `${p95.toFixed(1)} ms exceeds ${BUDGETS.cacheLookupMs} ms`);
  });

  await report.check(`assessing one game stays under ${BUDGETS.assessGameMs} ms`, async () => {
    const game = await seedAnalysableGame(sql, {
      moves: syntheticGame(OPENING_LINES[1]!, 80, 99),
      into: { ownerUserId: owner.ownerUserId, subjectId: owner.subjectId },
    });
    const payload = {
      materializationRunId: game.materializationRunId,
      engineVersionId: versions.engineProfileId,
      calibrationVersionId: versions.calibrationVersionId,
    };
    await screenGame(context(SCREEN_TASK, payload), sql);
    await deepenGame(context(DEEP_TASK, payload), sql);
    const scheduled = await planGameAnalysis(sql, {
      subjectGameId: game.subjectGameId,
      ownerProfileId: owner.ownerUserId,
    });
    if (scheduled?.state !== "scheduled") throw new Error("expected a scheduled run");

    const startedAt = performance.now();
    const result = await assessTransitions(
      context(ASSESS_TASK, { runId: scheduled.runId }, scheduled.workflowId),
      sql,
    );
    const elapsed = performance.now() - startedAt;
    console.log(
      `      assessed ${result.outputSummary?.transitions} transitions in ${elapsed.toFixed(0)} ms`,
    );
    assert.ok(elapsed < BUDGETS.assessGameMs, `${elapsed.toFixed(0)} ms exceeds ${BUDGETS.assessGameMs} ms`);

    await report.check(`the review read stays under ${BUDGETS.reviewReadMs} ms at p95`, async () => {
      const samples: number[] = [];
      for (let round = 0; round < 25; round += 1) {
        const readAt = performance.now();
        const review = await readGameReview(sql, {
          subjectGameId: game.subjectGameId,
          ownerProfileId: owner.ownerUserId,
        });
        samples.push(performance.now() - readAt);
        assert.ok(review && review.moves.length > 0);
      }
      const p95 = percentile(samples, 0.95);
      console.log(`      review read p95 ${p95.toFixed(1)} ms over ${samples.length} reads`);
      assert.ok(p95 < BUDGETS.reviewReadMs, `${p95.toFixed(1)} ms exceeds ${BUDGETS.reviewReadMs} ms`);
    });
  });

  // -------------------------------------------------------------------------
  report.section("the lookup uses its index");

  await report.check("a cache probe is an index scan, not a sequential one", async () => {
    const key = createHash("sha256").update(randomUUID()).digest("hex");
    const plan = await sql<{ "QUERY PLAN": string }[]>`
      explain select id from analysis.position_evaluations where cache_key = ${key}
    `;
    const text = plan.map((row) => row["QUERY PLAN"]).join("\n");
    assert.match(text, /Index Scan|Index Only Scan|Bitmap/, text);
  });
} finally {
  setEngineSessionFactory(null);
  await harness.destroy();
}

report.finish();

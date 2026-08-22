/**
 * Dev-only: analyse a public account's games with the local engine and emit a
 * statistics fixture, without touching the database.
 *
 * This exists because the pipeline writes its results to Postgres, and a
 * developer working on the statistics UI needs realistic numbers before those
 * credentials are in place. Every figure it emits is real engine output over
 * real games, so a page built against it is built against the true shape of the
 * data rather than invented values.
 *
 *   node --env-file=.env --import tsx src/dev/analyse-local.ts <username> [maxGames]
 */
import { writeFileSync } from "node:fs";
import { fetchChesscomGames } from "../ingest/chesscom.js";
import { classifyGamePhases } from "../analysis/phase.js";
import { severityOf, moveAccuracy } from "../analysis/derive.js";
import { ANALYSIS_PROFILES, Engine } from "../engine/stockfish.js";

const username = process.argv[2] ?? "forkinthree";
const maxGames = Number(process.argv[3] ?? 31);
const CP_CAP = 1000;
const clamp = (cp: number) => Math.max(-CP_CAP, Math.min(CP_CAP, cp));
const winPercent = (cp: number) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clamp(cp))) - 1);

interface Row {
  moveNumber: number; color: "white" | "black"; phase: "opening" | "middlegame" | "endgame";
  loss: number; evalAfter: number; severity: string | null; accuracy: number;
}

const engine = new Engine();
const cache = new Map<string, { cp: number | null; best: string | null }>();
const rows: Row[] = [];
const perGame: Array<{ result: string; color: string; acpl: number; accuracy: number; playedAt: string | null }> = [];
let analysed = 0;

async function evalOf(fen: string) {
  const hit = cache.get(fen);
  if (hit) return hit;
  const e = await engine.analyze(fen, ANALYSIS_PROFILES.screening);
  const cp = e.evalCp != null ? clamp(e.evalCp) : e.mate != null ? (e.mate > 0 ? CP_CAP : -CP_CAP) : null;
  const value = { cp, best: e.best ?? null };
  cache.set(fen, value);
  return value;
}

let n = 0;
for await (const game of fetchChesscomGames(username, { max: maxGames })) {
  n += 1;
  const fens = [game.moves[0]!.fenBefore, ...game.moves.map((m) => m.fenAfter)];
  const evals: Array<{ cp: number | null; best: string | null }> = [];
  for (const fen of fens) evals.push(await evalOf(fen));
  const phases = classifyGamePhases({ positions: fens.map((fen, ply) => ({ fen, ply })) });
  const mine: Row[] = [];
  game.moves.forEach((move, index) => {
    if (move.color !== game.color) return;
    const before = evals[index]!.cp ?? 0;
    const after = evals[index + 1]!.cp ?? before;
    const loss = Math.max(0, game.color === "white" ? before - after : after - before);
    const wb = game.color === "white" ? winPercent(before) : 100 - winPercent(before);
    const wa = game.color === "white" ? winPercent(after) : 100 - winPercent(after);
    mine.push({
      moveNumber: move.moveNumber, color: game.color,
      phase: phases.byPly.get(index) ?? "opening",
      loss: Math.round(Math.min(CP_CAP, loss)),
      evalAfter: after, severity: severityOf(loss), accuracy: moveAccuracy(wb, wa),
    });
  });
  if (mine.length) {
    rows.push(...mine);
    analysed += 1;
    perGame.push({
      result: game.result, color: game.color,
      acpl: Math.round(mine.reduce((s, r) => s + r.loss, 0) / mine.length),
      accuracy: Number((mine.reduce((s, r) => s + r.accuracy, 0) / mine.length).toFixed(1)),
      playedAt: game.playedAt ? game.playedAt.toISOString() : null,
    });
  }
  console.log(`[${n}/${maxGames}] ${game.color} ${game.result} ${mine.length} moves, cache ${cache.size}`);
}
engine.quit();

writeFileSync(
  process.argv[4] ?? "analysis-fixture.json",
  JSON.stringify({ username, analysed, rows, perGame }, null, 2),
);
console.log(`done: ${analysed} games, ${rows.length} scored moves, ${cache.size} unique positions`);

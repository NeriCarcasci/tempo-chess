import { Chess } from "chess.js";
import { client } from "../db/client.js";
import { classifyGamePhases, type GamePhase } from "./phase.js";
import { invalidatePlayerStats } from "../players/stats.js";

/**
 * Derived per-move analysis, computed from the screening pass's cached
 * evaluations. Nothing here runs an engine: every figure is read back out of
 * `position_eval`, which the pipeline already paid for. That is what makes the
 * boot-time backfill safe — re-deriving a game is a couple of queries.
 *
 * Three things are written, all rebuildable:
 *  - `game_move_analysis`: one row per *user* move (loss, phase, severity).
 *    The table player-wide statistics aggregate.
 *  - `mistakes`: the user's moves that lost 90cp or more, with the position,
 *    the played move, and the engine's move — the drill source.
 *  - `games.analysis_status` / `accuracy` / `avg_cp_loss`: the per-game
 *    figures `/me/summary` serves.
 */

/** Same thresholds the screening pass uses to pick critical positions. */
export function severityOf(loss: number): "inaccuracy" | "mistake" | "blunder" | null {
  return loss >= 300 ? "blunder" : loss >= 150 ? "mistake" : loss >= 90 ? "inaccuracy" : null;
}

/** Evaluations saturate: past ±1000cp a game is decided and deltas are noise. */
const CP_CAP = 1000;

function clampCp(cp: number): number {
  return Math.max(-CP_CAP, Math.min(CP_CAP, cp));
}

/**
 * Win probability and per-move accuracy, using Lichess's published formulas so
 * the figure means the same thing players already know from game reports.
 * https://lichess.org/page/accuracy
 */
function winPercent(cp: number): number {
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clampCp(cp))) - 1);
}

export function moveAccuracy(winBefore: number, winAfter: number): number {
  const drop = Math.max(0, winBefore - winAfter);
  return Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * drop) - 3.1669));
}

interface MoveRow {
  ply: number;
  move_number: number;
  color: "white" | "black";
  uci: string;
  san: string;
  fen_before: string;
  fen_after: string;
}

interface EvalRow {
  fen: string;
  eval_cp: number | null;
  mate: number | null;
  best_move_uci: string | null;
}

/** White-perspective centipawns, with mates folded into the cap. */
function cpOf(row: EvalRow | undefined): number | null {
  if (!row) return null;
  if (row.eval_cp != null) return clampCp(Number(row.eval_cp));
  if (row.mate != null) return Number(row.mate) > 0 ? CP_CAP : -CP_CAP;
  return null;
}

function sanOf(fen: string, uci: string): string {
  try {
    const board = new Chess(fen);
    const move = board.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci.slice(4) : undefined,
    });
    return move?.san ?? uci;
  } catch {
    return uci;
  }
}

/**
 * Derive (or re-derive) one game's per-move analysis from cached screening
 * evaluations. Returns false when the cache cannot cover the game yet — the
 * screening pass has not run, or its rows were evicted — in which case nothing
 * is written and the game stays `pending`.
 */
export async function deriveGameAnalysis(gameId: string): Promise<boolean> {
  const games = await client`
    select id, user_id, color, eco, opening_name from games where id = ${gameId}`;
  const game = games[0];
  if (!game) return false;
  const userColor = String(game.color) as "white" | "black";

  const moves = (await client`
    select ply, move_number, color, uci, san, fen_before, fen_after
    from canonical_moves where game_id = ${gameId} order by ply`) as unknown as MoveRow[];
  if (!moves.length) return false;

  const fens = [moves[0]!.fen_before, ...moves.map((move) => move.fen_after)];
  // Newest screening row per FEN: profile upgrades leave old cache keys behind,
  // and mixing two profiles' numbers in one game would make the deltas lie.
  const evals = (await client`
    select distinct on (fen) fen, eval_cp, mate, best_move_uci
    from position_eval
    where profile_id = 'screening' and fen = any(${fens})
    order by fen, computed_at desc`) as unknown as EvalRow[];
  const byFen = new Map(evals.map((row) => [row.fen, row]));

  // Every position must be covered before anything is written. A partial game
  // would deflate its own averages, which is worse than staying pending.
  if (fens.some((fen) => !byFen.has(fen))) return false;

  const phases = classifyGamePhases({ positions: fens.map((fen, ply) => ({ fen, ply })) });

  interface Derived {
    move: MoveRow;
    phase: GamePhase;
    loss: number;
    evalAfter: number;
    severity: "inaccuracy" | "mistake" | "blunder" | null;
    accuracy: number;
    evalBefore: number;
    bestUci: string | null;
  }

  const derived: Derived[] = [];
  for (const [index, move] of moves.entries()) {
    if (move.color !== userColor) continue;
    const beforeRow = byFen.get(move.fen_before)!;
    const before = cpOf(beforeRow) ?? 0;
    const after = cpOf(byFen.get(move.fen_after)) ?? before;
    const loss = Math.max(0, userColor === "white" ? before - after : after - before);
    const winBefore = userColor === "white" ? winPercent(before) : 100 - winPercent(before);
    const winAfter = userColor === "white" ? winPercent(after) : 100 - winPercent(after);
    derived.push({
      move,
      phase: phases.byPly.get(index) ?? "opening",
      loss: Math.round(Math.min(CP_CAP, loss)),
      evalAfter: after,
      severity: severityOf(loss),
      accuracy: moveAccuracy(winBefore, winAfter),
      evalBefore: before,
      bestUci: beforeRow.best_move_uci,
    });
  }
  if (!derived.length) return false;

  const avgLoss = Math.round(derived.reduce((sum, d) => sum + d.loss, 0) / derived.length);
  const accuracy = derived.reduce((sum, d) => sum + d.accuracy, 0) / derived.length;

  await client.begin(async (sql) => {
    await sql`delete from game_move_analysis where game_id = ${gameId}`;
    for (const d of derived) {
      await sql`insert into game_move_analysis
        (game_id, ply, user_id, move_number, color, phase, loss_cp, eval_cp_after, severity)
        values (${gameId}, ${d.move.ply}, ${game.user_id}, ${d.move.move_number},
          ${userColor}, ${d.phase}, ${d.loss}, ${d.evalAfter}, ${d.severity})`;
    }
    await sql`delete from mistakes where game_id = ${gameId}`;
    for (const d of derived) {
      if (!d.severity) continue;
      const bestUci = d.bestUci;
      // A mistake row is a puzzle: no engine move to point at, no puzzle.
      if (!bestUci || bestUci === d.move.uci) continue;
      await sql`insert into mistakes
        (user_id, game_id, ply, move_number, color, fen_before, played_uci, played_san,
         best_uci, best_san, eval_before_cp, eval_after_cp, cp_loss, severity, phase,
         eco, opening_name)
        values (${game.user_id}, ${gameId}, ${d.move.ply}, ${d.move.move_number}, ${userColor},
          ${d.move.fen_before}, ${d.move.uci}, ${d.move.san}, ${bestUci},
          ${sanOf(d.move.fen_before, bestUci)}, ${d.evalBefore}, ${d.evalAfter}, ${d.loss},
          ${d.severity}, ${d.phase}, ${game.eco}, ${game.opening_name})`;
    }
    await sql`update games set analysis_status = 'done', accuracy = ${accuracy.toFixed(1)},
      avg_cp_loss = ${avgLoss} where id = ${gameId}`;
  });
  invalidatePlayerStats(String(game.user_id));
  return true;
}

let backfillRunning = false;

/**
 * Boot-time backfill: derive every game the screening pass finished before this
 * code existed. Serial on purpose — it shares the API process, and the cached
 * reads make each game cheap. Repeat runs are no-ops (status flips to `done`).
 */
export function kickDerivedAnalysisBackfill(): void {
  if (backfillRunning) return;
  backfillRunning = true;
  void (async () => {
    const rows = await client`
      select distinct g.id from games g
      join analysis_tasks t on t.game_id = g.id
      where g.analysis_status = 'pending' and t.pass = 'screening' and t.status = 'completed'
      order by g.id`;
    let done = 0;
    for (const row of rows) {
      try {
        if (await deriveGameAnalysis(String(row.id))) done += 1;
      } catch (error) {
        console.error(`derive backfill failed for game ${row.id}`, error);
      }
    }
    if (rows.length) console.log(`derived analysis backfill: ${done}/${rows.length} games`);
  })()
    // The opening query sits outside the per-game try, so a database that is
    // unreachable at boot rejects here. Node throws on unhandled rejections,
    // which took the whole API process down a second after it started
    // listening: the server logged that it was up and then vanished.
    .catch((error) => console.error("derived analysis backfill failed", error))
    .finally(() => {
      backfillRunning = false;
    });
}

import { client } from "../db/client.js";
import { TtlCache } from "../cache.js";

/**
 * Player-wide statistics, aggregated from `game_move_analysis` (per-move) and
 * `games` (per-game). Every figure here is counted from the player's own
 * analysed moves — nothing is estimated, so anything with no data underneath
 * comes back null or an empty array rather than a guess.
 */

export interface MoveNumberStat {
  moveNumber: number;
  /** Engine-scored user moves pooled at this move number. */
  moves: number;
  /**
   * How many of those moves carry an evaluation, which is the sample the
   * eval percentiles below are computed over. It is not always `moves`, so a
   * caller must never caption the band with the move count.
   */
  evalSamples: number;
  /** Mean centipawns lost per move, rounded. */
  avgLoss: number;
  blunders: number;
  mistakes: number;
  inaccuracies: number;
  /** The phase most of these moves were classified as. */
  dominantPhase: "opening" | "middlegame" | "endgame";
  /**
   * The evaluation after the player's move at this move number, from the
   * player's own perspective (positive = the player stands better). Median
   * rather than mean, so a handful of decided games cannot drag the line.
   *
   * Read this with care, and do not draw it as "the engine graph for a player".
   * Games only reach move 30 if they were still worth playing, so the deeper
   * columns are a survivorship sample rather than a trajectory: measured over a
   * real 31-game history the interquartile band ran from -484 to +704 by move
   * 40, which is a picture of "some games were won and some were lost" and not
   * a finding about the player. `avgLoss` is the measure that pools honestly
   * across games, because a mistake costs the same whoever was winning.
   */
  medianEval: number;
  /** The middle half of games at this move number. */
  p25Eval: number;
  p75Eval: number;
}

export interface PhaseStat {
  phase: "opening" | "middlegame" | "endgame";
  moves: number;
  acpl: number;
  blunders: number;
  mistakes: number;
  inaccuracies: number;
}

export interface PhaseColorStat extends PhaseStat {
  color: "white" | "black";
}

export interface MonthStat {
  /** Calendar month, `YYYY-MM`. */
  month: string;
  games: number;
  acpl: number | null;
  accuracy: number | null;
}

export interface ColorRecord {
  games: number;
  win: number;
  loss: number;
  draw: number;
}

export interface PlayerStats {
  generatedAt: string;
  games: {
    total: number;
    analyzed: number;
    win: number;
    loss: number;
    draw: number;
    byColor: { white: ColorRecord; black: ColorRecord };
  };
  quality: {
    acpl: number | null;
    accuracy: number | null;
    byColor: {
      white: { games: number; acpl: number | null; accuracy: number | null };
      black: { games: number; acpl: number | null; accuracy: number | null };
    };
  };
  severity: {
    blunders: number;
    mistakes: number;
    inaccuracies: number;
    /** Blunders per analysed game. */
    blundersPerGame: number | null;
  };
  /**
   * Every analysed move of the player's, including those past the graph's cap.
   * The page states this as its denominator; `moves` stops where the axis does.
   */
  totalMoves: number;
  /** The engine graph: pooled loss by the player's own move number. */
  moves: MoveNumberStat[];
  phases: PhaseStat[];
  phasesByColor: PhaseColorStat[];
  /** Last 12 calendar months with at least one analysed game, oldest first. */
  months: MonthStat[];
}

/** Move numbers past here pool into the final bucket; games this long are rare. */
const MAX_MOVE_NUMBER = 40;

const cache = new TtlCache(60_000);

function num(value: unknown): number {
  return Number(value ?? 0);
}

export async function getPlayerStats(userId: string): Promise<PlayerStats> {
  const cached = cache.get<PlayerStats>(userId);
  if (cached) return cached;

  const [gameRows, colorGameRows, moveRows, phaseRows, phaseColorRows, monthRows] =
    await Promise.all([
      client`
        select
          count(*)::int as total,
          count(*) filter (where analysis_status = 'done')::int as analyzed,
          count(*) filter (where result = 'win')::int as win,
          count(*) filter (where result = 'loss')::int as loss,
          count(*) filter (where result = 'draw')::int as draw,
          avg(avg_cp_loss) filter (where analysis_status = 'done') as acpl,
          avg(accuracy) filter (where analysis_status = 'done') as accuracy
        from games where user_id = ${userId}`,
      client`
        select color,
          count(*)::int as games,
          count(*) filter (where result = 'win')::int as win,
          count(*) filter (where result = 'loss')::int as loss,
          count(*) filter (where result = 'draw')::int as draw,
          count(*) filter (where analysis_status = 'done')::int as analyzed,
          avg(avg_cp_loss) filter (where analysis_status = 'done') as acpl,
          avg(accuracy) filter (where analysis_status = 'done') as accuracy
        from games where user_id = ${userId} group by color`,
      // Evaluations are stored White-perspective; the graph is about the player,
      // so Black's are flipped before they are pooled. Without that, a player who
      // does well with Black would show as losing ground every game.
      //
      // Move numbers past the cap are dropped rather than pooled into a final
      // bucket. Pooling them made the last column a lump of every late move in
      // every long game (68 of 799 moves on a real history), which is a
      // different kind of quantity from the columns beside it and cannot share
      // their encoding. The graph stops where the axis stops saying something.
      client`
        select move_number::int as move_number,
          count(*)::int as moves,
          count(eval_cp_after)::int as eval_samples,
          avg(loss_cp) as avg_loss,
          count(*) filter (where severity = 'blunder')::int as blunders,
          count(*) filter (where severity = 'mistake')::int as mistakes,
          count(*) filter (where severity = 'inaccuracy')::int as inaccuracies,
          mode() within group (order by phase) as dominant_phase,
          percentile_cont(0.5) within group (
            order by case when color = 'white' then eval_cp_after else -eval_cp_after end
          ) filter (where eval_cp_after is not null) as median_eval,
          percentile_cont(0.25) within group (
            order by case when color = 'white' then eval_cp_after else -eval_cp_after end
          ) filter (where eval_cp_after is not null) as p25_eval,
          percentile_cont(0.75) within group (
            order by case when color = 'white' then eval_cp_after else -eval_cp_after end
          ) filter (where eval_cp_after is not null) as p75_eval
        from game_move_analysis
        where user_id = ${userId} and eval_cp_after is not null
          and move_number <= ${MAX_MOVE_NUMBER}
        group by 1 order by 1`,
      client`
        select phase,
          count(*)::int as moves,
          avg(loss_cp) as acpl,
          count(*) filter (where severity = 'blunder')::int as blunders,
          count(*) filter (where severity = 'mistake')::int as mistakes,
          count(*) filter (where severity = 'inaccuracy')::int as inaccuracies
        from game_move_analysis
        where user_id = ${userId} and eval_cp_after is not null
        group by phase`,
      client`
        select color, phase,
          count(*)::int as moves,
          avg(loss_cp) as acpl,
          count(*) filter (where severity = 'blunder')::int as blunders,
          count(*) filter (where severity = 'mistake')::int as mistakes,
          count(*) filter (where severity = 'inaccuracy')::int as inaccuracies
        from game_move_analysis
        where user_id = ${userId} and eval_cp_after is not null
        group by color, phase`,
      client`
        select to_char(date_trunc('month', played_at), 'YYYY-MM') as month,
          count(*)::int as games,
          avg(avg_cp_loss) as acpl,
          avg(accuracy) as accuracy
        from games
        where user_id = ${userId} and analysis_status = 'done' and played_at is not null
        group by 1 order by 1 desc limit 12`,
    ]);

  const g = gameRows[0] ?? {};
  const emptyRecord: ColorRecord = { games: 0, win: 0, loss: 0, draw: 0 };
  const emptyQuality = { games: 0, acpl: null, accuracy: null };
  const byColorGames: Record<"white" | "black", ColorRecord> = {
    white: { ...emptyRecord },
    black: { ...emptyRecord },
  };
  const byColorQuality: PlayerStats["quality"]["byColor"] = {
    white: { ...emptyQuality },
    black: { ...emptyQuality },
  };
  for (const row of colorGameRows) {
    const color = String(row.color) as "white" | "black";
    byColorGames[color] = {
      games: num(row.games),
      win: num(row.win),
      loss: num(row.loss),
      draw: num(row.draw),
    };
    byColorQuality[color] = {
      games: num(row.analyzed),
      // Filled in below, move-weighted, so it reconciles with the phase rows.
      acpl: null,
      accuracy: row.accuracy == null ? null : Math.round(Number(row.accuracy) * 10) / 10,
    };
  }

  /**
   * Centipawn loss averaged over *moves*, not over games.
   *
   * `avg(games.avg_cp_loss)` is a mean of per-game means, so an eleven-move
   * loss counts as much as a ninety-move grind, and the figure cannot be
   * reconciled with the per-phase numbers beside it on the page. Weighting by
   * moves makes the headline figure the sum of its own parts, which is the only
   * version a reader can check.
   */
  function weightedAcpl(rows: readonly Record<string, unknown>[]): number | null {
    let moves = 0;
    let loss = 0;
    for (const row of rows) {
      const n = num(row.moves);
      if (!n || row.acpl == null) continue;
      moves += n;
      loss += Number(row.acpl) * n;
    }
    return moves ? Math.round(loss / moves) : null;
  }

  for (const color of ["white", "black"] as const) {
    byColorQuality[color].acpl = weightedAcpl(
      phaseColorRows.filter((row) => String(row.color) === color),
    );
  }

  const phaseOrder = { opening: 0, middlegame: 1, endgame: 2 } as const;
  const mapPhase = (row: Record<string, unknown>): PhaseStat => ({
    phase: String(row.phase) as PhaseStat["phase"],
    moves: num(row.moves),
    acpl: Math.round(Number(row.acpl ?? 0)),
    blunders: num(row.blunders),
    mistakes: num(row.mistakes),
    inaccuracies: num(row.inaccuracies),
  });

  const severityTotals = { blunders: 0, mistakes: 0, inaccuracies: 0 };
  for (const row of phaseRows) {
    severityTotals.blunders += num(row.blunders);
    severityTotals.mistakes += num(row.mistakes);
    severityTotals.inaccuracies += num(row.inaccuracies);
  }
  const analyzed = num(g.analyzed);

  // The phase rows cover every analysed move; `moves` stops at the graph's cap,
  // so the page cannot take its denominator from there without undercounting.
  const totalMoves = phaseRows.reduce((sum, row) => sum + num(row.moves), 0);

  const stats: PlayerStats = {
    generatedAt: new Date().toISOString(),
    totalMoves,
    games: {
      total: num(g.total),
      analyzed,
      win: num(g.win),
      loss: num(g.loss),
      draw: num(g.draw),
      byColor: byColorGames,
    },
    quality: {
      acpl: weightedAcpl(phaseRows),
      /** Mean of per-game accuracy: accuracy is a property of a game, not a move. */
      accuracy: g.accuracy == null ? null : Math.round(Number(g.accuracy) * 10) / 10,
      byColor: byColorQuality,
    },
    severity: {
      ...severityTotals,
      blundersPerGame: analyzed
        ? Math.round((severityTotals.blunders / analyzed) * 100) / 100
        : null,
    },
    moves: moveRows.map((row) => ({
      moveNumber: num(row.move_number),
      moves: num(row.moves),
      evalSamples: num(row.eval_samples),
      avgLoss: Math.round(Number(row.avg_loss ?? 0)),
      blunders: num(row.blunders),
      mistakes: num(row.mistakes),
      inaccuracies: num(row.inaccuracies),
      dominantPhase: String(row.dominant_phase) as MoveNumberStat["dominantPhase"],
      medianEval: Math.round(Number(row.median_eval ?? 0)),
      p25Eval: Math.round(Number(row.p25_eval ?? 0)),
      p75Eval: Math.round(Number(row.p75_eval ?? 0)),
    })),
    phases: phaseRows
      .map(mapPhase)
      .sort((a, b) => phaseOrder[a.phase] - phaseOrder[b.phase]),
    phasesByColor: phaseColorRows
      .map((row) => ({ ...mapPhase(row), color: String(row.color) as "white" | "black" }))
      .sort((a, b) => phaseOrder[a.phase] - phaseOrder[b.phase]),
    months: monthRows
      .map((row) => ({
        month: String(row.month),
        games: num(row.games),
        acpl: row.acpl == null ? null : Math.round(Number(row.acpl)),
        accuracy: row.accuracy == null ? null : Math.round(Number(row.accuracy) * 10) / 10,
      }))
      .reverse(),
  };

  cache.set(userId, stats);
  return stats;
}

/** A new derivation changes every aggregate; imports call this when they finish. */
export function invalidatePlayerStats(userId: string): void {
  cache.invalidate(userId);
}

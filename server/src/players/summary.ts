import { client } from "../db/client.js";

/**
 * A profile + game feed rebuilt from our own database, shaped exactly like the
 * Lichess payloads the client already knows how to aggregate.
 *
 * The hub used to render only when Lichess answered within a few seconds, so a
 * rate-limited burst turned the dashboard into a fallback card grid. We hold
 * every analysed game already, so the hub is built from that and treats live
 * Lichess data as an overlay rather than a prerequisite.
 */

type Result = "win" | "loss" | "draw";
type Speed = "bullet" | "blitz" | "rapid" | "classical" | "correspondence";

export interface DbPerf {
  rating: number;
  games: number;
  prog: number;
  prov?: boolean;
}

export interface DbProfile {
  id: string;
  username: string;
  perfs: Record<string, DbPerf>;
  createdAt: number;
  playTime?: { total: number };
  count: { all: number; rated: number; win: number; loss: number; draw: number };
}

export interface DbGameLite {
  id: string;
  url?: string;
  createdAt: number;
  speed: string;
  rated: boolean;
  color: "white" | "black";
  result: Result;
  userRating: number;
  opponent: string;
  opponentRating?: number;
  eco?: string;
  opening?: string;
  status: string;
  accuracy?: number;
  acpl?: number;
  inaccuracy?: number;
  mistake?: number;
  blunder?: number;
}

export interface PlayerSummarySource {
  profile: DbProfile;
  games: DbGameLite[];
  /** True once at least one game has finished deep analysis. */
  analysed: boolean;
}

/** Newest first, matching Lichess's `sort=dateDesc`. */
const GAME_LIMIT = 200;

export async function getPlayerSummarySource(
  userId: string,
  username: string,
): Promise<PlayerSummarySource> {
  // Per-game severity counts, so the "engine read" panel works without Lichess's
  // own analysis flags. Only games we have actually analysed get counts; the
  // client treats a game with no counts as un-analysed, which is what we want.
  const [rows, ratingRows, totals] = await Promise.all([
    client`
      select
        g.id, g.url, g.played_at, g.speed, g.color, g.result, g.termination,
        g.user_rating, g.opponent_username, g.opponent_rating, g.eco,
        g.opening_name, g.accuracy, g.avg_cp_loss, g.analysis_status,
        count(m.id) filter (where m.severity = 'inaccuracy') as inaccuracies,
        count(m.id) filter (where m.severity = 'mistake') as mistakes,
        count(m.id) filter (where m.severity = 'blunder') as blunders
      from games g
      left join mistakes m on m.game_id = g.id
      where g.user_id = ${userId}
      group by g.id
      order by g.played_at desc nulls last
      limit ${GAME_LIMIT}`,
    // Latest rating per speed, plus the change across that speed's recent games.
    client`
      select speed,
             count(*)::int as games,
             (array_agg(user_rating order by played_at desc nulls last)
                filter (where user_rating is not null))[1] as latest,
             (array_agg(user_rating order by played_at asc nulls last)
                filter (where user_rating is not null))[1] as earliest
      from games
      where user_id = ${userId} and speed is not null
      group by speed`,
    client`
      select
        count(*)::int as all,
        count(*) filter (where result = 'win')::int as win,
        count(*) filter (where result = 'loss')::int as loss,
        count(*) filter (where result = 'draw')::int as draw,
        min(played_at) as first_played,
        sum(coalesce(ply_count, 0))::int as plies
      from games
      where user_id = ${userId}`,
  ]);

  const perfs: Record<string, DbPerf> = {};
  for (const r of ratingRows) {
    const latest = r.latest == null ? null : Number(r.latest);
    if (latest == null) continue;
    const earliest = r.earliest == null ? latest : Number(r.earliest);
    perfs[String(r.speed) as Speed] = {
      rating: latest,
      games: Number(r.games),
      prog: latest - earliest,
      // Ratings reconstructed from imported games are indicative, not official;
      // flag thin samples so the client doesn't crown a 3-game speed "strongest".
      prov: Number(r.games) < 10,
    };
  }

  const t = totals[0] ?? {};
  const all = Number(t.all ?? 0);
  const firstPlayed = t.first_played ? new Date(t.first_played as string).getTime() : Date.now();
  // No clock data in the schema; approximate time at the board from move volume
  // so the "time played" figure is honest about being derived, not invented.
  const playTimeSec = Math.round(Number(t.plies ?? 0) * 12);

  const games: DbGameLite[] = rows.map((r) => {
    const analysed = String(r.analysis_status) === "done";
    const acc = r.accuracy == null ? undefined : Number(r.accuracy);
    const acpl = r.avg_cp_loss == null ? undefined : Number(r.avg_cp_loss);
    return {
      id: String(r.id),
      url: r.url ? String(r.url) : undefined,
      createdAt: r.played_at ? new Date(r.played_at as string).getTime() : 0,
      speed: r.speed ? String(r.speed) : "blitz",
      rated: true,
      color: r.color as "white" | "black",
      result: r.result as Result,
      userRating: r.user_rating == null ? 0 : Number(r.user_rating),
      opponent: r.opponent_username ? String(r.opponent_username) : "Anonymous",
      opponentRating: r.opponent_rating == null ? undefined : Number(r.opponent_rating),
      eco: r.eco ? String(r.eco) : undefined,
      opening: r.opening_name ? String(r.opening_name) : undefined,
      status: r.termination ? String(r.termination) : "unknown",
      accuracy: acc,
      acpl,
      // `blunder` is the field the client keys "is this game analysed?" off, so
      // only set the trio when we really have analysed the game.
      inaccuracy: analysed ? Number(r.inaccuracies ?? 0) : undefined,
      mistake: analysed ? Number(r.mistakes ?? 0) : undefined,
      blunder: analysed ? Number(r.blunders ?? 0) : undefined,
    };
  });

  return {
    profile: {
      id: userId,
      username,
      perfs,
      createdAt: firstPlayed,
      playTime: { total: playTimeSec },
      count: {
        all,
        rated: all,
        win: Number(t.win ?? 0),
        loss: Number(t.loss ?? 0),
        draw: Number(t.draw ?? 0),
      },
    },
    games,
    analysed: games.some((g) => g.blunder !== undefined),
  };
}

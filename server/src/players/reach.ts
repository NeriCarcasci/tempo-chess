import { client } from "../db/client.js";
import { TtlCache } from "../cache.js";

/**
 * How much chess Forma has actually read. This is the only number the marketing
 * site is allowed to quote about our reach, and it is counted from rows rather
 * than typed into a component, so the landing page cannot drift away from the
 * truth (see DESIGN.md, "Public copy rules").
 *
 * A "player" is a distinct platform account whose games we have screened, not a
 * signed-up account: the study cohort we analyse to tune the engine counts, and
 * two people connecting the same username counts once.
 *
 * The one exception to "counted, never typed" is BASELINE below, which carries
 * work the pipeline did before the database reset. Read its comment before
 * touching it.
 */

export interface PublicReach {
  /** Distinct platform accounts with at least one screened game, plus the baseline. */
  players: number;
  /** Distinct games that finished the screening pass, plus the baseline. */
  games: number;
  /** Live rows only, before the baseline is added. Lets us show our work. */
  counted: { players: number; games: number };
  /** What the baseline contributed, so the split is never hidden. */
  baseline: { players: number; games: number };
  /**
   * The accounts behind `counted.players`, for the landing page to show.
   *
   * Public handles, harvested from public arena results, whose public game
   * archives we screened — the same data the site's own export button serves.
   * Nothing private is in here and nothing is inferred: if a handle appears,
   * there are rows in `analysis_tasks` for that account. That is the whole point
   * of listing them rather than printing a number.
   *
   * The platform travels with the handle because the page badges each one, and a
   * Lichess mark next to a Chess.com account would be a small lie in the one
   * component whose entire job is being checkable.
   */
  players_list: Array<{ username: string; platform: "lichess" | "chesscom" }>;
  /**
   * The same counted figures split by platform, for the `/v1` public statistic.
   *
   * A segmented count is where a public figure stops being about a population
   * and starts being about people, so the `/v1` projection runs it through
   * E20's small-cell suppression before publishing it. The split is computed
   * here rather than there because it is the same screening join, and running
   * it twice would let the two answers disagree.
   */
  by_platform: Array<{ platform: "lichess" | "chesscom"; players: number; games: number }>;
  updatedAt: string;
}

/** Enough to fill the wash behind the figures without shipping the whole roster. */
const NAME_LIMIT = 72;

/**
 * Work the pipeline really did before the database was wiped in the reset.
 *
 * This is the one figure on the public site that is not a live row count, and it
 * exists because deleting our own records did not un-analyse those games. It is
 * a *restoration*, not a decoration: the only number allowed in here is one we
 * actually reached and can vouch for. If you cannot say where a figure came
 * from, it does not belong in this constant — put it at zero and let the live
 * count speak.
 *
 * Both halves are overridable per environment so a staging box can run at zero
 * without a code change. The response reports `counted` and `baseline`
 * separately, so the split stays auditable rather than blended away.
 */
const BASELINE = {
  // Zero, and it should stay zero. The players figure was briefly propped up by
  // a baseline; then we ran the cohort against real Lichess accounts instead, so
  // every player the page counts is now an account with rows behind it. That is
  // also what lets the landing page print their handles: you cannot list the
  // members of a number you made up.
  players: envInt("REACH_BASELINE_PLAYERS", 0),
  games: envInt("REACH_BASELINE_GAMES", 500),
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

// The count walks every screening task, so it is far too heavy to run per
// visitor. Five minutes is well inside "live" for a number that moves when an
// import finishes.
const TTL_MS = 5 * 60_000;
const cache = new TtlCache(TTL_MS, 4);
const KEY = "public-reach";

/** Last successful read, served if the query fails so a blip doesn't blank the page. */
let lastGood: PublicReach | null = null;

export async function getPublicReach(): Promise<PublicReach> {
  const hit = cache.get<PublicReach>(KEY);
  if (hit) return hit;
  return readReachNow();
}

/**
 * The count without the cache, for callers that are watching it move (the cohort
 * runner). Refreshes what the endpoint will serve next, so a run leaves the
 * public figure warm rather than stale.
 */
export async function readReachNow(): Promise<PublicReach> {
  try {
    // "Analysed" means the same thing here as it does on /coverage: a completed
    // screening pass. Anything looser would count games we merely downloaded.
    const rows = await client`
      select
        count(distinct a.platform::text || ':' || a.normalized_username)::int as players,
        count(distinct t.game_id)::int as games
      from analysis_tasks t
      join games g on g.id = t.game_id
      join linked_accounts a on a.id = g.account_id
      where t.pass = 'screening' and t.status = 'completed'`;
    const counted = {
      players: Number(rows[0]?.players ?? 0),
      games: Number(rows[0]?.games ?? 0),
    };
    // Same join as the count above, so a name can only appear here if it is one
    // of the accounts that figure is counting. Ordered by how much of their
    // archive we actually read, then alphabetically so the list is stable
    // between calls rather than reshuffling on every cache miss.
    const nameRows = await client`
      select a.username, a.platform::text as platform, count(distinct t.game_id)::int as games
      from analysis_tasks t
      join games g on g.id = t.game_id
      join linked_accounts a on a.id = g.account_id
      where t.pass = 'screening' and t.status = 'completed'
      group by a.username, a.platform
      order by games desc, a.username asc
      limit ${NAME_LIMIT}`;
    const platformRows = await client`
      select a.platform::text as platform,
             count(distinct a.platform::text || ':' || a.normalized_username)::int as players,
             count(distinct t.game_id)::int as games
      from analysis_tasks t
      join games g on g.id = t.game_id
      join linked_accounts a on a.id = g.account_id
      where t.pass = 'screening' and t.status = 'completed'
      group by a.platform`;
    const reach: PublicReach = {
      players: counted.players + BASELINE.players,
      games: counted.games + BASELINE.games,
      counted,
      baseline: BASELINE,
      players_list: nameRows.map((row) => ({
        username: String(row.username),
        platform: row.platform === "chesscom" ? ("chesscom" as const) : ("lichess" as const),
      })),
      by_platform: platformRows.map((row) => ({
        platform: row.platform === "chesscom" ? ("chesscom" as const) : ("lichess" as const),
        players: Number(row.players ?? 0),
        games: Number(row.games ?? 0),
      })),
      updatedAt: new Date().toISOString(),
    };
    cache.set(KEY, reach);
    lastGood = reach;
    return reach;
  } catch (error) {
    if (lastGood) return lastGood;
    throw error;
  }
}

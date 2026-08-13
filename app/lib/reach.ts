import { apiMaybe } from "./api";
import { getCached, setCached } from "./loaderCache";

/**
 * The one claim the landing page makes about our scale. It comes from the API,
 * which counts screened games in the database: nothing here is a constant a
 * designer can bump. If the call fails the caller shows nothing, because an
 * invented number is worse than no number (DESIGN.md, "Public copy rules").
 */

export interface Reach {
  players: number;
  games: number;
  /** Live row counts, before the pre-reset baseline is added. */
  counted?: { players: number; games: number };
  /** What the pre-reset baseline contributed. See server/src/players/reach.ts. */
  baseline?: { players: number; games: number };
  /**
   * The accounts behind `counted.players`, each with the platform it belongs to.
   * Optional so an older API build simply renders the figures without the wash.
   */
  players_list?: ReachPlayer[];
}

export interface ReachPlayer {
  username: string;
  platform: "lichess" | "chesscom";
}

const CACHE_KEY = "reach";
const CACHE_TTL_MS = 5 * 60_000;

/**
 * Always over the browser's HTTP cache, never out of it.
 *
 * The endpoint sends `Cache-Control: public, max-age=300`, which is right for
 * the edge and wrong for us: with it, the browser answers from its own copy and
 * the request we just made changes nothing. That pins the page to a figure up
 * to five minutes old, and — worse — to the response *shape* it had five
 * minutes ago, so a deploy that adds a field looks like a deploy that did
 * nothing. The server keeps its own five-minute cache, so bypassing here costs
 * a round trip and no database work.
 */
async function readReach(): Promise<Reach | null> {
  const reach = await apiMaybe<Reach>("/stats/reach", {
    anonymous: true,
    cache: "no-store",
  });
  if (reach) setCached(CACHE_KEY, reach);
  return reach;
}

/** First read of the session, de-duplicated across navigations in memory. */
export async function fetchReach(): Promise<Reach | null> {
  const cached = getCached<Reach>(CACHE_KEY, CACHE_TTL_MS);
  if (cached) return cached;
  return readReach();
}

/**
 * The same figure with the in-memory cache stepped over too, for the counter
 * that is watching it move. Polling harder than the server's own five minutes
 * buys nothing — the counter's job is to be *correct* while the page is open,
 * not to spin.
 */
export async function fetchReachFresh(): Promise<Reach | null> {
  return readReach();
}

/**
 * Round *down* to a readable figure, so the number on screen is never larger
 * than the number in the database. 512 reads "500+", 40 reads "40".
 *
 * `step` is the bucket the value falls into; small counts are printed exactly
 * because "0+" and "50+" would both be worse than the real figure.
 */
export function atLeast(value: number, step: number): string {
  if (value < step * 2) return value.toLocaleString("en-GB");
  return `${(Math.floor(value / step) * step).toLocaleString("en-GB")}+`;
}

/** Players: buckets of 50, so 512 reads "500+" and 40 reads "40". */
export function formatPlayers(value: number): string {
  return atLeast(value, 50);
}

/** Games: buckets of a thousand, which is the resolution anyone reads anyway. */
export function formatGames(value: number): string {
  return atLeast(value, 1000);
}

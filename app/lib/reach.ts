import { v1Maybe } from "./v1/client";
import type { PublicStats } from "./v1/types";
import { getCached, setCached } from "./loaderCache";

/**
 * The one claim the landing page makes about our scale, from
 * `GET /v1/public/stats`.
 *
 * It counts rows in the database: nothing here is a constant a designer can
 * bump. If the call fails the caller shows nothing, because an invented number
 * is worse than no number (DESIGN.md, "Public copy rules").
 *
 * Two things changed when this moved off the prototype's `/stats/reach`, and
 * both are the contract being stricter rather than the figures moving.
 *
 * `players` is a disclosure, not a number: a count small enough to identify
 * somebody comes back as "fewer than N" instead of the exact figure, so callers
 * must render both shapes. `games` stays a plain integer, since a game count
 * names nobody.
 *
 * The roster of handles is gone. `/v1` withholds it — it is named in the
 * response's own redaction block as `data.playersList` — because those accounts
 * are real people screened from public arena results who never opted into being
 * listed, and the contract's rule that provider handles require opt-in does not
 * stop applying because the surface is a statistic.
 */

export type Reach = PublicStats;

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
  const reach = await v1Maybe<Reach>("/v1/public/stats", {
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

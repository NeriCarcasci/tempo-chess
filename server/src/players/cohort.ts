import { client } from "../db/client.js";
import { createLichessImport, getImport } from "../pipeline/service.js";
import { normalizeProviderUsername } from "../ingest/canonical.js";
import { readReachNow } from "./reach.js";

/**
 * The study cohort: a few hundred real Lichess players whose public archives we
 * run through the whole pipeline before release.
 *
 * Two jobs, in this order of importance:
 *
 * 1. It is how we find out whether the analysis holds up across rating bands,
 *    time controls and openings we did not pick ourselves. A corpus we chose by
 *    hand would only ever confirm what we already believe.
 * 2. It is what the landing page counts. `/stats/reach` counts screened games,
 *    so the figure there moves as this runs and stops moving when it stops.
 *    Nothing here writes a number anywhere; the number is a consequence.
 *
 * Everything it touches is public: Lichess game archives, fetched with no token,
 * exactly as the site's own export button serves them.
 */

const LICHESS = "https://lichess.org";

/** Lichess asks for one request at a time from a script. We go slower than that. */
const CALL_SPACING_MS = 1200;
/** Their documented cool-off after a 429 is a full minute. */
const RATE_LIMIT_BACKOFF_MS = 65_000;
/** A player whose import stops making progress is abandoned, not waited on forever. */
const IMPORT_TIMEOUT_MS = 30 * 60_000;
const POLL_MS = 4000;

let lastCallAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function paced(path: string): Promise<Response> {
  const wait = lastCallAt + CALL_SPACING_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
  const response = await fetch(`${LICHESS}${path}`, {
    headers: { Accept: "application/x-ndjson, application/json" },
  });
  if (response.status === 429) {
    console.warn(`  lichess rate limit, waiting ${RATE_LIMIT_BACKOFF_MS / 1000}s`);
    await sleep(RATE_LIMIT_BACKOFF_MS);
    return paced(path);
  }
  if (!response.ok) throw new Error(`GET ${path} returned ${response.status}`);
  return response;
}

async function lichessJson<T>(path: string): Promise<T> {
  return (await paced(path)).json() as Promise<T>;
}

async function lichessNdjson(path: string): Promise<Record<string, unknown>[]> {
  const text = await (await paced(path)).text();
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export interface Candidate {
  username: string;
  rating: number | null;
  /** Which arena we found them in, so a surprising result can be traced back. */
  source: string;
}

interface Arena {
  id: string;
  fullName?: string;
  nbPlayers?: number;
  variant?: string | { key?: string };
  perf?: { key?: string };
}

function isStandard(arena: Arena): boolean {
  const variant = typeof arena.variant === "string" ? arena.variant : arena.variant?.key;
  return variant === undefined || variant === "standard";
}

export interface HarvestOptions {
  /** How many usernames to come back with. */
  target: number;
  /** Inclusive rating band, or null for anyone. */
  band: [number, number] | null;
}

/**
 * Usernames from recently finished arenas.
 *
 * Arenas are the least biased public list Lichess offers: the leaderboard APIs
 * return titled players with enormous archives, which is the opposite of the
 * population we need. This still skews towards active players and towards the
 * top of each arena's table (the results endpoint is ranked), so `band` exists
 * to pull the sample back down into ordinary rating territory.
 */
export async function harvestUsernames(options: HarvestOptions): Promise<Candidate[]> {
  const { finished = [] } = await lichessJson<{ finished?: Arena[] }>("/api/tournament");
  const arenas = finished
    .filter(isStandard)
    .sort((a, b) => (b.nbPlayers ?? 0) - (a.nbPlayers ?? 0));

  const seen = new Set<string>();
  const candidates: Candidate[] = [];

  for (const arena of arenas) {
    if (candidates.length >= options.target) break;
    const name = arena.fullName ?? arena.id;
    let rows: Record<string, unknown>[];
    try {
      rows = await lichessNdjson(`/api/tournament/${arena.id}/results?nb=200`);
    } catch (error) {
      console.warn(`  skipping arena ${name}: ${(error as Error).message}`);
      continue;
    }
    let taken = 0;
    for (const row of rows) {
      if (candidates.length >= options.target) break;
      const username = typeof row.username === "string" ? row.username : null;
      if (!username) continue;
      // Bots play thousands of games a day and are not what we are testing on.
      if (row.title === "BOT") continue;
      const key = normalizeProviderUsername(username);
      if (seen.has(key)) continue;
      const rating = typeof row.rating === "number" ? row.rating : null;
      if (options.band && (rating == null || rating < options.band[0] || rating > options.band[1])) {
        continue;
      }
      seen.add(key);
      candidates.push({ username, rating, source: name });
      taken += 1;
    }
    console.log(`  ${name}: took ${taken} (${candidates.length}/${options.target})`);
  }

  return candidates;
}

/**
 * Players we have already been through. The pipeline stores one linked account
 * per username, so a finished import is the resume marker: re-running the script
 * after a crash picks up where it stopped instead of paying for it all again.
 */
async function alreadyDone(): Promise<Set<string>> {
  const rows = await client`
    select distinct a.normalized_username
    from analysis_imports i
    join linked_accounts a on a.id = i.account_id
    where i.status = 'completed' and a.platform = 'lichess'`;
  return new Set(rows.map((row) => String(row.normalized_username)));
}

export interface CohortOptions extends HarvestOptions {
  /** Games per player. The whole archive is rarely worth the engine time. */
  gamesPerPlayer: number;
  /** Harvest and print, import nothing. */
  dryRun: boolean;
  /** Use these usernames instead of harvesting. */
  usernames?: string[];
}

export interface CohortResult {
  attempted: number;
  imported: number;
  skipped: number;
  failed: string[];
  reach: { players: number; games: number };
}

/** One player, start to finish. Resolves once the import stops moving. */
async function importPlayer(username: string, games: number): Promise<"completed" | "failed"> {
  const started = await createLichessImport(username, games);
  const deadline = Date.now() + IMPORT_TIMEOUT_MS;
  let current = started;
  while (Date.now() < deadline) {
    if (current.status === "completed") return "completed";
    if (current.status === "failed" || current.status === "cancelled") return "failed";
    await sleep(POLL_MS);
    current = (await getImport(started.id)) ?? current;
  }
  console.warn(`  ${username}: still ${current.status} after 30 minutes, moving on`);
  return "failed";
}

/**
 * Run the cohort. Strictly one player at a time: the analysis worker is a single
 * serial loop with one engine, and firing every import at once would queue
 * hundreds of archive downloads at Lichess in the same second.
 */
export async function runCohort(options: CohortOptions): Promise<CohortResult> {
  const candidates = options.usernames
    ? options.usernames.map((username) => ({ username, rating: null, source: "list" }))
    : await harvestUsernames(options);

  if (options.dryRun) {
    for (const candidate of candidates) {
      console.log(`${candidate.username}\t${candidate.rating ?? "?"}\t${candidate.source}`);
    }
    const reach = await readReachNow();
    return { attempted: candidates.length, imported: 0, skipped: 0, failed: [], reach };
  }

  const done = await alreadyDone();
  const failed: string[] = [];
  let imported = 0;
  let skipped = 0;

  for (const [index, candidate] of candidates.entries()) {
    const position = `${index + 1}/${candidates.length}`;
    if (done.has(normalizeProviderUsername(candidate.username))) {
      skipped += 1;
      console.log(`${position} ${candidate.username}: already analysed, skipping`);
      continue;
    }
    try {
      const outcome = await importPlayer(candidate.username, options.gamesPerPlayer);
      if (outcome === "completed") imported += 1;
      else failed.push(candidate.username);
    } catch (error) {
      failed.push(candidate.username);
      console.warn(`${position} ${candidate.username}: ${(error as Error).message}`);
      continue;
    }
    // The same number the landing page reads, so progress is visible in the
    // terms the claim is made in.
    const reach = await readReachNow();
    console.log(
      `${position} ${candidate.username}: done. reach now ${reach.players} players, ${reach.games} games`,
    );
  }

  return { attempted: candidates.length, imported, skipped, failed, reach: await readReachNow() };
}

import { writeFile } from "node:fs/promises";

import { Chess } from "chess.js";

import { parsePgn } from "../ingest/pgn.js";
import { ratingBandFor, type Speed } from "./contract.js";
import {
  DEFAULT_SAMPLING_POLICY,
  checkSplitRules,
  excludeStraddlingAccounts,
  groupBySlice,
  manifestHash,
  selectHoldoutPositions,
  type HoldoutPosition,
  type ReplayedGame,
} from "./holdout.js";

/**
 * Build a holdout corpus from public Lichess games.
 *
 * `npm run models:holdout -- --out=corpus.jsonl [--target=700] [--arenas=40]`
 *
 * Games come from finished public arenas rather than from a hand-picked list of
 * players: an arena is a pool nobody chose for its results, which is the closest
 * thing to a random sample of real games that a public API offers. Ratings come
 * from the game's own PGN headers, so a position is binned by what the player
 * was rated when they played it rather than by what they are rated today.
 *
 * The network lives here and the sampling policy lives in `holdout.ts`, so the
 * policy is testable without a provider and the corpus is reproducible from its
 * manifest hash.
 */

const USER_AGENT =
  "forma-chess-benchmark/1.0 (+https://github.com/NKO42/forma-chess)";
const LICHESS = "https://lichess.org";

/** Speeds Forma calibrates. Correspondence is excluded: no clock, no pressure. */
const WANTED_SPEEDS: readonly Speed[] = ["blitz", "rapid"];

interface ArenaSummary {
  id: string;
  perf: Speed;
  finished: boolean;
}

async function get(path: string, accept: string): Promise<string> {
  const response = await fetch(`${LICHESS}${path}`, {
    headers: { "User-Agent": USER_AGENT, Accept: accept },
  });
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status} ${response.statusText}`);
  }
  return response.text();
}

async function listArenas(pages: number): Promise<ArenaSummary[]> {
  const arenas: ArenaSummary[] = [];
  for (let page = 1; page <= pages; page += 1) {
    const body = await get(`/api/tournament?page=${page}`, "application/json");
    const parsed = JSON.parse(body) as {
      finished?: { id: string; perf?: { key?: string } }[];
    };
    for (const arena of parsed.finished ?? []) {
      const perf = arena.perf?.key;
      if (perf && (WANTED_SPEEDS as readonly string[]).includes(perf)) {
        arenas.push({ id: arena.id, perf: perf as Speed, finished: true });
      }
    }
    await pause(1_000);
  }
  // The finished list is not paged the way the created one is: later pages
  // repeat the same tournaments. Deduplicating here rather than re-downloading
  // a quarter of a million moves to add nothing.
  const seen = new Set<string>();
  return arenas.filter((arena) => !seen.has(arena.id) && seen.add(arena.id));
}

/** Recent rated games for one account, as PGN. */
async function userGames(username: string, max: number): Promise<string> {
  return get(
    `/api/games/user/${encodeURIComponent(username)}?max=${max}&rated=true` +
      `&perfType=blitz,rapid&clocks=false&evals=false&opening=false&literate=false`,
    "application/x-chess-pgn",
  );
}

function speedOfPgn(pgn: string): Speed | null {
  // Lichess writes the perf into the Event tag: "Rated blitz game".
  const event = /\[Event "([^"]*)"\]/.exec(pgn)?.[1]?.toLowerCase() ?? "";
  for (const speed of WANTED_SPEEDS) if (event.includes(speed)) return speed;
  return null;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Split a PGN stream into individual games. */
function splitPgn(stream: string): string[] {
  const games: string[] = [];
  let current: string[] = [];
  for (const line of stream.split(/\r?\n/)) {
    if (line.startsWith("[Event ") && current.some((l) => !l.startsWith("["))) {
      games.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.some((l) => l.trim().length > 0)) games.push(current.join("\n"));
  return games;
}

/** Replay one PGN into the shape the sampler wants, or null if unusable. */
export function replayGame(pgn: string, speed: Speed): ReplayedGame | null {
  const parsed = parsePgn(pgn);
  if (parsed.warning || parsed.moves.length === 0) return null;

  const headers = parsed.headers;
  const variant = headers.Variant ?? "Standard";
  if (variant !== "Standard") return null;
  // Rated games only: an unrated game is not evidence about the rating it is
  // filed under.
  if ((headers.Result ?? "*") === "*") return null;

  const whiteRating = Number(headers.WhiteElo);
  const blackRating = Number(headers.BlackElo);
  if (!Number.isFinite(whiteRating) || !Number.isFinite(blackRating)) return null;

  const white = headers.White;
  const black = headers.Black;
  const site = headers.Site ?? "";
  const gameKey = site.split("/").filter(Boolean).pop() ?? "";
  const playedAt = isoDate(headers.UTCDate, headers.UTCTime);
  if (!white || !black || !gameKey || !playedAt) return null;

  const board = new Chess();
  const positions: ReplayedGame["positions"] = parsed.moves.map((move) => {
    const legalMoveCount = board.moves().length;
    board.move(move.san);
    return {
      // parsePgn numbers plies from 1; the corpus numbers positions from 0, so
      // ply 0 is the initial position and an even ply always has White to move.
      ply: move.ply - 1,
      fen: move.fenBefore,
      legalMoveCount,
      playedUci: move.uci,
    };
  });

  return {
    gameKey,
    provider: "lichess",
    speed,
    playedAt,
    whiteAccountKey: white.toLowerCase(),
    blackAccountKey: black.toLowerCase(),
    whiteRating,
    blackRating,
    positions,
  };
}

function isoDate(date?: string, time?: string): string | null {
  if (!date) return null;
  const normalized = date.replace(/\./g, "-");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;
  return `${normalized}T${time && /^\d{2}:\d{2}:\d{2}$/.test(time) ? time : "00:00:00"}Z`;
}

async function main(): Promise<void> {
  const args = new Map(
    process.argv.slice(2).map((arg) => {
      const [key, value = "true"] = arg.replace(/^--/, "").split("=");
      return [key, value] as const;
    }),
  );
  const out = args.get("out") ?? "holdout.jsonl";
  const perBandTarget = Number(args.get("target") ?? 700);
  const arenaPages = Number(args.get("pages") ?? 6);
  const maxGamesPerArena = Number(args.get("games") ?? 250);
  const maxGamesPerAccount = Number(args.get("user-games") ?? 20);
  const trainingWindowEnd = args.get("training-window-end") ?? "2020-01-01T00:00:00Z";

  console.log(`listing arenas over ${arenaPages} pages`);
  const arenas = await listArenas(arenaPages);
  console.log(`found ${arenas.length} finished ${WANTED_SPEEDS.join("/")} arenas`);

  const positions: HoldoutPosition[] = [];
  const perBand = new Map<number, number>();
  const seenGames = new Set<string>();

  for (const arena of arenas) {
    if (bandsSatisfied(perBand, perBandTarget)) break;
    let stream: string;
    try {
      stream = await get(
        `/api/tournament/${arena.id}/games?max=${maxGamesPerArena}&clocks=false&evals=false&opening=false&literate=false`,
        "application/x-chess-pgn",
      );
    } catch (error) {
      console.warn(`arena ${arena.id}: ${(error as Error).message}`);
      await pause(2_000);
      continue;
    }

    let added = 0;
    for (const pgn of splitPgn(stream)) {
      const game = replayGame(pgn, arena.perf);
      if (game === null || seenGames.has(game.gameKey)) continue;
      seenGames.add(game.gameKey);
      for (const position of selectHoldoutPositions(game)) {
        const band = ratingBandFor(position.moverRating);
        if (band === null) continue;
        // Stop feeding a band that already has what it needs, so a popular
        // rating range does not crowd out the ones the claim depends on.
        if ((perBand.get(band.low) ?? 0) >= perBandTarget) continue;
        positions.push(position);
        perBand.set(band.low, (perBand.get(band.low) ?? 0) + 1);
        added += 1;
      }
    }
    console.log(
      `arena ${arena.id} (${arena.perf}): +${added} positions, total ${positions.length}`,
    );
    await pause(2_000);
  }

  // Second pass: top up the bands the arenas left short, by asking the accounts
  // we already saw for their own recent games. Arenas are a good random sample
  // of games but a poor one of rating bands -- most players are 1200-1700, so
  // the ends of the calibrated range stay empty without this.
  const candidates = candidateAccounts(positions, perBand, perBandTarget);
  console.log(`
topping up from ${candidates.length} accounts in short bands`);
  for (const account of candidates) {
    if (bandsSatisfied(perBand, perBandTarget)) break;
    let stream: string;
    try {
      stream = await userGames(account, maxGamesPerAccount);
    } catch (error) {
      console.warn(`user ${account}: ${(error as Error).message}`);
      await pause(3_000);
      continue;
    }
    let added = 0;
    for (const pgn of splitPgn(stream)) {
      const speed = speedOfPgn(pgn);
      if (speed === null) continue;
      const game = replayGame(pgn, speed);
      if (game === null || seenGames.has(game.gameKey)) continue;
      seenGames.add(game.gameKey);
      for (const position of selectHoldoutPositions(game)) {
        const band = ratingBandFor(position.moverRating);
        if (band === null) continue;
        if ((perBand.get(band.low) ?? 0) >= perBandTarget) continue;
        positions.push(position);
        perBand.set(band.low, (perBand.get(band.low) ?? 0) + 1);
        added += 1;
      }
    }
    if (added > 0) console.log(`  ${account}: +${added}, total ${positions.length}`);
    await pause(1_500);
  }

  const rules = checkSplitRules(positions, trainingWindowEnd);
  const kept = excludeStraddlingAccounts(positions, rules.straddlingAccounts);
  const finalRules = checkSplitRules(kept, trainingWindowEnd);
  const hash = manifestHash(kept);

  await writeFile(out, kept.map((p) => JSON.stringify(p)).join("\n") + "\n", "utf8");

  console.log("");
  console.log(`positions:              ${kept.length}`);
  console.log(`dropped for straddling: ${positions.length - kept.length}`);
  console.log(`distinct accounts:      ${new Set(kept.map((p) => p.moverAccountKey)).size}`);
  console.log(`distinct games:         ${new Set(kept.map((p) => p.gameKey)).size}`);
  console.log(`account disjoint:       ${finalRules.accountDisjoint}`);
  console.log(`chronological split:    ${finalRules.chronologicalSplit}`);
  console.log(`earliest game:          ${finalRules.earliestPlayedAt}`);
  console.log(`sampling policy:        ${DEFAULT_SAMPLING_POLICY.version}`);
  console.log(`manifest sha256:        ${hash}`);
  console.log("");
  for (const [key, group] of [...groupBySlice(kept).entries()].sort()) {
    console.log(
      `  ${key.padEnd(26)} ${String(group.positions.length).padStart(5)} positions, ` +
        `${new Set(group.positions.map((p) => p.moverAccountKey)).size} accounts`,
    );
  }
}

/**
 * Accounts worth asking for more games: the ones whose band is still short.
 *
 * Ordered by how short their band is, so the scarcest evidence is collected
 * first and a run that is cut off still leaves the corpus more balanced than it
 * found it.
 */
function candidateAccounts(
  positions: readonly HoldoutPosition[],
  perBand: Map<number, number>,
  target: number,
): string[] {
  const byAccount = new Map<string, number>();
  for (const position of positions) {
    const band = ratingBandFor(position.moverRating);
    if (band === null) continue;
    if ((perBand.get(band.low) ?? 0) >= target) continue;
    if (!byAccount.has(position.moverAccountKey)) byAccount.set(position.moverAccountKey, band.low);
  }
  return [...byAccount.entries()]
    .sort((a, b) => (perBand.get(a[1]) ?? 0) - (perBand.get(b[1]) ?? 0))
    .map(([account]) => account);
}

function bandsSatisfied(perBand: Map<number, number>, target: number): boolean {
  // Bands Maia actually covers. Filling 1000-1100 and 2100-2200 is welcome but
  // is not what the run is waiting for.
  const wanted = [1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900];
  return wanted.every((band) => (perBand.get(band) ?? 0) >= target);
}

if (process.argv[1]?.endsWith("fetch-holdout.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

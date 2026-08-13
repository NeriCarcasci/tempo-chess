import { readFile } from "node:fs/promises";
import { client } from "../db/client.js";
import { runCohort } from "./cohort.js";

/**
 * Run the study cohort.
 *
 *   npm run cohort -- --players=500 --games=30 --band=1000-2200
 *   npm run cohort -- --players=40 --dry-run          # print the roster only
 *   npm run cohort -- --from=roster.txt --games=30    # a list you chose yourself
 *
 * Safe to stop and restart: players with a completed import are skipped, so a
 * second run continues rather than paying for the same games twice.
 *
 * It analyses in this process, using this machine's STOCKFISH_PATH, one player
 * at a time. Budget accordingly: at 30 games a player, ~60 screened positions a
 * game and the ~58ms/position in benchmark/BASELINE.md, 500 players is on the
 * order of 15 engine-hours.
 */

function argument(name: string): string | undefined {
  const token = process.argv.find((entry) => entry.startsWith(`--${name}=`));
  return token?.slice(name.length + 3);
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function parseBand(value: string | undefined): [number, number] | null {
  if (!value) return null;
  const [low, high] = value.split("-").map((part) => Number(part.trim()));
  if (!Number.isFinite(low) || !Number.isFinite(high) || low >= high) {
    throw new Error(`--band expects "low-high", got "${value}"`);
  }
  return [low, high];
}

const target = Number(argument("players") ?? "500");
const gamesPerPlayer = Number(argument("games") ?? "30");
const band = parseBand(argument("band"));
const from = argument("from");
const dryRun = flag("dry-run");

const usernames = from
  ? (await readFile(from, "utf8"))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
  : undefined;

try {
  console.log(
    usernames
      ? `Cohort: ${usernames.length} usernames from ${from}, ${gamesPerPlayer} games each`
      : `Cohort: ${target} players${band ? ` rated ${band[0]}-${band[1]}` : ""}, ${gamesPerPlayer} games each`,
  );
  const result = await runCohort({ target, band, gamesPerPlayer, dryRun, usernames });
  console.log(
    `\nAttempted ${result.attempted}. Imported ${result.imported}, skipped ${result.skipped}, failed ${result.failed.length}.`,
  );
  if (result.failed.length) console.log(`Failed: ${result.failed.join(", ")}`);
  console.log(`Reach: ${result.reach.players} players, ${result.reach.games} games.`);
} finally {
  await client.end();
}

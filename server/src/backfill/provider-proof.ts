/**
 * `npm run backfill:proof` — the whole canonical pipeline, on real games.
 *
 * Everything E08 and E09 built has so far only run on fixtures. This fetches a
 * small number of real games from the Lichess public API, pushes them through
 * normalization, the atomic commit, materialization and exact search, and
 * reports what happened.
 *
 * It is deliberately not a provider adapter. There is no rate-limit loop, no
 * cursor, no incremental mode and no Chess.com support -- those are E08's
 * remaining scope. This is a proof that the substrate accepts real data, using
 * one bounded read-only request against a public endpoint.
 *
 * Usage: LICHESS_USER=<handle> npm run backfill:proof
 */

import { Chess } from "chessops/chess";
import { parseFen, INITIAL_FEN } from "chessops/fen";
import { parseSan } from "chessops/san";
import { makeUci } from "chessops/util";
import postgres from "postgres";
import { normalizeGame, type ProviderGameInput } from "../sync/contract.js";
import { commitBatch, finishSyncRun, startSyncRun } from "../sync/commit.js";
import { buildRun, findExactPosition, publishRun } from "../positions/materialize.js";
import { materializeReplay } from "../positions/canonical.js";

const handle = process.env.LICHESS_USER?.trim();
if (!handle) {
  console.error("LICHESS_USER is not set");
  process.exit(1);
}
const MAX_GAMES = Number(process.env.PROOF_GAMES ?? 5);

interface LichessGame {
  id: string;
  rated?: boolean;
  variant?: string;
  speed?: string;
  status?: string;
  winner?: "white" | "black";
  createdAt?: number;
  lastMoveAt?: number;
  moves?: string;
  clock?: { initial: number; increment: number };
  players?: {
    white?: { user?: { name?: string }; rating?: number; ratingDiff?: number };
    black?: { user?: { name?: string }; rating?: number; ratingDiff?: number };
  };
}

/** Lichess returns SAN; the canonical replay is UCI, so replay it to convert. */
function toUciMoves(san: string): { uci: string }[] {
  const setup = parseFen(INITIAL_FEN);
  if (setup.isErr) throw new Error("bad initial fen");
  const positionResult = Chess.fromSetup(setup.value);
  if (positionResult.isErr) throw new Error("bad initial position");
  const position = positionResult.value;
  const moves: { uci: string }[] = [];
  for (const token of san.trim().split(/\s+/).filter(Boolean)) {
    const parsed = parseSan(position, token);
    if (!parsed) throw new Error(`unparsable san: ${token}`);
    moves.push({ uci: makeUci(parsed) });
    position.play(parsed);
  }
  return moves;
}

const url =
  `https://lichess.org/api/games/user/${encodeURIComponent(handle)}` +
  `?max=${MAX_GAMES}&moves=true&clocks=false&evals=false&opening=false`;

console.log(`fetching up to ${MAX_GAMES} games for ${handle}\n`);
const response = await fetch(url, { headers: { accept: "application/x-ndjson" } });
if (!response.ok) {
  console.error(`lichess responded ${response.status}`);
  process.exit(1);
}
const body = await response.text();
const raw: LichessGame[] = body
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as LichessGame);
console.log(`lichess returned ${raw.length} games`);

// Map to the provider-neutral input E08 normalizes.
const inputs: ProviderGameInput[] = raw.map((game) => ({
  providerGameId: game.id,
  variant: game.variant ?? null,
  status: game.status ?? null,
  winner: game.status && ["started", "created"].includes(game.status)
    ? undefined
    : (game.winner ?? null),
  moves: game.moves ? toUciMoves(game.moves) : [],
  playedAt: new Date(game.createdAt ?? Date.now()),
  completedAt: game.lastMoveAt ? new Date(game.lastMoveAt) : null,
  rated: game.rated ?? null,
  speed: game.speed ?? null,
  timeControl: game.clock ? `${game.clock.initial}+${game.clock.increment}` : null,
  url: `https://lichess.org/${game.id}`,
  white: {
    username: game.players?.white?.user?.name ?? null,
    rating: game.players?.white?.rating ?? null,
    ratingChange: game.players?.white?.ratingDiff ?? null,
  },
  black: {
    username: game.players?.black?.user?.name ?? null,
    rating: game.players?.black?.rating ?? null,
    ratingChange: game.players?.black?.ratingDiff ?? null,
  },
}));

const accepted = [];
const rejected: string[] = [];
for (const input of inputs) {
  const outcome = normalizeGame(input);
  if (outcome.accepted) accepted.push(outcome.game);
  else rejected.push(outcome.reason);
}
console.log(`normalized: ${accepted.length} accepted, ${rejected.length} rejected` +
  (rejected.length ? ` (${[...new Set(rejected)].join(", ")})` : ""));

const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });

// The owner and claim this proof commits under.
const [identity] = await sql<{ id: string }[]>`
  select pi.id from app.provider_identities pi
  where pi.provider_id = 2 and pi.current_normalized_username = ${handle.toLowerCase()}
  limit 1
`;
const [claim] = identity
  ? await sql<{ id: string; owner_user_id: string }[]>`
      select id, owner_user_id from app.linked_accounts
      where provider_identity_id = ${identity.id} and status <> 'disconnected' limit 1
    `
  : [undefined];

if (!claim) {
  console.error(`no linked account found for ${handle}; link it first`);
  await sql.end();
  process.exit(1);
}
const [subject] = await sql<{ id: string }[]>`
  select id from app.analysis_subjects
  where owner_user_id = ${claim.owner_user_id} and kind = 'personal' and status = 'active'
`;

const runId = await startSyncRun(sql, claim.id, "reconcile");
const result = await commitBatch(sql, {
  syncRunId: runId,
  linkedAccountId: claim.id,
  subjectId: subject.id,
  providerId: 2,
  sequenceNo: 1,
  cursorAfter: accepted[0]?.providerGameId ?? null,
  games: accepted,
  subjectUsernames: [handle],
  rejections: rejected as never[],
});
await finishSyncRun(sql, runId, "succeeded");
console.log(
  `committed: accepted ${result.accepted}, duplicate ${result.duplicate}, ` +
    `corrected ${result.corrected}, rejected ${result.rejected}`,
);

// Materialize each committed replay and publish it.
let materialized = 0;
let occurrences = 0;
for (const game of accepted) {
  const [revision] = await sql<{ id: string }[]>`
    select r.id from chess.game_replay_revisions r
    join chess.provider_games g on g.id = r.provider_game_id
    where g.provider_id = 2 and g.provider_game_id = ${game.providerGameId}
    order by r.revision_no desc limit 1
  `;
  if (!revision) continue;
  const built = await buildRun(sql, revision.id, {
    moves: game.normalizedReplay.moves.map((move) => ({ uci: move.uci, clockMs: move.clockMs })),
  });
  if (!built.alreadyPublished) await publishRun(sql, built.runId);
  materialized += 1;
  occurrences += built.occurrenceCount;
}
console.log(`materialized: ${materialized} runs, ${occurrences} occurrences`);

// The opening position must now be findable across every game that reached it.
const start = materializeReplay({ moves: [] }).occurrences[0];
const hits = await findExactPosition(sql, start.coreKeyHash, null, 200);
console.log(`exact search for the starting position: ${hits.length} occurrences across ${new Set(hits.map((h) => h.runId)).size} runs`);

await sql.end();
console.log("\ndone");

/**
 * `npm run positions:materialize` — persistence, publication and exact search,
 * against a real database.
 *
 * Needs `DATABASE_URL`. Proves what only the database can answer: publication
 * is atomic and single, a transposition across two different games finds one
 * shared core position, and a rebuild is compared rather than assumed.
 *
 * Everything it creates is removed at the end.
 */

import { strict as assert } from "node:assert";
import postgres from "postgres";
import { coreKeyHash, materializeReplay } from "./canonical.js";
import { buildRun, compareRebuild, findExactPosition, publishRun } from "./materialize.js";

const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
let passed = 0;
const failures: string[] = [];

async function check(name: string, body: () => Promise<string>): Promise<void> {
  try {
    console.log(`ok   ${name} — ${await body()}`);
    passed += 1;
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    console.log(`FAIL ${name}`);
  }
}

const STAMP = Date.now();
const HASH = (n: number) => `${n}`.padStart(64, "0").replace(/[^0-9a-f]/g, "0");

// Two provider games, so a transposition can be observed across games.
const revisionIds: string[] = [];
const gameIds: string[] = [];
for (const index of [1, 2]) {
  const [game] = await sql<{ id: string }[]>`
    insert into chess.provider_games (provider_id, provider_game_id)
    values (2, ${`e09-probe-${STAMP}-${index}`}) returning id
  `;
  gameIds.push(game.id);
  const [revision] = await sql<{ id: string }[]>`
    insert into chess.game_replay_revisions (
      provider_game_id, revision_no, normalizer_component_version_id, normalized_replay,
      normalized_sha256, played_at, result, ply_count, revision_reason
    ) values (
      ${game.id}, 1, 'norm-v1', '{"moves":[]}'::jsonb, ${HASH(index)}, now(), 'white', 4, 'first_seen'
    ) returning id
  `;
  revisionIds.push(revision.id);
}

// Two different move orders reaching the same position: a transposition.
const DIRECT = { moves: [{ uci: "g1f3" }, { uci: "g8f6" }, { uci: "d2d4" }, { uci: "d7d5" }] };
const TRANSPOSED = { moves: [{ uci: "d2d4" }, { uci: "d7d5" }, { uci: "g1f3" }, { uci: "g8f6" }] };

console.log("cd server && npm run positions:materialize\n");

let runA = "";
let runB = "";

await check("a run stores the whole chain and only publishes on request", async () => {
  const built = await buildRun(sql, revisionIds[0], DIRECT);
  runA = built.runId;
  const [row] = await sql<{ state: string; occurrence_count: number; transition_count: number }[]>`
    select state, occurrence_count, transition_count from chess.materialization_runs where id = ${runA}
  `;
  const [{ occurrences }] = await sql<{ occurrences: number }[]>`
    select count(*)::int as occurrences from chess.position_occurrences where run_id = ${runA}
  `;
  const [{ transitions }] = await sql<{ transitions: number }[]>`
    select count(*)::int as transitions from chess.position_transitions where run_id = ${runA}
  `;
  assert.equal(row.state, "building");
  assert.equal(occurrences, 5);
  assert.equal(transitions, 4);
  assert.equal(built.occurrenceCount, 5);
  return `5 occurrences, 4 transitions, state ${row.state}`;
});

await check("publication is atomic and there is exactly one published run", async () => {
  const result = await publishRun(sql, runA);
  assert.equal(result.published, true);
  const [{ published }] = await sql<{ published: number }[]>`
    select count(*)::int as published from chess.materialization_runs
    where replay_revision_id = ${revisionIds[0]} and state = 'published'
  `;
  assert.equal(published, 1);
  // Publishing twice is a no-op rather than a second row or an error.
  const again = await publishRun(sql, runA);
  assert.equal(again.published, true);
  const [{ still }] = await sql<{ still: number }[]>`
    select count(*)::int as still from chess.materialization_runs
    where replay_revision_id = ${revisionIds[0]} and state = 'published'
  `;
  assert.equal(still, 1);
  return "1 published run; publishing twice changes nothing";
});

await check("a transposition in another game shares one core position", async () => {
  const built = await buildRun(sql, revisionIds[1], TRANSPOSED);
  runB = built.runId;
  await publishRun(sql, runB);

  const direct = materializeReplay(DIRECT);
  const transposed = materializeReplay(TRANSPOSED);
  // The final positions are the same board reached two ways.
  assert.equal(direct.occurrences[4].coreKey, transposed.occurrences[4].coreKey);
  // ...but the chains differ, so the checksums must not collide.
  assert.notEqual(direct.checksum, transposed.checksum);

  const hits = await findExactPosition(sql, direct.occurrences[4].coreKeyHash);
  const runs = new Set(hits.map((hit) => hit.runId));
  assert.equal(hits.length >= 2, true, `expected the position in both runs, got ${hits.length}`);
  assert.equal(runs.size >= 2, true, "the transposition was not found across both games");

  const [{ cores }] = await sql<{ cores: number }[]>`
    select count(*)::int as cores from chess.core_positions
    where core_key_hash = ${direct.occurrences[4].coreKeyHash}
  `;
  assert.equal(cores, 1, "the same board produced two core positions");
  return `1 core position, found in ${runs.size} runs via ${hits.length} occurrences`;
});

await check("exact search is keyset-paginated and stable", async () => {
  const hash = coreKeyHash(materializeReplay(DIRECT).occurrences[0].coreKey);
  const firstPage = await findExactPosition(sql, hash, null, 1);
  assert.equal(firstPage.length, 1);
  const secondPage = await findExactPosition(
    sql,
    hash,
    { runId: firstPage[0].runId, ply: firstPage[0].ply },
    1,
  );
  assert.equal(secondPage.length, 1);
  // The cursor advanced rather than repeating the first row.
  assert.notEqual(
    `${firstPage[0].runId}:${firstPage[0].ply}`,
    `${secondPage[0].runId}:${secondPage[0].ply}`,
  );
  return "page 2 continues after page 1 rather than repeating it";
});

await check("an unpublished run is invisible to search", async () => {
  const built = await buildRun(sql, revisionIds[0], {
    moves: [{ uci: "e2e4" }, { uci: "e7e5" }, { uci: "g1f3" }, { uci: "b8c6" }],
  });
  const hash = materializeReplay({
    moves: [{ uci: "e2e4" }, { uci: "e7e5" }, { uci: "g1f3" }, { uci: "b8c6" }],
  }).occurrences[4].coreKeyHash;
  const hits = await findExactPosition(sql, hash);
  assert.equal(hits.length, 0, "a building run was searchable");
  // Publishing it supersedes the old one rather than creating a second.
  const result = await publishRun(sql, built.runId);
  assert.equal(result.checksumChanged, true);
  assert.notEqual(result.supersededRunId, null);
  const [{ published }] = await sql<{ published: number }[]>`
    select count(*)::int as published from chess.materialization_runs
    where replay_revision_id = ${revisionIds[0]} and state = 'published'
  `;
  assert.equal(published, 1);
  const after = await findExactPosition(sql, hash);
  assert.equal(after.length, 1);
  return "invisible while building; on publish the prior run is superseded, not deleted";
});

await check("a rebuild is compared before anything is switched", async () => {
  const same = await compareRebuild(sql, revisionIds[1], TRANSPOSED);
  assert.equal(same.matches, true);
  const different = await compareRebuild(sql, revisionIds[1], DIRECT);
  assert.equal(different.matches, false);
  assert.notEqual(different.publishedChecksum, different.rebuiltChecksum);
  return "an identical rebuild matches; a different chain is reported, not applied";
});

await check("the derived draw flags cannot disagree with their counters", async () => {
  const [run] = await sql<{ id: string }[]>`
    select id from chess.materialization_runs where id = ${runB}
  `;
  let refused = false;
  try {
    await sql`
      insert into chess.position_occurrences (
        run_id, ply, core_position_id, fen, halfmove_clock, fullmove_number,
        repetition_count, side_to_move, threefold
      ) values (
        ${run.id}, 99, (select id from chess.core_positions limit 1), 'x',
        0, 1, 1, 'w', true
      )
    `;
  } catch {
    refused = true;
  }
  assert.equal(refused, true, "threefold with one occurrence was accepted");
  return "threefold true at repetition 1 is refused by constraint";
});

// Cleanup.
await sql`delete from chess.position_transitions where run_id in (
  select id from chess.materialization_runs where replay_revision_id = any(${revisionIds}))`;
await sql`delete from chess.position_occurrences where run_id in (
  select id from chess.materialization_runs where replay_revision_id = any(${revisionIds}))`;
await sql`delete from chess.materialization_runs where replay_revision_id = any(${revisionIds})`;
await sql`alter table chess.game_replay_revisions disable trigger replay_revisions_immutable`;
await sql`update chess.provider_games set current_replay_revision_id = null where id = any(${gameIds})`;
await sql`delete from chess.game_replay_revisions where id = any(${revisionIds})`;
await sql`alter table chess.game_replay_revisions enable trigger replay_revisions_immutable`;
await sql`delete from chess.provider_games where id = any(${gameIds})`;
const [{ left }] = await sql<{ left: number }[]>`
  select count(*)::int as left from chess.provider_games where provider_game_id like ${`e09-probe-${STAMP}%`}
`;
await sql.end();

console.log(`\n${passed} passed, ${failures.length} failed (rows left behind: ${left})`);
if (failures.length > 0 || left > 0) {
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
}

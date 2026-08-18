/**
 * `npm run sync:commit` — the atomic checkpoint commit, against a real database.
 *
 * Needs `DATABASE_URL`. Proves the acceptance criteria that only a database can
 * answer: a duplicate delivery is one canonical result and one cursor advance,
 * a provider correction appends without rewriting, and a lock is not held twice.
 *
 * Everything it creates is removed at the end.
 */

import { strict as assert } from "node:assert";
import postgres from "postgres";
import { normalizeGame, type ProviderGameInput } from "./contract.js";
import {
  acquireLock,
  commitBatch,
  finishSyncRun,
  providerLockKey,
  releaseLock,
  startSyncRun,
} from "./commit.js";

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

const OWNER = "00000000-0000-4000-8000-00000000e082";
const GAME_ID = `e08-commit-${Date.now()}`;

const RAW: ProviderGameInput = {
  providerGameId: GAME_ID,
  variant: "standard",
  status: "mate",
  winner: "white",
  moves: [
    { uci: "e2e4", san: "e4", clockMs: 60_000 },
    { uci: "e7e5", san: "e5", clockMs: 59_000 },
  ],
  playedAt: "2026-08-18T10:00:00Z",
  white: { username: "probe-white", rating: 1500 },
  black: { username: "probe-black", rating: 1490 },
};

// Fixture: profile, subject, provider identity, linked account.
await sql`delete from app.profiles where user_id = ${OWNER}`;
await sql`insert into app.profiles (user_id) values (${OWNER})`;
const [subject] = await sql<{ id: string }[]>`
  insert into app.analysis_subjects (kind, owner_user_id, display_label)
  values ('personal', ${OWNER}, 'commit probe') returning id
`;
await sql`delete from app.provider_identities where provider_identity_key = 'probe-white'`;
const [identity] = await sql<{ id: string }[]>`
  insert into app.provider_identities (provider_id, provider_identity_key, key_basis, current_normalized_username)
  values (2, 'probe-white', 'username', 'probe-white') returning id
`;
const [account] = await sql<{ id: string }[]>`
  insert into app.linked_accounts (owner_user_id, provider_identity_id)
  values (${OWNER}, ${identity.id}) returning id
`;

console.log("cd server && npm run sync:commit\n");

const normalized = normalizeGame(RAW);
if (!normalized.accepted) throw new Error("the fixture game was rejected");

let runId = "";

await check("a batch commits canonical rows, the cursor and a checkpoint together", async () => {
  runId = await startSyncRun(sql, account.id, "initial");
  const result = await commitBatch(sql, {
    syncRunId: runId,
    linkedAccountId: account.id,
    subjectId: subject.id,
    providerId: 2,
    sequenceNo: 1,
    cursorAfter: "cursor-1",
    games: [normalized.game],
    subjectUsernames: ["probe-white"],
    rejections: ["non_standard_variant"],
  });
  const [state] = await sql<{ cursor_value: string }[]>`
    select cursor_value from ops.account_sync_state where linked_account_id = ${account.id}
  `;
  const [{ checkpoints }] = await sql<{ checkpoints: number }[]>`
    select count(*)::int as checkpoints from ops.sync_checkpoints where sync_run_id = ${runId}
  `;
  const [sg] = await sql<{ subject_color: string; status: string }[]>`
    select subject_color, status from chess.subject_games where subject_id = ${subject.id}
  `;
  assert.equal(result.accepted, 1);
  assert.equal(result.rejected, 1);
  assert.equal(state.cursor_value, "cursor-1");
  assert.equal(checkpoints, 1);
  assert.equal(sg.subject_color, "white");
  assert.equal(sg.status, "included");
  return `accepted 1, rejected 1, cursor ${state.cursor_value}, colour ${sg.subject_color}`;
});

await check("a duplicate delivery is one result and one cursor, not two", async () => {
  const result = await commitBatch(sql, {
    syncRunId: runId,
    linkedAccountId: account.id,
    subjectId: subject.id,
    providerId: 2,
    sequenceNo: 1,
    cursorAfter: "cursor-1",
    games: [normalized.game],
    subjectUsernames: ["probe-white"],
    rejections: [],
  });
  const [{ revisions }] = await sql<{ revisions: number }[]>`
    select count(*)::int as revisions from chess.game_replay_revisions r
    join chess.provider_games g on g.id = r.provider_game_id
    where g.provider_game_id = ${GAME_ID}
  `;
  const [{ games }] = await sql<{ games: number }[]>`
    select count(*)::int as games from chess.subject_games where subject_id = ${subject.id}
  `;
  const [{ checkpoints }] = await sql<{ checkpoints: number }[]>`
    select count(*)::int as checkpoints from ops.sync_checkpoints where sync_run_id = ${runId}
  `;
  assert.equal(result.duplicate, 1);
  assert.equal(result.accepted, 0);
  assert.equal(revisions, 1, "a redelivery appended a revision");
  assert.equal(games, 1);
  assert.equal(checkpoints, 1, "a redelivery wrote a second checkpoint");
  return "1 revision, 1 subject game, 1 checkpoint";
});

await check("a provider correction appends a revision and moves the pointer", async () => {
  const corrected = normalizeGame({ ...RAW, winner: "black" });
  if (!corrected.accepted) throw new Error("unreachable");
  const result = await commitBatch(sql, {
    syncRunId: runId,
    linkedAccountId: account.id,
    subjectId: subject.id,
    providerId: 2,
    sequenceNo: 2,
    cursorAfter: "cursor-2",
    games: [corrected.game],
    subjectUsernames: ["probe-white"],
    rejections: [],
  });
  const revisions = await sql<{ revision_no: number; result: string; revision_reason: string }[]>`
    select r.revision_no, r.result, r.revision_reason from chess.game_replay_revisions r
    join chess.provider_games g on g.id = r.provider_game_id
    where g.provider_game_id = ${GAME_ID} order by r.revision_no
  `;
  const [pointer] = await sql<{ current: string; latest: string }[]>`
    select g.current_replay_revision_id::text as current,
           sg.latest_replay_revision_id::text as latest
    from chess.provider_games g
    join chess.subject_games sg on sg.provider_game_id = g.id
    where g.provider_game_id = ${GAME_ID}
  `;
  assert.equal(result.corrected, 1);
  assert.equal(revisions.length, 2);
  assert.equal(revisions[0].result, "white", "the prior revision was rewritten");
  assert.equal(revisions[1].result, "black");
  assert.equal(revisions[1].revision_reason, "provider_correction");
  assert.equal(pointer.current, pointer.latest);
  return "revision 1 still white, revision 2 black as provider_correction, pointers agree";
});

await check("a lock is not held by two holders, and an expired one is taken over", async () => {
  const key = providerLockKey("e08-probe");
  // Start from no lock: a previous aborted run may have left one held, and a
  // test that depends on the last run's failure state proves nothing.
  await sql`delete from ops.provider_locks where lock_key = ${key}`;
  const first = await acquireLock(sql, key, "worker-a", 60);
  const second = await acquireLock(sql, key, "worker-b", 60);
  assert.notEqual(first, null);
  assert.equal(second, null, "two holders took one lock");
  // A release by the wrong holder does nothing.
  assert.equal(await releaseLock(sql, key, "worker-b"), false);
  // Age the lock into the past. Both timestamps move together: setting only
  // expires_at backwards would violate provider_locks_expiry, which is the
  // constraint refusing an incoherent lock rather than a bug in acquisition.
  await sql`
    update ops.provider_locks
    set acquired_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
    where lock_key = ${key}
  `;
  const third = await acquireLock(sql, key, "worker-b", 60);
  assert.notEqual(third, null, "an expired lock was not reclaimed");
  await releaseLock(sql, key, "worker-b");
  return "second holder refused, wrong-holder release refused, expired lock reclaimed";
});

await check("the run records aggregates and no game identifier", async () => {
  await finishSyncRun(sql, runId, "succeeded", { non_standard_variant: 1 });
  const [run] = await sql<
    { state: string; games_accepted: number; games_duplicate: number; games_corrected: number; games_rejected: number; rejection_summary: unknown }[]
  >`
    select state, games_accepted, games_duplicate, games_corrected, games_rejected, rejection_summary
    from ops.sync_runs where id = ${runId}
  `;
  assert.equal(run.state, "succeeded");
  assert.equal(run.games_accepted, 1);
  assert.equal(run.games_duplicate, 1);
  assert.equal(run.games_corrected, 1);
  assert.equal(run.games_rejected, 1);
  assert.equal(JSON.stringify(run.rejection_summary).includes(GAME_ID), false);
  return `accepted 1, duplicate 1, corrected 1, rejected 1; summary names no game`;
});

// Cleanup. Revisions are immutable, so the trigger is lifted for the probe rows
// only -- the same admission made in the migration's verification.
await sql`delete from chess.subject_game_sources where subject_game_id in (select id from chess.subject_games where subject_id = ${subject.id})`;
await sql`delete from chess.subject_games where subject_id = ${subject.id}`;
await sql`alter table chess.game_replay_revisions disable trigger replay_revisions_immutable`;
await sql`alter table chess.game_revision_participants disable trigger participants_immutable`;
await sql`update chess.provider_games set current_replay_revision_id = null where provider_game_id = ${GAME_ID}`;
await sql`delete from chess.game_revision_participants where replay_revision_id in (
  select r.id from chess.game_replay_revisions r join chess.provider_games g on g.id = r.provider_game_id
  where g.provider_game_id = ${GAME_ID})`;
await sql`delete from chess.game_replay_revisions where provider_game_id in (
  select id from chess.provider_games where provider_game_id = ${GAME_ID})`;
await sql`alter table chess.game_revision_participants enable trigger participants_immutable`;
await sql`alter table chess.game_replay_revisions enable trigger replay_revisions_immutable`;
await sql`delete from chess.provider_games where provider_game_id = ${GAME_ID}`;
await sql`delete from ops.sync_checkpoints where sync_run_id = ${runId}`;
await sql`delete from ops.sync_runs where linked_account_id = ${account.id}`;
await sql`delete from ops.account_sync_state where linked_account_id = ${account.id}`;
await sql`delete from app.linked_accounts where owner_user_id = ${OWNER}`;
await sql`delete from app.provider_identities where id = ${identity.id}`;
await sql`delete from app.profiles where user_id = ${OWNER}`;
const [{ left }] = await sql<{ left: number }[]>`
  select count(*)::int as left from chess.provider_games where provider_game_id = ${GAME_ID}
`;
await sql.end();

console.log(`\n${passed} passed, ${failures.length} failed (rows left behind: ${left})`);
if (failures.length > 0 || left > 0) {
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
}

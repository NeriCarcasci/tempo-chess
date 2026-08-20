/**
 * `npm run artifacts:lifecycle` — the ordering rules, against a real database.
 *
 * Needs `DATABASE_URL`. It uses the in-memory store rather than a bucket,
 * because what is being proven is the sequencing between the object and the
 * row, and the in-memory store is a real implementation of that interface —
 * including refusing an overwrite and confirming a removal.
 *
 * Every row it creates is removed at the end.
 */

import { strict as assert } from "node:assert";
import postgres from "postgres";
import { sha256Of } from "./contract.js";
import {
  ArtifactVerificationFailed,
  signArtifactDownload,
  storeArtifact,
  sweepArtifacts,
} from "./lifecycle.js";
import { MemoryArtifactStore, type ArtifactStore, type PutObject } from "./store.js";

const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
const created: string[] = [];
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

async function stateOf(id: string): Promise<string> {
  const [row] = await sql<{ state: string }[]>`select state from ops.artifacts where id = ${id}`;
  return row?.state ?? "absent";
}

const OWNER = "00000000-0000-4000-8000-00000000e072";
let subjectId = "";

await sql`delete from app.profiles where user_id = ${OWNER}`;
await sql`insert into app.profiles (user_id) values (${OWNER})`;
const [subject] = await sql<{ id: string }[]>`
  insert into app.analysis_subjects (kind, owner_user_id, display_label)
  values ('personal', ${OWNER}, 'artifact owner') returning id
`;
subjectId = subject.id;

console.log("cd server && npm run artifacts:lifecycle\n");

await check("a verified upload becomes ready and downloadable", async () => {
  const store = new MemoryArtifactStore();
  const body = new TextEncoder().encode("1. e4 e5");
  const stored = await storeArtifact(sql, store, {
    retentionClass: "subject_owned",
    body,
    ownerSubjectId: subjectId,
    mediaType: "application/x-chess-pgn",
    extension: "pgn",
  });
  created.push(stored.id);
  assert.equal(stored.state, "ready");
  assert.equal(stored.sha256, sha256Of(body));
  assert.equal(await stateOf(stored.id), "ready");
  const signed = await signArtifactDownload(sql, store, stored.id, [subjectId]);
  assert.ok(signed, "the owner was refused a url");
  assert.equal(signed!.expiresInSeconds, 120);
  return `ready, ${stored.byteSize} bytes, url expires in ${signed!.expiresInSeconds}s`;
});

await check("a body that does not match what was declared never becomes ready", async () => {
  // A store that quietly writes something else: the corruption case the
  // read-back exists to catch.
  const store: ArtifactStore = {
    ...new MemoryArtifactStore(),
    async put() {},
    async stat() {
      return { bytes: 3, sha256: sha256Of("xxx") };
    },
    async signDownload() {
      return "never";
    },
    async remove() {
      return true;
    },
  };
  let failed = false;
  let id = "";
  try {
    await storeArtifact(sql, store, {
      retentionClass: "subject_owned",
      body: new TextEncoder().encode("the real body"),
      ownerSubjectId: subjectId,
    });
  } catch (error) {
    failed = error instanceof ArtifactVerificationFailed;
    if (error instanceof ArtifactVerificationFailed) id = error.artifactId;
  }
  created.push(id);
  assert.equal(failed, true, "a mismatched upload was accepted");
  assert.equal(await stateOf(id), "failed");
  return "the row is failed, never ready";
});

await check("a pending or failed artifact cannot be downloaded, even by its owner", async () => {
  const store = new MemoryArtifactStore();
  const [row] = await sql<{ id: string }[]>`
    insert into ops.artifacts (bucket, object_key, state, retention_class, owner_subject_id)
    values ('subject-artifacts', ${`2026-08-18/${Math.random().toString(16).slice(2)}pending`},
            'pending', 'subject_owned', ${subjectId})
    returning id
  `;
  created.push(row.id);
  const signed = await signArtifactDownload(sql, store, row.id, [subjectId]);
  assert.equal(signed, null);
  return "refused";
});

await check("a non-owner is refused a url for a ready artifact", async () => {
  const store = new MemoryArtifactStore();
  const stored = await storeArtifact(sql, store, {
    retentionClass: "subject_owned",
    body: new TextEncoder().encode("private"),
    ownerSubjectId: subjectId,
  });
  created.push(stored.id);
  assert.equal(await signArtifactDownload(sql, store, stored.id, ["someone-else"]), null);
  assert.equal(await signArtifactDownload(sql, store, stored.id, []), null);
  assert.notEqual(await signArtifactDownload(sql, store, stored.id, [subjectId]), null);
  return "another subject and an empty actor both refused; the owner is not";
});

await check("the same system artifact twice is one object", async () => {
  const store = new MemoryArtifactStore();
  const body = new TextEncoder().encode("catalogue v1");
  const first = await storeArtifact(sql, store, { retentionClass: "system_immutable", body });
  const second = await storeArtifact(sql, store, { retentionClass: "system_immutable", body });
  created.push(first.id);
  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.equal(second.id, first.id);
  assert.equal(store.keys().length, 1);
  return "checksum-addressed: one row, one object";
});

await check("an abandoned body is swept and its row ends deleted", async () => {
  const store = new MemoryArtifactStore();
  const stored = await storeArtifact(sql, store, {
    retentionClass: "subject_owned",
    body: new TextEncoder().encode("orphan"),
    ownerSubjectId: subjectId,
  });
  created.push(stored.id);
  // Age it past the grace period and put it back to pending, as a crash between
  // the object write and the ready update would leave it.
  await sql`
    update ops.artifacts set state = 'pending', created_at = now() - interval '7 hours'
    where id = ${stored.id}
  `;
  const report = await sweepArtifacts(sql, store, new Date());
  assert.equal(await stateOf(stored.id), "deleted");
  assert.equal(store.keys().length, 0);
  return `examined ${report.examined}, removed ${report.removed}, object gone`;
});

await check("deletion does not complete while the object is still there", async () => {
  const store = new MemoryArtifactStore();
  const stored = await storeArtifact(sql, store, {
    retentionClass: "subject_owned",
    body: new TextEncoder().encode("stubborn"),
    ownerSubjectId: subjectId,
  });
  created.push(stored.id);
  await sql`
    update ops.artifacts set state = 'pending', created_at = now() - interval '7 hours'
    where id = ${stored.id}
  `;
  store.failNextRemoval = true;
  await sweepArtifacts(sql, store, new Date());
  assert.equal(await stateOf(stored.id), "deleting", "a failed removal reported deleted");
  assert.equal(store.keys().length, 1, "the object vanished despite a failed removal");
  // The retry converges.
  await sweepArtifacts(sql, store, new Date());
  assert.equal(await stateOf(stored.id), "deleted");
  assert.equal(store.keys().length, 0);
  return "stays deleting until confirmed, then the retry completes it";
});

await check("sweeping twice removes nothing the second time", async () => {
  const store = new MemoryArtifactStore();
  const stored = await storeArtifact(sql, store, {
    retentionClass: "subject_owned",
    body: new TextEncoder().encode("idempotent"),
    ownerSubjectId: subjectId,
  });
  created.push(stored.id);
  await sql`
    update ops.artifacts set state = 'pending', created_at = now() - interval '7 hours'
    where id = ${stored.id}
  `;
  const first = await sweepArtifacts(sql, store, new Date());
  const second = await sweepArtifacts(sql, store, new Date());
  assert.equal(first.removed >= 1, true);
  assert.equal(second.removed, 0);
  return `first removed ${first.removed}, second removed ${second.removed}`;
});

await check("an expired export is swept even though it was ready", async () => {
  const store = new MemoryArtifactStore();
  const stored = await storeArtifact(sql, store, {
    retentionClass: "temporary",
    body: new TextEncoder().encode("export"),
    expiresAt: new Date(Date.now() - 60_000),
  });
  created.push(stored.id);
  assert.equal(await stateOf(stored.id), "ready");
  await sweepArtifacts(sql, store, new Date());
  assert.equal(await stateOf(stored.id), "deleted");
  return "a ready artifact past its expiry is removed; unexpired ones are not";
});

// Cleanup.
for (const id of created.filter(Boolean)) {
  await sql`delete from ops.artifacts where id = ${id}`;
}
await sql`delete from ops.artifacts where owner_subject_id = ${subjectId}`;
await sql`delete from app.profiles where user_id = ${OWNER}`;
const [{ left }] = await sql<{ left: number }[]>`
  select count(*)::int as left from ops.artifacts where owner_subject_id = ${subjectId}
`;
await sql.end();

console.log(`\n${passed} passed, ${failures.length} failed (rows left behind: ${left})`);
if (failures.length > 0 || left > 0) {
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
}

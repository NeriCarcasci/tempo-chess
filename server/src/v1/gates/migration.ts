import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { GateReport } from "./harness.js";
import {
  createDisposableDatabase,
  type DisposableDatabase,
} from "../../platform/harness/postgres.js";
import { MIGRATIONS_FOLDER, applyMigrations, journal } from "../../platform/harness/migrations.js";

/**
 * Migration gate for `0013_e03_api_kernel`.
 *
 * Four questions, each answered against a real database rather than a model:
 * does it apply to an empty one, does it apply to the production-shaped state
 * `0012` leaves behind, is re-running it a no-op, and does a run interrupted
 * part way converge when it is run again.
 *
 * The last one is the one that matters operationally. A migration that only
 * works from a clean start is a migration that cannot be recovered from a
 * deploy that died halfway, and the epic's rollback contract is forward
 * recovery — never a destructive undo.
 *
 * Disposable clusters only. This gate creates databases and roles.
 */

const TAG = "0013_e03_api_kernel";
const report = new GateReport("E03 /v1 kernel migration gate");

const source = readFileSync(join(MIGRATIONS_FOLDER, `${TAG}.sql`), "utf8");
const statements = source
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter((statement) => statement.length > 0);

/** Apply the committed file directly, as the deploy role would. */
async function replay(url: string, upTo = statements.length): Promise<void> {
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await sql.begin(async (tx) => {
      for (const statement of statements.slice(0, upTo)) {
        await tx.unsafe(statement);
      }
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

interface Expectation {
  table: string;
  columns: number;
  policies: number;
}

const EXPECTED: readonly Expectation[] = [
  { table: "idempotency_records", columns: 18, policies: 1 },
  { table: "audit_events", columns: 12, policies: 2 },
  { table: "rate_limit_counters", columns: 5, policies: 1 },
];

async function assertKernelSchema(db: DisposableDatabase, label: string): Promise<void> {
  for (const expectation of EXPECTED) {
    const columns = await db.query<{ n: number }>(
      `select count(*)::int as n from information_schema.columns
       where table_schema = 'ops' and table_name = $1`,
      [expectation.table],
    );
    assert.equal(columns[0].n, expectation.columns, `${label}: ops.${expectation.table} columns`);

    const policies = await db.query<{ n: number }>(
      `select count(*)::int as n from pg_policies where schemaname = 'ops' and tablename = $1`,
      [expectation.table],
    );
    assert.equal(policies[0].n, expectation.policies, `${label}: ops.${expectation.table} policies`);

    const security = await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `select relrowsecurity, relforcerowsecurity from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'ops' and c.relname = $1`,
      [expectation.table],
    );
    assert.equal(security[0].relrowsecurity, true, `${label}: ${expectation.table} RLS`);
    assert.equal(security[0].relforcerowsecurity, true, `${label}: ${expectation.table} forced RLS`);

    const owner = await db.query<{ owner: string }>(
      `select pg_get_userbyid(relowner) as owner from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'ops' and c.relname = $1`,
      [expectation.table],
    );
    assert.equal(owner[0].owner, "forma_migrator", `${label}: ${expectation.table} owner`);
  }
}

const created: DisposableDatabase[] = [];
async function disposable(): Promise<DisposableDatabase> {
  const db = await createDisposableDatabase();
  created.push(db);
  return db;
}

try {
  report.section("the journal addition");

  await report.check("0013 sits exactly once in the journal, directly after 0012", () => {
    const entries = journal().entries;
    const position = entries.findIndex((entry) => entry.tag === TAG);
    assert.notEqual(position, -1, "0013 is not in the journal");
    // `idx` is zero-based and matches the file's numeric prefix.
    assert.equal(entries[position]!.idx, position);
    assert.equal(entries.filter((entry) => entry.tag === TAG).length, 1);
    // Append-only: 0012 must still be where it was. Stated as a position rather
    // than "the last entry", so a later epic appending its own migration does
    // not make this gate fail for a reason that has nothing to do with 0013.
    assert.equal(entries[position - 1]!.tag, "0012_e02_platform_foundation");
  });

  await report.check("the migration drops and renames nothing", () => {
    const forbidden = /\b(drop\s+(table|column|schema|role|database)|alter\s+table\s+\S+\s+rename|truncate)\b/i;
    assert.equal(forbidden.test(source), false, "the migration contains a destructive statement");
    // `drop policy if exists` before `create policy` is the repeatability idiom,
    // not a destructive change: it removes only what this file also recreates.
    const policyDrops = source.match(/drop policy if exists (\S+)/g) ?? [];
    for (const drop of policyDrops) {
      const name = drop.split(" ").at(-1)!;
      assert.ok(source.includes(`create policy ${name}`), `${name} is dropped but not recreated`);
    }
  });

  report.section("from an empty database");

  const empty = await disposable();
  await report.check("every migration applies to a fresh cluster", async () => {
    await applyMigrations(empty.adminUrl);
    const rows = await empty.query<{ n: number }>(
      `select count(*)::int as n from drizzle.__drizzle_migrations`,
    );
    assert.equal(rows[0].n, journal().entries.length);
  });

  await report.check("the kernel tables exist with their constraints and policies", async () => {
    await assertKernelSchema(empty, "empty");
  });

  await report.check("the record constraints reject an impossible state", async () => {
    // A completed record must carry a status; a processing one must not. The
    // check is what stops a half-written record from being replayed as success.
    await assert.rejects(
      () =>
        empty.query(
          `insert into ops.idempotency_records
             (actor_key, route_key, idempotency_key, request_method, request_digest,
              state, expires_at, completed_at)
           values ('anon', 'POST /v1/x', 'k1', 'POST', repeat('a', 64), 'completed',
                   now() + interval '1 day', now())`,
        ),
      /idempotency_records_completed_status_check/,
    );
    await assert.rejects(
      () =>
        empty.query(
          `insert into ops.idempotency_records
             (actor_key, route_key, idempotency_key, request_method, request_digest,
              state, expires_at)
           values ('anon', 'POST /v1/x', 'k2', 'POST', 'not-a-digest', 'processing',
                   now() + interval '1 day')`,
        ),
      /idempotency_records_digest_check/,
    );
    await assert.rejects(
      () =>
        empty.query(
          `insert into ops.audit_events (actor_kind, action, result)
           values ('robot', 'auth.token_rejected', 'denied')`,
        ),
      /audit_events_actor_kind_check/,
    );
  });

  await report.check("the uniqueness scope is actor, route and key together", async () => {
    const insert = (actor: string, route: string, key: string) =>
      empty.query(
        `insert into ops.idempotency_records
           (actor_key, route_key, idempotency_key, request_method, request_digest,
            state, lease_expires_at, expires_at)
         values ($1, $2, $3, 'POST', repeat('b', 64), 'processing',
                 now() + interval '1 minute', now() + interval '1 day')`,
        [actor, route, key],
      );
    await insert("anon", "POST /v1/a", "same-key");
    // Same key, different route and different actor: both are separate commands.
    await insert("anon", "POST /v1/b", "same-key");
    await insert("00000000-0000-4000-8000-000000000001", "POST /v1/a", "same-key");
    await assert.rejects(() => insert("anon", "POST /v1/a", "same-key"), /duplicate key value/);
    await empty.query(`delete from ops.idempotency_records where idempotency_key = 'same-key'`);
  });

  report.section("from the production-shaped prior state");

  const prior = await disposable();
  await report.check("0012 leaves a database without the kernel tables", async () => {
    await applyMigrations(prior.adminUrl, "0012_e02_platform_foundation");
    const rows = await prior.query<{ n: number }>(
      `select count(*)::int as n from information_schema.tables
       where table_schema = 'ops' and table_name = any(array[
         'idempotency_records','audit_events','rate_limit_counters'])`,
    );
    assert.equal(rows[0].n, 0);
  });

  await report.check("0013 applies on top of it and changes nothing else", async () => {
    const before = await prior.query<{ n: number }>(
      `select count(*)::int as n from information_schema.tables where table_schema = 'public'`,
    );
    // Stops at 0013. It used to apply everything, which meant the assertion
    // below quietly grew into "no migration ever touches the legacy schema" --
    // true by accident until 0042 deliberately dropped three tables from it.
    // The claim this check is named for is about 0013 alone, so it applies 0013
    // alone; later migrations are their own epics' to prove.
    await applyMigrations(prior.adminUrl, "0013_e03_api_kernel");
    await assertKernelSchema(prior, "prior state");
    const after = await prior.query<{ n: number }>(
      `select count(*)::int as n from information_schema.tables where table_schema = 'public'`,
    );
    assert.equal(after[0].n, before[0].n, "0013 altered the legacy schema");
  });

  await report.check("the E02 catalogue and helpers are untouched", async () => {
    const rows = await prior.query<{ n: number }>(
      `select count(*)::int as n from ops.schema_catalogue`,
    );
    assert.equal(rows[0].n, 8);
    const helper = await prior.query<{ actor: string | null }>(
      `select private.current_actor_id() as actor`,
    );
    assert.equal(helper[0].actor, null);
  });

  report.section("repeated execution");

  await report.check("replaying the committed file is a no-op", async () => {
    await replay(prior.adminUrl);
    await replay(prior.adminUrl);
    await assertKernelSchema(prior, "replayed");
  });

  await report.check("a replay does not multiply policies or grants", async () => {
    const policies = await prior.query<{ n: number }>(
      `select count(*)::int as n from pg_policies where schemaname = 'ops'
       and tablename = any(array['idempotency_records','audit_events','rate_limit_counters'])`,
    );
    assert.equal(policies[0].n, 4);
    const grants = await prior.query<{ n: number }>(
      `select count(*)::int as n from information_schema.role_table_grants
       where table_schema = 'ops' and grantee in ('anon','authenticated','service_role','PUBLIC')`,
    );
    assert.equal(grants[0].n, 0);
  });

  await report.check("replaying does not discard rows written since the first run", async () => {
    await prior.query(
      `insert into ops.audit_events (actor_kind, action, result, request_id)
       values ('system', 'auth.token_rejected', 'denied', 'req_migration_gate')`,
    );
    await replay(prior.adminUrl);
    const rows = await prior.query<{ n: number }>(
      `select count(*)::int as n from ops.audit_events where request_id = 'req_migration_gate'`,
    );
    // Rollback is forward recovery: the epic forbids a path that deletes
    // idempotency or audit evidence, and a re-run is the closest thing to one.
    assert.equal(rows[0].n, 1);
    await prior.query(`delete from ops.audit_events where request_id = 'req_migration_gate'`);
  });

  report.section("partial failure and forward recovery");

  const partial = await disposable();
  await report.check("an interrupted run leaves nothing behind", async () => {
    await applyMigrations(partial.adminUrl, "0012_e02_platform_foundation");
    // Every statement is inside one transaction, so an interruption is a
    // rollback: this is the property that makes forward recovery just "run it
    // again" rather than "work out how far it got".
    const sql = postgres(partial.adminUrl, { max: 1, prepare: false, onnotice: () => {} });
    try {
      await assert.rejects(() =>
        sql.begin(async (tx) => {
          for (const statement of statements.slice(0, 6)) await tx.unsafe(statement);
          throw new Error("gate: simulated deploy interruption");
        }),
      );
    } finally {
      await sql.end({ timeout: 5 });
    }
    const rows = await partial.query<{ n: number }>(
      `select count(*)::int as n from information_schema.tables
       where table_schema = 'ops' and table_name = 'idempotency_records'`,
    );
    assert.equal(rows[0].n, 0, "an aborted run left a partial table");
  });

  await report.check("re-running after the interruption converges", async () => {
    await applyMigrations(partial.adminUrl);
    await assertKernelSchema(partial, "after recovery");
    const ledger = await partial.query<{ n: number }>(
      `select count(*)::int as n from drizzle.__drizzle_migrations`,
    );
    assert.equal(ledger[0].n, journal().entries.length);
  });

  await report.check("recovery from a half-applied state converges too", async () => {
    // Not every interruption is transactional in the field: a connection can
    // drop after a commit that the runner never recorded. Replaying the file
    // over a partly-built schema must still converge rather than error.
    const half = await disposable();
    await applyMigrations(half.adminUrl, "0012_e02_platform_foundation");
    await replay(half.adminUrl, 8);
    await replay(half.adminUrl);
    await assertKernelSchema(half, "half applied");
  });
} finally {
  for (const db of created) await db.destroy().catch(() => {});
}

report.finish();

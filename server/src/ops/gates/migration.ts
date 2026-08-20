import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { GateReport } from "../../v1/gates/harness.js";
import {
  createDisposableDatabase,
  type DisposableDatabase,
} from "../../platform/harness/postgres.js";
import { MIGRATIONS_FOLDER, applyMigrations, journal } from "../../platform/harness/migrations.js";

/**
 * Migration gate for `0014_e04_work_ledger`.
 *
 * The same four questions `0013`'s gate asks, against a real database rather
 * than a model: does it apply to an empty one, does it apply to the
 * production-shaped state `0013` leaves behind, is re-running it a no-op, and
 * does a run interrupted part way converge when it is run again.
 *
 * Plus one this epic adds. The ledger is the record that committed work
 * existed, so the gate proves that a re-run keeps rows written since the first
 * run, and that no role holds `delete` on any of it — rollback here is forward
 * recovery, never a path that removes evidence.
 *
 * Disposable clusters only. This gate creates databases and roles.
 */

const TAG = "0014_e04_work_ledger";
const report = new GateReport("E04 work ledger migration gate");

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
      for (const statement of statements.slice(0, upTo)) await tx.unsafe(statement);
    });
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const LEDGER_TABLES = [
  "workflows",
  "work_items",
  "work_item_dependencies",
  "work_attempts",
  "outbox_events",
] as const;

const EXPECTED_COLUMNS: Readonly<Record<(typeof LEDGER_TABLES)[number], number>> = {
  workflows: 14,
  work_items: 29,
  work_item_dependencies: 3,
  work_attempts: 18,
  outbox_events: 12,
};

async function assertLedgerSchema(db: DisposableDatabase, label: string): Promise<void> {
  for (const table of LEDGER_TABLES) {
    const columns = await db.query<{ n: number }>(
      `select count(*)::int as n from information_schema.columns
       where table_schema = 'ops' and table_name = $1`,
      [table],
    );
    assert.equal(columns[0].n, EXPECTED_COLUMNS[table], `${label}: ops.${table} columns`);

    const policies = await db.query<{ n: number }>(
      `select count(*)::int as n from pg_policies where schemaname = 'ops' and tablename = $1`,
      [table],
    );
    assert.equal(policies[0].n, 1, `${label}: ops.${table} policies`);

    const security = await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `select relrowsecurity, relforcerowsecurity from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'ops' and c.relname = $1`,
      [table],
    );
    assert.equal(security[0].relrowsecurity, true, `${label}: ${table} RLS`);
    assert.equal(security[0].relforcerowsecurity, true, `${label}: ${table} forced RLS`);

    const owner = await db.query<{ owner: string }>(
      `select pg_get_userbyid(relowner) as owner from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'ops' and c.relname = $1`,
      [table],
    );
    assert.equal(owner[0].owner, "forma_migrator", `${label}: ${table} owner`);
  }

  const triggers = await db.query<{ n: number }>(
    `select count(*)::int as n from pg_trigger t
     join pg_class c on c.oid = t.tgrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'ops' and not t.tgisinternal`,
  );
  assert.equal(triggers[0].n, 3, `${label}: the three ledger guards`);
}

const created: DisposableDatabase[] = [];
async function disposable(): Promise<DisposableDatabase> {
  const db = await createDisposableDatabase();
  created.push(db);
  return db;
}

try {
  report.section("the journal addition");

  await report.check("0014 sits exactly once in the journal, directly after 0013", () => {
    const entries = journal().entries;
    const position = entries.findIndex((entry) => entry.tag === TAG);
    assert.notEqual(position, -1, "0014 is not in the journal");
    assert.equal(entries[position]!.idx, position);
    assert.equal(entries.filter((entry) => entry.tag === TAG).length, 1);
    // A position, not "the last entry": the next epic appends its own migration
    // and must not have to edit this gate to do it.
    assert.equal(entries[position - 1]!.tag, "0013_e03_api_kernel");
  });

  await report.check("the migration drops and renames nothing", () => {
    const forbidden = /\b(drop\s+(table|column|schema|role|database)|alter\s+table\s+\S+\s+rename|truncate|delete\s+from)\b/i;
    assert.equal(forbidden.test(source), false, "the migration contains a destructive statement");
    const dropped = source.match(/drop (policy|trigger) if exists (\S+)/g) ?? [];
    for (const drop of dropped) {
      const parts = drop.split(" ");
      const kind = parts[1]!;
      const name = parts[4]!;
      assert.ok(source.includes(`create ${kind} ${name}`), `${name} is dropped but not recreated`);
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

  await report.check("the ledger tables exist with their policies and guards", async () => {
    await assertLedgerSchema(empty, "empty");
  });

  await report.check("Q10's claim index exists and matches the claim predicate", async () => {
    const rows = await empty.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where schemaname = 'ops' and indexname = 'work_items_claim_idx'`,
    );
    assert.equal(rows.length, 1);
    // A partial index only helps if the predicate is the one the claim uses.
    assert.ok(rows[0].indexdef.includes("WHERE (status = 'ready'::text)"), rows[0].indexdef);
    assert.ok(rows[0].indexdef.includes("resource_class"));
    assert.ok(rows[0].indexdef.includes("priority DESC"));

    const recovery = await empty.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where schemaname = 'ops' and indexname = 'work_items_lease_recovery_idx'`,
    );
    assert.ok(recovery[0].indexdef.includes("WHERE (status = 'leased'::text)"));

    const pull = await empty.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where schemaname = 'ops' and indexname = 'work_items_in_process_claim_idx'`,
    );
    assert.equal(pull.length, 1);
    assert.ok(pull[0].indexdef.includes("in_process"), pull[0].indexdef);
  });

  await report.check("the state vocabularies are enforced by the database", async () => {
    await empty.query(`insert into ops.workflows (id, kind) values
      ('11111111-1111-4111-8111-111111111111', 'maintenance')`);
    await assert.rejects(
      () => empty.query(`insert into ops.workflows (kind) values ('not_a_kind')`),
      /workflows_kind_check/,
    );
    await assert.rejects(
      () =>
        empty.query(`insert into ops.workflows (kind, state) values ('maintenance', 'half_done')`),
      /workflows_state_check/,
    );
    await assert.rejects(
      () =>
        empty.query(
          `insert into ops.work_items (workflow_id, task_type, resource_class, idempotency_key, queue)
           values ('11111111-1111-4111-8111-111111111111', 'x', 'ingestion', 'k1', 'analysis')`,
        ),
      /work_items_task_type_check/,
    );
    await assert.rejects(
      () =>
        empty.query(
          `insert into ops.work_items (workflow_id, task_type, resource_class, idempotency_key, queue)
           values ('11111111-1111-4111-8111-111111111111', 'gate_task', 'gpu_farm', 'k2', 'analysis')`,
        ),
      /work_items_resource_class_check/,
    );
  });

  await report.check("a queue-dispatched item cannot exist without a queue", async () => {
    await assert.rejects(
      () =>
        empty.query(
          `insert into ops.work_items (workflow_id, task_type, resource_class, idempotency_key)
           values ('11111111-1111-4111-8111-111111111111', 'gate_task', 'ingestion', 'k3')`,
        ),
      /work_items_queue_mode_check/,
    );
    await assert.rejects(
      () =>
        empty.query(
          `insert into ops.work_items (workflow_id, task_type, resource_class, idempotency_key,
             dispatch_mode, queue)
           values ('11111111-1111-4111-8111-111111111111', 'gate_task', 'ingestion', 'k4',
             'in_process', 'analysis')`,
        ),
      /work_items_queue_mode_check/,
    );
  });

  await report.check("a lease exists exactly while an item is leased", async () => {
    await assert.rejects(
      () =>
        empty.query(
          `insert into ops.work_items (workflow_id, task_type, resource_class, idempotency_key,
             dispatch_mode, status, lease_owner)
           values ('11111111-1111-4111-8111-111111111111', 'gate_task', 'ingestion', 'k5',
             'in_process', 'ready', 'someone')`,
        ),
      /work_items_lease_owner_check/,
    );
  });

  await report.check("a payload may not become the work itself", async () => {
    await assert.rejects(
      () =>
        empty.query(
          `insert into ops.work_items (workflow_id, task_type, resource_class, idempotency_key,
             dispatch_mode, payload)
           values ('11111111-1111-4111-8111-111111111111', 'gate_task', 'ingestion', 'k6',
             'in_process', jsonb_build_object('pgn', repeat('1. e4 e5 ', 800)))`,
        ),
      /work_items_payload_size_check/,
    );
    await assert.rejects(
      () =>
        empty.query(
          `insert into ops.work_items (workflow_id, task_type, resource_class, idempotency_key,
             dispatch_mode, payload)
           values ('11111111-1111-4111-8111-111111111111', 'gate_task', 'ingestion', 'k7',
             'in_process', '"a string"'::jsonb)`,
        ),
      /work_items_payload_object_check/,
    );
  });

  await report.check("a dependency cycle is unrepresentable", async () => {
    await empty.query(
      `insert into ops.work_items (id, workflow_id, task_type, resource_class, idempotency_key, dispatch_mode)
       overriding system value
       values (900001, '11111111-1111-4111-8111-111111111111', 'gate_task', 'ingestion', 'dep-a', 'in_process'),
              (900002, '11111111-1111-4111-8111-111111111111', 'gate_task', 'ingestion', 'dep-b', 'in_process')`,
    );
    await empty.query(
      `insert into ops.work_item_dependencies (work_item_id, depends_on_work_item_id)
       values (900002, 900001)`,
    );
    await assert.rejects(
      () =>
        empty.query(
          `insert into ops.work_item_dependencies (work_item_id, depends_on_work_item_id)
           values (900001, 900002)`,
        ),
      /work_item_dependencies_acyclic_check/,
    );
    await assert.rejects(
      () =>
        empty.query(
          `insert into ops.work_item_dependencies (work_item_id, depends_on_work_item_id)
           values (900001, 900001)`,
        ),
      /work_item_dependencies_acyclic_check/,
    );
  });

  await report.check("the E03 idempotency record now points at a real workflow", async () => {
    const rows = await empty.query<{ n: number }>(
      `select count(*)::int as n from pg_constraint
       where conname = 'idempotency_records_workflow_id_fkey'
         and conrelid = 'ops.idempotency_records'::regclass`,
    );
    assert.equal(rows[0].n, 1);
    await assert.rejects(
      () =>
        empty.query(
          `insert into ops.idempotency_records
             (actor_key, route_key, idempotency_key, request_method, request_digest, state,
              lease_expires_at, expires_at, workflow_id)
           values ('anon', 'POST /v1/x', 'fk', 'POST', repeat('a', 64), 'processing',
                   now() + interval '1 minute', now() + interval '1 day',
                   '22222222-2222-4222-8222-222222222222')`,
        ),
      /idempotency_records_workflow_id_fkey/,
    );
  });

  report.section("from the production-shaped prior state");

  const prior = await disposable();
  await report.check("0013 leaves a database without the ledger", async () => {
    await applyMigrations(prior.adminUrl, "0013_e03_api_kernel");
    const rows = await prior.query<{ n: number }>(
      `select count(*)::int as n from information_schema.tables
       where table_schema = 'ops' and table_name = any($1::text[])`,
      [[...LEDGER_TABLES]],
    );
    assert.equal(rows[0].n, 0);
  });

  await report.check("0014 applies on top of it and changes nothing else", async () => {
    const before = await prior.query<{ n: number }>(
      `select count(*)::int as n from information_schema.tables where table_schema = 'public'`,
    );
    // Rows the earlier epics wrote, which the ledger must not disturb.
    await prior.query(
      `insert into ops.audit_events (actor_kind, action, result, request_id)
       values ('system', 'auth.token_rejected', 'denied', 'req_prior_state')`,
    );
    await applyMigrations(prior.adminUrl);
    await assertLedgerSchema(prior, "prior state");
    const after = await prior.query<{ n: number }>(
      `select count(*)::int as n from information_schema.tables where table_schema = 'public'`,
    );
    assert.equal(after[0].n, before[0].n, "0014 altered the legacy schema");
    const audit = await prior.query<{ n: number }>(
      `select count(*)::int as n from ops.audit_events where request_id = 'req_prior_state'`,
    );
    assert.equal(audit[0].n, 1, "0014 disturbed rows written before it");
  });

  report.section("repeated execution");

  await report.check("replaying the committed file is a no-op", async () => {
    await replay(prior.adminUrl);
    await replay(prior.adminUrl);
    await assertLedgerSchema(prior, "replayed");
  });

  await report.check("a replay does not multiply policies or leak a browser grant", async () => {
    const policies = await prior.query<{ n: number }>(
      `select count(*)::int as n from pg_policies where schemaname = 'ops'
       and tablename = any($1::text[])`,
      [[...LEDGER_TABLES]],
    );
    assert.equal(policies[0].n, LEDGER_TABLES.length);
    const grants = await prior.query<{ n: number }>(
      `select count(*)::int as n from information_schema.role_table_grants
       where table_schema = 'ops' and grantee in ('anon','authenticated','service_role','PUBLIC')`,
    );
    assert.equal(grants[0].n, 0);
  });

  await report.check("no runtime role may delete committed work, on any run", async () => {
    // `forma_migrator` owns the tables and therefore holds every privilege on
    // them; it has no runtime credential and never serves a request. What must
    // be empty is the set of *serving* roles that could remove the record that
    // work was committed.
    const rows = await prior.query<{ grantee: string; table_name: string }>(
      `select grantee, table_name from information_schema.role_table_grants
       where table_schema = 'ops' and privilege_type = 'DELETE'
         and table_name = any($1::text[]) and grantee <> 'forma_migrator'`,
      [[...LEDGER_TABLES]],
    );
    assert.deepEqual([...rows], []);
  });

  await report.check("replaying does not discard work recorded since the first run", async () => {
    await prior.query(
      `insert into ops.workflows (id, kind, owner_profile_id)
       values ('33333333-3333-4333-8333-333333333333', 'game_import', null)`,
    );
    await prior.query(
      `insert into ops.work_items (workflow_id, task_type, resource_class, idempotency_key, dispatch_mode)
       values ('33333333-3333-4333-8333-333333333333', 'gate_task', 'ingestion', 'survives-replay', 'in_process')`,
    );
    await replay(prior.adminUrl);
    const rows = await prior.query<{ n: number }>(
      `select count(*)::int as n from ops.work_items where idempotency_key = 'survives-replay'`,
    );
    // Rollback is forward recovery. A re-run is the closest thing to one, and it
    // must not be a way to lose the record that work was committed.
    assert.equal(rows[0].n, 1);
  });

  report.section("partial failure and forward recovery");

  const partial = await disposable();
  await report.check("an interrupted run leaves nothing behind", async () => {
    await applyMigrations(partial.adminUrl, "0013_e03_api_kernel");
    // Every statement is inside one transaction, so an interruption is a
    // rollback: this is what makes forward recovery "run it again" rather than
    // "work out how far it got".
    const sql = postgres(partial.adminUrl, { max: 1, prepare: false, onnotice: () => {} });
    try {
      await assert.rejects(() =>
        sql.begin(async (tx) => {
          for (const statement of statements.slice(0, 8)) await tx.unsafe(statement);
          throw new Error("gate: simulated deploy interruption");
        }),
      );
    } finally {
      await sql.end({ timeout: 5 });
    }
    const rows = await partial.query<{ n: number }>(
      `select count(*)::int as n from information_schema.tables
       where table_schema = 'ops' and table_name = 'workflows'`,
    );
    assert.equal(rows[0].n, 0, "an aborted run left a partial table");
  });

  await report.check("re-running after the interruption converges", async () => {
    await applyMigrations(partial.adminUrl);
    await assertLedgerSchema(partial, "after recovery");
    const ledger = await partial.query<{ n: number }>(
      `select count(*)::int as n from drizzle.__drizzle_migrations`,
    );
    assert.equal(ledger[0].n, journal().entries.length);
  });

  report.section("the dispatch-routing rollback");

  await report.check("routing an item back in process keeps its row and its history", async () => {
    await partial.query(
      `insert into ops.workflows (id, kind) values ('44444444-4444-4444-8444-444444444444', 'maintenance')`,
    );
    await partial.query(
      `insert into ops.work_items (id, workflow_id, task_type, resource_class, idempotency_key,
         dispatch_mode, queue, attempt_count)
       overriding system value
       values (910001, '44444444-4444-4444-8444-444444444444', 'gate_task', 'ingestion',
         'rollback-item', 'queue', 'analysis', 2)`,
    );
    await partial.query(
      `insert into ops.work_attempts (work_item_id, attempt_number, deployment, outcome, finished_at)
       values (910001, 1, 'gate', 'failed', now()), (910001, 2, 'gate', 'failed', now())`,
    );
    // The rollback: change the transport, keep everything else.
    await partial.query(
      `update ops.work_items set dispatch_mode = 'in_process', queue = null where id = 910001`,
    );
    const item = await partial.query<{ attempt_count: number; dispatch_mode: string }>(
      `select attempt_count, dispatch_mode from ops.work_items where id = 910001`,
    );
    assert.equal(item[0].dispatch_mode, "in_process");
    assert.equal(item[0].attempt_count, 2);
    const attempts = await partial.query<{ n: number }>(
      `select count(*)::int as n from ops.work_attempts where work_item_id = 910001`,
    );
    assert.equal(attempts[0].n, 2, "rolling back dispatch discarded attempt history");
  });
} finally {
  for (const db of created) await db.destroy();
}

report.finish();

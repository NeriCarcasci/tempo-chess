/**
 * `npm run platform:database` — the E02 database gate.
 *
 * Eight groups, every one of them a statement that actually ran against a real
 * PostgreSQL: empty database, production-shaped legacy prior state, browser
 * denial, role isolation, actor context and spoofing, repeated execution,
 * forward recovery from conflicting hand-applied DDL, and deployment under the
 * documented non-superuser deploy posture rather than as the bootstrap
 * superuser that can do anything and therefore proves nothing.
 *
 * Denials are proven by connecting as the role and being refused, not by
 * reading a catalogue row and believing it. Where a full matrix is cheaper to
 * read than to connect 48 times, `has_schema_privilege` is used — but every
 * class of denial has at least one real connection behind it.
 */

import postgres from "postgres";
import {
  ACTOR_SETTING,
  DENIED_ROLES,
  MIGRATION_TAG,
  MIGRATOR_ROLE,
  ROLE_NAMES,
  RUNTIME_ROLES,
  SCHEMAS,
  SCHEMA_NAMES,
} from "../contract.js";
import {
  HARNESS_PASSWORD,
  createDisposableDatabase,
  grantRolePasswords,
  type DisposableDatabase,
} from "../harness/postgres.js";
import { applyMigrations, journal } from "../harness/migrations.js";

/**
 * How many migrations the committed journal holds.
 *
 * Derived rather than written down: this gate is about E02's objects, and a
 * later epic adding a migration must not make it fail. What it does assert is
 * that every committed migration applied.
 */
const JOURNAL_LENGTH = journal().entries.length;

/** The journal timestamp of the migration this gate is about. */
const MIGRATION_WHEN = (() => {
  const entry = journal().entries.find((candidate) => candidate.tag === MIGRATION_TAG);
  if (!entry) throw new Error(`the journal has no entry tagged ${MIGRATION_TAG}`);
  return entry.when;
})();

/**
 * The documented recovery, expressed against a growing journal.
 *
 * Drizzle replays every migration recorded *after* the newest ledger row, so
 * clearing this migration's row means clearing everything at or after it —
 * otherwise the next run replays only whatever happens to be last, which is a
 * different migration entirely once a later epic lands one.
 */
const CLEAR_LEDGER_FROM_MIGRATION =
  `delete from drizzle.__drizzle_migrations where created_at >= ${MIGRATION_WHEN}`;

const COMMAND = "cd server && npm run platform:database";

let passed = 0;
const failures: string[] = [];

async function check(name: string, body: () => Promise<string>): Promise<void> {
  try {
    const detail = await body();
    passed += 1;
    console.log(`ok   ${name} — ${detail}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${name}: ${message}`);
    console.log(`FAIL ${name} — ${message}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/** The first row of a `postgres.js` result, typed. */
function first<T>(rows: readonly unknown[], label: string): T {
  if (rows.length === 0) throw new Error(`${label} returned no rows`);
  return rows[0] as T;
}

/** Run `body` as `role` on `db` and return the SQLSTATE it was refused with. */
async function refusal(db: DisposableDatabase, role: string, statement: string): Promise<string> {
  const client = postgres(db.urlFor(role), { max: 1, prepare: false, onnotice: () => {} });
  try {
    await client.unsafe(statement);
  } catch (error) {
    return (error as { code?: string }).code ?? "unknown";
  } finally {
    await client.end({ timeout: 5 });
  }
  throw new Error(`${role} was allowed to run: ${statement}`);
}

const ACTOR_A = "11111111-1111-4111-8111-111111111111";
const ACTOR_B = "22222222-2222-4222-8222-222222222222";

/** A legacy database is production-shaped only if it also holds legacy rows. */
async function seedLegacyRows(db: DisposableDatabase): Promise<void> {
  await db.query(`insert into public.beta_signups (name, email, platform, username, goal) values
    ('Legacy One', 'one@example.invalid', 'lichess', 'legacy_one', 'improve endgames'),
    ('Legacy Two', 'two@example.invalid', 'chesscom', 'legacy_two', 'stop blundering'),
    ('Legacy Three', 'three@example.invalid', 'lichess', null, null)`);
  await db.query(`insert into public.profiles (id, email, display_name) values
    ('33333333-3333-4333-8333-333333333333', 'p1@example.invalid', 'Legacy Profile One'),
    ('44444444-4444-4444-8444-444444444444', null, null)`);
}

/** A stable fingerprint of every legacy relation and its row count. */
async function legacyFingerprint(db: DisposableDatabase): Promise<string> {
  const rows = await db.query<{ fingerprint: string }>(`
    with columns as (
      select table_name, string_agg(column_name || ':' || data_type, ',' order by ordinal_position) as shape
      from information_schema.columns
      where table_schema = 'public'
      group by table_name
    ),
    counts as (
      select c.relname as table_name,
             (select count(*) from pg_catalog.pg_class where false) as ignored
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
    )
    select string_agg(columns.table_name || '(' || columns.shape || ')', '|' order by columns.table_name) as fingerprint
    from columns join counts on counts.table_name = columns.table_name`);
  const rowCounts = await db.query<{ signups: string; profiles: string }>(
    `select (select count(*) from public.beta_signups)::text as signups,
            (select count(*) from public.profiles)::text as profiles`,
  );
  return `${rows[0]?.fingerprint ?? ""}#signups=${rowCounts[0]?.signups}#profiles=${rowCounts[0]?.profiles}`;
}

/** Install a tenant-shaped fixture the way a feature migration is expected to. */
async function installTenancyFixture(db: DisposableDatabase): Promise<void> {
  await db.query(`create table app.tenancy_probe (
    id uuid primary key default gen_random_uuid(),
    owner_user_id uuid not null,
    note text not null
  )`);
  await db.query(`alter table app.tenancy_probe owner to ${MIGRATOR_ROLE}`);
  await db.query(`alter table app.tenancy_probe enable row level security`);
  await db.query(`alter table app.tenancy_probe force row level security`);
  await db.query(`create policy tenancy_probe_actor on app.tenancy_probe
    as permissive for all to forma_api
    using (owner_user_id = private.current_actor_id())
    with check (owner_user_id = private.current_actor_id())`);
  await db.query(`grant select, insert, update, delete on app.tenancy_probe to forma_api`);
  await db.query(`insert into app.tenancy_probe (owner_user_id, note) values
    ('${ACTOR_A}', 'belongs to A'), ('${ACTOR_B}', 'belongs to B')`);
}

/**
 * Foreign keys in the target schemas whose columns are not the leftmost prefix
 * of some index. The plans require an index on every FK path used for joins,
 * deletes, or RLS; this is the check, not a drift engine.
 */
async function unindexedForeignKeys(
  db: DisposableDatabase,
): Promise<{ table_name: string; constraint_name: string }[]> {
  return db.query<{ table_name: string; constraint_name: string }>(
    `with fk as (
       -- conkey is already in the constraint's column order, and that order is
       -- the one an index has to lead with. Sorting either side here would
       -- accept an index whose columns are the same set in the wrong order.
       select c.oid, c.conrelid, c.conname, c.conkey as cols,
              array_length(c.conkey, 1) as width
       from pg_constraint c
       join pg_class t on t.oid = c.conrelid
       join pg_namespace n on n.oid = t.relnamespace
       where c.contype = 'f' and n.nspname = any($1)
     ),
     covered as (
       select distinct fk.oid
       from fk
       join pg_index i on i.indrelid = fk.conrelid
       where (
         select array_agg(key order by ord)
         from unnest(string_to_array(i.indkey::text, ' ')::smallint[]) with ordinality as k(key, ord)
         where ord <= fk.width
       ) = fk.cols
     )
     select (fk.conrelid::regclass)::text as table_name, fk.conname as constraint_name
     from fk
     where fk.oid not in (select oid from covered)
     order by 1, 2`,
    [SCHEMA_NAMES as string[]],
  );
}

async function main(): Promise<void> {
  console.log(`${COMMAND}\n`);

  // ---------------------------------------------------------------- empty
  const fresh = await createDisposableDatabase();
  try {
    await check("empty database migrates", async () => {
      await applyMigrations(fresh.adminUrl);
      const applied = await fresh.query<{ hash: string }>(
        `select hash from drizzle.__drizzle_migrations order by created_at`,
      );
      assert(
        applied.length === JOURNAL_LENGTH,
        `expected ${JOURNAL_LENGTH} applied migrations, saw ${applied.length}`,
      );
      return `every committed migration applied to an empty database, ${JOURNAL_LENGTH} journal entries recorded`;
    });
    await grantRolePasswords(fresh, ROLE_NAMES);

    await check("eight namespaces exist, every one commented", async () => {
      const rows = await fresh.query<{ nspname: string; owner: string; description: string | null }>(
        `select n.nspname, pg_get_userbyid(n.nspowner) as owner, obj_description(n.oid, 'pg_namespace') as description
         from pg_namespace n where n.nspname = any($1)`,
        [SCHEMA_NAMES as string[]],
      );
      assert(rows.length === 8, `expected 8 schemas, saw ${rows.length}`);
      for (const row of rows) {
        assert(row.owner === MIGRATOR_ROLE, `${row.nspname} is owned by ${row.owner}`);
        assert((row.description ?? "").length > 40, `${row.nspname} has no useful comment`);
      }
      return `${rows.map((r) => r.nspname).sort().join(", ")} owned by ${MIGRATOR_ROLE}`;
    });

    await check("six roles exist with the contract attributes", async () => {
      const rows = await fresh.query<{
        rolname: string;
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolcreaterole: boolean;
        rolcreatedb: boolean;
        description: string | null;
      }>(
        `select r.rolname, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb,
                shobj_description(r.oid, 'pg_authid') as description
         from pg_roles r where r.rolname = any($1)`,
        [ROLE_NAMES as string[]],
      );
      assert(rows.length === 6, `expected 6 roles, saw ${rows.length}`);
      for (const row of rows) {
        assert(!row.rolsuper, `${row.rolname} is a superuser`);
        assert(!row.rolbypassrls, `${row.rolname} holds BYPASSRLS`);
        assert(!row.rolcreaterole, `${row.rolname} holds CREATEROLE`);
        assert(!row.rolcreatedb, `${row.rolname} holds CREATEDB`);
        assert((row.description ?? "").length > 40, `${row.rolname} has no useful comment`);
      }
      return `${rows.map((r) => r.rolname).sort().join(", ")}: no superuser, no BYPASSRLS, no CREATEROLE`;
    });

    await check("schema catalogue matches the contract", async () => {
      const rows = await fresh.query<{
        schema_name: string;
        purpose: string;
        browser_exposed: boolean;
        data_class: string;
        retention_class: string;
        owning_role: string;
      }>(`select * from ops.schema_catalogue order by schema_name`);
      assert(rows.length === 8, `expected 8 catalogue rows, saw ${rows.length}`);
      for (const entry of SCHEMAS) {
        const row = rows.find((candidate) => candidate.schema_name === entry.name);
        assert(row !== undefined, `${entry.name} is missing from the catalogue`);
        assert(row!.browser_exposed === entry.browserExposed, `${entry.name} exposure disagrees`);
        assert(row!.data_class === entry.dataClass, `${entry.name} data class disagrees`);
        assert(row!.retention_class === entry.retention, `${entry.name} retention disagrees`);
        assert(row!.owning_role === MIGRATOR_ROLE, `${entry.name} owning role disagrees`);
      }
      return `8 rows agree with SCHEMAS on exposure, data class, retention, and owner`;
    });

    // -------------------------------------------------------- browser denial
    await check("browser and service roles reach no internal schema", async () => {
      const rows = await fresh.query<{ role: string; schema: string; usage: boolean; create: boolean }>(
        `select r.rolname as role, n.nspname as schema,
                has_schema_privilege(r.rolname, n.nspname, 'USAGE') as usage,
                has_schema_privilege(r.rolname, n.nspname, 'CREATE') as create
         from pg_roles r cross join pg_namespace n
         where r.rolname = any($1) and n.nspname = any($2)`,
        [DENIED_ROLES as unknown as string[], SCHEMA_NAMES as string[]],
      );
      assert(rows.length === 24, `expected 24 role/schema pairs, saw ${rows.length}`);
      const held = rows.filter((row) => row.usage || row.create);
      assert(held.length === 0, `held privileges: ${held.map((r) => `${r.role}->${r.schema}`).join(", ")}`);
      return `anon, authenticated, service_role: 0 of 24 schema privileges`;
    });

    await check("PUBLIC cannot execute either actor helper", async () => {
      const rows = await fresh.query<{ helper: string; public_execute: boolean }>(
        `select p.oid::regprocedure::text as helper,
                has_function_privilege('public', p.oid, 'EXECUTE') as public_execute
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'private'`,
      );
      assert(rows.length === 2, `expected 2 private helpers, saw ${rows.length}`);
      const leaked = rows.filter((row) => row.public_execute);
      assert(leaked.length === 0, `PUBLIC may execute ${leaked.map((r) => r.helper).join(", ")}`);
      return `${rows.map((r) => r.helper).sort().join(", ")}: PUBLIC has no EXECUTE`;
    });

    await check("anonymous connection is refused every internal schema", async () => {
      const codes: string[] = [];
      for (const role of DENIED_ROLES) {
        codes.push(await refusal(fresh, role, `select private.current_actor_id()`));
        codes.push(await refusal(fresh, role, `select * from ops.schema_catalogue`));
      }
      assert(
        codes.every((code) => code === "42501" || code === "3F000" || code === "42P01"),
        `unexpected SQLSTATEs: ${codes.join(", ")}`,
      );
      return `6 connected denials as anon/authenticated/service_role, SQLSTATEs ${[...new Set(codes)].sort().join(", ")}`;
    });

    await check("a function created after the migration is not PUBLIC-executable", async () => {
      const migrator = postgres(fresh.urlFor(MIGRATOR_ROLE), { max: 1, prepare: false, onnotice: () => {} });
      try {
        await migrator.unsafe(`create function app.post_migration_probe() returns int language sql as 'select 1'`);
      } finally {
        await migrator.end({ timeout: 5 });
      }
      const rows = await fresh.query<{ acl: string | null; public_execute: boolean; api_execute: boolean }>(
        `select p.proacl::text as acl,
                has_function_privilege('public', p.oid, 'EXECUTE') as public_execute,
                has_function_privilege('forma_api', p.oid, 'EXECUTE') as api_execute
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'app' and p.proname = 'post_migration_probe'`,
      );
      assert(rows.length === 1, "the probe function was not created");
      assert(!rows[0].public_execute, `PUBLIC may execute a new function; proacl=${rows[0].acl}`);
      assert(!rows[0].api_execute, "forma_api may execute an unreviewed new function");
      const code = await refusal(fresh, "forma_api", `select app.post_migration_probe()`);
      assert(code === "42501", `forma_api refusal SQLSTATE was ${code}`);
      await fresh.query(`drop function app.post_migration_probe()`);
      return `default privileges hold: proacl={forma_migrator}, forma_api refused with 42501 despite schema USAGE`;
    });

    // --------------------------------------------------------- role isolation
    await check("each runtime role holds exactly its contract schemas", async () => {
      const rows = await fresh.query<{ role: string; schema: string; usage: boolean }>(
        `select r.rolname as role, n.nspname as schema,
                has_schema_privilege(r.rolname, n.nspname, 'USAGE') as usage
         from pg_roles r cross join pg_namespace n
         where r.rolname = any($1) and n.nspname = any($2)`,
        [RUNTIME_ROLES.map((role) => role.name), SCHEMA_NAMES as string[]],
      );
      assert(rows.length === 40, `expected 40 role/schema pairs, saw ${rows.length}`);
      for (const role of RUNTIME_ROLES) {
        for (const schema of SCHEMA_NAMES) {
          const row = rows.find((candidate) => candidate.role === role.name && candidate.schema === schema)!;
          const expected = role.usage.includes(schema);
          assert(
            row.usage === expected,
            `${role.name} ${row.usage ? "holds" : "lacks"} USAGE on ${schema}; contract says ${expected ? "holds" : "lacks"}`,
          );
        }
      }
      return `40 role/schema pairs match RUNTIME_ROLES exactly`;
    });

    await check("no runtime role may create objects in any namespace", async () => {
      const rows = await fresh.query<{ role: string; schema: string }>(
        `select r.rolname as role, n.nspname as schema
         from pg_roles r cross join pg_namespace n
         where r.rolname = any($1) and n.nspname = any($2)
           and has_schema_privilege(r.rolname, n.nspname, 'CREATE')`,
        [RUNTIME_ROLES.map((role) => role.name), SCHEMA_NAMES as string[]],
      );
      assert(rows.length === 0, `may create: ${rows.map((r) => `${r.role}->${r.schema}`).join(", ")}`);
      const code = await refusal(fresh, "forma_api", `create table app.smuggled (id int)`);
      assert(code === "42501", `forma_api CREATE refusal SQLSTATE was ${code}`);
      return `0 of 40 CREATE privileges; forma_api refused CREATE TABLE with 42501`;
    });

    await check("every foreign key in a target schema is indexed", async () => {
      const shipped = await unindexedForeignKeys(fresh);
      assert(
        shipped.length === 0,
        `unindexed: ${shipped.map((row) => `${row.table_name}.${row.constraint_name}`).join(", ")}`,
      );
      // E02 ships one table and no foreign key, so the rule above passes
      // vacuously. Prove it is a rule and not a decoration before the epics
      // that add tables rely on it.
      await fresh.query(`create table app.fk_parent (id bigint generated always as identity primary key)`);
      await fresh.query(
        `create table app.fk_child (
           id bigint generated always as identity primary key,
           parent_id bigint not null references app.fk_parent (id)
         )`,
      );
      const flagged = await unindexedForeignKeys(fresh);
      assert(
        flagged.length === 1 && flagged[0].table_name === "app.fk_child",
        `the rule did not flag an unindexed foreign key; it reported ${flagged.length}`,
      );
      await fresh.query(`create index fk_child_parent_idx on app.fk_child (parent_id)`);
      const cleared = await unindexedForeignKeys(fresh);
      assert(cleared.length === 0, "indexing the column did not clear the finding");

      // A composite foreign key needs an index that *leads* with its columns in
      // the constraint's order. An index over the same columns reversed does
      // not serve the path, and must not be accepted as if it did.
      await fresh.query(
        `create table app.fk_pair (z_col int not null, a_col int not null, primary key (z_col, a_col))`,
      );
      await fresh.query(
        `create table app.fk_pair_child (
           z_col int not null,
           a_col int not null,
           foreign key (z_col, a_col) references app.fk_pair (z_col, a_col)
         )`,
      );
      await fresh.query(`create index fk_pair_child_reversed on app.fk_pair_child (a_col, z_col)`);
      const reversed = await unindexedForeignKeys(fresh);
      assert(
        reversed.length === 1 && reversed[0].table_name === "app.fk_pair_child",
        `a reversed composite index was accepted as covering; the rule reported ${reversed.length} findings`,
      );
      await fresh.query(`create index fk_pair_child_ordered on app.fk_pair_child (z_col, a_col)`);
      const ordered = await unindexedForeignKeys(fresh);
      assert(ordered.length === 0, "an index in the constraint's own column order did not clear the finding");

      await fresh.query(`drop table app.fk_pair_child`);
      await fresh.query(`drop table app.fk_pair`);
      await fresh.query(`drop table app.fk_child`);
      await fresh.query(`drop table app.fk_parent`);
      return `0 unindexed foreign keys across 8 schemas; the rule flags an unindexed FK, rejects a reversed composite index, and clears on a correctly ordered one`;
    });

    await check("forma_stockfish holds no actor helper and no identity schema", async () => {
      const schemaCode = await refusal(fresh, "forma_stockfish", `select 1 from app.tenancy_probe`);
      const helperCode = await refusal(
        fresh,
        "forma_stockfish",
        `select private.set_actor_context('${ACTOR_A}'::uuid)`,
      );
      const rows = await fresh.query<{ ok: boolean }>(
        `select has_function_privilege('forma_stockfish', 'private.set_actor_context(uuid)', 'EXECUTE') as ok`,
      );
      assert(!rows[0].ok, "forma_stockfish holds EXECUTE on set_actor_context");
      return `app schema refused (${schemaCode}); private.set_actor_context refused (${helperCode})`;
    });

    // ------------------------------------------------------ actor and tenancy
    await installTenancyFixture(fresh);

    await check("the bound actor sees only its own rows", async () => {
      const client = postgres(fresh.urlFor("forma_api"), { max: 1, prepare: false, onnotice: () => {} });
      try {
        const rows = await client.begin(async (tx) => {
          await tx.unsafe(`select private.set_actor_context('${ACTOR_A}'::uuid)`);
          return tx.unsafe(`select owner_user_id::text as owner from app.tenancy_probe`);
        });
        assert(rows.length === 1, `actor A saw ${rows.length} rows`);
        assert(first<{ owner: string }>(rows, "owner").owner === ACTOR_A, "actor A saw another actor's row");
      } finally {
        await client.end({ timeout: 5 });
      }
      return `forma_api bound to actor A reads 1 of 2 rows`;
    });

    await check("an unbound transaction reads nothing", async () => {
      const client = postgres(fresh.urlFor("forma_api"), { max: 1, prepare: false, onnotice: () => {} });
      try {
        const rows = await client.unsafe(`select 1 from app.tenancy_probe`);
        assert(rows.length === 0, `an unbound connection read ${rows.length} rows`);
        const setting = await client.unsafe(
          `select coalesce(current_setting('${ACTOR_SETTING}', true), '<unset>') as value`,
        );
        assert(first<{ value: string }>(setting, "setting").value === "<unset>", "the actor setting was already set");
      } finally {
        await client.end({ timeout: 5 });
      }
      return `null actor denies: 0 rows, ${ACTOR_SETTING} unset`;
    });

    await check("the actor does not survive its transaction on a pooled connection", async () => {
      const client = postgres(fresh.urlFor("forma_api"), { max: 1, prepare: false, onnotice: () => {} });
      let raw = "";
      try {
        const backends = new Set<string>();
        const bound = await client.begin(async (tx) => {
          await tx.unsafe(`select private.set_actor_context('${ACTOR_A}'::uuid)`);
          const pid = await tx.unsafe(`select pg_backend_pid()::text as pid`);
          backends.add(first<{ pid: string }>(pid, "backend pid").pid);
          return tx.unsafe(`select count(*)::int as seen from app.tenancy_probe`);
        });
        assert(first<{ seen: number }>(bound, "bound count").seen === 1, "the first transaction did not see its row");
        const second = await client.begin(async (tx) => {
          const pid = await tx.unsafe(`select pg_backend_pid()::text as pid`);
          backends.add(first<{ pid: string }>(pid, "backend pid").pid);
          return tx.unsafe(
            `select (select count(*)::int from app.tenancy_probe) as seen,
                    private.current_actor_id()::text as actor,
                    quote_literal(coalesce(current_setting('${ACTOR_SETTING}', true), '<null>')) as raw`,
          );
        });
        assert(backends.size === 1, "the two transactions did not share a backend, so nothing was proven");
        const next = first<{ seen: number; actor: string | null; raw: string }>(second, "second transaction");
        // A custom setting reverts to the empty string rather than to null once
        // the session has seen it, which is why the actor is read through the
        // helper: an empty setting must resolve to no actor, not to a value.
        assert(next.actor === null, `the actor leaked into the next transaction as ${next.actor}`);
        assert(next.seen === 0, `the next transaction still saw ${next.seen} rows`);
        raw = next.raw;
      } finally {
        await client.end({ timeout: 5 });
      }
      return `same backend, second transaction: setting reverts to ${raw}, current_actor_id() null, 0 rows visible`;
    });

    await check("an actor cannot forge or hand off ownership", async () => {
      const client = postgres(fresh.urlFor("forma_api"), { max: 1, prepare: false, onnotice: () => {} });
      const codes: Record<string, string> = {};
      try {
        for (const [label, statement] of [
          ["insert", `insert into app.tenancy_probe (owner_user_id, note) values ('${ACTOR_B}', 'forged')`],
          ["update", `update app.tenancy_probe set owner_user_id = '${ACTOR_B}' where owner_user_id = '${ACTOR_A}'`],
        ] as const) {
          try {
            await client.begin(async (tx) => {
              await tx.unsafe(`select private.set_actor_context('${ACTOR_A}'::uuid)`);
              await tx.unsafe(statement);
            });
            throw new Error(`actor A was allowed to ${label} a row owned by actor B`);
          } catch (error) {
            const code = (error as { code?: string }).code;
            assert(code === "42501", `${label} was refused with ${code ?? "no SQLSTATE"}`);
            codes[label] = code!;
          }
        }
        const deleted = await client.begin(async (tx) => {
          await tx.unsafe(`select private.set_actor_context('${ACTOR_A}'::uuid)`);
          return tx.unsafe(`delete from app.tenancy_probe where owner_user_id = '${ACTOR_B}' returning id`);
        });
        assert(deleted.length === 0, "actor A deleted actor B's row");
      } finally {
        await client.end({ timeout: 5 });
      }
      return `forged insert ${codes.insert}, ownership handoff ${codes.update}, cross-actor delete affected 0 rows`;
    });

    await check("a null actor is rejected rather than treated as a wildcard", async () => {
      const code = await refusal(fresh, "forma_api", `select private.set_actor_context(null)`);
      assert(code === "22004", `null actor was refused with ${code}`);
      const rows = await fresh.query<{ actor: string | null }>(
        `select set_config('${ACTOR_SETTING}', 'not-a-uuid', false) is not null as ignored,
                private.current_actor_id()::text as actor`,
      );
      assert(rows[0].actor === null, `a malformed setting resolved to ${rows[0].actor}`);
      await fresh.query(`select set_config('${ACTOR_SETTING}', '', false)`);
      return `null actor refused with 22004; malformed setting resolves to null, not a match`;
    });

    await check("forced RLS binds the owner too", async () => {
      const client = postgres(fresh.urlFor(MIGRATOR_ROLE), { max: 1, prepare: false, onnotice: () => {} });
      try {
        const rows = await client.unsafe(`select count(*)::int as seen from app.tenancy_probe`);
        const seen = first<{ seen: number }>(rows, "owner count").seen;
        assert(seen === 0, `the owner read ${seen} tenant rows`);
      } finally {
        await client.end({ timeout: 5 });
      }
      const forced = await fresh.query<{ relforcerowsecurity: boolean }>(
        `select relforcerowsecurity from pg_class where oid = 'app.tenancy_probe'::regclass`,
      );
      assert(forced[0].relforcerowsecurity, "RLS is enabled but not forced on the fixture");
      return `${MIGRATOR_ROLE} owns app.tenancy_probe and reads 0 of 2 rows`;
    });

    await fresh.query(`drop table app.tenancy_probe`);

    // ------------------------------------------------------------- rerun
    await check("re-running the migration path changes nothing", async () => {
      await applyMigrations(fresh.adminUrl);
      const applied = await fresh.query<{ count: string }>(
        `select count(*)::text from drizzle.__drizzle_migrations`,
      );
      assert(
        applied[0].count === String(JOURNAL_LENGTH),
        `journal grew to ${applied[0].count} entries`,
      );
      const catalogue = await fresh.query<{ count: string }>(
        `select count(*)::text from ops.schema_catalogue`,
      );
      assert(catalogue[0].count === "8", `catalogue grew to ${catalogue[0].count} rows`);
      return `second db:migrate applied 0 new migrations, catalogue still 8 rows`;
    });

    await check("re-applying the committed SQL over live objects is a no-op", async () => {
      await fresh.query(CLEAR_LEDGER_FROM_MIGRATION);
      await applyMigrations(fresh.adminUrl);
      const catalogue = await fresh.query<{ count: string }>(
        `select count(*)::text from ops.schema_catalogue`,
      );
      assert(catalogue[0].count === "8", `catalogue grew to ${catalogue[0].count} rows`);
      const schemas = await fresh.query<{ count: string }>(
        `select count(*)::text from pg_namespace where nspname = any($1)`,
        [SCHEMA_NAMES as string[]],
      );
      assert(schemas[0].count === "8", `schema count became ${schemas[0].count}`);
      return `${MIGRATION_TAG} replayed against an already-migrated database: 8 schemas, 8 catalogue rows`;
    });

    // -------------------------------------------------- forward recovery
    await check("forward recovery repairs conflicting hand-applied DDL", async () => {
      await fresh.query(`revoke usage on schema chess from forma_ingestion`);
      await fresh.query(`grant usage on schema private to anon`);
      await fresh.query(`drop policy schema_catalogue_runtime_read on ops.schema_catalogue`);
      await fresh.query(`delete from ops.schema_catalogue where schema_name = 'coaching'`);
      await fresh.query(CLEAR_LEDGER_FROM_MIGRATION);

      await applyMigrations(fresh.adminUrl);

      const repaired = await fresh.query<{
        ingestion: boolean;
        anon: boolean;
        policies: string;
        catalogue: string;
      }>(
        `select has_schema_privilege('forma_ingestion', 'chess', 'USAGE') as ingestion,
                has_schema_privilege('anon', 'private', 'USAGE') as anon,
                (select count(*)::text from pg_policies
                  where schemaname = 'ops' and tablename = 'schema_catalogue') as policies,
                (select count(*)::text from ops.schema_catalogue) as catalogue`,
      );
      assert(repaired[0].ingestion, "forma_ingestion did not regain USAGE on chess");
      assert(!repaired[0].anon, "anon kept USAGE on private");
      assert(repaired[0].policies === "1", `catalogue has ${repaired[0].policies} policies`);
      assert(repaired[0].catalogue === "8", `catalogue recovered to ${repaired[0].catalogue} rows`);
      return `revoked grant, anon grant, dropped policy, and deleted row all repaired by re-running forward`;
    });
  } finally {
    await fresh.destroy();
  }

  // --------------------------------------------- non-superuser deployment
  //
  // Everything above ran as the cluster's bootstrap superuser, which can do
  // anything and therefore proves nothing about the documented deploy path.
  // The hosted deploy role is not a superuser: it owns the database, holds
  // CREATEROLE, and holds the membership CREATEROLE grants automatically —
  // ADMIN TRUE, SET FALSE, INHERIT FALSE. That is the posture below.
  const hosted = await createDisposableDatabase();
  const deployer = `forma_deploy_${hosted.database}`;
  try {
    await check("a non-superuser deploy role applies the migration", async () => {
      await applyMigrations(hosted.adminUrl, "0011_e01_containment");
      await seedLegacyRows(hosted);
      const before = await legacyFingerprint(hosted);

      await hosted.query(
        `create role ${deployer} with login password '${HARNESS_PASSWORD}'
         nosuperuser createrole nocreatedb nobypassrls`,
      );
      await hosted.query(`alter database ${hosted.database} owner to ${deployer}`);
      await hosted.query(`grant create, usage on schema public to ${deployer}`);
      // Exactly the membership a CREATEROLE role receives for a role it creates.
      await hosted.query(`grant forma_migrator to ${deployer} with admin true, set false, inherit false`);
      // The migration ledger belongs to whoever ran the earlier migrations.
      await hosted.query(`alter schema drizzle owner to ${deployer}`);
      await hosted.query(`alter table drizzle.__drizzle_migrations owner to ${deployer}`);
      await hosted.query(`do $$
        declare seq text;
        begin
          for seq in
            select c.oid::regclass::text from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'drizzle' and c.relkind = 'S'
          loop
            execute format('alter sequence %s owner to ${deployer}', seq);
          end loop;
        end $$`);

      await applyMigrations(hosted.urlFor(deployer));

      const shape = first<{
        schemas: string;
        migrator_owned: string;
        catalogue_owner: string;
        ledger_owner: string;
        ledger_rows: string;
      }>(
        await hosted.query(
          `select (select count(*)::text from pg_namespace where nspname = any($1)) as schemas,
                  (select count(*)::text from pg_namespace
                    where nspname = any($1) and pg_get_userbyid(nspowner) = 'forma_migrator') as migrator_owned,
                  pg_get_userbyid((select relowner from pg_class where oid = 'ops.schema_catalogue'::regclass)) as catalogue_owner,
                  pg_get_userbyid((select relowner from pg_class where oid = 'drizzle.__drizzle_migrations'::regclass)) as ledger_owner,
                  (select count(*)::text from drizzle.__drizzle_migrations) as ledger_rows`,
          [SCHEMA_NAMES as string[]],
        ),
        "deployment shape",
      );
      assert(shape.schemas === "8", `expected 8 namespaces, saw ${shape.schemas}`);
      assert(shape.migrator_owned === "8", `only ${shape.migrator_owned} of 8 are owned by ${MIGRATOR_ROLE}`);
      assert(shape.catalogue_owner === MIGRATOR_ROLE, `catalogue is owned by ${shape.catalogue_owner}`);
      assert(shape.ledger_owner === deployer, `ledger ownership moved to ${shape.ledger_owner}`);
      assert(
        shape.ledger_rows === String(JOURNAL_LENGTH),
        `ledger holds ${shape.ledger_rows} rows; the bootstrap insert was lost`,
      );
      assert((await legacyFingerprint(hosted)) === before, "the legacy schema or its rows changed");
      const commented = first<{ count: string }>(
        await hosted.query(
          `select count(*)::text from pg_roles r
           where r.rolname = any($1) and coalesce(shobj_description(r.oid, 'pg_authid'), '') <> ''`,
          [ROLE_NAMES as string[]],
        ),
        "role comments",
      );
      assert(commented.count === "6", `only ${commented.count} of 6 roles carry a comment`);
      return `applied by a non-superuser CREATEROLE deploy role: 8 namespaces owned by ${MIGRATOR_ROLE}, catalogue owned by ${MIGRATOR_ROLE}, ledger still ${deployer}'s with ${JOURNAL_LENGTH} rows, legacy data unchanged`;
    });

    await check("the migrator can then run migrations and the recovery replay", async () => {
      await grantRolePasswords(hosted, [MIGRATOR_ROLE]);
      const migratorUrl = hosted.urlFor(MIGRATOR_ROLE);
      // An ordinary later run: nothing pending, but it must reach the ledger.
      await applyMigrations(migratorUrl);

      // The documented recovery: clear this migration's ledger row, damage the
      // contract, and re-run forward — all as the migration role, not as an
      // administrator standing in for it.
      const migrator = postgres(migratorUrl, { max: 1, prepare: false, onnotice: () => {} });
      try {
        await migrator.unsafe(CLEAR_LEDGER_FROM_MIGRATION);
      } finally {
        await migrator.end({ timeout: 5 });
      }
      await hosted.query(`revoke usage on schema chess from forma_ingestion`);
      await hosted.query(`delete from ops.schema_catalogue where schema_name = 'coaching'`);

      await applyMigrations(migratorUrl);

      const repaired = first<{ ingestion: boolean; catalogue: string; ledger: string }>(
        await hosted.query(
          `select has_schema_privilege('forma_ingestion', 'chess', 'USAGE') as ingestion,
                  (select count(*)::text from ops.schema_catalogue) as catalogue,
                  (select count(*)::text from drizzle.__drizzle_migrations) as ledger`,
        ),
        "recovery",
      );
      assert(repaired.ingestion, "forma_ingestion did not regain USAGE on chess");
      assert(repaired.catalogue === "8", `catalogue recovered to ${repaired.catalogue} rows`);
      assert(
        repaired.ledger === String(JOURNAL_LENGTH),
        `ledger holds ${repaired.ledger} rows after replay`,
      );
      return `${MIGRATOR_ROLE} ran db:migrate and replayed ${MIGRATION_TAG}: grant and catalogue row restored, ledger back to ${JOURNAL_LENGTH}`;
    });
  } finally {
    // Roles are cluster-wide; the database is not. Hand the database back before
    // dropping the deploy role so a caller-managed server is left as it was.
    try {
      const admin = first<{ role: string }>(
        await hosted.query(`select current_user as role`),
        "current_user",
      ).role;
      await hosted.query(`alter database ${hosted.database} owner to ${admin}`);
      await hosted.query(`reassign owned by ${deployer} to ${admin}`);
      await hosted.query(`drop owned by ${deployer}`);
      await hosted.query(`drop role ${deployer}`);
    } catch {
      // Best effort: the database is about to be dropped either way.
    }
    await hosted.destroy();
  }

  // ------------------------------------------------------- legacy-shaped
  const legacy = await createDisposableDatabase();
  try {
    await check("a production-shaped legacy database migrates without touching legacy data", async () => {
      await applyMigrations(legacy.adminUrl, "0011_e01_containment");
      await seedLegacyRows(legacy);
      const before = await legacyFingerprint(legacy);
      const legacyTables = await legacy.query<{ count: string }>(
        `select count(*)::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r'`,
      );

      await applyMigrations(legacy.adminUrl);

      const after = await legacyFingerprint(legacy);
      assert(before === after, "the legacy schema or its rows changed");
      const afterTables = await legacy.query<{ count: string }>(
        `select count(*)::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r'`,
      );
      assert(
        legacyTables[0].count === afterTables[0].count,
        `legacy table count moved from ${legacyTables[0].count} to ${afterTables[0].count}`,
      );
      const schemas = await legacy.query<{ count: string }>(
        `select count(*)::text from pg_namespace where nspname = any($1)`,
        [SCHEMA_NAMES as string[]],
      );
      assert(schemas[0].count === "8", `expected 8 new schemas beside legacy, saw ${schemas[0].count}`);
      return `${afterTables[0].count} legacy tables and 5 seeded rows unchanged; 8 namespaces created beside them`;
    });

    await check("E01's containment survives E02", async () => {
      const rows = await legacy.query<{ role: string; table_name: string; privilege: string }>(
        `select grantee as role, table_name, privilege_type as privilege
         from information_schema.role_table_grants
         where table_schema = 'public' and grantee in ('anon', 'authenticated', 'PUBLIC')`,
      );
      assert(rows.length === 0, `browser roles regained ${rows.length} legacy table grants`);
      const rls = await legacy.query<{ count: string }>(
        `select count(*)::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
      );
      assert(rls[0].count === "0", `${rls[0].count} legacy tables lost RLS`);
      return `0 legacy table grants to anon/authenticated/PUBLIC; RLS still enabled on every legacy table`;
    });
  } finally {
    await legacy.destroy();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
  }
}

await main();

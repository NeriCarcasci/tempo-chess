/**
 * Read-only catalogue probes.
 *
 * Every statement in this file is a `select`. The rehearsal runs them against a
 * disposable database and the production gate runs them against the live one
 * through an authorized read-only administrative path, so a stray write here
 * would be a write to production. There are none, and `readOnly()` refuses to
 * pass anything that is not a `select`.
 *
 * The catalogue is read as a snapshot — a fixed handful of queries — rather than
 * one query per assertion. Several hundred round trips against a live control
 * plane is both rude and rate-limited, and a snapshot has the better property
 * anyway: all 147 production assertions judge one coherent observation instead of
 * 147 observations taken at different instants.
 *
 * Effective privileges are read through `has_*_privilege`, which accounts for
 * role inheritance and memberships. Explicit table and column ACLs are also
 * enumerated so redundant column grants, unexpected grantees, and grant options
 * cannot hide behind an otherwise-correct effective privilege set.
 */

import type { CatalogueSource, ObservedPolicy } from "../catalogue.js";
import type { RoleAttributes } from "../sql-model.js";
import { DENIED_ROLES, MIGRATOR_ROLE, RUNTIME_ROLE, type AccessClass } from "../contract.js";

export type SqlRow = Record<string, unknown>;
/** A parameterless read-only query runner. Callers pass complete `select` text. */
export type SqlQuery = (sql: string) => Promise<SqlRow[]>;

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function assertReadOnly(sql: string): void {
  if (!/^\s*select\b/i.test(sql)) {
    throw new Error("catalogue probes may only issue select statements");
  }
}

/** Wrap a runner so nothing but a `select` can leave this module. */
export function readOnly(query: SqlQuery): SqlQuery {
  return async (sql: string) => {
    assertReadOnly(sql);
    return query(sql);
  };
}

const TABLE_PRIVILEGES = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
] as const;

const SEQUENCE_PRIVILEGES = ["USAGE", "SELECT", "UPDATE"] as const;
const COLUMN_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "REFERENCES"] as const;
/** Relations on which PostgreSQL accepts table privileges. */
const TABLE_RELKINDS = ["r", "v", "m", "f", "p"] as const;
const TABLE_RELKIND_SQL = TABLE_RELKINDS.map(literal).join(", ");

/** Roles every gate asks about. Kept small so the snapshot stays cheap. */
const OBSERVED_ROLES = [RUNTIME_ROLE, MIGRATOR_ROLE, ...DENIED_ROLES] as const;
const NAMED_ROLES = OBSERVED_ROLES.filter((role) => role !== "PUBLIC");

function valuesList(items: readonly string[]): string {
  return items.map((item) => `(${literal(item)})`).join(", ");
}

interface Snapshot {
  tables: Map<string, boolean>;
  policies: Map<string, ObservedPolicy[]>;
  /** `table grantee` to privileges. */
  grants: Map<string, Set<string>>;
  explicitGrantRecords: string[];
  roles: Map<string, RoleAttributes>;
  owned: Map<string, string[]>;
  schemaUsage: Set<string>;
  sequences: Map<string, string[]>;
  routines: Map<string, string[]>;
}

function commandFromPolCmd(polcmd: string): string {
  switch (polcmd) {
    case "r":
      return "SELECT";
    case "a":
      return "INSERT";
    case "w":
      return "UPDATE";
    case "d":
      return "DELETE";
    case "*":
      return "ALL";
    default:
      return polcmd;
  }
}

/** `pg_get_expr` renders a literal `true` as `true`; normalise the harmless variants. */
function normaliseExpression(expression: string): string {
  const trimmed = expression.trim();
  if (trimmed === "true" || trimmed === "(true)") return "true";
  return trimmed;
}

async function loadSnapshot(query: SqlQuery): Promise<Snapshot> {
  const tableRows = await query(
    `select c.relname as name, c.relrowsecurity as rls
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in (${TABLE_RELKIND_SQL}) order by 1`,
  );
  const tables = new Map<string, boolean>(
    tableRows.map((row) => [String(row.name), row.rls === true]),
  );

  const policyRows = await query(
    `select c.relname as table_name,
            p.polname as name,
            coalesce(
              (select string_agg(pg_get_userbyid(r), ',' order by pg_get_userbyid(r))
                 from unnest(p.polroles) r where r <> 0),
              ''
            ) as roles,
            (0 = any(p.polroles)) as applies_to_public,
            p.polcmd as cmd,
            p.polpermissive as permissive,
            coalesce(pg_get_expr(p.polqual, p.polrelid), 'null') as qual,
            coalesce(pg_get_expr(p.polwithcheck, p.polrelid), 'null') as with_check
     from pg_policy p
     join pg_class c on c.oid = p.polrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' order by 1, 2`,
  );
  const policies = new Map<string, ObservedPolicy[]>();
  for (const row of policyRows) {
    const table = String(row.table_name);
    // Joined server-side: the two drivers in play render a text[] differently
    // (a real array here, a `{a,b}` literal there), and a comma-joined string is
    // unambiguous for both.
    const roles = String(row.roles ?? "")
      .split(",")
      .map((role) => role.trim())
      .filter((role) => role.length > 0);
    if (row.applies_to_public === true) roles.push("PUBLIC");
    const list = policies.get(table) ?? [];
    list.push({
      name: String(row.name),
      roles,
      command: commandFromPolCmd(String(row.cmd)),
      permissive: row.permissive === true,
      qual: normaliseExpression(String(row.qual)),
      withCheck: normaliseExpression(String(row.with_check)),
    });
    policies.set(table, list);
  }

  const grants = new Map<string, Set<string>>();
  const namedGrantRows = await query(
    `select c.relname as table_name, g.grantee as grantee, p.privilege as privilege
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     cross join (values ${valuesList(NAMED_ROLES)}) as g(grantee)
     cross join (values ${valuesList(TABLE_PRIVILEGES)}) as p(privilege)
     where n.nspname = 'public' and c.relkind in (${TABLE_RELKIND_SQL})
       and exists (select 1 from pg_roles where rolname = g.grantee)
       and has_table_privilege(g.grantee, c.oid, p.privilege)
     order by 1, 2, 3`,
  );
  const publicGrantRows = await query(
    `select c.relname as table_name, 'PUBLIC' as grantee, a.privilege_type as privilege,
            a.is_grantable as is_grantable
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace,
     lateral aclexplode(c.relacl) a
     where n.nspname = 'public' and c.relkind in (${TABLE_RELKIND_SQL}) and a.grantee = 0
     order by 1, 3`,
  );
  for (const row of [...namedGrantRows, ...publicGrantRows]) {
    const key = `${String(row.table_name)} ${String(row.grantee)}`;
    const held = grants.get(key) ?? new Set<string>();
    held.add(String(row.privilege).toUpperCase());
    if (row.is_grantable === true) {
      held.add(`${String(row.privilege).toUpperCase()} WITH GRANT OPTION`);
    }
    grants.set(key, held);
  }

  const namedGrantOptionRows = await query(
    `select c.relname as table_name, g.grantee as grantee, p.privilege as privilege
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     cross join (values ${valuesList(NAMED_ROLES)}) as g(grantee)
     cross join (values ${valuesList(TABLE_PRIVILEGES)}) as p(privilege)
     where n.nspname = 'public' and c.relkind in (${TABLE_RELKIND_SQL})
       and exists (select 1 from pg_roles where rolname = g.grantee)
       and has_table_privilege(g.grantee, c.oid, p.privilege || ' WITH GRANT OPTION')
     order by 1, 2, 3`,
  );
  for (const row of namedGrantOptionRows) {
    const key = `${String(row.table_name)} ${String(row.grantee)}`;
    const held = grants.get(key) ?? new Set<string>();
    held.add(`${String(row.privilege).toUpperCase()} WITH GRANT OPTION`);
    grants.set(key, held);
  }

  // Column-only effective access must not disappear behind a table-only probe.
  const namedColumnRows = await query(
    `select c.relname as table_name, att.attname as column_name,
            g.grantee as grantee, p.privilege as privilege,
            has_column_privilege(g.grantee, c.oid, att.attnum, p.privilege || ' WITH GRANT OPTION') as is_grantable
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     join pg_attribute att on att.attrelid = c.oid and att.attnum > 0 and not att.attisdropped
     cross join (values ${valuesList(NAMED_ROLES)}) as g(grantee)
     cross join (values ${valuesList(COLUMN_PRIVILEGES)}) as p(privilege)
     where n.nspname = 'public' and c.relkind in (${TABLE_RELKIND_SQL})
       and exists (select 1 from pg_roles where rolname = g.grantee)
       and has_column_privilege(g.grantee, c.oid, att.attnum, p.privilege)
       and not has_table_privilege(g.grantee, c.oid, p.privilege)
     order by 1, 2, 3, 4`,
  );
  for (const row of namedColumnRows) {
    const key = `${String(row.table_name)} ${String(row.grantee)}`;
    const held = grants.get(key) ?? new Set<string>();
    const privilege = `COLUMN ${String(row.column_name)}:${String(row.privilege).toUpperCase()}`;
    held.add(privilege);
    if (row.is_grantable === true) held.add(`${privilege} WITH GRANT OPTION`);
    grants.set(key, held);
  }

  const explicitTableRows = await query(
    `select c.relname as table_name,
            case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
            a.privilege_type as privilege, a.is_grantable as is_grantable
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     join lateral aclexplode(c.relacl) a on true
     where n.nspname = 'public' and c.relkind in (${TABLE_RELKIND_SQL})
       and (a.grantee = 0 or pg_get_userbyid(a.grantee) in (${NAMED_ROLES.map(literal).join(", ")}))
     order by 1, 2, 3`,
  );
  const explicitColumnRows = await query(
    `select c.relname as table_name, att.attname as column_name,
            case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
            a.privilege_type as privilege, a.is_grantable as is_grantable
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     join pg_attribute att on att.attrelid = c.oid and att.attnum > 0 and not att.attisdropped
     join lateral aclexplode(att.attacl) a on true
     where n.nspname = 'public' and c.relkind in (${TABLE_RELKIND_SQL})
     order by 1, 2, 3, 4`,
  );
  const explicitGrantRecords = [
    ...explicitTableRows.map(
      (row) =>
        `table:${String(row.table_name)}:${String(row.privilege).toUpperCase()}:${String(row.grantee)}:grantable=${row.is_grantable === true}`,
    ),
    ...explicitColumnRows.map(
      (row) =>
        `column:${String(row.table_name)}.${String(row.column_name)}:${String(row.privilege).toUpperCase()}:${String(row.grantee)}:grantable=${row.is_grantable === true}`,
    ),
  ].sort();
  for (const row of explicitColumnRows.filter((entry) => String(entry.grantee) === "PUBLIC")) {
    const key = `${String(row.table_name)} PUBLIC`;
    const held = grants.get(key) ?? new Set<string>();
    const privilege = `COLUMN ${String(row.column_name)}:${String(row.privilege).toUpperCase()}`;
    held.add(privilege);
    if (row.is_grantable === true) held.add(`${privilege} WITH GRANT OPTION`);
    grants.set(key, held);
  }

  const roleRows = await query(
    `select rolname as name, rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
     from pg_roles where rolname in (${NAMED_ROLES.map(literal).join(", ")}) order by 1`,
  );
  const roles = new Map<string, RoleAttributes>(
    roleRows.map((row) => [
      String(row.name),
      {
        rolcanlogin: row.rolcanlogin === true,
        rolinherit: row.rolinherit === true,
        rolsuper: row.rolsuper === true,
        rolcreatedb: row.rolcreatedb === true,
        rolcreaterole: row.rolcreaterole === true,
        rolbypassrls: row.rolbypassrls === true,
      },
    ]),
  );

  const ownedRows = await query(
    `select pg_get_userbyid(c.relowner) as owner, c.relname as name
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r','S','v','m','p','i')
     union all
     select pg_get_userbyid(p.proowner), p.proname from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
     union all
     select pg_get_userbyid(n.nspowner), n.nspname from pg_namespace n where n.nspname = 'public'
     order by 1, 2`,
  );
  const owned = new Map<string, string[]>();
  for (const row of ownedRows) {
    const owner = String(row.owner);
    owned.set(owner, [...(owned.get(owner) ?? []), String(row.name)]);
  }

  const schemaRows = await query(
    `select g.grantee as grantee
       from (values ${valuesList(NAMED_ROLES)}) as g(grantee)
       where exists (select 1 from pg_roles where rolname = g.grantee)
         and has_schema_privilege(g.grantee, 'public', 'USAGE')
     union all
     select 'PUBLIC' from pg_namespace n,
       lateral aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
       where n.nspname = 'public' and a.grantee = 0 and a.privilege_type = 'USAGE'`,
  );
  const schemaUsage = new Set(schemaRows.map((row) => String(row.grantee)));

  const sequenceRows = await query(
    `select g.grantee as grantee, c.relname as name
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       cross join (values ${valuesList(NAMED_ROLES)}) as g(grantee)
       where n.nspname = 'public' and c.relkind = 'S'
         and exists (select 1 from pg_roles where rolname = g.grantee)
         and (${SEQUENCE_PRIVILEGES.map((privilege) => `has_sequence_privilege(g.grantee, c.oid, ${literal(privilege)})`).join(" or ")})
     union all
     select 'PUBLIC', c.relname from pg_class c
       join pg_namespace n on n.oid = c.relnamespace,
       lateral aclexplode(coalesce(c.relacl, acldefault('S', c.relowner))) a
       where n.nspname = 'public' and c.relkind = 'S' and a.grantee = 0
     order by 1, 2`,
  );
  const sequences = new Map<string, string[]>();
  for (const row of sequenceRows) {
    const grantee = String(row.grantee);
    sequences.set(grantee, [...(sequences.get(grantee) ?? []), String(row.name)]);
  }

  const routineRows = await query(
    `select g.grantee as grantee, p.proname as name
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       cross join (values ${valuesList(NAMED_ROLES)}) as g(grantee)
       where n.nspname = 'public'
         and exists (select 1 from pg_roles where rolname = g.grantee)
         and has_function_privilege(g.grantee, p.oid, 'EXECUTE')
     union all
     select 'PUBLIC', p.proname from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace,
       lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       where n.nspname = 'public' and a.grantee = 0 and a.privilege_type = 'EXECUTE'
     order by 1, 2`,
  );
  const routines = new Map<string, string[]>();
  for (const row of routineRows) {
    const grantee = String(row.grantee);
    routines.set(grantee, [...(routines.get(grantee) ?? []), String(row.name)]);
  }

  return { tables, policies, grants, explicitGrantRecords, roles, owned, schemaUsage, sequences, routines };
}

/**
 * One coherent read-only observation of a catalogue, presented through the
 * shared containment predicates.
 */
export async function createSqlCatalogueSource(
  rawQuery: SqlQuery,
  label: string,
): Promise<CatalogueSource> {
  const snapshot = await loadSnapshot(readOnly(rawQuery));
  return {
    label,
    async tableExists(table) {
      return snapshot.tables.has(table);
    },
    async rlsEnabled(table) {
      return snapshot.tables.get(table) === true;
    },
    async policiesOn(table) {
      return snapshot.policies.get(table) ?? [];
    },
    async tableGrants(table, grantee) {
      return [...(snapshot.grants.get(`${table} ${grantee}`) ?? [])].sort();
    },
    async roleAttributes(role) {
      return snapshot.roles.get(role) ?? null;
    },
    async ownedObjects(role) {
      return snapshot.owned.get(role) ?? [];
    },
    async listTables() {
      return [...snapshot.tables.keys()].sort();
    },
    async listPolicies() {
      return [...snapshot.policies.entries()]
        .flatMap(([table, policies]) => policies.map((policy) => ({ ...policy, table })))
        .sort((a, b) => `${a.table}.${a.name}`.localeCompare(`${b.table}.${b.name}`));
    },
    async listRuntimeGrantPairs() {
      const pairs: string[] = [];
      for (const [key, privileges] of snapshot.grants) {
        const [table, grantee] = key.split(" ");
        if (grantee !== RUNTIME_ROLE) continue;
        for (const privilege of privileges) pairs.push(`${table}:${privilege}`);
      }
      return pairs.sort();
    },
    async listExplicitGrantRecords() {
      return snapshot.explicitGrantRecords;
    },
    async effectiveAccess(role, accessClass: AccessClass) {
      const usable = snapshot.schemaUsage.has(role);
      if (accessClass === "schema") return usable ? ["public"] : [];
      // Without USAGE on the schema no object inside it is reachable, whatever
      // the object ACL says. That is exactly what makes the surviving
      // default-ACL rows residual risk rather than live exposure.
      if (!usable) return [];
      if (accessClass === "tables") {
        return [...snapshot.tables.keys()].filter(
          (table) => (snapshot.grants.get(`${table} ${role}`)?.size ?? 0) > 0,
        );
      }
      if (accessClass === "sequences") return snapshot.sequences.get(role) ?? [];
      return snapshot.routines.get(role) ?? [];
    },
  };
}

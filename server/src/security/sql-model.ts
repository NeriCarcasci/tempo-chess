/**
 * A deterministic model of what 0011 does to a catalogue.
 *
 * The migration gate has to prove the containment shape without a database, so
 * it replays the exact committed SQL against a production-shaped pre-0011
 * catalogue fixture and asserts the resulting state. That is only trustworthy if
 * the replay refuses to guess: every statement form in 0011 is recognised
 * explicitly, and anything unrecognised throws rather than being ignored. A
 * silent no-op here would turn "the migration does nothing" into a pass.
 *
 * The rehearsal proves the same predicates against a real Postgres. This model
 * is the deterministic half, not a replacement for it.
 */

export type PrivilegeName =
  | "SELECT"
  | "INSERT"
  | "UPDATE"
  | "DELETE"
  | "TRUNCATE"
  | "REFERENCES"
  | "TRIGGER"
  | "USAGE"
  | "CREATE"
  | "EXECUTE";

export interface RoleAttributes {
  rolcanlogin: boolean;
  rolinherit: boolean;
  rolsuper: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolbypassrls: boolean;
}

export interface ModelPolicy {
  name: string;
  table: string;
  roles: string[];
  command: string;
  permissive: boolean;
  qual: string;
  withCheck: string;
}

export interface DefaultAcl {
  grantor: string;
  objectType: "tables" | "sequences" | "functions";
  grantee: string;
  privileges: PrivilegeName[];
}

export interface CatalogueFixture {
  label: string;
  provenance: string;
  schema: string;
  /**
   * Grantors whose default privileges the migration executor can actually
   * alter. 0011 wraps each `alter default privileges` in an
   * `insufficient_privilege` handler because Supabase-owned superuser grantors
   * cannot be altered; modelling that skip is what stops the replay from
   * claiming containment the migration does not achieve.
   */
  alterableDefaultAclGrantors: string[];
  alterableDefaultAclNote?: string;
  roles: Record<string, RoleAttributes>;
  tables: Array<{ name: string; rls: boolean; owner: string }>;
  sequences: string[];
  routines: string[];
  schemaPrivileges: Record<string, PrivilegeName[]>;
  tablePrivileges: Record<string, PrivilegeName[]>;
  sequencePrivileges: Record<string, PrivilegeName[]>;
  routinePrivileges: Record<string, PrivilegeName[]>;
  defaultAcls: DefaultAcl[];
  policies: ModelPolicy[];
}

type PrivilegeSet = Set<PrivilegeName>;

function key(object: string, grantee: string): string {
  return `${object} ${grantee}`;
}

export class Catalogue {
  readonly schema: string;
  readonly roles = new Map<string, RoleAttributes>();
  readonly tables = new Map<string, { rls: boolean; owner: string }>();
  readonly sequences: string[];
  readonly routines: string[];
  /** grantee to privileges on the schema itself. */
  readonly schemaPrivileges = new Map<string, PrivilegeSet>();
  readonly tablePrivileges = new Map<string, PrivilegeSet>();
  readonly sequencePrivileges = new Map<string, PrivilegeSet>();
  readonly routinePrivileges = new Map<string, PrivilegeSet>();
  readonly defaultAcls: DefaultAcl[];
  readonly policies: ModelPolicy[];
  readonly alterableDefaultAclGrantors: ReadonlySet<string>;
  /** Statement forms the replay recognised, in order. Used as replay evidence. */
  readonly applied: string[] = [];
  /** Default-ACL grantors 0011 could not alter, and so left in place. */
  readonly skippedDefaultAclGrantors = new Set<string>();

  constructor(fixture: CatalogueFixture) {
    this.schema = fixture.schema;
    this.alterableDefaultAclGrantors = new Set(fixture.alterableDefaultAclGrantors);
    for (const [name, attributes] of Object.entries(fixture.roles)) {
      this.roles.set(name, { ...attributes });
    }
    for (const table of fixture.tables) {
      this.tables.set(table.name, { rls: table.rls, owner: table.owner });
    }
    this.sequences = [...fixture.sequences];
    this.routines = [...fixture.routines];
    for (const [grantee, privileges] of Object.entries(fixture.schemaPrivileges)) {
      this.schemaPrivileges.set(grantee, new Set(privileges));
    }
    // The fixture states one browser-role privilege list that applied to every
    // legacy table, which is how the audit recorded the exposure.
    for (const [grantee, privileges] of Object.entries(fixture.tablePrivileges)) {
      for (const table of this.tables.keys()) {
        this.tablePrivileges.set(key(table, grantee), new Set(privileges));
      }
    }
    for (const [grantee, privileges] of Object.entries(fixture.sequencePrivileges)) {
      for (const sequence of this.sequences) {
        this.sequencePrivileges.set(key(sequence, grantee), new Set(privileges));
      }
    }
    for (const [grantee, privileges] of Object.entries(fixture.routinePrivileges)) {
      for (const routine of this.routines) {
        this.routinePrivileges.set(key(routine, grantee), new Set(privileges));
      }
    }
    this.defaultAcls = fixture.defaultAcls.map((acl) => ({
      ...acl,
      privileges: [...acl.privileges],
    }));
    this.policies = fixture.policies.map((policy) => ({ ...policy, roles: [...policy.roles] }));
  }

  tableGrants(table: string, grantee: string): PrivilegeName[] {
    return [...(this.tablePrivileges.get(key(table, grantee)) ?? [])].sort();
  }

  schemaGrants(grantee: string): PrivilegeName[] {
    return [...(this.schemaPrivileges.get(grantee) ?? [])].sort();
  }

  sequenceGrants(grantee: string): PrivilegeName[] {
    const held = new Set<PrivilegeName>();
    for (const sequence of this.sequences) {
      for (const privilege of this.sequencePrivileges.get(key(sequence, grantee)) ?? []) {
        held.add(privilege);
      }
    }
    return [...held].sort();
  }

  routineGrants(grantee: string): PrivilegeName[] {
    const held = new Set<PrivilegeName>();
    for (const routine of this.routines) {
      for (const privilege of this.routinePrivileges.get(key(routine, grantee)) ?? []) {
        held.add(privilege);
      }
    }
    return [...held].sort();
  }

  policiesOn(table: string): ModelPolicy[] {
    return this.policies.filter((policy) => policy.table === table);
  }

  defaultAclsFor(grantee: string): DefaultAcl[] {
    return this.defaultAcls.filter((acl) => acl.grantee === grantee && acl.privileges.length > 0);
  }
}

export const ALL_TABLE_PRIVILEGES: PrivilegeName[] = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
];

/** Split the committed migration into statements on its own breakpoint marker. */
export function splitStatements(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => stripComments(statement).trim())
    .filter((statement) => statement.length > 0);
}

function stripComments(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

function parseGrantees(list: string): string[] {
  return list
    .split(",")
    .map((entry) => entry.trim().replace(/;$/, ""))
    .filter((entry) => entry.length > 0)
    .map((entry) => (entry.toLowerCase() === "public" ? "PUBLIC" : entry));
}

function parsePrivileges(list: string): PrivilegeName[] {
  return list
    .split(",")
    .map((entry) => entry.trim().toUpperCase())
    .filter((entry) => entry.length > 0) as PrivilegeName[];
}

function bare(table: string): string {
  return table.replace(/^public\./, "");
}

export class UnrecognisedStatement extends Error {
  constructor(statement: string) {
    super(`0011 replay refused an unrecognised statement: ${statement.slice(0, 120)}`);
    this.name = "UnrecognisedStatement";
  }
}

function expectSchema(catalogue: Catalogue, schema: string): void {
  if (schema !== catalogue.schema) {
    throw new Error(
      `0011 replay saw schema "${schema}" but the fixture models "${catalogue.schema}"`,
    );
  }
}

function requireTable(catalogue: Catalogue, name: string): { rls: boolean; owner: string } {
  const table = catalogue.tables.get(name);
  if (!table) throw new Error(`0011 replay referenced unknown table ${name}`);
  return table;
}

function revokeAll(catalogue: Catalogue, objectType: string, grantee: string): void {
  if (objectType === "tables") {
    for (const table of catalogue.tables.keys()) {
      catalogue.tablePrivileges.set(key(table, grantee), new Set());
    }
    return;
  }
  if (objectType === "sequences") {
    for (const sequence of catalogue.sequences) {
      catalogue.sequencePrivileges.set(key(sequence, grantee), new Set());
    }
    return;
  }
  // "functions" and "routines" name the same objects in Postgres; 0011 issues
  // both spellings so the revoke survives either.
  for (const routine of catalogue.routines) {
    catalogue.routinePrivileges.set(key(routine, grantee), new Set());
  }
}

function applyDoBlock(catalogue: Catalogue, sql: string): void {
  // create role <name> with login noinherit nosuperuser nocreatedb nocreaterole nobypassrls
  let match =
    /create role (\w+) with login noinherit nosuperuser nocreatedb nocreaterole nobypassrls/i.exec(
      sql,
    );
  if (match) {
    const name = match[1];
    if (!catalogue.roles.has(name)) {
      catalogue.roles.set(name, {
        rolcanlogin: true,
        rolinherit: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolbypassrls: false,
      });
    }
    catalogue.applied.push("create-role");
    return;
  }

  match = /alter role (\w+) nosuperuser nocreatedb nocreaterole nobypassrls/i.exec(sql);
  if (match) {
    const role = catalogue.roles.get(match[1]);
    if (role) {
      role.rolsuper = false;
      role.rolcreatedb = false;
      role.rolcreaterole = false;
      role.rolbypassrls = false;
    }
    catalogue.applied.push("alter-role");
    return;
  }

  match =
    /alter default privileges for role (\w+) in schema (\w+) revoke all on (tables|sequences|functions) from ([^']+)/i.exec(
      sql,
    );
  if (match) {
    const [, grantor, schema, objectType, granteeList] = match;
    expectSchema(catalogue, schema);
    if (!catalogue.alterableDefaultAclGrantors.has(grantor)) {
      // The migration's insufficient_privilege handler swallows this, so the
      // grantor's rows survive. Recorded, not silently dropped.
      catalogue.skippedDefaultAclGrantors.add(grantor);
      catalogue.applied.push("alter-default-privileges-skipped");
      return;
    }
    const revoked = new Set(parseGrantees(granteeList));
    for (const acl of catalogue.defaultAcls) {
      if (acl.grantor === grantor && acl.objectType === objectType && revoked.has(acl.grantee)) {
        acl.privileges = [];
      }
    }
    catalogue.applied.push("alter-default-privileges");
    return;
  }

  // The loop that grants every existing sequence to the runtime role.
  match = /grant usage, select on sequence [^ ]+ to (\w+)/i.exec(sql);
  if (match) {
    const grantee = match[1];
    for (const sequence of catalogue.sequences) {
      const held =
        catalogue.sequencePrivileges.get(key(sequence, grantee)) ?? new Set<PrivilegeName>();
      held.add("USAGE");
      held.add("SELECT");
      catalogue.sequencePrivileges.set(key(sequence, grantee), held);
    }
    catalogue.applied.push("grant-sequences-loop");
    return;
  }

  throw new UnrecognisedStatement(sql);
}

/**
 * Apply one statement. Every branch is an exact form taken from the committed
 * 0011; the anonymous blocks are matched on their body, because that is where
 * their effect lives.
 */
export function applyStatement(catalogue: Catalogue, statement: string): void {
  const sql = statement.replace(/\s+/g, " ").trim();
  const lower = sql.toLowerCase();

  if (/^comment on (role|table|policy|column|schema) /i.test(sql)) {
    catalogue.applied.push("comment");
    return;
  }

  if (lower.startsWith("do $$")) {
    applyDoBlock(catalogue, sql);
    return;
  }

  let match =
    /^revoke all on all (tables|sequences|functions|routines) in schema (\w+) from (.+)$/i.exec(sql);
  if (match) {
    const [, objectType, schema, granteeList] = match;
    expectSchema(catalogue, schema);
    for (const grantee of parseGrantees(granteeList)) {
      revokeAll(catalogue, objectType.toLowerCase(), grantee);
    }
    catalogue.applied.push(`revoke-all-${objectType.toLowerCase()}`);
    return;
  }

  match = /^revoke all on schema (\w+) from (.+)$/i.exec(sql);
  if (match) {
    expectSchema(catalogue, match[1]);
    for (const grantee of parseGrantees(match[2])) {
      catalogue.schemaPrivileges.set(grantee, new Set());
    }
    catalogue.applied.push("revoke-schema");
    return;
  }

  match = /^grant (.+) on schema (\w+) to (.+)$/i.exec(sql);
  if (match) {
    expectSchema(catalogue, match[2]);
    const privileges = parsePrivileges(match[1]);
    for (const grantee of parseGrantees(match[3])) {
      const held = catalogue.schemaPrivileges.get(grantee) ?? new Set<PrivilegeName>();
      for (const privilege of privileges) held.add(privilege);
      catalogue.schemaPrivileges.set(grantee, held);
    }
    catalogue.applied.push("grant-schema");
    return;
  }

  match = /^alter table ([\w.]+) enable row level security$/i.exec(sql);
  if (match) {
    requireTable(catalogue, bare(match[1])).rls = true;
    catalogue.applied.push("enable-rls");
    return;
  }

  match = /^drop policy if exists (\w+) on ([\w.]+)$/i.exec(sql);
  if (match) {
    const [, name, tableRef] = match;
    const table = bare(tableRef);
    requireTable(catalogue, table);
    for (let index = catalogue.policies.length - 1; index >= 0; index -= 1) {
      const policy = catalogue.policies[index];
      if (policy.name === name && policy.table === table) catalogue.policies.splice(index, 1);
    }
    catalogue.applied.push("drop-policy");
    return;
  }

  match = /^grant (.+) on ([\w.]+) to (.+)$/i.exec(sql);
  if (match) {
    const table = bare(match[2]);
    requireTable(catalogue, table);
    const privileges = parsePrivileges(match[1]);
    for (const grantee of parseGrantees(match[3])) {
      const held = catalogue.tablePrivileges.get(key(table, grantee)) ?? new Set<PrivilegeName>();
      for (const privilege of privileges) held.add(privilege);
      catalogue.tablePrivileges.set(key(table, grantee), held);
    }
    catalogue.applied.push("grant-table");
    return;
  }

  match =
    /^create policy (\w+) on ([\w.]+) as (permissive|restrictive) for (\w+) to (.+?) using \((.+?)\) with check \((.+?)\)$/i.exec(
      sql,
    );
  if (match) {
    const [, name, tableRef, permissive, command, roleList, qual, withCheck] = match;
    const table = bare(tableRef);
    requireTable(catalogue, table);
    catalogue.policies.push({
      name,
      table,
      roles: parseGrantees(roleList),
      command: command.toUpperCase(),
      permissive: permissive.toLowerCase() === "permissive",
      qual: qual.trim(),
      withCheck: withCheck.trim(),
    });
    catalogue.applied.push("create-policy");
    return;
  }

  throw new UnrecognisedStatement(statement);
}

/** Replay the whole migration once. */
export function applyMigration(fixture: CatalogueFixture, sql: string): Catalogue {
  const catalogue = new Catalogue(fixture);
  for (const statement of splitStatements(sql)) {
    applyStatement(catalogue, statement);
  }
  return catalogue;
}

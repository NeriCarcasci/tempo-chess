/**
 * One set of containment predicates, three places to evaluate them.
 *
 * The migration gate evaluates them against a deterministic replay of 0011, the
 * rehearsal against a disposable Postgres, and the production gate against the
 * live catalogue over a read-only administrative path. Writing the predicates
 * once is the point: if "the runtime role holds exactly these 54 grants" means
 * something slightly different in each gate, three green gates prove nothing.
 *
 * Every source here is read-only. Nothing in this module writes.
 */

import {
  CONTAINED_TABLES,
  DENIED_ROLES,
  MIGRATOR_ROLE,
  POLICY_SHAPE,
  ROLE_ATTRIBUTES,
  POLICY_TABLES,
  RUNTIME_GRANTS,
  RUNTIME_GRANT_PAIRS,
  RUNTIME_ROLE,
  policyName,
  type AccessClass,
  type Privilege,
} from "./contract.js";
import type { AssertionBody } from "./assertions.js";
import type { RoleAttributes } from "./sql-model.js";

export interface ObservedPolicy {
  name: string;
  roles: string[];
  command: string;
  permissive: boolean;
  qual: string;
  withCheck: string;
}

/** The read-only surface a gate needs to judge containment. */
export interface CatalogueSource {
  /** Human label used in evidence detail. Deterministic for deterministic gates. */
  readonly label: string;
  /**
   * Which allowlist "exactly the contained tables" means for this source.
   *
   * Two sources answer that differently and both are right. A live database
   * must hold today's `CONTAINED_TABLES`. A replay of 0011 against the pre-0011
   * fixture reconstructs what `public` held *at 0011*, and 0042 has not been
   * applied to it — judging that reconstruction against today's list asks a
   * migration from the past to have anticipated a migration from the future.
   * Left unset it is today's list, so only the replay has to say otherwise.
   */
  readonly expectedTables?: readonly string[];
  tableExists(table: string): Promise<boolean>;
  rlsEnabled(table: string): Promise<boolean>;
  policiesOn(table: string): Promise<ObservedPolicy[]>;
  /** Privileges `grantee` holds on `table`, upper-case and sorted. */
  tableGrants(table: string, grantee: string): Promise<string[]>;
  roleAttributes(role: string): Promise<RoleAttributes | null>;
  /** Objects in `public` owned by `role`. Empty is the only acceptable answer. */
  ownedObjects(role: string): Promise<string[]>;
  /** Reachable things for `role` in the given class. Empty means contained. */
  effectiveAccess(role: string, accessClass: AccessClass): Promise<string[]>;

  // --- enumeration ---------------------------------------------------------
  //
  // Asking "does this expected thing exist?" proves the contract is a subset of
  // reality. It cannot see an extra table, an extra policy, or a grant the
  // contract never named — and an unnoticed extra grant is exactly the shape a
  // containment regression takes. These three enumerate, so exactness can be
  // asserted rather than assumed.

  /** Every table-privilege-bearing relation in `public`. */
  listTables(): Promise<string[]>;
  /** Every policy in `public`, whichever table it is on. */
  listPolicies(): Promise<Array<ObservedPolicy & { table: string }>>;
  /** Every `table:PRIVILEGE` the runtime role holds anywhere in `public`. */
  listRuntimeGrantPairs(): Promise<string[]>;
  /** Every explicit table/column ACL entry, including grantability. */
  listExplicitGrantRecords(): Promise<string[]>;
}

function fail(message: string): never {
  throw new Error(message);
}

/**
 * Set difference reported both ways. "Missing" and "unexpected" are different
 * failures and a reviewer needs to see which one happened.
 */
function difference(actual: readonly string[], expected: readonly string[]) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return {
    missing: [...expectedSet].filter((value) => !actualSet.has(value)).sort(),
    unexpected: [...actualSet].filter((value) => !expectedSet.has(value)).sort(),
  };
}

/**
 * The three exactness checks, each computed once per source and shared by every
 * assertion that folds it in. They are cached per source object rather than per
 * call so that folding exactness into 95 frozen assertion bodies does not turn
 * into 95 full catalogue comparisons.
 */
const exactnessCache = new WeakMap<CatalogueSource, Map<string, Promise<void>>>();

function once(source: CatalogueSource, key: string, check: () => Promise<void>): Promise<void> {
  let perSource = exactnessCache.get(source);
  if (!perSource) {
    perSource = new Map();
    exactnessCache.set(source, perSource);
  }
  let pending = perSource.get(key);
  if (!pending) {
    pending = check();
    perSource.set(key, pending);
  }
  return pending;
}

/** The catalogue holds exactly its own contained tables and nothing else. */
export function assertExactTables(source: CatalogueSource): Promise<void> {
  return once(source, "tables", async () => {
    const expected = source.expectedTables ?? CONTAINED_TABLES;
    const { missing, unexpected } = difference(await source.listTables(), expected);
    if (missing.length > 0 || unexpected.length > 0) {
      fail(
        `public holds ${unexpected.length} unlisted table(s) [${unexpected.slice(0, 5).join(", ")}] and is missing ${missing.length} [${missing.slice(0, 5).join(", ")}]`,
      );
    }
  });
}

/** Exactly 19 policies exist, one per policy table, each with the frozen name. */
export function assertExactPolicies(source: CatalogueSource): Promise<void> {
  return once(source, "policies", async () => {
    const policies = await source.listPolicies();
    const observed = policies.map((policy) => `${policy.table}.${policy.name}`);
    const expected = POLICY_TABLES.map((table) => `${table}.${policyName(table)}`);
    const { missing, unexpected } = difference(observed, expected);
    if (missing.length > 0 || unexpected.length > 0) {
      fail(
        `public holds ${unexpected.length} unlisted policy/policies [${unexpected.slice(0, 5).join(", ")}] and is missing ${missing.length} [${missing.slice(0, 5).join(", ")}]`,
      );
    }
    if (policies.length !== POLICY_TABLES.length) {
      fail(`public holds ${policies.length} policies, contract froze ${POLICY_TABLES.length}`);
    }
  });
}

/** The runtime role holds exactly the 54 frozen `table:PRIVILEGE` pairs. */
export function assertExactRuntimeGrants(source: CatalogueSource): Promise<void> {
  return once(source, "grants", async () => {
    const runtimePairs = await source.listRuntimeGrantPairs();
    const { missing, unexpected } = difference(runtimePairs, RUNTIME_GRANT_PAIRS);
    if (missing.length > 0 || unexpected.length > 0) {
      fail(
        `${RUNTIME_ROLE} holds ${unexpected.length} unlisted grant(s) [${unexpected.slice(0, 5).join(", ")}] and is missing ${missing.length} [${missing.slice(0, 5).join(", ")}]`,
      );
    }
    const expectedRecords = RUNTIME_GRANT_PAIRS.map(
      (pair) => `table:${pair}:${RUNTIME_ROLE}:grantable=false`,
    );
    const records = await source.listExplicitGrantRecords();
    const recordDifference = difference(records, expectedRecords);
    if (recordDifference.missing.length > 0 || recordDifference.unexpected.length > 0) {
      fail(
        `public ACLs hold ${recordDifference.unexpected.length} unlisted explicit grant(s) [${recordDifference.unexpected.slice(0, 5).join(", ")}] and are missing ${recordDifference.missing.length} [${recordDifference.missing.slice(0, 5).join(", ")}]`,
      );
    }
  });
}

function sortedEqual(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  const a = [...actual].sort();
  const b = [...expected].sort();
  return a.every((value, index) => value === b[index]);
}

/** The table exists and row level security is on. Existence is proven first. */
export function tableRlsBody(source: CatalogueSource, table: string): AssertionBody {
  return async () => {
    await assertExactTables(source);
    if (!(await source.tableExists(table))) fail(`public.${table} does not exist`);
    if (!(await source.rlsEnabled(table))) fail(`public.${table} has relrowsecurity=false`);
    const listed = (source.expectedTables ?? CONTAINED_TABLES).length;
    return `public.${table} exists, relrowsecurity=true; public holds exactly the ${listed} contained tables`;
  };
}

/** Exactly one containment policy, with the exact frozen shape. */
export function policyBody(source: CatalogueSource, table: string): AssertionBody {
  const expected = policyName(table);
  return async () => {
    await assertExactPolicies(source);
    if (!(await source.tableExists(table))) fail(`public.${table} does not exist`);
    const policies = await source.policiesOn(table);
    if (policies.length !== 1) {
      fail(`public.${table} has ${policies.length} policies, contract requires exactly 1`);
    }
    const policy = policies[0];
    if (policy.name !== expected) fail(`policy is named ${policy.name}, expected ${expected}`);
    if (!sortedEqual(policy.roles, POLICY_SHAPE.roles)) {
      fail(`policy roles are {${policy.roles.join(",")}}, expected {${POLICY_SHAPE.roles.join(",")}}`);
    }
    if (policy.command !== POLICY_SHAPE.command) {
      fail(`policy command is ${policy.command}, expected ${POLICY_SHAPE.command}`);
    }
    if (policy.permissive !== POLICY_SHAPE.permissive) fail("policy is not permissive");
    if (policy.qual !== POLICY_SHAPE.qual) fail(`policy qual is ${policy.qual}, expected true`);
    if (policy.withCheck !== POLICY_SHAPE.withCheck) {
      fail(`policy with_check is ${policy.withCheck}, expected true`);
    }
    return `${expected} roles={${POLICY_SHAPE.roles.join(",")}} ALL permissive using(true) with check(true); public holds exactly 19 policies`;
  };
}

/**
 * The runtime role holds this privilege, the browser roles hold nothing on the
 * table, and the runtime role holds no privilege the contract did not name.
 */
export function grantBody(
  source: CatalogueSource,
  table: string,
  privilege: Privilege,
): AssertionBody {
  const allowed = RUNTIME_GRANTS[table] ?? [];
  return async () => {
    await assertExactRuntimeGrants(source);
    if (!(await source.tableExists(table))) fail(`public.${table} does not exist`);
    const held = await source.tableGrants(table, RUNTIME_ROLE);
    if (!held.includes(privilege)) {
      fail(`${RUNTIME_ROLE} lacks ${privilege} on public.${table}`);
    }
    const unlisted = held.filter((granted) => !(allowed as readonly string[]).includes(granted));
    if (unlisted.length > 0) {
      fail(`${RUNTIME_ROLE} holds unlisted ${unlisted.join(",")} on public.${table}`);
    }
    for (const denied of DENIED_ROLES) {
      const deniedHeld = await source.tableGrants(table, denied);
      if (deniedHeld.length > 0) {
        fail(`${denied} holds ${deniedHeld.join(",")} on public.${table}`);
      }
    }
    return `${RUNTIME_ROLE} has ${privilege} on public.${table}; browser roles hold nothing; ${RUNTIME_ROLE} holds exactly the 54 frozen grants`;
  };
}

/** A table the runtime role must not reach at all. */
export function denialBody(source: CatalogueSource, table: string): AssertionBody {
  return async () => {
    await assertExactTables(source);
    await assertExactPolicies(source);
    await assertExactRuntimeGrants(source);
    if (!(await source.tableExists(table))) fail(`public.${table} does not exist`);
    // Every privilege, for every role this gate observes — not just the runtime
    // role's, and not just the ones the contract happens to name elsewhere.
    for (const role of [RUNTIME_ROLE, MIGRATOR_ROLE, ...DENIED_ROLES]) {
      const held = await source.tableGrants(table, role);
      if (held.length > 0) {
        fail(`${role} unexpectedly holds ${held.join(",")} on public.${table}`);
      }
    }
    const policies = await source.policiesOn(table);
    if (policies.length > 0) {
      fail(
        `public.${table} carries ${policies.length} policy/policies [${policies.map((policy) => policy.name).join(", ")}]; the contract allows none`,
      );
    }
    return `no role holds any privilege and no policy of any kind exists on public.${table}`;
  };
}

/** The frozen role attributes. Any drift is a hard failure. */
export function roleAttributesBody(source: CatalogueSource, role: string): AssertionBody {
  return async () => {
    const attributes = await source.roleAttributes(role);
    if (!attributes) fail(`role ${role} does not exist`);
    const drift = (Object.keys(ROLE_ATTRIBUTES) as Array<keyof typeof ROLE_ATTRIBUTES>).filter(
      (key) => attributes[key] !== ROLE_ATTRIBUTES[key],
    );
    if (drift.length > 0) {
      fail(`${role} attribute drift: ${drift.map((key) => `${key}=${attributes[key]}`).join(", ")}`);
    }
    return `${role} rolcanlogin=true rolinherit=false rolsuper=false rolcreatedb=false rolcreaterole=false rolbypassrls=false`;
  };
}

/** The runtime role owns nothing, so it cannot grant itself anything later. */
export function ownershipBody(source: CatalogueSource, role: string): AssertionBody {
  return async () => {
    const owned = await source.ownedObjects(role);
    if (owned.length > 0) {
      fail(`${role} owns ${owned.length} object(s) in public: ${owned.slice(0, 5).join(", ")}`);
    }
    return `${role} owns no table, sequence, routine, or schema in public`;
  };
}

/** Zero effective access for a browser role, in one object class. */
export function effectiveAccessBody(
  source: CatalogueSource,
  role: string,
  accessClass: AccessClass,
): AssertionBody {
  return async () => {
    const reachable = await source.effectiveAccess(role, accessClass);
    if (reachable.length > 0) {
      fail(
        `${role} retains effective ${accessClass} access in public: ${reachable.slice(0, 5).join(", ")}`,
      );
    }
    return `${role} has zero effective ${accessClass} access in public`;
  };
}

/**
 * `forma_migrator` is frozen in 0011 but inert in E01. Inertness is a property of
 * the repository, not the database: no credential, no client, no job, no
 * executable path may exist on this branch.
 */
export function migratorInertnessBody(
  scanRepository: () => Promise<string[]>,
  extra?: () => Promise<string[]>,
): AssertionBody {
  return async () => {
    const hits = await scanRepository();
    if (hits.length > 0) {
      fail(`${MIGRATOR_ROLE} has an operational path: ${hits.slice(0, 5).join(", ")}`);
    }
    const live = extra ? await extra() : [];
    if (live.length > 0) {
      fail(`${MIGRATOR_ROLE} is not inert: ${live.slice(0, 5).join(", ")}`);
    }
    return `${MIGRATOR_ROLE} has no committed credential, runtime client, job, or executable operational path${
      extra ? " and no active session" : ""
    }`;
  };
}

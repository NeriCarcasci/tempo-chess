/**
 * Turn manifest records into catalogue assertion bodies.
 *
 * The manifest's `target` field is the binding between an assertion ID and the
 * thing it judges, so it is parsed rather than re-derived: that is what
 * guarantees `MIG-GRT-017` checks the privilege the inventory says it checks,
 * in every gate, for all three catalogue sources.
 */

import type { AssertionBody, AssertionRecord } from "../assertions.js";
import {
  denialBody,
  effectiveAccessBody,
  grantBody,
  migratorInertnessBody,
  ownershipBody,
  policyBody,
  roleAttributesBody,
  tableRlsBody,
  type CatalogueSource,
} from "../catalogue.js";
import {
  ACCESS_CLASSES,
  CONTAINED_TABLES,
  MIGRATOR_ROLE,
  RUNTIME_ROLE,
  policyName,
  type AccessClass,
  type Privilege,
} from "../contract.js";

function knownTable(name: string): string {
  if (!(CONTAINED_TABLES as readonly string[]).includes(name)) {
    throw new Error(`manifest target names ${name}, which is not one of the 22 contained tables`);
  }
  return name;
}

/** `public.games` */
function parseTableTarget(target: string): string {
  const match = /^public\.([a-z_]+)$/.exec(target);
  if (!match) throw new Error(`cannot parse table target "${target}"`);
  return knownTable(match[1]);
}

/** `public.games.games_forma_api_service_dataplane` */
function parsePolicyTarget(target: string): string {
  const match = /^public\.([a-z_]+)\.([a-z_]+)$/.exec(target);
  if (!match) throw new Error(`cannot parse policy target "${target}"`);
  const table = knownTable(match[1]);
  if (match[2] !== policyName(table)) {
    throw new Error(`manifest policy target "${target}" does not use the frozen policy name`);
  }
  return table;
}

/** `public.games:INSERT` */
function parseGrantTarget(target: string): { table: string; privilege: Privilege } {
  const match = /^public\.([a-z_]+):(SELECT|INSERT|UPDATE|DELETE)$/.exec(target);
  if (!match) throw new Error(`cannot parse grant target "${target}"`);
  return { table: knownTable(match[1]), privilege: match[2] as Privilege };
}

/** `anon:tables` */
function parseAccessTarget(target: string): { role: string; accessClass: AccessClass } {
  const match = /^(PUBLIC|anon|authenticated):(schema|tables|sequences|routines)$/.exec(target);
  if (!match) throw new Error(`cannot parse effective-access target "${target}"`);
  const accessClass = match[2] as AccessClass;
  if (!ACCESS_CLASSES.includes(accessClass)) {
    throw new Error(`unknown access class in "${target}"`);
  }
  return { role: match[1], accessClass };
}

export interface RolePostureHooks {
  /** Repository scan proving `forma_migrator` has no executable operational path. */
  scanMigratorPaths: () => Promise<string[]>;
  /** Optional live check, used only where the manifest asks for session metadata. */
  liveMigratorSessions?: () => Promise<string[]>;
}

/**
 * Build the body for one catalogue-shaped record, or return `undefined` when the
 * category belongs to a different family of assertions.
 */
export function catalogueBody(
  record: AssertionRecord,
  source: CatalogueSource,
  hooks: RolePostureHooks,
): AssertionBody | undefined {
  switch (record.category) {
    case "table-rls":
      return tableRlsBody(source, parseTableTarget(record.target));
    case "policy":
      return policyBody(source, parsePolicyTarget(record.target));
    case "runtime-grant": {
      const { table, privilege } = parseGrantTarget(record.target);
      return grantBody(source, table, privilege);
    }
    case "runtime-denial":
      return denialBody(source, parseTableTarget(record.target));
    case "effective-access":
    case "effective-browser-access": {
      const { role, accessClass } = parseAccessTarget(record.target);
      return effectiveAccessBody(source, role, accessClass);
    }
    case "role-posture":
      return rolePostureBody(record, source, hooks);
    default:
      return undefined;
  }
}

function rolePostureBody(
  record: AssertionRecord,
  source: CatalogueSource,
  hooks: RolePostureHooks,
): AssertionBody {
  switch (record.target) {
    case `${RUNTIME_ROLE} attributes`:
      return roleAttributesBody(source, RUNTIME_ROLE);
    case `${RUNTIME_ROLE} ownership`:
      return ownershipBody(source, RUNTIME_ROLE);
    case `${MIGRATOR_ROLE} attributes`:
      return roleAttributesBody(source, MIGRATOR_ROLE);
    case `${MIGRATOR_ROLE} inertness`:
      return migratorInertnessBody(hooks.scanMigratorPaths, hooks.liveMigratorSessions);
    default:
      throw new Error(`unknown role-posture target "${record.target}"`);
  }
}

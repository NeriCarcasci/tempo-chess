/**
 * `npm run security:migration` — 105 deterministic assertions.
 *
 * No database, no network, no clock. The gate hashes the two frozen artifacts,
 * checks the single journal addition, and replays the exact committed 0011
 * against the production-shaped pre-0011 fixture, then judges the resulting
 * catalogue with the same predicates the rehearsal and production gates use.
 *
 * Nothing here applies a migration to anything.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  assertionsFor,
  gateExitCode,
  loadManifest,
  runGate,
  type AssertionBody,
  type AssertionRecord,
} from "../assertions.js";
import {
  assertExactPolicies,
  assertExactRuntimeGrants,
  assertExactTables,
  type CatalogueSource,
  type ObservedPolicy,
} from "../catalogue.js";
import {
  JOURNAL_ENTRY,
  MIGRATION_ARTIFACTS,
  CONTAINED_TABLES,
  RUNTIME_ROLE,
  policyName,
} from "../contract.js";
import { applyMigration, type Catalogue, type CatalogueFixture, type RoleAttributes } from "../sql-model.js";
import { describeHits, repoRoot, scanMigratorOperationalPaths } from "../repo-scan.js";
import { catalogueBody } from "./catalogue-bodies.js";
import type { AccessClass } from "../contract.js";

const COMMAND = "cd server && npm run security:migration";
const FIXTURE_PATH = "server/src/security/fixtures/production-shaped-0010-catalogue.json";
const JOURNAL_PATH = "server/drizzle/meta/_journal.json";

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

/** Adapt the replayed model to the shared catalogue predicates. */
export function modelCatalogueSource(catalogue: Catalogue, label: string): CatalogueSource {
  return {
    label,
    async tableExists(table) {
      return catalogue.tables.has(table);
    },
    async rlsEnabled(table) {
      return catalogue.tables.get(table)?.rls === true;
    },
    async policiesOn(table): Promise<ObservedPolicy[]> {
      return catalogue.policiesOn(table).map((policy) => ({
        name: policy.name,
        roles: policy.roles,
        command: policy.command,
        permissive: policy.permissive,
        qual: policy.qual,
        withCheck: policy.withCheck,
      }));
    },
    async tableGrants(table, grantee) {
      return catalogue.tableGrants(table, grantee);
    },
    async roleAttributes(role): Promise<RoleAttributes | null> {
      return catalogue.roles.get(role) ?? null;
    },
    async ownedObjects(role) {
      const owned = [...catalogue.tables.entries()]
        .filter(([, table]) => table.owner === role)
        .map(([name]) => name);
      return owned;
    },
    async listTables() {
      return [...catalogue.tables.keys()].sort();
    },
    async listPolicies() {
      return catalogue.policies
        .map((policy) => ({
          name: policy.name,
          table: policy.table,
          roles: policy.roles,
          command: policy.command,
          permissive: policy.permissive,
          qual: policy.qual,
          withCheck: policy.withCheck,
        }))
        .sort((a, b) => `${a.table}.${a.name}`.localeCompare(`${b.table}.${b.name}`));
    },
    async listRuntimeGrantPairs() {
      const pairs: string[] = [];
      for (const table of catalogue.tables.keys()) {
        for (const privilege of catalogue.tableGrants(table, RUNTIME_ROLE)) {
          pairs.push(`${table}:${privilege}`);
        }
      }
      return pairs.sort();
    },
    async listExplicitGrantRecords() {
      const records: string[] = [];
      for (const table of catalogue.tables.keys()) {
        for (const privilege of catalogue.tableGrants(table, RUNTIME_ROLE)) {
          records.push(`table:${table}:${privilege}:${RUNTIME_ROLE}:grantable=false`);
        }
      }
      return records.sort();
    },
    async effectiveAccess(role, accessClass: AccessClass) {
      const schemaUsage = catalogue.schemaGrants(role).includes("USAGE");
      if (accessClass === "schema") return schemaUsage ? ["public"] : [];
      if (!schemaUsage) return [];
      if (accessClass === "tables") {
        return [...catalogue.tables.keys()].filter(
          (table) => catalogue.tableGrants(table, role).length > 0,
        );
      }
      if (accessClass === "sequences") {
        return catalogue.sequenceGrants(role).length > 0 ? [...catalogue.sequences] : [];
      }
      return catalogue.routineGrants(role).length > 0 ? [...catalogue.routines] : [];
    },
  };
}

function hashFile(root: string, relative: string): { bytes: number; sha256: string } {
  const raw = readFileSync(`${root}/${relative}`);
  return { bytes: raw.length, sha256: createHash("sha256").update(raw).digest("hex") };
}

/** The two artifact-integrity assertions, shared with the rehearsal gate. */
export function artifactBodies(root: string): Map<string, AssertionBody> {
  const bodies = new Map<string, AssertionBody>();
  for (const artifact of [MIGRATION_ARTIFACTS.sql, MIGRATION_ARTIFACTS.snapshot]) {
    bodies.set(artifact.path, async () => {
      const { bytes, sha256 } = hashFile(root, artifact.path);
      if (bytes !== artifact.bytes) {
        throw new Error(`${artifact.path} is ${bytes} bytes, contract froze ${artifact.bytes}`);
      }
      if (sha256 !== artifact.sha256) {
        throw new Error(`${artifact.path} hashes ${sha256}, contract froze ${artifact.sha256}`);
      }
      return `${artifact.path} ${bytes} bytes sha256=${sha256}`;
    });
  }
  return bodies;
}

/** The journal must gain exactly one entry, and it must be the frozen tuple. */
export function journalBody(root: string): AssertionBody {
  return async () => {
    const journal = JSON.parse(readFileSync(`${root}/${JOURNAL_PATH}`, "utf8")) as {
      entries: JournalEntry[];
    };
    const entries = journal.entries;
    const added = entries.filter((entry) => entry.idx >= 11);
    if (added.length !== 1) {
      throw new Error(
        `journal has ${added.length} entries at or beyond idx=11; E01 adds exactly one`,
      );
    }
    const entry = added[0];
    const drift: string[] = [];
    if (entry.idx !== JOURNAL_ENTRY.idx) drift.push(`idx=${entry.idx}`);
    if (entry.version !== JOURNAL_ENTRY.version) drift.push(`version=${entry.version}`);
    if (entry.when !== JOURNAL_ENTRY.when) drift.push(`when=${entry.when}`);
    if (entry.tag !== JOURNAL_ENTRY.tag) drift.push(`tag=${entry.tag}`);
    if (entry.breakpoints !== JOURNAL_ENTRY.breakpoints) {
      drift.push(`breakpoints=${entry.breakpoints}`);
    }
    if (drift.length > 0) throw new Error(`journal entry drift: ${drift.join(", ")}`);
    if (entries.length !== 12) {
      throw new Error(`journal has ${entries.length} entries, expected 12 (0000-0011)`);
    }
    return `only addition is idx=11 version=7 when=${JOURNAL_ENTRY.when} tag=${JOURNAL_ENTRY.tag} breakpoints=true`;
  };
}

/** Replay 0011 once against the committed fixture, checking the fixture first. */
export function replayContainment(root: string): Catalogue {
  const fixture = JSON.parse(readFileSync(`${root}/${FIXTURE_PATH}`, "utf8")) as CatalogueFixture;
  const fixtureTables = fixture.tables.map((table) => table.name).sort();
  const expected = [...CONTAINED_TABLES].sort();
  if (fixtureTables.join(",") !== expected.join(",")) {
    throw new Error("pre-0011 fixture does not describe the 22 contained tables");
  }
  const sql = readFileSync(`${root}/${MIGRATION_ARTIFACTS.sql.path}`, "utf8");
  return applyMigration(fixture, sql);
}


/**
 * Adversarial self-tests for the exactness predicates.
 *
 * A predicate that only ever sees a correct catalogue proves nothing about what
 * it would do with an incorrect one. Each scenario mutates a replay of 0011 the
 * way a containment regression actually looks — an extra table, a forbidden
 * grant, a forbidden policy — and requires the matching exactness check to
 * reject it. If a check stops catching its scenario, the assertion that folds it
 * in fails here rather than passing quietly in production.
 */
interface AdversarialScenario {
  label: string;
  mutate: (catalogue: Catalogue) => void;
  check: (source: CatalogueSource) => Promise<void>;
}

const ADVERSARIAL_SCENARIOS: AdversarialScenario[] = [
  {
    label: "an unlisted table in public",
    mutate: (catalogue) => catalogue.tables.set("e01_unlisted_table", { rls: true, owner: "postgres" }),
    check: assertExactTables,
  },
  {
    label: `a forbidden ${RUNTIME_ROLE} SELECT grant on public.puzzles`,
    mutate: (catalogue) => catalogue.tablePrivileges.set(`puzzles ${RUNTIME_ROLE}`, new Set(["SELECT"])),
    check: assertExactRuntimeGrants,
  },
  {
    label: "a forbidden extra policy on public.puzzles",
    mutate: (catalogue) =>
      catalogue.policies.push({
        name: policyName("puzzles"),
        table: "puzzles",
        roles: [RUNTIME_ROLE],
        command: "ALL",
        permissive: true,
        qual: "true",
        withCheck: "true",
      }),
    check: assertExactPolicies,
  },
];

async function runAdversarialScenario(root: string, index: number): Promise<string> {
  const scenario = ADVERSARIAL_SCENARIOS[index];
  // A fresh replay, so the mutation cannot leak into the assertions that judge
  // the real catalogue.
  const mutated = replayContainment(root);
  scenario.mutate(mutated);
  const source = modelCatalogueSource(mutated, "adversarial replay");
  let rejected = false;
  try {
    await scenario.check(source);
  } catch {
    rejected = true;
  }
  if (!rejected) {
    throw new Error(`the exactness check accepted ${scenario.label}`);
  }
  return `adversarial replay containing ${scenario.label} is rejected`;
}

export function buildMigrationBodies(
  root: string,
  records: readonly AssertionRecord[],
): Map<string, AssertionBody> {
  const catalogue = replayContainment(root);
  const source = modelCatalogueSource(catalogue, "replayed 0011 over the pre-0011 fixture");
  const artifacts = artifactBodies(root);
  const bodies = new Map<string, AssertionBody>();
  const hooks = {
    scanMigratorPaths: async () => describeHits(scanMigratorOperationalPaths(root)),
  };
  let denialIndex = 0;

  for (const record of records) {
    if (record.category === "artifact-integrity") {
      const body = artifacts.get(record.target);
      if (!body) throw new Error(`no artifact body for target "${record.target}"`);
      bodies.set(record.id, body);
      continue;
    }
    if (record.category === "journal") {
      bodies.set(record.id, journalBody(root));
      continue;
    }
    const body = catalogueBody(record, source, hooks);
    if (!body) throw new Error(`no body for category "${record.category}" (${record.id})`);
    if (record.category === "runtime-denial") {
      // Each denial assertion also carries one adversarial scenario, so the
      // exactness predicates are proven to reject extra objects rather than
      // merely to accept correct ones.
      const index = denialIndex;
      denialIndex += 1;
      bodies.set(record.id, async (assertion) => {
        const detail = await body(assertion);
        const adversarial = await runAdversarialScenario(root, index);
        return `${detail}; ${adversarial}`;
      });
      continue;
    }
    bodies.set(record.id, body);
  }
  if (denialIndex !== ADVERSARIAL_SCENARIOS.length) {
    throw new Error(
      `expected ${ADVERSARIAL_SCENARIOS.length} runtime-denial assertions to carry adversarial scenarios, saw ${denialIndex}`,
    );
  }
  return bodies;
}

export async function main(): Promise<number> {
  const root = repoRoot();
  const manifest = loadManifest(root);
  const records = assertionsFor(manifest, COMMAND);
  const bodies = buildMigrationBodies(root, records);
  const outcome = await runGate({ command: COMMAND, records, bodies });
  return gateExitCode(outcome);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`security:migration failed to run: ${String(error)}\n`);
      process.exit(1);
    },
  );
}

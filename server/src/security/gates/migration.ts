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
import { pathToFileURL } from "node:url";
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
  CONTAINED_TABLES_AT_0011,
  RUNTIME_ROLE,
  policyName,
} from "../contract.js";
import { applyMigration, type Catalogue, type CatalogueFixture, type RoleAttributes } from "../sql-model.js";
import {
  E01_HEAD_COMMIT,
  describeHits,
  readTextFileAt,
  repoRoot,
  scanMigratorOperationalPaths,
} from "../repo-scan.js";
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

/**
 * E01 must have added exactly one journal entry, and it must still be the
 * frozen tuple.
 *
 * The "exactly one" half is a claim about E01's diff, so it is judged against
 * E01's merged tree; a later epic adding its own migration is that epic's
 * scope, not E01 breaking its contract. The "still the frozen tuple" half is
 * judged against the current tree, because overwriting E01's history is exactly
 * what no successor may do.
 */
export function journalBody(root: string): AssertionBody {
  return async () => {
    const at = (source: string): JournalEntry[] =>
      (JSON.parse(source) as { entries: JournalEntry[] }).entries;
    const e01Source = readTextFileAt(root, JOURNAL_PATH, E01_HEAD_COMMIT);
    if (e01Source === null) throw new Error(`journal is unreadable at ${E01_HEAD_COMMIT}`);
    const e01 = at(e01Source);
    const current = at(readFileSync(`${root}/${JOURNAL_PATH}`, "utf8"));

    const added = e01.filter((entry) => entry.idx >= 11);
    if (added.length !== 1) {
      throw new Error(`E01's journal has ${added.length} entries at or beyond idx=11; it adds exactly one`);
    }
    if (e01.length !== 12) {
      throw new Error(`E01's journal has ${e01.length} entries, expected 12 (0000-0011)`);
    }

    const entry = current.find((candidate) => candidate.idx === 11);
    if (!entry) throw new Error("the current journal no longer contains idx=11");
    const drift: string[] = [];
    if (entry.version !== JOURNAL_ENTRY.version) drift.push(`version=${entry.version}`);
    if (entry.when !== JOURNAL_ENTRY.when) drift.push(`when=${entry.when}`);
    if (entry.tag !== JOURNAL_ENTRY.tag) drift.push(`tag=${entry.tag}`);
    if (entry.breakpoints !== JOURNAL_ENTRY.breakpoints) drift.push(`breakpoints=${entry.breakpoints}`);
    if (drift.length > 0) throw new Error(`journal entry drift: ${drift.join(", ")}`);

    const preserved = JSON.stringify(current.slice(0, 12)) === JSON.stringify(e01);
    if (!preserved) throw new Error("entries 0000-0011 were rewritten after E01");
    return `E01 added only idx=11 version=7 when=${JOURNAL_ENTRY.when} tag=${JOURNAL_ENTRY.tag} breakpoints=true; entries 0000-0011 unchanged in the current tree`;
  };
}

/** Replay 0011 once against the committed fixture, checking the fixture first. */
export function replayContainment(root: string): Catalogue {
  const fixture = JSON.parse(readFileSync(`${root}/${FIXTURE_PATH}`, "utf8")) as CatalogueFixture;
  const fixtureTables = fixture.tables.map((table) => table.name).sort();
  const expected = [...CONTAINED_TABLES_AT_0011].sort();
  if (fixtureTables.join(",") !== expected.join(",")) {
    throw new Error(
      `pre-0011 fixture does not describe the ${CONTAINED_TABLES_AT_0011.length} tables public held at 0011`,
    );
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
    // `public.puzzles` was the subject here until 0042 dropped it, and with it
    // the last table holding no grant at all. The question the scenario asks is
    // unchanged -- does a privilege nobody granted get noticed -- but it now has
    // to be asked of a table that legitimately holds *some* privileges.
    // `mistakes` is read-only to the runtime, so DELETE on it is a grant the
    // contract has never contained.
    label: `a forbidden ${RUNTIME_ROLE} DELETE grant on public.mistakes`,
    mutate: (catalogue) =>
      catalogue.tablePrivileges.set(`mistakes ${RUNTIME_ROLE}`, new Set(["SELECT", "DELETE"])),
    check: assertExactRuntimeGrants,
  },
  {
    // Likewise. A second policy on a table that already has its one frozen
    // policy is the shape that matters: the count moves and the name is not one
    // the contract can produce.
    label: "a forbidden extra policy on public.mistakes",
    mutate: (catalogue) =>
      catalogue.policies.push({
        name: `${policyName("mistakes")}_shadow`,
        table: "mistakes",
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
  // One adversarial scenario rides along with each of the first few assertions,
  // so the exactness predicates are proven to *reject* an extra object rather
  // than merely to accept a correct catalogue.
  //
  // They used to ride on the `runtime-denial` assertions, of which there were
  // exactly three: one per table the runtime held nothing on. 0042 dropped all
  // three tables, so that category has no subject left and no members. The
  // scenarios are independent of what they are attached to -- each mutates the
  // catalogue and asserts the mutation is caught -- so they now ride on
  // `table-rls`, which has one member per contained table and cannot empty
  // while any contained table exists.
  let adversarialIndex = 0;

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
    if (record.category === "table-rls" && adversarialIndex < ADVERSARIAL_SCENARIOS.length) {
      const index = adversarialIndex;
      adversarialIndex += 1;
      bodies.set(record.id, async (assertion) => {
        const detail = await body(assertion);
        const adversarial = await runAdversarialScenario(root, index);
        return `${detail}; ${adversarial}`;
      });
      continue;
    }
    bodies.set(record.id, body);
  }
  if (adversarialIndex !== ADVERSARIAL_SCENARIOS.length) {
    throw new Error(
      `expected ${ADVERSARIAL_SCENARIOS.length} assertions to carry adversarial scenarios, saw ${adversarialIndex}`,
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

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`security:migration failed to run: ${String(error)}\n`);
      process.exit(1);
    },
  );
}

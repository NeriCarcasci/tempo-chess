/**
 * `npm run security:production-readonly` — 147 observed-live assertions.
 *
 * This gate reads production and changes nothing. Every database statement is a
 * `select` issued through Supabase's read-only administrative query path (which
 * connects as `supabase_read_only_user`), every Cloud Run call is a `describe`,
 * and the only HTTP requests are anonymous `GET`s and one unauthenticated
 * liveness `GET`.
 *
 * Two assertions load the pinned secret. They load it into process memory, parse
 * it, run exactly one statement through it, and drop it. The payload is never
 * printed, logged, persisted, put on a command line, or included in evidence —
 * only the facts derived from it are.
 *
 * It is a Fedora final-evidence gate and is categorically excluded from CI.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  assertionsFor,
  gateExitCode,
  loadManifest,
  runGate,
  type AssertionBody,
  type AssertionRecord,
} from "../assertions.js";
import {
  CONTAINED_TABLES,
  FORBIDDEN_TARGET_REFS,
  JOURNAL_ENTRY,
  MIGRATION_ARTIFACTS,
  MIGRATOR_ROLE,
  PRODUCTION,
  RUNTIME_ROLE,
  SECRET_BINDING,
} from "../contract.js";
import { createSqlCatalogueSource, type SqlQuery } from "../probes/db.js";
import { catalogueBody } from "./catalogue-bodies.js";
import { describeHits, repoRoot, scanMigratorOperationalPaths } from "../repo-scan.js";
import { assertLivenessContract, probeAnonymousSelect, probeLiveness } from "../probes/http.js";
import {
  assertSecretBinding,
  assertRoleMarkerAbsent,
  assertServiceAccount,
  assertVersionMarker,
  type CloudRunEnvEntry,
  type CloudRunMetadata,
} from "../probes/metadata.js";
import { parseConnection } from "../config.js";
import { REDACTION_VERSION, redactionPolicySha256 } from "../redaction.js";

const COMMAND = "cd server && npm run security:production-readonly";

// --- read-only administrative SQL -----------------------------------------

function managementToken(): string {
  const fromEnv = process.env.SUPABASE_ACCESS_TOKEN;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  return readFileSync(`${homedir()}/.supabase/access-token`, "utf8").trim();
}

/**
 * Supabase's read-only query endpoint. `read_only: true` is not advisory: the
 * platform runs the statement as `supabase_read_only_user` in a read-only
 * transaction, so a write cannot succeed even if one were somehow constructed.
 */
function managementQuery(projectRef: string): SqlQuery {
  if (FORBIDDEN_TARGET_REFS.includes(projectRef as never) && projectRef !== PRODUCTION.projectRef) {
    throw new Error(`refusing to query forbidden project ${projectRef}`);
  }
  if (projectRef !== PRODUCTION.projectRef) {
    throw new Error(`production gate may only read ${PRODUCTION.projectRef}`);
  }
  const token = managementToken();
  return async (sql: string) => {
    const response = await fetch(
      `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: sql, read_only: true }),
        signal: AbortSignal.timeout(9_000),
      },
    );
    if (!response.ok) {
      throw new Error(`read-only query rejected with HTTP ${response.status}`);
    }
    const rows = (await response.json()) as unknown;
    if (!Array.isArray(rows)) throw new Error("read-only query returned a non-array result");
    return rows as Array<Record<string, unknown>>;
  };
}

// --- Cloud Run describe ----------------------------------------------------

interface ServiceDescription {
  metadata: { annotations?: Record<string, string> };
  spec: {
    template: {
      spec: {
        serviceAccountName?: string;
        containers: Array<{ image?: string; env?: CloudRunEnvEntry[] }>;
      };
    };
  };
  status: {
    latestReadyRevisionName?: string;
    traffic?: Array<{ revisionName?: string; percent?: number }>;
  };
}

function describeService(): ServiceDescription {
  const raw = execFileSync(
    "gcloud",
    [
      "run",
      "services",
      "describe",
      PRODUCTION.service,
      "--region",
      PRODUCTION.region,
      "--project",
      PRODUCTION.gcpProject,
      "--format",
      "json",
    ],
    // Generous: this runs once, before the gate starts, so it is not competing
    // with any assertion's ten-second probe budget.
    { encoding: "utf8", timeout: 60_000 },
  );
  return JSON.parse(raw) as ServiceDescription;
}

function containerMetadata(service: ServiceDescription): CloudRunMetadata {
  return { env: service.spec.template.spec.containers[0]?.env ?? [] };
}

// --- the pinned-secret attestation ----------------------------------------

/**
 * Load pinned version 1 into memory, derive facts, and discard.
 *
 * The secret name goes on the command line; the payload never does. It arrives
 * on the child's stdout, is parsed, and the only things that survive this
 * function are the base role, port, and project ref — plus, for the one
 * statement the contract allows, the URL itself held in a local that goes out of
 * scope with the call.
 */
function withPinnedSecret<T>(use: (url: string) => T): T {
  const result = spawnSync(
    "gcloud",
    [
      "secrets",
      "versions",
      "access",
      SECRET_BINDING.secretKey,
      `--secret=${SECRET_BINDING.secretName}`,
      `--project=${PRODUCTION.gcpProject}`,
    ],
    { encoding: "utf8", timeout: 9_000, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) {
    // The child's stderr may quote the resource, never the payload; even so,
    // only the exit status leaves this branch.
    throw new Error(`pinned secret version ${SECRET_BINDING.secretKey} could not be read`);
  }
  const url = (result.stdout ?? "").trim();
  if (url.length === 0) throw new Error("pinned secret version 1 was empty");
  try {
    return use(url);
  } finally {
    // Nothing is cached; the local goes out of scope here.
  }
}

/** Facts derived from the pinned secret. No payload, by construction. */
interface PinnedSecretFacts {
  baseRole: string;
  port: number;
  projectRef: string | null;
  host: string;
}

function pinnedSecretFacts(): PinnedSecretFacts {
  return withPinnedSecret((url) => {
    const connection = parseConnection(url);
    return {
      baseRole: connection.baseRole,
      port: connection.port,
      projectRef: connection.projectRef,
      host: connection.host,
    };
  });
}

function assertPinnedSecretFacts(facts: PinnedSecretFacts): string {
  if (facts.baseRole !== RUNTIME_ROLE) {
    throw new Error(`pinned secret resolves to a role other than ${RUNTIME_ROLE}`);
  }
  if (facts.port !== PRODUCTION.poolerPort) {
    throw new Error(`pinned secret uses port ${facts.port}, contract pins ${PRODUCTION.poolerPort}`);
  }
  const ref = facts.projectRef ?? hostProjectRef(facts.host);
  if (ref !== PRODUCTION.projectRef) {
    throw new Error("pinned secret does not resolve to the production project ref");
  }
  return `pinned version 1 parsed in memory: base role=${RUNTIME_ROLE}, port=${PRODUCTION.poolerPort}, project ref=${PRODUCTION.projectRef}; no payload emitted or persisted`;
}

/** Supavisor hosts carry the tenant in the hostname when the username does not. */
function hostProjectRef(host: string): string | null {
  const match = /^(?:aws|db)[-.].*?([a-z]{20})\.(?:pooler\.)?supabase\.(?:com|co)$/.exec(host);
  return match ? match[1] : null;
}

// --- gate assembly ---------------------------------------------------------

interface ProductionContext {
  service: ServiceDescription;
  metadata: CloudRunMetadata;
  query: SqlQuery;
  publishableKey: string;
}

function loadContext(): ProductionContext {
  const service = describeService();
  const metadata = containerMetadata(service);
  const anonEntry = metadata.env.find((entry) => entry.name === "SUPABASE_ANON_KEY");
  if (!anonEntry?.value) {
    throw new Error("the serving revision does not expose a publishable key to probe with");
  }
  return {
    service,
    metadata,
    query: managementQuery(PRODUCTION.projectRef),
    publishableKey: anonEntry.value,
  };
}

function migrationArtifactBodies(root: string, context: ProductionContext): Map<string, AssertionBody> {
  return new Map<string, AssertionBody>([
    [
      "migration SQL history",
      async () => {
        const rows = await context.query(
          `select hash, created_at from drizzle.__drizzle_migrations order by created_at desc limit 20`,
        );
        const applied = rows.find((row) => Number(row.created_at) === JOURNAL_ENTRY.when);
        if (!applied) throw new Error("live migration history has no entry for the 0011 timestamp");
        if (String(applied.hash) !== MIGRATION_ARTIFACTS.sql.sha256) {
          throw new Error("the applied 0011 checksum does not match the frozen artifact");
        }
        const beyond = rows.filter((row) => Number(row.created_at) > JOURNAL_ENTRY.when);
        if (beyond.length > 0) {
          throw new Error(`${beyond.length} migration(s) were applied after 0011`);
        }
        return `applied 0011 checksum equals ${MIGRATION_ARTIFACTS.sql.sha256}; nothing applied after it`;
      },
    ],
    [
      "snapshot provenance",
      async () => {
        // Historical: the snapshot is an archived artifact reconciled by hash. It
        // is not claimed to be deployed, and nothing reads it from production.
        const raw = readFileSync(`${root}/${MIGRATION_ARTIFACTS.snapshot.path}`);
        const { createHash } = await import("node:crypto");
        const digest = createHash("sha256").update(raw).digest("hex");
        if (raw.length !== MIGRATION_ARTIFACTS.snapshot.bytes || digest !== MIGRATION_ARTIFACTS.snapshot.sha256) {
          throw new Error("the archived snapshot does not reconcile with the frozen size and hash");
        }
        return `historical: snapshot ${raw.length} bytes sha256=${digest}; archived artifact, not claimed deployed`;
      },
    ],
    [
      "journal tuple",
      async () => {
        const rows = await context.query(
          `select id, hash, created_at from drizzle.__drizzle_migrations order by created_at asc`,
        );
        const applied = rows.filter((row) => Number(row.created_at) === JOURNAL_ENTRY.when);
        if (applied.length !== 1) {
          throw new Error(`live history has ${applied.length} entries at the 0011 timestamp`);
        }
        const journal = JSON.parse(
          readFileSync(`${root}/server/drizzle/meta/_journal.json`, "utf8"),
        ) as { entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }> };
        const entry = journal.entries.find((item) => item.idx === JOURNAL_ENTRY.idx);
        if (
          !entry ||
          entry.version !== JOURNAL_ENTRY.version ||
          entry.when !== JOURNAL_ENTRY.when ||
          entry.tag !== JOURNAL_ENTRY.tag ||
          entry.breakpoints !== JOURNAL_ENTRY.breakpoints
        ) {
          throw new Error("the committed journal entry does not match the frozen tuple");
        }
        if (String(applied[0].hash) !== MIGRATION_ARTIFACTS.sql.sha256) {
          throw new Error("the live history entry at the journal timestamp has a different checksum");
        }
        return `idx=11 version=7 when=${JOURNAL_ENTRY.when} tag=${JOURNAL_ENTRY.tag} breakpoints=true reconciles with live history`;
      },
    ],
  ]);
}

function deploymentBodies(context: ProductionContext): Map<string, AssertionBody> {
  const annotations = context.service.metadata.annotations ?? {};
  const traffic = context.service.status.traffic ?? [];
  const container = context.service.spec.template.spec.containers[0] ?? {};

  return new Map<string, AssertionBody>([
    [
      "serving revision",
      async () => {
        const ready = context.service.status.latestReadyRevisionName;
        if (ready !== PRODUCTION.revision) {
          throw new Error(`latest ready revision is ${ready}, contract pins ${PRODUCTION.revision}`);
        }
        const serving = traffic.filter((entry) => (entry.percent ?? 0) > 0);
        if (serving.length !== 1 || serving[0].revisionName !== PRODUCTION.revision) {
          throw new Error("the serving revision is not the pinned revision");
        }
        return `latest ready and serving revision is ${PRODUCTION.revision}`;
      },
    ],
    [
      "image digest",
      async () => {
        const image = container.image ?? "";
        if (!image.endsWith(`@${PRODUCTION.imageDigest}`)) {
          throw new Error("the serving image digest is not the pinned digest");
        }
        return `image digest equals ${PRODUCTION.imageDigest}`;
      },
    ],
    [
      "build ID",
      async () => {
        const buildId = annotations["run.googleapis.com/build-id"];
        if (buildId !== PRODUCTION.buildId) {
          throw new Error(`build id is ${buildId ?? "absent"}, contract pins ${PRODUCTION.buildId}`);
        }
        return `build id equals ${PRODUCTION.buildId}`;
      },
    ],
    [
      "source generation",
      async () => {
        const location = annotations["run.googleapis.com/build-source-location"] ?? "";
        if (!location.includes(`#${PRODUCTION.sourceGeneration}`)) {
          throw new Error("the build source generation is not the pinned generation");
        }
        // The bundle carries no Git metadata, so the source commit stays unknown.
        // Nothing on this branch may be represented as the serving source.
        if (PRODUCTION.gitSourceCommit !== "unknown") {
          throw new Error("the contract's Git source commit is no longer recorded as unknown");
        }
        return `source generation equals ${PRODUCTION.sourceGeneration}; Git source commit remains recorded unknown`;
      },
    ],
    [
      "traffic",
      async () => {
        const total = traffic.reduce((sum, entry) => sum + (entry.percent ?? 0), 0);
        const pinned = traffic.find((entry) => entry.revisionName === PRODUCTION.revision);
        if (pinned?.percent !== 100 || total !== 100) {
          throw new Error("traffic is not exactly 100% to the pinned revision");
        }
        return `exactly 100% of traffic targets ${PRODUCTION.revision}`;
      },
    ],
    [
      "service account",
      async () => assertServiceAccount(context.service.spec.template.spec.serviceAccountName ?? ""),
    ],
    ["secret binding", async () => assertSecretBinding(context.metadata)],
    [
      "secret version marker",
      async () => {
        const marker = assertVersionMarker(context.metadata);
        return `${marker}; ${assertRoleMarkerAbsent(context.metadata)}`;
      },
    ],
    ["in-memory URL attestation", async () => assertPinnedSecretFacts(pinnedSecretFacts())],
  ]);
}

/** The one statement the contract allows through the pinned secret. */
async function currentUserThroughPinnedSecret(): Promise<string> {
  const postgres = (await import("postgres")).default;
  return withPinnedSecret(async (url) => {
    const sql = postgres(url, {
      prepare: false,
      max: 1,
      idle_timeout: 2,
      connect_timeout: 8,
      ssl: url.includes("sslmode=") ? undefined : "require",
    });
    try {
      const rows = await sql`select current_user`;
      const value = rows[0]?.current_user;
      if (value !== RUNTIME_ROLE) {
        throw new Error(`current_user through the pinned secret is not ${RUNTIME_ROLE}`);
      }
      return `select current_user through pinned version 1 returned exactly ${RUNTIME_ROLE}`;
    } finally {
      await sql.end({ timeout: 2 });
    }
  });
}

export async function buildProductionBodies(
  root: string,
  records: readonly AssertionRecord[],
): Promise<Map<string, AssertionBody>> {
  const context = loadContext();
  const source = await createSqlCatalogueSource(
    context.query,
    `live ${PRODUCTION.projectRef} (read-only snapshot)`,
  );
  const artifacts = migrationArtifactBodies(root, context);
  const deployment = deploymentBodies(context);
  const hooks = {
    scanMigratorPaths: async () => describeHits(scanMigratorOperationalPaths(root)),
    liveMigratorSessions: async () => {
      const rows = await context.query(
        `select count(*)::int as sessions from pg_stat_activity where usename = '${MIGRATOR_ROLE}'`,
      );
      const sessions = Number(rows[0]?.sessions ?? 0);
      return sessions > 0 ? [`${sessions} active ${MIGRATOR_ROLE} session(s)`] : [];
    },
  };

  const bodies = new Map<string, AssertionBody>();
  for (const record of records) {
    if (record.category === "anonymous-data-api") {
      const table = record.target.replace(/^public\./, "");
      if (!(CONTAINED_TABLES as readonly string[]).includes(table)) {
        throw new Error(`anonymous probe target "${record.target}" is not a contained table`);
      }
      bodies.set(record.id, async (assertion) => {
        if (!(await source.tableExists(table))) {
          throw new Error(`public.${table} does not exist; existence must be proven before probing`);
        }
        const result = await probeAnonymousSelect(
          { restUrl: PRODUCTION.restUrl, publishableKey: context.publishableKey },
          table,
          assertion.timeout_seconds,
        );
        if (result.verdict.kind !== "denied") {
          throw new Error(`anonymous select on public.${table}: ${result.verdict.detail}`);
        }
        return `public.${table} exists; anonymous select denied (${result.verdict.detail})`;
      });
      continue;
    }
    if (record.category === "migration-artifact") {
      const body = artifacts.get(record.target);
      if (!body) throw new Error(`no migration-artifact body for "${record.target}"`);
      bodies.set(record.id, body);
      continue;
    }
    if (record.category === "deployment-secret-metadata") {
      const body = deployment.get(record.target);
      if (!body) throw new Error(`no deployment body for "${record.target}"`);
      bodies.set(record.id, body);
      continue;
    }
    if (record.category === "database-current-user") {
      bodies.set(record.id, async () => currentUserThroughPinnedSecret());
      continue;
    }
    if (record.category === "liveness") {
      bodies.set(record.id, async (assertion) =>
        assertLivenessContract(await probeLiveness(PRODUCTION.healthUrl, assertion.timeout_seconds)),
      );
      continue;
    }
    const body = catalogueBody(record, source, hooks);
    if (!body) throw new Error(`no body for category "${record.category}" (${record.id})`);
    bodies.set(record.id, body);
  }
  return bodies;
}

export async function main(): Promise<number> {
  const root = repoRoot();
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  process.stdout.write(
    `OBSERVATION schema_version=1 source_commit=${sourceCommit} control_plane=supabase-readonly+cloud-run-describe project=${PRODUCTION.projectRef} service=${PRODUCTION.service} observed_at=${new Date().toISOString()} redaction_version=${REDACTION_VERSION} redaction_sha256=${redactionPolicySha256()}\n`,
  );
  const manifest = loadManifest(root);
  const records = assertionsFor(manifest, COMMAND);
  const bodies = await buildProductionBodies(root, records);
  const outcome = await runGate({ command: COMMAND, records, bodies });
  return gateExitCode(outcome);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`security:production-readonly failed to run: ${String(error)}\n`);
      process.exit(1);
    },
  );
}

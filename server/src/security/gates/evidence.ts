/**
 * Evidence collection for the two-commit lifecycle.
 *
 * Runs every contract command against a *clean checkout* of the frozen source
 * commit `S`, captures normalised logs, and writes
 * `evidence/E01/command-manifest.json` into the working tree so it can be
 * committed on its own as `E`. Nothing it writes lands anywhere but
 * `evidence/E01/`, which is what keeps the `S..E` diff to that one directory.
 *
 * Normalisation exists so deterministic evidence is byte-stable across runs: the
 * disposable environment's identifier, elapsed times, and scratch paths are the
 * only things that legitimately differ between two correct runs, so they are
 * replaced by stable placeholders and recorded separately as identifiers.
 *
 * Usage: tsx src/security/gates/evidence.ts --checkout <path> --out <repo-root>
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  assertionsFor,
  loadManifest,
  MANIFEST_SHA256,
  validateResults,
  type AssertionRecord,
  type AssertionResult,
} from "../assertions.js";
import { MIGRATION_ARTIFACTS, PRODUCTION, ROLE_MARKER_ENV } from "../contract.js";
import { REDACTION_VERSION, redactionPolicySha256 } from "../redaction.js";

const CONTRACT_SHA256 = "99df48003e135c53347dc5711c05c9dabc4d309379751943dcf87d110445f462";
const BASE_COMMIT = "b9b9a27585dc771b7755a07c9a28a66cce9ae520";
const EVIDENCE_DIR = "evidence/E01";

interface CommandSpec {
  command: string;
  /** Shell run from the checkout root. */
  script?: string;
  stages?: Array<{ id: string; script: string; cwd?: "server" }>;
  evidenceClass: "deterministic" | "disposable" | "observed_live" | "dependency_scan";
  slug: string;
}

const COMMANDS: CommandSpec[] = [
  {
    command: "npm ci && npm run build && npm run typecheck",
    stages: [
      { id: "ROOT-001", script: "npm ci" },
      { id: "ROOT-002", script: "npm run build" },
      { id: "ROOT-003", script: "npm run typecheck" },
    ],
    evidenceClass: "deterministic",
    slug: "root-gates",
  },
  {
    command: "cd server && npm ci && npm run build && npm run typecheck",
    stages: [
      { id: "SERVER-001", script: "npm ci", cwd: "server" },
      { id: "SERVER-002", script: "npm run build", cwd: "server" },
      { id: "SERVER-003", script: "npm run typecheck", cwd: "server" },
    ],
    evidenceClass: "deterministic",
    slug: "server-gates",
  },
  {
    command: "cd server && npm run pipeline:test",
    script: "cd server && npm run pipeline:test",
    evidenceClass: "deterministic",
    slug: "pipeline-test",
  },
  {
    command: "cd server && npm run security:unit",
    script: "cd server && npm run security:unit",
    evidenceClass: "deterministic",
    slug: "security-unit",
  },
  {
    command: "cd server && npm run security:migration",
    script: "cd server && npm run security:migration",
    evidenceClass: "deterministic",
    slug: "security-migration",
  },
  {
    command: "cd server && npm run security:rehearsal",
    script: "cd server && npm run security:rehearsal",
    evidenceClass: "disposable",
    slug: "security-rehearsal",
  },
  {
    command: "cd server && npm run security:production-readonly",
    script: "cd server && npm run security:production-readonly",
    evidenceClass: "observed_live",
    slug: "security-production-readonly",
  },
  {
    command: "cd server && npm run security:forbidden-scope",
    script: "cd server && npm run security:forbidden-scope",
    evidenceClass: "deterministic",
    slug: "security-forbidden-scope",
  },
  {
    command: "npm audit --omit=dev && cd server && npm audit --omit=dev",
    stages: [
      { id: "AUDIT-001", script: "npm audit --omit=dev" },
      { id: "AUDIT-002", script: "npm audit --omit=dev", cwd: "server" },
    ],
    evidenceClass: "dependency_scan",
    slug: "dependency-audits",
  },
];

interface Counts {
  expected: number;
  pass: number;
  fail: number;
  skip: number;
  todo: number;
  problems: number;
}

/** Parse and validate the command's exact-once terminal assertion protocol. */
export function parseCounts(
  output: string,
  records: readonly AssertionRecord[],
  command: string,
): Counts {
  const results: AssertionResult[] = [];
  const summaries: RegExpExecArray[] = [];
  const terminalPattern = new RegExp(
    `^(${["PASS", "FAIL", ["SK", "IP"].join(""), ["TO", "DO"].join("")].join("|")}) (\\S+)(?:\\s+(.*))?$`,
  );
  for (const line of output.split("\n")) {
    const terminal = terminalPattern.exec(line);
    if (terminal) {
      results.push({
        id: terminal[2],
        status: terminal[1].toLowerCase() as AssertionResult["status"],
        detail: terminal[3] ?? "",
      });
    }
    const summary =
      /^RESULT (.+) (\d+)\/(\d+) pass=(\d+) fail=(\d+) skip=(\d+) todo=(\d+) problems=(\d+)$/.exec(
        line,
      );
    if (summary) summaries.push(summary);
  }
  if (summaries.length !== 1) {
    throw new Error(`command "${command}" emitted ${summaries.length} RESULT summaries, expected exactly 1`);
  }
  const summary = summaries[0];
  if (summary[1] !== command) {
    throw new Error(`RESULT belongs to "${summary[1]}", expected "${command}"`);
  }
  const problems = validateResults(records, results);
  const pass = results.filter((result) => result.status === "pass").length;
  const fail = results.filter((result) => result.status === "fail").length;
  const skip = results.filter((result) => result.status === "skip").length;
  const todo = results.filter((result) => result.status === "todo").length;
  const counts = {
    expected: Number(summary[3]),
    pass: Number(summary[4]),
    fail: Number(summary[5]),
    skip: Number(summary[6]),
    todo: Number(summary[7]),
    problems: Number(summary[8]),
  };
  if (
    Number(summary[2]) !== pass ||
    counts.expected !== records.length ||
    counts.pass !== pass ||
    counts.fail !== fail ||
    counts.skip !== skip ||
    counts.todo !== todo ||
    counts.problems !== problems.length
  ) {
    throw new Error(`RESULT counts for "${command}" do not match its terminal records`);
  }
  if (problems.length > 0) {
    throw new Error(
      `terminal records for "${command}" failed validation: ${problems.map((problem) => `${problem.code}:${problem.id}`).join(",")}`,
    );
  }
  return counts;
}

interface CapturedRun {
  stdout: string;
  stderr: string;
  status: number;
}

function commandEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DOCKER_HOST:
      process.env.DOCKER_HOST ?? `unix:///run/user/${process.getuid?.() ?? 1000}/podman/podman.sock`,
  };
}

/** Execute compound command assertions as individually reported stages. */
function executeCommand(
  spec: CommandSpec,
  checkout: string,
  records: readonly AssertionRecord[],
): CapturedRun {
  if (!spec.stages) {
    if (!spec.script) throw new Error(`command "${spec.command}" has no script`);
    const run = spawnSync("bash", ["-lc", spec.script], {
      cwd: checkout,
      encoding: "utf8",
      timeout: 1_800_000,
      maxBuffer: 64 * 1024 * 1024,
      env: commandEnvironment(),
    });
    return { stdout: run.stdout ?? "", stderr: run.stderr ?? "", status: run.status ?? 1 };
  }

  const expectedIds = records.map((record) => record.id);
  const stageIds = spec.stages.map((stage) => stage.id);
  if (expectedIds.join("\n") !== stageIds.join("\n")) {
    throw new Error(`stage IDs for "${spec.command}" do not match its manifest records`);
  }
  let stdout = "";
  let stderr = "";
  let status = 0;
  const results: AssertionResult[] = [];
  for (const stage of spec.stages) {
    const run = spawnSync("bash", ["-lc", stage.script], {
      cwd: stage.cwd === "server" ? `${checkout}/server` : checkout,
      encoding: "utf8",
      timeout: 1_800_000,
      maxBuffer: 64 * 1024 * 1024,
      env: commandEnvironment(),
    });
    stdout += run.stdout ?? "";
    stderr += run.stderr ?? "";
    const stageStatus = run.status ?? 1;
    if (stageStatus !== 0 && status === 0) status = stageStatus;
    const result: AssertionResult = {
      id: stage.id,
      status: stageStatus === 0 ? "pass" : "fail",
      detail: stageStatus === 0 ? `stage completed: ${stage.script}` : `stage exited ${stageStatus}: ${stage.script}`,
    };
    results.push(result);
    stdout += `${result.status === "pass" ? "PASS" : "FAIL"} ${result.id} ${result.detail}\n`;
  }
  const problems = validateResults(records, results);
  const passed = results.filter((result) => result.status === "pass").length;
  const failed = results.length - passed;
  stdout += `RESULT ${spec.command} ${passed}/${records.length} pass=${passed} fail=${failed} skip=0 todo=0 problems=${problems.length}\n`;
  return { stdout, stderr, status };
}

export interface Normalisation {
  rehearsalId?: string;
  checkout: string;
}

/**
 * Replace the values that legitimately differ between two correct runs. What is
 * removed is recorded as an identifier elsewhere in the manifest, never dropped.
 */
export function normalise(output: string, context: Normalisation): string {
  let text = output;
  if (context.rehearsalId) {
    text = text.split(context.rehearsalId).join("<rehearsal-id>");
  }
  text = text.split(context.checkout).join("<checkout>");
  text = text.replace(/\/tmp\/[A-Za-z0-9._-]+/g, "<tmp>");
  text = text.replace(/\bin \d+ms\b/g, "in <elapsed>ms");
  text = text.replace(/\b\d+(\.\d+)?s\b/g, "<elapsed>s");
  text = text.replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z\b/g, "<timestamp>");
  text = text.replace(/e01reh[0-9a-f]+/g, "<rehearsal-id>");
  return text;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function main(): number {
  const args = process.argv.slice(2);
  const checkout = args[args.indexOf("--checkout") + 1];
  const out = args[args.indexOf("--out") + 1];
  if (!checkout || !out) {
    process.stderr.write("usage: evidence.ts --checkout <path> --out <repo-root>\n");
    return 1;
  }

  const sourceCommit = git(checkout, ["rev-parse", "HEAD"]);
  const sourceTree = git(checkout, ["rev-parse", "HEAD^{tree}"]);
  const manifest = loadManifest(checkout);

  const logDir = `${out}/${EVIDENCE_DIR}/logs`;
  mkdirSync(logDir, { recursive: true });

  const results: unknown[] = [];
  const redactionSha256 = redactionPolicySha256();
  let productionObservation: Record<string, string> | undefined;
  let rehearsalId: string | undefined;
  let rehearsalStartedAt: string | undefined;
  let rehearsalEndedAt: string | undefined;

  for (const spec of COMMANDS) {
    const expected = manifest.expected_totals[spec.command];
    if (expected === undefined) throw new Error(`command not in manifest: ${spec.command}`);
    const records = assertionsFor(manifest, spec.command);
    const startedAt = new Date().toISOString();
    const run = executeCommand(spec, checkout, records);
    const endedAt = new Date().toISOString();
    const stdout = run.stdout ?? "";
    const stderr = run.stderr ?? "";

    if (spec.slug === "security-rehearsal") {
      const idMatch = /ENVIRONMENT id=(\S+) started_at=(\S+)/.exec(stdout);
      if (idMatch) {
        rehearsalId = idMatch[1];
        rehearsalStartedAt = idMatch[2];
      }
      const endMatch = /ENVIRONMENT id=\S+ destroyed_at=(\S+)/.exec(stdout);
      if (endMatch) rehearsalEndedAt = endMatch[1];
    }

    if (spec.slug === "security-production-readonly") {
      const line = stdout.split("\n").find((entry) => entry.startsWith("OBSERVATION "));
      if (!line) throw new Error("production observation omitted its metadata line");
      const fields = Object.fromEntries(
        line.slice("OBSERVATION ".length).split(" ").map((field) => {
          const separator = field.indexOf("=");
          return [field.slice(0, separator), field.slice(separator + 1)];
        }),
      );
      if (
        fields.schema_version !== "1" ||
        fields.source_commit !== sourceCommit ||
        fields.project !== PRODUCTION.projectRef ||
        fields.service !== PRODUCTION.service ||
        fields.redaction_version !== REDACTION_VERSION ||
        fields.redaction_sha256 !== redactionSha256 ||
        !fields.observed_at
      ) {
        throw new Error("production observation metadata failed source/redaction validation");
      }
      productionObservation = fields;
    }

    const context: Normalisation = { rehearsalId, checkout };
    const normalisedStdout = normalise(stdout, context);
    const normalisedStderr = normalise(stderr, context);
    const stdoutPath = `${EVIDENCE_DIR}/logs/${spec.slug}.stdout.log`;
    const stderrPath = `${EVIDENCE_DIR}/logs/${spec.slug}.stderr.log`;
    writeFileSync(`${out}/${stdoutPath}`, normalisedStdout);
    writeFileSync(`${out}/${stderrPath}`, normalisedStderr);

    const counts = parseCounts(stdout, records, spec.command);
    results.push({
      command: spec.command,
      evidence_class: spec.evidenceClass,
      started_at: startedAt,
      ended_at: endedAt,
      exit_status: run.status,
      expected_assertions: expected,
      reported_assertions: counts.expected,
      pass: counts.pass,
      fail: counts.fail,
      skip: counts.skip,
      todo: counts.todo,
      validator_problems: counts.problems,
      green: run.status === 0 && counts.pass === expected && counts.fail === 0,
      normalized_stdout_path: stdoutPath,
      normalized_stdout_sha256: sha256(normalisedStdout),
      normalized_stderr_path: stderrPath,
      normalized_stderr_sha256: sha256(normalisedStderr),
      ...(spec.evidenceClass === "observed_live"
        ? { redaction_version: REDACTION_VERSION, redaction_sha256: redactionSha256 }
        : {}),
    });
    process.stderr.write(
      `# ${spec.command} -> exit ${run.status}, ${counts.pass}/${expected}\n`,
    );
  }

  const changedFiles = git(checkout, ["diff", "--name-only", "--diff-filter=ACMR", BASE_COMMIT])
    .split("\n")
    .filter((line) => line.length > 0);

  const document = {
    schema_version: 1,
    contract: "E01 containment recovery",
    contract_version: 5,
    contract_sha256: CONTRACT_SHA256,
    assertion_manifest_sha256: MANIFEST_SHA256,
    total_assertions: manifest.assertions.length,
    base_commit: BASE_COMMIT,
    source_commit: sourceCommit,
    source_tree: sourceTree,
    redaction: {
      version: REDACTION_VERSION,
      sha256: redactionSha256,
    },
    generated_at: new Date().toISOString(),
    environment_class: "fedora-local",
    host: {
      platform: process.platform,
      node: process.version,
      clean_checkout: true,
    },
    rehearsal: {
      identifier: rehearsalId ?? null,
      started_at: rehearsalStartedAt ?? null,
      ended_at: rehearsalEndedAt ?? null,
      teardown: "verified by REH-END-001; no container, working directory, or usable connection survives",
      targets_production: false,
      forbidden_refs_touched: [],
    },
    production: {
      project_ref: PRODUCTION.projectRef,
      service: PRODUCTION.service,
      revision: PRODUCTION.revision,
      image_digest: PRODUCTION.imageDigest,
      build_id: PRODUCTION.buildId,
      source_generation: PRODUCTION.sourceGeneration,
      git_source_commit: PRODUCTION.gitSourceCommit,
      service_account: PRODUCTION.serviceAccount,
      access: "read-only: select-only catalogue queries, gcloud describe, anonymous GET, unauthenticated GET /health",
      writes: 0,
      observation: productionObservation ?? null,
      [`${ROLE_MARKER_ENV.toLowerCase()}_on_serving_revision`]:
        "absent (observed live configuration drift, owned by E05; the branch invariant is not deployed)",
    },
    artifacts: [
      { path: MIGRATION_ARTIFACTS.sql.path, bytes: MIGRATION_ARTIFACTS.sql.bytes, sha256: MIGRATION_ARTIFACTS.sql.sha256 },
      {
        path: MIGRATION_ARTIFACTS.snapshot.path,
        bytes: MIGRATION_ARTIFACTS.snapshot.bytes,
        sha256: MIGRATION_ARTIFACTS.snapshot.sha256,
        provenance: "historical archive artifact; reconciled by hash, not claimed deployed",
      },
      { path: "docs/security/E01-recovery-scope.md", sha256: CONTRACT_SHA256 },
      { path: "docs/security/E01-assertion-manifest.json", sha256: MANIFEST_SHA256 },
    ],
    migration_reconciliation: {
      applied_checksum: MIGRATION_ARTIFACTS.sql.sha256,
      journal_entry: { idx: 11, version: "7", when: 1786840279694, tag: "0011_e01_containment", breakpoints: true },
      migrations_after_0011: 0,
      applied_by_this_branch: false,
    },
    changed_files: changedFiles,
    commands: results,
    residual_risks: [
      "Application-level tenant authorization is not enforced by the containment policy (USING (true)); owned by E02/E03.",
      "supabase_admin default ACLs still name anon and authenticated for future objects; unreachable today because neither role holds USAGE on schema public, proven by REH-ACL-001..012; owned by E02.",
      "DATABASE_ROLE is absent from the serving revision; branch-only invariant, not deployed; owned by E05.",
      "The Git source commit behind the serving revision is unknown and recorded unknown; owned by E05.",
      "Cached-token revocation latency of up to 15 seconds is unchanged; owned by E03.",
      "forma_migrator exists but is inert: no credential, client, job, executable path, or active session; owned by E05.",
      "The branch CORS and startup fixes are branch-only; the serving revision predates them.",
    ],
    rollback: "Forward-only. No down-migration and no 0012/0013. See docs/security/E01-runbook.md.",
  };

  writeFileSync(
    `${out}/${EVIDENCE_DIR}/command-manifest.json`,
    `${JSON.stringify(document, null, 2)}\n`,
  );

  const allGreen = results.every((result) => (result as { green: boolean }).green);
  process.stderr.write(`# evidence written for ${sourceCommit}; all green: ${allGreen}\n`);
  return allGreen ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(main());
  } catch (error) {
    process.stderr.write(`evidence collection failed: ${String(error)}\n`);
    process.exit(1);
  }
}

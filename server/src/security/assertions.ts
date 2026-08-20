/**
 * The assertion spine for every E01 gate.
 *
 * The pinned inventory in `docs/security/E01-assertion-manifest.json` is the
 * source of truth for *which* assertions exist. A gate never invents, renames,
 * reorders, or drops one: it is handed the manifest's list for its command and
 * must emit exactly one terminal result for every ID in it and no others.
 *
 * There is no reporting path that produces a skipped or unfinished status: they
 * exist in the type only so the validator can reject a result set that contains
 * them, which is what the evidence-classification assertions check.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { MAX_PROBE_TIMEOUT_SECONDS } from "./contract.js";

export const MANIFEST_PATH = "docs/security/E01-assertion-manifest.json";
export const MANIFEST_SHA256 =
  "f03c782f6e9c1be5bcf9e3975b6c25ce0e1df8cc865b67e2b8f7e1ddf6ed07f7";

export interface AssertionRecord {
  id: string;
  command: string;
  category: string;
  target: string;
  setup: string;
  predicate: string;
  timeout_seconds: number;
  evidence_class: "deterministic" | "disposable" | "observed_live" | "dependency_scan";
}

export interface AssertionManifest {
  schema_version: number;
  contract_version: number;
  contract: string;
  expected_totals: Record<string, number>;
  assertions: AssertionRecord[];
}

/** Load and integrity-check the committed inventory. */
export function loadManifest(repoRoot: string): AssertionManifest {
  const path = `${repoRoot}/${MANIFEST_PATH}`;
  const raw = readFileSync(path);
  const digest = createHash("sha256").update(raw).digest("hex");
  if (digest !== MANIFEST_SHA256) {
    throw new Error(
      `assertion manifest hash drift: ${MANIFEST_PATH} is ${digest}, contract pinned ${MANIFEST_SHA256}`,
    );
  }
  const manifest = JSON.parse(raw.toString("utf8")) as AssertionManifest;
  const ids = new Set<string>();
  for (const record of manifest.assertions) {
    if (ids.has(record.id)) throw new Error(`assertion manifest contains duplicate id ${record.id}`);
    ids.add(record.id);
    if (!(record.timeout_seconds > 0)) {
      throw new Error(`assertion ${record.id} has a non-positive timeout`);
    }
    // Probes are capped at ten seconds. Install/build/audit gates and the
    // teardown assertion are not probes and carry their own larger budgets.
    const isProbe =
      (record.evidence_class === "observed_live" || record.evidence_class === "disposable") &&
      record.category !== "teardown";
    if (isProbe && record.timeout_seconds > MAX_PROBE_TIMEOUT_SECONDS) {
      throw new Error(`assertion ${record.id} exceeds the ${MAX_PROBE_TIMEOUT_SECONDS}s probe ceiling`);
    }
  }
  for (const [command, total] of Object.entries(manifest.expected_totals)) {
    const actual = manifest.assertions.filter((a) => a.command === command).length;
    if (actual !== total) {
      throw new Error(`assertion manifest total drift for "${command}": ${actual} != ${total}`);
    }
  }
  return manifest;
}

export function assertionsFor(manifest: AssertionManifest, command: string): AssertionRecord[] {
  const records = manifest.assertions.filter((a) => a.command === command);
  const expected = manifest.expected_totals[command];
  if (expected === undefined) throw new Error(`command "${command}" is not in the manifest`);
  if (records.length !== expected) {
    throw new Error(`command "${command}" expected ${expected} assertions, manifest has ${records.length}`);
  }
  return records;
}

export type AssertionStatus = "pass" | "fail" | "skip" | "todo";

export interface AssertionResult {
  id: string;
  status: AssertionStatus;
  /** Redacted, deterministic where the evidence class is deterministic. */
  detail: string;
}

export interface ValidationProblem {
  code:
    | "duplicate"
    | "missing"
    | "unexpected"
    | "skipped"
    | "todo"
    | "failed"
    | "empty";
  id: string;
  message: string;
}

/**
 * The complete acceptance rule for a command's result set. A failed, skipped,
 * unfinished, duplicate, missing, or unexpected assertion fails its command, and an
 * empty result set fails rather than trivially passing.
 */
export function validateResults(
  expected: readonly AssertionRecord[],
  results: readonly AssertionResult[],
): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  if (expected.length === 0) {
    problems.push({ code: "empty", id: "-", message: "no assertions were expected" });
  }
  if (results.length === 0) {
    problems.push({ code: "empty", id: "-", message: "no assertions were reported" });
  }

  const seen = new Map<string, number>();
  for (const result of results) {
    seen.set(result.id, (seen.get(result.id) ?? 0) + 1);
  }
  for (const [id, count] of seen) {
    if (count > 1) {
      problems.push({ code: "duplicate", id, message: `${id} was reported ${count} times` });
    }
  }

  const expectedIds = new Set(expected.map((record) => record.id));
  for (const record of expected) {
    if (!seen.has(record.id)) {
      problems.push({ code: "missing", id: record.id, message: `${record.id} was never reported` });
    }
  }
  for (const id of seen.keys()) {
    if (!expectedIds.has(id)) {
      problems.push({ code: "unexpected", id, message: `${id} is not assigned to this command` });
    }
  }

  for (const result of results) {
    if (result.status === "skip") {
      problems.push({ code: "skipped", id: result.id, message: `${result.id} was skipped` });
    } else if (result.status === "todo") {
      problems.push({ code: "todo", id: result.id, message: `${result.id} is marked unfinished` });
    } else if (result.status === "fail") {
      problems.push({ code: "failed", id: result.id, message: `${result.id} failed: ${result.detail}` });
    }
  }

  return problems;
}

/**
 * An assertion body. Returning a string records the evidence detail; throwing
 * fails the assertion. There is no third option, by design.
 */
export type AssertionBody = (record: AssertionRecord) => Promise<string> | string;

export class AssertionTimeout extends Error {
  constructor(id: string, seconds: number) {
    super(`${id} exceeded its ${seconds}s budget`);
    this.name = "AssertionTimeout";
  }
}

async function withTimeout(record: AssertionRecord, body: AssertionBody): Promise<string> {
  const budgetMs = record.timeout_seconds * 1000;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => body(record)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new AssertionTimeout(record.id, record.timeout_seconds)), budgetMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface GateOptions {
  command: string;
  records: readonly AssertionRecord[];
  bodies: ReadonlyMap<string, AssertionBody>;
  /** Written to stdout as the gate runs. */
  report?: (line: string) => void;
}

export interface GateOutcome {
  command: string;
  results: AssertionResult[];
  problems: ValidationProblem[];
  passed: number;
  failed: number;
  expected: number;
}

/**
 * Run every assertion assigned to a command, in manifest order, and validate the
 * result set. Output is deterministic: no timings, no timestamps, no paths.
 */
export async function runGate(options: GateOptions): Promise<GateOutcome> {
  const report = options.report ?? ((line: string) => process.stdout.write(`${line}\n`));
  const results: AssertionResult[] = [];

  for (const record of options.records) {
    const body = options.bodies.get(record.id);
    if (!body) {
      results.push({ id: record.id, status: "fail", detail: "no assertion body is implemented" });
      report(`FAIL ${record.id} no assertion body is implemented`);
      continue;
    }
    try {
      const detail = await withTimeout(record, body);
      results.push({ id: record.id, status: "pass", detail });
      report(`PASS ${record.id} ${detail}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      results.push({ id: record.id, status: "fail", detail });
      report(`FAIL ${record.id} ${detail}`);
    }
  }

  const problems = validateResults(options.records, results);
  const failed = results.filter((r) => r.status !== "pass").length;
  const passed = results.length - failed;
  for (const problem of problems) {
    report(`PROBLEM ${problem.code} ${problem.id} ${problem.message}`);
  }
  report(
    `RESULT ${options.command} ${passed}/${options.records.length} pass=${passed} fail=${failed} skip=0 todo=0 problems=${problems.length}`,
  );
  return {
    command: options.command,
    results,
    problems,
    passed,
    failed,
    expected: options.records.length,
  };
}

/** Exit code for a gate: zero only when every assertion passed and nothing was flagged. */
export function gateExitCode(outcome: GateOutcome): number {
  return outcome.problems.length === 0 && outcome.failed === 0 && outcome.passed === outcome.expected
    ? 0
    : 1;
}

// --- probe classification --------------------------------------------------

export type ProbeVerdict =
  | { kind: "denied"; detail: string }
  | { kind: "failure"; detail: string };

/**
 * Classify an anonymous HTTP table probe.
 *
 * Only an explicit refusal counts as a denial. A `200` is a failure because the
 * public-projection allowlist is empty; a `404` is a failure because the target
 * was already proven to exist, so "not found" means the probe missed rather than
 * that access was refused.
 */
export function classifyHttpProbe(status: number, body: string): ProbeVerdict {
  if (status === 401 || status === 403) {
    return { kind: "denied", detail: `http ${status}` };
  }
  if (status === 200) {
    return { kind: "failure", detail: "http 200 on an internal table" };
  }
  if (status === 404) {
    return { kind: "failure", detail: "http 404 after the target was proven to exist" };
  }
  let code: unknown;
  try {
    code = (JSON.parse(body) as { code?: unknown }).code;
  } catch {
    code = undefined;
  }
  if (code === "42501") {
    return { kind: "denied", detail: "postgrest 42501" };
  }
  return { kind: "failure", detail: `unclassified http ${status}` };
}

/** A transport problem is always a failure. It is never evidence of a denial. */
export function classifyTransportError(error: unknown): ProbeVerdict {
  const reason = error instanceof Error ? error.name : "unknown";
  return { kind: "failure", detail: `transport failure (${reason})` };
}

/** Classify a direct SQL probe. Only `42501` and an applicable RLS denial count. */
export function classifySqlProbe(error: unknown): ProbeVerdict {
  if (error === undefined || error === null) {
    return { kind: "failure", detail: "statement succeeded where denial was required" };
  }
  const code = (error as { code?: unknown }).code;
  if (code === "42501") return { kind: "denied", detail: "sqlstate 42501" };
  return { kind: "failure", detail: `sqlstate ${typeof code === "string" ? code : "unknown"}` };
}

export const PROBE_TIMEOUT_CEILING_SECONDS = MAX_PROBE_TIMEOUT_SECONDS;

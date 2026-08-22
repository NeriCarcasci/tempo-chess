import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  SYNTHETIC_FAILURE_PAYLOAD,
  SYNTHETIC_PROVIDER_PAYLOAD,
  SYNTHETIC_SQL,
  SYNTHETIC_UNREACHABLE_DATABASE_URL,
} from "../security/fixtures/synthetic-credentials.js";

const FIXTURE = "dist/pipeline/fire-and-forget.fixture.js";
// The trailing ` | at file:line <- file:line` was added by 67640b0, which made
// a closed log line say *where* an error was thrown instead of what it said.
// That is still closed — a path and a line number carry no message and no
// credential, and the forbidden-substring checks below still run over the whole
// output — so the pattern accepts it rather than the log being reverted to
// saying less.
const CLOSED_LOG_LINE = /^(?:analysis worker failed|analysis import failed|analysis import failure persistence failed): (?:Error|AggregateError|TypeError|RangeError)\/(?:config_rejected|identity_failed|db_unavailable|db_permission_denied|db_constraint|db_error|provider_unavailable|provider_rejected|auth_required|not_found|validation_failed|timeout|cancelled|unknown)(?: \| (?:Error|AggregateError|TypeError|RangeError)\/(?:config_rejected|identity_failed|db_unavailable|db_permission_denied|db_constraint|db_error|provider_unavailable|provider_rejected|auth_required|not_found|validation_failed|timeout|cancelled|unknown))*(?: \| at (?:[\w./-]+:\d+)(?: <- [\w./-]+:\d+)*)?$/;

function runScenario(scenario: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, [FIXTURE, scenario], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      DATABASE_URL: SYNTHETIC_UNREACHABLE_DATABASE_URL,
      DATABASE_ROLE: "forma_api",
      FORMA_ENV: "development",
    },
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

function assertClosedProcessOutput(
  result: ReturnType<typeof runScenario>,
  expectedLines: readonly string[],
): void {
  assert.equal(result.status, 0, "adversarial child process did not exit cleanly");
  assert.equal(result.stdout, "", "adversarial child process wrote to stdout");
  const lines = result.stderr.trim().split("\n");
  assert.deepEqual(
    lines.map((line) => line.slice(0, line.indexOf(":"))),
    expectedLines,
    "adversarial child process emitted unexpected classifications",
  );
  for (const line of lines) assert.match(line, CLOSED_LOG_LINE);

  const combined = `${result.stdout}\n${result.stderr}`;
  const rawUrl = new URL(SYNTHETIC_UNREACHABLE_DATABASE_URL);
  for (const forbidden of [
    rawUrl.hostname,
    rawUrl.password,
    SYNTHETIC_UNREACHABLE_DATABASE_URL,
    SYNTHETIC_SQL,
    SYNTHETIC_PROVIDER_PAYLOAD,
    SYNTHETIC_FAILURE_PAYLOAD,
    "UnhandledPromiseRejection",
    "node:internal",
  ]) {
    assert.equal(combined.includes(forbidden), false, "adversarial child process exposed raw failure detail");
  }
}

function adversarialOuterWorkerDatabaseFailure(): void {
  assertClosedProcessOutput(runScenario("outer-worker-database-failure"), ["analysis worker failed"]);
}

function adversarialImportDoubleFailure(): void {
  assertClosedProcessOutput(runScenario("import-double-failure"), [
    "analysis import failed",
    "analysis import failure persistence failed",
  ]);
}

adversarialOuterWorkerDatabaseFailure();
adversarialImportDoubleFailure();
console.log("fire-and-forget real-process adversarial tests passed");

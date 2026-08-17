import "../v1/gates/unit-env.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DISPATCH_MODES,
  OUTBOX_STATES,
  QUEUES,
  RESOURCE_CLASSES,
  RETRY_CLASSES,
  WORKFLOW_KINDS,
  WORKFLOW_STATES,
  WORK_ITEM_STATUSES,
  isTerminalWorkItemStatus,
  isTerminalWorkflowState,
} from "./contract.js";
import {
  BACKOFF,
  WorkFailure,
  backoffSeconds,
  classifyFailure,
  isRetryable,
  toRetryClass,
} from "./retry.js";
import {
  InvalidTransitionError,
  assertWorkItemTransition,
  assertWorkflowTransition,
  deriveProgress,
  deriveWorkflowState,
  emptyTally,
  tally,
  workItemTransitionAllowed,
  workflowTransitionAllowed,
} from "./state.js";
import { safeWorkflowError } from "./errors.js";
import {
  TASK_PAYLOAD_FIELDS,
  assertMinimalTaskPayload,
  attemptToken,
  attemptTokenMatches,
  buildTaskPayload,
} from "./tokens.js";
import { OPS_EVENT_FIELDS, opsEventLine } from "./telemetry.js";
import { inspectInternalConfig } from "../v1/auth/oidc.js";
import { inspectTasksConfig, workerPath } from "./tasks.js";
import { requiresIdempotencyKey } from "../v1/registry.js";
import { setSigningKeyForTest } from "../v1/signing.js";

/**
 * Unit gate for the E04 work ledger.
 *
 * Deterministic and offline. Everything that needs a real PostgreSQL — the
 * conditional claim, the outbox, lease recovery, the grants — is proven by
 * `gates/integration.ts`, `gates/security.ts` and `gates/migration.ts`. What is
 * here is the logic those gates cannot isolate: the state machines, the retry
 * arithmetic, the payload minimality and the vocabularies the database also
 * enforces.
 */

let failures = 0;
function check(name: string, run: () => void): void {
  try {
    run();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${name}: ${(error as Error).message}`);
  }
}

setSigningKeyForTest(Buffer.from("e04-unit-gate-signing-key-0123456789abcdef", "utf8"));

const MIGRATION = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "drizzle", "0014_e04_work_ledger.sql"),
  "utf8",
);

console.log("frozen vocabularies match the migration\n");

/**
 * The check constraints and these constants are two copies of one contract.
 * A value that exists in only one of them is a row the database refuses at
 * runtime or a state the code cannot express — both are silent until the worst
 * moment, so the drift is caught here instead.
 */
for (const [label, values] of [
  ["workflow state", WORKFLOW_STATES],
  ["work item status", WORK_ITEM_STATUSES],
  ["resource class", RESOURCE_CLASSES],
  ["retry class", RETRY_CLASSES],
  ["workflow kind", WORKFLOW_KINDS],
  ["dispatch mode", DISPATCH_MODES],
  ["outbox state", OUTBOX_STATES],
  ["queue", QUEUES],
] as const) {
  check(`every ${label} appears in a migration check constraint`, () => {
    for (const value of values) {
      assert.ok(
        MIGRATION.includes(`'${value}'`),
        `${value} is declared in code but not constrained in 0014`,
      );
    }
  });
}

console.log("\nstate machines");

check("a terminal workflow state has no outgoing transition", () => {
  for (const state of WORKFLOW_STATES) {
    if (!isTerminalWorkflowState(state)) continue;
    for (const target of WORKFLOW_STATES) {
      if (target === state) continue;
      assert.equal(workflowTransitionAllowed(state, target), false, `${state} -> ${target}`);
    }
  }
});

check("a terminal work item status has no outgoing transition", () => {
  for (const status of WORK_ITEM_STATUSES) {
    if (!isTerminalWorkItemStatus(status)) continue;
    for (const target of WORK_ITEM_STATUSES) {
      if (target === status) continue;
      assert.equal(workItemTransitionAllowed(status, target), false, `${status} -> ${target}`);
    }
  }
});

check("a repeated transition is allowed so a retry is not an error", () => {
  assert.equal(workflowTransitionAllowed("running", "running"), true);
  assert.equal(workItemTransitionAllowed("leased", "leased"), true);
});

check("an invalid transition names both ends", () => {
  assert.throws(
    () => assertWorkflowTransition("succeeded", "running"),
    (error: unknown) =>
      error instanceof InvalidTransitionError && /succeeded -> running/.test((error as Error).message),
  );
  assert.throws(() => assertWorkItemTransition("dead", "ready"), InvalidTransitionError);
});

check("blocked work cannot be leased without becoming ready", () => {
  assert.equal(workItemTransitionAllowed("blocked", "leased"), false);
  assert.equal(workItemTransitionAllowed("blocked", "ready"), true);
});

console.log("\nweighted progress");

check("percent is null while the total is unknown", () => {
  assert.equal(deriveProgress(emptyTally()).percent, null);
  assert.equal(deriveProgress(emptyTally()).totalWeight, 0);
});

check("progress is weighted, not counted", () => {
  const progress = deriveProgress(
    tally([
      { status: "succeeded", weight: 90 },
      { status: "ready", weight: 10 },
    ]),
  );
  assert.equal(progress.completedWeight, 90);
  assert.equal(progress.totalWeight, 100);
  assert.equal(progress.percent, 90);
});

check("cancelling outstanding work raises the percentage rather than lowering it", () => {
  const before = deriveProgress(
    tally([
      { status: "succeeded", weight: 50 },
      { status: "ready", weight: 50 },
    ]),
  );
  const after = deriveProgress(
    tally([
      { status: "succeeded", weight: 50 },
      { status: "cancelled", weight: 50 },
    ]),
  );
  assert.equal(before.percent, 50);
  assert.equal(after.percent, 100);
  assert.ok(after.percent! >= before.percent!);
});

check("dead work stalls progress instead of completing it", () => {
  const progress = deriveProgress(
    tally([
      { status: "succeeded", weight: 50 },
      { status: "dead", weight: 50 },
    ]),
  );
  assert.equal(progress.percent, 50);
});

console.log("\nworkflow settlement");

check("a workflow with no items stays where it is", () => {
  assert.equal(deriveWorkflowState("queued", emptyTally(), false), "queued");
});

check("work that has started makes the workflow running", () => {
  assert.equal(
    deriveWorkflowState("queued", tally([{ status: "leased", weight: 1 }]), false),
    "running",
  );
  assert.equal(
    deriveWorkflowState("queued", tally([{ status: "ready", weight: 1 }]), false),
    "queued",
  );
});

check("all succeeded settles as succeeded", () => {
  assert.equal(
    deriveWorkflowState("running", tally([{ status: "succeeded", weight: 1 }]), false),
    "succeeded",
  );
});

check("a dead item fails the workflow", () => {
  assert.equal(
    deriveWorkflowState(
      "running",
      tally([
        { status: "succeeded", weight: 1 },
        { status: "dead", weight: 1 },
      ]),
      false,
    ),
    "failed",
  );
});

check("a cancellation with a leased attempt is cancelling, not cancelled", () => {
  assert.equal(
    deriveWorkflowState(
      "running",
      tally([
        { status: "leased", weight: 1 },
        { status: "cancelled", weight: 1 },
      ]),
      true,
    ),
    "cancelling",
  );
});

check("cancellation does not undo work that already succeeded", () => {
  assert.equal(
    deriveWorkflowState("cancelling", tally([{ status: "succeeded", weight: 1 }]), true),
    "succeeded",
  );
});

check("a terminal workflow is never re-derived", () => {
  for (const state of ["succeeded", "failed", "cancelled"] as const) {
    assert.equal(deriveWorkflowState(state, tally([{ status: "ready", weight: 1 }]), false), state);
  }
});

check("every derived state is a transition the machine allows", () => {
  const shapes = [
    [{ status: "ready" as const, weight: 1 }],
    [{ status: "leased" as const, weight: 1 }],
    [{ status: "succeeded" as const, weight: 1 }],
    [{ status: "dead" as const, weight: 1 }],
    [{ status: "cancelled" as const, weight: 1 }],
    [
      { status: "leased" as const, weight: 1 },
      { status: "cancelled" as const, weight: 1 },
    ],
  ];
  for (const from of WORKFLOW_STATES) {
    for (const shape of shapes) {
      for (const cancelled of [false, true]) {
        const next = deriveWorkflowState(from, tally(shape), cancelled);
        assert.ok(
          workflowTransitionAllowed(from, next),
          `derived ${from} -> ${next} is not an allowed transition`,
        );
      }
    }
  }
});

console.log("\nretry classification and backoff");

check("only transient and rate-limit failures are retried", () => {
  for (const retryClass of RETRY_CLASSES) {
    assert.equal(
      isRetryable(retryClass),
      retryClass === "transient" || retryClass === "rate_limit",
      retryClass,
    );
  }
});

check("a non-retryable class is dead on the first attempt", () => {
  const decision = classifyFailure({
    workItemId: "1",
    attempt: 1,
    maxAttempts: 5,
    retryClass: "invalid_input",
  });
  assert.equal(decision.status, "dead");
  assert.equal(decision.delaySeconds, 0);
});

check("a retryable class is dead once attempts are exhausted", () => {
  assert.equal(
    classifyFailure({ workItemId: "1", attempt: 5, maxAttempts: 5, retryClass: "transient" }).status,
    "dead",
  );
  assert.equal(
    classifyFailure({ workItemId: "1", attempt: 4, maxAttempts: 5, retryClass: "transient" }).status,
    "retry_wait",
  );
});

check("backoff grows and is capped", () => {
  let previous = 0;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const delay = backoffSeconds({ workItemId: "42", attempt, retryClass: "transient" });
    assert.ok(delay >= previous || delay >= BACKOFF.transient.maxSeconds, `attempt ${attempt}`);
    assert.ok(delay <= BACKOFF.transient.maxSeconds * (1 + BACKOFF.transient.jitterFraction));
    previous = delay;
  }
});

check("a rate limit waits far longer than a transient failure", () => {
  assert.ok(
    backoffSeconds({ workItemId: "7", attempt: 1, retryClass: "rate_limit" }) >=
      BACKOFF.rate_limit.baseSeconds,
  );
  assert.ok(
    backoffSeconds({ workItemId: "7", attempt: 1, retryClass: "rate_limit" }) >
      backoffSeconds({ workItemId: "7", attempt: 1, retryClass: "transient" }),
  );
});

check("backoff is deterministic for one item and spread across items", () => {
  const first = backoffSeconds({ workItemId: "100", attempt: 3, retryClass: "transient" });
  assert.equal(first, backoffSeconds({ workItemId: "100", attempt: 3, retryClass: "transient" }));
  const others = new Set(
    Array.from({ length: 40 }, (_, index) =>
      backoffSeconds({ workItemId: String(index), attempt: 3, retryClass: "transient" }),
    ),
  );
  assert.ok(others.size > 1, "jitter did not spread identical attempts across items");
});

check("a provider Retry-After raises the delay but never past the ceiling", () => {
  const raised = backoffSeconds({
    workItemId: "9",
    attempt: 1,
    retryClass: "rate_limit",
    retryAfterSeconds: 600,
  });
  assert.ok(raised >= 600);
  const clamped = backoffSeconds({
    workItemId: "9",
    attempt: 1,
    retryClass: "rate_limit",
    retryAfterSeconds: 86_400,
  });
  assert.ok(clamped <= BACKOFF.rate_limit.maxSeconds * (1 + BACKOFF.rate_limit.jitterFraction));
});

check("a Retry-After of zero does not licence an immediate retry", () => {
  const delay = backoffSeconds({
    workItemId: "9",
    attempt: 1,
    retryClass: "rate_limit",
    retryAfterSeconds: 0,
  });
  assert.ok(delay >= BACKOFF.rate_limit.baseSeconds);
});

check("scheduling a backoff for a dead class is refused, not silently zero", () => {
  assert.throws(() => backoffSeconds({ workItemId: "1", attempt: 1, retryClass: "permanent" }));
});

check("an unknown class reported by a worker reads as transient", () => {
  assert.equal(toRetryClass("nonsense"), "transient");
  assert.equal(toRetryClass(undefined), "transient");
  assert.equal(toRetryClass("budget"), "budget");
});

check("every retry class has a safe workflow error and none leaks a detail", () => {
  for (const retryClass of RETRY_CLASSES) {
    const error = safeWorkflowError(retryClass);
    assert.ok(error.code.startsWith("WORK_FAILED_"));
    assert.ok(error.message.length > 0 && error.message.length <= 500);
  }
  assert.equal(safeWorkflowError(null).code, "WORK_FAILED_PERMANENT");
});

check("a work failure carries a class, not a formatted provider message", () => {
  const failure = new WorkFailure("rate_limit", "provider_429", "lichess asked us to wait", 90);
  assert.equal(failure.retryClass, "rate_limit");
  assert.equal(failure.retryAfterSeconds, 90);
});

console.log("\nattempt tokens and the queue payload");

check("a token verifies for its own epoch only", () => {
  const token = attemptToken({ workItemId: "12", dispatchEpoch: 3 });
  assert.equal(attemptTokenMatches({ workItemId: "12", dispatchEpoch: 3 }, token), true);
  assert.equal(attemptTokenMatches({ workItemId: "12", dispatchEpoch: 4 }, token), false);
  assert.equal(attemptTokenMatches({ workItemId: "13", dispatchEpoch: 3 }, token), false);
});

check("a forged or malformed token never matches", () => {
  assert.equal(attemptTokenMatches({ workItemId: "12", dispatchEpoch: 3 }, ""), false);
  assert.equal(attemptTokenMatches({ workItemId: "12", dispatchEpoch: 3 }, "zz"), false);
  assert.equal(
    attemptTokenMatches({ workItemId: "12", dispatchEpoch: 3 }, "a".repeat(64)),
    false,
  );
});

check("the queue payload carries exactly what platform spec 7 allows", () => {
  const payload = buildTaskPayload({ workItemId: "5", dispatchEpoch: 0 }, "00-abc-def-01");
  assert.deepEqual(Object.keys(payload).sort(), ["attemptToken", "traceparent", "workItemId"]);
  assert.deepEqual([...TASK_PAYLOAD_FIELDS].sort(), ["attemptToken", "traceparent", "workItemId"]);
  assertMinimalTaskPayload(payload as unknown as Record<string, unknown>);
});

check("a payload with any extra field is refused before it leaves the process", () => {
  assert.throws(() =>
    assertMinimalTaskPayload({ workItemId: "5", attemptToken: "x", pgn: "1. e4 e5" }),
  );
  assert.throws(() => assertMinimalTaskPayload({ workItemId: "5", attemptToken: "x", userId: "u" }));
});

check("the worker path names the item and nothing else", () => {
  assert.equal(workerPath("42"), "/internal/v1/work-items/42/execute");
});

console.log("\nobservability");

check("an ops event emits only its declared fields", () => {
  const line = opsEventLine({
    event: "work_item_transition",
    traceId: "t",
    workItemId: "1",
    workflowId: "w",
    taskType: "legacy_import_shadow",
    resourceClass: "ingestion",
    from: "ready",
    to: "leased",
    attempt: 1,
    maxAttempts: 5,
    retryClass: null,
    errorCode: null,
    durationMs: 4,
    duplicateDelivery: false,
  });
  assert.deepEqual(
    Object.keys(JSON.parse(line)).sort(),
    [...OPS_EVENT_FIELDS.work_item_transition].sort(),
  );
});

check("an ops event cannot carry a field that was never declared", () => {
  const line = opsEventLine({
    event: "lease_recovery",
    traceId: null,
    examined: 1,
    reconciledSucceeded: 1,
    requeued: 0,
    deadLettered: 0,
    durationMs: 2,
    // A field a future call site adds by accident.
    payload: { pgn: "1. e4" },
  } as never);
  assert.equal(line.includes("pgn"), false);
  assert.equal(line.includes("payload"), false);
});

console.log("\nconfiguration gates");

check("internal ingress refuses to serve without an audience and both allowlists", () => {
  const findings = inspectInternalConfig({});
  assert.deepEqual(findings.map((finding) => finding.code).sort(), [
    "FORMA_INTERNAL_AUDIENCE_MISSING",
    "FORMA_OPS_SERVICE_ACCOUNTS_MISSING",
    "FORMA_WORKER_SERVICE_ACCOUNTS_MISSING",
  ]);
  assert.deepEqual(
    inspectInternalConfig({
      FORMA_INTERNAL_AUDIENCE: "https://worker.invalid",
      FORMA_OPS_SERVICE_ACCOUNTS: "ops@example.iam.gserviceaccount.com",
      FORMA_WORKER_SERVICE_ACCOUNTS: "worker@example.iam.gserviceaccount.com",
    }),
    [],
  );
});

check("a real Cloud Tasks endpoint may not dispatch without an invoker identity", () => {
  const base = {
    FORMA_TASKS_PROJECT: "p",
    FORMA_TASKS_LOCATION: "europe-west1",
    FORMA_WORKER_BASE_URL: "https://worker.invalid",
    FORMA_INTERNAL_AUDIENCE: "https://worker.invalid",
  };
  assert.deepEqual(
    inspectTasksConfig(base).map((finding) => finding.code),
    ["FORMA_TASKS_INVOKER_SERVICE_ACCOUNT_MISSING"],
  );
  assert.deepEqual(
    inspectTasksConfig({ ...base, FORMA_TASKS_ENDPOINT: "http://127.0.0.1:8123" }),
    [],
  );
});

console.log("\nthe idempotency rule the internal surface is allowed to vary");

check("every /v1 command still requires an idempotency key", () => {
  assert.equal(requiresIdempotencyKey({ kind: "command", surface: "v1" }), true);
  assert.equal(requiresIdempotencyKey({ kind: "read", surface: "v1" }), false);
});

check("a ledger-idempotent command is refused on the product surface", () => {
  assert.throws(() => requiresIdempotencyKey({ kind: "command", idempotency: "ledger", surface: "v1" }));
  assert.equal(
    requiresIdempotencyKey({ kind: "command", idempotency: "ledger", surface: "internal" }),
    false,
  );
});

console.log(failures === 0 ? "\nE04 work ledger unit gate: pass" : `\nE04 work ledger unit gate: ${failures} failing`);
process.exit(failures === 0 ? 0 : 1);

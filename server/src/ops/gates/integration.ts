import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet } from "jose";
import { GateReport, startLedgerHarness, WORKER_SERVICE_ACCOUNT, OPS_SERVICE_ACCOUNT } from "./harness.js";

/**
 * Integration gate for the E04 work ledger.
 *
 * What this proves that a unit test cannot: that the claim really is atomic
 * under a duplicate delivery, that a committed command survives a process that
 * never dispatches it, that an expired lease is reconciled against its output
 * before it is retried, that the dependency DAG really releases and really
 * fails closed, and that the acknowledgement a queue receives always follows a
 * committed transition.
 *
 * Everything it creates it leaves in its own disposable cluster; nothing
 * asserts that a table is globally empty. It runs only against a disposable
 * server and a loopback queue.
 */

const report = new GateReport("E04 work ledger integration gate");
const harness = await startLedgerHarness();
const { app, sql, apiSql, ledger, dispatch, handlers, queue, tokens } = harness;

// --- a signed-in owner, using the production verifier ----------------------

const ISSUER = `${process.env.SUPABASE_URL}/auth/v1`;
const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
const keySet: JSONWebKeySet = {
  keys: [{ ...(await exportJWK(publicKey)), kid: "gate-signing-key", alg: "ES256", use: "sig" }],
};
harness.verifier.setTokenVerifierForTest(
  new harness.verifier.TokenVerifier({
    supabaseUrl: process.env.SUPABASE_URL!,
    supabaseAnonKey: "gate",
    keySet,
    async getUser() {
      return null;
    },
  }),
);

const OWNER = randomUUID();
const OTHER_OWNER = randomUUID();

async function userToken(actor = OWNER): Promise<string> {
  return new SignJWT({ email: `${actor}@gate.invalid` })
    .setProtectedHeader({ alg: "ES256", kid: "gate-signing-key" })
    .setSubject(actor)
    .setIssuer(ISSUER)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}

async function json(response: Response): Promise<Record<string, never>> {
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, never>;
  } catch {
    throw new Error(`expected JSON, got ${response.status} ${text.slice(0, 160)}`);
  }
}

/**
 * Both owners need a profile row: the kernel builds its context from one.
 * Written on the API connection, because `forma_ops` has no reach into the
 * legacy `public` schema at all — which is itself worth stating.
 */
for (const actor of [OWNER, OTHER_OWNER]) {
  await apiSql`insert into profiles (id, email) values (${actor}, ${`${actor}@gate.invalid`})
               on conflict (id) do nothing`;
}

const worker = { deployment: "gate-worker", revision: "r1", instance: randomUUID().slice(0, 8) };

/** POST to the private worker entry point exactly as Cloud Tasks would. */
async function deliver(
  workItemId: string,
  attemptToken: string,
  options: { token?: string } = {},
): Promise<Response> {
  const token = options.token ?? (await harness.serviceToken());
  return app.request(`/internal/v1/work-items/${workItemId}/execute`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ attemptToken }),
  });
}

async function itemRow(id: string): Promise<Record<string, never>> {
  const rows = await sql`select * from ops.work_items where id = ${id}::bigint`;
  return rows[0] as Record<string, never>;
}

async function workflowRow(id: string): Promise<Record<string, never>> {
  const rows = await sql`select * from ops.workflows where id = ${id}::uuid`;
  return rows[0] as Record<string, never>;
}

let handlerRuns = 0;
handlers.registerHandler("gate_succeeds", async () => {
  handlerRuns += 1;
  return { outputRef: `gate:${handlerRuns}`, metrics: { outputCount: 1 } };
});

const queueItem = (key: string, extra: Record<string, unknown> = {}) => ({
  taskType: "gate_succeeds",
  resourceClass: "aggregation" as const,
  idempotencyKey: key,
  queue: "analysis" as const,
  ...extra,
});

// --- a committed command cannot be lost ------------------------------------

report.section("a committed command survives the process that made it");

let firstWorkflow = "";
let firstItem = "";
await report.check("the workflow, its item and its outbox row commit together", async () => {
  const created = await ledger.createWorkflow({
    kind: "maintenance",
    ownerProfileId: OWNER,
    items: [queueItem(`commit-${randomUUID()}`)],
  });
  firstWorkflow = created.workflowId;
  firstItem = created.itemIds[0]!;
  const outbox = await sql`
    select state, payload from ops.outbox_events where payload ->> 'workItemId' = ${firstItem}`;
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0]!.state, "pending");
  assert.equal((await itemRow(firstItem)).status, "ready");
});

await report.check("a dispatcher that never ran leaves the row for the next one", async () => {
  // No dispatch has happened yet, and the item is still ready. This is the
  // crash window: the command committed, the process died, nothing was sent.
  const pending = await sql`
    select count(*)::int as n from ops.outbox_events
    where state = 'pending' and payload ->> 'workItemId' = ${firstItem}`;
  assert.equal(pending[0]!.n, 1);
});

let deliveredToken = "";
await report.check("the next dispatch delivers it to the right queue", async () => {
  const built = harness.tasks.taskTransport();
  assert.ok("transport" in built, "task transport should be configured in the gate");
  const result = await dispatch.dispatchOutbox((built as { transport: never }).transport as never);
  assert.equal(result.published >= 1, true);
  const task = queue.tasks.find((entry) => entry.payload.workItemId === firstItem);
  assert.ok(task, "no task was created for the committed work item");
  assert.equal(task!.queue, "analysis");
  deliveredToken = task!.payload.attemptToken as string;
});

await report.check("the queue message carries only identity and trace metadata", async () => {
  const task = queue.tasks.find((entry) => entry.payload.workItemId === firstItem)!;
  assert.deepEqual(Object.keys(task.payload).sort(), ["attemptToken", "workItemId"]);
  assert.equal(task.url.endsWith(`/internal/v1/work-items/${firstItem}/execute`), true);
  assert.equal(task.oidcAudience, process.env.FORMA_INTERNAL_AUDIENCE);
});

await report.check("an outbox row is published exactly once", async () => {
  const rows = await sql`
    select state, published_at from ops.outbox_events where payload ->> 'workItemId' = ${firstItem}`;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.state, "published");
  assert.notEqual(rows[0]!.published_at, null);
});

// --- delivery, duplicates and acknowledgement ------------------------------

report.section("delivery is at-least-once and the effect is exactly once");

await report.check("the first delivery runs the work and acknowledges after the commit", async () => {
  const before = handlerRuns;
  const response = await deliver(firstItem, deliveredToken);
  assert.equal(response.status, 204);
  assert.equal(handlerRuns, before + 1);
  // The acknowledgement is only correct if the transition is already durable.
  const row = await itemRow(firstItem);
  assert.equal(row.status, "succeeded");
  assert.equal(row.lease_owner, null);
  assert.equal((await workflowRow(firstWorkflow)).state, "succeeded");
});

await report.check("a duplicate delivery of the same message has no second effect", async () => {
  const before = handlerRuns;
  const response = await deliver(firstItem, deliveredToken);
  assert.equal(response.status, 204);
  assert.equal(handlerRuns, before);
});

await report.check("a superseded attempt token is acknowledged without running", async () => {
  const created = await ledger.createWorkflow({
    kind: "maintenance",
    ownerProfileId: OWNER,
    items: [queueItem(`stale-${randomUUID()}`)],
  });
  const item = created.itemIds[0]!;
  const stale = tokens.attemptToken({ workItemId: item, dispatchEpoch: 99 });
  const before = handlerRuns;
  const response = await deliver(item, stale);
  assert.equal(response.status, 204);
  assert.equal(handlerRuns, before);
  assert.equal((await itemRow(item)).status, "ready");
});

await report.check("an attempt records deployment, worker and outcome", async () => {
  const attempts = await sql`
    select attempt_number, deployment, worker_instance, outcome, finished_at
    from ops.work_attempts where work_item_id = ${firstItem}::bigint`;
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]!.outcome, "succeeded");
  assert.notEqual(attempts[0]!.finished_at, null);
});

await report.check("attempt history cannot be rewritten once it is finished", async () => {
  await assert.rejects(
    sql`update ops.work_attempts set outcome = 'failed' where work_item_id = ${firstItem}::bigint`,
    /append-only/,
  );
});

// --- retry, backoff and dead letters ---------------------------------------

report.section("retry classification is durable");

let failingItem = "";
let failingWorkflow = "";
let failMode: "transient" | "permanent" = "transient";
handlers.registerHandler("gate_fails", async () => {
  const { WorkFailure } = await import("../retry.js");
  throw failMode === "transient"
    ? new WorkFailure("transient", "gate_transient")
    : new WorkFailure("invalid_input", "gate_invalid");
});

await report.check("a transient failure schedules a durable next attempt", async () => {
  const created = await ledger.createWorkflow({
    kind: "maintenance",
    ownerProfileId: OWNER,
    items: [queueItem(`retry-${randomUUID()}`, { taskType: "gate_fails", maxAttempts: 3 })],
  });
  failingWorkflow = created.workflowId;
  failingItem = created.itemIds[0]!;
  const token = tokens.attemptToken({ workItemId: failingItem, dispatchEpoch: 0 });
  assert.equal((await deliver(failingItem, token)).status, 204);

  const row = await itemRow(failingItem);
  assert.equal(row.status, "retry_wait");
  assert.equal(row.error_class, "transient");
  assert.equal(row.attempt_count, 1);
  assert.equal(row.dispatch_epoch, 1);
  assert.ok(new Date(row.available_at as never) > new Date(), "next attempt is not in the future");
});

await report.check("the retry is enqueued for dispatch with its own epoch", async () => {
  const rows = await sql`
    select state, payload from ops.outbox_events
    where payload ->> 'workItemId' = ${failingItem} order by id`;
  assert.equal(rows.length, 2);
  assert.equal((rows[1]!.payload as { dispatchEpoch: number }).dispatchEpoch, 1);
});

await report.check("a dispatched retry is scheduled, not sent immediately", async () => {
  const built = harness.tasks.taskTransport() as { transport: never };
  await dispatch.dispatchOutbox(built.transport as never);
  const task = queue.tasks.find(
    (entry) => entry.payload.workItemId === failingItem && entry.name.endsWith("-1"),
  );
  assert.ok(task, "the retry was not dispatched");
  assert.ok(task!.scheduleTime, "the retry was dispatched without a schedule time");
});

await report.check("a delivery before the scheduled time is not acknowledged", async () => {
  const token = tokens.attemptToken({ workItemId: failingItem, dispatchEpoch: 1 });
  const response = await deliver(failingItem, token);
  assert.equal(response.status, 503);
  const body = await json(response);
  assert.equal((body as unknown as { code: string }).code, "WORK_NOT_READY");
});

await report.check("an unretryable failure is dead on the first attempt", async () => {
  failMode = "permanent";
  const created = await ledger.createWorkflow({
    kind: "maintenance",
    ownerProfileId: OWNER,
    items: [queueItem(`dead-${randomUUID()}`, { taskType: "gate_fails" })],
  });
  const item = created.itemIds[0]!;
  const token = tokens.attemptToken({ workItemId: item, dispatchEpoch: 0 });
  assert.equal((await deliver(item, token)).status, 204);
  const row = await itemRow(item);
  assert.equal(row.status, "dead");
  assert.equal(row.error_class, "invalid_input");
  assert.equal(row.attempt_count, 1);

  const workflow = await workflowRow(created.workflowId);
  assert.equal(workflow.state, "failed");
  assert.equal(workflow.error_code, "WORK_FAILED_INVALID_INPUT");
  assert.equal(String(workflow.error_message).includes("gate_invalid"), false);
  failMode = "transient";
});

await report.check("work routed to a deployment with no handler is dead, not retried", async () => {
  const created = await ledger.createWorkflow({
    kind: "maintenance",
    ownerProfileId: OWNER,
    items: [queueItem(`unsupported-${randomUUID()}`, { taskType: "gate_not_registered" })],
  });
  const item = created.itemIds[0]!;
  const token = tokens.attemptToken({ workItemId: item, dispatchEpoch: 0 });
  assert.equal((await deliver(item, token)).status, 204);
  const row = await itemRow(item);
  assert.equal(row.status, "dead");
  assert.equal(row.error_class, "unsupported");
  assert.equal(row.error_code, "no_handler");
});

// --- dependencies ----------------------------------------------------------

report.section("the dependency DAG");

await report.check("a dependent stays blocked and is released on success", async () => {
  const created = await ledger.createWorkflow({
    kind: "maintenance",
    ownerProfileId: OWNER,
    items: [
      queueItem(`dep-a-${randomUUID()}`, { weight: 3 }),
      queueItem(`dep-b-${randomUUID()}`, { weight: 1, dependsOn: [0] }),
    ],
  });
  const [a, b] = created.itemIds;
  assert.equal((await itemRow(b!)).status, "blocked");
  const outboxForB = await sql`
    select count(*)::int as n from ops.outbox_events where payload ->> 'workItemId' = ${b!}`;
  assert.equal(outboxForB[0]!.n, 0, "a blocked item must not be dispatched");

  const token = tokens.attemptToken({ workItemId: a!, dispatchEpoch: 0 });
  assert.equal((await deliver(a!, token)).status, 204);
  const released = await itemRow(b!);
  assert.equal(released.status, "ready");
  assert.equal(released.dispatch_epoch, 1);
  const enqueued = await sql`
    select count(*)::int as n from ops.outbox_events where payload ->> 'workItemId' = ${b!}`;
  assert.equal(enqueued[0]!.n, 1);
});

await report.check("a dead upstream item takes its blocked descendants with it", async () => {
  failMode = "permanent";
  const created = await ledger.createWorkflow({
    kind: "maintenance",
    ownerProfileId: OWNER,
    items: [
      queueItem(`chain-a-${randomUUID()}`, { taskType: "gate_fails" }),
      queueItem(`chain-b-${randomUUID()}`, { dependsOn: [0] }),
      queueItem(`chain-c-${randomUUID()}`, { dependsOn: [1] }),
    ],
  });
  const [a, b, c] = created.itemIds;
  const token = tokens.attemptToken({ workItemId: a!, dispatchEpoch: 0 });
  assert.equal((await deliver(a!, token)).status, 204);
  assert.equal((await itemRow(b!)).status, "dead");
  assert.equal((await itemRow(c!)).status, "dead");
  assert.equal((await itemRow(c!)).error_code, "dependency_failed");
  // The workflow settles rather than waiting forever on work that cannot run.
  assert.equal((await workflowRow(created.workflowId)).state, "failed");
  failMode = "transient";
});

await report.check("a cycle cannot be represented", async () => {
  const created = await ledger.createWorkflow({
    kind: "maintenance",
    ownerProfileId: OWNER,
    items: [queueItem(`cycle-a-${randomUUID()}`), queueItem(`cycle-b-${randomUUID()}`, { dependsOn: [0] })],
  });
  const [a, b] = created.itemIds;
  await assert.rejects(
    sql`insert into ops.work_item_dependencies (work_item_id, depends_on_work_item_id)
        values (${a!}::bigint, ${b!}::bigint)`,
    /acyclic/,
  );
});

// --- cancellation ----------------------------------------------------------

report.section("cancellation");

await report.check("cancelling stops unleased work immediately", async () => {
  const created = await ledger.createWorkflow({
    kind: "maintenance",
    ownerProfileId: OWNER,
    items: [queueItem(`cancel-${randomUUID()}`), queueItem(`cancel-b-${randomUUID()}`, { dependsOn: [0] })],
  });
  const result = await ledger.requestCancellation(created.workflowId, OWNER);
  assert.equal(result.outcome, "accepted");
  assert.equal(result.state, "cancelled");
  for (const id of created.itemIds) assert.equal((await itemRow(id)).status, "cancelled");
});

await report.check("a delivery for cancelled work does not run it", async () => {
  const created = await ledger.createWorkflow({
    kind: "maintenance",
    ownerProfileId: OWNER,
    items: [queueItem(`cancel-deliver-${randomUUID()}`)],
  });
  const item = created.itemIds[0]!;
  const token = tokens.attemptToken({ workItemId: item, dispatchEpoch: 0 });
  await ledger.requestCancellation(created.workflowId, OWNER);
  const before = handlerRuns;
  assert.equal((await deliver(item, token)).status, 204);
  assert.equal(handlerRuns, before);
  assert.equal((await itemRow(item)).status, "cancelled");
});

await report.check("a leased handler is asked to stop, not killed", async () => {
  let observed: boolean | null = null;
  const created = await ledger.createWorkflow({
    kind: "maintenance",
    ownerProfileId: OWNER,
    items: [queueItem(`cancel-leased-${randomUUID()}`, { taskType: "gate_cooperative" })],
  });
  const item = created.itemIds[0]!;
  handlers.registerHandler("gate_cooperative", async (context) => {
    await ledger.requestCancellation(created.workflowId, OWNER);
    const checkpoint = await context.checkpoint();
    observed = checkpoint.continue;
    return {};
  });
  const token = tokens.attemptToken({ workItemId: item, dispatchEpoch: 0 });
  assert.equal((await deliver(item, token)).status, 204);
  assert.equal(observed, false, "the handler was not told to stop");
  assert.equal((await itemRow(item)).status, "cancelled");
  assert.equal((await workflowRow(created.workflowId)).state, "cancelled");
  handlers.unregisterHandler("gate_cooperative");
});

// --- lease expiry ----------------------------------------------------------

report.section("expired leases reconcile before they retry");

await report.check("an expired lease whose output landed is completed, not repeated", async () => {
  const created = await ledger.createWorkflow({
    kind: "maintenance",
    ownerProfileId: OWNER,
    items: [queueItem(`recover-done-${randomUUID()}`)],
  });
  const item = created.itemIds[0]!;
  // A worker that wrote its output and died before releasing the lease.
  await sql`
    update ops.work_items
    set status = 'leased', lease_owner = 'ghost', lease_expires_at = now() - interval '1 minute',
        attempt_count = 1, output_ref = 'gate:already-done', started_at = now()
    where id = ${item}::bigint`;
  await sql`
    insert into ops.work_attempts (work_item_id, attempt_number, deployment, worker_instance)
    values (${item}::bigint, 1, 'ghost', 'ghost')`;

  const recovery = await ledger.recoverExpiredLeases();
  assert.equal(recovery.reconciledSucceeded >= 1, true);
  assert.equal((await itemRow(item)).status, "succeeded");
  const attempts = await sql`
    select outcome from ops.work_attempts where work_item_id = ${item}::bigint`;
  assert.equal(attempts[0]!.outcome, "abandoned");
});

await report.check("an expired lease with no output is requeued with a new epoch", async () => {
  const created = await ledger.createWorkflow({
    kind: "maintenance",
    ownerProfileId: OWNER,
    items: [queueItem(`recover-retry-${randomUUID()}`)],
  });
  const item = created.itemIds[0]!;
  await sql`
    update ops.work_items
    set status = 'leased', lease_owner = 'ghost', lease_expires_at = now() - interval '1 minute',
        attempt_count = 1, started_at = now()
    where id = ${item}::bigint`;
  await sql`
    insert into ops.work_attempts (work_item_id, attempt_number, deployment, worker_instance)
    values (${item}::bigint, 1, 'ghost', 'ghost')`;

  const recovery = await ledger.recoverExpiredLeases();
  assert.equal(recovery.requeued >= 1, true);
  const row = await itemRow(item);
  assert.equal(row.status, "retry_wait");
  assert.equal(row.dispatch_epoch, 1);
  assert.equal(row.error_code, "lease_expired");
});

await report.check("a lease that never expired is left alone", async () => {
  const before = await sql`select count(*)::int as n from ops.work_items where status = 'leased'`;
  const recovery = await ledger.recoverExpiredLeases();
  assert.equal(recovery.examined, 0);
  const after = await sql`select count(*)::int as n from ops.work_items where status = 'leased'`;
  assert.equal(after[0]!.n, before[0]!.n);
});

// --- terminal monotonicity -------------------------------------------------

report.section("terminal states are final in the database, not only in the code");

await report.check("a terminal workflow cannot be moved back", async () => {
  await assert.rejects(
    sql`update ops.workflows set state = 'running', completed_at = null where id = ${firstWorkflow}::uuid`,
    /terminal/,
  );
});

await report.check("a terminal work item cannot be moved back", async () => {
  await assert.rejects(
    sql`update ops.work_items set status = 'ready', completed_at = null where id = ${firstItem}::bigint`,
    /terminal/,
  );
});

await report.check("an attempt count cannot be rewound", async () => {
  await assert.rejects(
    sql`update ops.work_items set attempt_count = 0 where id = ${failingItem}::bigint`,
    /attempt count/,
  );
});

// --- the product surface, under the API role -------------------------------

report.section("workflow reads are owner-scoped under the API role");

/**
 * These run on the `forma_api` connection rather than through HTTP. The gate
 * process serves the private surface as `forma_ops`, so its own kernel could
 * not answer a `/v1` request; the HTTP surface — authentication, ownership,
 * problem codes, cursors — is proven by `gates/security.ts`, which runs a
 * kernel as the API role. What is proven here is that the ledger reads
 * themselves are sufficient and safe under exactly the API role's grants.
 */
await report.check("an owner sees their own workflows with weighted progress", async () => {
  const rows = await ledger.listWorkflows(
    { ownerProfileId: OWNER, limit: 5 },
    apiSql as never,
  );
  assert.ok(rows.length > 0);
  assert.ok(rows.every((row) => row.ownerProfileId === OWNER));
  assert.ok(rows.every((row) => typeof row.progress.totalWeight === "number"));
});

await report.check("the keyset walks the whole list without repeating a row", async () => {
  const seen = new Set<string>();
  let after: { createdAt: string; id: string } | null = null;
  for (let page = 0; page < 30; page += 1) {
    const rows = await ledger.listWorkflows(
      { ownerProfileId: OWNER, after, limit: 2 },
      apiSql as never,
    );
    for (const row of rows) {
      assert.equal(seen.has(row.id), false, `row ${row.id} appeared twice`);
      seen.add(row.id);
    }
    if (rows.length < 2) break;
    const last = rows.at(-1)!;
    after = { createdAt: last.createdAt, id: last.id };
  }
  assert.ok(seen.size >= 5);
});

await report.check("a workflow belonging to someone else simply is not there", async () => {
  assert.equal(await ledger.readWorkflow(firstWorkflow, OTHER_OWNER, apiSql as never), null);
  assert.notEqual(await ledger.readWorkflow(firstWorkflow, OWNER, apiSql as never), null);
  assert.deepEqual(await ledger.listWorkflows({ ownerProfileId: OTHER_OWNER, limit: 50 }, apiSql as never), []);
});

await report.check("a finished workflow cannot be cancelled", async () => {
  const result = await ledger.requestCancellation(firstWorkflow, OWNER, apiSql as never);
  assert.equal(result.outcome, "already_terminal");
});

await report.check("cancelling someone else's workflow is not found", async () => {
  const created = await ledger.createWorkflow({
    kind: "maintenance",
    ownerProfileId: OWNER,
    items: [queueItem(`cross-cancel-${randomUUID()}`)],
  });
  const denied = await ledger.requestCancellation(created.workflowId, OTHER_OWNER, apiSql as never);
  assert.equal(denied.outcome, "not_found");
  // And nothing was written: a denied cancellation must not leave a request behind.
  assert.equal((await workflowRow(created.workflowId)).cancel_requested_at, null);
});

await report.check("the API role can create and cancel work with the grants it holds", async () => {
  const created = (await apiSql.begin(async (tx) =>
    ledger.insertWorkflow(tx as never, {
      kind: "maintenance",
      ownerProfileId: OWNER,
      items: [queueItem(`api-role-${randomUUID()}`)],
    }),
  )) as { workflowId: string };
  const cancelled = await ledger.requestCancellation(created.workflowId, OWNER, apiSql as never);
  assert.equal(cancelled.outcome, "accepted");
});

// --- the legacy shadow -----------------------------------------------------

report.section("the ledger beside the legacy pipeline");

await report.check("a legacy import commits with a shadow workflow", async () => {
  const account = await apiSql`
    insert into linked_accounts (user_id, platform, username, normalized_username)
    values (${OWNER}, 'lichess', ${`gate${Date.now()}`}, ${`gate${Date.now()}`})
    returning id`;
  const importId = (
    await apiSql.begin(async (tx) => {
      const rows = await tx`
        insert into analysis_imports (user_id, account_id, requested_games, max_positions)
        values (${OWNER}, ${account[0]!.id}, 10, 1000) returning id`;
      const id = String(rows[0]!.id);
      await harness.shadow.createImportShadow(tx as never, { importId: id, ownerProfileId: OWNER });
      return id;
    })
  ) as string;

  const workflows = await sql`
    select id, kind, state from ops.workflows
    where resource_type = 'analysisImport' and resource_id = ${importId}`;
  assert.equal(workflows.length, 1);
  assert.equal(workflows[0]!.kind, "game_import");

  // A shadow item is never dispatched: routing it is E05's work, and until then
  // the legacy runner beside it is the executor.
  const items = await sql`
    select dispatch_mode, queue from ops.work_items
    where workflow_id = ${workflows[0]!.id}::uuid`;
  assert.equal(items[0]!.dispatch_mode, "in_process");
  assert.equal(items[0]!.queue, null);
  const outbox = await sql`
    select count(*)::int as n from ops.outbox_events
    where aggregate_id = (select id::text from ops.work_items where workflow_id = ${workflows[0]!.id}::uuid)`;
  assert.equal(outbox[0]!.n, 0);

  await harness.shadow.mirrorImportStatus(importId, "ingesting", apiSql as never);
  assert.equal(
    (await sql`select status from ops.work_items where workflow_id = ${workflows[0]!.id}::uuid`)[0]!.status,
    "leased",
  );
  await harness.shadow.mirrorImportStatus(importId, "completed", apiSql as never);
  assert.equal((await workflowRow(String(workflows[0]!.id))).state, "succeeded");
});

await report.check("reconciliation reports agreement without repairing it", async () => {
  const account = await apiSql`
    insert into linked_accounts (user_id, platform, username, normalized_username)
    values (${OWNER}, 'lichess', ${`orphan${Date.now()}`}, ${`orphan${Date.now()}`})
    returning id`;
  await apiSql`
    insert into analysis_imports (user_id, account_id, requested_games, max_positions)
    values (${OWNER}, ${account[0]!.id}, 5, 500)`;

  // Reconciliation reads the legacy tables and the ledger together, so it runs
  // as the API role: it is the only one that can see both.
  const before = await harness.shadow.reconcileLegacyImports(apiSql as never);
  assert.ok(before.legacyImports >= 2);
  assert.equal(before.missingShadow >= 1, true);
  const after = await harness.shadow.reconcileLegacyImports(apiSql as never);
  assert.equal(after.missingShadow, before.missingShadow, "reconciliation changed what it measured");
});

// --- dispatch failure ------------------------------------------------------

report.section("dispatch failures do not lose work");

await report.check("an unreachable queue leaves the row pending with a later retry", async () => {
  const created = await ledger.createWorkflow({
    kind: "maintenance",
    ownerProfileId: OWNER,
    items: [queueItem(`dispatch-fail-${randomUUID()}`)],
  });
  const item = created.itemIds[0]!;
  const built = harness.tasks.taskTransport() as { transport: never };
  // Drain everything else first, so the injected failure lands on this row and
  // the assertion is about it rather than about whatever else was pending.
  await sql`update ops.outbox_events set available_at = now() + interval '1 hour'
            where state = 'pending' and payload ->> 'workItemId' <> ${item}`;
  queue.failNext(1);
  const result = await dispatch.dispatchOutbox(built.transport as never);
  assert.equal(result.retrying >= 1, true);
  const rows = await sql`
    select state, publish_attempts, available_at, last_error_code from ops.outbox_events
    where payload ->> 'workItemId' = ${item}`;
  assert.equal(rows[0]!.state, "pending");
  assert.equal(rows[0]!.last_error_code, "transport_error");
  assert.ok(new Date(rows[0]!.available_at as never) > new Date());
});

await report.check("a redelivered dispatch is a duplicate at the queue, not a second task", async () => {
  const created = await ledger.createWorkflow({
    kind: "maintenance",
    ownerProfileId: OWNER,
    items: [queueItem(`dispatch-dup-${randomUUID()}`)],
  });
  const item = created.itemIds[0]!;
  const built = harness.tasks.taskTransport() as { transport: never };
  await dispatch.dispatchOutbox(built.transport as never);
  // Force the row back to pending, exactly as a crash between send and record
  // would leave it.
  await sql`
    update ops.outbox_events set state = 'pending', published_at = null, available_at = now()
    where payload ->> 'workItemId' = ${item}`;
  const second = await dispatch.dispatchOutbox(built.transport as never);
  assert.equal(second.duplicates >= 1, true);
  assert.equal(queue.tasks.filter((task) => task.payload.workItemId === item).length, 1);
});

await report.check("an outbox row for work that moved on is superseded, not dead", async () => {
  const created = await ledger.createWorkflow({
    kind: "maintenance",
    ownerProfileId: OWNER,
    items: [queueItem(`superseded-${randomUUID()}`)],
  });
  const item = created.itemIds[0]!;
  await ledger.requestCancellation(created.workflowId, OWNER);
  const built = harness.tasks.taskTransport() as { transport: never };
  const result = await dispatch.dispatchOutbox(built.transport as never);
  assert.equal(result.superseded >= 1, true);
  const rows = await sql`
    select state from ops.outbox_events where payload ->> 'workItemId' = ${item}`;
  assert.equal(rows[0]!.state, "superseded");
  assert.equal(queue.tasks.some((task) => task.payload.workItemId === item), false);
});

// --- the internal surface --------------------------------------------------

report.section("the private operator surface");

await report.check("ops endpoints report what they did", async () => {
  const token = await harness.serviceToken({ email: OPS_SERVICE_ACCOUNT });
  const response = await app.request("/internal/v1/outbox/dispatch", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 200);
  const body = (await json(response)) as unknown as { data: { pending: number } };
  assert.equal(typeof body.data.pending, "number");
});

await report.check("readiness names the handlers this deployment will accept", async () => {
  const token = await harness.serviceToken({ email: WORKER_SERVICE_ACCOUNT });
  const response = await app.request("/internal/v1/ready", {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  const body = (await json(response)) as unknown as {
    data: { ready: boolean; handlers: string[]; dispatch: string };
  };
  assert.equal(body.data.ready, true);
  assert.ok(body.data.handlers.includes("gate_succeeds"));
});

await report.check("an unknown internal path stays in problem+json", async () => {
  const token = await harness.serviceToken();
  const response = await app.request("/internal/v1/nonsense", {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("content-type"), "application/problem+json");
});

await harness.destroy();
report.finish();

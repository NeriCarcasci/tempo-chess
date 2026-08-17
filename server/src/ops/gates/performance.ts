import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { GateReport, startLedgerHarness } from "./harness.js";
import { peakConnections, poolOptionsFor, SERVICE_BUDGETS } from "../../platform/connection.js";

/**
 * Performance gate for the E04 work ledger.
 *
 * The claim is the one path in this epic worth measuring: every unit of work in
 * the product will pass through it, and it is a query whose cost depends
 * entirely on whether the partial index in database architecture §28 Q10 is
 * used. A claim that falls back to a sequential scan does not get slower
 * gradually — it gets slower in proportion to everything the ledger has ever
 * held.
 *
 * What is measured and what actually fails are deliberately different things,
 * for the same reason `v1/gates/performance.ts` explains: absolute wall clock
 * on a shared runner against a local cluster is ambient noise, not a
 * regression. So the blocking thresholds are the ones noise cannot fake:
 *
 *  - the claim and the recovery sweep must use their partial indexes;
 *  - the claim must stay flat as the ledger grows — measured as a ratio between
 *    a small ledger and a production-shaped one in the same run, so the
 *    environment cancels out;
 *  - exactly one of many simultaneous deliveries may claim an item;
 *  - the dispatcher and the sweep must stay inside the connection budget the
 *    platform allocates their service.
 *
 * Every timing is printed whether or not it is inside its reference, so a
 * regression stays visible as a trend.
 */

const report = new GateReport("E04 work ledger performance gate");
const harness = await startLedgerHarness();
const { sql, ledger, dispatch, handlers, tokens } = harness;

/** Production-shaped: the ledger after a few months of ordinary analysis work. */
const SEED_WORKFLOWS = 400;
const SEED_ITEMS = 20_000;

/** Reference wall-clock budgets. Reported, never asserted. See the note above. */
const REFERENCE = {
  claim: { name: "conditional claim by identity", p95Ms: 25 },
  scan: { name: "in-process claim scan", p95Ms: 25 },
  read: { name: "workflow read with derived progress", p95Ms: 25 },
  list: { name: "workflow page of 25", p95Ms: 40 },
  dispatchBatch: { name: "outbox claim of 100", p95Ms: 60 },
} as const;

/** The blocking one: growth must not change the claim's cost profile. */
const MAX_GROWTH_RATIO = 5;

function percentile(samples: number[], fraction: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

async function measure(
  label: { name: string; p95Ms: number },
  iterations: number,
  run: (index: number) => Promise<unknown>,
): Promise<number> {
  await run(-1);
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    await run(index);
    samples.push(performance.now() - startedAt);
  }
  const p95 = percentile(samples, 0.95);
  const p50 = percentile(samples, 0.5);
  console.log(
    `      ${label.name}: p50 ${p50.toFixed(2)}ms p95 ${p95.toFixed(2)}ms (reference ${label.p95Ms}ms)`,
  );
  if (p95 > label.p95Ms) {
    console.log(
      `      note: over the ${label.p95Ms}ms reference (advisory: shared-runner timing is not a merge gate)`,
    );
  }
  return p95;
}

handlers.registerHandler("perf_noop", async () => ({}));

const OWNER = randomUUID();
await harness.apiSql`insert into profiles (id, email) values (${OWNER}, ${`${OWNER}@perf.invalid`})
                     on conflict (id) do nothing`;

/** One claimable item, ready and dispatched, ready to be delivered. */
async function freshItem(): Promise<{ id: string; token: string }> {
  const created = await ledger.createWorkflow({
    kind: "maintenance",
    ownerProfileId: OWNER,
    items: [
      {
        taskType: "perf_noop",
        resourceClass: "aggregation",
        idempotencyKey: `perf-${randomUUID()}`,
        queue: "analysis",
      },
    ],
  });
  const id = created.itemIds[0]!;
  return { id, token: tokens.attemptToken({ workItemId: id, dispatchEpoch: 0 }) };
}

const worker = { deployment: "perf-worker", revision: null, instance: "perf" };

// --- a small ledger --------------------------------------------------------

report.section("baseline: a nearly empty ledger");

let smallClaimP95 = 0;
await report.check("a claim on a small ledger", async () => {
  const prepared = await Promise.all(Array.from({ length: 40 }, () => freshItem()));
  smallClaimP95 = await measure(REFERENCE.claim, 30, async (index) => {
    const item = prepared[Math.max(0, index)]!;
    await ledger.claimWorkItem({
      workItemId: item.id,
      attemptToken: item.token,
      worker,
    });
  });
});

// --- production-shaped -----------------------------------------------------

report.section(`production-shaped: ${SEED_ITEMS} items across ${SEED_WORKFLOWS} workflows`);

await report.check("the ledger is seeded", async () => {
  const startedAt = performance.now();
  await sql`
    insert into ops.workflows (id, kind, owner_profile_id, state)
    select gen_random_uuid(), 'game_analysis', ${OWNER}::uuid, 'running'
    from generate_series(1, ${SEED_WORKFLOWS})`;
  await sql`
    insert into ops.work_items (
      workflow_id, task_type, resource_class, idempotency_key, dispatch_mode, queue,
      status, priority, weight, available_at, completed_at
    )
    select w.id,
           'perf_seed',
           (array['ingestion','cpu_engine','aggregation','publication'])[1 + (n % 4)],
           'seed-' || n,
           'queue',
           'analysis',
           (array['ready','succeeded','succeeded','dead','blocked'])[1 + (n % 5)],
           (n % 200),
           1 + (n % 8),
           now() - make_interval(secs => n % 3600),
           -- A terminal item carries a completion time, exactly as the schema
           -- requires; a seed that ignored the constraint would be a fixture of
           -- rows production can never hold.
           case when (n % 5) in (1, 2, 3) then now() end
    from generate_series(1, ${SEED_ITEMS}) n
    join lateral (
      select id from ops.workflows
      where kind = 'game_analysis' offset (n % ${SEED_WORKFLOWS}) limit 1
    ) w on true`;
  console.log(`      seeded in ${Math.round(performance.now() - startedAt)}ms`);
  const rows = await sql<{ n: number }[]>`select count(*)::int as n from ops.work_items`;
  assert.ok(rows[0]!.n >= SEED_ITEMS);
});

await report.check("queue depth by class uses the Q10 partial index", async () => {
  const plan = await sql<{ "QUERY PLAN": string }[]>`
    explain (costs off)
    select resource_class, count(*)::int,
           max(extract(epoch from (now() - available_at))) filter (where available_at <= now())
    from ops.work_items where status = 'ready' group by resource_class`;
  const text = plan.map((row) => row["QUERY PLAN"]).join("\n");
  console.log(`      ${text.split("\n").slice(0, 2).join(" / ")}`);
  assert.ok(/work_items_claim_idx/.test(text), text);
});

await report.check("the in-process pull claim uses its own partial index", async () => {
  const plan = await sql<{ "QUERY PLAN": string }[]>`
    explain (costs off)
    select id from ops.work_items
    where dispatch_mode = 'in_process' and status in ('ready', 'retry_wait')
      and available_at <= now() and task_type = any(array['perf_seed']::text[])
    order by priority desc, available_at, id
    limit 10`;
  const text = plan.map((row) => row["QUERY PLAN"]).join("\n");
  console.log(`      ${text.split("\n").slice(0, 2).join(" / ")}`);
  assert.ok(/work_items_in_process_claim_idx/.test(text), text);
});

await report.check("lease recovery uses its own partial index", async () => {
  const plan = await sql<{ "QUERY PLAN": string }[]>`
    explain (costs off)
    select id, workflow_id from ops.work_items
    where status = 'leased' and lease_expires_at < now()
    order by lease_expires_at limit 200`;
  const text = plan.map((row) => row["QUERY PLAN"]).join("\n");
  console.log(`      ${text.split("\n")[0]}`);
  assert.ok(/work_items_lease_recovery_idx/.test(text), text);
});

await report.check("the outbox dispatch claim uses its partial index", async () => {
  const plan = await sql<{ "QUERY PLAN": string }[]>`
    explain (costs off)
    select o.id from ops.outbox_events o
    where o.state = 'pending' and o.available_at <= now()
    order by o.available_at, o.id limit 100`;
  const text = plan.map((row) => row["QUERY PLAN"]).join("\n");
  console.log(`      ${text.split("\n")[0]}`);
  assert.equal(/Seq Scan on outbox_events/.test(text), false, text);
});

let largeClaimP95 = 0;
await report.check("the claim stays flat as the ledger grows", async () => {
  const prepared = await Promise.all(Array.from({ length: 40 }, () => freshItem()));
  largeClaimP95 = await measure(REFERENCE.claim, 30, async (index) => {
    const item = prepared[Math.max(0, index)]!;
    await ledger.claimWorkItem({
      workItemId: item.id,
      attemptToken: item.token,
      worker,
    });
  });
  const ratio = largeClaimP95 / Math.max(smallClaimP95, 0.5);
  console.log(
    `      growth ratio ${ratio.toFixed(2)}x from ~0 to ${SEED_ITEMS} items ` +
      `(blocking above ${MAX_GROWTH_RATIO}x)`,
  );
  assert.ok(
    ratio <= MAX_GROWTH_RATIO,
    `claim cost grew ${ratio.toFixed(2)}x with the ledger; the index is not carrying it`,
  );
});

await report.check("the in-process claim scan is bounded", async () => {
  await measure(REFERENCE.scan, 20, async () => {
    await ledger.claimNextInProcess({ taskTypes: ["perf_seed"], worker });
  });
});

await report.check("a workflow read derives progress without loading its items", async () => {
  const rows = await sql<{ id: string }[]>`
    select id from ops.workflows where owner_profile_id = ${OWNER}::uuid limit 20`;
  await measure(REFERENCE.read, 20, async (index) => {
    await ledger.readWorkflow(rows[Math.max(0, index) % rows.length]!.id, OWNER, harness.apiSql as never);
  });
});

await report.check("a workflow page stays bounded over the whole ledger", async () => {
  await measure(REFERENCE.list, 20, async () => {
    await ledger.listWorkflows({ ownerProfileId: OWNER, limit: 25 }, harness.apiSql as never);
  });
});

await report.check("an outbox dispatch pass claims a bounded batch", async () => {
  const built = harness.tasks.taskTransport() as { transport: never };
  await measure(REFERENCE.dispatchBatch, 5, async () => {
    await dispatch.dispatchOutbox(built.transport as never, 100);
  });
});

// --- correctness under concurrency -----------------------------------------

report.section("throughput does not cost correctness");

await report.check("exactly one of twenty simultaneous deliveries claims the item", async () => {
  const item = await freshItem();
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      ledger.claimWorkItem({ workItemId: item.id, attemptToken: item.token, worker }),
    ),
  );
  const claimed = results.filter((result) => result.outcome === "claimed");
  assert.equal(claimed.length, 1, `${claimed.length} callers claimed the same item`);
  const attempts = await sql<{ n: number }[]>`
    select count(*)::int as n from ops.work_attempts where work_item_id = ${item.id}::bigint`;
  assert.equal(attempts[0]!.n, 1);
});

await report.check("twenty scanning workers never take the same item twice", async () => {
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      ledger.claimNextInProcess({
        taskTypes: ["perf_seed"],
        worker: { deployment: "perf-worker", revision: null, instance: `scan-${index}` },
      }),
    ),
  );
  const ids = results.filter(Boolean).map((item) => item!.id);
  assert.equal(new Set(ids).size, ids.length, "two scanners claimed the same item");
});

// --- connection budget -----------------------------------------------------

report.section("connection budget");

await report.check("the ledger's services stay inside their allocated pools", async () => {
  for (const service of ["forma-ops", "forma-ingestion", "forma-stockfish", "forma-analysis"]) {
    const budget = SERVICE_BUDGETS.find((entry) => entry.service === service)!;
    const options = poolOptionsFor(service);
    assert.equal(options.max, budget.poolPerInstance);
    assert.equal(options.prepare, false);
    console.log(
      `      ${service}: ${options.max} per instance, ${peakConnections(budget)} at peak`,
    );
  }
});

await report.check("a dispatch pass holds no more connections than its pool allows", async () => {
  const built = harness.tasks.taskTransport() as { transport: never };
  const before = await sql<{ n: number }[]>`
    select count(*)::int as n from pg_stat_activity where usename = 'forma_ops'`;
  await Promise.all([
    dispatch.dispatchOutbox(built.transport as never, 50),
    dispatch.dispatchOutbox(built.transport as never, 50),
    dispatch.dispatchOutbox(built.transport as never, 50),
  ]);
  const during = await sql<{ n: number }[]>`
    select count(*)::int as n from pg_stat_activity where usename = 'forma_ops'`;
  const budget = SERVICE_BUDGETS.find((entry) => entry.service === "forma-ops")!;
  console.log(
    `      forma_ops backends: ${before[0]!.n} before, ${during[0]!.n} after ` +
      `(pool ${budget.poolPerInstance})`,
  );
  // The driver pool is the ceiling; three concurrent passes must queue on it
  // rather than opening a connection each.
  assert.ok(
    during[0]!.n <= budget.poolPerInstance + 1,
    `forma_ops held ${during[0]!.n} backends against a pool of ${budget.poolPerInstance}`,
  );
});

await harness.destroy();
report.finish();

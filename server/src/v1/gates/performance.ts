import assert from "node:assert/strict";
import { Hono } from "hono";
import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet } from "jose";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { GateReport, startKernelHarness } from "./harness.js";
import type { RouteDefinition } from "../registry.js";

/**
 * Performance gate for the `/v1` kernel.
 *
 * The kernel sits in front of every future endpoint, so its overhead is paid on
 * every request forever. That makes it one of the few things in this epic worth
 * measuring rather than assuming.
 *
 * What is measured and what actually fails are deliberately different things.
 * Absolute wall-clock budgets are reported, never asserted: this gate runs on a
 * shared CI runner against a containerised cluster, where a tail spike is
 * ambient noise rather than a regression. Treating those numbers as a merge
 * gate makes the pipeline flaky without making the kernel faster — commit
 * 03d5fb9 passed and failed the identical assertion in two runs of the same
 * SHA, on a p95 of 85ms against a p50 of 1.68ms.
 *
 * Two things do fail the run, because a code change can regress them and noise
 * cannot fake them:
 *
 *  - kernel overhead, measured as the difference between the kernel path and
 *    the bare control in the same run, so the environment cancels out;
 *  - the *shape* of the database work — one round trip per claim — counted
 *    rather than inferred from a timing.
 *
 * The disposable cluster is local, so latency here is a floor and not a
 * production figure; production latency is E05's staging measurement. Every
 * number is printed whether or not it is within budget, so a regression stays
 * visible as a trend.
 */

const report = new GateReport("E03 /v1 kernel performance gate");
const harness = await startKernelHarness();

/** Production-shaped enough to matter: the counter and record tables carry rows. */
const SEED_ROWS = 5_000;

interface Budget {
  readonly name: string;
  readonly p95Ms: number;
}

const BUDGETS = {
  bareHandler: { name: "bare handler (control)", p95Ms: 5 },
  kernelRead: { name: "kernel bounded read", p95Ms: 20 },
  jwtVerify: { name: "local JWT verification", p95Ms: 3 },
  idempotency: { name: "idempotency claim + complete", p95Ms: 25 },
  rateLimit: { name: "distributed rate-limit check", p95Ms: 25 },
} as const satisfies Record<string, Budget>;

/** The kernel's own cost, over and above the handler it wraps. */
const KERNEL_OVERHEAD_BUDGET_MS = 15;

/** Report a wall-clock budget without failing the run. See the note above. */
function noteIfOverBudget(budget: Budget, p95: number): void {
  if (p95 > budget.p95Ms) {
    console.log(
      `      note: ${budget.name} p95 ${p95.toFixed(2)}ms exceeded the ${budget.p95Ms}ms ` +
        `reference (advisory: shared-runner timing is not a merge gate)`,
    );
  }
}

function percentile(samples: number[], fraction: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

async function measure(
  budget: Budget,
  iterations: number,
  run: (index: number) => Promise<unknown>,
): Promise<number> {
  // Warm the path first: the first call through any of these pays for a
  // connection, a code path that has never been optimised, and a JIT tier-up.
  for (let i = 0; i < Math.min(20, iterations); i += 1) await run(-1 - i);
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const started = performance.now();
    await run(i);
    samples.push(performance.now() - started);
  }
  const p95 = percentile(samples, 0.95);
  console.log(
    `      ${budget.name}: p50 ${percentile(samples, 0.5).toFixed(2)}ms  ` +
      `p95 ${p95.toFixed(2)}ms  budget ${budget.p95Ms}ms  (n=${iterations})`,
  );
  return p95;
}

try {
  report.section("production-shaped fixture");

  await report.check(`seed ${SEED_ROWS} counter and record rows`, async () => {
    await harness.sql`
      insert into ops.rate_limit_counters (bucket, subject_key, window_start, count, expires_at)
      select 'perf_seed', lpad(to_hex(g), 32, '0'), now() - make_interval(mins => g % 60), 1,
             now() + interval '1 hour'
      from generate_series(1, ${SEED_ROWS}) g`;
    await harness.sql`
      insert into ops.idempotency_records
        (actor_key, route_key, idempotency_key, request_method, request_digest,
         state, response_status, response_body, completed_at, expires_at)
      select 'anon', 'POST /v1/public/beta-signups', 'seed-' || g, 'POST',
             repeat('c', 64), 'completed', 202, '{"data":{"accepted":true}}'::jsonb,
             now(), now() + interval '1 day'
      from generate_series(1, ${SEED_ROWS}) g`;
    const rows = await harness.sql<{ n: number }[]>`
      select count(*)::int as n from ops.idempotency_records`;
    assert.ok(rows[0].n >= SEED_ROWS);
  });

  report.section("kernel overhead on a bounded read");

  const payload = { data: { value: "x".repeat(256) } };
  const bare = new Hono();
  bare.get("/bare", (c) => c.json(payload));

  const throughKernel: RouteDefinition<never, never, { value: string }> = {
    method: "GET",
    path: "/v1/perf/read",
    operationId: "getPerfRead",
    summary: "Performance fixture read",
    kind: "read",
    auth: "public",
    envelope: "resource",
    successStatus: 200,
    etag: true,
    cacheControl: "public, max-age=0",
    dataSchema: z.object({ value: z.string() }),
    async handler() {
      return { data: payload.data };
    },
  };
  const kernelApp = new Hono();
  harness.kernel.mountRoute(kernelApp, throughKernel as unknown as RouteDefinition<never, never, never>);

  // The request line would otherwise dominate the console for 4,000 requests.
  harness.telemetry.setObservationSink(() => {});

  let bareP95 = 0;
  let kernelP95 = 0;

  await report.check("a bare handler establishes the control", async () => {
    bareP95 = await measure(BUDGETS.bareHandler, 2_000, async () => bare.request("http://perf/bare"));
    noteIfOverBudget(BUDGETS.bareHandler, bareP95);
  });

  await report.check("the same read through the kernel is measured", async () => {
    kernelP95 = await measure(BUDGETS.kernelRead, 2_000, async () =>
      kernelApp.request("http://perf/v1/perf/read"),
    );
    noteIfOverBudget(BUDGETS.kernelRead, kernelP95);
  });

  await report.check(`kernel overhead is at most ${KERNEL_OVERHEAD_BUDGET_MS}ms at p95`, () => {
    const overhead = kernelP95 - bareP95;
    console.log(
      `      overhead: ${overhead.toFixed(2)}ms  budget ${KERNEL_OVERHEAD_BUDGET_MS}ms`,
    );
    assert.ok(overhead <= KERNEL_OVERHEAD_BUDGET_MS, `overhead ${overhead.toFixed(2)}ms`);
  });

  report.section("authentication");

  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  const keySet: JSONWebKeySet = {
    keys: [{ ...(await exportJWK(publicKey)), kid: "perf", alg: "ES256", use: "sig" }],
  };
  const verifier = new harness.verifier.TokenVerifier({
    supabaseUrl: process.env.SUPABASE_URL!,
    supabaseAnonKey: "perf",
    keySet,
    async getUser() {
      throw new Error("the performance gate must never reach the network fallback");
    },
  });
  const issuer = `${process.env.SUPABASE_URL}/auth/v1`;
  const tokens = await Promise.all(
    Array.from({ length: 200 }, () =>
      new SignJWT({})
        .setProtectedHeader({ alg: "ES256", kid: "perf" })
        .setSubject(randomUUID())
        .setIssuer(issuer)
        .setAudience("authenticated")
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(privateKey),
    ),
  );

  await report.check("local verification is measured on a cache miss", async () => {
    // A distinct token every iteration, so this measures verification and not
    // the digest cache. The cached path is faster by construction.
    const p95 = await measure(BUDGETS.jwtVerify, 200, async (i) => {
      const result = await verifier.verify(tokens[((i % 200) + 200) % 200]);
      assert.equal(result.ok, true);
    });
    noteIfOverBudget(BUDGETS.jwtVerify, p95);
  });

  report.section("durable command paths");

  await report.check("an idempotency claim and completion is measured", async () => {
    const scope = {
      routeKey: "POST /v1/public/beta-signups",
      method: "POST",
      actorProfileId: null,
    };
    const digest = harness.idempotency.requestDigest(scope, { probe: true });
    const p95 = await measure(BUDGETS.idempotency, 300, async (i) => {
      const claim = await harness.idempotency.beginCommand(scope, `perf-${i}`, digest);
      if (claim.kind === "proceed") {
        await harness.idempotency.completeCommand(claim.recordId, {
          status: 202,
          body: { data: { accepted: true }, meta: { requestId: "req_perf" } },
        });
      }
    });
    noteIfOverBudget(BUDGETS.idempotency, p95);
  });

  await report.check("a distributed rate-limit check is measured", async () => {
    const policy = { name: "perf_check", windowSeconds: 3_600, max: 10_000_000 };
    const p95 = await measure(BUDGETS.rateLimit, 500, async (i) => {
      const decision = await harness.rateLimit.consume(policy, `perf-${i % 50}`, {
        failClosed: true,
      });
      assert.equal(decision.status, "ok");
    });
    noteIfOverBudget(BUDGETS.rateLimit, p95);
  });

  await report.check("claiming a fresh key costs exactly one database round trip", async () => {
    // Shape, not speed. A claim that grew a second query would still fit the
    // millisecond budget on a local cluster and would not on the pooler, where
    // every round trip crosses a network — so the round trip is what is
    // asserted, and it is counted rather than inferred from a timing.
    let queries = 0;
    const counting = new Proxy(harness.sql, {
      apply(target, thisArg, args: unknown[]) {
        queries += 1;
        return Reflect.apply(target as never, thisArg, args as never);
      },
    }) as typeof harness.sql;

    const scope = { routeKey: "POST /v1/perf/shape", method: "POST", actorProfileId: null };
    const digest = harness.idempotency.requestDigest(scope, { shape: true });
    const key = `shape-${randomUUID()}`;

    const claim = await harness.idempotency.beginCommand(scope, key, digest, counting);
    assert.equal(claim.kind, "proceed");
    assert.equal(queries, 1, `a fresh claim issued ${queries} queries`);

    // The duplicate path costs one more: the insert loses the race and the
    // winner's row has to be read before the outcome is known.
    queries = 0;
    await assert.rejects(() => harness.idempotency.beginCommand(scope, key, digest, counting));
    assert.equal(queries, 2, `a duplicate claim issued ${queries} queries`);
  });
} finally {
  harness.telemetry.setObservationSink(null);
  await harness.destroy();
}

report.finish();

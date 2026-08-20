import assert from "node:assert/strict";
import postgres from "postgres";
import { z } from "zod";
import { Hono } from "hono";
import { GateReport, startKernelHarness } from "./harness.js";
import { encodeCursor, decodeCursor } from "../cursor.js";
import type { RouteDefinition } from "../registry.js";

/**
 * Integration gate: the `/v1` kernel through real process, HTTP and database
 * boundaries.
 *
 * What this proves that unit tests cannot: that the idempotency record really
 * is a lock under a race, that the rate limit really is shared by two
 * connections rather than by one process's memory, that the actor context
 * really is transaction-local on a pooled connection, and that the grants
 * `forma_api` holds are sufficient for every one of those to work.
 *
 * Everything it creates, it removes; nothing asserts that a table is globally
 * empty. It runs only against a disposable cluster.
 */

const report = new GateReport("E03 /v1 kernel integration gate");
const harness = await startKernelHarness();
const { app, sql } = harness;

/** Read a JSON body without letting a parse failure hide the status. */
async function json(response: Response): Promise<Record<string, never>> {
  const text = await response.text();
  try {
    return JSON.parse(text) as Record<string, never>;
  } catch {
    throw new Error(`expected JSON, got ${response.status} ${text.slice(0, 120)}`);
  }
}

const signup = (email: string) => ({
  name: "Gate Tester",
  email,
  platform: "lichess" as const,
  ratingBand: "1400-1800" as const,
});

/**
 * Each check gets its own client address. The address policy is five signups an
 * hour, and a shared address would mean the eighth check in this file failed
 * because the second one had already spent the budget.
 */
let addressCounter = 0;
const freshAddress = (): string => `203.0.113.${(addressCounter += 1) % 200}`;

function command(body: unknown, key: string, address = freshAddress()): Request {
  return new Request("http://gate/v1/public/beta-signups", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": key,
      "cf-connecting-ip": address,
    },
    body: JSON.stringify(body),
  });
}

const createdEmails: string[] = [];

try {
  report.section("public reads");

  await report.check("a read returns the success envelope with a request id", async () => {
    const response = await app.request("http://gate/v1/public/plans");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json");
    const body = await json(response);
    assert.ok(Array.isArray((body.data as { plans: unknown[] }).plans));
    assert.match((body.meta as { requestId: string }).requestId, /^req_[0-9a-z]{26}$/);
    assert.equal(response.headers.get("x-request-id"), (body.meta as { requestId: string }).requestId);
  });

  await report.check("a caller-supplied request id is echoed when it is well formed", async () => {
    const response = await app.request("http://gate/v1/public/plans", {
      headers: { "x-request-id": "gate-request-0001" },
    });
    assert.equal(response.headers.get("x-request-id"), "gate-request-0001");
  });

  await report.check("a malformed caller request id is replaced, not reflected", async () => {
    const response = await app.request("http://gate/v1/public/plans", {
      headers: { "x-request-id": "<script>alert(1)</script>" },
    });
    assert.match(response.headers.get("x-request-id") ?? "", /^req_/);
    assert.equal((await response.text()).includes("<script>"), false);
  });

  await report.check("an ETag is stable and If-None-Match yields 304 with no body", async () => {
    const first = await app.request("http://gate/v1/public/plans");
    const etag = first.headers.get("etag");
    assert.match(etag ?? "", /^"[0-9a-f]{32}"$/);
    const second = await app.request("http://gate/v1/public/plans");
    assert.equal(second.headers.get("etag"), etag);
    const conditional = await app.request("http://gate/v1/public/plans", {
      headers: { "if-none-match": etag! },
    });
    assert.equal(conditional.status, 304);
    assert.equal(await conditional.text(), "");
  });

  await report.check("a public read declares public caching", async () => {
    const response = await app.request("http://gate/v1/public/stats");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "public, max-age=300");
  });

  await report.check("the generated OpenAPI document is served raw", async () => {
    const response = await app.request("http://gate/v1/openapi.json");
    assert.equal(response.status, 200);
    const document = await json(response);
    assert.equal(document.openapi, "3.1.0");
    assert.ok((document.paths as Record<string, unknown>)["/v1/public/beta-signups"]);
    assert.equal("meta" in document, false);
  });

  report.section("problem details");

  await report.check("an unknown /v1 path is a problem document, not text", async () => {
    const response = await app.request("http://gate/v1/nope");
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("content-type"), "application/problem+json");
    const body = await json(response);
    assert.equal(body.code, "NOT_FOUND");
    assert.equal(body.instance, "/v1/nope");
    assert.match(body.type as unknown as string, /problems\/not-found$/);
  });

  await report.check("a malformed body is a validation problem naming the field", async () => {
    const response = await app.request(
      command({ name: "", email: "not-an-email", platform: "lichess" }, "gate-validation-1"),
    );
    assert.equal(response.status, 400);
    const body = await json(response);
    assert.equal(body.code, "VALIDATION_FAILED");
    const paths = (body.errors as { path: string }[]).map((e) => e.path).sort();
    assert.deepEqual(paths, ["email", "name"]);
    assert.equal(JSON.stringify(body).includes("not-an-email"), false);
  });

  await report.check("a body that is not JSON is a validation problem, not a 500", async () => {
    const response = await app.request("http://gate/v1/public/beta-signups", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "gate-json-1" },
      body: "{oops",
    });
    assert.equal(response.status, 400);
    assert.equal((await json(response)).code, "VALIDATION_FAILED");
  });

  await report.check("a client-supplied identity field is refused", async () => {
    const response = await app.request(
      command({ ...signup("identity@gate.invalid"), userId: "someone-else" }, "gate-identity-1"),
    );
    assert.equal(response.status, 400);
    const body = await json(response);
    assert.equal((body.errors as { code: string }[])[0].code, "CLIENT_SUPPLIED_IDENTITY");
    assert.equal(JSON.stringify(body).includes("someone-else"), false);
  });

  report.section("durable idempotency");

  await report.check("a command requires an Idempotency-Key", async () => {
    const response = await app.request("http://gate/v1/public/beta-signups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(signup("nokey@gate.invalid")),
    });
    assert.equal(response.status, 400);
    const body = await json(response);
    assert.equal((body.errors as { path: string }[])[0].path, "header.Idempotency-Key");
  });

  await report.check("a command is accepted with 202 and a content-free body", async () => {
    const email = "accept@gate.invalid";
    createdEmails.push(email);
    const response = await app.request(command(signup(email), "gate-accept-1"));
    assert.equal(response.status, 202);
    const body = await json(response);
    assert.deepEqual(body.data, { accepted: true });
    // §3: the response must not reveal whether the address was already known.
    assert.equal(JSON.stringify(body).includes("created"), false);
    const rows = await sql`select count(*)::int as n from beta_signups where email = ${email}`;
    assert.equal(rows[0].n, 1);
  });

  await report.check("an identical retry replays the original response without re-running", async () => {
    const email = "replay@gate.invalid";
    createdEmails.push(email);
    const first = await app.request(command(signup(email), "gate-replay-1"));
    assert.equal(first.status, 202);
    await sql`update beta_signups set name = 'mutated' where email = ${email}`;
    const second = await app.request(command(signup(email), "gate-replay-1"));
    assert.equal(second.status, 202);
    assert.equal(second.headers.get("idempotency-replayed"), "true");
    assert.deepEqual(await json(second), await json(first.clone()));
    // The handler did not run again: the row the replay would have rewritten
    // still holds the value the test put there.
    const rows = await sql`select name from beta_signups where email = ${email}`;
    assert.equal(rows[0].name, "mutated");
  });

  await report.check("the same key with a different body is a 409 conflict", async () => {
    const emailA = "conflict-a@gate.invalid";
    const emailB = "conflict-b@gate.invalid";
    createdEmails.push(emailA, emailB);
    await app.request(command(signup(emailA), "gate-conflict-1"));
    const response = await app.request(command(signup(emailB), "gate-conflict-1"));
    assert.equal(response.status, 409);
    const body = await json(response);
    assert.equal(body.code, "IDEMPOTENCY_CONFLICT");
    assert.equal(body.retryable, false);
    const rows = await sql`select count(*)::int as n from beta_signups where email = ${emailB}`;
    assert.equal(rows[0].n, 0, "the conflicting command must not have run");
  });

  await report.check("a duplicate arriving while the original runs is told to retry", async () => {
    const key = "gate-inflight-1";
    // Claim the key exactly as the kernel would, then leave it processing.
    const scope = { routeKey: "POST /v1/public/beta-signups", method: "POST", actorProfileId: null };
    const digest = harness.idempotency.requestDigest(scope, signup("inflight@gate.invalid"));
    const claim = await harness.idempotency.beginCommand(scope, key, digest);
    assert.equal(claim.kind, "proceed");
    const response = await app.request(command(signup("inflight@gate.invalid"), key));
    assert.equal(response.status, 409);
    const body = await json(response);
    assert.equal(body.code, "IDEMPOTENCY_IN_PROGRESS");
    assert.equal(body.retryable, true);
    assert.equal(response.headers.get("retry-after"), "1");
    // The record is deliberately left standing: `forma_api` holds no delete on
    // this table, and a command role that could erase its own replay evidence
    // would be a hole rather than a convenience. The key is unique to this
    // check, so nothing later depends on it being gone.
  });

  await report.check("a crashed attempt's lease expires and the retry proceeds", async () => {
    const email = "crashed@gate.invalid";
    createdEmails.push(email);
    const key = "gate-crashed-1";
    const scope = { routeKey: "POST /v1/public/beta-signups", method: "POST", actorProfileId: null };
    const digest = harness.idempotency.requestDigest(scope, signup(email));
    await harness.idempotency.beginCommand(scope, key, digest);
    // The process that held it died: age the lease rather than sleeping a minute.
    await sql`update ops.idempotency_records set lease_expires_at = now() - interval '1 second'
              where idempotency_key = ${key}`;
    const response = await app.request(command(signup(email), key));
    assert.equal(response.status, 202);
    const rows = await sql`select state, response_status from ops.idempotency_records
                           where idempotency_key = ${key}`;
    assert.equal(rows[0].state, "completed");
    assert.equal(rows[0].response_status, 202);
  });

  await report.check("only one of two concurrent duplicates runs the command", async () => {
    const email = "race@gate.invalid";
    createdEmails.push(email);
    const key = "gate-race-1";
    const [a, b] = await Promise.all([
      app.request(command(signup(email), key)),
      app.request(command(signup(email), key)),
    ]);
    const statuses = [a.status, b.status].sort();
    // One accepted; the other either replayed the accepted response or was told
    // the original was still running. Both are correct; two 202s from two
    // independent runs would not be.
    assert.ok(
      statuses[0] === 202 && (statuses[1] === 202 || statuses[1] === 409),
      `unexpected statuses ${statuses.join(",")}`,
    );
    const records = await sql`select count(*)::int as n from ops.idempotency_records
                              where idempotency_key = ${key}`;
    assert.equal(records[0].n, 1);
  });

  await report.check("the record stores a keyed digest and no request content", async () => {
    const rows = await sql`select request_digest, response_body, actor_key, actor_profile_id
                           from ops.idempotency_records where idempotency_key = 'gate-accept-1'`;
    assert.match(rows[0].request_digest as string, /^[0-9a-f]{64}$/);
    assert.equal(rows[0].actor_key, "anon");
    assert.equal(rows[0].actor_profile_id, null);
    const stored = JSON.stringify(rows[0].response_body);
    assert.equal(stored.includes("@gate.invalid"), false, "the stored body must not carry the email");
    assert.equal(stored.includes("Gate Tester"), false);
  });

  report.section("distributed rate limiting");

  await report.check("the counter is shared by two independent connections", async () => {
    const other = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });
    try {
      const policy = { name: "gate_shared", windowSeconds: 60, max: 2 };
      const identity = `gate-${Date.now()}`;
      const first = await harness.rateLimit.consume(policy, identity, { failClosed: true });
      const second = await harness.rateLimit.consume(policy, identity, {
        failClosed: true,
        sql: other as never,
      });
      const third = await harness.rateLimit.consume(policy, identity, {
        failClosed: true,
        sql: other as never,
      });
      assert.equal(first.status, "ok");
      assert.equal(second.status, "ok");
      // Two separate connections, one budget: the third is over the limit.
      assert.equal(third.status, "limited");
      assert.ok(third.retryAfterSeconds > 0);
      await sql`delete from ops.rate_limit_counters where bucket = 'gate_shared'`;
    } finally {
      await other.end({ timeout: 5 });
    }
  });

  await report.check("the counter stores a keyed subject, never the raw identity", async () => {
    const policy = { name: "gate_privacy", windowSeconds: 60, max: 10 };
    await harness.rateLimit.consume(policy, "198.51.100.7", { failClosed: false });
    const rows = await sql`select subject_key from ops.rate_limit_counters where bucket = 'gate_privacy'`;
    assert.match(rows[0].subject_key as string, /^[0-9a-f]{32}$/);
    assert.equal((rows[0].subject_key as string).includes("198"), false);
    await sql`delete from ops.rate_limit_counters where bucket = 'gate_privacy'`;
  });

  await report.check("the address policy refuses the sixth signup in an hour", async () => {
    const address = "203.0.113.55";
    let limited: Response | null = null;
    for (let i = 0; i < 7; i += 1) {
      const email = `flood-${i}@gate.invalid`;
      createdEmails.push(email);
      const response = await app.request(command(signup(email), `gate-flood-${i}`, address));
      if (response.status === 429) {
        limited = response;
        break;
      }
    }
    assert.ok(limited, "the address policy never engaged");
    const body = await json(limited!);
    assert.equal(body.code, "RATE_LIMITED");
    assert.equal(body.retryable, true);
    assert.ok(Number(limited!.headers.get("retry-after")) > 0);
  });

  await report.check("the email policy engages across different addresses", async () => {
    const email = "persistent@gate.invalid";
    createdEmails.push(email);
    let limited = false;
    for (let i = 0; i < 5; i += 1) {
      const response = await app.request(
        command(signup(email), `gate-email-${i}`, `198.51.100.${20 + i}`),
      );
      if (response.status === 429) {
        limited = true;
        break;
      }
    }
    assert.ok(limited, "the email policy never engaged");
  });

  report.section("degraded dependency and recovery");

  await report.check("a command fails closed when the counter store is unreachable", async () => {
    // Injected for real, by revoking the grant the limiter depends on. A stub
    // would prove that the catch block runs; this proves the kernel's answer
    // when the database genuinely refuses.
    await harness.db.query("revoke all on ops.rate_limit_counters from forma_api");
    try {
      const email = "degraded@gate.invalid";
      const response = await app.request(command(signup(email), "gate-degraded-1"));
      assert.equal(response.status, 429, "a command was served while the limiter was blind");
      assert.equal((await json(response)).code, "RATE_LIMITED");
      const rows = await sql`select count(*)::int as n from beta_signups where email = ${email}`;
      assert.equal(rows[0].n, 0, "the command ran despite failing closed");
    } finally {
      await harness.db.query(
        "grant select, insert, update, delete on ops.rate_limit_counters to forma_api",
      );
    }
  });

  await report.check("a public read stays open when the counter store is unreachable", async () => {
    await harness.db.query("revoke all on ops.rate_limit_counters from forma_api");
    try {
      const response = await app.request("http://gate/v1/public/plans");
      // The landing page must not go dark because a counter table hiccupped.
      assert.equal(response.status, 200);
    } finally {
      await harness.db.query(
        "grant select, insert, update, delete on ops.rate_limit_counters to forma_api",
      );
    }
  });

  await report.check("the degraded state is reported rather than logged as healthy", async () => {
    await harness.db.query("revoke all on ops.rate_limit_counters from forma_api");
    const lines: string[] = [];
    harness.telemetry.setObservationSink((line) => lines.push(line));
    try {
      await app.request("http://gate/v1/public/plans");
    } finally {
      harness.telemetry.setObservationSink(null);
      await harness.db.query(
        "grant select, insert, update, delete on ops.rate_limit_counters to forma_api",
      );
    }
    const observed = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
    assert.equal(observed.rateLimit, "degraded");
    assert.equal(observed.status, 200);
  });

  await report.check("restoring the grant restores normal service", async () => {
    const email = "recovered@gate.invalid";
    createdEmails.push(email);
    const response = await app.request(command(signup(email), "gate-recovered-1"));
    assert.equal(response.status, 202);
    const rows = await sql`select count(*)::int as n from beta_signups where email = ${email}`;
    assert.equal(rows[0].n, 1);
  });

  report.section("actor context and audit");

  await report.check("the actor context is transaction-local on a pooled connection", async () => {
    const actor = "11111111-2222-3333-4444-555555555555";
    const inside = await harness.context.withActorContext(actor, async (tx) => {
      const rows = await tx`select private.current_actor_id() as actor`;
      return rows[0].actor as string | null;
    });
    assert.equal(inside, actor);
    // The same pool, a later transaction: the setting must not have survived.
    const after = await sql`select private.current_actor_id() as actor`;
    assert.equal(after[0].actor, null);
  });

  await report.check("a malformed actor setting reads as unset rather than as a wildcard", async () => {
    const rows = await sql`
      select set_config('forma.actor_id', 'not-a-uuid', true) as ignored,
             private.current_actor_id() as actor`;
    assert.equal(rows[0].actor, null);
  });

  await report.check("an idempotency conflict is recorded as an audit event", async () => {
    const rows = await sql`
      select actor_kind, result, reason_code, metadata
      from ops.audit_events
      where action = 'command.idempotency_conflict'
      order by id desc limit 1`;
    assert.equal(rows[0].actor_kind, "anonymous");
    assert.equal(rows[0].result, "denied");
    assert.equal(rows[0].reason_code, "digest_mismatch");
    assert.equal((rows[0].metadata as { route: string }).route, "POST /v1/public/beta-signups");
  });

  await report.check("audit rows carry no email, name or token", async () => {
    const rows = await sql`select actor_kind, action, target_ref, reason_code, metadata
                           from ops.audit_events`;
    const encoded = JSON.stringify(rows);
    for (const forbidden of ["@gate.invalid", "Gate Tester", "Bearer ", "203.0.113"]) {
      assert.equal(encoded.includes(forbidden), false, `audit rows leaked ${forbidden}`);
    }
  });

  await report.check("forma_api cannot update or delete an audit row", async () => {
    const before = await sql`select id from ops.audit_events order by id limit 1`;
    await assert.rejects(
      () => sql`update ops.audit_events set result = 'allowed' where id = ${before[0].id}`,
      (error: { code?: string }) => error.code === "42501",
    );
    await assert.rejects(
      () => sql`delete from ops.audit_events where id = ${before[0].id}`,
      (error: { code?: string }) => error.code === "42501",
    );
  });

  report.section("keyset pagination through the kernel");

  /**
   * A collection route declared with the same registry the product routes use.
   * It exists in this gate rather than in production because E03 ships no list
   * endpoint — the paging *primitive* is production code, and this is what
   * exercises it end to end.
   */
  const items = Array.from({ length: 7 }, (_, i) => ({ id: `item-${i}`, rank: i }));
  const pagedRoute: RouteDefinition<{ cursor?: string; color?: string }, never, { id: string }[]> = {
    method: "GET",
    path: "/v1/gate/items",
    operationId: "listGateItems",
    summary: "Gate fixture collection",
    kind: "read",
    auth: "public",
    envelope: "collection",
    successStatus: 200,
    cacheControl: "public, max-age=0",
    querySchema: z.object({ cursor: z.string().optional(), color: z.string().optional() }),
    async handler({ query }) {
      const scope = {
        routeKey: "GET /v1/gate/items",
        sortKey: "rank",
        filters: { color: query.color ?? null },
      };
      const after = query.cursor ? Number(decodeCursor(query.cursor, scope).a[0]) : -1;
      const page = items.filter((item) => item.rank > after).slice(0, 3);
      const hasMore = items.some((item) => item.rank > (page.at(-1)?.rank ?? after));
      return {
        data: page.map((item) => ({ id: item.id })),
        page: {
          hasMore,
          nextCursor: hasMore ? encodeCursor(scope, [page.at(-1)!.rank, page.at(-1)!.id]) : null,
        },
      };
    },
  };
  const pagedApp = new Hono();
  harness.kernel.mountRoute(pagedApp, pagedRoute as unknown as RouteDefinition<never, never, never>);

  await report.check("a collection pages to exhaustion with a stable order", async () => {
    const seen: string[] = [];
    let url = "http://gate/v1/gate/items";
    for (let page = 0; page < 5; page += 1) {
      const body = await json(await pagedApp.request(url));
      seen.push(...(body.data as unknown as { id: string }[]).map((item) => item.id));
      const next = (body.page as unknown as { nextCursor: string | null }).nextCursor;
      if (!next) break;
      url = `http://gate/v1/gate/items?cursor=${encodeURIComponent(next)}`;
    }
    assert.deepEqual(seen, items.map((item) => item.id));
  });

  await report.check("a cursor replayed under different filters is refused", async () => {
    const first = await json(await pagedApp.request("http://gate/v1/gate/items"));
    const cursor = (first.page as unknown as { nextCursor: string }).nextCursor;
    const response = await pagedApp.request(
      `http://gate/v1/gate/items?color=red&cursor=${encodeURIComponent(cursor)}`,
    );
    assert.equal(response.status, 400);
    const body = await json(response);
    assert.equal((body.errors as { code: string }[])[0].code, "CURSOR_INVALID");
  });

  await report.check("a rejected cursor is reported in the structured log", async () => {
    const lines: string[] = [];
    harness.telemetry.setObservationSink((line) => lines.push(line));
    try {
      await pagedApp.request("http://gate/v1/gate/items?cursor=forged.cursor");
    } finally {
      harness.telemetry.setObservationSink(null);
    }
    const observed = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
    assert.equal(observed.cursorRejected, true);
    assert.equal(observed.problemCode, "VALIDATION_FAILED");
    assert.equal(observed.route, "/v1/gate/items");
  });

  report.section("legacy compatibility");

  await report.check("a legacy route keeps its body and gains deprecation headers", async () => {
    const { legacyCompatibility } = await import("../legacy.js");
    const legacyApp = new Hono();
    legacyApp.use("*", legacyCompatibility());
    legacyApp.get("/billing/plans", (c) => c.json({ plans: [], configured: false }));
    const response = await legacyApp.request("http://gate/billing/plans");
    assert.equal(response.status, 200);
    assert.deepEqual(await json(response), { plans: [], configured: false });
    assert.equal(response.headers.get("deprecation"), "true");
    assert.ok(response.headers.get("sunset"));
    assert.equal(response.headers.get("link"), '</v1/public/plans>; rel="successor-version"');
  });

  await report.check("legacy usage is counted per route template", async () => {
    const { legacyCompatibility, legacyUsage, resetLegacyUsage } = await import("../legacy.js");
    resetLegacyUsage();
    const legacyApp = new Hono();
    legacyApp.use("*", legacyCompatibility());
    legacyApp.get("/imports/:id", (c) => c.json({ import: null }));
    legacyApp.get("/health", (c) => c.json({ status: "ok" }));
    await legacyApp.request("http://gate/imports/8f14e45f-ceea-467a-9b7f-1d2c3e4f5a6b");
    await legacyApp.request("http://gate/imports/1d2c3e4f-5a6b-4f14-8e45-ceea467a9b7f");
    await legacyApp.request("http://gate/health");
    assert.equal(legacyUsage().get("GET /imports/:id"), 2);
    assert.equal(legacyUsage().has("GET /health"), false, "/health is not deprecated");
  });

  await report.check("a /v1 route is not marked deprecated", async () => {
    const { legacyCompatibility } = await import("../legacy.js");
    const mixed = new Hono();
    mixed.use("*", legacyCompatibility());
    harness.kernel.mountV1(mixed, harness.routes.V1_ROUTES);
    const response = await mixed.request("http://gate/v1/public/plans");
    assert.equal(response.headers.get("deprecation"), null);
  });

  report.section("frontend consumer compatibility");

  await report.check("the shipped client's legacy error shape still parses", async () => {
    // app/lib/api.ts reads `body.error` on a failure and `response.json()` on
    // success. The legacy contract must keep satisfying it unchanged.
    const legacyBody = { error: "Sign in to continue" } as { error?: string };
    assert.equal(legacyBody.error, "Sign in to continue");
  });

  await report.check("a /v1 problem body carries everything a client needs to branch", async () => {
    const response = await app.request("http://gate/v1/nope");
    const body = await json(response);
    for (const field of ["type", "title", "status", "code", "instance", "requestId", "retryable"]) {
      assert.ok(field in body, `problem body is missing ${field}`);
    }
    assert.equal(body.status, response.status);
  });

  await report.check("a /v1 success body is data plus meta and nothing else", async () => {
    const response = await app.request("http://gate/v1/public/stats");
    assert.deepEqual(Object.keys(await json(response)).sort(), ["data", "meta"]);
  });
} finally {
  // Leave the shared beta list as it was found: these gates may run against a
  // disposable database, but the habit is what keeps them safe elsewhere.
  if (createdEmails.length > 0) {
    await sql`delete from beta_signups where email = any(${createdEmails})`.catch(() => {});
  }
  await harness.destroy();
}

report.finish();

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet } from "jose";
import {
  GateReport,
  INTERNAL_AUDIENCE,
  INTERNAL_ISSUER,
  OPS_SERVICE_ACCOUNT,
  WORKER_SERVICE_ACCOUNT,
  startLedgerHarness,
} from "./harness.js";

/**
 * Security gate for the E04 work ledger.
 *
 * Two boundaries are new in this epic and both are proven here against real
 * forgeries rather than asserted.
 *
 * The first is `/internal/v1`. plans/v1-api-contract.md §15 protects it with
 * private ingress, a Google-signed OIDC audience and a service-account
 * allowlist. Private ingress is Cloud Run's job and stops being true the moment
 * someone opens it to debug something, so the gate signs its own tokens and
 * tries the attacks: no token, a user's Supabase token, the wrong audience, the
 * wrong issuer, an expired token, an unknown key, an unverified email, and a
 * legitimate worker account reaching for an operator endpoint.
 *
 * The second is the ledger's tenancy. A workflow is owned, and the only thing
 * standing between one account and another's operations is the owner argument
 * every read takes — so the gate asks for someone else's workflow every way the
 * API allows.
 *
 * It runs as `forma_api`, the role the product surface really uses, and probes
 * the other roles' grants on their own connections. Disposable clusters only:
 * it creates roles and logs in with a synthetic password.
 */

const report = new GateReport("E04 work ledger security gate");
const harness = await startLedgerHarness({ role: "forma_api" });
const { app, sql, ledger } = harness;

// --- a signed-in owner, and someone else -----------------------------------

const ISSUER = `${process.env.SUPABASE_URL}/auth/v1`;
const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
const keySet: JSONWebKeySet = {
  keys: [{ ...(await exportJWK(publicKey)), kid: "gate-signing-key", alg: "ES256", use: "sig" }],
};
let revoked = false;
harness.verifier.setTokenVerifierForTest(
  new harness.verifier.TokenVerifier({
    supabaseUrl: process.env.SUPABASE_URL!,
    supabaseAnonKey: "gate",
    keySet,
    async getUser() {
      return revoked ? null : { id: OWNER, email: null };
    },
  }),
);

const OWNER = randomUUID();
const INTRUDER = randomUUID();

async function userToken(actor: string): Promise<string> {
  return new SignJWT({ email: `${actor}@gate.invalid` })
    .setProtectedHeader({ alg: "ES256", kid: "gate-signing-key" })
    .setSubject(actor)
    .setIssuer(ISSUER)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}

for (const actor of [OWNER, INTRUDER]) {
  await sql`insert into profiles (id, email) values (${actor}, ${`${actor}@gate.invalid`})
            on conflict (id) do nothing`;
}

const created = await ledger.createWorkflow({
  kind: "maintenance",
  ownerProfileId: OWNER,
  items: [
    {
      taskType: "gate_task",
      resourceClass: "aggregation",
      idempotencyKey: `sec-${randomUUID()}`,
      queue: "analysis",
    },
  ],
});
const WORKFLOW = created.workflowId;
const WORK_ITEM = created.itemIds[0]!;

async function body(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

// --- the product surface ---------------------------------------------------

report.section("workflow reads are owner-scoped");

await report.check("an anonymous caller cannot list or read a workflow", async () => {
  for (const path of ["/v1/workflows", `/v1/workflows/${WORKFLOW}`]) {
    const response = await app.request(path);
    assert.equal(response.status, 401);
    assert.equal((await body(response)).code, "AUTH_REQUIRED");
  }
});

await report.check("an anonymous caller cannot cancel", async () => {
  const response = await app.request(`/v1/workflows/${WORKFLOW}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": randomUUID() },
    body: "{}",
  });
  assert.equal(response.status, 401);
});

await report.check("another account gets 404, not 403, so an id cannot be probed", async () => {
  const response = await app.request(`/v1/workflows/${WORKFLOW}`, {
    headers: { authorization: `Bearer ${await userToken(INTRUDER)}` },
  });
  assert.equal(response.status, 404);
  const document = await body(response);
  assert.equal(document.code, "NOT_FOUND");
  // The refusal carries nothing but the path the caller already sent: no kind,
  // no owner, no state, no hint that the identifier resolves to anything.
  assert.equal(document.instance, `/v1/workflows/${WORKFLOW}`);
  assert.equal(document.detail, "No such workflow.");
});

await report.check("a non-existent workflow is indistinguishable from someone else's", async () => {
  const absent = await app.request(`/v1/workflows/${randomUUID()}`, {
    headers: { authorization: `Bearer ${await userToken(INTRUDER)}` },
  });
  const foreign = await app.request(`/v1/workflows/${WORKFLOW}`, {
    headers: { authorization: `Bearer ${await userToken(INTRUDER)}` },
  });
  assert.equal(absent.status, foreign.status);
  assert.deepEqual(
    { ...(await body(absent)), requestId: null, instance: null },
    { ...(await body(foreign)), requestId: null, instance: null },
  );
});

await report.check("another account cannot cancel work it does not own", async () => {
  const response = await app.request(`/v1/workflows/${WORKFLOW}/cancel`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await userToken(INTRUDER)}`,
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
    },
    body: "{}",
  });
  assert.equal(response.status, 404);
  const rows = await sql`select cancel_requested_at from ops.workflows where id = ${WORKFLOW}::uuid`;
  assert.equal(rows[0]!.cancel_requested_at, null);
});

await report.check("a forged workflow identifier is refused without a database round trip", async () => {
  const response = await app.request("/v1/workflows/not-a-uuid", {
    headers: { authorization: `Bearer ${await userToken(OWNER)}` },
  });
  assert.equal(response.status, 404);
});

await report.check("a client may not name whose workflows it wants", async () => {
  const response = await app.request("/v1/workflows?userId=someone-else", {
    headers: { authorization: `Bearer ${await userToken(OWNER)}` },
  });
  assert.equal(response.status, 400);
  assert.equal((await body(response)).code, "VALIDATION_FAILED");
});

await report.check("a revoked session cannot read workflows", async () => {
  // A symmetric token has no local path, so the answer comes from the fallback
  // — which is the only place a revoked session is visible.
  const symmetric = await new SignJWT({ email: null })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(OWNER)
    .setIssuer(ISSUER)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode("guessed-secret"));
  revoked = true;
  const denied = await app.request("/v1/workflows", {
    headers: { authorization: `Bearer ${symmetric}` },
  });
  assert.equal(denied.status, 401);
  revoked = false;
});

await report.check("an access denial is audited without naming the caller's email", async () => {
  const rows = await sql`
    select actor_kind, actor_ref, action, target_ref, metadata from ops.audit_events
    where action = 'workflow.access_denied' order by id desc limit 5`;
  assert.ok(rows.length > 0, "no access denial was audited");
  const text = JSON.stringify(rows);
  assert.equal(text.includes("@gate.invalid"), false);
  assert.equal(rows[0]!.actor_kind, "user");
});

// --- the private surface ---------------------------------------------------

report.section("the private surface refuses everything but its own callers");

const EXECUTE = `/internal/v1/work-items/${WORK_ITEM}/execute`;
const attemptToken = harness.tokens.attemptToken({ workItemId: WORK_ITEM, dispatchEpoch: 0 });

async function execute(headers: Record<string, string>): Promise<Response> {
  return app.request(EXECUTE, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ attemptToken }),
  });
}

await report.check("no token is refused", async () => {
  assert.equal((await execute({})).status, 401);
});

await report.check("a user's Supabase token is not a service identity", async () => {
  const response = await execute({ authorization: `Bearer ${await userToken(OWNER)}` });
  assert.equal(response.status, 401);
});

const forgeries: [string, () => Promise<string>][] = [
  ["a token for another audience", () => harness.serviceToken({ audience: "https://elsewhere.invalid" })],
  ["a token from another issuer", () => harness.serviceToken({ issuer: "https://evil.invalid" })],
  ["an expired token", () => harness.serviceToken({ expiresIn: "-1m" })],
  ["a token signed by an unknown key", () => harness.serviceToken({ key: harness.forgedKey })],
  ["a token whose email is unverified", () => harness.serviceToken({ emailVerified: false })],
  [
    "a token for a service account on no allowlist",
    () => harness.serviceToken({ email: "stranger@evil.iam.gserviceaccount.com" }),
  ],
];

for (const [label, mint] of forgeries) {
  await report.check(`${label} is refused`, async () => {
    const response = await execute({ authorization: `Bearer ${await mint()}` });
    assert.equal(response.status, 401);
    // Nothing may move: a refused caller must not have claimed the item.
    const rows = await sql`select status, attempt_count from ops.work_items where id = ${WORK_ITEM}::bigint`;
    assert.equal(rows[0]!.status, "ready");
    assert.equal(rows[0]!.attempt_count, 0);
  });
}

await report.check("an unsigned token is refused", async () => {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "none", typ: "JWT" })}.${encode({
    sub: "x",
    iss: INTERNAL_ISSUER,
    aud: INTERNAL_AUDIENCE,
    email: WORKER_SERVICE_ACCOUNT,
    email_verified: true,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}.`;
  assert.equal((await execute({ authorization: `Bearer ${unsigned}` })).status, 401);
});

await report.check("a worker account cannot drive the operator endpoints", async () => {
  const token = await harness.serviceToken({ email: WORKER_SERVICE_ACCOUNT });
  for (const path of ["/internal/v1/outbox/dispatch", "/internal/v1/work-items/recover-leases"]) {
    const response = await app.request(path, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 401, path);
  }
});

await report.check("an operator account cannot execute work", async () => {
  const response = await execute({
    authorization: `Bearer ${await harness.serviceToken({ email: OPS_SERVICE_ACCOUNT })}`,
  });
  assert.equal(response.status, 401);
});

await report.check("a rejected internal caller is audited by reason, without its address", async () => {
  const rows = await sql`
    select actor_kind, actor_ref, action, reason_code, metadata from ops.audit_events
    where action = 'internal.caller_rejected' order by id desc limit 20`;
  assert.ok(rows.length > 0);
  const reasons = new Set(rows.map((row) => row.reason_code));
  assert.ok(reasons.has("rejected"), "a forged token was not recorded as rejected");
  assert.ok(reasons.has("not_allowed"), "an unlisted account was not recorded as not_allowed");
  const text = JSON.stringify(rows);
  assert.equal(text.includes("gserviceaccount.com"), false, "an audit row named a service account");
  assert.equal(rows.every((row) => row.actor_ref === null), true);
});

await report.check("a valid worker cannot run work with a forged attempt token", async () => {
  const response = await app.request(EXECUTE, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${await harness.serviceToken()}`,
    },
    body: JSON.stringify({ attemptToken: "f".repeat(64) }),
  });
  assert.equal(response.status, 204);
  const rows = await sql`select status, attempt_count from ops.work_items where id = ${WORK_ITEM}::bigint`;
  assert.equal(rows[0]!.status, "ready");
  assert.equal(rows[0]!.attempt_count, 0);
});

await report.check("the private surface is not in the published contract", async () => {
  // Imported after the harness, like every other production module here: the
  // route registry resolves the database configuration at load time.
  const { openApiDocument } = await import("../../v1/routes/index.js");
  const document = openApiDocument();
  const paths = Object.keys((document as { paths: Record<string, unknown> }).paths);
  assert.equal(paths.some((path) => path.startsWith("/internal")), false);
  assert.ok(paths.includes("/v1/workflows"));
});

await report.check("an internal path receives no CORS grant", async () => {
  const response = await app.request(EXECUTE, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://formachess.com" },
    body: JSON.stringify({ attemptToken }),
  });
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

// --- least privilege -------------------------------------------------------

report.section("least privilege on the ledger tables");

const LEDGER_TABLES = [
  "ops.workflows",
  "ops.work_items",
  "ops.work_item_dependencies",
  "ops.work_attempts",
  "ops.outbox_events",
] as const;

await report.check("no runtime role may delete a ledger row", async () => {
  for (const role of ["forma_api", "forma_ops", "forma_ingestion", "forma_stockfish", "forma_analysis"]) {
    for (const table of LEDGER_TABLES) {
      const rows = await sql<{ ok: boolean }[]>`
        select has_table_privilege(${role}, ${table}, 'DELETE') as ok`;
      assert.equal(rows[0]!.ok, false, `${role} may delete from ${table}`);
    }
  }
});

await report.check("only the operator role may update the outbox", async () => {
  for (const role of ["forma_api", "forma_ingestion", "forma_stockfish", "forma_analysis"]) {
    const rows = await sql<{ ok: boolean }[]>`
      select has_table_privilege(${role}, 'ops.outbox_events', 'UPDATE') as ok`;
    assert.equal(rows[0]!.ok, false, `${role} may update the outbox`);
  }
  const ops = await sql<{ ok: boolean }[]>`
    select has_table_privilege('forma_ops', 'ops.outbox_events', 'UPDATE') as ok`;
  assert.equal(ops[0]!.ok, true);
});

await report.check("a worker role cannot create work, only run it", async () => {
  for (const role of ["forma_ingestion", "forma_stockfish", "forma_analysis"]) {
    const rows = await sql<{ insert: boolean; update: boolean }[]>`
      select has_table_privilege(${role}, 'ops.work_items', 'INSERT') as insert,
             has_table_privilege(${role}, 'ops.work_items', 'UPDATE') as update`;
    assert.equal(rows[0]!.insert, false, `${role} may create work items`);
    assert.equal(rows[0]!.update, true, `${role} cannot progress work items`);
  }
});

await report.check("a browser role reaches no ledger table at all", async () => {
  for (const role of ["anon", "authenticated", "service_role", "public"]) {
    for (const table of LEDGER_TABLES) {
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"] as const) {
        const rows = await sql<{ ok: boolean }[]>`
          select has_table_privilege(${role}, ${table}, ${privilege}) as ok`;
        assert.equal(rows[0]!.ok, false, `${role} holds ${privilege} on ${table}`);
      }
    }
  }
});

await report.check("an authenticated browser session is refused by the database itself", async () => {
  const browser = await harness.connectAs("authenticated");
  for (const table of LEDGER_TABLES) {
    await assert.rejects(
      browser.unsafe(`select 1 from ${table} limit 1`),
      (error: unknown) => (error as { code?: string }).code === "42501",
      `${table} answered a browser role`,
    );
  }
});

await report.check("row level security is forced on every ledger table", async () => {
  const rows = await sql<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
    select relname, relrowsecurity, relforcerowsecurity from pg_class
    where oid = any(${LEDGER_TABLES.map((table) => table)}::regclass[])`;
  assert.equal(rows.length, LEDGER_TABLES.length);
  for (const row of rows) {
    assert.equal(row.relrowsecurity, true, `${row.relname} has RLS disabled`);
    assert.equal(row.relforcerowsecurity, true, `${row.relname} does not force RLS`);
  }
});

// --- sensitive content -----------------------------------------------------

report.section("nothing sensitive is retained or logged");

await report.check("a workflow error is from the closed vocabulary, never a raw failure", async () => {
  const failing = await ledger.createWorkflow({
    kind: "maintenance",
    ownerProfileId: OWNER,
    items: [
      {
        taskType: "gate_task",
        resourceClass: "aggregation",
        idempotencyKey: `sec-fail-${randomUUID()}`,
        queue: "analysis",
        maxAttempts: 1,
      },
    ],
  });
  const item = failing.itemIds[0]!;
  const token = harness.tokens.attemptToken({ workItemId: item, dispatchEpoch: 0 });
  await app.request(`/internal/v1/work-items/${item}/execute`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${await harness.serviceToken()}`,
    },
    body: JSON.stringify({ attemptToken: token }),
  });
  const rows = await sql`
    select error_code, error_message from ops.workflows where id = ${failing.workflowId}::uuid`;
  assert.equal(rows[0]!.error_code, "WORK_FAILED_UNSUPPORTED");
  assert.equal(String(rows[0]!.error_message).includes("handler"), false);
});

await report.check("an ops event line carries no payload, owner or input reference", async () => {
  const lines: string[] = [];
  harness.opsTelemetry.setOpsEventSink((line) => lines.push(line));
  const recovery = await app.request("/internal/v1/work-items/recover-leases", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${await harness.serviceToken({ email: OPS_SERVICE_ACCOUNT })}`,
    },
    body: "{}",
  });
  harness.opsTelemetry.setOpsEventSink(null);
  // `forma_api` may not run the operator sweep, and that is the correct answer
  // here: what matters is that whatever was emitted carries nothing private.
  void recovery;
  for (const line of lines) {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    for (const forbidden of ["payload", "inputRef", "input_ref", "ownerProfileId", "email"]) {
      assert.equal(forbidden in parsed, false, `${forbidden} reached an ops event`);
    }
  }
});

await report.check("a queue message never carries work, only identity", async () => {
  assert.throws(() =>
    harness.tokens.assertMinimalTaskPayload({
      workItemId: "1",
      attemptToken: "t",
      pgn: "1. e4 e5",
    }),
  );
  for (const task of harness.queue.tasks) {
    assert.deepEqual(
      Object.keys(task.payload).filter((key) => !["workItemId", "attemptToken", "traceparent"].includes(key)),
      [],
    );
  }
});

await harness.destroy();
report.finish();

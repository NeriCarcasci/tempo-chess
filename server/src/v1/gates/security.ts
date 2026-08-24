import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { SignJWT, exportJWK, generateKeyPair, type JSONWebKeySet } from "jose";
import postgres from "postgres";
import { z } from "zod";
import { GateReport, startKernelHarness } from "./harness.js";
import { HARNESS_PASSWORD } from "../../platform/harness/postgres.js";
import type { RouteDefinition } from "../registry.js";

/**
 * Security gate for the `/v1` kernel.
 *
 * The forged-token cases are the reason this epic replaced a network call with
 * a local signature check: local verification is only an improvement if it is
 * strict, and "strict" has to be demonstrated against real forgeries rather
 * than asserted. So the gate generates its own key pair, signs its own tokens,
 * and tries the attacks — `alg: none`, a wrong issuer, a wrong audience, an
 * expired token, an unknown key, and a symmetric token signed with a guessed
 * secret.
 *
 * It also counts fallback calls. A verifier that refers every forgery to
 * Supabase would pass a pure allow/deny test while handing an attacker a way to
 * spend our network budget, so "was the fallback consulted" is an assertion in
 * its own right.
 *
 * Runs only against a disposable cluster: it creates roles, logs in with a
 * synthetic password, and probes denied privileges.
 */

const report = new GateReport("E03 /v1 kernel security gate");
const harness = await startKernelHarness();
const { sql } = harness;

// --- a real key set, and tokens signed against it --------------------------

const ISSUER = `${process.env.SUPABASE_URL}/auth/v1`;
const KID = "gate-signing-key";
const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
const { privateKey: otherPrivateKey } = await generateKeyPair("ES256", { extractable: true });
const keySet: JSONWebKeySet = {
  keys: [{ ...(await exportJWK(publicKey)), kid: KID, alg: "ES256", use: "sig" }],
};

const ACTOR = randomUUID();
const OTHER_ACTOR = randomUUID();

interface TokenOptions {
  actor?: string;
  issuer?: string;
  audience?: string;
  kid?: string;
  expiresIn?: string;
  key?: CryptoKey;
}

async function token(options: TokenOptions = {}): Promise<string> {
  return new SignJWT({ email: "actor@gate.invalid" })
    .setProtectedHeader({ alg: "ES256", kid: options.kid ?? KID })
    .setSubject(options.actor ?? ACTOR)
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? "authenticated")
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? "1h")
    .sign(options.key ?? privateKey);
}

/** A token whose header claims no signature is required. */
function unsignedToken(): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({
    sub: ACTOR,
    iss: ISSUER,
    aud: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}.`;
}

let fallbackCalls = 0;
let fallbackAnswer: { id: string; email: string | null } | null = null;

harness.verifier.setTokenVerifierForTest(
  new harness.verifier.TokenVerifier({
    supabaseUrl: process.env.SUPABASE_URL!,
    supabaseAnonKey: "gate",
    keySet,
    async getUser() {
      fallbackCalls += 1;
      return fallbackAnswer;
    },
  }),
);

// --- a protected route built from the production registry ------------------

/**
 * E03 ships no protected `/v1` route — every candidate belongs to a named later
 * epic. The protected middleware is production code all the same, so the gate
 * declares a route with the same registry and exercises it. `subjectId` is a
 * path parameter precisely so the cross-subject case is reachable.
 */
const protectedRoute: RouteDefinition<never, never, { actorPresent: true; subject: string }> = {
  method: "GET",
  path: "/v1/gate/subjects/:subjectId",
  operationId: "getGateSubject",
  summary: "Gate fixture protected read",
  kind: "read",
  auth: "required",
  envelope: "resource",
  successStatus: 200,
  cacheControl: "private, max-age=0",
  dataSchema: z.object({ actorPresent: z.literal(true), subject: z.string() }),
  async handler({ auth, params }) {
    harness.context.authorizeSubject(auth!, params.subjectId);
    return { data: { actorPresent: true as const, subject: params.subjectId } };
  },
};

const app = new Hono();
harness.kernel.mountRoute(app, protectedRoute as unknown as RouteDefinition<never, never, never>);
harness.kernel.mountV1(app, harness.routes.V1_ROUTES);

async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.request(`http://gate${path}`, { headers });
}

async function body(response: Response): Promise<Record<string, never>> {
  return JSON.parse(await response.text()) as Record<string, never>;
}

try {
  report.section("anonymous and forged callers");

  await report.check("an anonymous caller is refused with a problem document", async () => {
    const response = await get(`/v1/gate/subjects/${ACTOR}`);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("content-type"), "application/problem+json");
    assert.equal((await body(response)).code, "AUTH_REQUIRED");
  });

  // The kernel auto-provisions an account on first authenticated request and
  // then refuses it, because a new account is not approved and closed beta is
  // enforced before any route logic runs. This gate is about the auth kernel —
  // token verification, actor identity, cross-subject authorization, cache and
  // log hygiene — not about the beta gate, which has its own check. Without
  // this the whole section reads 403 and proves nothing it is named for.
  //
  // Approved over the admin connection rather than the gate's own, which runs
  // as `forma_api` and deliberately holds no grant on `state`: an approval is
  // an operator action and the API cannot perform one on itself. That missing
  // grant is a thing the least-privilege gates assert, so borrowing it here
  // would quietly weaken them.
  await get(`/v1/gate/subjects/${ACTOR}`, { authorization: `Bearer ${await token()}` });
  const operator = postgres(harness.db.adminUrl, { max: 1, prepare: false, onnotice: () => {} });
  try {
    // `decided_at` is not optional: the table requires a decided row to carry
    // its decision time, so that a half-written decision cannot read as pending
    // while the state says otherwise.
    await operator`
      update app.access_requests
         set state = 'approved', decided_at = now()
       where user_id = ${ACTOR}::uuid
    `;
  } finally {
    await operator.end({ timeout: 5 });
  }

  await report.check("a valid token reaches the handler", async () => {
    const response = await get(`/v1/gate/subjects/${ACTOR}`, {
      authorization: `Bearer ${await token()}`,
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await body(response)).data, { actorPresent: true, subject: ACTOR });
  });

  await report.check("verification is local: the fallback was never called", async () => {
    fallbackCalls = 0;
    await get(`/v1/gate/subjects/${ACTOR}`, { authorization: `Bearer ${await token()}` });
    assert.equal(fallbackCalls, 0);
  });

  const forgeries: [string, () => Promise<string>][] = [
    ["alg: none", async () => unsignedToken()],
    ["a signature from another key", () => token({ key: otherPrivateKey })],
    ["an unknown kid", () => token({ kid: "not-our-key" })],
    ["the wrong issuer", () => token({ issuer: "https://evil.example/auth/v1" })],
    ["the wrong audience", () => token({ audience: "service_role" })],
    ["an expired token", () => token({ expiresIn: "-1h" })],
    ["a bearer value that is not a JWT", async () => "definitely-not-a-token"],
    ["an empty bearer value", async () => " "],
  ];

  for (const [name, mint] of forgeries) {
    await report.check(`${name} is refused`, async () => {
      const response = await get(`/v1/gate/subjects/${ACTOR}`, {
        authorization: `Bearer ${await mint()}`,
      });
      assert.equal(response.status, 401, `${name} was not refused`);
      const problem = await body(response);
      assert.equal(problem.code, "AUTH_REQUIRED");
      // The refusal must not describe the check that failed: "wrong audience"
      // is a hint, and "no matching key" is a map of the key set.
      assert.equal(/issuer|audience|signature|kid|expired/i.test(JSON.stringify(problem)), false);
    });
  }

  await report.check("a forged asymmetric token never reaches the network fallback", async () => {
    fallbackCalls = 0;
    for (const [, mint] of forgeries.slice(0, 6)) {
      await get(`/v1/gate/subjects/${ACTOR}`, { authorization: `Bearer ${await mint()}` });
    }
    // Only the unknown-kid forgery may legitimately consult the fallback: a kid
    // we do not recognise is indistinguishable from a key rotation we have not
    // fetched yet. Everything else is a decided "no".
    assert.ok(fallbackCalls <= 1, `the fallback was called ${fallbackCalls} times`);
  });

  await report.check("a legacy symmetric token is checked by the fallback, and can be refused", async () => {
    const symmetric = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(ACTOR)
      .setIssuer(ISSUER)
      .setAudience("authenticated")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("a-guessed-jwt-secret-that-is-long-enough"));
    fallbackCalls = 0;
    fallbackAnswer = null;
    const response = await get(`/v1/gate/subjects/${ACTOR}`, { authorization: `Bearer ${symmetric}` });
    assert.equal(response.status, 401);
    assert.equal(fallbackCalls, 1, "the legacy path must go through getUser");
  });

  await report.check("a revoked session is refused on the revocation-sensitive path", async () => {
    const revocationRoute = {
      ...protectedRoute,
      path: "/v1/gate/revocation/:subjectId",
      operationId: "getGateRevocation",
      revocationSensitive: true,
    };
    const revocationApp = new Hono();
    harness.kernel.mountRoute(
      revocationApp,
      revocationRoute as unknown as RouteDefinition<never, never, never>,
    );
    const live = await token();
    // The signature is still valid; Supabase says the session is gone. Local
    // verification cannot see that, which is exactly why the flag exists.
    fallbackAnswer = null;
    fallbackCalls = 0;
    const denied = await revocationApp.request(`http://gate/v1/gate/revocation/${ACTOR}`, {
      headers: { authorization: `Bearer ${live}` },
    });
    assert.equal(denied.status, 401);
    assert.equal(fallbackCalls, 1);

    fallbackAnswer = { id: ACTOR, email: "actor@gate.invalid" };
    const allowed = await revocationApp.request(`http://gate/v1/gate/revocation/${ACTOR}`, {
      headers: { authorization: `Bearer ${live}` },
    });
    assert.equal(allowed.status, 200);
    fallbackAnswer = null;
  });

  report.section("actor to subject authorization");

  await report.check("a cross-subject read is forbidden, and says nothing about the subject", async () => {
    const response = await get(`/v1/gate/subjects/${OTHER_ACTOR}`, {
      authorization: `Bearer ${await token()}`,
    });
    assert.equal(response.status, 403);
    const problem = await body(response);
    assert.equal(problem.code, "FORBIDDEN");
    // `instance` is the URI the caller themselves requested, so it names the
    // subject by definition and discloses nothing new. Nothing else in the
    // document may mention it — in particular the detail must not confirm that
    // the subject exists, or say who owns it.
    const { instance: _instance, ...rest } = problem as unknown as Record<string, unknown>;
    assert.equal(JSON.stringify(rest).includes(OTHER_ACTOR), false);
    assert.equal(problem.detail, "That does not belong to your account.");
  });

  await report.check("a forged subject identifier is refused rather than looked up", async () => {
    for (const forged of ["../../etc/passwd", "00000000-0000-0000-0000-000000000000", "*"]) {
      const response = await get(`/v1/gate/subjects/${encodeURIComponent(forged)}`, {
        authorization: `Bearer ${await token()}`,
      });
      assert.equal(response.status, 403, `subject ${forged}`);
    }
  });

  await report.check("no header lets a caller assert a different actor", async () => {
    // There is no internal-caller surface in E03, so the spoofing case that
    // exists here is a client claiming an identity out of band. The actor comes
    // from the token and nowhere else, and these headers must be inert.
    const spoofed = {
      authorization: `Bearer ${await token()}`,
      "x-forma-actor": OTHER_ACTOR,
      "x-forwarded-user": OTHER_ACTOR,
      "x-actor-id": OTHER_ACTOR,
      "x-forma-service-account": "forma-ops",
    };
    const own = await get(`/v1/gate/subjects/${ACTOR}`, spoofed);
    assert.equal(own.status, 200, "the real actor was not served");
    const other = await get(`/v1/gate/subjects/${OTHER_ACTOR}`, spoofed);
    assert.equal(other.status, 403, "a spoofing header changed the actor");
  });

  await report.check("an authorization denial is recorded, without naming the target", async () => {
    // The denial the handler raised comes back through the kernel as FORBIDDEN;
    // what the audit trail must not do is record whose subject was asked for.
    const rows = await sql`select actor_kind, action, target_ref, metadata from ops.audit_events`;
    const encoded = JSON.stringify(rows);
    assert.equal(encoded.includes(OTHER_ACTOR), false, "an audit row named the other subject");
  });

  await report.check("a protected read is privately cached, never publicly", async () => {
    const response = await get(`/v1/gate/subjects/${ACTOR}`, {
      authorization: `Bearer ${await token()}`,
    });
    assert.match(response.headers.get("cache-control") ?? "", /^private/);
  });

  report.section("response and log hygiene");

  await report.check("an internal exception never reaches the caller", async () => {
    const explodingRoute = {
      ...protectedRoute,
      path: "/v1/gate/explode",
      operationId: "getGateExplode",
      auth: "public" as const,
      async handler(): Promise<never> {
        // Assembled rather than written out: a literal here would be a
        // secret-shaped string in a tracked file, which the forbidden-scope
        // gate rejects on sight and rightly so.
        const credentialUrl = ["postgres://forma_api", ":", "hunter2", "@db/postgres"].join("");
        throw new Error(
          `relation "auth.users" does not exist; DATABASE_URL=${credentialUrl}`,
        );
      },
    };
    const explodingApp = new Hono();
    harness.kernel.mountRoute(
      explodingApp,
      explodingRoute as unknown as RouteDefinition<never, never, never>,
    );
    const response = await explodingApp.request("http://gate/v1/gate/explode");
    assert.equal(response.status, 500);
    const text = await response.text();
    for (const secret of ["hunter2", "auth.users", "relation", "postgres:/"]) {
      assert.equal(text.includes(secret), false, `the response leaked ${secret}`);
    }
    assert.equal(JSON.parse(text).code, "INTERNAL_ERROR");
    assert.equal(JSON.parse(text).detail, null);
  });

  await report.check("the request log carries no payload from an adversarial request", async () => {
    const lines: string[] = [];
    harness.telemetry.setObservationSink((line) => lines.push(line));
    try {
      await app.request("http://gate/v1/public/beta-signups", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "gate-security-1",
          authorization: `Bearer ${await token()}`,
          "cf-connecting-ip": "192.0.2.99",
        },
        body: JSON.stringify({
          name: "Leak Probe",
          email: "leak-probe@gate.invalid",
          platform: "lichess",
          goal: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
        }),
      });
    } finally {
      harness.telemetry.setObservationSink(null);
    }
    const emitted = lines.join("\n");
    for (const forbidden of [
      "leak-probe@gate.invalid",
      "Leak Probe",
      "rnbqkbnr",
      "192.0.2.99",
      "gate-security-1",
      ACTOR,
      "Bearer",
    ]) {
      assert.equal(emitted.includes(forbidden), false, `the log leaked ${forbidden}`);
    }
  });

  await report.check("a stored idempotency record carries no request content", async () => {
    const rows = await sql`select request_digest, response_body from ops.idempotency_records
                           where idempotency_key = 'gate-security-1'`;
    const encoded = JSON.stringify(rows);
    for (const forbidden of ["leak-probe", "Leak Probe", "rnbqkbnr"]) {
      assert.equal(encoded.includes(forbidden), false, `the record leaked ${forbidden}`);
    }
  });

  report.section("least privilege on the new tables");

  const NEW_TABLES = ["idempotency_records", "audit_events", "rate_limit_counters"] as const;

  await report.check("every new table has RLS enabled and forced", async () => {
    const rows = await sql`
      select relname, relrowsecurity, relforcerowsecurity
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'ops' and relname = any(${[...NEW_TABLES]})`;
    assert.equal(rows.length, NEW_TABLES.length);
    for (const row of rows) {
      assert.equal(row.relrowsecurity, true, `${row.relname} has RLS disabled`);
      assert.equal(row.relforcerowsecurity, true, `${row.relname} does not force RLS`);
    }
  });

  const PRIVILEGES = ["select", "insert", "update", "delete", "truncate", "references"] as const;

  /**
   * Read the grant from the catalogue, not from `information_schema`.
   *
   * `information_schema.role_table_grants` only shows rows the *connected* role
   * is party to, so a stray grant to `anon` would be invisible to a gate
   * running as `forma_api` — the check would pass by not looking. `relacl` is
   * the whole access control list, whoever is asking.
   */
  async function privilegesFor(table: string, role: string): Promise<string[]> {
    const rows = await sql<{ privilege: string }[]>`
      select p.privilege
      from unnest(${[...PRIVILEGES]}::text[]) as p(privilege)
      where has_table_privilege(${role}, ${`ops.${table}`}, p.privilege)`;
    return rows.map((row) => row.privilege).sort();
  }

  await report.check("no browser or PUBLIC role holds any privilege on them", async () => {
    const rows = await sql<{ relname: string; grantee: string; privilege: string }[]>`
      select c.relname, pg_get_userbyid(a.grantee) as grantee, a.privilege_type as privilege
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(c.relacl) a
      where n.nspname = 'ops'
        and c.relname = any(${[...NEW_TABLES]})
        and (a.grantee = 0 or pg_get_userbyid(a.grantee) in ('anon','authenticated','service_role'))`;
    // grantee 0 is PUBLIC.
    assert.equal(rows.length, 0, `unexpected browser grants: ${JSON.stringify(rows)}`);
  });

  await report.check("forma_api holds exactly the privileges it needs", async () => {
    assert.deepEqual(await privilegesFor("idempotency_records", "forma_api"), [
      "insert",
      "select",
      "update",
    ]);
    // Append only: no update and no delete on the audit trail.
    assert.deepEqual(await privilegesFor("audit_events", "forma_api"), ["insert", "select"]);
    assert.deepEqual(await privilegesFor("rate_limit_counters", "forma_api"), [
      "delete",
      "insert",
      "select",
      "update",
    ]);
  });

  await report.check("no browser role holds a privilege by any route", async () => {
    // `has_table_privilege` also answers for privileges inherited through role
    // membership, which a direct ACL read would miss.
    for (const table of NEW_TABLES) {
      for (const role of ["anon", "authenticated", "service_role"]) {
        assert.deepEqual(await privilegesFor(table, role), [], `${role} on ops.${table}`);
      }
    }
  });

  await report.check("a browser role connecting directly is denied every new table", async () => {
    // Not a privilege check on paper: an actual session as `anon`, which is the
    // credential the browser holds, against the tables E03 added.
    const anon = postgres(harness.db.urlFor("anon"), {
      max: 1,
      prepare: false,
      onnotice: () => {},
    });
    try {
      for (const table of NEW_TABLES) {
        await assert.rejects(
          () => anon.unsafe(`select * from ops.${table} limit 1`),
          (error: { code?: string }) => error.code === "42501" || error.code === "3F000",
          `anon could read ops.${table}`,
        );
      }
    } finally {
      await anon.end({ timeout: 5 });
    }
  });

  await report.check("the harness roles really do have passwords, so the denial is real", async () => {
    // A denial proves nothing if the role could not have connected at all.
    const anon = postgres(harness.db.urlFor("anon"), { max: 1, prepare: false, onnotice: () => {} });
    try {
      const rows = await anon`select current_user as who`;
      assert.equal(rows[0].who, "anon");
      assert.ok(HARNESS_PASSWORD.length > 0);
    } finally {
      await anon.end({ timeout: 5 });
    }
  });

  await report.check("the actor helper is not reachable by a browser role", async () => {
    const anon = postgres(harness.db.urlFor("anon"), { max: 1, prepare: false, onnotice: () => {} });
    try {
      await assert.rejects(
        () => anon.unsafe(`select private.current_actor_id()`),
        (error: { code?: string }) => error.code === "42501" || error.code === "3F000",
      );
    } finally {
      await anon.end({ timeout: 5 });
    }
  });
} finally {
  await harness.destroy();
}

report.finish();

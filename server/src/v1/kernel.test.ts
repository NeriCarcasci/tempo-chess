import "./gates/unit-env.js";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { decodeCursor, encodeCursor, filterDigest, resolveLimit } from "./cursor.js";
import { computeEtag, assertIfMatch, ifNoneMatchSatisfied } from "./etag.js";
import { collection, resource } from "./envelope.js";
import { mintRequestId, resolveRequestId, resolveTraceId } from "./identifiers.js";
import { requireIdempotencyKey, requestDigest, MAX_KEY_LENGTH } from "./idempotency.js";
import { generateOpenApiDocument } from "./openapi.js";
import {
  PROBLEM_CODES,
  PROBLEM_CODE_LIST,
  ProblemError,
  problemDocument,
  problemTypeUri,
  toProblemError,
} from "./problem.js";
import { POLICIES, clientAddress, windowStart } from "./rate-limit.js";
import { routeKey, requiresIdempotencyKey, type RouteDefinition } from "./registry.js";
import { setSigningKeyForTest, inspectKernelConfig, sign, signatureMatches } from "./signing.js";
import { Hono } from "hono";
import { mountRoute } from "./kernel.js";
import { setTokenVerifierForTest, TokenVerifier } from "./auth/verifier.js";
import { setAuthorizationContextForTest, type AuthorizationContext } from "./auth/context.js";
import { ACCESS_STATES, grantsProductAccess, type AccessState } from "../access/contract.js";
import { OBSERVATION_FIELDS, observationLine } from "./telemetry.js";
import { parseOrProblem } from "./validation.js";
import { assertNoClientIdentity, authorizeSubject } from "./auth/context.js";
import { classifyHeader, issuerFor, jwksUrlFor } from "./auth/jwt.js";
import { bearerToken } from "./auth/verifier.js";
import { LEGACY_SUCCESSORS, legacyRouteTemplate } from "./legacy.js";
import { V1_ROUTES } from "./routes/index.js";

/**
 * Unit gate for the `/v1` kernel.
 *
 * Deterministic and offline: no database, no network, no clock dependence. The
 * pieces that need a real PostgreSQL or a real HTTP round trip are proven by
 * `gates/integration.ts` and `gates/security.ts`; what is here is the logic
 * those gates would otherwise be unable to isolate.
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

// A fixed key, so every signature in this file is reproducible.
setSigningKeyForTest(createHash("sha256").update("e03-unit-gate").digest());

console.log("problem details");

check("every code has a status, a title and a type URI", () => {
  for (const code of PROBLEM_CODE_LIST) {
    const spec = PROBLEM_CODES[code];
    assert.ok(spec.status >= 400 && spec.status < 600, `${code} status`);
    assert.ok(spec.title.length > 0, `${code} title`);
    assert.match(problemTypeUri(code), /^https:\/\/docs\.formachess\.com\/problems\/[a-z-]+$/);
  }
});

check("the contract's named codes are all present", () => {
  // plans/v1-api-contract.md §1.3.
  for (const code of [
    "AUTH_REQUIRED",
    "FORBIDDEN",
    "NOT_FOUND",
    "VALIDATION_FAILED",
    "CONFLICT",
    "IDEMPOTENCY_CONFLICT",
    "RATE_LIMITED",
    "ENTITLEMENT_REQUIRED",
    "PROVIDER_UNAVAILABLE",
    "PROVIDER_RATE_LIMITED",
    "UNSUPPORTED_GAME",
    "INSUFFICIENT_COVERAGE",
    "WORKFLOW_NOT_CANCELLABLE",
    "INTERNAL_ERROR",
  ]) {
    assert.ok(PROBLEM_CODE_LIST.includes(code as never), `${code} is missing`);
  }
});

check("an unknown throw becomes INTERNAL_ERROR with no detail", () => {
  const problem = toProblemError(new Error("relation \"secrets\" does not exist"));
  assert.equal(problem.code, "INTERNAL_ERROR");
  const document = problemDocument(problem, { path: "/v1/x", requestId: "req_1" });
  assert.equal(document.detail, null);
  assert.equal(JSON.stringify(document).includes("secrets"), false);
});

check("a curated detail carrying a secret is still redacted", () => {
  // Assembled at runtime rather than written out, so this file does not become
  // its own hit in the forbidden-scope gate's secret-shaped scan. The value is
  // synthetic and the assembly is the same idiom that gate uses on itself.
  const credentialUrl = ["postgres://forma_api", ":", "hunter2", "@db.example.com:5432/postgres"].join("");
  const problem = new ProblemError("VALIDATION_FAILED", {
    detail: `could not reach ${credentialUrl}`,
  });
  const document = problemDocument(problem, { path: "/v1/x", requestId: "req_1" });
  assert.equal(document.detail?.includes("hunter2"), false);
  assert.match(document.detail ?? "", /\[redacted:database-url\]/);
});

check("instance is the path, never the query string", () => {
  const document = problemDocument(new ProblemError("NOT_FOUND"), {
    path: "/v1/public/stats",
    requestId: "req_1",
  });
  assert.equal(document.instance, "/v1/public/stats");
});

check("errors is null rather than an empty array", () => {
  const document = problemDocument(new ProblemError("VALIDATION_FAILED", { errors: [] }), {
    path: "/v1/x",
    requestId: "req_1",
  });
  assert.equal(document.errors, null);
});

console.log("envelopes");

check("a resource envelope always carries the request id", () => {
  assert.deepEqual(resource({ a: 1 }, "req_2"), { data: { a: 1 }, meta: { requestId: "req_2" } });
});

check("redactions appear only when something was withheld", () => {
  assert.equal("redactions" in resource({}, "req_2").meta, false);
  const withRedaction = resource({}, "req_2", [{ path: "data.x", reason: "entitlement" }]);
  assert.equal(withRedaction.meta.redactions?.length, 1);
});

check("a collection without more pages reports a null cursor", () => {
  const page = collection([1, 2], { nextCursor: "abc", hasMore: false }, "req_2");
  assert.equal(page.page.nextCursor, null);
  assert.equal(page.page.hasMore, false);
});

console.log("canonical encoding, ETags and preconditions");

check("key order does not change the canonical encoding", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
});

check("undefined members are dropped, null members are kept", () => {
  assert.equal(canonicalJson({ a: undefined, b: null }), '{"b":null}');
});

check("a non-finite number has no canonical form", () => {
  assert.throws(() => canonicalJson({ a: Number.NaN }), RangeError);
});

check("the ETag ignores meta so a repeated read still matches", () => {
  const first = { data: { x: 1 }, meta: { requestId: mintRequestId() } };
  const second = { data: { x: 1 }, meta: { requestId: mintRequestId() } };
  assert.equal(computeEtag(first), computeEtag(second));
  assert.notEqual(computeEtag(first), computeEtag({ data: { x: 2 }, meta: first.meta }));
});

check("If-None-Match matches a listed tag or a wildcard", () => {
  const etag = computeEtag({ data: 1 });
  assert.equal(ifNoneMatchSatisfied(`"other", ${etag}`, etag), true);
  assert.equal(ifNoneMatchSatisfied("*", etag), true);
  assert.equal(ifNoneMatchSatisfied('"other"', etag), false);
  assert.equal(ifNoneMatchSatisfied(null, etag), false);
});

check("a missing If-Match is 428 and a stale one is 412", () => {
  const etag = computeEtag({ data: 1 });
  assert.throws(
    () => assertIfMatch(null, etag),
    (error: ProblemError) => error.code === "PRECONDITION_REQUIRED" && error.status === 428,
  );
  assert.throws(
    () => assertIfMatch('"stale"', etag),
    (error: ProblemError) => error.code === "PRECONDITION_FAILED" && error.status === 412,
  );
  assert.doesNotThrow(() => assertIfMatch(etag, etag));
});

check("a weak validator does not satisfy a strong comparison", () => {
  const etag = computeEtag({ data: 1 });
  assert.equal(ifNoneMatchSatisfied(`W/${etag}`, etag), false);
});

console.log("cursors");

const scope = { routeKey: "GET /v1/games", sortKey: "playedAt", filters: { color: "white" } };

check("a cursor round-trips within its own scope", () => {
  const cursor = encodeCursor(scope, ["2026-01-01", "id-1"]);
  assert.deepEqual(decodeCursor(cursor, scope).a, ["2026-01-01", "id-1"]);
});

check("a tampered payload fails the signature", () => {
  const cursor = encodeCursor(scope, ["2026-01-01", "id-1"]);
  const [payload, signature] = cursor.split(".");
  const forged = Buffer.from(
    canonicalJson({ v: 1, k: scope.routeKey, f: filterDigest(scope.filters), s: "playedAt", a: ["9999", "id-9"] }),
  ).toString("base64url");
  assert.throws(
    () => decodeCursor(`${forged}.${signature}`, scope),
    (error: ProblemError) => error.code === "VALIDATION_FAILED",
  );
  assert.ok(payload.length > 0);
});

check("a cursor from another route is refused", () => {
  const cursor = encodeCursor(scope, ["a", "b"]);
  assert.throws(() => decodeCursor(cursor, { ...scope, routeKey: "GET /v1/findings" }));
});

check("a cursor is bound to the filters it was issued for", () => {
  const cursor = encodeCursor(scope, ["a", "b"]);
  assert.throws(() => decodeCursor(cursor, { ...scope, filters: { color: "black" } }));
});

check("filter digests ignore key order", () => {
  assert.equal(filterDigest({ a: 1, b: 2 }), filterDigest({ b: 2, a: 1 }));
});

check("garbage is a validation failure, never a crash", () => {
  for (const value of ["", ".", "a.b", "!!!.!!!", "x".repeat(500)]) {
    assert.throws(
      () => decodeCursor(value, scope),
      (error: ProblemError) => error.code === "VALIDATION_FAILED",
      `cursor ${JSON.stringify(value.slice(0, 12))}`,
    );
  }
});

check("the rejection never says which check failed", () => {
  try {
    decodeCursor("aaaa.bbbb", scope);
    assert.fail("expected a rejection");
  } catch (error) {
    const document = problemDocument(error as ProblemError, { path: "/v1/games", requestId: "req_3" });
    assert.equal(document.errors?.[0].code, "CURSOR_INVALID");
    assert.equal(/signature|filter|version/i.test(JSON.stringify(document)), false);
  }
});

check("limit defaults to 25 and caps at 100", () => {
  assert.equal(resolveLimit(undefined), 25);
  assert.equal(resolveLimit("10"), 10);
  assert.equal(resolveLimit("1000"), 100);
  assert.throws(() => resolveLimit("0"));
  assert.throws(() => resolveLimit("-1"));
  assert.throws(() => resolveLimit("abc"));
});

console.log("signing");

check("a signature is bound to its purpose", () => {
  assert.notEqual(sign("cursor", ["x"]), sign("idempotency-digest", ["x"]));
});

check("length prefixing prevents part-boundary collisions", () => {
  assert.notEqual(sign("cursor", ["a", "bc"]), sign("cursor", ["ab", "c"]));
});

check("signature comparison rejects a wrong-length or non-hex candidate", () => {
  const expected = sign("cursor", ["x"]);
  assert.equal(signatureMatches(expected, expected), true);
  assert.equal(signatureMatches(expected, expected.slice(0, 10)), false);
  assert.equal(signatureMatches(expected, "z".repeat(expected.length)), false);
});

check("a deployed process without a signing key is rejected", () => {
  assert.deepEqual(inspectKernelConfig({ FORMA_ENV: "production" }).map((f) => f.code), [
    "API_SIGNING_KEY_MISSING",
  ]);
  assert.deepEqual(
    inspectKernelConfig({ FORMA_ENV: "production", FORMA_API_SIGNING_KEY: "short" }).map((f) => f.code),
    ["API_SIGNING_KEY_TOO_SHORT"],
  );
  assert.deepEqual(
    inspectKernelConfig({
      FORMA_ENV: "production",
      FORMA_API_SIGNING_KEY: randomBytes(32).toString("hex"),
    }),
    [],
  );
  assert.deepEqual(inspectKernelConfig({}), []);
});

check("a finding never contains the key it rejected", () => {
  const findings = inspectKernelConfig({ FORMA_ENV: "production", FORMA_API_SIGNING_KEY: "s3cret" });
  assert.equal(JSON.stringify(findings).includes("s3cret"), false);
});

console.log("identifiers");

check("a caller-supplied request id is accepted only in the allowed shape", () => {
  assert.equal(resolveRequestId("abcdefgh12345"), "abcdefgh12345");
  for (const bad of ["short", "has space", "a".repeat(65), "<script>", null, undefined]) {
    assert.match(resolveRequestId(bad as string | null), /^req_[0-9a-z]{26}$/);
  }
});

check("minted request ids are unique and URL-safe", () => {
  const minted = new Set(Array.from({ length: 200 }, () => mintRequestId()));
  assert.equal(minted.size, 200);
  for (const id of minted) assert.match(id, /^req_[0-9a-z]{26}$/);
});

check("trace ids come from either header, and the all-zero id is invalid", () => {
  assert.equal(
    resolveTraceId({ traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" }),
    "4bf92f3577b34da6a3ce929d0e0e4736",
  );
  assert.equal(
    resolveTraceId({ cloudTrace: "105445aa7843bc8bf206b12000100000/1;o=1" }),
    "105445aa7843bc8bf206b12000100000",
  );
  assert.match(resolveTraceId({ traceparent: "00-" + "0".repeat(32) + "-x-01" }), /^[0-9a-f]{32}$/);
  assert.match(resolveTraceId({}), /^[0-9a-f]{32}$/);
});

console.log("idempotency");

check("a missing or malformed key is a validation failure", () => {
  for (const bad of [undefined, "", "   ", "has space", "a".repeat(MAX_KEY_LENGTH + 1), "curly{}"]) {
    assert.throws(
      () => requireIdempotencyKey(bad),
      (error: ProblemError) => error.code === "VALIDATION_FAILED",
      `key ${JSON.stringify(bad)}`,
    );
  }
  assert.equal(requireIdempotencyKey(" 0198a1b2-c3d4 "), "0198a1b2-c3d4");
});

check("the digest is stable across key order and differs across bodies", () => {
  const scopeA = { routeKey: "POST /v1/x", method: "POST", actorProfileId: null };
  assert.equal(
    requestDigest(scopeA, { a: 1, b: 2 }),
    requestDigest(scopeA, { b: 2, a: 1 }),
  );
  assert.notEqual(requestDigest(scopeA, { a: 1 }), requestDigest(scopeA, { a: 2 }));
  assert.notEqual(
    requestDigest(scopeA, { a: 1 }),
    requestDigest({ ...scopeA, routeKey: "POST /v1/y" }, { a: 1 }),
  );
});

check("the digest is keyed, so it is not a plain hash of the body", () => {
  const digest = requestDigest({ routeKey: "POST /v1/x", method: "POST", actorProfileId: null }, { email: "a@b.co" });
  const plain = createHash("sha256").update(canonicalJson({ email: "a@b.co" })).digest("hex");
  assert.notEqual(digest, plain);
  assert.match(digest, /^[0-9a-f]{64}$/);
});

console.log("rate limiting");

check("a window start is shared by every instance in the window", () => {
  const at = new Date("2026-08-17T12:34:56.789Z");
  assert.equal(windowStart(POLICIES.betaSignupAddress, at).toISOString(), "2026-08-17T12:00:00.000Z");
  assert.equal(windowStart(POLICIES.publicRead, at).toISOString(), "2026-08-17T12:34:00.000Z");
});

check("the client address prefers Cloudflare, then the first forwarded hop", () => {
  assert.equal(clientAddress({ cfConnectingIp: "1.1.1.1", forwardedFor: "2.2.2.2" }), "1.1.1.1");
  assert.equal(clientAddress({ forwardedFor: "2.2.2.2, 3.3.3.3" }), "2.2.2.2");
  assert.equal(clientAddress({}), "unknown");
});

console.log("authorization");

check("a subject the actor does not own is forbidden, not not-found", () => {
  const context = {
    actorId: "a",
    profileId: "a",
    email: null,
    plan: "free" as const,
    authMode: "jwks" as const,
    subjects: ["a"],
  };
  assert.doesNotThrow(() => authorizeSubject(context, "a"));
  for (const other of ["b", "", "A"]) {
    assert.throws(
      () => authorizeSubject(context, other),
      (error: ProblemError) => error.code === "FORBIDDEN" && error.status === 403,
      `subject ${JSON.stringify(other)}`,
    );
  }
});

check("an empty subject list denies everything", () => {
  assert.throws(() =>
    authorizeSubject(
      { actorId: "a", profileId: "a", email: null, plan: "free", authMode: "jwks", subjects: [] },
      "a",
    ),
  );
});

check("a client-supplied identity field is rejected, not ignored", () => {
  for (const field of ["userId", "user_id", "subjectId", "profileId", "ownerUserId"]) {
    assert.throws(
      () => assertNoClientIdentity({ [field]: "someone-else" }, "body"),
      (error: ProblemError) =>
        error.code === "VALIDATION_FAILED" &&
        error.fieldErrors?.[0].code === "CLIENT_SUPPLIED_IDENTITY",
      field,
    );
  }
  assert.doesNotThrow(() => assertNoClientIdentity({ username: "ok" }, "body"));
  assert.doesNotThrow(() => assertNoClientIdentity(null, "body"));
});

check("the rejection does not echo the value the client sent", () => {
  try {
    assertNoClientIdentity({ userId: "victim-uuid" }, "body");
    assert.fail("expected a rejection");
  } catch (error) {
    assert.equal(JSON.stringify((error as ProblemError).fieldErrors).includes("victim-uuid"), false);
  }
});

console.log("token shapes");

check("bearer extraction is case-insensitive and rejects an empty token", () => {
  assert.equal(bearerToken("Bearer abc"), "abc");
  assert.equal(bearerToken("bearer  abc  "), "abc");
  assert.equal(bearerToken("Bearer "), null);
  assert.equal(bearerToken("Basic abc"), null);
  assert.equal(bearerToken(null), null);
});

check("only the asymmetric algorithms are verified locally", () => {
  const header = (value: object) =>
    `${Buffer.from(JSON.stringify(value)).toString("base64url")}.e30.sig`;
  assert.equal(classifyHeader(header({ alg: "ES256", kid: "k" })).local, true);
  assert.equal(classifyHeader(header({ alg: "RS256", kid: "k" })).local, true);
  assert.equal(classifyHeader(header({ alg: "HS256" })).local, false);
  assert.equal(classifyHeader(header({ alg: "none" })).local, false);
  assert.equal(classifyHeader("not-a-jwt").local, false);
  assert.equal(classifyHeader(header({ alg: "none" })).algorithm, "none");
});

check("issuer and JWKS URL are derived from the project URL", () => {
  assert.equal(issuerFor("https://p.supabase.co/"), "https://p.supabase.co/auth/v1");
  assert.equal(
    jwksUrlFor("https://p.supabase.co").toString(),
    "https://p.supabase.co/auth/v1/.well-known/jwks.json",
  );
});

console.log("validation");

check("a validation error names the path and the rule, never the value", () => {
  const schema = z.object({ email: z.string().email(), age: z.number().int().min(18) });
  try {
    parseOrProblem(schema, { email: "nope@@bad", age: 4 }, "request body");
    assert.fail("expected a validation failure");
  } catch (error) {
    const problem = error as ProblemError;
    assert.equal(problem.code, "VALIDATION_FAILED");
    const encoded = JSON.stringify(problem.fieldErrors);
    assert.equal(encoded.includes("nope@@bad"), false);
    assert.deepEqual(problem.fieldErrors?.map((e) => e.path).sort(), ["age", "email"]);
  }
});

console.log("observability");

check("the request line emits exactly the allowlisted fields", () => {
  const line = observationLine({
    requestId: "req_1",
    traceId: "a".repeat(32),
    route: "/v1/public/stats",
    method: "GET",
    status: 200,
    durationMs: 12.7,
    surface: "v1",
    authMode: "jwks",
    actorPresent: true,
    problemCode: null,
    idempotency: "none",
    cursorRejected: false,
    rateLimit: "ok",
    redactions: 0,
    deprecated: false,
  });
  assert.deepEqual(Object.keys(JSON.parse(line)).sort(), [...OBSERVATION_FIELDS].sort());
});

check("the line carries no actor identifier and no raw path", () => {
  const line = observationLine({
    requestId: "req_1",
    traceId: "a".repeat(32),
    route: "/v1/games/:gameId",
    method: "GET",
    status: 403,
    durationMs: 3,
    surface: "v1",
    authMode: "fallback",
    actorPresent: true,
    problemCode: "FORBIDDEN",
    idempotency: "none",
    cursorRejected: false,
    rateLimit: "ok",
    redactions: 1,
    deprecated: false,
  });
  const parsed = JSON.parse(line) as Record<string, unknown>;
  assert.equal("actorId" in parsed, false);
  assert.equal("path" in parsed, false);
  assert.equal(parsed.actorPresent, true);
});

console.log("legacy compatibility");

check("route templates collapse identifiers so cardinality stays bounded", () => {
  assert.equal(
    legacyRouteTemplate("/imports/8f14e45f-ceea-467a-9b7f-1d2c3e4f5a6b/cancel"),
    "/imports/:id/cancel",
  );
  assert.equal(legacyRouteTemplate("/lessons/42/progress"), "/lessons/:n/progress");
  assert.equal(legacyRouteTemplate("/stats/reach"), "/stats/reach");
});

check("every declared successor is a mounted /v1 path", () => {
  const mounted = new Set(V1_ROUTES.map((route) => route.path));
  for (const successor of Object.values(LEGACY_SUCCESSORS)) {
    assert.ok(mounted.has(successor), `${successor} is not mounted`);
  }
});

console.log("route registry and OpenAPI");

check("every route declares a unique key and operation id", () => {
  const keys = V1_ROUTES.map((route) => routeKey(route));
  const ids = V1_ROUTES.map((route) => route.operationId);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(new Set(ids).size, ids.length);
});

check("every command requires an idempotency key and every read does not", () => {
  for (const route of V1_ROUTES) {
    assert.equal(requiresIdempotencyKey(route), route.kind === "command", route.path);
  }
});

check("no command is cacheable and every read declares its caching", () => {
  for (const route of V1_ROUTES) {
    if (route.kind === "command") {
      assert.equal(route.cacheControl, undefined, `${route.path} declares caching`);
      assert.equal(route.etag ?? false, false, `${route.path} declares an ETag`);
    } else {
      assert.ok(route.cacheControl, `${route.path} has no cache directive`);
    }
  }
});

check("a public read is never marked private and an authenticated read never public", () => {
  for (const route of V1_ROUTES) {
    if (route.kind !== "read") continue;
    const directive = route.cacheControl ?? "";
    // `no-store` is legitimate on either side. E20's player directory is public
    // and must still never sit in a shared cache: the risk on that endpoint is
    // enumeration rather than load, and a CDN holding "who matches `an`" is an
    // enumeration cache in front of it. What must never happen is a public read
    // marked private, or an authenticated read marked public.
    const allowed = route.auth === "public" ? "public" : "private";
    assert.equal(
      directive.startsWith(allowed) || directive.startsWith("no-store"),
      true,
      `${route.path}: ${directive}`,
    );
  }
});

const document = generateOpenApiDocument(V1_ROUTES as RouteDefinition<never, never, never>[]);

check("the document is OpenAPI 3.1 with a path per mounted route", () => {
  assert.equal(document.openapi, "3.1.0");
  const paths = document.paths as Record<string, Record<string, unknown>>;
  for (const route of V1_ROUTES) {
    const key = route.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
    assert.ok(paths[key], `${route.path} is missing from the document`);
    assert.ok(paths[key][route.method.toLowerCase()], `${route.method} ${route.path} is missing`);
  }
});

check("the document describes no path that is not mounted", () => {
  const mounted = new Set(V1_ROUTES.map((route) => route.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}")));
  for (const path of Object.keys(document.paths as object)) {
    assert.ok(mounted.has(path), `${path} is documented but not mounted`);
  }
});

check("commands document the Idempotency-Key header and its conflicts", () => {
  const paths = document.paths as Record<string, Record<string, never>>;
  for (const route of V1_ROUTES.filter((r) => r.kind === "command")) {
    // The document uses OpenAPI's `{param}` spelling, not Hono's `:param`.
    // Every command had a static path until E04 added one that does not.
    const key = route.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
    const operation = paths[key][route.method.toLowerCase()] as {
      parameters?: { name: string; required: boolean }[];
      responses: Record<string, unknown>;
    };
    const header = operation.parameters?.find((p) => p.name === "Idempotency-Key");
    assert.ok(header?.required, `${route.path} does not require Idempotency-Key`);
    assert.ok(operation.responses["409"], `${route.path} does not document 409`);
  }
});

check("every operation documents the problem schema for its failures", () => {
  const paths = document.paths as Record<string, Record<string, never>>;
  for (const route of V1_ROUTES) {
    const operation = paths[route.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}")][
      route.method.toLowerCase()
    ] as { responses: Record<string, { content?: Record<string, { schema: { $ref?: string } }> }> };
    const problems = Object.entries(operation.responses).filter(([status]) => Number(status) >= 400);
    assert.ok(problems.length > 0, `${route.path} documents no failure`);
    for (const [status, response] of problems) {
      assert.equal(
        response.content?.["application/problem+json"]?.schema.$ref,
        "#/components/schemas/Problem",
        `${route.path} ${status}`,
      );
    }
  }
});

check("the beta signup body schema reaches the document", () => {
  const operation = (document.paths as Record<string, Record<string, never>>)[
    "/v1/public/beta-signups"
  ].post as { requestBody: { content: Record<string, { schema: Record<string, unknown> }> } };
  const schema = operation.requestBody.content["application/json"].schema;
  assert.deepEqual((schema.required as string[]).sort(), ["email", "name", "platform"]);
  assert.equal((schema.properties as Record<string, unknown>).ratingBand !== undefined, true);
});

console.log("closed beta access gate");

/**
 * The gate, through a mounted route and a real HTTP round trip.
 *
 * Not a call to the gate function: the claim worth proving is that an
 * unapproved account is refused by the *kernel*, before any handler runs, on a
 * route that did nothing to opt in. A unit test of the predicate alone would
 * still pass if somebody deleted the line that calls it.
 *
 * Both boundaries that leave the process are stubbed, and neither is the thing
 * under test. What a real database proves instead — that the row behind
 * `auth.access` is readable at all under row level security — is in
 * `gates/integration.ts`. Neither test replaces the other.
 */
async function checkAsync(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${name}: ${(error as Error).message}`);
  }
}

const GATE_ACTOR = "3f1a1d2e-0000-4000-8000-00000000beef";

function contextWith(state: AccessState): AuthorizationContext {
  return {
    actorId: GATE_ACTOR,
    profileId: GATE_ACTOR,
    email: "gate@example.invalid",
    plan: "free",
    authMode: "fallback",
    subjects: [GATE_ACTOR],
    access: {
      userId: GATE_ACTOR,
      state,
      note: null,
      requestedAt: "2026-08-01T00:00:00.000Z",
      noteUpdatedAt: null,
      decidedAt: state === "pending" ? null : "2026-08-02T00:00:00.000Z",
      decisionNote: null,
    },
  };
}

setTokenVerifierForTest(
  new TokenVerifier({
    supabaseUrl: "https://unit.supabase.invalid",
    supabaseAnonKey: "unit-gate-anon-key",
    // An opaque token is not a local JWT, so verification takes the fallback
    // path and this stands in for `supabase.auth.getUser`.
    getUser: async () => ({ id: GATE_ACTOR, email: "gate@example.invalid" }),
  }),
);

/**
 * A token shaped like the legacy symmetric one, so verification takes the
 * fallback path where `getUser` stands in for Supabase.
 *
 * The verifier refuses anything that is neither a locally verifiable JWT nor
 * `alg: HS256` before it will spend a round trip, which is the right behaviour
 * and means an opaque string never reaches the stub. Nothing checks the
 * signature on this path; the stub above is the authority.
 */
const GATE_TOKEN = [
  Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
  Buffer.from(JSON.stringify({ sub: GATE_ACTOR })).toString("base64url"),
  Buffer.from("unit-gate").toString("base64url"),
].join(".");

/** Set by a handler when it runs, so "refused" can be told from "ran, then 403". */
let handlerRan = false;

function probe(path: string, access?: "self"): RouteDefinition<never, never, { ok: boolean }> {
  return {
    method: "GET",
    path,
    operationId: `probe_${path.replace(/[^a-z]+/gi, "_")}`,
    summary: "gate probe",
    kind: "read",
    auth: "required",
    ...(access ? { access } : {}),
    envelope: "resource",
    successStatus: 200,
    cacheControl: "private, no-store",
    async handler() {
      handlerRan = true;
      return { data: { ok: true } };
    },
  };
}

const gateApp = new Hono();
mountRoute(gateApp, probe("/v1/probe/product") as unknown as RouteDefinition<never, never, never>);
mountRoute(gateApp, probe("/v1/probe/self", "self") as unknown as RouteDefinition<never, never, never>);

function signedIn(path: string): Promise<Response> {
  return gateApp.request(path, { headers: { Authorization: `Bearer ${GATE_TOKEN}` } });
}

for (const state of ACCESS_STATES) {
  await checkAsync(`${state}: a route that opted into nothing refuses it`, async () => {
    setAuthorizationContextForTest(contextWith(state));
    handlerRan = false;
    const response = await signedIn("/v1/probe/product");
    if (grantsProductAccess(state)) {
      assert.equal(response.status, 200, "an approved account is served");
      assert.equal(handlerRan, true);
      return;
    }
    assert.equal(response.status, 403);
    assert.equal(handlerRan, false, "the handler must not run for an unapproved account");
    const body = (await response.json()) as { code: string; status: number; retryable: boolean; detail: string | null };
    // `FORBIDDEN` already means "that is somebody else's". A client cannot send
    // somebody who is merely waiting to the right screen if the two collapse.
    assert.equal(body.code, "ACCESS_NOT_APPROVED");
    assert.equal(body.status, 403);
    assert.equal(body.retryable, false);
    assert.ok((body.detail ?? "").length > 0, "the refusal says which state it is");
  });
}

await checkAsync("an unapproved account may still read its own access state", async () => {
  setAuthorizationContextForTest(contextWith("pending"));
  handlerRan = false;
  const response = await signedIn("/v1/probe/self");
  assert.equal(response.status, 200);
  assert.equal(handlerRan, true);
});

await checkAsync("no token is still 401, not the beta refusal", async () => {
  setAuthorizationContextForTest(contextWith("pending"));
  const response = await gateApp.request("/v1/probe/product");
  // "Sign in" and "you are waiting" are different instructions, and the gate
  // must not shadow the first with the second.
  assert.equal(response.status, 401);
});

setAuthorizationContextForTest(null);

check("only the account's own access routes opt out of the gate", () => {
  const opted = V1_ROUTES.filter((route) => route.auth === "required" && route.access === "self");
  assert.deepEqual(
    opted.map((route) => route.path).sort(),
    ["/v1/access-request", "/v1/access-request/note"],
    "opening the gate on a route has to be a deliberate, reviewed line",
  );
});

check("the admin surface is gated like everything else", () => {
  const admin = V1_ROUTES.filter((route) => route.path.startsWith("/v1/admin"));
  assert.ok(admin.length > 0, "the admin routes are mounted");
  for (const route of admin) {
    assert.equal(route.auth, "required", `${route.path} is authenticated`);
    // An operator is an approved account with an extra grant, never a way past
    // the gate: `operator` falls through to the approval check in the kernel.
    assert.equal(route.access, "operator", `${route.path} declares its audience`);
  }
});

console.log(failures === 0 ? "\nv1 kernel unit gate: pass" : `\nv1 kernel unit gate: ${failures} failing`);
process.exit(failures === 0 ? 0 : 1);

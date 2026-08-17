/**
 * `npm run security:unit` — 32 deterministic assertions.
 *
 * Runtime configuration, redaction and safe errors, liveness, and the evidence
 * validator's own classification rules. No database, no network, no containers.
 * The one subprocess is a real startup attempt, because "the process refuses to
 * serve" is not something an in-process assertion can honestly prove.
 */

import { spawnSync } from "node:child_process";
import {
  assertionsFor,
  classifyHttpProbe,
  classifyTransportError,
  gateExitCode,
  loadManifest,
  runGate,
  validateResults,
  type AssertionBody,
  type AssertionRecord,
  type AssertionResult,
} from "../assertions.js";
import {
  RuntimeConfigError,
  assertRuntimeConfig,
  inspectRuntimeConfig,
  parseConnection,
  parsePooledUsername,
} from "../config.js";
import { CuratedError, GENERIC_CLIENT_MESSAGE, redactError, safeClientMessage } from "../redaction.js";
import { RuntimeIdentityError, verifyRuntimeIdentity } from "../identity.js";
import { PRODUCTION, RUNTIME_ROLE } from "../contract.js";
import { repoRoot } from "../repo-scan.js";
import { loadApp } from "../../cors.test.js";
import {
  SYNTHETIC_ARBITRARY_PROVIDER_VALUE,
  SYNTHETIC_API_KEY,
  SYNTHETIC_BEARER_TOKEN,
  SYNTHETIC_DATABASE_URL,
  SYNTHETIC_FEN,
  SYNTHETIC_JWT,
  SYNTHETIC_PASSWORD,
  SYNTHETIC_PGN,
  SYNTHETIC_PROVIDER_PAYLOAD,
  SYNTHETIC_ROW_PAYLOAD,
  SYNTHETIC_OWNER_URL,
  SYNTHETIC_SQL,
  syntheticDeployedUrl,
} from "../fixtures/synthetic-credentials.js";

const COMMAND = "cd server && npm run security:unit";

const DEPLOYED_BASE = {
  FORMA_ENV: "production",
  DATABASE_URL: syntheticDeployedUrl(RUNTIME_ROLE, PRODUCTION.projectRef),
  DATABASE_ROLE: RUNTIME_ROLE,
};

function expectBlocking(env: Record<string, string | undefined>, expectedCode?: string): string {
  const findings = inspectRuntimeConfig(env);
  if (findings.length === 0) throw new Error("configuration was accepted; a blocking rejection was required");
  if (expectedCode && !findings.some((finding) => finding.code === expectedCode)) {
    throw new Error(
      `rejection codes were ${findings.map((f) => f.code).join(",")}, expected ${expectedCode}`,
    );
  }
  return `blocking rejection: ${findings.map((finding) => finding.code).join(", ")}`;
}

/** No redacted output may contain any of these substrings. */
function requireAbsent(text: string, forbidden: readonly string[], context: string): void {
  for (const needle of forbidden) {
    if (needle.length > 0 && text.includes(needle)) {
      throw new Error(`${context} still contains ${needle.slice(0, 24)}...`);
    }
  }
}

function redactionBody(
  build: () => unknown,
  forbidden: readonly string[],
  label: string,
): AssertionBody {
  return async () => {
    const error = build();
    const logged = redactError(error);
    requireAbsent(logged, forbidden, "log output");
    const client = safeClientMessage(error);
    requireAbsent(client, forbidden, "client body");
    if (client !== GENERIC_CLIENT_MESSAGE) {
      throw new Error("an uncurated failure produced a non-generic client message");
    }
    return `${label} removed from log output and client body`;
  };
}

const READINESS_PATHS = [
  "/ready",
  "/readyz",
  "/readiness",
  "/health/ready",
  "/health/db",
  "/healthz",
  "/identity",
  "/whoami",
  "/current-user",
  "/db",
  "/status",
];

function livenessBodies(): Map<string, AssertionBody> {
  return new Map<string, AssertionBody>([
    [
      "GET /health success",
      async () => {
        const app = await loadApp();
        const response = await app.request("/health");
        if (response.status !== 200) throw new Error(`GET /health returned ${response.status}`);
        const body = (await response.json()) as Record<string, unknown>;
        const keys = Object.keys(body).sort();
        if (keys.join(",") !== "service,status,ts") {
          throw new Error(`liveness body shape is {${keys.join(",")}}, expected {service,status,ts}`);
        }
        if (body.status !== "ok" || body.service !== "forma-chess-api") {
          throw new Error("liveness body does not carry the expected public values");
        }
        const serialised = JSON.stringify(body).toLowerCase();
        for (const leak of ["role", "revision", "secret", "database", "current_user", "digest"]) {
          if (serialised.includes(leak)) throw new Error(`liveness body discloses "${leak}"`);
        }
        return "HTTP 200 {status,service,ts}; no DB role, revision, or secret fields";
      },
    ],
    [
      "public readiness absence",
      async () => {
        const app = await loadApp();
        const reachable: string[] = [];
        for (const path of READINESS_PATHS) {
          const response = await app.request(path);
          if (response.status !== 404) reachable.push(`${path}=${response.status}`);
        }
        if (reachable.length > 0) {
          throw new Error(`public readiness/identity routes exist: ${reachable.join(", ")}`);
        }
        return `${READINESS_PATHS.length} likely readiness/identity paths all return 404`;
      },
    ],
    [
      "dependency error privacy",
      async () => {
        // A dependency failure raised where the identity check runs, not inside
        // the liveness handler.
        const driverError = Object.assign(
          new Error(`connect ECONNREFUSED for ${SYNTHETIC_DATABASE_URL}`),
          { query: SYNTHETIC_SQL },
        );
        let thrown: unknown;
        try {
          await verifyRuntimeIdentity(() => Promise.reject(driverError));
        } catch (error) {
          thrown = error;
        }
        if (!(thrown instanceof RuntimeIdentityError)) {
          throw new Error("a failing dependency did not fail the identity check closed");
        }
        requireAbsent(thrown.message, [SYNTHETIC_PASSWORD, SYNTHETIC_DATABASE_URL, SYNTHETIC_SQL], "identity error");
        const app = await loadApp();
        const response = await app.request("/health");
        const body = await response.text();
        if (response.status !== 200) throw new Error("liveness stopped answering for a DB failure");
        if (/ready|identity|current_user|database/i.test(body)) {
          throw new Error("liveness represented itself as identity-ready");
        }
        return "identity check failed closed with no secret or SQL; liveness claims no identity readiness";
      },
    ],
    [
      "startup fail closed",
      async () => {
        const root = repoRoot();
        const result = spawnSync("npx", ["tsx", "src/index.ts"], {
          cwd: `${root}/server`,
          encoding: "utf8",
          timeout: 8_000,
          env: {
            ...process.env,
            FORMA_ENV: "production",
            API_PORT: "0",
            PORT: "0",
            DATABASE_URL: SYNTHETIC_OWNER_URL,
            DATABASE_ROLE: "postgres",
            SUPABASE_URL: "http://127.0.0.1:1/synthetic",
            SUPABASE_ANON_KEY: "sb_publishable_synthetic_fixture_key",
          },
        });
        const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
        if (result.status === 0) throw new Error("a deployed invalid configuration started cleanly");
        if (/listening on/.test(output)) throw new Error("the process bound a port before rejecting");
        if (!/RuntimeConfigError|runtime database configuration rejected/.test(output)) {
          throw new Error(`startup failed for an unrelated reason: ${output.trim().slice(0, 160)}`);
        }
        requireAbsent(output, ["pw@pooler.invalid"], "startup output");
        return "deployed invalid configuration rejected before serving, with no credential in the output";
      },
    ],
  ]);
}

function evidenceBodies(): Map<string, AssertionBody> {
  const record = (id: string): AssertionRecord => ({
    id,
    command: COMMAND,
    category: "fixture",
    target: "fixture",
    setup: "fixture",
    predicate: "fixture",
    timeout_seconds: 10,
    evidence_class: "deterministic",
  });
  const expected = [record("FIXTURE-001"), record("FIXTURE-002")];
  const pass = (id: string): AssertionResult => ({ id, status: "pass", detail: "ok" });

  function expectRejected(results: AssertionResult[], code: string, label: string): string {
    const problems = validateResults(expected, results);
    if (!problems.some((problem) => problem.code === code)) {
      throw new Error(`validator accepted ${label}; problems were ${problems.map((p) => p.code).join(",") || "none"}`);
    }
    return `validator rejects ${label} (${code})`;
  }

  return new Map<string, AssertionBody>([
    [
      "UNIT-EVD-001",
      async () =>
        expectRejected(
          [pass("FIXTURE-001"), pass("FIXTURE-001"), pass("FIXTURE-002")],
          "duplicate",
          "a duplicate assertion ID",
        ),
    ],
    [
      "UNIT-EVD-002",
      async () => expectRejected([pass("FIXTURE-001")], "missing", "a missing assertion"),
    ],
    [
      "UNIT-EVD-003",
      async () =>
        expectRejected(
          [pass("FIXTURE-001"), pass("FIXTURE-002"), pass("FIXTURE-999")],
          "unexpected",
          "an unexpected assertion ID",
        ),
    ],
    [
      "UNIT-EVD-004",
      async () => {
        const skipped = expectRejected(
          [pass("FIXTURE-001"), { id: "FIXTURE-002", status: "skip", detail: "" }],
          "skipped",
          "a skipped assertion",
        );
        const todo = expectRejected(
          [pass("FIXTURE-001"), { id: "FIXTURE-002", status: "todo", detail: "" }],
          "todo",
          "an unfinished assertion",
        );
        return `${skipped}; ${todo}`;
      },
    ],
    [
      "UNIT-EVD-005",
      async () => {
        const timeout = classifyTransportError(new (class extends Error {
          override name = "AssertionTimeout";
        })("timed out"));
        const network = classifyTransportError(Object.assign(new Error("socket hang up"), { name: "FetchError" }));
        if (timeout.kind !== "failure" || network.kind !== "failure") {
          throw new Error("a transport error was classified as a denial");
        }
        return "timeout and network errors classify as failure, never denial";
      },
    ],
    [
      "UNIT-EVD-006",
      async () => {
        const notFound = classifyHttpProbe(404, '{"code":"PGRST205"}');
        if (notFound.kind !== "failure") throw new Error("a 404 was classified as a denial");
        const ok = classifyHttpProbe(200, "[]");
        if (ok.kind !== "failure") throw new Error("a 200 was classified as a denial");
        const denied = classifyHttpProbe(401, '{"code":"42501"}');
        if (denied.kind !== "denied") throw new Error("a 401 was not classified as a denial");
        return "404 and 200 classify as failure after existence is proven; 401/403/42501 remain denials";
      },
    ],
  ]);
}

function configBodies(): Map<string, AssertionBody> {
  return new Map<string, AssertionBody>([
    [
      "pooled username",
      async () => {
        const parsed = parsePooledUsername(`${RUNTIME_ROLE}.${PRODUCTION.projectRef}`);
        if (parsed.baseRole !== RUNTIME_ROLE) throw new Error(`base role is ${parsed.baseRole}`);
        if (parsed.projectRef !== PRODUCTION.projectRef) {
          throw new Error(`project ref is ${parsed.projectRef}`);
        }
        return `${RUNTIME_ROLE}.<ref> resolves to base role ${RUNTIME_ROLE}`;
      },
    ],
    [
      "plain username",
      async () => {
        const parsed = parsePooledUsername(RUNTIME_ROLE);
        if (parsed.baseRole !== RUNTIME_ROLE || parsed.projectRef !== null) {
          throw new Error("a plain username did not resolve to the bare base role");
        }
        return `${RUNTIME_ROLE} resolves to base role ${RUNTIME_ROLE} with no tenant`;
      },
    ],
    [
      "valid deployed config",
      async () => {
        const findings = inspectRuntimeConfig(DEPLOYED_BASE);
        if (findings.length !== 0) {
          throw new Error(`valid config produced ${findings.map((f) => f.code).join(",")}`);
        }
        const connection = assertRuntimeConfig(DEPLOYED_BASE);
        if (connection.baseRole !== RUNTIME_ROLE || connection.port !== PRODUCTION.poolerPort) {
          throw new Error("accepted configuration did not resolve to the pooled runtime identity");
        }
        return `pooled ${RUNTIME_ROLE} on ${PRODUCTION.poolerPort} with the role marker: zero blocking findings`;
      },
    ],
    [
      "owner role",
      async () =>
        expectBlocking(
          { ...DEPLOYED_BASE, DATABASE_URL: DEPLOYED_BASE.DATABASE_URL.replace(`${RUNTIME_ROLE}.`, "postgres.") },
          "DATABASE_ROLE_IS_OWNER",
        ),
    ],
    [
      "migrator role",
      async () =>
        expectBlocking(
          { ...DEPLOYED_BASE, DATABASE_URL: DEPLOYED_BASE.DATABASE_URL.replace(`${RUNTIME_ROLE}.`, "forma_migrator.") },
          "DATABASE_ROLE_IS_MIGRATOR",
        ),
    ],
    [
      "unknown role",
      async () =>
        expectBlocking(
          { ...DEPLOYED_BASE, DATABASE_URL: DEPLOYED_BASE.DATABASE_URL.replace(`${RUNTIME_ROLE}.`, "unknown_role.") },
          "DATABASE_ROLE_UNKNOWN",
        ),
    ],
    [
      "wrong port",
      async () => {
        const env = { ...DEPLOYED_BASE, DATABASE_URL: DEPLOYED_BASE.DATABASE_URL.replace(":6543/", ":5432/") };
        const findings = inspectRuntimeConfig(env);
        const port = findings.find((finding) => finding.code === "DATABASE_PORT_NOT_POOLED");
        if (!port) throw new Error("port 5432 was accepted in a deployed configuration");
        if (!port.message.includes(String(PRODUCTION.poolerPort))) {
          throw new Error("the port rejection does not name the pooled port");
        }
        return `port 5432 rejected with a message naming ${PRODUCTION.poolerPort}`;
      },
    ],
    [
      "missing marker",
      async () => {
        const env = { ...DEPLOYED_BASE, DATABASE_ROLE: undefined };
        return expectBlocking(env, "DATABASE_ROLE_MARKER_MISSING");
      },
    ],
    [
      "mismatched marker",
      async () => expectBlocking({ ...DEPLOYED_BASE, DATABASE_ROLE: "postgres" }, "DATABASE_ROLE_MARKER_MISMATCH"),
    ],
    [
      "malformed URL",
      async () => {
        const malformed = `mysql://${RUNTIME_ROLE}:${SYNTHETIC_PASSWORD}@host.invalid:3306/db`;
        const findings = inspectRuntimeConfig({ ...DEPLOYED_BASE, DATABASE_URL: malformed });
        if (findings.length === 0) throw new Error("a non-Postgres URL was accepted");
        const text = JSON.stringify(findings);
        requireAbsent(text, [SYNTHETIC_PASSWORD, malformed], "rejection findings");
        let thrown: unknown;
        try {
          parseConnection("not a url at all");
        } catch (error) {
          thrown = error;
        }
        if (!(thrown instanceof RuntimeConfigError)) throw new Error("an invalid URL parsed successfully");
        return `blocking rejection (${findings.map((f) => f.code).join(", ")}) without echoing the input`;
      },
    ],
    [
      "secret-safe parse",
      async () => {
        const connection = parseConnection(SYNTHETIC_DATABASE_URL);
        const serialised = JSON.stringify(connection);
        requireAbsent(serialised, [SYNTHETIC_PASSWORD, SYNTHETIC_DATABASE_URL], "parsed connection");
        if (Object.values(connection).some((value) => String(value).includes(SYNTHETIC_PASSWORD))) {
          throw new Error("a parsed field carried the password");
        }
        return "parsed connection carries host, port, database, and base role only";
      },
    ],
    [
      "private identity mismatch",
      async () => {
        let thrown: unknown;
        try {
          await verifyRuntimeIdentity(async () => [{ current_user: "postgres" }]);
        } catch (error) {
          thrown = error;
        }
        if (!(thrown instanceof RuntimeIdentityError)) {
          throw new Error("current_user=postgres was accepted by the identity check");
        }
        const app = await loadApp();
        for (const path of ["/identity", "/whoami", "/current-user"]) {
          if ((await app.request(path)).status !== 404) {
            throw new Error(`${path} is a public diagnostic route`);
          }
        }
        return "current_user=postgres fails closed and no public diagnostic route exposes it";
      },
    ],
  ]);
}

function redactionBodies(): Map<string, AssertionBody> {
  const curatedDescendant = new (class extends CuratedError {})(SYNTHETIC_ARBITRARY_PROVIDER_VALUE);
  curatedDescendant.name = SYNTHETIC_ARBITRARY_PROVIDER_VALUE;
  const spoofedCause = new Error(
    `inner used Bearer ${SYNTHETIC_BEARER_TOKEN} against ${SYNTHETIC_DATABASE_URL}`,
  );
  spoofedCause.name = SYNTHETIC_ARBITRARY_PROVIDER_VALUE;
  const nested = new AggregateError(
    [curatedDescendant],
    SYNTHETIC_ARBITRARY_PROVIDER_VALUE,
    { cause: spoofedCause },
  );
  return new Map<string, AssertionBody>([
    [
      "Postgres URL password",
      redactionBody(
        () => new Error(`connection failed: ${SYNTHETIC_DATABASE_URL}`),
        [SYNTHETIC_PASSWORD, SYNTHETIC_DATABASE_URL],
        "database URL and password",
      ),
    ],
    [
      "Bearer token",
      redactionBody(
        () => new Error(`upstream rejected Bearer ${SYNTHETIC_BEARER_TOKEN}`),
        [SYNTHETIC_BEARER_TOKEN, `Bearer ${SYNTHETIC_BEARER_TOKEN}`],
        "bearer token and header",
      ),
    ],
    ["JWT", redactionBody(() => new Error(`token ${SYNTHETIC_JWT} expired`), [SYNTHETIC_JWT], "JWT")],
    ["API key", redactionBody(() => new Error(`key ${SYNTHETIC_API_KEY} refused`), [SYNTHETIC_API_KEY], "API key")],
    [
      "SQL text",
      redactionBody(
        () => Object.assign(new Error(`error running ${SYNTHETIC_SQL}`), {
          detail: "Key (email)=(someone@synthetic.invalid) already exists.",
          table_name: "profiles",
          column_name: "email",
        }),
        [SYNTHETIC_SQL, "someone@synthetic.invalid", "Key (email)"],
        "SQL text and driver detail",
      ),
    ],
    [
      "row payload",
      redactionBody(
        () => new Error(`row rejected: ${SYNTHETIC_ROW_PAYLOAD}`),
        [SYNTHETIC_ROW_PAYLOAD, "someone@synthetic.invalid"],
        "row values",
      ),
    ],
    [
      "provider payload",
      redactionBody(
        () => new Error(`provider said ${SYNTHETIC_PROVIDER_PAYLOAD}`),
        [SYNTHETIC_PROVIDER_PAYLOAD, "synthetic-player"],
        "provider body",
      ),
    ],
    [
      "PGN/FEN",
      redactionBody(
        () => new Error(`parse failed for ${SYNTHETIC_PGN} at ${SYNTHETIC_FEN}`),
        [SYNTHETIC_PGN, SYNTHETIC_FEN],
        "PGN and FEN payloads",
      ),
    ],
    [
      "raw exception",
      async () => {
        const error = new Error("synthetic internal detail");
        const client = safeClientMessage(error);
        if (client.includes("synthetic internal detail")) {
          throw new Error("the raw exception message reached the client body");
        }
        if (client !== GENERIC_CLIENT_MESSAGE) throw new Error("the safe body is not the legacy generic message");
        const body = JSON.stringify({ error: client });
        if (!/^\{"error":"[^"]+"\}$/.test(body)) throw new Error("the safe body is not the legacy shape");
        return "raw exception replaced by the legacy safe body {\"error\":\"...\"}";
      },
    ],
    [
      "nested cause",
      redactionBody(
        () => nested,
        [
          SYNTHETIC_ARBITRARY_PROVIDER_VALUE,
          SYNTHETIC_BEARER_TOKEN,
          SYNTHETIC_DATABASE_URL,
          SYNTHETIC_PASSWORD,
        ],
        "caller text, spoofed names, AggregateError descendants, and nested causes",
      ),
    ],
  ]);
}

export function buildUnitBodies(records: readonly AssertionRecord[]): Map<string, AssertionBody> {
  const byCategory: Record<string, Map<string, AssertionBody>> = {
    "runtime-config": configBodies(),
    "redaction-safe-error": redactionBodies(),
    liveness: livenessBodies(),
    "evidence-classification": evidenceBodies(),
  };
  const bodies = new Map<string, AssertionBody>();
  for (const record of records) {
    const family = byCategory[record.category];
    if (!family) throw new Error(`unexpected category "${record.category}" for ${record.id}`);
    // Most families key on the manifest target; the evidence-classification
    // family keys on the assertion id, because its targets name the very marker
    // tokens the leak rule rejects across tracked files.
    const body = family.get(record.target) ?? family.get(record.id);
    if (!body) throw new Error(`no body for ${record.category} target "${record.target}" (${record.id})`);
    bodies.set(record.id, body);
  }
  return bodies;
}

export async function main(): Promise<number> {
  const root = repoRoot();
  const manifest = loadManifest(root);
  const records = assertionsFor(manifest, COMMAND);
  const outcome = await runGate({ command: COMMAND, records, bodies: buildUnitBodies(records) });
  return gateExitCode(outcome);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`security:unit failed to run: ${String(error)}\n`);
      process.exit(1);
    },
  );
}

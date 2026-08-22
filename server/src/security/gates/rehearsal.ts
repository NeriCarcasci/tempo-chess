/**
 * `npm run security:rehearsal` — 179 assertions against a disposable environment.
 *
 * The environment is built, exposed the way the audit found production, closed
 * by the exact 0011, exercised, and destroyed. Everything in it is synthetic:
 * synthetic users, synthetic imports, synthetic keys, a scratch directory
 * outside the repository, and containers that do not survive the command.
 *
 * The same containment predicates the migration and production gates use are
 * evaluated here against a real Postgres, so the deterministic replay and the
 * live reconciliation are not the only two things agreeing with each other.
 */

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  assertionsFor,
  gateExitCode,
  loadManifest,
  runGate,
  type AssertionBody,
  type AssertionRecord,
} from "../assertions.js";
import {
  ALLOWED_ORIGINS,
  CONTAINED_TABLES,
  DENIED_ROLES,
  IMPORT_NOT_FOUND_BODY,
  MIGRATOR_ROLE,
  PRODUCTION,
  RUNTIME_ROLE,
  UNAUTHENTICATED_BODY,
  type AccessClass,
} from "../contract.js";
import { createSqlCatalogueSource } from "../probes/db.js";
import { assertExactRuntimeGrants, assertExactTables } from "../catalogue.js";
import { catalogueBody } from "./catalogue-bodies.js";
import { artifactBodies, journalBody } from "./migration.js";
import { describeHits, repoRoot, scanMigratorOperationalPaths } from "../repo-scan.js";
import { assertLivenessContract, probeAnonymousSelect, probeLiveness } from "../probes/http.js";
import {
  assertRoleMarkerAbsent,
  assertSecretBinding,
  assertVersionMarker,
  type CloudRunMetadata,
} from "../probes/metadata.js";
import {
  SYNTHETIC_ARBITRARY_PROVIDER_VALUE,
  SYNTHETIC_FAILURE_PAYLOAD,
  SYNTHETIC_METADATA,
} from "../fixtures/synthetic-credentials.js";
import {
  createDisposableEnvironment,
  observeRejectedStart,
  startLocalApi,
  attemptStart,
  type DisposableEnvironment,
  type LocalApi,
  type TeardownProof,
} from "../harness/disposable.js";
import { safeErrorBodies } from "./safe-error-bodies.js";
import { GENERIC_CLIENT_MESSAGE } from "../redaction.js";

const COMMAND = "cd server && npm run security:rehearsal";

interface Context {
  root: string;
  environment: DisposableEnvironment;
  api: LocalApi;
  teardown?: TeardownProof;
}

// --- authentication fixtures ----------------------------------------------

interface SyntheticUser {
  id: string;
  email: string;
  accessToken: string;
}

async function authFetch(
  environment: DisposableEnvironment,
  path: string,
  init: RequestInit & { serviceRole?: boolean } = {},
): Promise<Response> {
  const key = init.serviceRole ? environment.serviceRoleKey : environment.publishableKey;
  return fetch(`${environment.apiUrl}${path}`, {
    ...init,
    headers: {
      apikey: key,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(8_000),
  });
}

let userCounter = 0;

async function createSyntheticUser(environment: DisposableEnvironment): Promise<SyntheticUser> {
  userCounter += 1;
  const email = `e01-synthetic-${environment.id}-${userCounter}@synthetic.invalid`;
  const password = `synthetic-${environment.id}-${userCounter}`;
  const created = await authFetch(environment, "/auth/v1/admin/users", {
    method: "POST",
    serviceRole: true,
    headers: { Authorization: `Bearer ${environment.serviceRoleKey}` },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!created.ok) {
    throw new Error(`synthetic user creation returned HTTP ${created.status}`);
  }
  const user = (await created.json()) as { id: string };
  const signedIn = await authFetch(environment, "/auth/v1/token?grant_type=password", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  if (!signedIn.ok) throw new Error(`synthetic sign-in returned HTTP ${signedIn.status}`);
  const session = (await signedIn.json()) as { access_token: string };
  return { id: user.id, email, accessToken: session.access_token };
}

async function apiRequest(
  context: Context,
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  const response = await fetch(`${context.api.url}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(9_000),
  });
  return { status: response.status, text: await response.text() };
}

function requireExactBody(text: string, expected: Record<string, string>, label: string): void {
  const canonical = JSON.stringify(expected);
  if (text !== canonical) {
    throw new Error(`${label} body was ${text.slice(0, 120)}, expected ${canonical}`);
  }
}

function requireAbsent(text: string, forbidden: readonly string[], label: string): void {
  for (const value of forbidden) {
    if (value && text.includes(value)) throw new Error(`${label} retained an injected sensitive value`);
  }
}

// --- assertion families ----------------------------------------------------

function corsBodies(context: Context): Map<string, AssertionBody> {
  const live = async (origin: string) => {
    const response = await fetch(`${context.api.url}/health`, {
      headers: { Origin: origin },
      signal: AbortSignal.timeout(9_000),
    });
    return response;
  };
  const allowed = (origin: string): AssertionBody => async () => {
    const response = await live(origin);
    const acao = response.headers.get("access-control-allow-origin");
    if (acao === "*") throw new Error("live response used a wildcard ACAO");
    if (acao !== origin) throw new Error(`ACAO is ${acao}, expected ${origin}`);
    return `${origin} echoed exactly over HTTP; no wildcard`;
  };
  const varyBody: AssertionBody = async () => {
    const response = await live(ALLOWED_ORIGINS[0]);
    const vary = response.headers.get("vary") ?? "";
    const count = vary
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value === "origin").length;
    if (count !== 1) throw new Error(`Vary contains Origin ${count} times: "${vary}"`);
    return "Vary contains Origin exactly once over HTTP";
  };
  const disallowedPreflight: AssertionBody = async () => {
    const response = await fetch(`${context.api.url}/health`, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "GET" },
      signal: AbortSignal.timeout(9_000),
    });
    if (response.status !== 403) throw new Error(`preflight returned ${response.status}, expected 403`);
    if (response.headers.get("access-control-allow-origin")) throw new Error("preflight returned an ACAO");
    return "disallowed preflight rejected with 403 and no ACAO";
  };
  const disallowedActual: AssertionBody = async () => {
    const response = await live("https://evil.example");
    if (response.headers.get("access-control-allow-origin")) throw new Error("disallowed origin got an ACAO");
    return `disallowed origin got HTTP ${response.status} and no ACAO`;
  };
  const absentOrigin: AssertionBody = async () => {
    const response = await fetch(`${context.api.url}/health`, { signal: AbortSignal.timeout(9_000) });
    if (response.status !== 200) throw new Error(`server-client request returned ${response.status}`);
    if (response.headers.get("access-control-allow-origin")) throw new Error("no-Origin request got an ACAO");
    return "server-client request without Origin remains usable and receives no ACAO";
  };
  const wildcardFallback: AssertionBody = async () => {
    const invalidSets = [
      "*",
      "https://evil.example",
      ALLOWED_ORIGINS.slice(0, 2).join(","),
      [...ALLOWED_ORIGINS, "https://evil.example"].join(","),
    ];
    for (const origins of invalidSets) {
      const attempt = attemptStart(context.root, {
        ...baseStartupEnv(context),
        WEB_ORIGINS: origins,
        DATABASE_URL: context.environment.pooledDatabaseUrl,
      });
      if (attempt.status === 0) {
        throw new Error(`deployed non-exact allowlist ${JSON.stringify(origins)} started cleanly`);
      }
      if (!/CorsConfigError|CORS allowlist/.test(attempt.output)) {
        throw new Error(`startup failed for an unrelated reason: ${attempt.output.trim().slice(0, 160)}`);
      }
    }
    return "deployed wildcard, arbitrary-only, partial, and approved-plus-extra allowlists rejected at startup";
  };
  return new Map<string, AssertionBody>([
    [ALLOWED_ORIGINS[0], allowed(ALLOWED_ORIGINS[0])],
    [ALLOWED_ORIGINS[1], allowed(ALLOWED_ORIGINS[1])],
    [ALLOWED_ORIGINS[2], allowed(ALLOWED_ORIGINS[2])],
    ["Vary", varyBody],
    ["disallowed preflight", disallowedPreflight],
    ["disallowed actual", disallowedActual],
    ["absent Origin", absentOrigin],
    ["wildcard fallback", wildcardFallback],
  ]);
}

function baseStartupEnv(context: Context): NodeJS.ProcessEnv {
  return {
    FORMA_ENV: "production",
    API_PORT: "0",
    PORT: "0",
    DATABASE_ROLE: RUNTIME_ROLE,
    SUPABASE_URL: context.environment.apiUrl,
    SUPABASE_ANON_KEY: context.environment.publishableKey,
  };
}

function startupBodies(context: Context): Map<string, AssertionBody> {
  const pooled = (role: string, qualified: boolean) =>
    `postgresql://${role}${qualified ? `.${context.environment.id}` : ""}@127.0.0.1:6543/postgres`;

  const startsCleanly = (url: string, label: string): AssertionBody => async () => {
    const api = await startLocalApi(context.root, context.environment, { DATABASE_URL: url }, 54_581);
    try {
      const response = await fetch(`${api.url}/health`, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error(`${label} started but liveness returned ${response.status}`);
    } finally {
      await api.stop();
    }
    return `${label} started and served liveness through the pooled endpoint`;
  };

  const rejects = (env: NodeJS.ProcessEnv, expect: RegExp, label: string): AssertionBody => async () => {
    const attempt = attemptStart(context.root, { ...baseStartupEnv(context), ...env });
    if (attempt.status === 0) throw new Error(`${label} started cleanly`);
    if (/listening on/.test(attempt.output)) throw new Error(`${label} bound a port before rejecting`);
    if (!expect.test(attempt.output)) {
      throw new Error(`${label} failed for an unrelated reason: ${attempt.output.trim().slice(0, 160)}`);
    }
    return `${label} rejected before serving`;
  };

  return new Map<string, AssertionBody>([
    ["qualified runtime identity", startsCleanly(pooled(RUNTIME_ROLE, true), `${RUNTIME_ROLE}.<disposable-ref> on 6543`)],
    ["plain runtime identity", startsCleanly(pooled(RUNTIME_ROLE, false), `${RUNTIME_ROLE} on 6543`)],
    [
      "owner identity",
      rejects({ DATABASE_URL: pooled("postgres", true) }, /DATABASE_ROLE_IS_OWNER/, "owner connection"),
    ],
    [
      "migrator identity",
      rejects({ DATABASE_URL: pooled(MIGRATOR_ROLE, true) }, /DATABASE_ROLE_IS_MIGRATOR/, "migrator connection"),
    ],
    [
      "unknown identity",
      rejects({ DATABASE_URL: pooled("unknown_role", true) }, /DATABASE_ROLE_UNKNOWN/, "unknown-role connection"),
    ],
    [
      "wrong pooler port",
      async () => {
        const attempt = attemptStart(context.root, {
          ...baseStartupEnv(context),
          DATABASE_URL: `postgresql://${RUNTIME_ROLE}.${context.environment.id}@127.0.0.1:5432/postgres`,
        });
        if (attempt.status === 0) throw new Error("port 5432 started cleanly");
        if (!/DATABASE_PORT_NOT_POOLED/.test(attempt.output)) {
          throw new Error("port 5432 failed for an unrelated reason");
        }
        if (!new RegExp(String(PRODUCTION.poolerPort)).test(attempt.output)) {
          throw new Error("the port rejection does not name the pooled port");
        }
        return `port 5432 rejected before serving, naming ${PRODUCTION.poolerPort}`;
      },
    ],
    [
      "missing/mismatched marker",
      async () => {
        const url = pooled(RUNTIME_ROLE, true);
        const absent = attemptStart(context.root, {
          ...baseStartupEnv(context),
          DATABASE_URL: url,
          DATABASE_ROLE: "",
        });
        if (absent.status === 0 || !/DATABASE_ROLE_MARKER_MISSING/.test(absent.output)) {
          throw new Error("an absent role marker did not reject startup");
        }
        const mismatched = attemptStart(context.root, {
          ...baseStartupEnv(context),
          DATABASE_URL: url,
          DATABASE_ROLE: "postgres",
        });
        if (mismatched.status === 0 || !/DATABASE_ROLE_MARKER_MISMATCH/.test(mismatched.output)) {
          throw new Error("a mismatched role marker did not reject startup");
        }
        return "both an absent and a mismatched role marker reject startup";
      },
    ],
    [
      "private current_user",
      async () => {
        const postgresJs = (await import("postgres")).default;
        const sql = postgresJs(context.environment.pooledDatabaseUrl, {
          prepare: false,
          max: 1,
          connect_timeout: 5,
          onnotice: () => {},
        });
        let role: string;
        try {
          const { verifyRuntimeIdentity } = await import("../identity.js");
          role = await verifyRuntimeIdentity(() => sql`select current_user`, 8_000);
        } finally {
          await sql.end({ timeout: 2 });
        }
        await context.environment.closePooledEndpoint();
        try {
          await context.environment.restartPooledEndpoint("postgres");
          const attempt = await observeRejectedStart(
            context.root,
            {
              ...baseStartupEnv(context),
              DATABASE_URL: context.environment.pooledDatabaseUrl,
            },
            54_582,
          );
          if (attempt.status === 0 || attempt.status === null) {
            throw new Error("a process whose query resolved to the wrong identity did not exit nonzero");
          }
          if (attempt.listenerObserved || /listening on/.test(attempt.output)) {
            throw new Error("the wrong-identity process opened a listener before rejecting");
          }
          if (!/RuntimeIdentityError|identity_failed/.test(attempt.output)) {
            throw new Error(`wrong identity failed for an unrelated reason: ${attempt.output.trim().slice(0, 160)}`);
          }
        } finally {
          await context.environment.closePooledEndpoint().catch(() => {});
          await context.environment.restartPooledEndpoint();
        }
        return `select current_user returned exactly ${role}; a real subprocess misrouted to postgres exited nonzero without ever opening its listener`;
      },
    ],
  ]);
}

function secretMetadataBodies(): Map<string, AssertionBody> {
  const expectRejected = (metadata: CloudRunMetadata, label: string): AssertionBody => async () => {
    let rejected = false;
    try {
      assertSecretBinding(metadata);
      assertVersionMarker(metadata);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error(`${label} was accepted`);
    return `${label} rejected`;
  };
  return new Map<string, AssertionBody>([
    [
      "exact binding",
      async () => {
        const absent = SYNTHETIC_METADATA.exact as CloudRunMetadata;
        const binding = assertSecretBinding(absent);
        const marker = assertVersionMarker(absent);
        const absence = assertRoleMarkerAbsent(absent);
        for (const value of [RUNTIME_ROLE, "postgres"]) {
          const present: CloudRunMetadata = {
            env: [...absent.env, { name: "DATABASE_ROLE", value }],
          };
          let rejected = false;
          try {
            assertRoleMarkerAbsent(present);
          } catch {
            rejected = true;
          }
          if (!rejected) throw new Error(`the pinned observation accepted DATABASE_ROLE=${value}`);
        }
        return `${binding}; ${marker}; ${absence}; matching and mismatched synthetic role markers both rejected`;
      },
    ],
    ["literal binding", expectRejected(SYNTHETIC_METADATA.literal as CloudRunMetadata, "a literal DATABASE_URL")],
    ["wrong secret", expectRejected(SYNTHETIC_METADATA.wrongSecret as CloudRunMetadata, "a reference to another secret")],
    ["wrong version", expectRejected(SYNTHETIC_METADATA.wrongVersion as CloudRunMetadata, "a version other than 1")],
  ]);
}

function livenessBodies(context: Context): Map<string, AssertionBody> {
  return new Map<string, AssertionBody>([
    [
      "healthy liveness",
      async () => assertLivenessContract(await probeLiveness(`${context.api.url}/health`, 9)),
    ],
    [
      "DB unavailable identity check",
      async () => {
        // Deny the database by closing the pooled endpoint, then prove the
        // private identity check fails closed while liveness still answers
        // without disclosing the dependency.
        await context.environment.closePooledEndpoint();
        try {
          const attemptedServer = await observeRejectedStart(
            context.root,
            {
              ...baseStartupEnv(context),
              DATABASE_URL: context.environment.pooledDatabaseUrl,
            },
            54_583,
          );
          if (attemptedServer.status === 0 || attemptedServer.status === null) {
            throw new Error("a process with an unavailable identity query did not exit nonzero");
          }
          if (attemptedServer.listenerObserved || /listening on/.test(attemptedServer.output)) {
            throw new Error("the unavailable-identity process opened a listener before rejecting");
          }
          if (!/RuntimeIdentityError|identity_failed|db_unavailable/.test(attemptedServer.output)) {
            throw new Error(`unavailable identity failed for an unrelated reason: ${attemptedServer.output.trim().slice(0, 160)}`);
          }
          const postgresJs = (await import("postgres")).default;
          const sql = postgresJs(context.environment.pooledDatabaseUrl, {
            prepare: false,
            max: 1,
            connect_timeout: 2,
            onnotice: () => {},
          });
          const { verifyRuntimeIdentity, RuntimeIdentityError } = await import("../identity.js");
          let thrown: unknown;
          try {
            await verifyRuntimeIdentity(() => sql`select current_user`, 4_000);
          } catch (error) {
            thrown = error;
          } finally {
            await sql.end({ timeout: 1 }).catch(() => {});
          }
          if (!(thrown instanceof RuntimeIdentityError)) {
            throw new Error("the identity check did not fail closed with the database denied");
          }
          const liveness = await probeLiveness(`${context.api.url}/health`, 5);
          assertLivenessContract(liveness);
          return "real server and private identity checks failed closed with the database denied; no listener opened and liveness disclosed no dependency detail";
        } finally {
          await context.environment.restartPooledEndpoint();
        }
      },
    ],
    [
      "missing database config",
      async () => {
        const attempt = attemptStart(context.root, {
          ...baseStartupEnv(context),
          DATABASE_URL: "",
        });
        if (attempt.status === 0 || !/DATABASE_URL_MISSING/.test(attempt.output)) {
          throw new Error("a missing DATABASE_URL did not reject startup");
        }
        return "startup without DATABASE_URL rejected before serving";
      },
    ],
    [
      "mismatched role config",
      async () => {
        const attempt = attemptStart(context.root, {
          ...baseStartupEnv(context),
          DATABASE_URL: `postgresql://${RUNTIME_ROLE}.${context.environment.id}@127.0.0.1:6543/postgres`,
          DATABASE_ROLE: "forma_migrator",
        });
        if (attempt.status === 0 || !/DATABASE_ROLE_MARKER_MISMATCH/.test(attempt.output)) {
          throw new Error("a marker/URL mismatch did not reject startup");
        }
        return "startup with a marker/URL mismatch rejected before serving";
      },
    ],
  ]);
}

/**
 * Push one arbitrary exception through the live Hono boundary and both pipeline
 * persistence paths, then inspect all three exits: client body, captured logs,
 * and the disposable database columns.
 */
async function adversarialSafeErrorProof(context: Context): Promise<string> {
  const response = await fetch(`${context.api.url}/__e01/adversarial-failure`, {
    signal: AbortSignal.timeout(5_000),
  });
  const body = await response.text();
  if (response.status !== 500) throw new Error(`injected API failure returned HTTP ${response.status}`);
  requireExactBody(body, { error: GENERIC_CLIENT_MESSAGE }, "injected API failure");

  // The global Hono boundary must keep an actual CuratedError message on the
  // client wire while omitting it from the process log.
  const globalAccount = await fetch(`${context.api.url}/__e01/adversarial-account-error`, {
    signal: AbortSignal.timeout(5_000),
  });
  const globalAccountBody = await globalAccount.text();
  if (globalAccount.status !== 403) {
    throw new Error(`injected AccountError returned HTTP ${globalAccount.status}`);
  }
  requireExactBody(
    globalAccountBody,
    { error: SYNTHETIC_ARBITRARY_PROVIDER_VALUE },
    "global AccountError",
  );

  // Spoofed Error.name values, causes, and AggregateError descendants all pass
  // through redactError() inside the same global boundary.
  const aggregate = await fetch(`${context.api.url}/__e01/adversarial-aggregate-error`, {
    signal: AbortSignal.timeout(5_000),
  });
  const aggregateBody = await aggregate.text();
  if (aggregate.status !== 500) {
    throw new Error(`injected AggregateError returned HTTP ${aggregate.status}`);
  }
  requireExactBody(aggregateBody, { error: GENERIC_CLIENT_MESSAGE }, "aggregate failure");

  // Exercise the live account route too: its caller-controlled provider username
  // remains in the frozen 409 client body but must not survive logSafeError().
  const firstAccountOwner = await createSyntheticUser(context.environment);
  const secondAccountOwner = await createSyntheticUser(context.environment);
  const accountRequest = {
    method: "POST",
    body: JSON.stringify({
      platform: "chesscom",
      username: SYNTHETIC_ARBITRARY_PROVIDER_VALUE,
    }),
  } satisfies RequestInit;
  const firstLink = await apiRequest(context, "/me/accounts", {
    ...accountRequest,
    token: firstAccountOwner.accessToken,
  });
  if (firstLink.status !== 201) throw new Error(`first adversarial account link returned ${firstLink.status}`);
  const duplicateLink = await apiRequest(context, "/me/accounts", {
    ...accountRequest,
    token: secondAccountOwner.accessToken,
  });
  if (duplicateLink.status !== 409) {
    throw new Error(`duplicate adversarial account link returned ${duplicateLink.status}`);
  }
  requireExactBody(
    duplicateLink.text,
    { error: `"${SYNTHETIC_ARBITRARY_PROVIDER_VALUE}" is already linked to another Forma account` },
    "duplicate account link",
  );

  const userId = randomUUID();
  const accountId = randomUUID();
  const gameId = randomUUID();
  const importId = randomUUID();
  const taskId = randomUUID();
  await context.environment.query(`
    insert into profiles (id, email) values ('${userId}', 'failure-probe@synthetic.invalid');
    insert into linked_accounts (id, user_id, platform, username, normalized_username)
      values ('${accountId}', '${userId}', 'lichess', 'failure-probe', 'failure-probe');
    insert into games (id, user_id, account_id, platform, platform_game_id, color, result, canonical_game_id)
      values ('${gameId}', '${userId}', '${accountId}', 'lichess', 'failure-probe', 'white', 'draw', 'game:v1:lichess:failure-probe');
    insert into analysis_imports (id, user_id, account_id, status, requested_games, max_positions)
      values ('${importId}', '${userId}', '${accountId}', 'analyzing', 1, 1);
    insert into analysis_tasks (id, import_id, game_id, pass, status, idempotency_key, attempts, max_attempts)
      values ('${taskId}', '${importId}', '${gameId}', 'screening', 'running', 'failure-probe', 3, 3)
  `);

  const savedEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_ROLE: process.env.DATABASE_ROLE,
    FORMA_ENV: process.env.FORMA_ENV,
  };
  process.env.DATABASE_URL = context.environment.pooledDatabaseUrl;
  process.env.DATABASE_ROLE = RUNTIME_ROLE;
  process.env.FORMA_ENV = "production";
  const captured: string[] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => captured.push(values.map(String).join(" "));
  try {
    const pipeline = await import("../../pipeline/service.js");
    const injected = new Error(SYNTHETIC_FAILURE_PAYLOAD);
    await pipeline.persistImportFailure(importId, injected);
    await pipeline.persistTaskFailure(taskId, 3, 3, injected);
  } finally {
    console.error = originalError;
    const { client } = await import("../../db/client.js");
    await client.end({ timeout: 2 }).catch(() => {});
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  const rows = await context.environment.query(`
    select 'import' as kind, status::text, error from analysis_imports where id = '${importId}'
    union all
    select 'task' as kind, status::text, error from analysis_tasks where id = '${taskId}'
    order by kind
  `);
  if (rows.length !== 2) throw new Error(`failure injection persisted ${rows.length} rows, expected 2`);
  for (const row of rows) {
    if (row.status !== "failed" || row.error !== "unknown") {
      throw new Error(`${String(row.kind)} persisted status=${String(row.status)} error=${String(row.error)}`);
    }
  }
  requireAbsent(body, [SYNTHETIC_FAILURE_PAYLOAD, "someone@synthetic.invalid", "synthetic-player"], "client body");
  requireAbsent(
    context.api.logs(),
    [
      SYNTHETIC_FAILURE_PAYLOAD,
      SYNTHETIC_ARBITRARY_PROVIDER_VALUE,
      "someone@synthetic.invalid",
      "synthetic-player",
    ],
    "live API logs",
  );
  requireAbsent(captured.join("\n"), [SYNTHETIC_FAILURE_PAYLOAD, "someone@synthetic.invalid", "synthetic-player"], "pipeline logs");
  requireAbsent(JSON.stringify(rows), [SYNTHETIC_FAILURE_PAYLOAD, "someone@synthetic.invalid", "synthetic-player"], "persisted error fields");
  return "live AccountError/account-route legacy bodies preserved; caller/provider text, spoofed names, causes, AggregateError descendants, and pipeline payloads omitted from logs and persisted fields";
}

/** Two synthetic users and one synthetic import, created once and shared. */
function ownershipFixture(context: Context) {
  let ready: Promise<{ owner: SyntheticUser; other: SyntheticUser; importId: string }> | undefined;
  return () => {
    if (!ready) {
      ready = (async () => {
        const owner = await createSyntheticUser(context.environment);
        const other = await createSyntheticUser(context.environment);
        const linked = await apiRequest(context, "/me/accounts", {
          method: "POST",
          token: owner.accessToken,
          body: JSON.stringify({ platform: "lichess", username: `synth-${context.environment.id}` }),
        });
        if (linked.status !== 201) {
          throw new Error(`linking a synthetic account returned HTTP ${linked.status}`);
        }
        const created = await apiRequest(context, "/imports/lichess", {
          method: "POST",
          token: owner.accessToken,
          body: JSON.stringify({ games: 1 }),
        });
        if (created.status !== 201) {
          throw new Error(`creating a synthetic import returned HTTP ${created.status}`);
        }
        const body = JSON.parse(created.text) as { import: { id: string } };
        return { owner, other, importId: body.import.id };
      })();
    }
    return ready;
  };
}

function authBodies(context: Context, fixture: ReturnType<typeof ownershipFixture>) {
  return new Map<string, AssertionBody>([
    [
      "absent token",
      async () => {
        const response = await apiRequest(context, "/me");
        if (response.status !== 401) throw new Error(`absent token returned HTTP ${response.status}`);
        requireExactBody(response.text, UNAUTHENTICATED_BODY, "absent token");
        return 'HTTP 401 with byte-equivalent {"error":"Sign in to continue"}';
      },
    ],
    [
      "malformed token",
      async () => {
        const response = await apiRequest(context, "/me", { token: "malformed.synthetic" });
        if (response.status !== 401) throw new Error(`malformed token returned HTTP ${response.status}`);
        requireExactBody(response.text, UNAUTHENTICATED_BODY, "malformed token");
        return 'HTTP 401 with byte-equivalent {"error":"Sign in to continue"}';
      },
    ],
    [
      "revoked-before-first-use token",
      async () => {
        // The session is created and revoked before the application ever sees
        // the token, so no cache entry can exist for it.
        const user = await createSyntheticUser(context.environment);
        const loggedOut = await authFetch(context.environment, "/auth/v1/logout?scope=global", {
          method: "POST",
          serviceRole: true,
          headers: { Authorization: `Bearer ${user.accessToken}` },
        });
        if (loggedOut.status !== 204) {
          throw new Error(`global logout returned HTTP ${loggedOut.status}, expected 204`);
        }
        const startedAt = Date.now();
        const response = await apiRequest(context, "/me", { token: user.accessToken });
        const elapsed = Date.now() - startedAt;
        if (response.status !== 401) {
          throw new Error(`revoked token returned HTTP ${response.status} after ${elapsed}ms`);
        }
        requireExactBody(response.text, UNAUTHENTICATED_BODY, "revoked token");
        if (elapsed > 10_000) throw new Error(`revoked token took ${elapsed}ms, budget is 10000ms`);
        return `global logout 204, then first use denied with the exact 401 body in ${elapsed}ms`;
      },
    ],
    [
      "foreign import read",
      async () => {
        const { other, importId } = await fixture();
        const response = await apiRequest(context, `/imports/${importId}`, { token: other.accessToken });
        if (response.status !== 404) throw new Error(`foreign read returned HTTP ${response.status}`);
        requireExactBody(response.text, IMPORT_NOT_FOUND_BODY, "foreign import read");
        return 'a second actor reading the first actor\'s import got HTTP 404 with {"error":"Import not found"}';
      },
    ],
    [
      "foreign import cancel",
      async () => {
        const { other, importId } = await fixture();
        const response = await apiRequest(context, `/imports/${importId}/cancel`, {
          method: "POST",
          token: other.accessToken,
        });
        if (response.status !== 404) throw new Error(`foreign cancel returned HTTP ${response.status}`);
        requireExactBody(response.text, IMPORT_NOT_FOUND_BODY, "foreign import cancel");
        return 'a second actor cancelling the first actor\'s import got HTTP 404 with {"error":"Import not found"}';
      },
    ],
    [
      "runtime write",
      async () => {
        const { owner, importId } = await fixture();
        const rows = await context.environment.query(
          `select count(*)::int as owned from analysis_imports where user_id = '${owner.id}'`,
        );
        const owned = Number(rows[0]?.owned ?? 0);
        if (owned !== 1) throw new Error(`the synthetic user owns ${owned} import rows, expected exactly 1`);
        const identity = await context.environment.query(
          `select count(*)::int as present from analysis_imports where id = '${importId}' and user_id = '${owner.id}'`,
        );
        if (Number(identity[0]?.present ?? 0) !== 1) {
          throw new Error("the created import row is not owned by the synthetic user");
        }
        return `one owned synthetic import row written through ${RUNTIME_ROLE}`;
      },
    ],
    [
      "runtime read",
      async () => {
        const { owner, importId } = await fixture();
        const response = await apiRequest(context, "/imports", { token: owner.accessToken });
        if (response.status !== 200) throw new Error(`owner read returned HTTP ${response.status}`);
        const body = JSON.parse(response.text) as { imports: Array<{ id: string }> };
        if (body.imports.length !== 1 || body.imports[0].id !== importId) {
          throw new Error(`owner read returned ${body.imports.length} rows, expected only the owned one`);
        }
        const direct = await apiRequest(context, `/imports/${importId}`, { token: owner.accessToken });
        if (direct.status !== 200) throw new Error(`owner direct read returned HTTP ${direct.status}`);
        return `read returned only the owned synthetic row through ${RUNTIME_ROLE}`;
      },
    ],
  ]);
}

/**
 * Effective access including a new object created under every default-ACL
 * grantor. The surviving `supabase_admin` rows would grant a browser role every
 * privilege on such an object, so this is the assertion that decides whether
 * that is residual risk or live exposure.
 */
function effectiveAccessBodies(context: Context) {
  let created: Promise<string[]> | undefined;
  const ensureObjects = () => {
    if (!created) {
      created = (async () => {
        const postgresJs = (await import("postgres")).default;
        const names: string[] = [];
        for (const grantor of ["postgres", "supabase_admin"]) {
          const url = context.environment.directDatabaseUrl.replace(
            /\/\/[^:@/]+(:[^@/]*)?@/,
            `//${grantor}@`,
          );
          const sql = postgresJs(url, { prepare: false, max: 1, connect_timeout: 5, onnotice: () => {} });
          const name = `e01_rehearsal_new_${grantor}`;
          try {
            await sql.unsafe(`create table public.${name} (id int primary key)`);
            names.push(name);
          } finally {
            await sql.end({ timeout: 2 });
          }
        }
        return names;
      })();
    }
    return created;
  };

  const body = (role: string, accessClass: AccessClass): AssertionBody => async () => {
    const newObjects = await ensureObjects();
    const usable = await context.environment.query(
      role === "PUBLIC"
        ? `select 1 as ok from pg_namespace n, lateral aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
           where n.nspname = 'public' and a.grantee = 0 and a.privilege_type = 'USAGE'`
        : `select 1 as ok where has_schema_privilege('${role}', 'public', 'USAGE')`,
    );
    if (usable.length > 0) {
      throw new Error(`${role} retains USAGE on schema public`);
    }
    if (accessClass === "schema") {
      return `${role} has no effective schema access in public; ${newObjects.length} new default-ACL objects unreachable`;
    }
    // Without schema usage nothing inside is reachable; prove the new objects
    // specifically, because that is where the surviving default ACLs bite.
    if (accessClass === "tables") {
      for (const name of newObjects) {
        const reachable = await context.environment.query(
          role === "PUBLIC"
            ? `select 1 as ok from pg_class c join pg_namespace n on n.oid = c.relnamespace,
                 lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
               where n.nspname = 'public' and c.relname = '${name}' and a.grantee = 0
                 and a.privilege_type = 'SELECT'
                 and has_schema_privilege('anon', 'public', 'USAGE')`
            : `select 1 as ok from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'public' and c.relname = '${name}'
                 and has_table_privilege('${role}', c.oid, 'SELECT')
                 and has_schema_privilege('${role}', 'public', 'USAGE')`,
        );
        if (reachable.length > 0) {
          throw new Error(`${role} can reach the new default-ACL object ${name}`);
        }
      }
      return `${role} has no effective tables access in public; new objects under both default-ACL grantors are unreachable`;
    }
    return `${role} has no effective ${accessClass} access in public (no schema USAGE); new default-ACL objects unreachable`;
  };

  const bodies = new Map<string, AssertionBody>();
  for (const role of DENIED_ROLES) {
    for (const accessClass of ["schema", "tables", "sequences", "routines"] as const) {
      bodies.set(`${role}:${accessClass}`, body(role, accessClass));
    }
  }
  return bodies;
}

/**
 * Real-Postgres negative controls for catalogue exactness. Each mutation lives
 * only long enough to take a fresh read-only snapshot, is required to be
 * rejected, and is then reversed before the next frozen assertion runs.
 */
function catalogueAdversarialBodies(context: Context): AssertionBody[] {
  interface Scenario {
    label: string;
    setup: string;
    cleanup: string;
    check: (source: Awaited<ReturnType<typeof createSqlCatalogueSource>>) => Promise<void>;
  }

  const scenarios: Scenario[] = [
    // These two used `public.puzzles` until 0042 dropped it. It was the
    // convenient subject because the runtime held nothing on it at all, and
    // after 0042 no such table exists. `mistakes` is the closest thing left:
    // the runtime holds SELECT on it and nothing else, so a column grant of any
    // other privilege is still a privilege the contract has never listed, and
    // the property under test -- a *column*-level grant is caught, not just a
    // table-level one -- is unchanged.
    {
      label: `column UPDATE on read-only public.mistakes for ${RUNTIME_ROLE}`,
      setup: `grant update (id) on table public.mistakes to ${RUNTIME_ROLE}`,
      cleanup: `revoke update (id) on table public.mistakes from ${RUNTIME_ROLE}`,
      check: assertExactRuntimeGrants,
    },
    {
      label: "effective browser column access on public.mistakes",
      setup: "grant usage on schema public to anon; grant select (id) on table public.mistakes to anon",
      cleanup: "revoke select (id) on table public.mistakes from anon; revoke usage on schema public from anon",
      check: async (source) => {
        const reachable = await source.effectiveAccess("anon", "tables");
        if (!reachable.includes("mistakes")) {
          throw new Error("the probe failed to observe effective anon column access to mistakes");
        }
        await assertExactRuntimeGrants(source);
      },
    },
    {
      label: `SELECT WITH GRANT OPTION drift on public.profiles for ${RUNTIME_ROLE}`,
      setup: `grant select on table public.profiles to ${RUNTIME_ROLE} with grant option`,
      cleanup: `revoke grant option for select on table public.profiles from ${RUNTIME_ROLE}`,
      check: assertExactRuntimeGrants,
    },
    {
      label: "an unlisted non-r public view",
      setup: "create view public.e01_unlisted_relation as select id from public.mistakes",
      cleanup: "drop view public.e01_unlisted_relation",
      check: assertExactTables,
    },
  ];

  const grouped = [[scenarios[0]], [scenarios[1]], [scenarios[2], scenarios[3]]];
  return grouped.map((group) => async () => {
    const rejected: string[] = [];
    for (const scenario of group) {
      await context.environment.query(scenario.setup);
      let didReject = false;
      try {
        const source = await createSqlCatalogueSource(
          context.environment.query,
          `adversarial disposable ${context.environment.id}`,
        );
        try {
          await scenario.check(source);
        } catch {
          didReject = true;
        }
      } finally {
        await context.environment.query(scenario.cleanup);
      }
      if (!didReject) throw new Error(`catalogue predicates accepted ${scenario.label}`);
      rejected.push(scenario.label);
    }
    return `real disposable Postgres rejected ${rejected.join(" and ")}`;
  });
}

// --- gate assembly ---------------------------------------------------------

async function buildBodies(
  context: Context,
  records: readonly AssertionRecord[],
): Promise<Map<string, AssertionBody>> {
  const source = await createSqlCatalogueSource(
    context.environment.query,
    `disposable ${context.environment.id} after 0011`,
  );
  const artifacts = artifactBodies(context.root);
  const hooks = {
    scanMigratorPaths: async () => describeHits(scanMigratorOperationalPaths(context.root)),
  };
  const cors = corsBodies(context);
  const startup = startupBodies(context);
  const secrets = secretMetadataBodies();
  const liveness = livenessBodies(context);
  const fixture = ownershipFixture(context);
  const auth = authBodies(context, fixture);
  const effective = effectiveAccessBodies(context);
  const safeErrors = safeErrorBodies(() => context.api.logs());
  const catalogueAdversarial = catalogueAdversarialBodies(context);
  const providerBody = safeErrors.get("provider payload");
  if (!providerBody) throw new Error("provider safe-error body is missing");
  safeErrors.set("provider payload", async (record) => {
    const helperDetail = await providerBody(record);
    return `${helperDetail}; ${await adversarialSafeErrorProof(context)}`;
  });

  const bodies = new Map<string, AssertionBody>();
  let runtimeDenialIndex = 0;
  for (const record of records) {
    switch (record.category) {
      case "artifact-integrity": {
        const body = artifacts.get(record.target);
        if (!body) throw new Error(`no artifact body for "${record.target}"`);
        bodies.set(record.id, body);
        continue;
      }
      case "journal":
        bodies.set(record.id, journalBody(context.root));
        continue;
      case "effective-access": {
        const body = effective.get(record.target);
        if (!body) throw new Error(`no effective-access body for "${record.target}"`);
        bodies.set(record.id, body);
        continue;
      }
      case "anonymous-data-api": {
        const table = record.target.replace(/^public\./, "");
        if (!(CONTAINED_TABLES as readonly string[]).includes(table)) {
          throw new Error(`anonymous probe target "${record.target}" is not a contained table`);
        }
        bodies.set(record.id, async (assertion) => {
          if (!(await source.tableExists(table))) {
            throw new Error(`public.${table} does not exist; existence must be proven before probing`);
          }
          const result = await probeAnonymousSelect(
            { restUrl: context.environment.restUrl, publishableKey: context.environment.publishableKey },
            table,
            assertion.timeout_seconds,
          );
          if (result.verdict.kind !== "denied") {
            throw new Error(`anonymous select on public.${table}: ${result.verdict.detail}`);
          }
          return `public.${table} exists; anonymous select denied (${result.verdict.detail})`;
        });
        continue;
      }
      case "cors":
      case "startup-private-identity":
      case "secret-metadata":
      case "liveness-config-negative":
      case "safe-error":
      case "auth-token":
      case "foreign-import":
      case "real-read-write": {
        const family =
          record.category === "cors"
            ? cors
            : record.category === "startup-private-identity"
              ? startup
              : record.category === "secret-metadata"
                ? secrets
                : record.category === "liveness-config-negative"
                  ? liveness
                  : record.category === "safe-error"
                    ? safeErrors
                    : auth;
        const body = family.get(record.target);
        if (!body) throw new Error(`no ${record.category} body for "${record.target}"`);
        bodies.set(record.id, body);
        continue;
      }
      case "teardown":
        bodies.set(record.id, async () => {
          const proof = await context.environment.destroy();
          context.teardown = proof;
          if (proof.containersRemaining.length > 0) {
            throw new Error(`containers survived teardown: ${proof.containersRemaining.join(", ")}`);
          }
          if (!proof.workdirRemoved) throw new Error("the disposable working directory survived teardown");
          if (!proof.connectionRefused) {
            throw new Error("the disposable database still accepts connections after teardown");
          }
          return `environment ${proof.id} destroyed; no container or working directory remains and a subsequent connection fails`;
        });
        continue;
      default: {
        const body = catalogueBody(record, source, hooks);
        if (!body) throw new Error(`no body for category "${record.category}" (${record.id})`);
        if (record.category === "runtime-denial") {
          const adversarial = catalogueAdversarial[runtimeDenialIndex];
          runtimeDenialIndex += 1;
          if (!adversarial) throw new Error(`no adversarial body for ${record.id}`);
          bodies.set(record.id, async (assertion) => {
            const detail = await body(assertion);
            return `${detail}; ${await adversarial(assertion)}`;
          });
        } else {
          bodies.set(record.id, body);
        }
      }
    }
  }
  if (runtimeDenialIndex !== catalogueAdversarial.length) {
    throw new Error(
      `expected ${catalogueAdversarial.length} runtime-denial assertions, saw ${runtimeDenialIndex}`,
    );
  }
  return bodies;
}

export async function main(): Promise<number> {
  const root = repoRoot();
  const manifest = loadManifest(root);
  const records = assertionsFor(manifest, COMMAND);
  const report = (line: string) => process.stderr.write(`# ${line}\n`);

  const environment = await createDisposableEnvironment(root, report);
  let context: Context | undefined;
  try {
    const api = await startLocalApi(root, environment, {
      E01_ADVERSARIAL_PROBES: "synthetic-only",
      E01_ADVERSARIAL_FAILURE_PAYLOAD: SYNTHETIC_FAILURE_PAYLOAD,
      E01_ADVERSARIAL_ACCOUNT_VALUE: SYNTHETIC_ARBITRARY_PROVIDER_VALUE,
    });
    context = { root, environment, api };
    process.stdout.write(
      `ENVIRONMENT id=${environment.id} started_at=${environment.startedAt} pooled=${environment.pooledDatabaseUrl}\n`,
    );
    const bodies = await buildBodies(context, records);
    const outcome = await runGate({ command: COMMAND, records, bodies });
    await api.stop();
    return gateExitCode(outcome);
  } finally {
    if (!context?.teardown) {
      // Teardown is itself an assertion; if the run never reached it, the
      // environment still must not survive the command.
      const proof = await environment.destroy().catch(() => undefined);
      if (proof) {
        process.stdout.write(`ENVIRONMENT id=${proof.id} destroyed_at=${proof.endedAt}\n`);
      }
    } else {
      process.stdout.write(
        `ENVIRONMENT id=${context.teardown.id} destroyed_at=${context.teardown.endedAt}\n`,
      );
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`security:rehearsal failed to run: ${String(error)}\n`);
      process.exit(1);
    },
  );
}

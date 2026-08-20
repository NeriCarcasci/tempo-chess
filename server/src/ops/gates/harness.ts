import { createServer, type Server } from "node:http";
import postgres from "postgres";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JSONWebKeySet } from "jose";
import type { Hono } from "hono";
import { startKernelHarness, GateReport, type KernelHarness } from "../../v1/gates/harness.js";
import { HARNESS_PASSWORD } from "../../platform/harness/postgres.js";

export { GateReport };

/**
 * A real ledger over a real PostgreSQL, with a real private ingress and a real
 * Cloud Tasks API in front of it.
 *
 * Everything E04 claims is a claim about behaviour under concurrency, crash and
 * duplicate delivery, and none of it can be shown against a mock: a stub of
 * `FOR UPDATE SKIP LOCKED` is a stub of the exact race the design rests on. So
 * the gates run the production kernel, the production routes and the production
 * `CloudTasksTransport` against a disposable cluster and a loopback queue that
 * speaks the Cloud Tasks REST shape.
 *
 * The queue stub is not a mock of our code. It is a stand-in for Google's
 * service, in the same position the emulator occupies, and the transport cannot
 * tell the difference — which is the point: the code path under test is the one
 * that will run in production.
 */

export const OPS_SERVICE_ACCOUNT = "forma-ops@gate.iam.gserviceaccount.com";
export const WORKER_SERVICE_ACCOUNT = "forma-worker@gate.iam.gserviceaccount.com";
export const INTERNAL_AUDIENCE = "https://forma-worker.gate.invalid";
export const INTERNAL_ISSUER = "https://accounts.google.invalid";

/** One task as the stub queue received it. */
export interface CapturedTask {
  queue: string;
  name: string;
  url: string;
  scheduleTime: string | null;
  payload: Record<string, unknown>;
  oidcAudience: string | null;
  oidcServiceAccount: string | null;
}

export interface QueueStub {
  endpoint: string;
  tasks: CapturedTask[];
  /** Reject the next `count` create calls, as an unreachable queue would. */
  failNext(count: number): void;
  close(): Promise<void>;
}

/**
 * A loopback Cloud Tasks. It enforces the two behaviours the dispatcher depends
 * on: a task name is unique, and a duplicate create is `409 ALREADY_EXISTS`.
 */
export async function startQueueStub(): Promise<QueueStub> {
  const tasks: CapturedTask[] = [];
  const names = new Set<string>();
  let failures = 0;

  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const match = /\/v2\/projects\/[^/]+\/locations\/[^/]+\/queues\/([^/]+)\/tasks$/.exec(
        request.url ?? "",
      );
      if (!match || request.method !== "POST") {
        response.writeHead(404).end("{}");
        return;
      }
      if (failures > 0) {
        failures -= 1;
        response.writeHead(503).end(JSON.stringify({ error: { message: "unavailable" } }));
        return;
      }
      const parsed = JSON.parse(body) as {
        task: {
          name: string;
          scheduleTime?: string;
          httpRequest: {
            url: string;
            body: string;
            oidcToken?: { serviceAccountEmail: string; audience: string };
          };
        };
      };
      if (names.has(parsed.task.name)) {
        response.writeHead(409).end(JSON.stringify({ error: { status: "ALREADY_EXISTS" } }));
        return;
      }
      names.add(parsed.task.name);
      tasks.push({
        queue: match[1]!,
        name: parsed.task.name,
        url: parsed.task.httpRequest.url,
        scheduleTime: parsed.task.scheduleTime ?? null,
        payload: JSON.parse(Buffer.from(parsed.task.httpRequest.body, "base64").toString("utf8")),
        oidcAudience: parsed.task.httpRequest.oidcToken?.audience ?? null,
        oidcServiceAccount: parsed.task.httpRequest.oidcToken?.serviceAccountEmail ?? null,
      });
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({}));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    tasks,
    failNext(count) {
      failures = count;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export interface LedgerHarness extends KernelHarness {
  queue: QueueStub;
  /**
   * A second connection, as `forma_api`. The gate process serves the private
   * surface as `forma_ops`, but the product surface and the legacy pipeline run
   * as the API role in production, so anything that stands in for them here has
   * to hold that role's grants and no more.
   */
  apiSql: import("postgres").Sql;
  /**
   * A connection as any role in the disposable cluster, for the grant probes.
   * The password is synthetic and the cluster is thrown away, which is exactly
   * why this may never point at a hosted database.
   */
  connectAs(role: string): Promise<import("postgres").Sql>;
  /** A Google-shaped identity token for one of the allowlisted accounts. */
  serviceToken(options?: {
    email?: string;
    audience?: string;
    issuer?: string;
    emailVerified?: boolean;
    key?: CryptoKey;
    expiresIn?: string;
  }): Promise<string>;
  /** A token signed by a key the allowlist has never seen. */
  forgedKey: CryptoKey;
  app: Hono;
  ledger: typeof import("../ledger.js");
  dispatch: typeof import("../dispatch.js");
  tasks: typeof import("../tasks.js");
  handlers: typeof import("../handlers.js");
  executor: typeof import("../executor.js");
  tokens: typeof import("../tokens.js");
  shadow: typeof import("../legacy-shadow.js");
  opsTelemetry: typeof import("../telemetry.js");
}

export interface LedgerHarnessOptions {
  /** The deployment role this gate's process serves as. Defaults to `forma_ops`. */
  role?: string;
}

export async function startLedgerHarness(
  options: LedgerHarnessOptions = {},
): Promise<LedgerHarness> {
  const queue = await startQueueStub();
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const { privateKey: forgedKey } = await generateKeyPair("RS256", { extractable: true });
  const keySet: JSONWebKeySet = {
    keys: [{ ...(await exportJWK(publicKey)), kid: "gate-oidc", alg: "RS256", use: "sig" }],
  };

  process.env.FORMA_INTERNAL_AUDIENCE = INTERNAL_AUDIENCE;
  process.env.FORMA_OPS_SERVICE_ACCOUNTS = OPS_SERVICE_ACCOUNT;
  process.env.FORMA_WORKER_SERVICE_ACCOUNTS = WORKER_SERVICE_ACCOUNT;
  process.env.FORMA_TASKS_PROJECT = "forma-gate";
  process.env.FORMA_TASKS_LOCATION = "europe-west1";
  process.env.FORMA_TASKS_ENDPOINT = queue.endpoint;
  process.env.FORMA_WORKER_BASE_URL = "https://forma-worker.gate.invalid";
  process.env.FORMA_TASKS_INVOKER_SERVICE_ACCOUNT = WORKER_SERVICE_ACCOUNT;

  // The private surface belongs to the operator and worker deployments, so the
  // gate process connects as `forma_ops` — the role that will really serve it.
  // `forma_api`'s own sufficiency is proven separately, per role, by the
  // security gate.
  const base = await startKernelHarness({ role: options.role ?? "forma_ops" });
  const kernel = await import("../../v1/kernel.js");
  const internal = await import("../../internal/routes.js");
  const oidc = await import("../../v1/auth/oidc.js");
  oidc.setInternalIngressForTest({
    audience: INTERNAL_AUDIENCE,
    issuer: INTERNAL_ISSUER,
    ops: [OPS_SERVICE_ACCOUNT],
    workers: [WORKER_SERVICE_ACCOUNT],
    keySet,
  });
  kernel.mountInternal(base.app, internal.INTERNAL_ROUTES);

  const apiSql = postgres(base.db.urlFor("forma_api"), { max: 2, prepare: false, onnotice: () => {} });

  const extraConnections: import("postgres").Sql[] = [];

  return {
    ...base,
    queue,
    apiSql,
    forgedKey,
    async connectAs(role: string) {
      await base.db.query(`alter role ${role} with login password '${HARNESS_PASSWORD}'`);
      const connection = postgres(base.db.urlFor(role), {
        max: 1,
        prepare: false,
        onnotice: () => {},
      });
      extraConnections.push(connection);
      return connection;
    },
    async serviceToken(options = {}) {
      return new SignJWT({
        email: options.email ?? WORKER_SERVICE_ACCOUNT,
        email_verified: options.emailVerified ?? true,
      })
        .setProtectedHeader({ alg: "RS256", kid: "gate-oidc" })
        .setSubject("gate-service-account")
        .setIssuer(options.issuer ?? INTERNAL_ISSUER)
        .setAudience(options.audience ?? INTERNAL_AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(options.expiresIn ?? "5m")
        .sign(options.key ?? privateKey);
    },
    ledger: await import("../ledger.js"),
    dispatch: await import("../dispatch.js"),
    tasks: await import("../tasks.js"),
    handlers: await import("../handlers.js"),
    executor: await import("../executor.js"),
    tokens: await import("../tokens.js"),
    shadow: await import("../legacy-shadow.js"),
    opsTelemetry: await import("../telemetry.js"),
    async destroy() {
      for (const connection of extraConnections) await connection.end({ timeout: 5 }).catch(() => {});
      await apiSql.end({ timeout: 5 }).catch(() => {});
      await queue.close();
      await base.destroy();
    },
  };
}

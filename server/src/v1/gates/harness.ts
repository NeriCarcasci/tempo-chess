import { createHash } from "node:crypto";
import type { Hono } from "hono";
import {
  createDisposableDatabase,
  grantRolePasswords,
  type DisposableDatabase,
} from "../../platform/harness/postgres.js";
import { applyMigrations } from "../../platform/harness/migrations.js";
import { RUNTIME_ROLE } from "../../security/contract.js";

/**
 * A real `/v1` kernel over a real PostgreSQL.
 *
 * Idempotency, rate limiting, the audit trail and the actor context are claims
 * about *database* behaviour under concurrency. None of them can be proven
 * against a mock: a stub of `insert ... on conflict do nothing` is a stub of the
 * exact race the design depends on. So the gates below run against a disposable
 * cluster created for the command and destroyed when it ends, reusing E02's
 * harness rather than adding a second one.
 *
 * The connection is opened as a named least-privilege role, never the owner, so
 * every gate result is also a statement about that role's grants. A missing
 * grant fails the test rather than passing under privileges production does not
 * have. The role defaults to `forma_api`; E04's ledger gates ask for
 * `forma_ops`, because the private surface belongs to that deployment.
 *
 * Never points at the live project: the harness refuses a non-loopback target,
 * and these gates create roles and log in with a synthetic password, which is
 * exactly what must not touch a hosted database.
 */

/** Deterministic, so a signature in a gate log is reproducible. */
export const GATE_SIGNING_KEY = createHash("sha256").update("e03-gate-signing-key").digest("hex");

export interface KernelHarness {
  db: DisposableDatabase;
  /** A Hono app with the production `/v1` routes mounted. */
  app: Hono;
  /** The production kernel modules, imported after the environment was set. */
  kernel: typeof import("../kernel.js");
  routes: typeof import("../routes/index.js");
  telemetry: typeof import("../telemetry.js");
  verifier: typeof import("../auth/verifier.js");
  context: typeof import("../auth/context.js");
  rateLimit: typeof import("../rate-limit.js");
  idempotency: typeof import("../idempotency.js");
  /** The runtime connection the kernel itself uses. */
  sql: typeof import("../../db/client.js")["client"];
  destroy(): Promise<void>;
}

/**
 * Build the harness.
 *
 * The environment is set before the first import of `db/client.js`, because
 * that module resolves and gates the connection at module load — deliberately,
 * since a process that cannot prove its identity must not serve. Dynamic import
 * is how a test gets to choose the target without weakening that gate.
 */
export interface KernelHarnessOptions {
  /**
   * The deployment role this harness's process connects as. Defaults to the
   * API role. E04's ledger gates use `forma_ops`, because the private
   * dispatch, recovery and worker endpoints belong to deployments that connect
   * as themselves — running them as `forma_api` would prove nothing about the
   * grants they will actually hold.
   */
  role?: string;
}

export async function startKernelHarness(
  options: KernelHarnessOptions = {},
): Promise<KernelHarness> {
  const role = options.role ?? RUNTIME_ROLE;
  const db = await createDisposableDatabase();
  try {
    await applyMigrations(db.adminUrl);
    await grantRolePasswords(db, [RUNTIME_ROLE, role]);

    process.env.DATABASE_URL = db.urlFor(role);
    process.env.DATABASE_ROLE = role;
    process.env.FORMA_API_SIGNING_KEY = GATE_SIGNING_KEY;
    process.env.SUPABASE_URL ??= "https://gate.supabase.invalid";
    process.env.SUPABASE_ANON_KEY ??= "gate-anon-key";
    delete process.env.FORMA_ENV;
    delete process.env.K_SERVICE;

    const { Hono } = await import("hono");
    const kernel = await import("../kernel.js");
    const routes = await import("../routes/index.js");
    const telemetry = await import("../telemetry.js");
    const verifier = await import("../auth/verifier.js");
    const context = await import("../auth/context.js");
    const rateLimit = await import("../rate-limit.js");
    const idempotency = await import("../idempotency.js");
    const { client } = await import("../../db/client.js");

    const app = new Hono();
    kernel.mountV1(app, routes.V1_ROUTES);

    return {
      db,
      app,
      kernel,
      routes,
      telemetry,
      verifier,
      context,
      rateLimit,
      idempotency,
      sql: client,
      async destroy() {
        await client.end({ timeout: 5 }).catch(() => {});
        await db.destroy();
      },
    };
  } catch (error) {
    await db.destroy();
    throw error;
  }
}

/** A tiny assertion runner shared by the gates, matching the repo's gate style. */
export class GateReport {
  private failures = 0;
  private passes = 0;

  constructor(private readonly title: string) {
    console.log(`${title}\n`);
  }

  section(name: string): void {
    console.log(`${name}`);
  }

  async check(name: string, run: () => Promise<void> | void): Promise<void> {
    try {
      await run();
      this.passes += 1;
      console.log(`  ok  ${name}`);
    } catch (error) {
      this.failures += 1;
      console.error(`  FAIL ${name}: ${(error as Error).message}`);
    }
  }

  finish(): never {
    const verdict = this.failures === 0 ? "pass" : `${this.failures} failing`;
    console.log(`\n${this.title}: ${verdict} (${this.passes} checks)`);
    process.exit(this.failures === 0 ? 0 : 1);
  }
}

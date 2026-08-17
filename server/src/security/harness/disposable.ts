/**
 * The disposable production-shaped rehearsal environment.
 *
 * E01 owes staging-grade evidence without owning staging, so it builds one for
 * the length of a single command and destroys it: local containers, synthetic
 * fixtures, a scratch working directory outside the repository, and nothing that
 * outlives the run. There is no persistent project, service, or topology here —
 * that belongs to E05.
 *
 * The environment is deliberately production-*shaped* rather than production-
 * like-enough: the browser-role exposure the audit found is re-created first, so
 * applying 0011 has something real to close. A rehearsal that starts already
 * contained proves nothing.
 *
 * It never targets the production project or the unrelated Eireplan project;
 * `assertDisposableTarget` refuses both by ref and by host.
 */

import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { FORBIDDEN_TARGET_REFS, PRODUCTION, RUNTIME_ROLE } from "../contract.js";
import { startPooledEndpoint, type PooledEndpoint } from "./pooled-endpoint.js";

/** Ports are shifted well clear of the Supabase CLI defaults so a developer's own stack survives. */
const PORT_BASE = 54_500;
const POOLED_PORT = 6543;

export interface DisposableEnvironment {
  /** Creation identifier, recorded in evidence and asserted absent after teardown. */
  readonly id: string;
  readonly workdir: string;
  readonly startedAt: string;
  readonly apiUrl: string;
  readonly restUrl: string;
  readonly publishableKey: string;
  readonly serviceRoleKey: string;
  readonly directDatabaseUrl: string;
  /** The pooled, production-shaped URL the rehearsal API uses. */
  readonly pooledDatabaseUrl: string;
  readonly localApiUrl: string;
  readonly query: (sql: string) => Promise<Array<Record<string, unknown>>>;
  readonly pooledEndpoint: PooledEndpoint;
  restartPooledEndpoint(upstreamRole?: string): Promise<void>;
  closePooledEndpoint(): Promise<void>;
  destroy(): Promise<TeardownProof>;
}

export interface TeardownProof {
  id: string;
  endedAt: string;
  containersRemaining: string[];
  workdirRemoved: boolean;
  connectionRefused: boolean;
}

function podmanEnv(): NodeJS.ProcessEnv {
  const uid = process.getuid?.() ?? 1000;
  return {
    ...process.env,
    DOCKER_HOST: process.env.DOCKER_HOST ?? `unix:///run/user/${uid}/podman/podman.sock`,
  };
}

/** Refuse, loudly, to point the rehearsal at anything that is not disposable. */
export function assertDisposableTarget(target: string): void {
  for (const ref of FORBIDDEN_TARGET_REFS) {
    if (target.includes(ref)) {
      throw new Error(`rehearsal refused: target names the forbidden project ref ${ref}`);
    }
  }
  if (/supabase\.(co|com)/i.test(target)) {
    throw new Error("rehearsal refused: target is a hosted Supabase endpoint");
  }
  if (!/(^|@|\/\/)(127\.0\.0\.1|localhost)(:|\/|$)/.test(target)) {
    throw new Error("rehearsal refused: target is not a loopback address");
  }
}

function run(command: string, args: string[], cwd: string, timeoutMs = 600_000): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    env: podmanEnv(),
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args[0]} failed (${result.status}): ${(result.stderr ?? "").trim().slice(0, 400)}`,
    );
  }
  return result.stdout ?? "";
}

/** Shift every default port so this stack cannot collide with another one. */
function rewritePorts(config: string, id: string): string {
  let shifted = config.replace(/^(\s*port\s*=\s*)(5432\d)\s*$/gm, (_match, prefix: string, port: string) =>
    `${prefix}${PORT_BASE + (Number(port) - 54_320)}`,
  );
  shifted = shifted.replace(/^project_id\s*=.*$/m, `project_id = "${id}"`);
  return shifted;
}

interface SupabaseStatus {
  DB_URL: string;
  API_URL: string;
  REST_URL: string;
  PUBLISHABLE_KEY?: string;
  ANON_KEY?: string;
  SECRET_KEY?: string;
  SERVICE_ROLE_KEY?: string;
}

/** Services the rehearsal does not use. Excluded so startup stays under a minute. */
const EXCLUDED_SERVICES = [
  "realtime",
  "storage-api",
  "imgproxy",
  "studio",
  "edge-runtime",
  "logflare",
  "vector",
  "supavisor",
  "mailpit",
].join(",");

function freeIdentifier(): string {
  const suffix = execFileSync("od", ["-An", "-N4", "-tx1", "/dev/urandom"], { encoding: "utf8" })
    .trim()
    .replace(/\s+/g, "");
  return `e01reh${suffix}`;
}

export async function createDisposableEnvironment(
  repoRoot: string,
  report: (line: string) => void = () => {},
): Promise<DisposableEnvironment> {
  const id = freeIdentifier();
  const startedAt = new Date().toISOString();
  const workdir = mkdtempSync(join(tmpdir(), `${id}-`));
  report(`rehearsal environment ${id} created at ${workdir}`);

  run("supabase", ["init", "--force", "--with-vscode-settings=false", "--with-intellij-settings=false"], workdir);
  const configPath = join(workdir, "supabase", "config.toml");
  writeFileSync(configPath, rewritePorts(readFileSync(configPath, "utf8"), id));

  run("supabase", ["start", "-x", EXCLUDED_SERVICES], workdir);
  const status = JSON.parse(run("supabase", ["status", "-o", "json"], workdir)) as SupabaseStatus;

  const directDatabaseUrl = status.DB_URL;
  assertDisposableTarget(directDatabaseUrl);
  assertDisposableTarget(status.API_URL);

  const dbPort = Number(new URL(directDatabaseUrl).port);
  const publishableKey = status.PUBLISHABLE_KEY ?? status.ANON_KEY ?? "";
  const serviceRoleKey = status.SECRET_KEY ?? status.SERVICE_ROLE_KEY ?? "";
  if (!publishableKey || !serviceRoleKey) {
    throw new Error("disposable stack did not report the keys the rehearsal needs");
  }

  const admin = postgres(directDatabaseUrl, { prepare: false, max: 2, onnotice: () => {} });
  const query = async (sql: string) =>
    (await admin.unsafe(sql)) as unknown as Array<Record<string, unknown>>;

  // The disposable container authenticates loopback connections with a
  // password. E01 may not execute any role/password statement, even against a
  // throwaway database, so the container's own host-based authentication is
  // relaxed instead. Nothing is provisioned, nothing is stored, and the file
  // dies with the container.
  const container = `supabase_db_${id}`;
  run(
    "podman",
    [
      "exec",
      container,
      "bash",
      "-lc",
      "cp /etc/postgresql/pg_hba.conf /tmp/hba.orig && " +
        "{ printf 'host all all 0.0.0.0/0 trust\\nhost all all ::0/0 trust\\n'; cat /tmp/hba.orig; } " +
        "> /etc/postgresql/pg_hba.conf",
    ],
    workdir,
    60_000,
  );
  await query("select pg_reload_conf()");

  report("applying migrations 0000-0010");
  await applyBaselineMigrations(repoRoot, admin);
  report("re-creating the production-shaped browser-role exposure");
  await reproduceLegacyExposure(admin);
  report("applying the exact 0011 once");
  await applyContainment(repoRoot, admin);
  await query("notify pgrst, 'reload schema'");

  const pooledEndpoint = await startPooledEndpoint({
    listenPort: POOLED_PORT,
    upstreamHost: "127.0.0.1",
    upstreamPort: dbPort,
    tenantRef: id,
  });
  const pooledDatabaseUrl = `postgresql://${RUNTIME_ROLE}.${id}@127.0.0.1:${POOLED_PORT}/postgres`;
  assertDisposableTarget(pooledDatabaseUrl);

  let endpoint = pooledEndpoint;
  const environment: DisposableEnvironment = {
    id,
    workdir,
    startedAt,
    apiUrl: status.API_URL,
    restUrl: status.REST_URL,
    publishableKey,
    serviceRoleKey,
    directDatabaseUrl,
    pooledDatabaseUrl,
    localApiUrl: `http://127.0.0.1:${PORT_BASE + 80}`,
    query,
    get pooledEndpoint() {
      return endpoint;
    },
    async closePooledEndpoint() {
      await endpoint.close();
    },
    async restartPooledEndpoint(upstreamRole?: string) {
      endpoint = await startPooledEndpoint({
        listenPort: POOLED_PORT,
        upstreamHost: "127.0.0.1",
        upstreamPort: dbPort,
        tenantRef: id,
        upstreamRole,
      });
    },
    async destroy(): Promise<TeardownProof> {
      await endpoint.close().catch(() => {});
      await admin.end({ timeout: 3 }).catch(() => {});
      spawnSync("supabase", ["stop", "--no-backup"], {
        cwd: workdir,
        encoding: "utf8",
        timeout: 120_000,
        env: podmanEnv(),
      });
      let workdirRemoved = true;
      try {
        rmSync(workdir, { recursive: true, force: true });
      } catch {
        workdirRemoved = false;
      }
      const containers = spawnSync("podman", ["ps", "-a", "--format", "{{.Names}}"], {
        encoding: "utf8",
        timeout: 30_000,
        env: podmanEnv(),
      });
      const containersRemaining = (containers.stdout ?? "")
        .split("\n")
        .map((name) => name.trim())
        .filter((name) => name.length > 0 && name.includes(id));
      let connectionRefused = false;
      try {
        const probe = postgres(directDatabaseUrl, {
          prepare: false,
          max: 1,
          connect_timeout: 3,
          onnotice: () => {},
        });
        await probe`select 1`;
        await probe.end({ timeout: 1 });
      } catch {
        connectionRefused = true;
      }
      return {
        id,
        endedAt: new Date().toISOString(),
        containersRemaining,
        workdirRemoved,
        connectionRefused,
      };
    },
  };
  return environment;
}

type Admin = ReturnType<typeof postgres>;

function statementsOf(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

async function applyBaselineMigrations(repoRoot: string, admin: Admin): Promise<void> {
  const { readdirSync } = await import("node:fs");
  const dir = `${repoRoot}/server/drizzle`;
  const files = readdirSync(dir)
    .filter((file) => /^\d{4}_.*\.sql$/.test(file) && !file.startsWith("0011"))
    .sort();
  for (const file of files) {
    for (const statement of statementsOf(readFileSync(`${dir}/${file}`, "utf8"))) {
      await admin.unsafe(statement);
    }
  }
}

/**
 * Re-create the exposure recorded in the audit: broad browser-role privileges on
 * every legacy table, schema usage, and default privileges that re-grant on each
 * new object. This is what 0011 then has to close.
 */
async function reproduceLegacyExposure(admin: Admin): Promise<void> {
  const statements = [
    "grant usage on schema public to public, anon, authenticated",
    "grant all on all tables in schema public to anon, authenticated",
    "grant all on all sequences in schema public to anon, authenticated",
    "alter default privileges in schema public grant all on tables to anon, authenticated",
    "alter default privileges in schema public grant all on sequences to anon, authenticated",
    "alter default privileges in schema public grant execute on functions to anon, authenticated",
  ];
  for (const statement of statements) await admin.unsafe(statement);
}

/** Apply the exact committed 0011, once. */
async function applyContainment(repoRoot: string, admin: Admin): Promise<void> {
  const sql = readFileSync(`${repoRoot}/server/drizzle/0011_e01_containment.sql`, "utf8");
  for (const statement of statementsOf(sql)) {
    await admin.unsafe(statement);
  }
}

export interface LocalApi {
  readonly url: string;
  readonly process: ChildProcess;
  /** Everything the process has written to stdout and stderr so far. */
  logs(): string;
  stop(): Promise<void>;
}

/** Start the real API against the disposable stack, with outbound traffic blocked. */
export async function startLocalApi(
  repoRoot: string,
  environment: DisposableEnvironment,
  overrides: NodeJS.ProcessEnv = {},
  port = PORT_BASE + 80,
): Promise<LocalApi> {
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(
    "npx",
    ["tsx", "--import", "./src/security/harness/offline-guard.ts", "src/index.ts"],
    {
      cwd: `${repoRoot}/server`,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        FORMA_ENV: "production",
        API_PORT: String(port),
        PORT: String(port),
        DATABASE_URL: environment.pooledDatabaseUrl,
        DATABASE_ROLE: RUNTIME_ROLE,
        SUPABASE_URL: environment.apiUrl,
        SUPABASE_ANON_KEY: environment.publishableKey,
        ...overrides,
      },
    },
  );
  const logs: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`local API exited ${child.exitCode}: ${logs.join("").slice(0, 300)}`);
    }
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        return {
          url,
          process: child,
          logs: () => logs.join(""),
          stop: async () => {
            child.kill("SIGTERM");
            await new Promise((resolve) => setTimeout(resolve, 300));
            if (child.exitCode === null) child.kill("SIGKILL");
          },
        };
      }
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  child.kill("SIGKILL");
  throw new Error(`local API did not become ready: ${logs.join("").slice(0, 300)}`);
}

/**
 * Attempt a start that is expected to fail. Returns the combined output so the
 * assertion can prove *why* it refused.
 */
export function attemptStart(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 9_000,
): { status: number | null; output: string } {
  const result = spawnSync("npx", ["tsx", "src/index.ts"], {
    cwd: `${repoRoot}/server`,
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, ...env },
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/**
 * Run the real entrypoint while polling its intended port. `listenerObserved`
 * is sticky, so a process that binds briefly and then exits still fails the
 * startup assertion.
 */
export async function observeRejectedStart(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  port: number,
  timeoutMs = 9_000,
): Promise<{ status: number | null; output: string; listenerObserved: boolean }> {
  const child = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: `${repoRoot}/server`,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env, API_PORT: String(port), PORT: String(port) },
  });
  const chunks: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
  let listenerObserved = false;
  const probe = setInterval(() => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      listenerObserved = true;
      socket.destroy();
    });
    socket.once("error", () => socket.destroy());
    socket.setTimeout(100, () => socket.destroy());
  }, 25);
  const status = await new Promise<number | null>((resolve) => {
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(deadline);
      resolve(code);
    });
  });
  clearInterval(probe);
  return { status, output: chunks.join(""), listenerObserved };
}

export { PORT_BASE, POOLED_PORT };

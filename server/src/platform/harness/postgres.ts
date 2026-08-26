/**
 * A disposable, production-shaped PostgreSQL cluster.
 *
 * E02's claims are about grants, forced RLS, actor context, and migration
 * behaviour. None of that can be proven by reading files, so the gate runs
 * against a real server created for the command and destroyed when it ends.
 *
 * Two ways to get one, in priority order:
 *
 *  1. `FORMA_TEST_DATABASE_URL` — an already-running disposable server the
 *     caller manages (a container, a CI service, a local cluster). A uniquely
 *     named database is created inside it and dropped afterwards.
 *  2. `initdb`/`pg_ctl` on `PATH` or under `FORMA_PG_BINDIR` — a cluster is
 *     initialised in a scratch directory and stopped afterwards.
 *
 * "Production-shaped" is not decoration. A vanilla cluster has no `anon`,
 * `authenticated`, or `service_role`, so a containment claim tested against it
 * would be vacuous: the roles it must exclude would not exist. The harness
 * creates the Supabase role set first, with the `public`-schema default
 * privileges Supabase ships, and only then applies migrations.
 *
 * It refuses, loudly, to point at anything that is not disposable.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { FORBIDDEN_TARGET_REFS } from "../../security/contract.js";

/** Roles a Supabase project ships with. Recreated so exclusion tests are real. */
export const SUPABASE_ROLES = ["anon", "authenticated", "service_role"] as const;

/** The password every role the harness creates logs in with. Disposable by definition. */
export const HARNESS_PASSWORD = "disposable";

export interface DisposableDatabase {
  readonly adminUrl: string;
  readonly database: string;
  /** A URL for another role against the same database. */
  urlFor(role: string): string;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  destroy(): Promise<void>;
}

/** Refuse anything that is not a loopback, non-Supabase target. */
export function assertDisposableTarget(url: string): void {
  for (const ref of FORBIDDEN_TARGET_REFS) {
    if (url.includes(ref)) {
      throw new Error(`disposable harness refused: target names the forbidden project ref ${ref}`);
    }
  }
  if (/supabase\.(co|com)/i.test(url)) {
    throw new Error("disposable harness refused: target is a hosted Supabase endpoint");
  }
  const host = new URL(url).hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error("disposable harness refused: target is not a loopback address");
  }
}

/**
 * Where a PostgreSQL binary lives, on this machine.
 *
 * Two spellings of every name, because Windows spells an executable
 * `initdb.exe` and POSIX spells it `initdb` — and one lookup per platform,
 * because `sh -c "command -v"` under Git Bash answers with a POSIX path
 * (`/c/Users/...`) that `execFileSync` cannot spawn. That is not a missing
 * binary but it fails as one, so every gate that needs a disposable cluster was
 * unrunnable on Windows with PostgreSQL installed and on PATH.
 */
function binary(name: string): string | null {
  const names = process.platform === "win32" ? [`${name}.exe`, name] : [name];
  const dir = process.env.FORMA_PG_BINDIR;
  if (dir) {
    for (const candidate of names) {
      if (existsSync(join(dir, candidate))) return join(dir, candidate);
    }
  }
  const found =
    process.platform === "win32"
      ? spawnSync("where", [name], { encoding: "utf8", shell: true })
      : spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
  // `where` lists every match, one per line; take the first that exists.
  for (const line of (found.stdout ?? "").split(/\r?\n/)) {
    const path = line.trim();
    if (path.length > 0 && existsSync(path)) return path;
  }
  return null;
}

interface Cluster {
  url: string;
  stop(): void;
}

let clusterCount = 0;

function startLocalCluster(): Cluster {
  const initdb = binary("initdb");
  const pgCtl = binary("pg_ctl");
  if (!initdb || !pgCtl) {
    throw new Error(
      "no disposable PostgreSQL available: set FORMA_TEST_DATABASE_URL, or put initdb/pg_ctl on PATH or in FORMA_PG_BINDIR",
    );
  }
  const workdir = mkdtempSync(join(tmpdir(), "forma-e02-"));
  const data = join(workdir, "data");
  const socket = join(workdir, "socket");
  mkdirSync(socket, { recursive: true });
  execFileSync(initdb, ["-D", data, "-U", "postgres", "-A", "trust", "--no-sync", "-E", "UTF8"], {
    stdio: "pipe",
  });
  clusterCount += 1;
  const port = 55_000 + ((process.pid * 7 + clusterCount * 101) % 4_000);
  const logfile = join(workdir, "server.log");
  try {
    execFileSync(
      pgCtl,
      [
        "-D",
        data,
        "-o",
        `-p ${port} -k ${socket} -c listen_addresses=127.0.0.1 -c fsync=off -c full_page_writes=off`,
        "-w",
        "-l",
        logfile,
        "start",
      ],
      /*
       * `ignore`, not `pipe`, and the difference is the whole gate on Windows.
       *
       * `pg_ctl start` exits as soon as the server is up, but the server it
       * started inherits the stdio handles it was given. With pipes, those
       * handles stay open for as long as the *server* runs, and `execFileSync`
       * waits for end-of-file on them — so the call never returned, the cluster
       * sat there accepting connections nobody made, and every gate that needs
       * a disposable database hung before its first query with no output and no
       * error. The server's own output is already going to `logfile`, which is
       * what the failure path below reads, so nothing is lost by discarding
       * these.
       */
      { stdio: "ignore" },
    );
  } catch (error) {
    // pg_ctl's own message is "examine the log output"; do that for the caller
    // rather than making them reconstruct a destroyed scratch directory.
    let log = "(no server log was written)";
    try {
      log = readFileSync(logfile, "utf8").trim().split("\n").slice(-6).join("\n");
    } catch {
      /* the log is the best-effort part of the error, not the error */
    }
    rmSync(workdir, { recursive: true, force: true });
    throw new Error(`disposable cluster failed to start on port ${port}:\n${log}`, { cause: error });
  }
  return {
    url: `postgresql://postgres@127.0.0.1:${port}/postgres`,
    stop() {
      try {
        execFileSync(pgCtl, ["-D", data, "-m", "immediate", "stop"], { stdio: "pipe" });
      } finally {
        rmSync(workdir, { recursive: true, force: true });
      }
    },
  };
}

let counter = 0;

/** Create a disposable database. The caller must `destroy()` it. */
export async function createDisposableDatabase(): Promise<DisposableDatabase> {
  let cluster: Cluster | null = null;
  const base = process.env.FORMA_TEST_DATABASE_URL ?? (cluster = startLocalCluster()).url;
  try {
    assertDisposableTarget(base);
  } catch (error) {
    cluster?.stop();
    throw error;
  }

  const database = `forma_e02_${process.pid}_${++counter}`;
  const admin = postgres(base, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await admin.unsafe(`create database ${database}`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  const adminUrl = new URL(base);
  adminUrl.pathname = `/${database}`;
  const client = postgres(adminUrl.toString(), { max: 2, prepare: false, onnotice: () => {} });

  for (const role of SUPABASE_ROLES) {
    await client.unsafe(`do $$
      begin
        if not exists (select 1 from pg_roles where rolname = '${role}') then
          create role ${role} nologin noinherit;
        end if;
      end $$`);
    // Supabase grants its browser roles usage on `public` and re-grants every
    // new table to them by default. Recreating that is what makes the exclusion
    // assertions meaningful rather than tautological.
    await client.unsafe(`grant usage on schema public to ${role}`);
    await client.unsafe(`alter default privileges in schema public grant all on tables to ${role}`);
    await client.unsafe(`alter role ${role} with login password '${HARNESS_PASSWORD}'`);
  }

  return {
    adminUrl: adminUrl.toString(),
    database,
    urlFor(role: string): string {
      const url = new URL(adminUrl.toString());
      url.username = role;
      url.password = HARNESS_PASSWORD;
      return url.toString();
    },
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      return (await client.unsafe(sql, params as never)) as unknown as T[];
    },
    async destroy(): Promise<void> {
      await client.end({ timeout: 5 });
      if (cluster) {
        cluster.stop();
        return;
      }
      const drop = postgres(base, { max: 1, prepare: false, onnotice: () => {} });
      try {
        await drop.unsafe(`drop database if exists ${database} with (force)`);
      } finally {
        await drop.end({ timeout: 5 });
      }
    },
  };
}

/** Give the contract roles a login password so the gate can connect as them. */
export async function grantRolePasswords(
  db: DisposableDatabase,
  roles: readonly string[],
): Promise<void> {
  for (const role of roles) {
    await db.query(`alter role ${role} with login password '${HARNESS_PASSWORD}'`);
  }
}

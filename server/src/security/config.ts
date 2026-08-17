/**
 * Runtime database configuration for E01.
 *
 * The deployed API is only allowed to reach Postgres as the named
 * least-privilege role, over the Supavisor pooled endpoint, with an explicit
 * role marker. Everything here is fail-closed: a configuration that cannot be
 * proven correct is rejected before the process serves traffic.
 *
 * Nothing in this module ever returns, logs, or embeds the connection string or
 * its password. Findings name the field that failed, not the value that failed.
 */

import {
  MIGRATOR_ROLE,
  OWNER_ROLE,
  PRODUCTION,
  ROLE_MARKER_ENV,
  DEPLOYMENT_ROLES,
  RUNTIME_ROLE,
  isDeploymentRole,
} from "./contract.js";

/** A blocking configuration finding. `message` is safe to log verbatim. */
export interface ConfigFinding {
  code: string;
  message: string;
}

export class RuntimeConfigError extends Error {
  constructor(readonly findings: readonly ConfigFinding[]) {
    super(`runtime database configuration rejected: ${findings.map((f) => f.code).join(", ")}`);
    this.name = "RuntimeConfigError";
  }
}

/**
 * A connection description with every secret-bearing field removed. This is the
 * only shape allowed to leave the module, so nothing downstream can accidentally
 * serialize a credential.
 */
export interface SafeConnection {
  /** The Postgres role, with any Supavisor tenant suffix stripped. */
  baseRole: string;
  /** The Supavisor tenant (project ref), when the username carries one. */
  projectRef: string | null;
  host: string;
  port: number;
  database: string;
  /** True when the username used the pooled `role.tenant` form. */
  pooledUsername: boolean;
}

/**
 * Split a Supavisor username. `forma_api.oqsjfmgdovvepncbphvk` and plain
 * `forma_api` both resolve to the same base role; the tenant suffix is a pooler
 * routing detail, not an identity.
 */
export function parsePooledUsername(username: string): {
  baseRole: string;
  projectRef: string | null;
} {
  const separator = username.indexOf(".");
  if (separator <= 0) return { baseRole: username, projectRef: null };
  return {
    baseRole: username.slice(0, separator),
    projectRef: username.slice(separator + 1) || null,
  };
}

/**
 * Parse a Postgres URL into its non-secret parts.
 *
 * Throws on anything that is not a Postgres URL. The error deliberately does not
 * echo the input: a malformed `DATABASE_URL` is frequently malformed because it
 * still contains a live password.
 */
export function parseConnection(url: string): SafeConnection {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RuntimeConfigError([
      { code: "DATABASE_URL_MALFORMED", message: "DATABASE_URL is not a valid URL" },
    ]);
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new RuntimeConfigError([
      {
        code: "DATABASE_URL_NOT_POSTGRES",
        message: "DATABASE_URL is not a postgres:// or postgresql:// URL",
      },
    ]);
  }
  const username = decodeURIComponent(parsed.username);
  if (!username) {
    throw new RuntimeConfigError([
      { code: "DATABASE_URL_NO_ROLE", message: "DATABASE_URL carries no database role" },
    ]);
  }
  const { baseRole, projectRef } = parsePooledUsername(username);
  const port = parsed.port ? Number(parsed.port) : 5432;
  const database = parsed.pathname.replace(/^\//, "") || "postgres";
  return {
    baseRole,
    projectRef,
    host: parsed.hostname,
    port,
    database,
    pooledUsername: projectRef !== null,
  };
}

/** The environment fields E01 reads. Passed explicitly so tests never mutate `process.env`. */
export interface RuntimeEnv {
  DATABASE_URL?: string;
  DATABASE_ROLE?: string;
  FORMA_ENV?: string;
  K_SERVICE?: string;
}

/**
 * Deployed means "running as the Cloud Run service". Local development is held
 * to the role and marker rules too, but only the deployed path enforces the
 * pooled port, because a disposable local database has no Supavisor in front of
 * it unless the rehearsal harness puts one there.
 */
export function isDeployed(env: RuntimeEnv): boolean {
  return env.FORMA_ENV === "production" || Boolean(env.K_SERVICE);
}

/**
 * Every blocking reason this configuration must not start. An empty array is the
 * only acceptable result for a deployed process.
 */
export function inspectRuntimeConfig(env: RuntimeEnv): ConfigFinding[] {
  const findings: ConfigFinding[] = [];
  const url = env.DATABASE_URL;
  if (!url) {
    return [{ code: "DATABASE_URL_MISSING", message: "DATABASE_URL is not set" }];
  }

  let connection: SafeConnection;
  try {
    connection = parseConnection(url);
  } catch (error) {
    if (error instanceof RuntimeConfigError) return [...error.findings];
    return [{ code: "DATABASE_URL_MALFORMED", message: "DATABASE_URL could not be parsed" }];
  }

  if (connection.baseRole === OWNER_ROLE) {
    findings.push({
      code: "DATABASE_ROLE_IS_OWNER",
      message: `DATABASE_URL connects as the owner role; only ${RUNTIME_ROLE} may serve requests`,
    });
  } else if (connection.baseRole === MIGRATOR_ROLE) {
    findings.push({
      code: "DATABASE_ROLE_IS_MIGRATOR",
      message: `DATABASE_URL connects as ${MIGRATOR_ROLE}; only ${RUNTIME_ROLE} may serve requests`,
    });
  } else if (!isDeploymentRole(connection.baseRole)) {
    findings.push({
      code: "DATABASE_ROLE_UNKNOWN",
      message: `DATABASE_URL connects as an unrecognised role; only ${DEPLOYMENT_ROLES.join(", ")} may serve requests`,
    });
  }

  if (isDeployed(env) && connection.port !== PRODUCTION.poolerPort) {
    findings.push({
      code: "DATABASE_PORT_NOT_POOLED",
      message: `DATABASE_URL must use the Supavisor pooled port ${PRODUCTION.poolerPort}`,
    });
  }

  const marker = env[ROLE_MARKER_ENV as "DATABASE_ROLE"];
  if (!marker) {
    findings.push({
      code: "DATABASE_ROLE_MARKER_MISSING",
      message: `${ROLE_MARKER_ENV} is not set; it must name this deployment's role`,
    });
  } else if (!isDeploymentRole(marker)) {
    findings.push({
      code: "DATABASE_ROLE_MARKER_MISMATCH",
      message: `${ROLE_MARKER_ENV} is not one of ${DEPLOYMENT_ROLES.join(", ")}`,
    });
  } else if (findings.length === 0 && marker !== connection.baseRole) {
    findings.push({
      code: "DATABASE_ROLE_MARKER_DISAGREES",
      message: `${ROLE_MARKER_ENV} does not match the role in DATABASE_URL`,
    });
  }

  return findings;
}

/**
 * Fail-closed startup gate. Returns the safe connection description or throws
 * before the process can serve a single request.
 */
export function assertRuntimeConfig(env: RuntimeEnv): SafeConnection {
  const findings = inspectRuntimeConfig(env);
  if (findings.length > 0) throw new RuntimeConfigError(findings);
  return parseConnection(env.DATABASE_URL!);
}

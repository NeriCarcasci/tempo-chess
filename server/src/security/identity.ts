/**
 * The private runtime identity check.
 *
 * `GET /health` proves the process is alive. It deliberately proves nothing
 * about the database, because a liveness probe that depends on Postgres turns a
 * database blip into a rollback. Identity is a separate, private check: it runs
 * the one statement that can distinguish "connected as the least-privilege role"
 * from "connected as the owner", and it fails closed.
 *
 * There is no route for it. E01 adds no public readiness or identity endpoint;
 * the only caller outside startup is the internal test hook at the bottom of
 * this file.
 */

import { MAX_PROBE_TIMEOUT_SECONDS, RUNTIME_ROLE } from "./contract.js";

/** The narrowest thing that can answer `select current_user`. */
export type CurrentUserQuery = () => Promise<unknown>;

export class RuntimeIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeIdentityError";
  }
}

function readCurrentUser(rows: unknown): string {
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new RuntimeIdentityError("identity query did not return exactly one row");
  }
  const row = rows[0] as Record<string, unknown>;
  const value = row.current_user ?? row.currentUser ?? Object.values(row)[0];
  if (typeof value !== "string" || value.length === 0) {
    throw new RuntimeIdentityError("identity query returned no current_user value");
  }
  return value;
}

/**
 * Resolve the connected role, or throw. A timeout, a transport error, or an
 * unreadable result is a failure — never an assumption that identity is fine.
 */
export async function verifyRuntimeIdentity(
  query: CurrentUserQuery,
  timeoutMs = MAX_PROBE_TIMEOUT_SECONDS * 1000,
): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new RuntimeIdentityError("identity query timed out")),
      timeoutMs,
    );
  });
  let rows: unknown;
  try {
    rows = await Promise.race([query(), deadline]);
  } catch (error) {
    if (error instanceof RuntimeIdentityError) throw error;
    // The underlying driver message may carry the connection string. It never
    // travels further than this line.
    throw new RuntimeIdentityError("identity query failed");
  } finally {
    if (timer) clearTimeout(timer);
  }
  const currentUser = readCurrentUser(rows);
  if (currentUser !== RUNTIME_ROLE) {
    throw new RuntimeIdentityError(
      `runtime connected as an unexpected role; only ${RUNTIME_ROLE} may serve requests`,
    );
  }
  return currentUser;
}

/**
 * Internal test hook. Exported for the E01 gates only: it is not routed, not
 * re-exported from the app, and not reachable over HTTP.
 */
export const __e01InternalIdentityHook = {
  verifyRuntimeIdentity,
} as const;

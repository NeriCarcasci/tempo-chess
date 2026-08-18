import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";
import { assertRuntimeConfig } from "../security/config.js";
import { resolveDeployment } from "../platform/deployment.js";
import { verifyRuntimeIdentity } from "../security/identity.js";
import { poolOptionsFor } from "../platform/connection.js";

/**
 * The runtime database handle.
 *
 * E01 makes this a gate rather than a getter: the process refuses to start
 * unless the configuration proves it will connect as the named least-privilege
 * role, over the pooled endpoint when deployed, with the role marker present.
 * A misconfigured process that starts and serves is exactly how the owner
 * credential ended up on the request path.
 *
 * The rejection carries field names only. Neither the URL nor its password is
 * logged, returned, or attached to the error.
 */
const connection = assertRuntimeConfig(process.env);

// Supabase poolers (transaction mode) don't support prepared statements, and
// the pool size comes from the aggregate connection budget rather than the
// driver default: an unbounded pool per instance is how a scaled-out service
// exhausts the database for every other service.
// Each deployment pools to its own budgeted size. Hardcoding forma-api's pool
// gave every service the API's 3 connections per instance, so forma-stockfish
// at 6 instances would have held 18 rather than the 6 it is budgeted — the
// exact over-allocation the budget exists to prevent.
const deployment = resolveDeployment(process.env);
const client = postgres(
  process.env.DATABASE_URL!,
  poolOptionsFor(deployment?.name ?? "forma-api"),
);

export const db = drizzle(client, { schema });
export { schema };
export { client };
export { connection };

/**
 * Prove the connected identity. Private by design: this is not `/health`, it is
 * not a route, and it fails closed rather than reporting a degraded state.
 */
export async function assertRuntimeIdentity(): Promise<string> {
  // Each deployment proves it is its own role. Before E05 this was always
  // forma_api, which is correct for the API and impossible for a worker.
  return verifyRuntimeIdentity(
    () => client`select current_user`,
    undefined,
    deployment?.databaseRole,
  );
}

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";
import { assertRuntimeConfig } from "../security/config.js";
import { verifyRuntimeIdentity } from "../security/identity.js";

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

// Supabase poolers (transaction mode) don't support prepared statements.
const client = postgres(process.env.DATABASE_URL!, { prepare: false });

export const db = drizzle(client, { schema });
export { schema };
export { client };
export { connection };

/**
 * Prove the connected identity. Private by design: this is not `/health`, it is
 * not a route, and it fails closed rather than reporting a degraded state.
 */
export async function assertRuntimeIdentity(): Promise<string> {
  return verifyRuntimeIdentity(() => client`select current_user`);
}

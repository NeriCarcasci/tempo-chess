/**
 * A disposable database with every migration applied, for the E11 gates.
 *
 * Thin on purpose: E02 already owns creating a production-shaped cluster and
 * applying the committed migrations, so this adds only the connections the
 * analysis gates need and the teardown that always runs.
 *
 * The owner connection is the one the integration and performance gates use.
 * That is deliberate rather than lax: those gates are about behaviour under
 * concurrency, idempotency and immutability, and the triggers that enforce
 * immutability apply to every role including this one. Tenancy is a different
 * claim and is proven by the security gate, which connects as the real
 * least-privilege roles with a bound actor — the only way that claim means
 * anything.
 *
 * It never targets the live project: `createDisposableDatabase` refuses a
 * non-loopback target, and this gate creates roles and logs in with a synthetic
 * password, which is exactly what must not reach a hosted database.
 */

import postgres, { type Sql } from "postgres";
import {
  createDisposableDatabase,
  grantRolePasswords,
  type DisposableDatabase,
} from "../../platform/harness/postgres.js";
import { applyMigrations } from "../../platform/harness/migrations.js";
import { DEPLOYMENT_ROLES } from "../../security/contract.js";

export { GateReport } from "../../v1/gates/harness.js";

export interface AnalysisHarness {
  db: DisposableDatabase;
  /** Owner connection: schema-shaped work and fixture seeding. */
  sql: Sql;
  /** A connection as a named deployment role. Caller must not close it. */
  as(role: string): Sql;
  destroy(): Promise<void>;
}

export async function startAnalysisHarness(): Promise<AnalysisHarness> {
  const db = await createDisposableDatabase();
  try {
    await applyMigrations(db.adminUrl);
    await grantRolePasswords(db, DEPLOYMENT_ROLES);
    const sql = postgres(db.adminUrl, { max: 4, prepare: false, onnotice: () => {} });
    const roleConnections = new Map<string, Sql>();
    return {
      db,
      sql,
      as(role: string): Sql {
        const existing = roleConnections.get(role);
        if (existing) return existing;
        const connection = postgres(db.urlFor(role), { max: 2, prepare: false, onnotice: () => {} });
        roleConnections.set(role, connection);
        return connection;
      },
      async destroy(): Promise<void> {
        for (const connection of roleConnections.values()) {
          await connection.end({ timeout: 5 }).catch(() => {});
        }
        await sql.end({ timeout: 5 }).catch(() => {});
        await db.destroy();
      },
    };
  } catch (error) {
    await db.destroy();
    throw error;
  }
}

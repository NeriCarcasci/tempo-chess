/**
 * The migration entrypoint for the `forma-migrate` Cloud Run Job.
 *
 * `npm run db:migrate` uses drizzle-kit, which is a devDependency and is not in
 * the production image — the image is built `npm ci --omit=dev` and ships only
 * `dist`. Rather than ship a second image or promote a build tool into runtime
 * dependencies, this uses drizzle-orm's own migrator, which is already a
 * production dependency and reads the same `drizzle/` folder and the same
 * `__drizzle_migrations` ledger, so a migration applied here is indistinguishable
 * from one applied locally.
 *
 * Deliberately standalone: it does not import `db/client.js`, because that runs
 * the runtime startup gates, and those require a *deployment* role. The migrator
 * is not a deployment role and never serves a request.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set; the migration job has nothing to connect to");
  process.exit(1);
}

/** Migrations take DDL locks; one connection, and never a prepared statement. */
const client = postgres(url, { max: 1, prepare: false });

try {
  const [{ who }] = await client<{ who: string }[]>`select current_user as who`;
  const before = await client<{ n: number }[]>`
    select count(*)::int as n from drizzle.__drizzle_migrations
  `.catch(() => [{ n: 0 }]);
  console.log(`connected as ${who}; ledger holds ${before[0].n} migrations`);

  await migrate(drizzle(client), { migrationsFolder: "drizzle" });

  const after = await client<{ n: number }[]>`
    select count(*)::int as n from drizzle.__drizzle_migrations
  `;
  const applied = after[0].n - before[0].n;
  console.log(
    applied === 0
      ? `no new migrations; ledger still holds ${after[0].n}`
      : `applied ${applied} migration(s); ledger now holds ${after[0].n}`,
  );
} catch (error) {
  // The driver's message can carry the connection string. It stops here.
  console.error("migration failed:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
} finally {
  await client.end({ timeout: 5 });
}

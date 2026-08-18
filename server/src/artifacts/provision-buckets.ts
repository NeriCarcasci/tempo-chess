/**
 * `npm run artifacts:buckets` — create the three private buckets.
 *
 * Bucket creation is infrastructure rather than schema, so it is not a
 * migration: `storage.buckets` is Supabase's table, and `forma_migrator` holds
 * no privilege on it by design. This runs as the deploying owner, is
 * idempotent, and refuses to make a bucket public.
 *
 * There is no public bucket. Every body is reached through a short-lived signed
 * URL issued after an authorization check, which is the whole point of E07.
 */

import postgres from "postgres";
import { BUCKETS, BUCKET_FOR_RETENTION, RETENTION_CLASSES } from "./contract.js";

/** Bodies are PGN, JSON reports and catalogue assets, not media. */
const FILE_SIZE_LIMITS: Readonly<Record<string, number>> = {
  "subject-artifacts": 64 * 1024 * 1024,
  "system-artifacts": 256 * 1024 * 1024,
  exports: 512 * 1024 * 1024,
};

const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });

// Every retention class must land in a bucket that exists.
for (const retention of RETENTION_CLASSES) {
  const bucket = BUCKET_FOR_RETENTION[retention];
  if (!(BUCKETS as readonly string[]).includes(bucket)) {
    throw new Error(`${retention} maps to unknown bucket ${bucket}`);
  }
}

for (const bucket of BUCKETS) {
  await sql`
    insert into storage.buckets (id, name, public, file_size_limit)
    values (${bucket}, ${bucket}, false, ${FILE_SIZE_LIMITS[bucket]})
    on conflict (id) do update set public = false, file_size_limit = ${FILE_SIZE_LIMITS[bucket]}
  `;
}

const rows = await sql<{ id: string; public: boolean; file_size_limit: number | null }[]>`
  select id, public, file_size_limit from storage.buckets where id = any(${[...BUCKETS]}) order by id
`;

let failures = 0;
for (const row of rows) {
  const mib = row.file_size_limit ? `${Math.round(row.file_size_limit / 1024 / 1024)} MiB` : "no limit";
  if (row.public) {
    console.error(`FAIL ${row.id} is public`);
    failures += 1;
  } else {
    console.log(`ok   ${row.id} — private, ${mib}`);
  }
}

const publicAnywhere = await sql<{ n: number }[]>`
  select count(*)::int as n from storage.buckets where public
`;
if (publicAnywhere[0].n > 0) {
  console.error(`FAIL ${publicAnywhere[0].n} public bucket(s) exist in this project`);
  failures += 1;
}

await sql.end();
console.log(`\n${rows.length} bucket(s), ${failures} failure(s)`);
if (rows.length !== BUCKETS.length || failures > 0) process.exitCode = 1;

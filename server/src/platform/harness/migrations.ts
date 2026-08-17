/**
 * Apply the repository's committed migrations to a disposable database.
 *
 * This is not a second migration system: it calls Drizzle's own migrator on the
 * committed `server/drizzle` folder, which is the same code path
 * `npm run db:migrate` takes. The only extra ability is stopping at a chosen
 * tag, so the gate can build a production-shaped legacy database that is
 * exactly the state 0011 left behind.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/** The committed migration folder: the one migration authority. */
export const MIGRATIONS_FOLDER = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "drizzle",
);

interface Journal {
  /** `when` is the journal timestamp Drizzle compares the ledger against. */
  entries: { idx: number; tag: string; when: number }[];
}

export function journal(): Journal {
  return JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as Journal;
}

/**
 * A copy of the migration folder whose journal stops after `throughTag`.
 * Returns the committed folder itself when no truncation is needed.
 */
function folderThrough(throughTag: string | undefined): { folder: string; cleanup: () => void } {
  if (!throughTag) return { folder: MIGRATIONS_FOLDER, cleanup: () => {} };
  const entries = journal().entries;
  const cut = entries.findIndex((entry) => entry.tag === throughTag);
  if (cut < 0) throw new Error(`no migration tagged ${throughTag}`);
  if (cut === entries.length - 1) return { folder: MIGRATIONS_FOLDER, cleanup: () => {} };
  const scratch = mkdtempSync(join(tmpdir(), "forma-e02-migrations-"));
  cpSync(MIGRATIONS_FOLDER, scratch, { recursive: true });
  const truncated = { ...journal(), entries: entries.slice(0, cut + 1) };
  writeFileSync(join(scratch, "meta", "_journal.json"), JSON.stringify(truncated, null, 2));
  return { folder: scratch, cleanup: () => rmSync(scratch, { recursive: true, force: true }) };
}

/** Run `drizzle-kit migrate`'s code path against `url`. */
export async function applyMigrations(url: string, throughTag?: string): Promise<void> {
  const { folder, cleanup } = folderThrough(throughTag);
  const client = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await migrate(drizzle(client), { migrationsFolder: folder });
  } finally {
    await client.end({ timeout: 5 });
    cleanup();
  }
}

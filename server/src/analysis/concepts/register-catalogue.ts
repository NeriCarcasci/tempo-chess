/**
 * `npm run concepts:register` — put the catalogue in the database, and nothing
 * else.
 *
 * `analysis:promote` already does this, but it does it as one step of a much
 * larger claim: it probes the engine on this machine, registers component
 * versions, runs the committed benchmark corpus through real Stockfish and
 * promotes recipes against the result. All of that is right when the *method*
 * changes. None of it is what happens when the catalogue gains a concept.
 *
 * Registering a concept is still a claim about what Forma says it can see, so
 * this is an operator command a person runs on purpose rather than something a
 * container does when it boots. It is simply a much narrower one than promoting
 * an analysis method, and running the wide command to achieve the narrow effect
 * would re-promote recipes as a side effect of adding a detector.
 *
 * ## What it will and will not do
 *
 * It inserts concepts and concept versions that are missing, and reports what it
 * found. It never updates a version row: a version is what a season of evidence
 * points at, and rewriting one in place would silently redefine every
 * observation already recorded against it. A stored rule that disagrees with
 * this build under the same version number is refused loudly and nothing is
 * written for it — that is a version somebody forgot to bump, and the fix is to
 * bump it rather than to overwrite history.
 *
 * Usage:
 *
 * ```bash
 * npm run concepts:register -- --dry-run   # report what would change
 * npm run concepts:register
 * ```
 */

import postgres from "postgres";
import { CONCEPT_CATALOGUE, conceptVersionHash } from "./catalogue.js";
import { registerCatalogue, summarizeRegistration } from "./register.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const dryRun = process.argv.slice(2).includes("--dry-run");
const unknown = process.argv.slice(2).filter((argument) => argument !== "--dry-run");
if (unknown.length > 0) {
  console.error(`unknown option ${unknown.join(", ")}`);
  process.exit(1);
}

const client = postgres(url, { max: 1, prepare: false });

try {
  if (dryRun) {
    // Read-only: what this build declares, against what is already stored.
    const stored = await client<{ slug: string; version_no: number; version_hash: string }[]>`
      select c.slug, cv.version_no, cv.version_hash
      from analysis.concepts c
      join analysis.concept_versions cv on cv.concept_id = c.id
    `;
    const have = new Map(stored.map((row) => [`${row.slug}@${row.version_no}`, row.version_hash]));
    let create = 0;
    let existing = 0;
    let conflicting = 0;
    for (const concept of CONCEPT_CATALOGUE) {
      const key = `${concept.slug}@${concept.versionNo}`;
      const storedHash = have.get(key);
      if (storedHash === undefined) {
        create += 1;
        console.log(`create    ${key}`);
      } else if (storedHash !== conceptVersionHash(concept)) {
        conflicting += 1;
        console.log(`CONFLICT  ${key} — the stored rule differs from this build`);
      } else {
        existing += 1;
      }
    }
    console.log(`dry run   ${create} to create, ${existing} already current, ${conflicting} conflicting`);
    process.exit(conflicting > 0 ? 1 : 0);
  }

  const registration = summarizeRegistration(await registerCatalogue(client));
  console.log(
    `concepts  ${registration.concepts.length} declared: ${registration.created} created, `
    + `${registration.existing} already current, ${registration.conflicting} conflicting`,
  );
  for (const concept of registration.concepts) {
    if (concept.outcome === "created") console.log(`created   ${concept.slug} @v${concept.versionNo}`);
  }

  const drifted = registration.concepts.filter((concept) => concept.hashMismatch);
  if (drifted.length > 0) {
    console.error(
      "these concepts changed their rule without a version bump: "
      + drifted.map((concept) => `${concept.slug} @v${concept.versionNo}`).join(", "),
    );
    process.exit(1);
  }
} finally {
  await client.end({ timeout: 5 });
}
process.exit(0);

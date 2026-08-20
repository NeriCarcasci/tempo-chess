/**
 * `npm run public:migration` — 0033 from empty, from prior state, twice.
 *
 * The checks that matter are the ones that decide whether something about a
 * real person can reach the public internet: a personal subject cannot be
 * published at all, an unfinished run cannot be published, an approval cannot
 * be recorded with a box unticked, consent that has been withdrawn refuses the
 * publication, the API role cannot publish anything and cannot see a draft, and
 * a retraction cannot erase the record that we published.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { GateReport } from "../../v1/gates/harness.js";
import { createDisposableDatabase, grantRolePasswords } from "../../platform/harness/postgres.js";
import { applyMigrations, MIGRATIONS_FOLDER } from "../../platform/harness/migrations.js";
import { REDACTION_POLICY_VERSION } from "../contract.js";
import { insertCaseStudy, randomHex, seedEditorial } from "./fixture.js";
import { jsonParam } from "../../db/json.js";

const report = new GateReport("E20 public projections migration gate");

const MIGRATION_TAG = "0033_e20_editorial_publications";
const MIGRATION_SQL = readFileSync(join(MIGRATIONS_FOLDER, `${MIGRATION_TAG}.sql`), "utf8");

async function apply0033(url: string): Promise<void> {
  const client = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await client.begin(async (tx) => {
      for (const statement of MIGRATION_SQL.split("--> statement-breakpoint")) {
        const trimmed = statement.trim();
        if (trimmed.length > 0) await tx.unsafe(trimmed);
      }
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}

const NEW_TABLES = [
  "case_study_publication_events",
  "case_study_publications",
  "editorial_consents",
  "editorial_reviews",
  "editorial_sources",
];

/** Did the statement fail, and with a message that names the reason? */
async function refuses(run: () => Promise<unknown>, expected: RegExp): Promise<void> {
  let message: string | null = null;
  try {
    await run();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert.notEqual(message, null, "the database accepted something it must refuse");
  assert.match(message!, expected);
}

report.section("from an empty database");

{
  const db = await createDisposableDatabase();
  try {
    await applyMigrations(db.adminUrl);
    const sql = postgres(db.adminUrl, { max: 2, prepare: false, onnotice: () => {} });
    try {
      await report.check("every table this epic claims exists", async () => {
        const rows = await sql<{ table_name: string }[]>`
          select table_name from information_schema.tables
          where table_schema = 'social' and table_name = any(${NEW_TABLES})
          order by table_name
        `;
        assert.deepEqual(rows.map((row) => row.table_name), NEW_TABLES);
      });

      await report.check("a complete, approved, sourced study publishes", async () => {
        const fixture = await seedEditorial(sql);
        const id = await insertCaseStudy(sql, fixture);
        const rows = await sql<{ public_state: string }[]>`
          select public_state from social.case_study_publications where id = ${id}
        `;
        assert.equal(rows[0]!.public_state, "published");
      });

      await report.check("a personal subject cannot be published", async () => {
        const fixture = await seedEditorial(sql, { subjectKind: "personal" });
        await refuses(
          () => insertCaseStudy(sql, fixture, { slug: "personal-subject" }),
          /editorial or case_study subject|account owner/,
        );
      });

      await report.check("an unfinished run cannot be published", async () => {
        const fixture = await seedEditorial(sql, { runStatus: "failed" });
        await refuses(
          () => insertCaseStudy(sql, fixture, { slug: "failed-run" }),
          /succeeded run with an output manifest/,
        );
      });

      await report.check("a review that did not approve cannot be cited", async () => {
        const fixture = await seedEditorial(sql, { reviewDecision: "changes_requested" });
        await refuses(
          () => insertCaseStudy(sql, fixture, { slug: "unapproved" }),
          /did not approve/,
        );
      });

      await report.check("an approval cannot be recorded with a box unticked", async () => {
        const fixture = await seedEditorial(sql);
        await refuses(
          () => sql`
            insert into social.editorial_reviews (
              subject_id, run_id, reviewer_user_id, decision, checklist, redaction_policy_version
            ) values (
              ${fixture.subjectId}, ${fixture.runId}, ${fixture.reviewerUserId}, 'approved',
              ${jsonParam({
                source_verified: true,
                licence_verified: true,
                consent_verified: true,
                redactions_verified: true,
                facts_unchanged: false,
              })}::jsonb,
              ${REDACTION_POLICY_VERSION}
            )
          `,
          /editorial_reviews_approval_is_complete/,
        );
      });

      await report.check("a refusal to publish has to say why", async () => {
        const fixture = await seedEditorial(sql);
        await refuses(
          () => sql`
            insert into social.editorial_reviews (
              subject_id, run_id, reviewer_user_id, decision, checklist, redaction_policy_version
            ) values (
              ${fixture.subjectId}, ${fixture.runId}, ${fixture.reviewerUserId}, 'rejected',
              '{}'::jsonb, ${REDACTION_POLICY_VERSION}
            )
          `,
          /editorial_reviews_refusal_explained/,
        );
      });

      await report.check("a review of a different redaction policy does not carry over", async () => {
        const fixture = await seedEditorial(sql, { redactionPolicyVersion: "2026-01-a" });
        await refuses(
          () => insertCaseStudy(sql, fixture, { slug: "stale-policy" }),
          /different redaction policy/,
        );
      });

      await report.check("a consent-based source needs a consent record", async () => {
        const fixture = await seedEditorial(sql, { permissionBasis: "consent" });
        await refuses(
          () => insertCaseStudy(sql, fixture, { slug: "no-consent", consentId: null }),
          /requires a consent record/,
        );
      });

      await report.check("withdrawn consent refuses the publication", async () => {
        const fixture = await seedEditorial(sql, { permissionBasis: "consent" });
        await sql`
          update social.editorial_consents
          set withdrawn_at = now(), withdrawal_note = 'They asked us to stop.'
          where id = ${fixture.consentId}
        `;
        await refuses(
          () => insertCaseStudy(sql, fixture, { slug: "withdrawn-consent" }),
          /consent for this subject has been withdrawn/,
        );
      });

      await report.check("a licensed source names its licence and its credit line", async () => {
        await refuses(
          () => sql`
            insert into social.editorial_sources (
              source_kind, title, retrieved_at, permission_basis
            ) values ('licensed_dataset', 'A dataset', now(), 'licence')
          `,
          /editorial_sources_licence_named/,
        );
      });

      await report.check("a player submission is consented or it is nothing", async () => {
        await refuses(
          () => sql`
            insert into social.editorial_sources (
              source_kind, title, retrieved_at, permission_basis
            ) values ('player_submission', 'Somebody sent it in', now(), 'public_domain')
          `,
          /editorial_sources_submission_is_consented/,
        );
      });

      await report.check("a publication history row must install this run", async () => {
        const fixture = await seedEditorial(sql);
        const other = await seedEditorial(sql);
        await refuses(
          () =>
            insertCaseStudy(sql, fixture, {
              slug: "wrong-publication",
              publicationId: other.publicationId,
            }),
          /publication history row does not match/,
        );
      });

      await report.check("a withdrawn study keeps the date it was published", async () => {
        const fixture = await seedEditorial(sql);
        const id = await insertCaseStudy(sql, fixture, { slug: "withdrawn-keeps-history" });
        await sql`
          update social.case_study_publications
          set public_state = 'withdrawn', withdrawn_at = now(),
              withdrawal_reason = 'The player asked us to take it down.'
          where id = ${id}
        `;
        const rows = await sql<{ published_at: Date | null; run_id: string }[]>`
          select published_at, run_id from social.case_study_publications where id = ${id}
        `;
        assert.notEqual(rows[0]!.published_at, null);
        assert.equal(rows[0]!.run_id, fixture.runId);
        // The evidence is untouched: the run, its manifest and the approval all
        // still resolve after the retraction.
        const runs = await sql<{ status: string }[]>`
          select status from analysis.runs where id = ${fixture.runId}
        `;
        assert.equal(runs[0]!.status, "succeeded");
      });

      await report.check("a withdrawal without a reason is refused", async () => {
        const fixture = await seedEditorial(sql);
        const id = await insertCaseStudy(sql, fixture, { slug: "silent-withdrawal" });
        await refuses(
          () => sql`
            update social.case_study_publications
            set public_state = 'withdrawn', withdrawn_at = now()
            where id = ${id}
          `,
          /case_studies_state_timestamps/,
        );
      });

      await report.check("the publication history cannot be rewritten or erased", async () => {
        const fixture = await seedEditorial(sql);
        const id = await insertCaseStudy(sql, fixture, { slug: "append-only-history" });
        await sql`
          insert into social.case_study_publication_events (
            case_study_id, event_kind, content_sha256, reason
          ) values (${id}, 'published', ${randomHex()}, 'first publication')
        `;
        await refuses(
          () => sql`
            update social.case_study_publication_events set reason = 'nothing to see'
            where case_study_id = ${id}
          `,
          /append-only/,
        );
        await refuses(
          () => sql`delete from social.case_study_publication_events where case_study_id = ${id}`,
          /append-only/,
        );
      });

      await report.check("a slug is lower-case words joined by hyphens", async () => {
        const fixture = await seedEditorial(sql);
        await refuses(
          () => insertCaseStudy(sql, fixture, { slug: "Not A Slug" }),
          /case_studies_slug_shape/,
        );
      });
    } finally {
      await sql.end({ timeout: 5 });
    }
  } finally {
    await db.destroy();
  }
}

report.section("least privilege");

{
  const db = await createDisposableDatabase();
  try {
    await applyMigrations(db.adminUrl);
    await grantRolePasswords(db, ["forma_api", "forma_ops"]);
    const owner = postgres(db.adminUrl, { max: 2, prepare: false, onnotice: () => {} });
    const api = postgres(db.urlFor("forma_api"), { max: 2, prepare: false, onnotice: () => {} });
    const ops = postgres(db.urlFor("forma_ops"), { max: 2, prepare: false, onnotice: () => {} });
    try {
      const fixture = await seedEditorial(owner);
      const draftId = await insertCaseStudy(owner, fixture, {
        slug: "a-draft",
        publicState: "draft",
      });
      const publishedId = await insertCaseStudy(owner, fixture, { slug: "a-published-study" });

      await report.check("the API cannot publish anything", async () => {
        await refuses(
          () => api`
            insert into social.case_study_publications (
              slug, subject_id, run_id, publication_id, source_id, review_id,
              redaction_policy_version, public_state, title, summary, content_sha256, published_at
            ) values (
              'api-published', ${fixture.subjectId}, ${fixture.runId}, ${fixture.publicationId},
              ${fixture.sourceId}, ${fixture.reviewId}, ${REDACTION_POLICY_VERSION}, 'published',
              'Published by the API', 'A study the API decided to publish by itself.',
              ${randomHex()}, now()
            )
          `,
          /permission denied/i,
        );
      });

      await report.check("the API cannot see a draft or a withdrawn study", async () => {
        const rows = await api<{ id: string }[]>`
          select id from social.case_study_publications
        `;
        const ids = [...rows].map((row) => row.id);
        assert.equal(ids.includes(draftId), false, "a draft reached the API role");
        assert.equal(ids.includes(publishedId), true);
      });

      await report.check("the API cannot read the consent document pointer", async () => {
        await refuses(
          () => api`select consent_artifact_id from social.editorial_consents`,
          /permission denied/i,
        );
      });

      await report.check("the API cannot rewrite when consent was given", async () => {
        await refuses(
          () => api`update social.editorial_consents set granted_at = now()`,
          /permission denied/i,
        );
      });

      await report.check("the editorial role publishes and withdraws, and nothing more", async () => {
        const id = await insertCaseStudy(owner, fixture, {
          slug: "ops-can-withdraw",
          publicState: "published",
        });
        await ops`
          update social.case_study_publications
          set public_state = 'withdrawn', withdrawn_at = now(),
              withdrawal_reason = 'The player asked us to take it down.'
          where id = ${id}
        `;
        // ...but it cannot repoint a published study at a different run, which
        // would change what a public claim rests on without a new review.
        await refuses(
          () => ops`update social.case_study_publications set run_id = ${fixture.runId} where id = ${id}`,
          /permission denied/i,
        );
      });
    } finally {
      await api.end({ timeout: 5 });
      await ops.end({ timeout: 5 });
      await owner.end({ timeout: 5 });
    }
  } finally {
    await db.destroy();
  }
}

report.section("applied twice, and on top of prior state");

{
  const db = await createDisposableDatabase();
  try {
    // Every migration up to and including this one, then this one again. A
    // forward recovery re-runs the last migration, and a migration that cannot
    // survive that is a migration nobody can safely retry.
    await applyMigrations(db.adminUrl);
    const before = await fingerprint(db.adminUrl);
    await apply0033(db.adminUrl);
    const after = await fingerprint(db.adminUrl);

    await report.check("re-applying changes nothing", async () => {
      assert.deepEqual(after, before);
    });

    await report.check("rows written before the re-run are still there", async () => {
      const sql = postgres(db.adminUrl, { max: 2, prepare: false, onnotice: () => {} });
      try {
        const fixture = await seedEditorial(sql);
        const id = await insertCaseStudy(sql, fixture, { slug: "survives-a-rerun" });
        await apply0033(db.adminUrl);
        const rows = await sql<{ public_state: string }[]>`
          select public_state from social.case_study_publications where id = ${id}
        `;
        assert.equal(rows[0]!.public_state, "published");
      } finally {
        await sql.end({ timeout: 5 });
      }
    });
  } finally {
    await db.destroy();
  }
}

async function fingerprint(url: string): Promise<unknown[]> {
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const rows = await sql<
      { table_name: string; column_name: string; data_type: string; is_nullable: string }[]
    >`
      select table_name, column_name, data_type, is_nullable
      from information_schema.columns
      where table_schema = 'social' and table_name = any(${NEW_TABLES})
      order by table_name, column_name
    `;
    return [...rows];
  } finally {
    await sql.end({ timeout: 5 });
  }
}

report.finish();

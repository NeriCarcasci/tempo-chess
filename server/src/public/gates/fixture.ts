/**
 * The smallest real editorial publication, for the E20 gates.
 *
 * Everything a public case study has to resolve — an editorial subject, a
 * succeeded run under a pinned recipe, the publication history row that
 * installed it, a source with a permission basis, and an approval by a named
 * person — because the whole point of the epic is that a study cannot be
 * published without them. A fixture that stubbed any of it would be testing a
 * different system.
 */

import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { REDACTION_POLICY_VERSION } from "../contract.js";
import type { PermissionBasis } from "../contract.js";
import { jsonParam } from "../../db/json.js";

/** A distinct 64-hex string, so two seeded runs never collide on a hash. */
export function randomHex(): string {
  return (randomUUID() + randomUUID()).replace(/-/g, "");
}

/** Insert if it is not there, read it back if it is. Never update. */
async function findOrCreate(
  insert: postgres.PendingQuery<{ id: string }[]>,
  select: postgres.PendingQuery<{ id: string }[]>,
): Promise<{ id: string }> {
  const inserted = await insert;
  if (inserted.length > 0) return inserted[0]!;
  const existing = await select;
  return existing[0]!;
}

export interface EditorialFixture {
  reviewerUserId: string;
  subjectId: string;
  runId: string;
  publicationId: string;
  sourceId: string;
  reviewId: string;
  consentId: string | null;
}

export interface FixtureOptions {
  permissionBasis?: PermissionBasis;
  /** Recorded consent, when the source rests on one. */
  consent?: { scope?: "publish_analysis" | "publish_analysis_with_handle"; expiresAt?: Date | null };
  /** A run that is not fit to publish, for the negative cases. */
  runStatus?: "succeeded" | "failed";
  reviewDecision?: "approved" | "changes_requested" | "rejected";
  redactionPolicyVersion?: string;
  subjectKind?: "editorial" | "case_study" | "personal";
}

export async function seedEditorial(
  sql: postgres.Sql,
  options: FixtureOptions = {},
): Promise<EditorialFixture> {
  const basis = options.permissionBasis ?? "public_domain";
  const subjectKind = options.subjectKind ?? "editorial";
  const runStatus = options.runStatus ?? "succeeded";
  const reviewDecision = options.reviewDecision ?? "approved";
  const policy = options.redactionPolicyVersion ?? REDACTION_POLICY_VERSION;

  const [reviewer] = await sql<{ user_id: string }[]>`
    insert into app.profiles (user_id) values (gen_random_uuid()) returning user_id
  `;
  const [subject] = await sql<{ id: string }[]>`
    insert into app.analysis_subjects (kind, owner_user_id, display_label)
    values (
      ${subjectKind},
      ${subjectKind === "personal" ? reviewer!.user_id : null},
      'Anderssen, 1851'
    )
    returning id
  `;
  // `on conflict do update` would be a no-op update, and `analysis.components`
  // refuses updates: a method change is a new row, which is E11's whole point.
  // So: insert, ignore a collision, and read back.
  const component = await findOrCreate(
    sql`
      insert into analysis.components (
        component_key, category, description, input_contract, output_contract
      ) values ('gate_editorial', 'estimator', 'A gate fixture.', 'a.v1', 'b.v1')
      on conflict (component_key) do nothing
      returning id
    `,
    sql`select id from analysis.components where component_key = 'gate_editorial'`,
  );
  const [version] = await sql<{ id: string }[]>`
    insert into analysis.component_versions (
      component_id, version, implementation_sha256, configuration, configuration_hash,
      content_hash, deterministic
    ) values (
      ${component.id}, ${randomHex().slice(0, 8)}, ${randomHex()}, '{}'::jsonb,
      ${randomHex()}, ${randomHex()}, true
    )
    returning id
  `;
  const [recipe] = await sql<{ id: string }[]>`
    insert into analysis.recipe_versions (
      recipe_key, version, run_type, input_schema_version, output_schema_version,
      required_artifacts, deterministic, manifest_sha256
    ) values (
      'gate_case_study', ${randomHex().slice(0, 8)}, 'subject_live', 'a.v1', 'b.v1',
      array['skill_estimates']::text[], true, ${randomHex()}
    )
    returning id
  `;
  await sql`
    insert into analysis.recipe_components (recipe_version_id, role, component_version_id)
    values (${recipe!.id}, 'estimator', ${version!.id})
  `;
  const cohort = await findOrCreate(
    sql`
      insert into analysis.cohort_definition_versions (
        cohort_key, version, definition, definition_hash
      ) values ('gate_cohort', '1', '{}'::jsonb, repeat('f', 64))
      on conflict (cohort_key, version) do nothing
      returning id
    `,
    sql`
      select id from analysis.cohort_definition_versions
      where cohort_key = 'gate_cohort' and version = '1'
    `,
  );
  const [snapshot] = await sql<{ id: string }[]>`
    insert into analysis.subject_data_snapshots (
      subject_id, cohort_definition_version_id, cutoff, snapshot_hash, game_count, under_covered
    ) values (${subject!.id}, ${cohort.id}, now(), ${randomHex()}, 0, true)
    returning id
  `;
  const [run] = await sql<{ id: string }[]>`
    insert into analysis.runs (
      run_type, recipe_version_id, subject_id, subject_data_snapshot_id, status,
      input_manifest_hash, output_manifest_hash, trigger_kind, actor_kind,
      started_at, completed_at, failure_class
    ) values (
      'subject_live', ${recipe!.id}, ${subject!.id}, ${snapshot!.id}, ${runStatus},
      ${randomHex()}, ${runStatus === "succeeded" ? randomHex() : null},
      'scheduled', 'system', now(), now(),
      ${runStatus === "failed" ? "permanent" : null}
    )
    returning id
  `;
  const [history] = await sql<{ id: string }[]>`
    insert into analysis.subject_live_publication_history (
      subject_id, run_id, reason, actor_kind
    ) values (${subject!.id}, ${run!.id}, 'first_publication', 'system')
    returning id
  `;

  const [source] = await sql<{ id: string }[]>`
    insert into social.editorial_sources (
      source_kind, title, publisher, source_url, retrieved_at, permission_basis,
      licence_key, licence_url, attribution_text
    ) values (
      ${basis === "consent" ? "player_submission" : "historic_archive"},
      'London 1851 game collection',
      'Public archive',
      'https://example.org/london-1851',
      ${basis === "own_material" || basis === "consent" ? null : new Date("2026-06-01T00:00:00Z")},
      ${basis},
      ${basis === "licence" ? "cc-by-4.0" : null},
      ${basis === "licence" ? "https://creativecommons.org/licenses/by/4.0/" : null},
      ${basis === "licence" ? "Games courtesy of the archive." : null}
    )
    returning id
  `;

  let consentId: string | null = null;
  if (basis === "consent") {
    const [consent] = await sql<{ id: string }[]>`
      insert into social.editorial_consents (
        subject_id, scope, granted_at, expires_at
      ) values (
        ${subject!.id},
        ${options.consent?.scope ?? "publish_analysis_with_handle"},
        now() - interval '1 day',
        ${options.consent?.expiresAt ?? null}
      )
      returning id
    `;
    consentId = consent!.id;
  }

  const [review] = await sql<{ id: string }[]>`
    insert into social.editorial_reviews (
      subject_id, run_id, reviewer_user_id, decision, checklist,
      redaction_policy_version, note
    ) values (
      ${subject!.id}, ${run!.id}, ${reviewer!.user_id}, ${reviewDecision},
      ${jsonParam(reviewDecision === "approved"
          ? {
              source_verified: true,
              licence_verified: true,
              consent_verified: true,
              redactions_verified: true,
              facts_unchanged: true,
            }
          : { source_verified: true },)}::jsonb,
      ${policy},
      ${reviewDecision === "approved" ? null : "The source is not established."}
    )
    returning id
  `;

  return {
    reviewerUserId: reviewer!.user_id,
    subjectId: subject!.id,
    runId: run!.id,
    publicationId: history!.id,
    sourceId: source!.id,
    reviewId: review!.id,
    consentId,
  };
}

/** The insert the routes read, written directly so a gate can vary one field. */
export async function insertCaseStudy(
  sql: postgres.Sql,
  fixture: EditorialFixture,
  over: {
    slug?: string;
    publicState?: "draft" | "published" | "withdrawn";
    title?: string;
    summary?: string;
    caveats?: string[];
    redactionPolicyVersion?: string;
    consentId?: string | null;
    subjectId?: string;
    runId?: string;
    publicationId?: string;
    reviewId?: string;
    sourceId?: string;
  } = {},
): Promise<string> {
  const state = over.publicState ?? "published";
  const rows = await sql<{ id: string }[]>`
    insert into social.case_study_publications (
      slug, subject_id, run_id, publication_id, source_id, consent_id, review_id,
      redaction_policy_version, public_state, title, summary, caveats,
      content_sha256, published_at, withdrawn_at, withdrawal_reason
    ) values (
      ${over.slug ?? "the-immortal-game"},
      ${over.subjectId ?? fixture.subjectId},
      ${over.runId ?? fixture.runId},
      ${over.publicationId ?? fixture.publicationId},
      ${over.sourceId ?? fixture.sourceId},
      ${over.consentId === undefined ? fixture.consentId : over.consentId},
      ${over.reviewId ?? fixture.reviewId},
      ${over.redactionPolicyVersion ?? REDACTION_POLICY_VERSION},
      ${state},
      ${over.title ?? "The Immortal Game, read by Forma"},
      ${over.summary ?? "What a modern read of a famous attacking game does and does not tell you."},
      ${over.caveats ?? ["One game is not an estimate of anybody's strength."]},
      ${randomHex()},
      ${state === "draft" ? null : new Date()},
      ${state === "withdrawn" ? new Date() : null},
      ${state === "withdrawn" ? "The player asked us to take it down." : null}
    )
    returning id
  `;
  return rows[0]!.id;
}

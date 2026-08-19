/**
 * The editorial workflow and the public reads.
 *
 * Publishing is four separate acts — register the source, record the consent,
 * record the review, move the pointer — and they are separate here because they
 * are separate in life. An editor who has to insert a source row before they can
 * approve anything has been asked where the material came from at the moment
 * they still know.
 *
 * Every write goes through `forma_ops`. Nothing on the `/v1` surface can publish
 * or withdraw: a route that could be made to publish is a route somebody will
 * eventually make publish.
 */

import { client } from "../db/client.js";
import {
  DIRECTORY_MAX_LIMIT,
  REDACTION_POLICY_VERSION,
  escapeLikePrefix,
  normalizeHandle,
} from "./contract.js";
import type { ConsentScope, PermissionBasis, ReviewChecklist, SourceKind } from "./contract.js";
import { publicationReadiness } from "./readiness.js";
import type { Blocker } from "./readiness.js";
import { contentChecksum } from "./projection.js";
import type { CaseStudyRecord, DirectoryProfileRecord } from "./projection.js";

type Sql = typeof client;

// ---------------------------------------------------------------------------
// Writes — the editorial side, driven by an operator through `forma_ops`
// ---------------------------------------------------------------------------

export interface SourceInput {
  sourceKind: SourceKind;
  title: string;
  publisher?: string | null;
  sourceUrl?: string | null;
  retrievedAt?: Date | null;
  permissionBasis: PermissionBasis;
  licenceKey?: string | null;
  licenceUrl?: string | null;
  attributionText?: string | null;
  note?: string | null;
  registeredBy?: string | null;
}

export async function registerSource(input: SourceInput, sql: Sql = client): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into social.editorial_sources (
      source_kind, title, publisher, source_url, retrieved_at, permission_basis,
      licence_key, licence_url, attribution_text, note, registered_by
    ) values (
      ${input.sourceKind}, ${input.title}, ${input.publisher ?? null},
      ${input.sourceUrl ?? null}, ${input.retrievedAt ?? null}, ${input.permissionBasis},
      ${input.licenceKey ?? null}, ${input.licenceUrl ?? null},
      ${input.attributionText ?? null}, ${input.note ?? null}, ${input.registeredBy ?? null}
    )
    returning id
  `;
  return rows[0]!.id;
}

export interface ConsentInput {
  subjectId: string;
  scope: ConsentScope;
  grantedAt: Date;
  consentingUserId?: string | null;
  consentArtifactId?: string | null;
  expiresAt?: Date | null;
  recordedBy?: string | null;
}

export async function recordConsent(input: ConsentInput, sql: Sql = client): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into social.editorial_consents (
      subject_id, consenting_user_id, consent_artifact_id, scope,
      granted_at, expires_at, recorded_by
    ) values (
      ${input.subjectId}, ${input.consentingUserId ?? null},
      ${input.consentArtifactId ?? null}, ${input.scope},
      ${input.grantedAt}, ${input.expiresAt ?? null}, ${input.recordedBy ?? null}
    )
    returning id
  `;
  return rows[0]!.id;
}

/**
 * Somebody changed their mind.
 *
 * This updates two columns and stops. It does not go looking for the case
 * studies that rest on the consent, because the public read already refuses to
 * serve a study whose consent has been withdrawn — the study is off the site
 * before this function returns, and `withdrawCaseStudy` below is how the pointer
 * is then tidied up deliberately rather than as a side effect.
 */
export async function withdrawConsent(
  input: { consentId: string; note: string; at?: Date },
  sql: Sql = client,
): Promise<void> {
  await sql`
    update social.editorial_consents
    set withdrawn_at = ${input.at ?? new Date()}, withdrawal_note = ${input.note}
    where id = ${input.consentId} and withdrawn_at is null
  `;
}

export interface ReviewInput {
  subjectId: string;
  runId: string;
  reviewerUserId: string;
  decision: "approved" | "changes_requested" | "rejected";
  checklist: ReviewChecklist;
  note?: string | null;
  redactionPolicyVersion?: string;
}

export async function recordReview(input: ReviewInput, sql: Sql = client): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into social.editorial_reviews (
      subject_id, run_id, reviewer_user_id, decision, checklist,
      redaction_policy_version, note
    ) values (
      ${input.subjectId}, ${input.runId}, ${input.reviewerUserId}, ${input.decision},
      ${sql.json(input.checklist)}, ${input.redactionPolicyVersion ?? REDACTION_POLICY_VERSION},
      ${input.note ?? null}
    )
    returning id
  `;
  return rows[0]!.id;
}

export interface CaseStudyInput {
  slug: string;
  subjectId: string;
  runId: string;
  publicationId: string;
  sourceId: string;
  consentId?: string | null;
  reviewId: string;
  title: string;
  summary: string;
  caveats?: string[];
  identifiesPlayerPublicly: boolean;
  publicArtifactId?: string | null;
  createdBy?: string | null;
  redactionPolicyVersion?: string;
}

export class NotReadyToPublish extends Error {
  constructor(readonly blockers: Blocker[]) {
    super(`not ready to publish: ${blockers.map((blocker) => blocker.code).join(", ")}`);
    this.name = "NotReadyToPublish";
  }
}

interface CandidateRow {
  subject_kind: string;
  subject_has_owner: boolean;
  run_status: string;
  run_manifest: string | null;
  run_belongs: boolean;
  publication_belongs: boolean;
  publication_pins_run: boolean;
  permission_basis: PermissionBasis;
  licence_key: string | null;
  licence_url: string | null;
  attribution_text: string | null;
  consent_belongs: boolean | null;
  consent_scope: string | null;
  consent_withdrawn_at: Date | null;
  consent_expires_at: Date | null;
  review_decision: "approved" | "changes_requested" | "rejected";
  review_checklist: Record<string, unknown>;
  review_belongs: boolean;
  review_pins_run: boolean;
  review_policy: string;
}

/**
 * Read the grounds and ask, once, whether they hold.
 *
 * Exported because an editor wants to see the whole list before they start
 * fixing things, and because the migration gate uses it to prove that this and
 * the database trigger refuse the same candidates.
 */
export async function readiness(
  input: CaseStudyInput,
  sql: Sql = client,
): Promise<{ ready: boolean; blockers: Blocker[] }> {
  const policy = input.redactionPolicyVersion ?? REDACTION_POLICY_VERSION;
  const rows = await sql<CandidateRow[]>`
    select
      s.kind as subject_kind,
      (s.owner_user_id is not null) as subject_has_owner,
      r.status as run_status,
      r.output_manifest_hash as run_manifest,
      (r.subject_id = ${input.subjectId}::uuid) as run_belongs,
      (h.subject_id = ${input.subjectId}::uuid) as publication_belongs,
      (h.run_id = ${input.runId}::uuid) as publication_pins_run,
      src.permission_basis, src.licence_key, src.licence_url, src.attribution_text,
      (c.subject_id = ${input.subjectId}::uuid) as consent_belongs,
      c.scope as consent_scope,
      c.withdrawn_at as consent_withdrawn_at,
      c.expires_at as consent_expires_at,
      rev.decision as review_decision,
      rev.checklist as review_checklist,
      (rev.subject_id = ${input.subjectId}::uuid) as review_belongs,
      (rev.run_id = ${input.runId}::uuid) as review_pins_run,
      rev.redaction_policy_version as review_policy
    from app.analysis_subjects s
    join analysis.runs r on r.id = ${input.runId}::uuid
    join analysis.subject_live_publication_history h on h.id = ${input.publicationId}::uuid
    join social.editorial_sources src on src.id = ${input.sourceId}::uuid
    join social.editorial_reviews rev on rev.id = ${input.reviewId}::uuid
    left join social.editorial_consents c on c.id = ${input.consentId ?? null}::uuid
    where s.id = ${input.subjectId}::uuid
  `;
  const row = rows[0];
  if (!row) {
    return {
      ready: false,
      blockers: [
        {
          code: "grounds_missing",
          detail: "One of the subject, run, publication, source or review does not exist.",
        },
      ],
    };
  }
  return publicationReadiness({
    slug: input.slug,
    title: input.title,
    summary: input.summary,
    redactionPolicyVersion: policy,
    subject: { kind: row.subject_kind, hasAccountOwner: row.subject_has_owner },
    run: {
      status: row.run_status,
      outputManifestHash: row.run_manifest,
      belongsToSubject: row.run_belongs,
    },
    publication: {
      belongsToSubject: row.publication_belongs,
      pinsRun: row.publication_pins_run,
    },
    source: {
      permissionBasis: row.permission_basis,
      licenceKey: row.licence_key,
      licenceUrl: row.licence_url,
      attributionText: row.attribution_text,
    },
    consent:
      input.consentId == null
        ? null
        : {
            belongsToSubject: row.consent_belongs ?? false,
            scope: row.consent_scope ?? "",
            withdrawnAt: row.consent_withdrawn_at,
            expiresAt: row.consent_expires_at,
          },
    review: {
      decision: row.review_decision,
      checklist: row.review_checklist,
      belongsToSubject: row.review_belongs,
      pinsRun: row.review_pins_run,
      redactionPolicyVersion: row.review_policy,
    },
    identifiesPlayerPublicly: input.identifiesPlayerPublicly,
  });
}

/**
 * Publish, in one transaction: the pointer and the history row that says we did.
 *
 * Refuses before it writes, with every reason at once. The database will refuse
 * again on its own terms; that is the arrangement, not a redundancy to remove.
 */
export async function publishCaseStudy(
  input: CaseStudyInput,
  options: { actorUserId?: string | null; sql?: Sql } = {},
): Promise<{ caseStudyId: string; checksum: string }> {
  const sql = options.sql ?? client;
  const decision = await readiness(input, sql);
  if (!decision.ready) throw new NotReadyToPublish(decision.blockers);

  const policy = input.redactionPolicyVersion ?? REDACTION_POLICY_VERSION;
  const caveats = input.caveats ?? [];
  const checksum = contentChecksum({
    slug: input.slug,
    title: input.title,
    summary: input.summary,
    caveats,
    redactionPolicyVersion: policy,
  });

  return sql.begin(async (tx) => {
    const rows = await tx<{ id: string }[]>`
      insert into social.case_study_publications (
        slug, subject_id, run_id, publication_id, source_id, consent_id, review_id,
        redaction_policy_version, public_state, title, summary, caveats,
        content_sha256, public_artifact_id, published_at, created_by
      ) values (
        ${input.slug}, ${input.subjectId}, ${input.runId}, ${input.publicationId},
        ${input.sourceId}, ${input.consentId ?? null}, ${input.reviewId},
        ${policy}, 'published', ${input.title}, ${input.summary}, ${caveats},
        ${checksum}, ${input.publicArtifactId ?? null}, now(), ${input.createdBy ?? null}
      )
      returning id
    `;
    const caseStudyId = rows[0]!.id;
    await tx`
      insert into social.case_study_publication_events (
        case_study_id, event_kind, content_sha256, reason, actor_user_id
      ) values (
        ${caseStudyId}, 'published', ${checksum},
        ${"first publication"}, ${options.actorUserId ?? null}
      )
    `;
    return { caseStudyId, checksum };
  }) as Promise<{ caseStudyId: string; checksum: string }>;
}

/**
 * Withdraw.
 *
 * The pointer moves and an event is written. The run, its manifest, the source,
 * the consent and the review are untouched — the acceptance criterion is that a
 * study "can withdraw without rewriting evidence", and evidence for a claim we
 * made in public is exactly the evidence that has to survive the retraction.
 */
export async function withdrawCaseStudy(
  input: { slug: string; reason: string; actorUserId?: string | null },
  sql: Sql = client,
): Promise<boolean> {
  return sql.begin(async (tx) => {
    const rows = await tx<{ id: string; content_sha256: string }[]>`
      update social.case_study_publications
      set public_state = 'withdrawn', withdrawn_at = now(), withdrawal_reason = ${input.reason}
      where slug = ${input.slug} and public_state = 'published'
      returning id, content_sha256
    `;
    const row = rows[0];
    if (!row) return false;
    await tx`
      insert into social.case_study_publication_events (
        case_study_id, event_kind, content_sha256, reason, actor_user_id
      ) values (
        ${row.id}, 'withdrawn', ${row.content_sha256}, ${input.reason},
        ${input.actorUserId ?? null}
      )
    `;
    return true;
  }) as Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Reads — the public side, served by `forma_api`
// ---------------------------------------------------------------------------

/**
 * The one query behind both case-study endpoints.
 *
 * Literally one: the detail read is this list with a slug and a limit of one.
 * The column list is written out once rather than shared as a string, because a
 * shared fragment has to be interpolated with `sql.unsafe`, and interpolating an
 * `unsafe` fragment drops the whole query into the simple protocol — where
 * every value comes back as text and a timestamp quietly stops being a Date.
 *
 * `where public_state = 'published'` is stated here *and* enforced by a
 * row-level policy that only lets the API see published rows. Two independent
 * statements of the same rule, because this is the query whose filter a future
 * feature will be tempted to loosen. Consent is joined rather than trusted:
 * withdrawal takes a study down on the next read.
 */
/**
 * A timestamp as it actually arrives.
 *
 * `drizzle(client)` mutates the shared postgres.js connection on construction,
 * replacing the parsers for every date and timestamp OID with a transparent one
 * so that drizzle can map them itself. Every raw query in this process
 * therefore gets a *string* back from a `timestamptz` column, and code that
 * assumed a Date fails with a TypeError three layers up, as a 500.
 *
 * So the row type says what is really there and `toDate` accepts either. Not a
 * workaround to remove later: whether a driver hands back a Date is a detail
 * this module should survive changing.
 */
type Timestamp = string | Date | null;

function toDate(value: Timestamp): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(value);
}

interface CaseStudyRow {
  id: string;
  slug: string;
  public_state: "draft" | "published" | "withdrawn";
  title: string;
  summary: string;
  caveats: string[];
  content_sha256: string;
  published_at: Timestamp;
  withdrawn_at: Timestamp;
  redaction_policy_version: string;
  subject_label: string;
  subject_kind: "editorial" | "case_study";
  run_id: string;
  publication_id: string;
  publication_at: Timestamp;
  recipe_version_id: string | null;
  source_kind: SourceKind;
  source_title: string;
  source_publisher: string | null;
  source_url: string | null;
  source_retrieved_at: Timestamp;
  permission_basis: PermissionBasis;
  licence_key: string | null;
  licence_url: string | null;
  attribution_text: string | null;
  reviewed_at: Timestamp;
  consent_recorded: boolean;
  consent_withdrawn_at: Timestamp;
  consent_expires_at: Timestamp;
}

function toRecord(row: CaseStudyRow): CaseStudyRecord {
  return {
    slug: row.slug,
    publicState: row.public_state,
    title: row.title,
    summary: row.summary,
    caveats: row.caveats ?? [],
    contentSha256: row.content_sha256,
    publishedAt: toDate(row.published_at),
    withdrawnAt: toDate(row.withdrawn_at),
    redactionPolicyVersion: row.redaction_policy_version,
    subjectLabel: row.subject_label,
    subjectKind: row.subject_kind,
    runId: row.run_id,
    publicationId: row.publication_id,
    publicationAt: toDate(row.publication_at)!,
    recipeVersionId: row.recipe_version_id,
    sourceKind: row.source_kind,
    sourceTitle: row.source_title,
    sourcePublisher: row.source_publisher,
    sourceUrl: row.source_url,
    sourceRetrievedAt: toDate(row.source_retrieved_at),
    permissionBasis: row.permission_basis,
    licenceKey: row.licence_key,
    licenceUrl: row.licence_url,
    attributionText: row.attribution_text,
    reviewedAt: toDate(row.reviewed_at)!,
    consentRecorded: row.consent_recorded,
    consentWithdrawnAt: toDate(row.consent_withdrawn_at),
    consentExpiresAt: toDate(row.consent_expires_at),
  };
}

/**
 * A page of published studies, newest first, with the row id alongside each
 * record so the route can mint a keyset cursor. The id is never projected.
 */
export async function listPublishedCaseStudies(
  input: { slug?: string | null; after?: { publishedAt: string; id: string } | null; limit: number },
  sql: Sql = client,
): Promise<{ record: CaseStudyRecord; id: string }[]> {
  const limit = Math.min(Math.max(1, Math.floor(input.limit)), 100);
  const slug = input.slug ?? null;
  const afterAt = input.after?.publishedAt ?? null;
  const afterId = input.after?.id ?? null;
  const rows = await sql<CaseStudyRow[]>`
    select
      cs.id, cs.slug, cs.public_state, cs.title, cs.summary, cs.caveats,
      cs.content_sha256, cs.published_at, cs.withdrawn_at, cs.redaction_policy_version,
      s.display_label as subject_label, s.kind as subject_kind,
      cs.run_id, cs.publication_id, h.published_at as publication_at,
      r.recipe_version_id,
      src.source_kind, src.title as source_title, src.publisher as source_publisher,
      src.source_url, src.retrieved_at as source_retrieved_at, src.permission_basis,
      src.licence_key, src.licence_url, src.attribution_text,
      rev.decided_at as reviewed_at,
      (cs.consent_id is not null) as consent_recorded,
      c.withdrawn_at as consent_withdrawn_at, c.expires_at as consent_expires_at
    from social.case_study_publications cs
    join app.analysis_subjects s on s.id = cs.subject_id
    join analysis.runs r on r.id = cs.run_id
    join analysis.subject_live_publication_history h on h.id = cs.publication_id
    join social.editorial_sources src on src.id = cs.source_id
    join social.editorial_reviews rev on rev.id = cs.review_id
    left join social.editorial_consents c on c.id = cs.consent_id
    where cs.public_state = 'published'
      and (${slug}::text is null or cs.slug = ${slug}::text)
      and (
        ${afterAt}::timestamptz is null
        or (cs.published_at, cs.id) < (${afterAt}::timestamptz, ${afterId}::uuid)
      )
    order by cs.published_at desc, cs.id desc
    limit ${limit}
  `;
  return rows.map((row) => ({ record: toRecord(row), id: row.id }));
}

export async function readPublishedCaseStudy(
  slug: string,
  sql: Sql = client,
): Promise<CaseStudyRecord | null> {
  const rows = await listPublishedCaseStudies({ slug, limit: 1 }, sql);
  return rows[0]?.record ?? null;
}

// ---------------------------------------------------------------------------
// The directory
// ---------------------------------------------------------------------------

interface ProfileRow {
  user_id: string;
  handle: string;
  display_name: string | null;
  avatar_url: string | null;
  is_discoverable: boolean;
  show_provider_handles: boolean;
}

/**
 * Provider handles for the profiles that asked for them to be shown.
 *
 * Two flags, both false by default, and the query needs both: the profile's
 * `show_provider_handles` and the linked account's own
 * `provider_handle_discoverable`. A person with three linked accounts who made
 * one of them public gets one handle listed, which is what they asked for.
 */
async function providerHandlesFor(
  userIds: readonly string[],
  sql: Sql,
): Promise<Map<string, { provider: string; handle: string }[]>> {
  const handles = new Map<string, { provider: string; handle: string }[]>();
  if (userIds.length === 0) return handles;
  const rows = await sql<
    { owner_user_id: string; provider: string; handle: string }[]
  >`
    select la.owner_user_id, pr.slug as provider,
           coalesce(pi.current_display_username, pi.current_normalized_username) as handle
    from app.linked_accounts la
    join app.provider_identities pi on pi.id = la.provider_identity_id
    join app.providers pr on pr.id = pi.provider_id
    where la.owner_user_id = any(${userIds as string[]})
      and la.provider_handle_discoverable
      and la.status = 'active'
      and coalesce(pi.current_display_username, pi.current_normalized_username) is not null
    order by pr.slug
  `;
  for (const row of rows) {
    const list = handles.get(row.owner_user_id) ?? [];
    list.push({ provider: row.provider, handle: row.handle });
    handles.set(row.owner_user_id, list);
  }
  return handles;
}

export async function searchDirectory(
  input: { prefix: string; after?: string | null; limit: number },
  sql: Sql = client,
): Promise<DirectoryProfileRecord[]> {
  const limit = Math.min(Math.max(1, Math.floor(input.limit)), DIRECTORY_MAX_LIMIT);
  const prefix = `${escapeLikePrefix(normalizeHandle(input.prefix))}%`;
  const rows = await sql<ProfileRow[]>`
    select p.user_id, p.handle, p.display_name, p.avatar_url,
           p.is_discoverable, p.show_provider_handles
    from social.public_player_profiles p
    where p.is_discoverable
      and p.handle like ${prefix}
      and (${input.after ?? null}::text is null or p.handle > ${input.after ?? null}::text)
    order by p.handle asc
    limit ${limit}
  `;
  const opted = rows.filter((row) => row.show_provider_handles).map((row) => row.user_id);
  const handles = await providerHandlesFor(opted, sql);
  return rows.map((row) => ({
    handle: row.handle,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    isDiscoverable: row.is_discoverable,
    showProviderHandles: row.show_provider_handles,
    providerHandles: handles.get(row.user_id) ?? [],
  }));
}

export async function readDirectoryProfile(
  handle: string,
  sql: Sql = client,
): Promise<DirectoryProfileRecord | null> {
  const normalized = normalizeHandle(handle);
  const rows = await sql<ProfileRow[]>`
    select p.user_id, p.handle, p.display_name, p.avatar_url,
           p.is_discoverable, p.show_provider_handles
    from social.public_player_profiles p
    where p.handle = ${normalized} and p.is_discoverable
  `;
  const row = rows[0];
  if (!row) return null;
  const handles = row.show_provider_handles
    ? await providerHandlesFor([row.user_id], sql)
    : new Map<string, { provider: string; handle: string }[]>();
  return {
    handle: row.handle,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    isDiscoverable: row.is_discoverable,
    showProviderHandles: row.show_provider_handles,
    providerHandles: handles.get(row.user_id) ?? [],
  };
}

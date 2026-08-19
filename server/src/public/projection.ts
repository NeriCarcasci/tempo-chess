/**
 * The public projections.
 *
 * Every field on a public body is named here, one at a time. There is no spread
 * of a database row into a response anywhere in this epic, because a spread is
 * how a column added next year becomes public without anybody deciding that it
 * should be.
 *
 * The functions are pure and take plain records, so the rules can be tested
 * without a database and the routes stay a thin layer over a query.
 */

import { createHash } from "node:crypto";
import { canonicalJson } from "../v1/canonical-json.js";
import type { PermissionBasis, PublicState, SourceKind } from "./contract.js";

/** What a case-study read returns from the database, before projection. */
export interface CaseStudyRecord {
  slug: string;
  publicState: PublicState;
  title: string;
  summary: string;
  caveats: string[];
  contentSha256: string;
  publishedAt: Date | null;
  withdrawnAt: Date | null;
  redactionPolicyVersion: string;
  subjectLabel: string;
  subjectKind: "editorial" | "case_study";
  runId: string;
  publicationId: string;
  publicationAt: Date;
  recipeVersionId: string | null;
  sourceKind: SourceKind;
  sourceTitle: string;
  sourcePublisher: string | null;
  sourceUrl: string | null;
  sourceRetrievedAt: Date | null;
  permissionBasis: PermissionBasis;
  licenceKey: string | null;
  licenceUrl: string | null;
  attributionText: string | null;
  reviewedAt: Date;
  consentRecorded: boolean;
  consentWithdrawnAt: Date | null;
  consentExpiresAt: Date | null;
}

export interface CaseStudySummaryView {
  slug: string;
  title: string;
  summary: string;
  publishedAt: string;
  /** §20.1: an editorial profile carries a visible badge. So does its study. */
  editorial: true;
  permissionBasis: PermissionBasis;
}

export interface CaseStudyView extends CaseStudySummaryView {
  subject: { label: string; kind: "editorial" | "case_study" };
  caveats: string[];
  source: {
    kind: SourceKind;
    title: string;
    publisher: string | null;
    url: string | null;
    retrievedAt: string | null;
    licence: { key: string; url: string } | null;
    attribution: string | null;
  };
  /**
   * §1.2's version block, in its public form. A public claim without the
   * publication that produced it is a screenshot.
   */
  version: {
    publicationId: string;
    runId: string;
    generatedAt: string;
    recipeVersionId: string | null;
    redactionPolicyVersion: string;
  };
  contentChecksum: string;
}

/**
 * Whether a stored case study may be served right now.
 *
 * Three ways to be unservable and they are all the same 404: not published,
 * withdrawn, or resting on consent that has since been withdrawn or expired.
 * The last one is why this is a function and not a `where public_state =
 * 'published'`: consent ends when the person says so, not when an operator
 * next runs the withdrawal job.
 */
export function isServable(record: CaseStudyRecord, now = new Date()): boolean {
  if (record.publicState !== "published") return false;
  if (record.publishedAt === null) return false;
  if (record.consentRecorded) {
    if (record.consentWithdrawnAt !== null) return false;
    if (record.consentExpiresAt !== null && record.consentExpiresAt <= now) return false;
  }
  return true;
}

export function caseStudySummary(record: CaseStudyRecord): CaseStudySummaryView {
  return {
    slug: record.slug,
    title: record.title,
    summary: record.summary,
    publishedAt: record.publishedAt!.toISOString(),
    editorial: true,
    permissionBasis: record.permissionBasis,
  };
}

export function caseStudyView(record: CaseStudyRecord): CaseStudyView {
  return {
    ...caseStudySummary(record),
    subject: { label: record.subjectLabel, kind: record.subjectKind },
    caveats: [...record.caveats],
    source: {
      kind: record.sourceKind,
      title: record.sourceTitle,
      publisher: record.sourcePublisher,
      url: record.sourceUrl,
      retrievedAt: record.sourceRetrievedAt?.toISOString() ?? null,
      licence:
        record.licenceKey && record.licenceUrl
          ? { key: record.licenceKey, url: record.licenceUrl }
          : null,
      attribution: record.attributionText,
    },
    version: {
      publicationId: record.publicationId,
      runId: record.runId,
      generatedAt: record.publicationAt.toISOString(),
      recipeVersionId: record.recipeVersionId,
      redactionPolicyVersion: record.redactionPolicyVersion,
    },
    contentChecksum: record.contentSha256,
  };
}

/**
 * The redaction block for a case study.
 *
 * §1.2 asks a response to *name* what it withheld. Two things are always
 * withheld here and saying so is the point: whether a real person consented is
 * public, but who they are is not, and the private analysis behind the
 * projection is not on this surface at all.
 */
export function caseStudyRedactions(record: CaseStudyRecord): { path: string; reason: "projection" }[] {
  const redactions: { path: string; reason: "projection" }[] = [
    { path: "data.subject.account", reason: "projection" },
    { path: "data.analysis", reason: "projection" },
  ];
  if (record.consentRecorded) redactions.push({ path: "data.consent", reason: "projection" });
  return redactions;
}

/**
 * The checksum of what was reviewed.
 *
 * Over the canonical JSON of the *public* fields, so it is a statement about
 * what a reader sees rather than about a row. Two studies with the same words
 * and different internal ids hash the same, which is correct: the promise is
 * about the projection.
 */
export function contentChecksum(input: {
  slug: string;
  title: string;
  summary: string;
  caveats: readonly string[];
  redactionPolicyVersion: string;
}): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        slug: input.slug,
        title: input.title,
        summary: input.summary,
        caveats: [...input.caveats],
        redactionPolicyVersion: input.redactionPolicyVersion,
      }),
    )
    .digest("hex");
}

// ---------------------------------------------------------------------------
// The player directory
// ---------------------------------------------------------------------------

export interface DirectoryProfileRecord {
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  isDiscoverable: boolean;
  showProviderHandles: boolean;
  /** Only the accounts whose own discoverability flag is set. */
  providerHandles: { provider: string; handle: string }[];
}

export interface DirectoryProfileView {
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  providerHandles: { provider: string; handle: string }[];
}

/**
 * The public projection of a profile.
 *
 * Provider handles need two opt-ins, not one: the profile's
 * `show_provider_handles` and the linked account's own
 * `provider_handle_discoverable`. Somebody who is happy to be findable on Forma
 * has not thereby agreed to publish which chess.com account is theirs, and the
 * two flags exist because they are two different disclosures.
 *
 * Returns null when the profile is not discoverable. A caller cannot tell that
 * from a handle nobody has taken, which is the intended answer: hidden means
 * hidden, not "exists but is shy".
 */
export function directoryProfile(record: DirectoryProfileRecord): DirectoryProfileView | null {
  if (!record.isDiscoverable) return null;
  return {
    handle: record.handle,
    displayName: record.displayName,
    avatarUrl: record.avatarUrl,
    providerHandles: record.showProviderHandles ? [...record.providerHandles] : [],
  };
}

export function directoryRedactions(
  record: DirectoryProfileRecord,
): { path: string; reason: "projection" }[] {
  return record.showProviderHandles
    ? []
    : [{ path: "data.providerHandles", reason: "projection" }];
}

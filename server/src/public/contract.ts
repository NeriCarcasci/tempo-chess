/**
 * E20 — what may be said in public, and on what basis.
 *
 * The rules in this file are the ones a public surface gets wrong quietly. A
 * handle that leaks is not a crash; a case study published without consent does
 * not fail a health check; a count of three in a segmented statistic is a name.
 * So each of them is a named constant or a total function here, and the routes
 * are assembled out of these rather than out of judgement at the call site.
 *
 * Specification: plans/v1-api-contract.md §3, plans/database-architecture.md
 * §§7.8–7.9, 20 and 26.4, plans/v1-platform-spec.md §21.13.
 */

/** Why we may republish somebody else's material. Four, and no fifth. */
export const PERMISSION_BASES = [
  "public_domain",
  "licence",
  "consent",
  "own_material",
] as const;
export type PermissionBasis = (typeof PERMISSION_BASES)[number];

export const SOURCE_KINDS = [
  "historic_archive",
  "provider_public_profile",
  "licensed_dataset",
  "player_submission",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const CONSENT_SCOPES = ["publish_analysis", "publish_analysis_with_handle"] as const;
export type ConsentScope = (typeof CONSENT_SCOPES)[number];

export const REVIEW_DECISIONS = ["approved", "changes_requested", "rejected"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export const PUBLIC_STATES = ["draft", "published", "withdrawn"] as const;
export type PublicState = (typeof PUBLIC_STATES)[number];

/**
 * The five boxes an editorial approval must tick.
 *
 * Written as a list rather than five booleans in a signature so that adding a
 * sixth is one edit and every approval already recorded fails the new check
 * loudly instead of being silently grandfathered.
 */
export const REVIEW_CHECKLIST_KEYS = [
  "source_verified",
  "licence_verified",
  "consent_verified",
  "redactions_verified",
  /**
   * The one that is not about paperwork: the public projection says the same
   * thing the private analysis says. A case study is allowed to show less. It
   * is never allowed to show something better.
   */
  "facts_unchanged",
] as const;
export type ReviewChecklistKey = (typeof REVIEW_CHECKLIST_KEYS)[number];

export type ReviewChecklist = Record<ReviewChecklistKey, boolean>;

/**
 * The redaction policy the public projection is built under.
 *
 * Version it, because a change to what is withheld is a change to what was
 * approved: a study reviewed under `2026-08-a` has not been reviewed under a
 * policy that shows one more field. The database refuses a pointer whose
 * policy version disagrees with its review.
 */
export const REDACTION_POLICY_VERSION = "2026-08-a";

/**
 * Below this, a count in a segmented public statistic is a description of
 * individuals rather than of a population.
 *
 * Ten is the conventional floor for published cell counts and is deliberately
 * not tuned to make our current numbers show: the point of a threshold chosen
 * in advance is that it also applies on the day it is inconvenient.
 */
export const SMALL_CELL_THRESHOLD = 10;

/** §3: "Minimum query length 2" on the public directory. */
export const DIRECTORY_MIN_QUERY_LENGTH = 2;
export const DIRECTORY_MAX_QUERY_LENGTH = 40;
export const DIRECTORY_DEFAULT_LIMIT = 20;
export const DIRECTORY_MAX_LIMIT = 50;

export const CASE_STUDY_DEFAULT_LIMIT = 20;
export const CASE_STUDY_MAX_LIMIT = 50;

/**
 * Field names that must never appear in a public body, at any depth.
 *
 * Belt and braces. Every public projection in this epic is built by naming its
 * fields one at a time — there is no spread of a database row into a response —
 * so this list is not what keeps the surface clean. It is what notices when
 * somebody changes that, and it is asserted against real HTTP responses in the
 * security gate rather than against a fixture.
 */
export const FORBIDDEN_PUBLIC_FIELDS = [
  "email",
  "emailAddress",
  "userId",
  "ownerUserId",
  "profileId",
  "linkedAccountId",
  "providerIdentityId",
  "providerAccountId",
  "consentArtifactId",
  "reviewerUserId",
  "recordedBy",
  "registeredBy",
  "createdBy",
  "rating",
  "ratingBand",
  "ratingHistory",
  "goal",
  "goals",
  "findings",
  "estimates",
  "ipAddress",
  "authUserId",
] as const;

/**
 * Every path in `value` whose key is forbidden in public.
 *
 * Returns paths rather than a boolean because a gate that says "something
 * leaked" sends somebody hunting, and one that says
 * `data.items[3].linkedAccountId` does not.
 */
export function forbiddenPublicFields(value: unknown, path = "data"): string[] {
  const found: string[] = [];
  const walk = (node: unknown, at: string): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${at}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const here = `${at}.${key}`;
      if ((FORBIDDEN_PUBLIC_FIELDS as readonly string[]).includes(key)) found.push(here);
      walk(child, here);
    }
  };
  walk(value, path);
  return found;
}

/** The slug shape the database enforces, so a route can reject before querying. */
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isValidSlug(slug: string): boolean {
  return slug.length >= 3 && slug.length <= 80 && SLUG.test(slug);
}

/**
 * The handle shape the directory searches on.
 *
 * Lower-cased and trimmed, never fuzzy: §20.1 fixes exact and prefix search on
 * the normalized Forma handle, because a fuzzy public search over identities is
 * a way to enumerate people who are hard to spell rather than a feature.
 */
export function normalizeHandle(raw: string): string {
  return raw.trim().toLowerCase();
}

const HANDLE = /^[a-z0-9](?:[a-z0-9_-]{1,38})[a-z0-9]$/;

export function isValidHandle(handle: string): boolean {
  return HANDLE.test(handle);
}

/**
 * The characters PostgreSQL's `like` treats as wildcards, escaped.
 *
 * A directory query is user input that reaches a prefix match. Without this, a
 * query of `%` is a listing of every discoverable profile — which is not a data
 * breach, but is exactly the kind of "it only returns public fields, so it is
 * fine" reasoning that ends with an enumeration endpoint.
 */
export function escapeLikePrefix(query: string): string {
  return query.replace(/([\\%_])/g, "\\$1");
}

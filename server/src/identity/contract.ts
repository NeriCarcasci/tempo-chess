/**
 * The E06 identity vocabulary and the rules that do not need a database.
 *
 * Every closed set here is also a check constraint in `0016_e06_identity.sql`,
 * for the same reason E04 duplicates its vocabulary: the database refuses a row
 * it does not recognise even if a future call site invents a value, and this
 * file is what the API and the OpenAPI document read.
 *
 * The public projection lives here too. What a stranger may see is a decision
 * about the product, not a detail of a query, so it is a pure function over a
 * row that a test can exhaust without a cluster.
 *
 * Sources: plans/database-architecture.md §7, plans/v1-platform-spec.md §§2,
 * 3.1, 16-18, plans/v1-api-contract.md §§3-5.
 */

/** Database architecture §7.2. */
export const SUBJECT_KINDS = ["personal", "editorial", "case_study"] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

export const SUBJECT_STATUSES = ["active", "archived", "deleting"] as const;
export type SubjectStatus = (typeof SUBJECT_STATUSES)[number];

/** Database architecture §7.6. */
export const CONNECTION_KINDS = ["public_lookup", "oauth"] as const;
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];

export const VERIFICATION_STATUSES = [
  "unverified",
  "confirmed",
  "verified",
  "revoked",
  "failed",
] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const LINK_STATUSES = ["active", "paused", "disconnected"] as const;
export type LinkStatus = (typeof LINK_STATUSES)[number];

export const CONFIRMATION_METHODS = ["owner_declared", "oauth_verified", "admin_reviewed"] as const;
export type ConfirmationMethod = (typeof CONFIRMATION_METHODS)[number];

/** Database architecture §7.3. Slugs, not an enum. */
export const PROVIDER_SLUGS = ["chesscom", "lichess"] as const;
export type ProviderSlug = (typeof PROVIDER_SLUGS)[number];

export const PROVIDER_IDS: Readonly<Record<ProviderSlug, number>> = {
  chesscom: 1,
  lichess: 2,
};

export function isProviderSlug(value: string): value is ProviderSlug {
  return (PROVIDER_SLUGS as readonly string[]).includes(value);
}

/**
 * How a provider handle becomes a lookup key.
 *
 * Both supported providers treat usernames case-insensitively and neither
 * permits surrounding whitespace, so folding is safe. It is deliberately *not*
 * clever beyond that: stripping punctuation or accents would silently merge two
 * different players, which is the one mistake this epic must not make.
 */
export function normalizeHandle(raw: string): string {
  return raw.trim().toLowerCase();
}

/** A handle a provider could actually issue. Rejects before any network call. */
export function isPlausibleHandle(raw: string): boolean {
  const handle = raw.trim();
  return handle.length >= 2 && handle.length <= 64 && /^[A-Za-z0-9_-]+$/.test(handle);
}

/**
 * A link that still contributes evidence.
 *
 * `paused` counts: the account is still the user's and its history is still
 * theirs; only `disconnected` stops being a claim. The database's partial
 * unique index uses the same rule, so a paused link still blocks a duplicate.
 */
export function isLiveLink(status: LinkStatus): boolean {
  return status !== "disconnected";
}

/**
 * Whether a verification status may be replaced by another.
 *
 * Verification truth is preserved: a weaker observation never overwrites a
 * stronger one. Re-running a public lookup against an account that was already
 * OAuth-verified must not quietly demote it to `confirmed`.
 */
const VERIFICATION_RANK: Readonly<Record<VerificationStatus, number>> = {
  unverified: 0,
  confirmed: 1,
  verified: 2,
  // Terminal observations. They are not stronger evidence of ownership, but
  // they are deliberate and must not be overwritten by a routine re-lookup.
  revoked: 3,
  failed: 3,
};

export function mayReplaceVerification(
  current: VerificationStatus,
  next: VerificationStatus,
): boolean {
  if (current === next) return false;
  if (current === "revoked" || current === "failed") {
    // Only an explicit re-verification clears a terminal state.
    return next === "verified";
  }
  return VERIFICATION_RANK[next] > VERIFICATION_RANK[current];
}

export interface PublicProfileRow {
  readonly userId: string;
  readonly personalSubjectId: string | null;
  readonly handle: string;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
  readonly isDiscoverable: boolean;
  readonly showProviderHandles: boolean;
  /** Handles of the owner's live links. Included only when they opted in. */
  readonly providerHandles?: { provider: ProviderSlug; handle: string }[];
}

export interface PublicProfileProjection {
  readonly handle: string;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
  readonly providerHandles: { provider: ProviderSlug; handle: string }[];
}

/**
 * What a stranger may see.
 *
 * Returns null rather than an empty projection when the profile is not
 * discoverable, so a caller cannot accidentally serve a husk that confirms the
 * handle exists. Provider handles are omitted unless separately opted into:
 * being findable and being willing to publish your Lichess name are different
 * decisions, and §7.8 keeps them as different flags.
 *
 * Everything absent here is absent on purpose — email, linked-account ids,
 * ratings, goals, findings and the user id itself.
 */
export function projectPublicProfile(row: PublicProfileRow): PublicProfileProjection | null {
  if (!row.isDiscoverable) return null;
  return {
    handle: row.handle,
    displayName: row.displayName,
    avatarUrl: row.avatarUrl,
    providerHandles: row.showProviderHandles ? (row.providerHandles ?? []) : [],
  };
}

/**
 * Whether an actor may act on a subject.
 *
 * Ownership is the whole rule in v1: there is no sharing, so a subject the
 * actor does not own is indistinguishable from one that does not exist. The
 * caller is responsible for turning `false` into a 404 rather than a 403 where
 * the contract says existence itself is private.
 */
export function mayActOnSubject(
  actorId: string | null,
  subject: { ownerUserId: string | null },
): boolean {
  if (!actorId) return false;
  return subject.ownerUserId === actorId;
}

export function mayActOnLinkedAccount(
  actorId: string | null,
  account: { ownerUserId: string },
): boolean {
  if (!actorId) return false;
  return account.ownerUserId === actorId;
}

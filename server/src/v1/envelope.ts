/**
 * `/v1` success bodies, per plans/v1-api-contract.md §1.2.
 *
 * Two shapes and no third: one resource, or a collection with a page block.
 * `meta.requestId` is on every response, so a caller quoting an ID in a support
 * request is quoting something the logs can find.
 *
 * `meta.redactions` is how the contract's "omitted fields" rule stays truthful.
 * A field withheld by entitlement or by endpoint projection is *named*, so a
 * client can tell "we do not know this" from "you may not see this" from "this
 * endpoint does not carry it".
 */

/** Why a field is absent. Nothing else may be a reason. */
export type RedactionReason = "entitlement" | "projection";

export interface Redaction {
  /** Dotted path into the response body, e.g. `data.subscription.trialEndsAt`. */
  path: string;
  reason: RedactionReason;
}

export interface ResponseMeta {
  requestId: string;
  redactions?: Redaction[];
}

export interface PageBlock {
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * The provenance block a claim-bearing read adds (§1.2). E03 publishes no
 * claims, so nothing here produces one yet; the type is frozen so E11's
 * publications and E15's findings inherit it rather than inventing a shape.
 */
export interface VersionBlock {
  publicationId: string;
  generatedAt: string;
  subjectSnapshotId: string | null;
  recipeVersionId: string | null;
  policyVersions: Record<string, string>;
}

export interface ResourceEnvelope<T> {
  data: T;
  meta: ResponseMeta;
}

export interface CollectionEnvelope<T> {
  data: T[];
  page: PageBlock;
  meta: ResponseMeta;
}

function meta(requestId: string, redactions?: readonly Redaction[]): ResponseMeta {
  // Absent rather than empty: `"redactions": []` invites a client to render
  // "0 fields hidden", which is noise on the overwhelming majority of responses.
  return redactions && redactions.length > 0
    ? { requestId, redactions: [...redactions] }
    : { requestId };
}

export function resource<T>(
  data: T,
  requestId: string,
  redactions?: readonly Redaction[],
): ResourceEnvelope<T> {
  return { data, meta: meta(requestId, redactions) };
}

export function collection<T>(
  data: readonly T[],
  page: PageBlock,
  requestId: string,
  redactions?: readonly Redaction[],
): CollectionEnvelope<T> {
  // `nextCursor` without `hasMore` is a client bug waiting to happen, so the
  // two are derived together at the one place that builds the block.
  return {
    data: [...data],
    page: { nextCursor: page.hasMore ? page.nextCursor : null, hasMore: page.hasMore },
    meta: meta(requestId, redactions),
  };
}

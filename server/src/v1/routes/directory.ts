import { z } from "zod";
import {
  DIRECTORY_DEFAULT_LIMIT,
  DIRECTORY_MAX_LIMIT,
  DIRECTORY_MAX_QUERY_LENGTH,
  DIRECTORY_MIN_QUERY_LENGTH,
  isValidHandle,
  normalizeHandle,
} from "../../public/contract.js";
import { readDirectoryProfile, searchDirectory } from "../../public/editorial.js";
import { directoryProfile, directoryRedactions } from "../../public/projection.js";
import type { DirectoryProfileView } from "../../public/projection.js";
import { type CursorScope, decodeCursor, encodeCursor } from "../cursor.js";
import { ProblemError } from "../problem.js";
import { POLICIES } from "../rate-limit.js";
import { routeKey, type RouteDefinition } from "../registry.js";

/**
 * `GET /v1/directory/players`, per §3 and database architecture §20.1.
 *
 * The initial player lookup, and deliberately the smallest thing that deserves
 * the name. Exact and prefix search on the Forma handle; nothing fuzzy, no
 * search by email, no search across provider identities. A fuzzy public search
 * over identities is not a nicer search box, it is a way to enumerate people
 * whose names you cannot spell.
 *
 * Three defaults do the privacy work, and all three are "off":
 * `is_discoverable`, the profile's `show_provider_handles`, and each linked
 * account's own `provider_handle_discoverable`. A profile is invisible until
 * its owner says otherwise, and being findable on Forma is not agreement to
 * publish which chess.com account is yours.
 */

const profileSchema = z.object({
  handle: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  providerHandles: z.array(z.object({ provider: z.string(), handle: z.string() })),
});

const searchQuery = z.object({
  query: z
    .string()
    .trim()
    .min(DIRECTORY_MIN_QUERY_LENGTH)
    .max(DIRECTORY_MAX_QUERY_LENGTH),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(DIRECTORY_MAX_LIMIT).optional(),
});

const searchRoute: RouteDefinition<z.infer<typeof searchQuery>, never, DirectoryProfileView[]> = {
  method: "GET",
  path: "/v1/directory/players",
  operationId: "searchDirectory",
  summary: "Prefix search of opted-in Forma handles",
  description:
    "Public, minimum query length 2, rate limited per address. Returns public profile summaries only, and provider handles only for profiles that have opted into showing them.",
  kind: "read",
  auth: "public",
  envelope: "collection",
  successStatus: 200,
  querySchema: searchQuery,
  dataSchema: z.array(profileSchema),
  // Private-ish by nature and cheap to recompute. A shared cache holding
  // "who matches `an`" is a small enumeration cache sitting in front of an
  // endpoint whose whole risk is enumeration.
  cacheControl: "no-store",
  rateLimits: [{ policy: POLICIES.directorySearch, source: "address" }],
  async handler({ query }) {
    const limit = query.limit ?? DIRECTORY_DEFAULT_LIMIT;
    const scope: CursorScope = {
      routeKey: routeKey(searchRoute),
      sortKey: "handle",
      filters: { query: normalizeHandle(query.query) },
    };
    // The cursor is bound to the query it was issued under, so it cannot be
    // carried from one prefix to another to walk past the limit.
    const anchor = query.cursor ? decodeCursor(query.cursor, scope).a : null;
    const records = await searchDirectory({
      prefix: query.query,
      after: anchor ? String(anchor[0]) : null,
      limit: limit + 1,
    });
    const hasMore = records.length > limit;
    const page = records.slice(0, limit);
    const last = page.at(-1);
    return {
      data: page
        .map((record) => directoryProfile(record))
        .filter((view): view is DirectoryProfileView => view !== null),
      page: {
        hasMore,
        nextCursor: hasMore && last ? encodeCursor(scope, [last.handle]) : null,
      },
    };
  },
};

const profileRoute: RouteDefinition<never, never, DirectoryProfileView> = {
  method: "GET",
  path: "/v1/directory/players/:handle",
  operationId: "getDirectoryProfile",
  summary: "One public player profile",
  description:
    "Public. Public profile fields and opted-in provider handles. It never returns email, linked-account identifiers, findings, goals, ratings or game history. A profile that is not discoverable is indistinguishable from a handle nobody has taken.",
  kind: "read",
  auth: "public",
  envelope: "resource",
  successStatus: 200,
  dataSchema: profileSchema,
  etag: true,
  cacheControl: "no-store",
  rateLimits: [{ policy: POLICIES.directorySearch, source: "address" }],
  async handler({ params }) {
    const handle = normalizeHandle(params.handle ?? "");
    if (!isValidHandle(handle)) {
      throw new ProblemError("NOT_FOUND", { detail: "No such profile." });
    }
    const record = await readDirectoryProfile(handle);
    const view = record ? directoryProfile(record) : null;
    if (!record || !view) {
      // Hidden and non-existent are the same answer. Anything else turns this
      // endpoint into a test for "does this person have a Forma account".
      throw new ProblemError("NOT_FOUND", { detail: "No such profile." });
    }
    return { data: view, redactions: directoryRedactions(record) };
  },
};

export const DIRECTORY_ROUTES = [searchRoute, profileRoute] as const;

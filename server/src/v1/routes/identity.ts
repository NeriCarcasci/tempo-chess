/**
 * `/v1/me`, linked accounts, and public player lookup.
 *
 * The routes are thin: validation is the schema, authorization is the actor
 * bound in `withActorContext` plus RLS, and the rules are in
 * `identity/contract.ts`. What is left here is the mapping from HTTP to those.
 */

import { z } from "zod";
import {
  PROVIDER_SLUGS,
  isPlausibleHandle,
  type ProviderSlug,
} from "../../identity/contract.js";
import {
  disconnectAccount,
  getMe,
  linkAccount,
  lookupPublicProfile,
} from "../../identity/service.js";
import { ProblemError } from "../problem.js";
import type { RouteDefinition } from "../registry.js";

const linkedAccountSchema = z.object({
  id: z.string(),
  provider: z.enum(PROVIDER_SLUGS),
  handle: z.string().nullable(),
  connectionKind: z.enum(["public_lookup", "oauth"]),
  verificationStatus: z.enum(["unverified", "confirmed", "verified", "revoked", "failed"]),
  status: z.enum(["active", "paused", "disconnected"]),
  providerHandleDiscoverable: z.boolean(),
  createdAt: z.string(),
});

const meSchema = z.object({
  profileId: z.string(),
  locale: z.string().nullable(),
  timezone: z.string().nullable(),
  personalSubject: z
    .object({ id: z.string(), displayLabel: z.string(), status: z.string() })
    .nullable(),
  accounts: z.array(linkedAccountSchema),
});

const publicProfileSchema = z.object({
  handle: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  providerHandles: z.array(z.object({ provider: z.enum(PROVIDER_SLUGS), handle: z.string() })),
});

const meRoute: RouteDefinition<never, never, z.infer<typeof meSchema>> = {
  method: "GET",
  path: "/v1/me",
  operationId: "getMe",
  summary: "The signed-in actor's profile, personal subject and linked accounts",
  kind: "read",
  auth: "required",
  envelope: "resource",
  successStatus: 200,
  dataSchema: meSchema,
  // Deliberately not cached: it changes the moment an account is linked, and a
  // stale copy of your own account list is worse than a round trip.
  cacheControl: "private, no-store",
  async handler({ auth }) {
    return { data: await getMe(auth!.actorId) };
  },
};

const linkBodySchema = z.object({
  provider: z.enum(PROVIDER_SLUGS),
  handle: z.string().min(2).max(64),
});

const linkRoute: RouteDefinition<never, z.infer<typeof linkBodySchema>, z.infer<typeof linkedAccountSchema>> = {
  method: "POST",
  path: "/v1/me/accounts",
  operationId: "linkAccount",
  summary: "Claim a provider account for the signed-in actor",
  description:
    "Two users may claim the same provider account independently; neither is told about the other. Re-claiming an account you already hold returns the existing link rather than failing.",
  kind: "command",
  auth: "required",
  idempotency: "key",
  envelope: "resource",
  successStatus: 201,
  bodySchema: linkBodySchema,
  dataSchema: linkedAccountSchema,
  async handler({ auth, body }) {
    if (!isPlausibleHandle(body.handle)) {
      throw new ProblemError("VALIDATION_FAILED", {
        detail: "A provider handle is 2-64 characters of letters, digits, hyphen or underscore.",
      });
    }
    const outcome = await linkAccount(auth!.actorId, body.provider as ProviderSlug, body.handle);
    return {
      // 200 when it already existed, so a retry is visibly not a new resource.
      status: outcome.existed ? 200 : 201,
      data: outcome.account,
      resource: { type: "linked_account", id: outcome.account.id },
    };
  },
};

const unlinkRoute: RouteDefinition<never, never, { id: string; status: string }> = {
  method: "DELETE",
  path: "/v1/me/accounts/:accountId",
  operationId: "disconnectAccount",
  summary: "Disconnect a linked account and close its subject membership",
  description:
    "Nothing is deleted. The link is marked disconnected and its membership closed, so past analysis stays explainable.",
  kind: "command",
  auth: "required",
  idempotency: "key",
  envelope: "resource",
  successStatus: 200,
  dataSchema: z.object({ id: z.string(), status: z.string() }),
  async handler({ auth, params }) {
    const accountId = params.accountId;
    const done = await disconnectAccount(auth!.actorId, accountId);
    if (!done) {
      // An account owned by someone else is invisible under RLS, so this is a
      // 404 rather than a 403: existence itself is private.
      throw new ProblemError("NOT_FOUND", {
        detail: "No linked account with that id is connected to this actor.",
      });
    }
    return { data: { id: accountId, status: "disconnected" }, resource: { type: "linked_account", id: accountId } };
  },
};

const lookupRoute: RouteDefinition<never, never, z.infer<typeof publicProfileSchema>> = {
  method: "GET",
  path: "/v1/players/:handle",
  operationId: "lookupPlayer",
  summary: "Look up an opt-in public player profile",
  description:
    "Returns only the explicit public projection. A profile that has not opted into discovery is indistinguishable from one that does not exist.",
  kind: "read",
  auth: "public",
  envelope: "resource",
  successStatus: 200,
  dataSchema: publicProfileSchema,
  etag: true,
  cacheControl: "public, max-age=60",
  async handler({ params }) {
    const projection = await lookupPublicProfile(params.handle);
    if (!projection) {
      throw new ProblemError("NOT_FOUND", {
        detail: "No discoverable player has that handle.",
      });
    }
    return { data: projection };
  },
};

export const IDENTITY_ROUTES = [meRoute, linkRoute, unlinkRoute, lookupRoute] as unknown as RouteDefinition<
  never,
  never,
  never
>[];

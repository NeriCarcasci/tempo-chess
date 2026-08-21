/**
 * `/v1/access-request` — the two things an unapproved account may do.
 *
 * These are the only routes in the API declared `access: "self"`, which is what
 * lets an account that has not been let into the closed beta reach them at all.
 * Both are about the caller and nothing else: the identifier is taken from the
 * verified token, there is no parameter naming an account, and
 * `CLIENT_FORBIDDEN_IDENTITY_FIELDS` refuses a body that tries to introduce one.
 *
 * Signing out is the third thing an unapproved account can do and needs no
 * route: the session lives in Supabase Auth and is dropped by the client.
 */

import { z } from "zod";
import { withActorContext } from "../auth/context.js";
import { readAccessRequest, writeAccessNote } from "../../access/service.js";
import { ACCESS_STATES, MAX_NOTE_LENGTH } from "../../access/contract.js";
import { ProblemError } from "../problem.js";
import { POLICIES } from "../rate-limit.js";
import type { RouteDefinition } from "../registry.js";

const accessRequestSchema = z.object({
  state: z.enum(ACCESS_STATES),
  note: z.string().nullable(),
  requestedAt: z.string(),
  noteUpdatedAt: z.string().nullable(),
  decidedAt: z.string().nullable(),
  /**
   * What an operator wrote when they decided.
   *
   * Carried so a decline can say something specific when there is something
   * specific to say. Null is the normal case, and the screen says the plain
   * thing rather than inventing a reason to fill the space.
   */
  decisionNote: z.string().nullable(),
});

type AccessRequestBody = z.infer<typeof accessRequestSchema>;

const readRoute: RouteDefinition<never, never, AccessRequestBody> = {
  method: "GET",
  path: "/v1/access-request",
  operationId: "getAccessRequest",
  summary: "The signed-in account's own request to join the closed beta",
  description:
    "Readable by an account that has not been approved; it is how that account learns whether it is waiting or was declined. Answers only for the caller.",
  kind: "read",
  auth: "required",
  access: "self",
  envelope: "resource",
  successStatus: 200,
  dataSchema: accessRequestSchema,
  rateLimits: [{ policy: POLICIES.accessRead, source: "actor" }],
  // Private and uncached. Somebody watching this screen is waiting for it to
  // change, and a cached copy of "you are still waiting" is the one answer that
  // must never be stale.
  cacheControl: "private, no-store",
  async handler({ auth }) {
    const request = await withActorContext(auth!.actorId, (tx) =>
      readAccessRequest(tx, auth!.actorId),
    );
    if (!request) {
      // The row is created when the authorization context is built, so reaching
      // here means it was created and then read back as absent -- the actor
      // context not being bound. A 404 would tell the client to stop asking,
      // which is exactly wrong for a transient fault.
      throw new ProblemError("INTERNAL_ERROR");
    }
    return { data: request };
  },
};

const noteBodySchema = z.object({
  /**
   * Their sentence about themselves.
   *
   * Optional at the schema level and empty is allowed, because an empty note is
   * a real edit: somebody who wrote something and wants it gone should be able
   * to remove it rather than being told the field is required.
   */
  note: z.string().max(MAX_NOTE_LENGTH),
});

const writeRoute: RouteDefinition<never, z.infer<typeof noteBodySchema>, AccessRequestBody> = {
  method: "PUT",
  path: "/v1/access-request/note",
  operationId: "setAccessRequestNote",
  summary: "Say something about yourself and your chess, for whoever reads the queue",
  description:
    "Replaces the note on the caller's own access request. Writable while the request is pending or after a decision; it changes no state and grants nothing.",
  kind: "command",
  auth: "required",
  access: "self",
  idempotency: "key",
  envelope: "resource",
  successStatus: 200,
  bodySchema: noteBodySchema,
  dataSchema: accessRequestSchema,
  rateLimits: [{ policy: POLICIES.accessCommand, source: "actor" }],
  async handler({ auth, body }) {
    const updated = await withActorContext(auth!.actorId, (tx) =>
      writeAccessNote(tx, auth!.actorId, body.note),
    );
    return { data: updated, resource: { type: "access_request", id: auth!.profileId } };
  },
};

export const ACCESS_ROUTES = [readRoute, writeRoute] as unknown as RouteDefinition<
  never,
  never,
  never
>[];

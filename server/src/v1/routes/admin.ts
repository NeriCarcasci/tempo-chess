/**
 * `/v1/admin` — the surface the people running Forma use.
 *
 * These routes are on `/v1` rather than on `/internal/v1` because their caller
 * is a person holding a Supabase session, and the internal surface authenticates
 * Google-signed service accounts instead. They appear in the OpenAPI document
 * for the same reason every other route does: the document describes what is
 * running, and hiding an endpoint from it would not make it unreachable. What
 * makes it unreachable is `withOperatorContext`, which asks the database whether
 * the caller is an operator and is refused by it if not.
 *
 * Each handler is thin on purpose. The queries are in `access/admin.ts`, where
 * the note about what an operator may and may not see sits beside the SQL that
 * has to honour it.
 */

import { z } from "zod";
import { recordAuditEvent } from "../audit.js";
import { decodeCursor, encodeCursor, resolveLimit, type CursorScope } from "../cursor.js";
import { ProblemError } from "../problem.js";
import { routeKey, type RouteDefinition } from "../registry.js";
import { withOperatorContext } from "../../access/operator.js";
import {
  decideAccessRequest,
  listAccessRequests,
  listAccounts,
  readOperations,
} from "../../access/admin.js";
import {
  ACCESS_DECISIONS,
  ACCESS_STATES,
  MAX_DECISION_NOTE_LENGTH,
  isAccessDecision,
} from "../../access/contract.js";

const USER_ID = z.uuid();

/**
 * A malformed id is a 404, not a validation failure.
 *
 * The same rule the workflow routes follow: an operator surface still should
 * not answer differently for "that is not a uuid" and "no such account", and
 * these routes are the ones a signed-in non-operator would be probing.
 */
function userIdOf(params: Record<string, string>): string {
  const parsed = USER_ID.safeParse(params.userId);
  if (!parsed.success) throw new ProblemError("NOT_FOUND", { detail: "No such account." });
  return parsed.data;
}

// --- pending signups -------------------------------------------------------

const accessRequestSummarySchema = z.object({
  userId: z.string(),
  email: z.string().nullable(),
  state: z.enum(ACCESS_STATES),
  note: z.string().nullable(),
  requestedAt: z.string(),
  joinedAt: z.string().nullable(),
  decidedAt: z.string().nullable(),
  decisionNote: z.string().nullable(),
  marketingSignup: z
    .object({
      platform: z.string(),
      rating: z.string().nullable(),
      goal: z.string().nullable(),
    })
    .nullable(),
});

type AccessRequestSummaryBody = z.infer<typeof accessRequestSummarySchema>;

const listQuery = z.object({
  state: z.enum(ACCESS_STATES).optional(),
  cursor: z.string().max(2_048).optional(),
  limit: z.string().max(4).optional(),
});

const listRequestsRoute: RouteDefinition<
  z.infer<typeof listQuery>,
  never,
  AccessRequestSummaryBody[]
> = {
  method: "GET",
  path: "/v1/admin/access-requests",
  operationId: "listAccessRequests",
  summary: "Accounts waiting to be let into the closed beta",
  description:
    "Oldest request first, so the person who has waited longest is at the top. Requires an operator grant; an approved account without one is refused exactly as an unapproved one is.",
  kind: "read",
  auth: "required",
  access: "operator",
  envelope: "collection",
  successStatus: 200,
  querySchema: listQuery,
  dataSchema: z.array(accessRequestSummarySchema),
  cacheControl: "private, no-store",
  async handler({ query, auth }) {
    const limit = resolveLimit(query.limit);
    const scope: CursorScope = {
      routeKey: routeKey(listRequestsRoute),
      sortKey: "requestedAt:userId",
      filters: { state: query.state ?? null },
    };
    const anchor = query.cursor ? decodeCursor(query.cursor, scope).a : null;

    const rows = await withOperatorContext(auth!.actorId, (tx) =>
      listAccessRequests(tx, {
        state: query.state ?? null,
        after: anchor
          ? { requestedAt: String(anchor[0]), userId: String(anchor[1]) }
          : null,
        // One extra row answers "is there another page" without a second query
        // that could disagree with the first.
        limit: limit + 1,
      }),
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      data: page,
      page: {
        nextCursor:
          hasMore && last ? encodeCursor(scope, [last.requestedAt, last.userId]) : null,
        hasMore,
      },
    };
  },
};

const decisionBodySchema = z.object({
  decision: z.enum(ACCESS_DECISIONS),
  /** Why. Optional, and shown to the person on a decline if it is there. */
  note: z.string().max(MAX_DECISION_NOTE_LENGTH).optional(),
});

const decideRoute: RouteDefinition<
  never,
  z.infer<typeof decisionBodySchema>,
  { userId: string; state: string }
> = {
  method: "POST",
  path: "/v1/admin/access-requests/:userId/decision",
  operationId: "decideAccessRequest",
  summary: "Approve or decline one account",
  description:
    "Writes the decision and appends it to the account's decision history in one transaction. Re-deciding an account is allowed and is recorded as a further decision rather than overwriting the first.",
  kind: "command",
  auth: "required",
  access: "operator",
  idempotency: "key",
  envelope: "resource",
  successStatus: 200,
  bodySchema: decisionBodySchema,
  dataSchema: z.object({ userId: z.string(), state: z.string() }),
  async handler({ auth, body, params, requestId, traceId }) {
    const userId = userIdOf(params);
    // Narrowed rather than cast: the enum is the schema's guarantee, and this
    // is the one place the value crosses into a function that writes it.
    if (!isAccessDecision(body.decision)) {
      throw new ProblemError("VALIDATION_FAILED", { detail: "Decide approved or declined." });
    }
    const note = body.note?.trim();

    const decided = await withOperatorContext(auth!.actorId, (tx) =>
      decideAccessRequest(tx, userId, body.decision, note?.length ? note : null),
    );
    if (!decided) throw new ProblemError("NOT_FOUND", { detail: "No such account." });

    await recordAuditEvent({
      actorKind: "user",
      actorRef: auth!.profileId,
      action: "access.decided",
      targetType: "access_request",
      targetRef: userId,
      requestId,
      traceId,
      result: "allowed",
      reasonCode: body.decision,
    });
    return {
      data: { userId, state: body.decision },
      resource: { type: "access_request", id: userId },
    };
  },
};

// --- accounts --------------------------------------------------------------

const accountSchema = z.object({
  userId: z.string(),
  email: z.string().nullable(),
  joinedAt: z.string(),
  accessState: z.enum(ACCESS_STATES).nullable(),
  linkedAccounts: z.number().int(),
  handles: z.array(z.object({ provider: z.string(), handle: z.string() })),
  hasPublishedReport: z.boolean(),
  onboardingStage: z.string().nullable(),
  onboardingStatus: z.string().nullable(),
  onboardingUpdatedAt: z.string().nullable(),
});

type AccountBody = z.infer<typeof accountSchema>;

const listAccountsRoute: RouteDefinition<z.infer<typeof listQuery>, never, AccountBody[]> = {
  method: "GET",
  path: "/v1/admin/accounts",
  operationId: "listAccounts",
  summary: "Every account, with its access state and how far it has got",
  description:
    "Newest first. Counts and states rather than content: whether a chess account is linked and whether a report exists, never the games or the report itself.",
  kind: "read",
  auth: "required",
  access: "operator",
  envelope: "collection",
  successStatus: 200,
  querySchema: listQuery,
  dataSchema: z.array(accountSchema),
  cacheControl: "private, no-store",
  async handler({ query, auth }) {
    const limit = resolveLimit(query.limit);
    const scope: CursorScope = {
      routeKey: routeKey(listAccountsRoute),
      sortKey: "joinedAt:userId",
      filters: { state: query.state ?? null },
    };
    const anchor = query.cursor ? decodeCursor(query.cursor, scope).a : null;

    const rows = await withOperatorContext(auth!.actorId, (tx) =>
      listAccounts(tx, {
        state: query.state ?? null,
        after: anchor ? { joinedAt: String(anchor[0]), userId: String(anchor[1]) } : null,
        limit: limit + 1,
      }),
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      data: page.map((row) => ({ ...row, handles: [...row.handles] })),
      page: {
        nextCursor: hasMore && last ? encodeCursor(scope, [last.joinedAt, last.userId]) : null,
        hasMore,
      },
    };
  },
};

// --- operations ------------------------------------------------------------

const operationsSchema = z.object({
  onboarding: z.array(
    z.object({
      userId: z.string(),
      email: z.string().nullable(),
      stage: z.string(),
      startedAt: z.string(),
      updatedAt: z.string(),
    }),
  ),
  work: z.array(
    z.object({
      taskType: z.string(),
      status: z.string(),
      count: z.number().int(),
      errorCode: z.string().nullable(),
      oldestAt: z.string().nullable(),
    }),
  ),
  sync: z.array(
    z.object({
      syncRunId: z.string(),
      handle: z.string().nullable(),
      mode: z.string(),
      state: z.string(),
      startedAt: z.string(),
      finishedAt: z.string().nullable(),
      accepted: z.number().int(),
      duplicate: z.number().int(),
      rejected: z.number().int(),
      rejectionSummary: z.record(z.string(), z.unknown()).nullable(),
      failureClass: z.string().nullable(),
    }),
  ),
});

/**
 * Fixed rather than paged.
 *
 * This is the screen somebody opens at two in the morning to find out why
 * nothing is happening, and the answer is always in the first few rows: the
 * oldest stuck onboarding, the task type with dead items, the most recent sync.
 * A cursor here would be pagination over a diagnostic, which nobody would page
 * through.
 */
const OPERATION_LIMITS = { onboarding: 50, work: 100, sync: 50 } as const;

const operationsRoute: RouteDefinition<never, never, z.infer<typeof operationsSchema>> = {
  method: "GET",
  path: "/v1/admin/operations",
  operationId: "getOperations",
  summary: "Onboarding runs in flight, the work ledger, and sync health",
  description:
    "Three readings that are invisible from every other surface: which accounts are part way through onboarding, which work is dead or waiting to retry and why, and what the last syncs accepted and rejected.",
  kind: "read",
  auth: "required",
  access: "operator",
  envelope: "resource",
  successStatus: 200,
  dataSchema: operationsSchema,
  cacheControl: "private, no-store",
  async handler({ auth }) {
    const operations = await withOperatorContext(auth!.actorId, (tx) =>
      readOperations(tx, OPERATION_LIMITS),
    );
    return {
      data: {
        onboarding: [...operations.onboarding],
        work: [...operations.work],
        sync: [...operations.sync],
      },
    };
  },
};

export const ADMIN_ROUTES = [
  listRequestsRoute,
  decideRoute,
  listAccountsRoute,
  operationsRoute,
] as unknown as RouteDefinition<never, never, never>[];

import { client } from "../../db/client.js";
import { ProblemError } from "../problem.js";
import type { AuthMode, VerifiedToken } from "./verifier.js";

/**
 * Actor, profile, and subject resolution — the authorization primitive the
 * audit records as missing (§7: "no API-level subject authorization primitive").
 *
 * The shape of the rule, from plans/database-architecture.md §3.5: ownership is
 * expressed through subject relationships, never inferred from a name the
 * client sent. So a handler never receives an identifier from the request and
 * decides whether to trust it; it receives a context the kernel built from a
 * verified token, and asks that context whether a subject is in scope.
 */

export interface AuthorizationContext {
  /** Supabase `auth.uid()`. Never client-supplied. */
  actorId: string;
  /** `profiles.id`. Equal to `actorId` in v1; the indirection is deliberate. */
  profileId: string;
  email: string | null;
  plan: "free" | "pro";
  authMode: AuthMode;
  /** Every subject this actor may act on. Empty is a valid, denying state. */
  subjects: readonly string[];
}

/**
 * Resolve the subjects an actor owns.
 *
 * `app.analysis_subjects` does not exist yet — E06 creates it, along with the
 * memberships that let one subject span several linked accounts. Until then the
 * personal subject *is* the profile, because that is genuinely the ownership
 * relationship the current data expresses: every owned row keys to the profile.
 *
 * This is one function rather than a rule spread across call sites precisely so
 * E06 replaces it in one place. It is not a placeholder: the decision it
 * returns is the correct decision for the data that exists.
 */
async function resolveSubjects(profileId: string): Promise<readonly string[]> {
  return [profileId];
}

/**
 * Ensure a profile row exists and read the entitlement off it.
 *
 * Supabase owns `auth.users`; `profiles` is our mirror and everything else keys
 * off it, so a freshly signed-up actor with no row would fail every subsequent
 * query rather than seeing an empty account.
 */
async function ensureProfile(actorId: string, email: string | null): Promise<"free" | "pro"> {
  const rows = await client`
    insert into profiles (id, email)
    values (${actorId}, ${email})
    on conflict (id) do update set email = coalesce(excluded.email, profiles.email)
    returning plan`;
  return rows[0]?.plan === "pro" ? "pro" : "free";
}

export async function buildAuthorizationContext(
  token: VerifiedToken,
): Promise<AuthorizationContext> {
  const plan = await ensureProfile(token.actorId, token.email);
  return {
    actorId: token.actorId,
    profileId: token.actorId,
    email: token.email,
    plan,
    authMode: token.mode,
    subjects: await resolveSubjects(token.actorId),
  };
}

/**
 * The only ownership check.
 *
 * It denies with `FORBIDDEN` rather than `NOT_FOUND`, on purpose: an actor
 * asking about a subject that is not theirs learns nothing about whether it
 * exists, and an actor asking about their own missing subject gets a `404` from
 * the handler that looked it up. Collapsing both into `404` — the prototype's
 * habit — makes an authorization failure indistinguishable from a typo in the
 * logs.
 */
export function authorizeSubject(context: AuthorizationContext, subjectId: string): void {
  if (!subjectId || !context.subjects.includes(subjectId)) {
    throw new ProblemError("FORBIDDEN", {
      detail: "That does not belong to your account.",
    });
  }
}

/** The identity fields a client may never send. Sending one is a validation failure. */
export const CLIENT_FORBIDDEN_IDENTITY_FIELDS = [
  "userId",
  "user_id",
  "profileId",
  "profile_id",
  "subjectId",
  "subject_id",
  "actorId",
  "actor_id",
  "ownerUserId",
  "owner_user_id",
] as const;

/**
 * Refuse a request that tries to name whose data it wants.
 *
 * Ignoring the field would be safe today and a trap tomorrow: the first handler
 * that reads `body.userId` for an unrelated purpose turns a silently ignored
 * field into an authorization bypass. Rejecting makes that impossible and tells
 * the client exactly what it did wrong.
 */
export function assertNoClientIdentity(input: unknown, location: "body" | "query"): void {
  if (input === null || typeof input !== "object") return;
  const offending = CLIENT_FORBIDDEN_IDENTITY_FIELDS.filter((field) =>
    Object.prototype.hasOwnProperty.call(input, field),
  );
  if (offending.length === 0) return;
  throw new ProblemError("VALIDATION_FAILED", {
    detail: "Identity comes from your access token; it cannot be set on a request.",
    errors: offending.map((field) => ({
      path: `${location}.${field}`,
      code: "CLIENT_SUPPLIED_IDENTITY",
      message: "this field is derived from the access token",
    })),
  });
}

/**
 * Run `fn` inside a transaction carrying the verified actor.
 *
 * E02 created `private.set_actor_context(uuid)`, which is transaction-local, so
 * a pooled connection cannot carry an actor from one request into the next.
 * E01's data-plane policies say tenant enforcement stays in the API "until E03
 * propagates actor context" — this is that propagation.
 *
 * It is defence in depth and nothing more. PostgreSQL lets any connected role
 * set a custom setting, so a policy that trusted the actor alone would trust
 * the connecting role; the API's own authorization is still the boundary.
 */
export async function withActorContext<T>(
  actorId: string,
  fn: (tx: typeof client) => Promise<T>,
): Promise<T> {
  return client.begin(async (tx) => {
    await tx`select private.set_actor_context(${actorId}::uuid)`;
    return fn(tx as unknown as typeof client);
  }) as Promise<T>;
}

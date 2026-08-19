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
 * E06 created `app.analysis_subjects`, so this now reads the real relationship
 * rather than standing in for it.
 *
 * The profile id is still included. Legacy rows in `public` key to the profile
 * and have not been backfilled onto a subject yet, so dropping it would make an
 * actor's existing data unreachable the moment this shipped. Both are returned
 * until that backfill lands, which is a scoped, deletable line rather than a
 * rule spread across call sites.
 */
async function resolveSubjects(profileId: string): Promise<readonly string[]> {
  const rows = await client<{ id: string }[]>`
    select id from app.analysis_subjects
    where owner_user_id = ${profileId}::uuid and status = 'active'
  `;
  const subjects = rows.map((row) => row.id);
  return subjects.includes(profileId) ? subjects : [profileId, ...subjects];
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

/**
 * Ensure the account has an `app`-side profile and a personal subject.
 *
 * E06 introduced `app.profiles` and `app.analysis_subjects`, and 0017 backfilled
 * one of each for every legacy profile that existed at the time. Nothing was
 * ever written to create them for an account that signed up *afterwards* --
 * every insert in the tree outside this function is a test fixture or a gate.
 *
 * The effect was that a new account got its legacy `public.profiles` row from
 * `ensureProfile` above and nothing else, so `resolveSubjects` returned no
 * subject and every `/v1` read answered as if the account were empty. Not an
 * error, which is what made it survive: an empty account and an account the
 * product forgot to create look identical from the outside.
 *
 * It runs inside the actor context because both tables force row level security
 * against `private.current_actor_id()`, which is null on an unbound connection
 * -- so an insert off the pool is silently refused by the policy rather than
 * failing loudly.
 */
async function ensureSubject(actorId: string): Promise<void> {
  await withActorContext(actorId, async (tx) => {
    await tx`
      insert into app.profiles (user_id) values (${actorId}::uuid)
      on conflict (user_id) do nothing`;
    // One personal subject per owner. `where not exists` rather than an upsert:
    // there is no unique constraint on (owner_user_id, kind), because a person
    // may legitimately own more than one subject later, and inventing one here
    // would be a schema decision made by an auth helper.
    await tx`
      insert into app.analysis_subjects (kind, owner_user_id, display_label)
      select 'personal', ${actorId}::uuid, 'My games'
      where not exists (
        select 1 from app.analysis_subjects
        where owner_user_id = ${actorId}::uuid and kind = 'personal' and status = 'active'
      )`;
  });
}

export async function buildAuthorizationContext(
  token: VerifiedToken,
): Promise<AuthorizationContext> {
  const plan = await ensureProfile(token.actorId, token.email);
  await ensureSubject(token.actorId);
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
/**
 * The caller's analysis subject, or null when they have none.
 *
 * `AuthorizationContext.subjects` deliberately mixes two kinds of id: the
 * profile id, for legacy `public` rows that key to it, and the real
 * `app.analysis_subjects` ids. That mix is correct for `authorizeSubject`,
 * which only asks "may this actor touch this id" — and wrong for anything that
 * needs *the* subject, because the profile id is always element zero. A route
 * reaching for `subjects[0]` gets a profile uuid, queries
 * `where subject_id = <profile uuid>`, matches nothing, and reports an empty
 * account rather than an error.
 *
 * Takes the transaction rather than the shared client on purpose:
 * `app.analysis_subjects` carries `force row level security` with a policy on
 * `private.current_actor_id()`, which is null outside a bound transaction. Read
 * off the pool, this returns zero rows every time.
 */
export async function resolveAnalysisSubject(
  sql: typeof client,
  profileId: string,
): Promise<string | null> {
  const rows = await sql<{ id: string }[]>`
    select id from app.analysis_subjects
    where owner_user_id = ${profileId}::uuid and status = 'active'
    order by created_at asc
    limit 1
  `;
  return rows[0]?.id ?? null;
}

export async function withActorContext<T>(
  actorId: string,
  fn: (tx: typeof client) => Promise<T>,
): Promise<T> {
  return client.begin(async (tx) => {
    await tx`select private.set_actor_context(${actorId}::uuid)`;
    return fn(tx as unknown as typeof client);
  }) as Promise<T>;
}

/**
 * What an operator may read, and nothing beside it.
 *
 * Every query in this file runs inside `withOperatorContext`, which binds the
 * transaction-local operator flag 0039 introduced. Without that flag the five
 * SELECT policies match no row and each of these returns an empty result rather
 * than raising — the same failure shape as an unbound actor, and the reason the
 * transaction is a parameter here rather than something a caller may forget.
 *
 * ## What is deliberately absent
 *
 * There is no query here that reads a game, a move, the body of a report, a
 * goal or a practice attempt, and 0039 grants no policy that would let one
 * work. An operator can see that somebody linked an account, that a report
 * exists, and which stage their onboarding reached. Verified against the live
 * database with the operator context bound: `chess.subject_games` and
 * `analysis.runs` both read zero, which is everything that attributes chess to
 * a person.
 *
 * The precise claim is worth stating, because a looser one would be wrong.
 * `analysis.position_evaluations` and `chess.core_positions` are readable, and
 * were before this file existed: they carry no row level security because they
 * are a position-keyed cache with no person column at all. A row there says
 * what an engine thinks of a FEN, not who reached it. Attribution lives in
 * `subject_games` and `runs`, and both are closed here. So an operator can
 * learn that a position has been evaluated and cannot learn whose game it came
 * from.
 *
 * The rule behind the rest is: prefer the count when the count answers the
 * question. "Has this person got a report" is what an approval queue and a
 * stuck-onboarding page actually ask. "What does their report say" is not a
 * question the people running Forma need answered in order to run it, so the
 * data to answer it is not reachable from here.
 *
 * The one identifier that is legible is the email address, because a decision
 * about who to let in cannot be made about an anonymous uuid. It is read from
 * the legacy `public.profiles` mirror, which is already role-scoped rather than
 * actor-scoped, so no policy was widened to obtain it and no second copy of the
 * address exists to drift.
 */

import type { client } from "../db/client.js";
import { isoOf, requiredIso } from "../db/timestamps.js";
import type { AccessDecision, AccessState } from "./contract.js";

// --- pending signups -------------------------------------------------------

export interface AccessRequestSummary {
  userId: string;
  email: string | null;
  state: AccessState;
  /** What they wrote about themselves. The reason the queue is decidable. */
  note: string | null;
  requestedAt: string;
  joinedAt: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  /**
   * What the same address said on the marketing form, when it said anything.
   *
   * Context for a decision, never a grant. `public.beta_signups` is written by
   * an unauthenticated endpoint against a self-asserted address, so a match
   * here means "somebody who typed this address also filled in our form" and
   * not "this account is the person who filled it in". Shown, never trusted.
   */
  marketingSignup: { platform: string; rating: string | null; goal: string | null } | null;
}

interface RequestRow {
  user_id: string;
  email: string | null;
  state: string;
  note: string | null;
  requested_at: string | Date;
  joined_at: string | Date | null;
  decided_at: string | Date | null;
  decision_note: string | null;
  signup_platform: string | null;
  signup_rating: string | null;
  signup_goal: string | null;
}

function toSummary(row: RequestRow): AccessRequestSummary {
  return {
    userId: row.user_id,
    email: row.email,
    state: row.state as AccessState,
    note: row.note,
    requestedAt: requiredIso(row.requested_at, "access_requests.requested_at"),
    joinedAt: isoOf(row.joined_at),
    decidedAt: isoOf(row.decided_at),
    decisionNote: row.decision_note,
    marketingSignup: row.signup_platform
      ? { platform: row.signup_platform, rating: row.signup_rating, goal: row.signup_goal }
      : null,
  };
}

export interface AccessRequestQuery {
  state: AccessState | null;
  /** Keyset anchor: the last row's `(requestedAt, userId)`. */
  after: { requestedAt: string; userId: string } | null;
  limit: number;
}

/**
 * The queue, oldest request first.
 *
 * Ascending rather than newest first, which is the opposite of every other
 * collection in this API and is the right way round for a queue: the person who
 * has been waiting longest is the one an operator should see at the top. A
 * pending list sorted newest first is how somebody waits three weeks behind a
 * page nobody scrolls.
 */
export async function listAccessRequests(
  tx: typeof client,
  query: AccessRequestQuery,
): Promise<AccessRequestSummary[]> {
  const rows = await tx<RequestRow[]>`
    select
      r.user_id,
      lp.email,
      r.state,
      r.note,
      r.requested_at,
      ap.created_at as joined_at,
      r.decided_at,
      r.decision_note,
      bs.platform as signup_platform,
      bs.rating as signup_rating,
      bs.goal as signup_goal
    from app.access_requests r
    join app.profiles ap on ap.user_id = r.user_id
    left join public.profiles lp on lp.id = r.user_id
    left join public.beta_signups bs on lower(bs.email) = lower(lp.email)
    where (${query.state}::text is null or r.state = ${query.state})
      and (
        ${query.after?.requestedAt ?? null}::timestamptz is null
        or (r.requested_at, r.user_id)
             > (${query.after?.requestedAt ?? null}::timestamptz, ${query.after?.userId ?? null}::uuid)
      )
    order by r.requested_at asc, r.user_id asc
    limit ${query.limit}`;
  return rows.map(toSummary);
}

/**
 * Approve or decline one account.
 *
 * The whole transition is one call into `private.decide_access_request`, which
 * reads the decider from the bound operator context, re-checks it against
 * `app.operators`, and writes the history row in the same statement.
 * `forma_api` holds no update grant on `app.access_requests.state`, so there is
 * no second path that could write a decision without recording it.
 *
 * There is deliberately no operator argument. Who approved this is a fact the
 * database already holds; passing it in would make it a value this file could
 * get wrong, and `decided_by` is the last field in the system that should be
 * settable by the caller doing the approving.
 *
 * False means the account has no request row, or the caller stopped being an
 * operator between binding the context and issuing this. Both are refusals, and
 * the caller turns them into the same one.
 */
export async function decideAccessRequest(
  tx: typeof client,
  userId: string,
  decision: AccessDecision,
  note: string | null,
): Promise<boolean> {
  const rows = await tx<{ decided: boolean }[]>`
    select private.decide_access_request(${userId}::uuid, ${decision}, ${note}) as decided`;
  return rows[0]?.decided === true;
}

// --- accounts --------------------------------------------------------------

export interface AccountSummary {
  userId: string;
  email: string | null;
  joinedAt: string;
  accessState: AccessState | null;
  /** Links that have not been disconnected. A count, not the accounts. */
  linkedAccounts: number;
  /** The handles those links play under. Public provider usernames. */
  handles: readonly { provider: string; handle: string }[];
  hasPublishedReport: boolean;
  /** The stage of their most recent onboarding run, or null if they never began. */
  onboardingStage: string | null;
  onboardingStatus: string | null;
  onboardingUpdatedAt: string | null;
}

interface AccountRow {
  user_id: string;
  email: string | null;
  joined_at: string | Date;
  access_state: string | null;
  linked_accounts: string | number;
  handles: { provider: string; handle: string }[] | null;
  has_published_report: boolean;
  onboarding_stage: string | null;
  onboarding_status: string | null;
  onboarding_updated_at: string | Date | null;
}

export interface AccountQuery {
  state: AccessState | null;
  after: { joinedAt: string; userId: string } | null;
  limit: number;
}

/**
 * Every account, newest first.
 *
 * `handles` comes from `app.provider_identities`, which is not tenant-scoped —
 * it is the shared record of a provider username, and two people may hold a
 * link to the same one. Reading it here discloses nothing about either of them
 * that the provider does not publish.
 */
export async function listAccounts(
  tx: typeof client,
  query: AccountQuery,
): Promise<AccountSummary[]> {
  const rows = await tx<AccountRow[]>`
    select
      ap.user_id,
      lp.email,
      ap.created_at as joined_at,
      r.state as access_state,
      coalesce(la.count, 0) as linked_accounts,
      la.handles,
      coalesce(pub.published, false) as has_published_report,
      ob.stage as onboarding_stage,
      ob.status as onboarding_status,
      ob.updated_at as onboarding_updated_at
    from app.profiles ap
    left join public.profiles lp on lp.id = ap.user_id
    left join app.access_requests r on r.user_id = ap.user_id
    left join lateral (
      select count(*)::int as count,
             coalesce(
               jsonb_agg(jsonb_build_object('provider', pr.slug, 'handle', pi.current_display_username))
                 filter (where pi.current_display_username is not null),
               '[]'::jsonb
             ) as handles
      from app.linked_accounts l
      join app.provider_identities pi on pi.id = l.provider_identity_id
      join app.providers pr on pr.id = pi.provider_id
      where l.owner_user_id = ap.user_id and l.status <> 'disconnected'
    ) la on true
    left join lateral (
      select true as published
      from app.analysis_subjects s
      join analysis.subject_live_publications p on p.subject_id = s.id
      where s.owner_user_id = ap.user_id
      limit 1
    ) pub on true
    left join lateral (
      select o.stage, o.status, o.updated_at
      from coaching.onboarding_runs o
      where o.user_id = ap.user_id
      order by o.created_at desc
      limit 1
    ) ob on true
    where (${query.state}::text is null or r.state = ${query.state})
      and (
        ${query.after?.joinedAt ?? null}::timestamptz is null
        or (ap.created_at, ap.user_id)
             < (${query.after?.joinedAt ?? null}::timestamptz, ${query.after?.userId ?? null}::uuid)
      )
    order by ap.created_at desc, ap.user_id desc
    limit ${query.limit}`;
  return rows.map((row) => ({
    userId: row.user_id,
    email: row.email,
    joinedAt: requiredIso(row.joined_at, "app.profiles.created_at"),
    accessState: (row.access_state as AccessState | null) ?? null,
    linkedAccounts: Number(row.linked_accounts),
    handles: row.handles ?? [],
    hasPublishedReport: row.has_published_report === true,
    onboardingStage: row.onboarding_stage,
    onboardingStatus: row.onboarding_status,
    onboardingUpdatedAt: isoOf(row.onboarding_updated_at),
  }));
}

// --- operations ------------------------------------------------------------

export interface OnboardingInFlight {
  userId: string;
  email: string | null;
  stage: string;
  startedAt: string;
  updatedAt: string;
}

export interface WorkTally {
  taskType: string;
  status: string;
  count: number;
  /** Present on `dead` and `retry_wait` rows: the reason, from the closed set. */
  errorCode: string | null;
  oldestAt: string | null;
}

export interface SyncHealth {
  syncRunId: string;
  handle: string | null;
  mode: string;
  state: string;
  startedAt: string;
  finishedAt: string | null;
  accepted: number;
  duplicate: number;
  rejected: number;
  /** Counts by reason. Never a game id, url or replay: the ledger holds none. */
  rejectionSummary: Record<string, unknown> | null;
  failureClass: string | null;
}

export interface Operations {
  onboarding: readonly OnboardingInFlight[];
  work: readonly WorkTally[];
  sync: readonly SyncHealth[];
}

/**
 * The three things worth looking at when somebody says nothing is happening.
 *
 * All three read tables that are role-scoped rather than actor-scoped, so none
 * of them needed a new policy: `ops.work_items` carries `using (true)` for the
 * runtime roles by design, and `coaching.onboarding_runs` and `ops.sync_runs`
 * carry no row level security at all. The last of those is a gap in the tenancy
 * model rather than a licence — it predates this work, it is noted in the plan,
 * and the query below is scoped to what an operator needs regardless of what
 * the table would allow.
 *
 * Sync health is here because a stuck cursor is invisible from every other
 * surface. An archive once stopped importing at 196 games of 337 and the run
 * reported success; `accepted` beside `rejected` and the rejection tally is the
 * reading that would have shown it.
 */
export async function readOperations(
  tx: typeof client,
  limits: { onboarding: number; work: number; sync: number },
): Promise<Operations> {
  const onboarding = await tx<
    { user_id: string; email: string | null; stage: string; created_at: string | Date; updated_at: string | Date }[]
  >`
    select o.user_id, lp.email, o.stage, o.created_at, o.updated_at
    from coaching.onboarding_runs o
    left join public.profiles lp on lp.id = o.user_id
    where o.status = 'active'
    order by o.updated_at asc
    limit ${limits.onboarding}`;

  // Grouped by the three columns an operator acts on. `error_code` is in the
  // key rather than aggregated away because "eleven dead" is not actionable and
  // "eleven dead, all provider_rate_limited" is.
  const work = await tx<
    { task_type: string; status: string; error_code: string | null; count: string | number; oldest_at: string | Date | null }[]
  >`
    select task_type, status, error_code, count(*)::int as count, min(updated_at) as oldest_at
    from ops.work_items
    where status <> 'succeeded'
    group by task_type, status, error_code
    order by
      case status when 'dead' then 0 when 'retry_wait' then 1 else 2 end,
      count(*) desc
    limit ${limits.work}`;

  const sync = await tx<
    {
      id: string;
      handle: string | null;
      mode: string;
      state: string;
      started_at: string | Date;
      finished_at: string | Date | null;
      games_accepted: number;
      games_duplicate: number;
      games_rejected: number;
      rejection_summary: Record<string, unknown> | null;
      failure_class: string | null;
    }[]
  >`
    select s.id, pi.current_display_username as handle, s.mode, s.state, s.started_at, s.finished_at,
           s.games_accepted, s.games_duplicate, s.games_rejected, s.rejection_summary, s.failure_class
    from ops.sync_runs s
    left join app.linked_accounts l on l.id = s.linked_account_id
    left join app.provider_identities pi on pi.id = l.provider_identity_id
    order by s.started_at desc
    limit ${limits.sync}`;

  return {
    onboarding: onboarding.map((row) => ({
      userId: row.user_id,
      email: row.email,
      stage: row.stage,
      startedAt: requiredIso(row.created_at, "onboarding_runs.created_at"),
      updatedAt: requiredIso(row.updated_at, "onboarding_runs.updated_at"),
    })),
    work: work.map((row) => ({
      taskType: row.task_type,
      status: row.status,
      count: Number(row.count),
      errorCode: row.error_code,
      oldestAt: isoOf(row.oldest_at),
    })),
    sync: sync.map((row) => ({
      syncRunId: row.id,
      handle: row.handle,
      mode: row.mode,
      state: row.state,
      startedAt: requiredIso(row.started_at, "sync_runs.started_at"),
      finishedAt: isoOf(row.finished_at),
      accepted: Number(row.games_accepted),
      duplicate: Number(row.games_duplicate),
      rejected: Number(row.games_rejected),
      rejectionSummary: row.rejection_summary,
      failureClass: row.failure_class,
    })),
  };
}

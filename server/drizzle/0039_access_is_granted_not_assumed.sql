-- 0039_access_is_granted_not_assumed
--
-- Close the product behind a human decision, and give an operator the narrowest
-- cross-account view that lets them make it.
--
-- Hand-written and reviewed. Two new tables, two new `private` helpers, five
-- SELECT policies and a column-scoped grant. No existing row is rewritten
-- except by the one backfill described below, which is idempotent. Every
-- `create policy` is dropped first, because `create policy` is not idempotent
-- on its own and a migration that claims to be re-runnable has to be.
--
-- ## What changes
--
-- Signing up no longer grants access. An authenticated account starts
-- `pending`, and `/v1` refuses it everything except reading its own state and
-- writing the sentence it wants an operator to read. An operator approves or
-- declines. Until then the account can authenticate and do nothing, which is
-- the point: an unapproved account that could start an examination would spend
-- real engine money before anybody had agreed to let it in.
--
-- ## Why a table and not a column on app.profiles
--
-- This is access control, so the question "who decided, and when, and had they
-- decided differently before" has to survive. A boolean column answers none of
-- it. `app.access_requests` holds the current state and `app.access_decisions`
-- is append-only beside it, so a decline that was later reversed is still
-- legible rather than overwritten.
--
-- The request row also carries the note the person wrote about themselves. That
-- lives here rather than in `public.beta_signups` because the two are different
-- things: a beta signup is an unauthenticated marketing capture keyed on a
-- self-asserted email, and reusing it as an access gate would mean anyone who
-- could type an already-approved address into a public form could grant
-- themselves the product. They stay separate. The admin surface may show a
-- signup beside a request as context, and may never derive access from one.
--
-- ## The hard part: how an operator reads across accounts
--
-- Every tenant table carries `force row level security` with a policy of the
-- shape `owner_user_id = private.current_actor_id()`. On a connection with no
-- bound actor that function is null, the policy matches no row, and the table
-- reads as empty rather than raising. An operator surveying pending requests
-- has no single actor it could bind: binding one would hide every other
-- account, which is the question it was asked. This is the same shape of
-- problem 0036 solved for the planner.
--
-- Three ways to solve it were considered and two were rejected:
--
--   * Bind an arbitrary actor. Rejected: it answers the wrong question and it
--     puts a real person's id on a query that is not about them.
--   * A second least-privilege role with a connection of its own, which is what
--     0036 did for `forma_ops`. Rejected on a counted constraint rather than a
--     preference: `platform/connection.ts` budgets 42 of the 43 runtime
--     connections this project has, and a role reachable from `forma-api` would
--     need `maxInstances * poolPerInstance` more. There is one spare. A role
--     that cannot be connected as is not a boundary, it is a comment.
--
-- What is here instead is a transaction-local operator context, the same
-- mechanism as `private.set_actor_context` and subject to the same honest
-- caveat: it is defence in depth, and the API's own authorization is still the
-- boundary. It is narrower than the alternatives in two ways that matter.
--
-- First, `private.set_operator_context` is `security definer` and checks
-- `app.operators` itself. `forma_api` holds no grant on that table and cannot
-- read it, so the API cannot mint an operator, and cannot set the flag for
-- somebody who is not one. The database decides who is an operator; the API
-- only asks.
--
-- Second, the policies are SELECT only, on five named tables, `to forma_api`
-- only, and each additionally requires the operator flag. An ordinary request
-- never sets the flag, so an ordinary request sees exactly what it saw before
-- this file: its own rows.
--
-- ## What an operator can see, and what it still cannot
--
-- Can: that a request exists and what it says, when an account was created,
-- whether it has an active linked account and under which provider handle,
-- whether it has a live published report, and which onboarding stage it is in.
-- Counts and states.
--
-- Cannot: games, moves, PGN, positions, evaluations, the contents of any
-- report, goals, practice attempts, artifacts or billing rows. None of those
-- tables gets a policy here, so every one of them reads as empty under the
-- operator flag exactly as it does today. An operator can tell that somebody is
-- stuck; they cannot read that person's chess.
--
-- One pre-existing exception is worth naming rather than leaving to be
-- discovered: the legacy `public` schema is role-scoped, not actor-scoped --
-- `public.profiles` and `public.beta_signups` already carry
-- `..._forma_api_service_dataplane` policies of `using (true)`. The admin
-- surface reads the account's email from `public.profiles` for that reason,
-- rather than copying the address into `app.access_requests`: 0016 deliberately
-- left login email authoritative in Auth and did not duplicate it into `app`,
-- and a second copy that drifts is worse than a join. This file widens nothing
-- there.
--
-- ## The backfill
--
-- Every account that already has an `app.profiles` row is approved, with a null
-- decider. Not a chosen list and not a hardcoded id: the one real account today
-- is the owner's, and a migration that shipped a closed door in front of the
-- person who built it would be a self-inflicted outage. Null `decided_by` means
-- "this file decided", which is true, and is distinguishable from a person
-- having decided.
--
-- Accounts created after this runs start `pending`, which is the whole point.

set local role forma_migrator
--> statement-breakpoint
-- Who may act as an operator.
--
-- Deliberately NOT `force row level security`. Every other table here forces
-- it, and forcing it on this one would be a silent, total failure: the decision
-- helpers below are `security definer` and therefore run as this table's owner,
-- forced RLS binds the owner too, the operator lookup would match zero rows,
-- and every operator in the system would stop being one while the admin surface
-- reported a clean 403. RLS is enabled with no policy and no runtime grant
-- instead, which denies every role that is not the owner just as completely and
-- leaves the definer functions working.
create table if not exists app.operators (
  user_id uuid primary key references app.profiles(user_id) on delete cascade,
  granted_at timestamptz not null default now(),
  -- Null means this migration granted it. A person is recorded when a person does.
  granted_by uuid references app.profiles(user_id) on delete set null,
  revoked_at timestamptz,
  note text
)
--> statement-breakpoint
comment on table app.operators is 'Who may use the admin surface. Read only by the security-definer helpers in private; no runtime role holds a grant on it, so the API can ask whether the caller is an operator and cannot answer that question for itself.'
--> statement-breakpoint
alter table app.operators enable row level security
--> statement-breakpoint
create table if not exists app.access_requests (
  user_id uuid primary key references app.profiles(user_id) on delete cascade,
  state text not null default 'pending',
  -- What the person wrote about themselves and their chess. The thing that
  -- makes an approval decision possible rather than a coin toss.
  note text,
  requested_at timestamptz not null default now(),
  note_updated_at timestamptz,
  decided_at timestamptz,
  -- Null when 0039 itself decided; see the backfill note above.
  decided_by uuid references app.profiles(user_id) on delete set null,
  decision_note text,
  constraint access_requests_state_check check (state in ('pending', 'approved', 'declined')),
  -- A decided row has a decision time and a pending one does not. Without this
  -- a half-written decision reads as pending while the state says otherwise,
  -- and the gate would let an account through on a row nobody finished writing.
  constraint access_requests_decided_together check ((state = 'pending') = (decided_at is null))
)
--> statement-breakpoint
comment on table app.access_requests is 'One access decision per account, and the note the account wrote to argue for it. The current state only; every decision ever taken is a row in app.access_decisions.'
--> statement-breakpoint
create index if not exists access_requests_pending
  on app.access_requests (requested_at) where state = 'pending'
--> statement-breakpoint
create table if not exists app.access_decisions (
  id bigint generated always as identity primary key,
  user_id uuid not null references app.profiles(user_id) on delete cascade,
  state text not null,
  decided_at timestamptz not null default now(),
  decided_by uuid references app.profiles(user_id) on delete set null,
  note text,
  constraint access_decisions_state_check check (state in ('approved', 'declined'))
)
--> statement-breakpoint
comment on table app.access_decisions is 'Append-only history of access decisions. A decline later reversed stays readable here; app.access_requests keeps only the current answer.'
--> statement-breakpoint
create index if not exists access_decisions_user on app.access_decisions (user_id, decided_at desc)
--> statement-breakpoint
alter table app.access_requests enable row level security
--> statement-breakpoint
alter table app.access_requests force row level security
--> statement-breakpoint
alter table app.access_decisions enable row level security
--> statement-breakpoint
alter table app.access_decisions force row level security
--> statement-breakpoint
-- --- the operator context ---------------------------------------------------
--
-- Mirrors private.current_actor_id(): transaction-local, null when unset, and a
-- malformed setting is treated as unset rather than as a wildcard.
create or replace function private.current_operator_id()
returns uuid
language sql
stable
security invoker
set search_path = ''
as $function$
  select case
    when pg_catalog.current_setting('forma.operator_id', true)
      ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then pg_catalog.current_setting('forma.operator_id', true)::uuid
    else null
  end
$function$
--> statement-breakpoint
comment on function private.current_operator_id() is 'The operator bound to the current transaction, or null when none is bound. Null denies: every policy that reads it is written so that null matches no row.'
--> statement-breakpoint
-- Bind an operator, if the actor really is one.
--
-- `security definer` is the whole design. forma_api has no grant on
-- app.operators, so it cannot read the list and cannot decide the answer; it
-- calls this and is told. Returns false rather than raising so the API can turn
-- a non-operator into a 403 problem document instead of a 500.
create or replace function private.set_operator_context(p_actor_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  granted boolean;
begin
  if p_actor_id is null then
    raise exception 'operator context requires a non-null actor id' using errcode = '22004';
  end if;
  select true into granted
  from app.operators
  where user_id = p_actor_id and revoked_at is null;
  if granted is not true then
    return false;
  end if;
  perform pg_catalog.set_config('forma.operator_id', p_actor_id::text, true);
  return true;
end
$function$
--> statement-breakpoint
comment on function private.set_operator_context(uuid) is 'Bind the caller as an operator for this transaction, if app.operators says they are one. Transaction-local, so a pooled connection cannot carry the flag into the next request. Security definer because the API must not be able to read or write the operator list it is being judged against.'
--> statement-breakpoint
-- Record a decision.
--
-- The state transition lives here rather than in an UPDATE the API issues,
-- because RLS cannot restrict columns and a column-level grant cannot tell an
-- operator's UPDATE from an owner's. If `forma_api` held `update (state)` on
-- app.access_requests, the owner policy below -- which exists so a person can
-- edit their own note -- would also let that person approve themselves. It does
-- not hold that grant. This function is the only writer of `state`.
--
-- It takes no operator argument. The decider is read from the bound context,
-- for the same reason `/v1` takes identity from the token and refuses a body
-- that names an account: an identity supplied at the point of use is one a
-- caller can get wrong, and "who approved this" is exactly the field that must
-- not be settable by whoever is doing the approving. The consequence is that a
-- decision is only possible inside a transaction where set_operator_context has
-- already succeeded, and `decided_by` is always the person the database
-- verified rather than the one the handler passed along.
--
-- The operator is re-checked here rather than trusted from the flag, so a
-- grant revoked mid-transaction stops a decision that has not yet been written.
create or replace function private.decide_access_request(
  p_user_id uuid,
  p_state text,
  p_note text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_operator uuid;
  is_operator boolean;
begin
  if p_state not in ('approved', 'declined') then
    raise exception 'an access decision is approved or declined' using errcode = '22023';
  end if;
  v_operator := private.current_operator_id();
  if v_operator is null then
    return false;
  end if;
  select true into is_operator
  from app.operators
  where user_id = v_operator and revoked_at is null;
  if is_operator is not true then
    return false;
  end if;

  update app.access_requests
  set state = p_state,
      decided_at = pg_catalog.now(),
      decided_by = v_operator,
      decision_note = p_note
  where user_id = p_user_id;
  if not found then
    return false;
  end if;

  insert into app.access_decisions (user_id, state, decided_by, note)
  values (p_user_id, p_state, v_operator, p_note);
  return true;
end
$function$
--> statement-breakpoint
comment on function private.decide_access_request(uuid, text, text) is 'Approve or decline one account and append the decision to history, atomically. The only writer of app.access_requests.state: forma_api deliberately holds no update grant on that column, so a user editing their own note cannot approve themselves. The decider comes from the bound operator context, never from an argument.'
--> statement-breakpoint
do $$
declare
  helper text;
  denied_role text;
begin
  foreach helper in array array[
    'private.current_operator_id()',
    'private.set_operator_context(uuid)',
    'private.decide_access_request(uuid, text, text)'
  ] loop
    begin
      execute format('alter function %s owner to forma_migrator', helper);
    exception when insufficient_privilege then
      raise notice '0039: cannot transfer function % to forma_migrator', helper;
    end;
    execute format('revoke all on function %s from public', helper);
    foreach denied_role in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = denied_role) then
        execute format('revoke all on function %s from %I', helper, denied_role);
      end if;
    end loop;
    -- Only the API surface needs these. A worker has no operator, and giving
    -- one the ability to set the flag would widen four policies at once.
    execute format('grant execute on function %s to forma_api', helper);
  end loop;
end
$$
--> statement-breakpoint
-- --- policies ---------------------------------------------------------------
--
-- A person reads and writes their own request. `with check` pins the state to
-- pending on insert, so the row an account creates for itself can never arrive
-- already approved.
drop policy if exists access_requests_owner on app.access_requests
--> statement-breakpoint
create policy access_requests_owner on app.access_requests
  for select to forma_api
  using (user_id = private.current_actor_id())
--> statement-breakpoint
drop policy if exists access_requests_owner_insert on app.access_requests
--> statement-breakpoint
create policy access_requests_owner_insert on app.access_requests
  for insert to forma_api
  with check (
    user_id = private.current_actor_id()
    and state = 'pending'
    and decided_at is null
    and decided_by is null
  )
--> statement-breakpoint
drop policy if exists access_requests_owner_note on app.access_requests
--> statement-breakpoint
create policy access_requests_owner_note on app.access_requests
  for update to forma_api
  using (user_id = private.current_actor_id())
  with check (user_id = private.current_actor_id())
--> statement-breakpoint
comment on policy access_requests_owner_note on app.access_requests is 'Lets a person edit the note they wrote. The columns they may write are fixed by a column-scoped grant, not by this policy: state has no grant at all.'
--> statement-breakpoint
-- The security-definer helpers run as the table owner, and `force row level
-- security` binds the owner. Without this policy `decide_access_request` would
-- update zero rows and report success, and the admin surface would show an
-- approval that never happened.
drop policy if exists access_requests_definer on app.access_requests
--> statement-breakpoint
create policy access_requests_definer on app.access_requests
  as permissive for all to forma_migrator
  using (true) with check (true)
--> statement-breakpoint
drop policy if exists access_decisions_definer on app.access_decisions
--> statement-breakpoint
create policy access_decisions_definer on app.access_decisions
  as permissive for all to forma_migrator
  using (true) with check (true)
--> statement-breakpoint
-- --- the five operator reads ------------------------------------------------
--
-- SELECT only, named tables only, `to forma_api` only, and each one dead unless
-- the operator flag is bound. An ordinary request sets no flag and is unchanged.
drop policy if exists access_requests_operator on app.access_requests
--> statement-breakpoint
create policy access_requests_operator on app.access_requests
  for select to forma_api
  using (private.current_operator_id() is not null)
--> statement-breakpoint
drop policy if exists access_decisions_operator on app.access_decisions
--> statement-breakpoint
create policy access_decisions_operator on app.access_decisions
  for select to forma_api
  using (private.current_operator_id() is not null)
--> statement-breakpoint
-- When the account was created.
drop policy if exists profiles_operator on app.profiles
--> statement-breakpoint
create policy profiles_operator on app.profiles
  for select to forma_api
  using (private.current_operator_id() is not null)
--> statement-breakpoint
-- Whether a chess account is linked, and under which handle. The handle is a
-- public provider username, which is why it is legible here and the games
-- behind it are not.
drop policy if exists linked_accounts_operator on app.linked_accounts
--> statement-breakpoint
create policy linked_accounts_operator on app.linked_accounts
  for select to forma_api
  using (private.current_operator_id() is not null)
--> statement-breakpoint
-- The subject a publication hangs off. Needed to answer "is there a report",
-- and nothing in it describes the analysis.
drop policy if exists analysis_subjects_operator on app.analysis_subjects
--> statement-breakpoint
create policy analysis_subjects_operator on app.analysis_subjects
  for select to forma_api
  using (private.current_operator_id() is not null)
--> statement-breakpoint
-- That a report exists and when it was published. The report's contents live in
-- analysis.runs and the tables under it, none of which gets a policy here.
drop policy if exists subject_live_publications_operator on analysis.subject_live_publications
--> statement-breakpoint
create policy subject_live_publications_operator on analysis.subject_live_publications
  for select to forma_api
  using (private.current_operator_id() is not null)
--> statement-breakpoint
-- --- grants -----------------------------------------------------------------
--
-- By name and by privilege. `grant all` is never correct, and the update grant
-- is by column for the reason given on decide_access_request: `state` is
-- absent, so the API physically cannot write it.
grant select, insert on app.access_requests to forma_api
--> statement-breakpoint
grant update (note, note_updated_at) on app.access_requests to forma_api
--> statement-breakpoint
grant select on app.access_decisions to forma_api
--> statement-breakpoint
-- --- backfill ---------------------------------------------------------------
--
-- From here on the file runs as the deploying owner rather than as
-- `forma_migrator`, exactly as 0017 does, and for the same two reasons.
--
-- `app.profiles` carries `force row level security` with an actor-scoped
-- policy, and forced binds the table owner too. `private.current_actor_id()` is
-- null in a migration, so `forma_migrator` selecting from it matches no row --
-- not an error, an empty result. The grandfathering select below would have
-- returned nothing, every existing account would have stayed `pending`, and the
-- first thing this migration did in production would have been to lock the
-- owner out of their own product while reporting success.
--
-- E01 also left `forma_migrator` no read on the legacy `public` tables, which
-- the operator seed needs. The deploying owner holds that SELECT and carries
-- BYPASSRLS, so it satisfies both without widening a grant or lifting FORCE.
reset role
--> statement-breakpoint
-- Idempotent by construction: only an account with no request row gets one, so
-- re-running this approves nobody twice and reverses no decision.
insert into app.access_requests (user_id, state, requested_at, decided_at, note)
select p.user_id, 'approved', p.created_at, pg_catalog.now(),
       'Account existed before access was gated.'
from app.profiles p
where not exists (select 1 from app.access_requests r where r.user_id = p.user_id)
--> statement-breakpoint
insert into app.access_decisions (user_id, state, note)
select r.user_id, 'approved', 'Grandfathered by migration 0039.'
from app.access_requests r
where r.state = 'approved' and r.decided_by is null
  and not exists (select 1 from app.access_decisions d where d.user_id = r.user_id)
--> statement-breakpoint
-- The first operator. There has to be one, and it cannot come from a route:
-- an endpoint that grants operator status is an escalation path, and the first
-- caller of it would have to already be trusted for it to be safe. Seeded by
-- email against the legacy profile mirror rather than by a literal uuid, so the
-- file is not tied to one database's key. Further operators are granted by SQL
-- by someone who already holds the credential to run one.
insert into app.operators (user_id, note)
select p.id, 'Seeded by migration 0039.'
from public.profiles p
where lower(p.email) = 'nericarcasci@gmail.com'
  and exists (select 1 from app.profiles a where a.user_id = p.id)
on conflict (user_id) do nothing

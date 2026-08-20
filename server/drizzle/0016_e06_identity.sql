-- 0016_e06_identity
--
-- E06 — subjects, provider identities, linked accounts and opt-in discovery.
--
-- Hand-written and reviewed, like 0011 through 0015. Applied by the migration
-- job or `npm run db:migrate`.
--
-- Additive and forward-only. It creates eight tables in the `app` and `social`
-- namespaces E02 established, and touches no row and no object in the legacy
-- `public` schema: `public.profiles` and `public.linked_accounts` keep serving
-- the shipped client until a later epic switches the pointer. Re-running it is
-- a no-op.
--
-- The constraint this epic exists to remove is global handle exclusivity. Two
-- users may link the same provider identity independently, and neither learns
-- of the other: uniqueness lives on (owner_user_id, provider_identity_id), not
-- on provider_identity_id alone.

set local role forma_migrator
--> statement-breakpoint
create table if not exists app.profiles (
  user_id uuid primary key,
  locale text,
  timezone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)
--> statement-breakpoint
comment on table app.profiles is 'One private application profile per auth user (database architecture 7.1). Login email stays authoritative in Auth and is deliberately not duplicated here. Carries no subscription enum and no public discovery field: discovery is social.public_player_profiles and is opt-in.'
--> statement-breakpoint
create table if not exists app.analysis_subjects (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  owner_user_id uuid references app.profiles(user_id) on delete cascade,
  display_label text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint analysis_subjects_kind_check
    check (kind in ('personal', 'editorial', 'case_study')),
  constraint analysis_subjects_status_check
    check (status in ('active', 'archived', 'deleting')),
  -- 7.2: editorial subjects have no user owner; a personal subject must.
  constraint analysis_subjects_owner_check
    check ((kind = 'personal') = (owner_user_id is not null))
)
--> statement-breakpoint
comment on table app.analysis_subjects is 'Whose chess behaviour is being analysed (database architecture 7.2). No subject is identified globally by a provider username; a provider handle is evidence attached through a linked account, never the subject key.'
--> statement-breakpoint
-- 7.2: at most one active personal subject per owner. Partial, so archived and
-- deleting subjects stay for explainability of old snapshots.
create unique index if not exists analysis_subjects_one_active_personal
  on app.analysis_subjects (owner_user_id)
  where kind = 'personal' and status = 'active'
--> statement-breakpoint
create table if not exists app.providers (
  id smallint primary key,
  slug text not null unique,
  display_name text not null,
  has_stable_player_id boolean not null default false,
  has_clocks boolean not null default false,
  has_rating_history boolean not null default false,
  has_oauth boolean not null default false,
  adapter_contract_version integer not null default 1
)
--> statement-breakpoint
comment on table app.providers is 'Reference table rather than a database enum (database architecture 7.3), so adding a provider is a row and not a type migration.'
--> statement-breakpoint
insert into app.providers (id, slug, display_name, has_stable_player_id, has_clocks, has_rating_history, has_oauth)
values
  (1, 'chesscom', 'Chess.com', true, true, true, false),
  (2, 'lichess', 'Lichess', true, true, true, true)
on conflict (id) do nothing
--> statement-breakpoint
create table if not exists app.provider_identities (
  id bigint generated always as identity primary key,
  provider_id smallint not null references app.providers(id),
  provider_identity_key text not null,
  key_basis text not null,
  current_display_username text,
  current_normalized_username text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  provider_deleted_at timestamptz,
  constraint provider_identities_key_basis_check
    check (key_basis in ('provider_id', 'username')),
  constraint provider_identities_key_unique unique (provider_id, provider_identity_key)
)
--> statement-breakpoint
comment on table app.provider_identities is 'One observed identity inside a provider namespace (database architecture 7.4). key_basis records how much the key is worth: a username-keyed identity is lower confidence because providers permit renames and reuse. Many users may reference the same row.'
--> statement-breakpoint
comment on column app.provider_identities.key_basis is 'provider_id when the provider exposes a stable id; username when only a normalized handle was available, which is explicitly weaker evidence.'
--> statement-breakpoint
create index if not exists provider_identities_normalized_username
  on app.provider_identities (provider_id, current_normalized_username)
--> statement-breakpoint
create table if not exists app.provider_identity_aliases (
  id bigint generated always as identity primary key,
  provider_identity_id bigint not null references app.provider_identities(id) on delete cascade,
  display_username text not null,
  normalized_username text not null,
  observed_from timestamptz not null default now(),
  observed_to timestamptz
)
--> statement-breakpoint
comment on table app.provider_identity_aliases is 'Observed username history (database architecture 7.5). A rename is recorded here rather than rewriting old games, so an archived game keeps the handle it was played under.'
--> statement-breakpoint
create index if not exists provider_identity_aliases_identity
  on app.provider_identity_aliases (provider_identity_id)
--> statement-breakpoint
create index if not exists provider_identity_aliases_normalized
  on app.provider_identity_aliases (normalized_username)
--> statement-breakpoint
create table if not exists app.linked_accounts (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references app.profiles(user_id) on delete cascade,
  provider_identity_id bigint not null references app.provider_identities(id),
  connection_kind text not null default 'public_lookup',
  verification_status text not null default 'unverified',
  status text not null default 'active',
  provider_handle_discoverable boolean not null default false,
  created_at timestamptz not null default now(),
  disconnected_at timestamptz,
  constraint linked_accounts_connection_kind_check
    check (connection_kind in ('public_lookup', 'oauth')),
  constraint linked_accounts_verification_check
    check (verification_status in ('unverified', 'confirmed', 'verified', 'failed', 'revoked')),
  constraint linked_accounts_status_check
    check (status in ('active', 'paused', 'disconnected'))
)
--> statement-breakpoint
comment on table app.linked_accounts is 'A user-owned claim on a provider identity, not the identity itself (database architecture 7.6). Uniqueness is per owner, never global: two users may link the same provider identity independently and neither is told about the other. Credentials never live in this row.'
--> statement-breakpoint
-- 7.6: one ACTIVE link from a user to a given provider identity, and explicitly
-- no uniqueness across different users. Partial so a disconnected link can be
-- retained and later re-established.
create unique index if not exists linked_accounts_one_active_per_owner_identity
  on app.linked_accounts (owner_user_id, provider_identity_id)
  where status <> 'disconnected'
--> statement-breakpoint
create index if not exists linked_accounts_owner on app.linked_accounts (owner_user_id)
--> statement-breakpoint
create index if not exists linked_accounts_identity on app.linked_accounts (provider_identity_id)
--> statement-breakpoint
create table if not exists app.subject_account_memberships (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references app.analysis_subjects(id) on delete cascade,
  linked_account_id uuid not null references app.linked_accounts(id) on delete cascade,
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  confirmation_method text not null,
  confirmed_at timestamptz,
  confirmed_by_user_id uuid references app.profiles(user_id),
  constraint subject_memberships_confirmation_check
    check (confirmation_method in ('owner_declared', 'oauth_verified', 'admin_reviewed'))
)
--> statement-breakpoint
comment on table app.subject_account_memberships is 'Explicit confirmation that a linked account contributes evidence to a subject (database architecture 7.7). Historical membership is retained with valid_to rather than deleted, so an old snapshot stays explainable.'
--> statement-breakpoint
-- 7.7: a linked account has at most one active membership.
create unique index if not exists subject_memberships_one_active_per_account
  on app.subject_account_memberships (linked_account_id)
  where valid_to is null
--> statement-breakpoint
create index if not exists subject_memberships_subject
  on app.subject_account_memberships (subject_id)
--> statement-breakpoint
create index if not exists subject_memberships_confirmed_by
  on app.subject_account_memberships (confirmed_by_user_id)
--> statement-breakpoint
create table if not exists social.public_player_profiles (
  user_id uuid primary key references app.profiles(user_id) on delete cascade,
  personal_subject_id uuid unique references app.analysis_subjects(id) on delete set null,
  handle text not null unique,
  display_name text,
  avatar_url text,
  is_discoverable boolean not null default false,
  show_provider_handles boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)
--> statement-breakpoint
comment on table social.public_player_profiles is 'The only initial player-discovery record (database architecture 7.8). Opt-in by default: is_discoverable and show_provider_handles are both false, so a profile is invisible until its owner says otherwise. Lookup returns this projection only -- never email, linked-account ids, ratings, goals or findings.'
--> statement-breakpoint
create index if not exists public_player_profiles_discoverable
  on social.public_player_profiles (handle) where is_discoverable
--> statement-breakpoint
-- Row level security. Every table here holds tenant rows, so RLS is enabled and
-- forced: forced binds the table owner too, which is how a migration or an ops
-- query cannot quietly read across owners.
alter table app.profiles enable row level security
--> statement-breakpoint
alter table app.profiles force row level security
--> statement-breakpoint
alter table app.analysis_subjects enable row level security
--> statement-breakpoint
alter table app.analysis_subjects force row level security
--> statement-breakpoint
alter table app.linked_accounts enable row level security
--> statement-breakpoint
alter table app.linked_accounts force row level security
--> statement-breakpoint
alter table app.subject_account_memberships enable row level security
--> statement-breakpoint
alter table app.subject_account_memberships force row level security
--> statement-breakpoint
alter table social.public_player_profiles enable row level security
--> statement-breakpoint
alter table social.public_player_profiles force row level security
--> statement-breakpoint
-- Policies are written against the transaction-local actor E02 established.
-- private.current_actor_id() is null outside a bound transaction, so an unbound
-- connection reads nothing rather than everything.
create policy profiles_owner on app.profiles
  using (user_id = private.current_actor_id())
  with check (user_id = private.current_actor_id())
--> statement-breakpoint
create policy analysis_subjects_owner on app.analysis_subjects
  using (owner_user_id = private.current_actor_id())
  with check (owner_user_id = private.current_actor_id())
--> statement-breakpoint
create policy linked_accounts_owner on app.linked_accounts
  using (owner_user_id = private.current_actor_id())
  with check (owner_user_id = private.current_actor_id())
--> statement-breakpoint
-- Membership is owned transitively: the actor must own the linked account the
-- membership is for. Both sides are checked, so a row cannot be written that
-- attaches someone else's account to your subject.
create policy subject_memberships_owner on app.subject_account_memberships
  using (
    exists (
      select 1 from app.linked_accounts la
      where la.id = linked_account_id and la.owner_user_id = private.current_actor_id()
    )
  )
  with check (
    exists (
      select 1 from app.linked_accounts la
      where la.id = linked_account_id and la.owner_user_id = private.current_actor_id()
    )
    and exists (
      select 1 from app.analysis_subjects s
      where s.id = subject_id and s.owner_user_id = private.current_actor_id()
    )
  )
--> statement-breakpoint
-- Discovery is the one place a row is readable by someone who does not own it,
-- and only when its owner has opted in.
create policy public_player_profiles_owner on social.public_player_profiles
  using (user_id = private.current_actor_id())
  with check (user_id = private.current_actor_id())
--> statement-breakpoint
create policy public_player_profiles_discoverable on social.public_player_profiles
  for select using (is_discoverable)
--> statement-breakpoint
-- Grants, by name and by privilege. `grant all` is never correct.
grant select, insert, update on app.profiles to forma_api
--> statement-breakpoint
grant select, insert, update on app.analysis_subjects to forma_api
--> statement-breakpoint
grant select on app.providers to forma_api, forma_ingestion, forma_analysis
--> statement-breakpoint
grant select, insert, update on app.provider_identities to forma_api, forma_ingestion
--> statement-breakpoint
grant select, insert, update on app.provider_identity_aliases to forma_api, forma_ingestion
--> statement-breakpoint
grant select, insert, update on app.linked_accounts to forma_api
--> statement-breakpoint
grant select on app.linked_accounts to forma_ingestion, forma_analysis
--> statement-breakpoint
grant select, insert, update on app.subject_account_memberships to forma_api
--> statement-breakpoint
grant select on app.subject_account_memberships to forma_analysis
--> statement-breakpoint
grant select, insert, update on social.public_player_profiles to forma_api
--> statement-breakpoint
-- The browser roles hold nothing here. E01's containment is the reason this
-- schema exists outside `public` at all.
revoke all on app.profiles from public
--> statement-breakpoint
revoke all on app.analysis_subjects from public
--> statement-breakpoint
revoke all on app.providers from public
--> statement-breakpoint
revoke all on app.provider_identities from public
--> statement-breakpoint
revoke all on app.provider_identity_aliases from public
--> statement-breakpoint
revoke all on app.linked_accounts from public
--> statement-breakpoint
revoke all on app.subject_account_memberships from public
--> statement-breakpoint
revoke all on social.public_player_profiles from public
--> statement-breakpoint
reset role

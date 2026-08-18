-- 0017_e06_identity_backfill
--
-- E06 — reconcile the legacy `public` identities onto the E06 tables.
--
-- Hand-written and reviewed. Additive and forward-only: it inserts, never
-- updates or deletes, and every legacy row stays exactly where it is. The
-- shipped client keeps reading `public.profiles` and `public.linked_accounts`
-- until a later epic switches the pointer, so this is an expand step and not a
-- cutover.
--
-- Re-running it is a no-op. Every insert is guarded by `where not exists` on the
-- natural key rather than by `on conflict`, because the uniqueness that matters
-- here lives in partial indexes and an `on conflict` arbiter cannot name them.
--
-- The reconciliation rule: a legacy row is one user's claim on a handle, and it
-- becomes exactly that — a shared `app.provider_identities` row plus a
-- per-owner `app.linked_accounts` row. Two legacy users holding the same handle
-- converge on one identity and keep two independent claims. Nothing here
-- inspects handles for similarity or merges users, which the epic forbids.

-- Applied by the deploying owner, not by `forma_migrator`, for two reasons that
-- both come from earlier epics doing their job.
--
-- E01 left `forma_migrator` no read on the legacy `public` tables -- only
-- `forma_api` and the Supabase roles were granted anything there -- so the
-- migrator cannot see the rows this reconciles. Granting it access would widen
-- E01's frozen containment surface for the length of one backfill.
--
-- E02 forces row level security on the E06 tables, which binds the table owner
-- too. That is correct at runtime and is what stops an ops query reading across
-- owners, but a backfill is not an actor and the policies are actor-scoped, so
-- every insert below would be filtered to nothing.
--
-- The deploying owner already holds SELECT on the legacy tables and carries
-- BYPASSRLS, so it satisfies both without changing a single grant or lifting
-- FORCE. This is the same posture 0015 used for role administration.
-- 1. Profiles. Email deliberately does not come across: Auth is authoritative
-- for it and app.profiles is specified not to duplicate it.
insert into app.profiles (user_id, created_at)
select p.id, p.created_at
from public.profiles p
where not exists (select 1 from app.profiles ap where ap.user_id = p.id)
--> statement-breakpoint
-- 2. One active personal subject per backfilled profile. display_name is a
-- reasonable label and is already the user's own words; it is not identity.
insert into app.analysis_subjects (kind, owner_user_id, display_label, created_at)
select 'personal', p.id, coalesce(nullif(p.display_name, ''), 'My games'), p.created_at
from public.profiles p
where not exists (
  select 1 from app.analysis_subjects s
  where s.owner_user_id = p.id and s.kind = 'personal' and s.status = 'active'
)
--> statement-breakpoint
-- 3. Shared provider identities, one per (provider, key) across every user.
-- The key is the provider's own id when the legacy row captured one, and the
-- normalized handle otherwise; key_basis records which, because a
-- username-keyed identity is weaker evidence that survives a rename.
insert into app.provider_identities (
  provider_id, provider_identity_key, key_basis,
  current_display_username, current_normalized_username, first_seen_at, last_seen_at
)
select
  pr.id,
  coalesce(nullif(la.provider_account_id, ''), la.normalized_username),
  case when nullif(la.provider_account_id, '') is null then 'username' else 'provider_id' end,
  min(la.username),
  la.normalized_username,
  min(la.created_at),
  max(coalesce(la.last_synced_at, la.created_at))
from public.linked_accounts la
join app.providers pr on pr.slug = la.platform::text
group by pr.id, coalesce(nullif(la.provider_account_id, ''), la.normalized_username),
         case when nullif(la.provider_account_id, '') is null then 'username' else 'provider_id' end,
         la.normalized_username
on conflict (provider_id, provider_identity_key) do nothing
--> statement-breakpoint
-- 4. Observed username history. One alias per distinct spelling actually seen,
-- so a later rename appends rather than rewriting an old game's handle.
insert into app.provider_identity_aliases (
  provider_identity_id, display_username, normalized_username, observed_from
)
select distinct pi.id, la.username, la.normalized_username, la.created_at
from public.linked_accounts la
join app.providers pr on pr.slug = la.platform::text
join app.provider_identities pi
  on pi.provider_id = pr.id
 and pi.provider_identity_key = coalesce(nullif(la.provider_account_id, ''), la.normalized_username)
where not exists (
  select 1 from app.provider_identity_aliases a
  where a.provider_identity_id = pi.id and a.display_username = la.username
)
--> statement-breakpoint
-- 5. One claim per legacy row. This is where the absence of global exclusivity
-- becomes real: two legacy users on the same handle produce two rows here and
-- neither is refused.
insert into app.linked_accounts (
  owner_user_id, provider_identity_id, connection_kind, verification_status, status, created_at
)
select la.user_id, pi.id, 'public_lookup', 'unverified', 'active', la.created_at
from public.linked_accounts la
join app.providers pr on pr.slug = la.platform::text
join app.provider_identities pi
  on pi.provider_id = pr.id
 and pi.provider_identity_key = coalesce(nullif(la.provider_account_id, ''), la.normalized_username)
join app.profiles ap on ap.user_id = la.user_id
where not exists (
  select 1 from app.linked_accounts existing
  where existing.owner_user_id = la.user_id
    and existing.provider_identity_id = pi.id
    and existing.status <> 'disconnected'
)
--> statement-breakpoint
-- 6. Membership, so a backfilled account actually contributes evidence to the
-- subject rather than sitting unattached. owner_declared is the truthful
-- method: the user did declare it, in the legacy product.
insert into app.subject_account_memberships (
  subject_id, linked_account_id, confirmation_method, confirmed_at, confirmed_by_user_id, valid_from
)
select s.id, nla.id, 'owner_declared', nla.created_at, nla.owner_user_id, nla.created_at
from app.linked_accounts nla
join app.analysis_subjects s
  on s.owner_user_id = nla.owner_user_id and s.kind = 'personal' and s.status = 'active'
where not exists (
  select 1 from app.subject_account_memberships m
  where m.linked_account_id = nla.id and m.valid_to is null
)

-- 0032_e19_entitlements_billing
--
-- E19 — the feature catalogue, effective-dated entitlement grants, the
-- subscription projection, the append-only usage ledger and idempotent billing
-- events.
--
-- Hand-written and reviewed. Additive and forward-only: five tables in the
-- `app` namespace. No existing object changes shape, no row is touched,
-- nothing is dropped or renamed. Re-running it is a no-op.
--
-- The thing this replaces is a mutable `plan` enum on a user row, and the four
-- constraints below are why that is not good enough:
--
--   * An entitlement is an effective-dated grant with a named source, so
--     "why can this person do that" always has an answer with a date on it.
--     A boolean column cannot say whether access came from a subscription, a
--     trial, a promotion or somebody in support being kind.
--   * Usage is an append-only ledger with an idempotency key. The counters the
--     product shows are projections over it. A retried unit of work cannot
--     charge twice, and a number nobody can audit is not a number.
--   * A billing event is unique by provider and external id, and its effect is
--     resolved from the provider's own object version rather than from arrival
--     order. Webhooks arrive twice and out of sequence; a system that trusts
--     order will eventually downgrade somebody who just paid.
--   * A grant may change what is shown and never what is true. There is no
--     column here that any report reads as a fact.

set local role forma_migrator
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 24.1 — the feature catalogue
--
-- Product code asks "may this user do X" against a key, not "is this user pro".
-- The indirection is the point: pricing changes without a code change, and a
-- feature can be granted to one person without inventing a tier for them.
-- ---------------------------------------------------------------------------
create table if not exists app.feature_catalogue (
  feature_key text primary key,
  display_name text not null,
  /* What a limit on this feature counts. `none` means the feature is a
     capability rather than a quantity. */
  metering_unit text not null,
  /* The limit everybody has without any grant at all. Null means unlimited,
     zero means the feature is off until granted. */
  default_limit integer,
  description text not null,
  created_at timestamptz not null default now(),
  constraint feature_catalogue_key_shape check (feature_key ~ '^[a-z][a-z0-9_.]{2,63}$'),
  constraint feature_catalogue_unit_check
    check (metering_unit in ('none', 'games', 'analyses', 'drills', 'reports', 'minutes')),
  constraint feature_catalogue_limit_non_negative
    check (default_limit is null or default_limit >= 0),
  constraint feature_catalogue_description_present check (length(btrim(description)) >= 10)
)
--> statement-breakpoint
comment on table app.feature_catalogue is 'Stable feature keys and their metering units (database architecture 24.1). Product code asks whether a user may do X rather than whether they are pro, so pricing changes without a code change and one person can be granted something without inventing a tier for them.'
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 24.2 — entitlement grants
-- ---------------------------------------------------------------------------
create table if not exists app.entitlement_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app.profiles(user_id) on delete cascade,
  subject_id uuid references app.analysis_subjects(id) on delete cascade,
  feature_key text not null references app.feature_catalogue(feature_key) on delete restrict,
  source text not null,
  /* Null means unlimited for the life of the grant. Zero means explicitly
     denied, which a support agent occasionally needs and a resolver must
     distinguish from "no grant". */
  quantitative_limit integer,
  configuration jsonb not null default '{}'::jsonb,
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  /* What produced it: a subscription id, a promotion code, or the audit row for
     a manual grant. A grant nobody can trace is a grant nobody can revoke. */
  source_reference text,
  granted_by uuid references app.profiles(user_id) on delete set null,
  note text,
  created_at timestamptz not null default now(),
  constraint entitlement_grants_source_check
    check (source in ('subscription', 'trial', 'promotion', 'editorial', 'admin')),
  constraint entitlement_grants_limit_non_negative
    check (quantitative_limit is null or quantitative_limit >= 0),
  constraint entitlement_grants_dates_ordered
    check (valid_to is null or valid_from < valid_to),
  constraint entitlement_grants_configuration_shape
    check (jsonb_typeof(configuration) = 'object'),
  -- A manual grant names the person who made it. "Somebody in support did this
  -- in March" is the answer an audit needs, and an unattributed admin grant
  -- cannot give it.
  constraint entitlement_grants_manual_is_attributed check (
    source not in ('admin', 'editorial') or (granted_by is not null and note is not null)
  ),
  -- A subscription grant points at the subscription. Otherwise cancelling one
  -- leaves access nobody can find.
  constraint entitlement_grants_subscription_is_traceable check (
    source <> 'subscription' or source_reference is not null
  )
)
--> statement-breakpoint
comment on table app.entitlement_grants is 'Effective-dated grants with a named source (database architecture 24.2). "Why can this person do that" always has an answer with a date on it, which a mutable plan column cannot give: it cannot say whether access came from a subscription, a trial, a promotion, or somebody in support being kind.'
--> statement-breakpoint
create index if not exists entitlement_grants_lookup
  on app.entitlement_grants (user_id, feature_key, valid_from desc)
--> statement-breakpoint
-- Grants are revoked by setting `valid_to`, never by deletion: the history of
-- what somebody was entitled to is what makes a billing dispute answerable.
create or replace function app.refuse_grant_deletion() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception
    'an entitlement grant is revoked by setting valid_to, never deleted'
    using errcode = 'restrict_violation';
end;
$$
--> statement-breakpoint
comment on function app.refuse_grant_deletion() is 'Grants are closed rather than removed. The history of what somebody was entitled to, and when, is what makes a billing dispute answerable.'
--> statement-breakpoint
revoke all on function app.refuse_grant_deletion() from public
--> statement-breakpoint
drop trigger if exists entitlement_grants_no_delete on app.entitlement_grants
--> statement-breakpoint
create trigger entitlement_grants_no_delete
  before delete on app.entitlement_grants
  for each row execute function app.refuse_grant_deletion()
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 24.3 — the subscription projection
-- ---------------------------------------------------------------------------
create table if not exists app.subscription_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app.profiles(user_id) on delete cascade,
  billing_provider text not null,
  external_customer_id text not null,
  external_subscription_id text not null,
  price_key text not null,
  status text not null,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  /*
   * The provider's own version of this object, from the event that produced
   * this row. Out-of-order webhooks are resolved against it rather than against
   * arrival order.
   */
  provider_object_version timestamptz not null,
  last_event_id uuid,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint subscription_records_unique unique (billing_provider, external_subscription_id),
  constraint subscription_records_provider_check check (billing_provider in ('stripe')),
  constraint subscription_records_status_check check (status in (
    'trialing', 'active', 'past_due', 'canceled', 'incomplete', 'incomplete_expired', 'unpaid'
  )),
  constraint subscription_records_period_ordered check (
    current_period_start is null or current_period_end is null
    or current_period_start < current_period_end
  ),
  -- The price is a key into our own allowlist, not an identifier the client
  -- chose. A price id arriving from a browser is a price nobody approved.
  constraint subscription_records_price_shape check (price_key ~ '^[a-z][a-z0-9_]{2,63}$')
)
--> statement-breakpoint
comment on table app.subscription_records is 'A provider-independent projection of billing state (database architecture 24.3). `provider_object_version` is what resolves out-of-order webhooks: they arrive twice and in the wrong sequence, and a system that trusts arrival order will eventually downgrade somebody who has just paid.'
--> statement-breakpoint
create index if not exists subscription_records_user on app.subscription_records (user_id)
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 24.4 — the usage ledger
-- ---------------------------------------------------------------------------
create table if not exists app.usage_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references app.profiles(user_id) on delete cascade,
  subject_id uuid references app.analysis_subjects(id) on delete cascade,
  feature_key text not null references app.feature_catalogue(feature_key) on delete restrict,
  /* Reserved first, settled or released after. A reservation that is never
     settled is released by the sweep, so a crashed worker does not permanently
     consume somebody's quota. */
  state text not null default 'reserved',
  quantity integer not null,
  unit text not null,
  /*
   * The caller's own key. Two attempts at the same unit of work are one ledger
   * entry, which is what stops a retry from charging twice.
   */
  idempotency_key text not null,
  workflow_id uuid references ops.workflows(id) on delete set null,
  work_item_id bigint references ops.work_items(id) on delete set null,
  billing_window date not null,
  occurred_at timestamptz not null default now(),
  settled_at timestamptz,
  released_at timestamptz,
  release_reason text,
  constraint usage_ledger_idempotent unique (user_id, feature_key, idempotency_key),
  constraint usage_ledger_state_check check (state in ('reserved', 'settled', 'released')),
  constraint usage_ledger_quantity_positive check (quantity > 0),
  constraint usage_ledger_unit_check
    check (unit in ('games', 'analyses', 'drills', 'reports', 'minutes')),
  constraint usage_ledger_key_shape check (idempotency_key ~ '^[A-Za-z0-9_:-]{8,128}$'),
  constraint usage_ledger_settled_shape check ((state = 'settled') = (settled_at is not null)),
  constraint usage_ledger_released_shape check (
    (state = 'released') = (released_at is not null and release_reason is not null)
  ),
  constraint usage_ledger_release_reason_shape check (
    release_reason is null or release_reason in (
      'work_failed', 'work_cancelled', 'reservation_expired', 'refunded'
    )
  )
)
--> statement-breakpoint
comment on table app.usage_ledger is 'Append-only metered usage (database architecture 24.4). The counters the product shows are projections over this, not mutable facts with no audit trail. A failed unit of work releases its reservation with a reason rather than silently consuming somebody''s quota.'
--> statement-breakpoint
create index if not exists usage_ledger_window
  on app.usage_ledger (user_id, feature_key, billing_window)
  where state <> 'released'
--> statement-breakpoint
-- Rows are closed by state, never removed: a usage record that can vanish is a
-- bill nobody can check.
create or replace function app.refuse_usage_deletion() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception 'usage is released by state, never deleted'
    using errcode = 'restrict_violation';
end;
$$
--> statement-breakpoint
comment on function app.refuse_usage_deletion() is 'A usage record that can vanish is a bill nobody can check.'
--> statement-breakpoint
revoke all on function app.refuse_usage_deletion() from public
--> statement-breakpoint
drop trigger if exists usage_ledger_no_delete on app.usage_ledger
--> statement-breakpoint
create trigger usage_ledger_no_delete
  before delete on app.usage_ledger
  for each row execute function app.refuse_usage_deletion()
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 24.5 — billing events
-- ---------------------------------------------------------------------------
create table if not exists app.billing_events (
  id uuid primary key default gen_random_uuid(),
  billing_provider text not null,
  external_event_id text not null,
  event_type text not null,
  /* The provider's timestamps. `object_version` is the one that decides which
     of two events describes the later state. */
  provider_created_at timestamptz not null,
  object_version timestamptz not null,
  received_at timestamptz not null default now(),
  payload_sha256 text not null,
  /* Only when retention is required, and always as a private artifact rather
     than a column: a webhook body carries payment metadata. */
  payload_artifact_id uuid references ops.artifacts(id) on delete set null,
  processing_state text not null default 'received',
  attempt_count integer not null default 0,
  processed_at timestamptz,
  error_code text,
  subscription_record_id uuid references app.subscription_records(id) on delete set null,
  -- The constraint that makes a redelivered webhook harmless.
  constraint billing_events_unique unique (billing_provider, external_event_id),
  constraint billing_events_provider_check check (billing_provider in ('stripe')),
  constraint billing_events_state_check
    check (processing_state in ('received', 'processing', 'processed', 'ignored', 'failed')),
  constraint billing_events_checksum_shape check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  constraint billing_events_attempts_non_negative check (attempt_count >= 0),
  constraint billing_events_processed_shape check (
    (processing_state in ('processed', 'ignored')) = (processed_at is not null)
  ),
  constraint billing_events_failure_explained check (
    (processing_state = 'failed') = (error_code is not null)
  ),
  -- A sanitized code, never a provider message: those quote payment details.
  constraint billing_events_error_shape check (
    error_code is null or error_code ~ '^[a-z][a-z0-9_]{2,63}$'
  )
)
--> statement-breakpoint
comment on table app.billing_events is 'Idempotent receipt and processing history for external billing events (database architecture 24.5). Unique by provider and external id, so a redelivery is harmless, and resolved by the provider''s own object version rather than by arrival order.'
--> statement-breakpoint
comment on column app.billing_events.payload_artifact_id is 'A webhook body carries payment metadata, so it is a private artifact rather than a column. Most events need only the checksum.'
--> statement-breakpoint
create index if not exists billing_events_unprocessed
  on app.billing_events (received_at)
  where processing_state in ('received', 'processing', 'failed')
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Grants.
--
-- The API resolves entitlements and reserves quota, because both happen while a
-- person waits. It cannot grant itself an entitlement, and it cannot write a
-- billing event: those come from a signed webhook handled by forma_ops.
-- ---------------------------------------------------------------------------
grant select on app.feature_catalogue to forma_api
--> statement-breakpoint
grant select on app.entitlement_grants to forma_api
--> statement-breakpoint
grant select on app.subscription_records to forma_api
--> statement-breakpoint
grant select, insert on app.usage_ledger to forma_api
--> statement-breakpoint
grant update (state, settled_at, released_at, release_reason) on app.usage_ledger to forma_api
--> statement-breakpoint
grant select on app.feature_catalogue to forma_ops
--> statement-breakpoint
grant select, insert on app.entitlement_grants to forma_ops
--> statement-breakpoint
grant update (valid_to) on app.entitlement_grants to forma_ops
--> statement-breakpoint
grant select, insert, update on app.subscription_records to forma_ops
--> statement-breakpoint
grant select, insert, update on app.billing_events to forma_ops
--> statement-breakpoint
grant select, insert on app.usage_ledger to forma_ops
--> statement-breakpoint
grant update (state, released_at, release_reason) on app.usage_ledger to forma_ops
--> statement-breakpoint
grant select on app.feature_catalogue to forma_analysis
--> statement-breakpoint
grant select on app.entitlement_grants to forma_analysis
--> statement-breakpoint
grant select, insert on app.usage_ledger to forma_analysis

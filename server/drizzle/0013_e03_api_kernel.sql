-- 0013_e03_api_kernel
--
-- E03 — the durable state the /v1 API kernel needs: command idempotency
-- records, append-only security audit events, and distributed rate-limit
-- counters.
--
-- Hand-written and reviewed, like 0011 and 0012. Applied by `npm run db:migrate`.
--
-- Additive and forward-only. It creates three new tables in the `ops` namespace
-- E02 established, grants them to named runtime roles, and touches nothing that
-- already exists. Re-running it is a no-op. Rollback is a paired forward
-- migration; these tables hold idempotency and audit evidence that the epic
-- forbids deleting as part of any rollback. See
-- docs/platform/E03-api-kernel-contract.md §15.

-- Own everything this file creates, exactly as 0012 does.
set local role forma_migrator
--> statement-breakpoint
--
-- 1. ops.idempotency_records — database architecture §14.7
--
-- The durable API command replay contract. A record holds the *keyed* digest of
-- the normalized request and the kernel's own safe response envelope, never a
-- bearer token and never a raw request body: an email that signed up must not be
-- confirmable by reading this table, which is why the digest is an HMAC rather
-- than a plain hash.
--
create table if not exists ops.idempotency_records (
  id uuid primary key default gen_random_uuid(),
  -- Null for an anonymous command. `actor_key` carries the uniqueness scope in
  -- both cases so the unique index never has to reason about null.
  actor_profile_id uuid,
  actor_key text not null,
  route_key text not null,
  idempotency_key text not null,
  request_method text not null,
  request_digest text not null,
  state text not null,
  response_status smallint,
  response_body jsonb,
  resource_type text,
  resource_id text,
  -- E04 populates this when a command creates a durable workflow.
  workflow_id uuid,
  -- Present only while `processing`: a process that dies mid-command must not
  -- wedge the key, so an expired lease is treated as a failed attempt.
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  expires_at timestamptz not null,
  constraint idempotency_records_state_check
    check (state in ('processing', 'completed', 'failed')),
  constraint idempotency_records_key_length_check
    check (char_length(idempotency_key) between 1 and 128),
  constraint idempotency_records_actor_key_check
    check (char_length(actor_key) between 1 and 64),
  constraint idempotency_records_digest_check
    check (request_digest ~ '^[0-9a-f]{64}$'),
  -- A completed record is the only one that can be replayed, so it is the only
  -- one allowed to carry a response status, and it must carry one.
  constraint idempotency_records_completed_status_check
    check ((state = 'completed') = (response_status is not null)),
  constraint idempotency_records_completed_at_check
    check ((state = 'processing') = (completed_at is null)),
  constraint idempotency_records_lease_check
    check ((state = 'processing') = (lease_expires_at is not null))
)
--> statement-breakpoint
comment on table ops.idempotency_records is 'Durable API command replay contract (database architecture 14.7). Holds a keyed request digest and the kernel safe response envelope only: no bearer token, no raw request body, no email, no provider payload.'
--> statement-breakpoint
comment on column ops.idempotency_records.actor_key is 'Uniqueness scope for the key: the profile id for an authenticated command, the literal ''anon'' for an anonymous one. Anonymous replay is admissible only where the stored response is content-free.'
--> statement-breakpoint
comment on column ops.idempotency_records.request_digest is 'HMAC-SHA256 of method, route key and canonical request body under the kernel signing key. Keyed rather than plain so a stored digest cannot be tested offline against a guessed body.'
--> statement-breakpoint
comment on column ops.idempotency_records.response_body is 'The kernel response envelope that was returned, replayed verbatim on an identical retry. Never a provider body or an internal error.'
--> statement-breakpoint
comment on column ops.idempotency_records.lease_expires_at is 'When a processing attempt stops being believed. A duplicate arriving after this may claim the record by compare-and-set, so a crashed process does not wedge the key forever.'
--> statement-breakpoint
create unique index if not exists idempotency_records_scope_key_uq
  on ops.idempotency_records (actor_key, route_key, idempotency_key)
--> statement-breakpoint
create index if not exists idempotency_records_expires_at_idx
  on ops.idempotency_records (expires_at)
--> statement-breakpoint
--
-- 2. ops.audit_events — database architecture §14.8
--
-- Append-only, content-free security and administrative audit. Runtime roles
-- insert and read; none of them is granted update or delete, so a row cannot be
-- rewritten by the process that wrote it.
--
create table if not exists ops.audit_events (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_kind text not null,
  -- Opaque reference. Never an email, a username, or a provider handle.
  actor_ref uuid,
  action text not null,
  target_type text,
  target_ref text,
  request_id text,
  trace_id text,
  result text not null,
  reason_code text,
  metadata jsonb not null default '{}'::jsonb,
  constraint audit_events_actor_kind_check
    check (actor_kind in ('user', 'anonymous', 'service', 'system')),
  constraint audit_events_result_check
    check (result in ('allowed', 'denied', 'error')),
  constraint audit_events_metadata_object_check
    check (jsonb_typeof(metadata) = 'object'),
  constraint audit_events_metadata_size_check
    check (pg_column_size(metadata) <= 2048)
)
--> statement-breakpoint
comment on table ops.audit_events is 'Append-only content-free security and administrative audit (database architecture 14.8). Rows never contain PGN, provider bodies, email, tokens, signed URLs, model prompts or analysis payloads, and cannot reconstruct deleted user content. Retention 180 days.'
--> statement-breakpoint
comment on column ops.audit_events.metadata is 'Minimal non-sensitive scalars only, bounded to 2 kB. The kernel writes from a closed field list; it is not a free-form payload column.'
--> statement-breakpoint
create index if not exists audit_events_occurred_at_idx
  on ops.audit_events (occurred_at)
--> statement-breakpoint
create index if not exists audit_events_actor_ref_idx
  on ops.audit_events (actor_ref, occurred_at desc)
  where actor_ref is not null
--> statement-breakpoint
--
-- 3. ops.rate_limit_counters
--
-- Distributed fixed-window counters. One atomic upsert per check, so the limit
-- is shared by every instance instead of being per-process (platform audit §10).
-- The identity is stored as a keyed HMAC, so the table cannot be mined for
-- client addresses or email addresses.
--
create table if not exists ops.rate_limit_counters (
  bucket text not null,
  subject_key text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  expires_at timestamptz not null,
  primary key (bucket, subject_key, window_start),
  constraint rate_limit_counters_count_check check (count >= 0),
  constraint rate_limit_counters_subject_key_check
    check (subject_key ~ '^[0-9a-f]{32}$')
)
--> statement-breakpoint
comment on table ops.rate_limit_counters is 'Distributed fixed-window rate-limit counters for public and expensive endpoints. Operational only: rows expire, hold no evidence, and are removed opportunistically rather than by a sweeper.'
--> statement-breakpoint
comment on column ops.rate_limit_counters.subject_key is 'HMAC-SHA256 of the policy and the rate-limited identity under the kernel signing key, truncated to 32 hex. Never a raw client address or email.'
--> statement-breakpoint
create index if not exists rate_limit_counters_expires_at_idx
  on ops.rate_limit_counters (expires_at)
--> statement-breakpoint
--
-- 4. Row level security
--
-- Forced, so not even the owning role bypasses the policies by accident. These
-- are shared operational tables rather than tenant data, so the policies carry
-- no actor predicate: the access model is the named grant plus the absence of
-- update and delete on the append-only table.
--
alter table ops.idempotency_records enable row level security
--> statement-breakpoint
alter table ops.idempotency_records force row level security
--> statement-breakpoint
alter table ops.audit_events enable row level security
--> statement-breakpoint
alter table ops.audit_events force row level security
--> statement-breakpoint
alter table ops.rate_limit_counters enable row level security
--> statement-breakpoint
alter table ops.rate_limit_counters force row level security
--> statement-breakpoint
drop policy if exists idempotency_records_runtime on ops.idempotency_records
--> statement-breakpoint
create policy idempotency_records_runtime on ops.idempotency_records
  as permissive for all
  to forma_api, forma_ops
  using (true) with check (true)
--> statement-breakpoint
comment on policy idempotency_records_runtime on ops.idempotency_records is 'Command replay is an API-role concern, not tenant data: a record is already scoped by actor_key, and the roles named here hold no other privilege that would widen it. Never extend to anon, authenticated, service_role or PUBLIC.'
--> statement-breakpoint
drop policy if exists audit_events_runtime_append on ops.audit_events
--> statement-breakpoint
create policy audit_events_runtime_append on ops.audit_events
  as permissive for insert
  to forma_api, forma_ops, forma_ingestion, forma_analysis
  with check (true)
--> statement-breakpoint
drop policy if exists audit_events_runtime_read on ops.audit_events
--> statement-breakpoint
create policy audit_events_runtime_read on ops.audit_events
  as permissive for select
  to forma_api, forma_ops
  using (true)
--> statement-breakpoint
comment on policy audit_events_runtime_append on ops.audit_events is 'Append only. There is deliberately no update or delete policy, and no runtime role holds those privileges, so an audit row cannot be rewritten by the process that wrote it.'
--> statement-breakpoint
drop policy if exists rate_limit_counters_runtime on ops.rate_limit_counters
--> statement-breakpoint
create policy rate_limit_counters_runtime on ops.rate_limit_counters
  as permissive for all
  to forma_api, forma_ops
  using (true) with check (true)
--> statement-breakpoint
--
-- 5. Named grants
--
-- Explicit per table and per action, as E02 requires. `forma_api` receives
-- delete on the counter table only: expiry is opportunistic and the rows hold
-- no evidence. It receives no delete anywhere else, and no update on the
-- append-only audit table.
--
grant select, insert, update on ops.idempotency_records to forma_api
--> statement-breakpoint
grant select, insert, update, delete on ops.idempotency_records to forma_ops
--> statement-breakpoint
grant select, insert on ops.audit_events to forma_api
--> statement-breakpoint
grant select, insert on ops.audit_events to forma_ops
--> statement-breakpoint
grant insert on ops.audit_events to forma_ingestion
--> statement-breakpoint
grant insert on ops.audit_events to forma_analysis
--> statement-breakpoint
grant usage, select on sequence ops.audit_events_id_seq to forma_api
--> statement-breakpoint
grant usage, select on sequence ops.audit_events_id_seq to forma_ops
--> statement-breakpoint
grant usage, select on sequence ops.audit_events_id_seq to forma_ingestion
--> statement-breakpoint
grant usage, select on sequence ops.audit_events_id_seq to forma_analysis
--> statement-breakpoint
grant select, insert, update, delete on ops.rate_limit_counters to forma_api
--> statement-breakpoint
grant select, insert, update, delete on ops.rate_limit_counters to forma_ops
--> statement-breakpoint
--
-- 6. Browser and PUBLIC exclusion
--
-- A new table carries no PUBLIC grant, but stating the revoke keeps the
-- containment claim checkable on a database whose defaults were changed.
--
do $$
declare
  table_name text;
  denied_role text;
begin
  foreach table_name in array array[
    'ops.idempotency_records', 'ops.audit_events', 'ops.rate_limit_counters'
  ] loop
    execute format('revoke all on table %s from public', table_name);
    foreach denied_role in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = denied_role) then
        execute format('revoke all on table %s from %I', table_name, denied_role);
      end if;
    end loop;
  end loop;
end
$$
--> statement-breakpoint
-- Hand the session back so the migration runner writes its ledger row as the
-- role that owns the ledger.
reset role

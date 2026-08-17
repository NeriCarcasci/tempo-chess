-- 0014_e04_work_ledger
--
-- E04 — the durable work ledger: workflows, work items, dependencies,
-- attempts, and the transactional outbox that makes a committed command
-- impossible to lose.
--
-- Hand-written and reviewed, like 0011, 0012 and 0013. Applied by
-- `npm run db:migrate`.
--
-- Additive and forward-only. It creates five tables and three guard functions
-- in the `ops` namespace E02 established, adds one foreign key and its index to
-- the E03 idempotency table, and touches no existing row. Re-running it is a
-- no-op. Rollback is a paired forward migration: these tables hold the
-- authoritative record of committed work and attempt history, which the epic
-- forbids deleting as part of any rollback. See
-- docs/platform/E04-work-ledger-contract.md §11.

set local role forma_migrator
--> statement-breakpoint
--
-- 1. ops.workflows — database architecture §14.1, platform spec §8
--
-- One user- or system-visible operation. The database owns workflow truth; a
-- queue only transports wake-up messages, so nothing here is derived from a
-- queue acknowledgement.
--
create table if not exists ops.workflows (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  -- Null for a system workflow with no owner. Deliberately not a foreign key to
  -- `public.profiles`, exactly as 0013's `actor_profile_id` is not: that table
  -- is owned outside the `forma_migrator` namespace this file writes in, and
  -- E06 replaces it with the subject model an ownership constraint should point
  -- at. Tenancy does not rest on the constraint — the API filters this column
  -- against a verified token — and §26's deletion graph is the epic that makes
  -- removal transitive.
  owner_profile_id uuid,
  state text not null default 'queued',
  -- The product resource this operation is about, as a typed reference rather
  -- than a foreign key: the target table differs per kind and several of them
  -- do not exist yet.
  resource_type text,
  resource_id text,
  -- Set the moment cancellation is requested; the state moves to 'cancelling'
  -- and only reaches 'cancelled' once no attempt still holds a lease.
  cancel_requested_at timestamptz,
  cost_budget_usd numeric(10, 4),
  -- A closed classification and a sentence written for the owner. Never a
  -- provider body, a driver message, or a task payload.
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint workflows_kind_check
    check (kind in (
      'account_sync', 'game_import', 'initial_examination', 'game_analysis',
      'model_backfill', 'subject_estimation', 'maintenance'
    )),
  constraint workflows_state_check
    check (state in ('queued', 'running', 'succeeded', 'failed', 'cancelling', 'cancelled')),
  -- A terminal state has a completion time and a nonterminal one does not, so
  -- "is it finished" has exactly one answer.
  constraint workflows_completed_at_check
    check ((state in ('succeeded', 'failed', 'cancelled')) = (completed_at is not null)),
  constraint workflows_cancelling_check
    check (state <> 'cancelling' or cancel_requested_at is not null),
  constraint workflows_error_state_check
    check (error_code is null or state = 'failed'),
  constraint workflows_error_message_length_check
    check (error_message is null or char_length(error_message) <= 500),
  constraint workflows_resource_pair_check
    check ((resource_type is null) = (resource_id is null))
)
--> statement-breakpoint
comment on table ops.workflows is 'One user- or system-visible durable operation (database architecture 14.1, platform spec 8). The database owns workflow truth; queue delivery is never treated as completion. Progress is derived from ops.work_items weights and states, never from a mutable counter on this row.'
--> statement-breakpoint
comment on column ops.workflows.error_message is 'A safe sentence for the workflow owner, from the API problem vocabulary. Never a provider body, a driver message, a PGN or a task payload.'
--> statement-breakpoint
create index if not exists workflows_owner_created_idx
  on ops.workflows (owner_profile_id, created_at desc, id desc)
  where owner_profile_id is not null
--> statement-breakpoint
create index if not exists workflows_active_idx
  on ops.workflows (state, created_at)
  where state in ('queued', 'running', 'cancelling')
--> statement-breakpoint
--
-- 2. ops.work_items — database architecture §14.2
--
-- Small, independently retriable units. The row names a capability
-- (`resource_class`), not a Cloud Run service, so deployments can be split or
-- merged without rewriting history.
--
create table if not exists ops.work_items (
  id bigint generated always as identity primary key,
  workflow_id uuid not null references ops.workflows(id) on delete cascade,
  task_type text not null,
  resource_class text not null,
  -- A typed reference such as `analysisImport:<uuid>`. The worker loads the
  -- immutable input from Postgres or Storage; it is never carried in the queue.
  input_ref text,
  payload jsonb not null default '{}'::jsonb,
  -- Stable per side effect and scoped to the handler version (platform spec §8).
  idempotency_key text not null,
  -- Weighted progress: a 400-position analysis is not one unit of the same size
  -- as a metadata refresh.
  weight integer not null default 1,
  priority smallint not null default 100,
  available_at timestamptz not null default now(),
  status text not null default 'blocked',
  -- 'queue' is dispatched through the outbox to Cloud Tasks. 'in_process' is
  -- claimed directly by a co-located runner and is deliberately never
  -- dispatched: it is how dispatch routing rolls back without losing a row.
  dispatch_mode text not null default 'queue',
  -- The platform spec §7 queue this item is dispatched on, named by whoever
  -- created the work rather than derived from resource_class: the provider
  -- split is a property of the job, not of the capability that runs it.
  queue text,
  -- Bumped on every dispatch, and bound into the attempt token, so a duplicate
  -- delivery from a superseded dispatch is recognised rather than executed.
  dispatch_epoch integer not null default 0,
  attempt_count integer not null default 0,
  max_attempts integer not null default 5,
  lease_owner text,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  timeout_seconds integer not null default 300,
  output_ref text,
  output_summary jsonb,
  -- The retry classification that produced the current state, from the closed
  -- set in platform spec §8.
  error_class text,
  error_code text,
  error_detail text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint work_items_task_type_check
    check (task_type ~ '^[a-z][a-z0-9_]{2,63}$'),
  constraint work_items_resource_class_check
    check (resource_class in (
      'api_light', 'ingestion', 'cpu_engine', 'cpu_model', 'gpu_model',
      'aggregation', 'publication'
    )),
  constraint work_items_status_check
    check (status in ('blocked', 'ready', 'leased', 'succeeded', 'retry_wait', 'dead', 'cancelled')),
  constraint work_items_dispatch_mode_check
    check (dispatch_mode in ('queue', 'in_process')),
  constraint work_items_queue_check
    check (queue is null or queue in (
      'provider-lichess', 'provider-chesscom', 'stockfish-screen', 'stockfish-deep',
      'analysis', 'maintenance'
    )),
  -- A queue-dispatched item without a queue is an item nothing will ever
  -- deliver, and an in-process item with one is a routing claim nothing honours.
  constraint work_items_queue_mode_check
    check ((dispatch_mode = 'queue') = (queue is not null)),
  constraint work_items_weight_check check (weight between 1 and 1000000),
  constraint work_items_attempts_check
    check (attempt_count >= 0 and max_attempts between 1 and 25 and attempt_count <= max_attempts),
  constraint work_items_dispatch_epoch_check check (dispatch_epoch >= 0),
  constraint work_items_timeout_check check (timeout_seconds between 5 and 3600),
  -- A lease exists exactly while the item is leased, and both halves of it
  -- appear together. Stated as two constraints rather than one conjunction
  -- because the conjunction is satisfied by a ready row that still carries a
  -- stale owner — a lease that outlived its attempt, which is how work silently
  -- stops being retried.
  constraint work_items_lease_owner_check
    check ((status = 'leased') = (lease_owner is not null)),
  constraint work_items_lease_expiry_check
    check ((status = 'leased') = (lease_expires_at is not null)),
  constraint work_items_completed_at_check
    check ((status in ('succeeded', 'dead', 'cancelled')) = (completed_at is not null)),
  constraint work_items_error_class_check
    check (error_class is null or error_class in (
      'transient', 'rate_limit', 'invalid_input', 'unsupported', 'unauthorized',
      'budget', 'permanent'
    )),
  constraint work_items_error_detail_length_check
    check (error_detail is null or char_length(error_detail) <= 500),
  constraint work_items_idempotency_key_length_check
    check (char_length(idempotency_key) between 1 and 200),
  -- Small by contract: the payload is a handle, not the work. 4 kB is generous
  -- for identifiers and bounds and far too small for a PGN or a FEN list.
  constraint work_items_payload_object_check check (jsonb_typeof(payload) = 'object'),
  constraint work_items_payload_size_check check (pg_column_size(payload) <= 4096),
  constraint work_items_output_summary_check
    check (output_summary is null or (jsonb_typeof(output_summary) = 'object' and pg_column_size(output_summary) <= 4096))
)
--> statement-breakpoint
comment on table ops.work_items is 'Independently retriable units of durable work (database architecture 14.2). resource_class names a capability, not a deployment, so services can be split or merged without changing history. Payload is a bounded handle: never a PGN, FEN list, model output, credential or authorization decision.'
--> statement-breakpoint
comment on column ops.work_items.dispatch_epoch is 'Incremented on every dispatch and bound into the attempt token. A delivery presenting a superseded epoch is acknowledged without executing, so at-least-once transport cannot run a retired attempt.'
--> statement-breakpoint
comment on column ops.work_items.dispatch_mode is 'Dispatch routing for this item. Flipping newly created items back to in_process is the epic rollback: committed rows and attempt history are retained and only the transport changes.'
--> statement-breakpoint
create unique index if not exists work_items_idempotency_key_uq
  on ops.work_items (idempotency_key)
--> statement-breakpoint
-- Database architecture §28 Q10, with §14.2's state vocabulary: Q10's 'queued'
-- is this schema's 'ready', and a partial index only helps when its predicate
-- is exactly the query's. It serves the queue-depth and oldest-ready-age
-- signals platform spec §19 asks for "by class".
create index if not exists work_items_claim_idx
  on ops.work_items (resource_class, priority desc, available_at, id)
  where status = 'ready'
--> statement-breakpoint
-- The pull claim of database architecture §14.6, for a runner co-located with
-- the ledger rather than behind a queue. Separate from the index above because
-- it answers a different question — "my task types, soonest due" rather than
-- "this capability, highest priority" — and because it covers only the
-- in-process minority of rows.
create index if not exists work_items_in_process_claim_idx
  on ops.work_items (task_type, priority desc, available_at, id)
  where dispatch_mode = 'in_process' and status in ('ready', 'retry_wait')
--> statement-breakpoint
create index if not exists work_items_lease_recovery_idx
  on ops.work_items (lease_expires_at)
  where status = 'leased'
--> statement-breakpoint
create index if not exists work_items_workflow_idx
  on ops.work_items (workflow_id, id)
--> statement-breakpoint
--
-- 3. ops.work_item_dependencies — database architecture §14.3
--
-- A child becomes runnable only after every upstream item succeeds. Cycles are
-- prohibited structurally rather than by a trigger: a dependency may only point
-- at a lower identity, and identities are assigned in creation order, so no
-- sequence of inserts can close a loop.
--
create table if not exists ops.work_item_dependencies (
  work_item_id bigint not null references ops.work_items(id) on delete cascade,
  depends_on_work_item_id bigint not null references ops.work_items(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (work_item_id, depends_on_work_item_id),
  constraint work_item_dependencies_acyclic_check
    check (depends_on_work_item_id < work_item_id)
)
--> statement-breakpoint
comment on table ops.work_item_dependencies is 'Dependency edges for the work DAG (database architecture 14.3). The check constraint makes cycles unrepresentable: an edge may only point at a lower, therefore earlier, work item.'
--> statement-breakpoint
create index if not exists work_item_dependencies_upstream_idx
  on ops.work_item_dependencies (depends_on_work_item_id, work_item_id)
--> statement-breakpoint
--
-- 4. ops.work_attempts — database architecture §14.4
--
-- Append-only attempt telemetry. A row may be finished exactly once; the guard
-- below refuses any edit to a finished attempt, so a retry adds history rather
-- than rewriting it.
--
create table if not exists ops.work_attempts (
  id bigint generated always as identity primary key,
  work_item_id bigint not null references ops.work_items(id) on delete cascade,
  attempt_number integer not null,
  deployment text,
  revision text,
  worker_instance text,
  claimed_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  outcome text,
  error_class text,
  error_code text,
  input_count integer,
  output_count integer,
  cache_hits integer,
  compute_ms integer,
  billed_units numeric(14, 6),
  trace_id text,
  constraint work_attempts_number_check check (attempt_number >= 1),
  constraint work_attempts_outcome_check
    check (outcome is null or outcome in ('succeeded', 'failed', 'abandoned', 'cancelled')),
  constraint work_attempts_finished_check check ((outcome is null) = (finished_at is null)),
  constraint work_attempts_error_class_check
    check (error_class is null or error_class in (
      'transient', 'rate_limit', 'invalid_input', 'unsupported', 'unauthorized',
      'budget', 'permanent'
    ))
)
--> statement-breakpoint
comment on table ops.work_attempts is 'Append-only attempt telemetry (database architecture 14.4). Carries deployment, worker identity, timing, cost and a sanitized terminal result plus a trace pointer. It never carries the work itself.'
--> statement-breakpoint
create unique index if not exists work_attempts_item_number_uq
  on ops.work_attempts (work_item_id, attempt_number)
--> statement-breakpoint
create index if not exists work_attempts_open_idx
  on ops.work_attempts (work_item_id)
  where outcome is null
--> statement-breakpoint
--
-- 5. ops.outbox_events — database architecture §14.5
--
-- The transactional outbox. A command writes its workflow, its items and this
-- row in one transaction, so a process that dies between commit and dispatch
-- loses nothing: the row is still there to be dispatched.
--
create table if not exists ops.outbox_events (
  id bigint generated always as identity primary key,
  aggregate_type text not null,
  aggregate_id text not null,
  event_type text not null,
  -- Both the outbox's own deduplication key and the deterministic task name the
  -- dispatcher creates, so a redelivered dispatch is rejected by the queue.
  dedup_key text not null,
  payload jsonb not null default '{}'::jsonb,
  -- 'superseded' is not a failure: the work item it would have woken has moved
  -- on (retried, cancelled, or already finished), so the message must not be
  -- sent and must not be counted as a dead letter either.
  state text not null default 'pending',
  available_at timestamptz not null default now(),
  publish_attempts integer not null default 0,
  published_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  constraint outbox_events_aggregate_type_check
    check (aggregate_type in ('workflow', 'work_item')),
  constraint outbox_events_state_check
    check (state in ('pending', 'published', 'dead', 'superseded')),
  constraint outbox_events_published_check check ((state = 'published') = (published_at is not null)),
  constraint outbox_events_attempts_check check (publish_attempts >= 0),
  constraint outbox_events_dedup_key_check check (dedup_key ~ '^[A-Za-z0-9_.:-]{1,200}$'),
  constraint outbox_events_payload_object_check check (jsonb_typeof(payload) = 'object'),
  constraint outbox_events_payload_size_check check (pg_column_size(payload) <= 2048)
)
--> statement-breakpoint
comment on table ops.outbox_events is 'Transactional outbox for reliable dispatch after canonical commits (database architecture 14.5). Payload carries identity and trace metadata only; the consumer reloads immutable inputs from Postgres or Storage.'
--> statement-breakpoint
create unique index if not exists outbox_events_dedup_key_uq
  on ops.outbox_events (dedup_key)
--> statement-breakpoint
create index if not exists outbox_events_pending_idx
  on ops.outbox_events (available_at, id)
  where state = 'pending'
--> statement-breakpoint
--
-- 6. Terminal monotonicity and append-only history
--
-- Platform spec §8: "A terminal state never returns to a nonterminal state."
-- That is not expressible as a check constraint, because it compares the row to
-- its own previous value, and it is the invariant a duplicate delivery or a
-- late lease-recovery sweep would otherwise break. So it is a trigger, and it
-- refuses rather than repairs.
--
create or replace function ops.guard_workflow_transition()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if old.state in ('succeeded', 'failed', 'cancelled') and new.state <> old.state then
    raise exception 'workflow % is terminal in state %; refusing transition to %',
      old.id, old.state, new.state
      using errcode = 'check_violation';
  end if;
  if new.created_at <> old.created_at then
    raise exception 'workflow created_at is immutable' using errcode = 'check_violation';
  end if;
  return new;
end
$$
--> statement-breakpoint
comment on function ops.guard_workflow_transition() is 'Enforces platform spec 8 terminal monotonicity for ops.workflows. A terminal workflow cannot be moved back to a nonterminal state by a duplicate delivery or a late sweep.'
--> statement-breakpoint
drop trigger if exists workflows_guard_transition on ops.workflows
--> statement-breakpoint
create trigger workflows_guard_transition
  before update on ops.workflows
  for each row execute function ops.guard_workflow_transition()
--> statement-breakpoint
create or replace function ops.guard_work_item_transition()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if old.status in ('succeeded', 'dead', 'cancelled') and new.status <> old.status then
    raise exception 'work item % is terminal in status %; refusing transition to %',
      old.id, old.status, new.status
      using errcode = 'check_violation';
  end if;
  if new.attempt_count < old.attempt_count then
    raise exception 'work item % attempt count cannot decrease', old.id
      using errcode = 'check_violation';
  end if;
  if new.dispatch_epoch < old.dispatch_epoch then
    raise exception 'work item % dispatch epoch cannot decrease', old.id
      using errcode = 'check_violation';
  end if;
  if new.workflow_id <> old.workflow_id or new.idempotency_key <> old.idempotency_key then
    raise exception 'work item % identity is immutable', old.id
      using errcode = 'check_violation';
  end if;
  return new;
end
$$
--> statement-breakpoint
comment on function ops.guard_work_item_transition() is 'Enforces terminal monotonicity and monotonic attempt/dispatch counters for ops.work_items, and freezes the row identity a stable idempotency key depends on.'
--> statement-breakpoint
drop trigger if exists work_items_guard_transition on ops.work_items
--> statement-breakpoint
create trigger work_items_guard_transition
  before update on ops.work_items
  for each row execute function ops.guard_work_item_transition()
--> statement-breakpoint
create or replace function ops.guard_work_attempt_history()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $$
begin
  if old.finished_at is not null then
    raise exception 'work attempt % is already finished; attempt history is append-only', old.id
      using errcode = 'check_violation';
  end if;
  if new.work_item_id <> old.work_item_id or new.attempt_number <> old.attempt_number
     or new.claimed_at <> old.claimed_at then
    raise exception 'work attempt % identity is immutable', old.id
      using errcode = 'check_violation';
  end if;
  return new;
end
$$
--> statement-breakpoint
comment on function ops.guard_work_attempt_history() is 'Keeps ops.work_attempts append-only in the sense database architecture 14.4 requires: an attempt may be finished once, and a finished attempt can never be rewritten.'
--> statement-breakpoint
drop trigger if exists work_attempts_guard_history on ops.work_attempts
--> statement-breakpoint
create trigger work_attempts_guard_history
  before update on ops.work_attempts
  for each row execute function ops.guard_work_attempt_history()
--> statement-breakpoint
revoke all on function ops.guard_workflow_transition() from public
--> statement-breakpoint
revoke all on function ops.guard_work_item_transition() from public
--> statement-breakpoint
revoke all on function ops.guard_work_attempt_history() from public
--> statement-breakpoint
--
-- 7. The E03 idempotency record's workflow reference
--
-- 0013 reserved the column for this epic. Adding the constraint now makes a
-- replayed command's workflow reference verifiable rather than advisory.
--
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'idempotency_records_workflow_id_fkey'
      and conrelid = 'ops.idempotency_records'::regclass
  ) then
    alter table ops.idempotency_records
      add constraint idempotency_records_workflow_id_fkey
      foreign key (workflow_id) references ops.workflows(id) on delete set null;
  end if;
end
$$
--> statement-breakpoint
-- Foreign keys are indexed (database architecture §28). Partial, because almost
-- every idempotency record is for a command that created no workflow at all.
create index if not exists idempotency_records_workflow_id_idx
  on ops.idempotency_records (workflow_id)
  where workflow_id is not null
--> statement-breakpoint
--
-- 8. Row level security
--
-- Forced, so not even the owning role bypasses the policies by accident. Like
-- 0013's operational tables these carry no actor predicate: the access model is
-- the named grant plus the absence of delete. API-level actor→subject
-- authorization is the tenancy boundary, and `ops.workflows.owner_profile_id`
-- is what it filters on.
--
alter table ops.workflows enable row level security
--> statement-breakpoint
alter table ops.workflows force row level security
--> statement-breakpoint
alter table ops.work_items enable row level security
--> statement-breakpoint
alter table ops.work_items force row level security
--> statement-breakpoint
alter table ops.work_item_dependencies enable row level security
--> statement-breakpoint
alter table ops.work_item_dependencies force row level security
--> statement-breakpoint
alter table ops.work_attempts enable row level security
--> statement-breakpoint
alter table ops.work_attempts force row level security
--> statement-breakpoint
alter table ops.outbox_events enable row level security
--> statement-breakpoint
alter table ops.outbox_events force row level security
--> statement-breakpoint
drop policy if exists workflows_runtime on ops.workflows
--> statement-breakpoint
create policy workflows_runtime on ops.workflows
  as permissive for all
  to forma_api, forma_ops, forma_ingestion, forma_stockfish, forma_analysis
  using (true) with check (true)
--> statement-breakpoint
comment on policy workflows_runtime on ops.workflows is 'Runtime roles only. Tenancy is the API actor→subject check against owner_profile_id; no browser role reaches this table at all. Never extend to anon, authenticated, service_role or PUBLIC.'
--> statement-breakpoint
drop policy if exists work_items_runtime on ops.work_items
--> statement-breakpoint
create policy work_items_runtime on ops.work_items
  as permissive for all
  to forma_api, forma_ops, forma_ingestion, forma_stockfish, forma_analysis
  using (true) with check (true)
--> statement-breakpoint
drop policy if exists work_item_dependencies_runtime on ops.work_item_dependencies
--> statement-breakpoint
create policy work_item_dependencies_runtime on ops.work_item_dependencies
  as permissive for all
  to forma_api, forma_ops, forma_ingestion, forma_stockfish, forma_analysis
  using (true) with check (true)
--> statement-breakpoint
drop policy if exists work_attempts_runtime on ops.work_attempts
--> statement-breakpoint
create policy work_attempts_runtime on ops.work_attempts
  as permissive for all
  to forma_api, forma_ops, forma_ingestion, forma_stockfish, forma_analysis
  using (true) with check (true)
--> statement-breakpoint
drop policy if exists outbox_events_runtime on ops.outbox_events
--> statement-breakpoint
create policy outbox_events_runtime on ops.outbox_events
  as permissive for all
  to forma_api, forma_ops, forma_ingestion, forma_stockfish, forma_analysis
  using (true) with check (true)
--> statement-breakpoint
--
-- 9. Named grants
--
-- Explicit per table and per action, as E02 requires. No role receives delete
-- on any ledger table: a workflow, an item, an attempt and an outbox row are
-- the evidence that committed work existed, and the rollback contract is
-- forward recovery rather than deletion. Rows leave only with the profile they
-- belong to, by cascade.
--
grant select, insert, update on ops.workflows to forma_api
--> statement-breakpoint
grant select, insert, update on ops.workflows to forma_ops
--> statement-breakpoint
grant select, update on ops.workflows to forma_ingestion
--> statement-breakpoint
grant select, update on ops.workflows to forma_stockfish
--> statement-breakpoint
grant select, update on ops.workflows to forma_analysis
--> statement-breakpoint
grant select, insert, update on ops.work_items to forma_api
--> statement-breakpoint
grant select, insert, update on ops.work_items to forma_ops
--> statement-breakpoint
grant select, update on ops.work_items to forma_ingestion
--> statement-breakpoint
grant select, update on ops.work_items to forma_stockfish
--> statement-breakpoint
grant select, update on ops.work_items to forma_analysis
--> statement-breakpoint
grant usage, select on sequence ops.work_items_id_seq to forma_api
--> statement-breakpoint
grant usage, select on sequence ops.work_items_id_seq to forma_ops
--> statement-breakpoint
grant select, insert on ops.work_item_dependencies to forma_api
--> statement-breakpoint
grant select, insert on ops.work_item_dependencies to forma_ops
--> statement-breakpoint
grant select on ops.work_item_dependencies to forma_ingestion
--> statement-breakpoint
grant select on ops.work_item_dependencies to forma_stockfish
--> statement-breakpoint
grant select on ops.work_item_dependencies to forma_analysis
--> statement-breakpoint
-- The API reads attempt history for the operator diagnostic on a dead workflow.
-- It also writes it, for one reason that is a fact about today rather than a
-- design: the legacy analysis pipeline still runs inside the API process
-- (platform audit §4 A-03), so the API process is currently also a worker and
-- its shadow work items record real attempts. E05 moves that runner to its own
-- deployment; the insert and update below are the grants to drop when it does.
grant select, insert, update on ops.work_attempts to forma_api
--> statement-breakpoint
grant select, insert, update on ops.work_attempts to forma_ops
--> statement-breakpoint
grant select, insert, update on ops.work_attempts to forma_ingestion
--> statement-breakpoint
grant select, insert, update on ops.work_attempts to forma_stockfish
--> statement-breakpoint
grant select, insert, update on ops.work_attempts to forma_analysis
--> statement-breakpoint
grant usage, select on sequence ops.work_attempts_id_seq to forma_api
--> statement-breakpoint
grant usage, select on sequence ops.work_attempts_id_seq to forma_ops
--> statement-breakpoint
grant usage, select on sequence ops.work_attempts_id_seq to forma_ingestion
--> statement-breakpoint
grant usage, select on sequence ops.work_attempts_id_seq to forma_stockfish
--> statement-breakpoint
grant usage, select on sequence ops.work_attempts_id_seq to forma_analysis
--> statement-breakpoint
-- The API and every worker may enqueue an outbox row inside the transaction
-- that commits their work. Only forma_ops dispatches, so only it may update.
grant select, insert on ops.outbox_events to forma_api
--> statement-breakpoint
grant select, insert, update on ops.outbox_events to forma_ops
--> statement-breakpoint
grant select, insert on ops.outbox_events to forma_ingestion
--> statement-breakpoint
grant select, insert on ops.outbox_events to forma_stockfish
--> statement-breakpoint
grant select, insert on ops.outbox_events to forma_analysis
--> statement-breakpoint
grant usage, select on sequence ops.outbox_events_id_seq to forma_api
--> statement-breakpoint
grant usage, select on sequence ops.outbox_events_id_seq to forma_ops
--> statement-breakpoint
grant usage, select on sequence ops.outbox_events_id_seq to forma_ingestion
--> statement-breakpoint
grant usage, select on sequence ops.outbox_events_id_seq to forma_stockfish
--> statement-breakpoint
grant usage, select on sequence ops.outbox_events_id_seq to forma_analysis
--> statement-breakpoint
--
-- 10. Browser and PUBLIC exclusion
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
    'ops.workflows', 'ops.work_items', 'ops.work_item_dependencies',
    'ops.work_attempts', 'ops.outbox_events'
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

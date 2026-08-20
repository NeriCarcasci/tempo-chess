-- 0021_e10_backfill
--
-- E10 — the resumable legacy backfill ledger.
--
-- Hand-written and reviewed. Additive and forward-only: one table in `ops`, no
-- existing object changed, no row touched, nothing dropped or renamed. The
-- legacy `public` tables stay exactly as they are and remain authoritative
-- until an explicit cutover gate passes.
--
-- One table rather than a run/checkpoint pair. A backfill over a bounded legacy
-- table is a single cursor advancing through a stable set, so a separate
-- checkpoint table would record the same fact twice.

set local role forma_migrator
--> statement-breakpoint
create table if not exists ops.backfill_runs (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  state text not null default 'running',
  -- The resume point: the last legacy row consumed, in a stable order.
  cursor_value text,
  processed integer not null default 0,
  created integer not null default 0,
  skipped integer not null default 0,
  mismatched integer not null default 0,
  -- Deterministic over what was read, so a rerun that sees the same legacy rows
  -- produces the same value and drift is visible rather than inferred.
  source_checksum text,
  target_checksum text,
  manifest jsonb,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  failure_class text,
  constraint backfill_runs_kind_check check (kind in ('identity', 'games', 'reconcile')),
  constraint backfill_runs_state_check
    check (state in ('running', 'succeeded', 'failed', 'cancelled')),
  constraint backfill_runs_counts_sane check (
    processed >= 0 and created >= 0 and skipped >= 0 and mismatched >= 0
  ),
  constraint backfill_runs_finished check ((state = 'running') = (finished_at is null))
)
--> statement-breakpoint
comment on table ops.backfill_runs is 'One resumable pass over the legacy tables (database architecture 31, 33-36). cursor_value is the last legacy row consumed in a stable order, so a run that dies resumes without duplicating; every insert it makes is guarded by its natural key, so resuming is idempotent rather than merely safe. The legacy tables are never modified: this is an expand step, and no drop or rename happens here or later.'
--> statement-breakpoint
comment on column ops.backfill_runs.manifest is 'Counts and checksums by category, for comparison against the legacy source. Carries no game id, url or player name.'
--> statement-breakpoint
create index if not exists backfill_runs_kind on ops.backfill_runs (kind, started_at desc)
--> statement-breakpoint
grant select, insert, update on ops.backfill_runs to forma_ops, forma_ingestion
--> statement-breakpoint
grant select on ops.backfill_runs to forma_api
--> statement-breakpoint
revoke all on ops.backfill_runs from public
--> statement-breakpoint
reset role

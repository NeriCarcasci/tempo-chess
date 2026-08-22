-- 0038_maia3_position_continuations
--
-- A Maia continuation is durable model work, but it is neither a historical
-- game analysis nor an objective position evaluation. It has its own service,
-- resource class, queue and least-privilege role so player latency cannot be
-- consumed by onboarding and offline analysis work.

-- Role creation is an administrative bootstrap just like 0012. Production
-- applies this migration with the owner credential; the password is generated
-- out of band and stored only in Secret Manager.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'forma_maia') then
    create role forma_maia with login noinherit nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end
$$
--> statement-breakpoint
alter role forma_maia connection limit 2
--> statement-breakpoint
alter role forma_analysis connection limit 4
--> statement-breakpoint
comment on role forma_maia is
  'Interactive Maia CPU policy-serving role. Reads canonical positions and promoted model identity, writes anonymous policy cache rows, and advances only its durable work attempts.'
--> statement-breakpoint

set local role forma_migrator
--> statement-breakpoint
alter table ops.workflows drop constraint if exists workflows_kind_check
--> statement-breakpoint
alter table ops.workflows add constraint workflows_kind_check
  check (kind in (
    'account_sync', 'game_import', 'initial_examination', 'game_analysis',
    'model_backfill', 'subject_estimation', 'maintenance', 'position_evaluation',
    'position_continuation'
  ))
--> statement-breakpoint
comment on constraint workflows_kind_check on ops.workflows is
  'Closed product-operation vocabulary. position_continuation is CPU human-policy work and is intentionally distinct from objective position_evaluation and historical game_analysis.'
--> statement-breakpoint
alter table ops.work_items drop constraint if exists work_items_resource_class_check
--> statement-breakpoint
alter table ops.work_items add constraint work_items_resource_class_check
  check (resource_class in (
    'api_light', 'ingestion', 'cpu_engine', 'cpu_model',
    'cpu_interactive_model', 'gpu_model', 'aggregation', 'publication'
  ))
--> statement-breakpoint
alter table ops.work_items drop constraint if exists work_items_queue_check
--> statement-breakpoint
alter table ops.work_items add constraint work_items_queue_check
  check (queue is null or queue in (
    'provider-lichess', 'provider-chesscom', 'stockfish-screen', 'stockfish-deep',
    'analysis', 'maia-play', 'maintenance'
  ))
--> statement-breakpoint

grant usage on schema chess, analysis, ops to forma_maia
--> statement-breakpoint
grant select on chess.core_positions to forma_maia
--> statement-breakpoint
grant select on analysis.component_versions, analysis.component_lifecycle_events,
  analysis.model_profiles to forma_maia
--> statement-breakpoint
grant select, insert on analysis.model_inferences, analysis.model_move_probabilities to forma_maia
--> statement-breakpoint

grant select, update on ops.workflows, ops.work_items to forma_maia
--> statement-breakpoint
grant select on ops.work_item_dependencies to forma_maia
--> statement-breakpoint
grant select, insert, update on ops.work_attempts to forma_maia
--> statement-breakpoint
grant usage, select on sequence ops.work_attempts_id_seq to forma_maia
--> statement-breakpoint
grant select, insert on ops.outbox_events to forma_maia
--> statement-breakpoint
grant usage, select on sequence ops.outbox_events_id_seq to forma_maia
--> statement-breakpoint

drop policy if exists workflows_runtime on ops.workflows
--> statement-breakpoint
create policy workflows_runtime on ops.workflows
  as permissive for all
  to forma_api, forma_ops, forma_ingestion, forma_stockfish, forma_analysis, forma_maia
  using (true) with check (true)
--> statement-breakpoint
drop policy if exists work_items_runtime on ops.work_items
--> statement-breakpoint
create policy work_items_runtime on ops.work_items
  as permissive for all
  to forma_api, forma_ops, forma_ingestion, forma_stockfish, forma_analysis, forma_maia
  using (true) with check (true)
--> statement-breakpoint
drop policy if exists work_item_dependencies_runtime on ops.work_item_dependencies
--> statement-breakpoint
create policy work_item_dependencies_runtime on ops.work_item_dependencies
  as permissive for all
  to forma_api, forma_ops, forma_ingestion, forma_stockfish, forma_analysis, forma_maia
  using (true) with check (true)
--> statement-breakpoint
drop policy if exists work_attempts_runtime on ops.work_attempts
--> statement-breakpoint
create policy work_attempts_runtime on ops.work_attempts
  as permissive for all
  to forma_api, forma_ops, forma_ingestion, forma_stockfish, forma_analysis, forma_maia
  using (true) with check (true)
--> statement-breakpoint
drop policy if exists outbox_events_runtime on ops.outbox_events
--> statement-breakpoint
create policy outbox_events_runtime on ops.outbox_events
  as permissive for all
  to forma_api, forma_ops, forma_ingestion, forma_stockfish, forma_analysis, forma_maia
  using (true) with check (true)

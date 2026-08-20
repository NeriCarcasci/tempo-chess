-- 0011_e01_containment
--
-- E01 — contain live Supabase exposure on the legacy `public` schema.
--
-- Generated from server/src/security/contract.ts by
-- `npm run security:generate-migration -- --write`. Do not hand-edit: the
-- contract test regenerates this file and fails on any difference.
--
-- Closes plans/v1-platform-audit.md §4 A-01. Before this migration `anon` and
-- `authenticated` held SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER
-- on all 22 legacy tables, ten tables had RLS enabled with no policy, twelve had
-- RLS off entirely, and default privileges re-granted everything to browser
-- roles on each new table.
--
-- Forward-only and repeatable. It creates no credential, drops no data, and
-- renames nothing. Rollback is the paired forward migration documented in
-- docs/security/E01-runbook.md.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'forma_api') then
    create role forma_api with login noinherit nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end
$$
--> statement-breakpoint
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'forma_migrator') then
    create role forma_migrator with login noinherit nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end
$$
--> statement-breakpoint
do $$
begin
  begin
    execute 'alter role forma_api nosuperuser nocreatedb nocreaterole nobypassrls';
  exception when insufficient_privilege then
    raise notice 'e01: cannot re-assert attributes on forma_api; the probe suite verifies them instead';
  end;
end
$$
--> statement-breakpoint
do $$
begin
  begin
    execute 'alter role forma_migrator nosuperuser nocreatedb nocreaterole nobypassrls';
  exception when insufficient_privilege then
    raise notice 'e01: cannot re-assert attributes on forma_migrator; the probe suite verifies them instead';
  end;
end
$$
--> statement-breakpoint
comment on role forma_api is 'E01: named least-privilege runtime role for forma-api. No BYPASSRLS, no ownership. Password lives only in Secret Manager.'
--> statement-breakpoint
comment on role forma_migrator is 'E01: deployment-only migration role. Used by Cloud Run Jobs over the direct endpoint, never by request-path traffic.'
--> statement-breakpoint
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'postgres') then
    begin
      execute 'alter default privileges for role postgres in schema public revoke all on tables from public, anon, authenticated';
    exception when insufficient_privilege then
      -- Supabase owns some of these roles and they carry SUPERUSER, which only
      -- another superuser may alter. Skipping is correct rather than fatal:
      -- such a grantor's defaults govern only objects it creates itself, and
      -- the ownership probe fails if any of those exist in this schema.
      raise notice 'e01: cannot alter default privileges for postgres; ownership probe covers the residual case';
    end;
  end if;
end
$$
--> statement-breakpoint
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'postgres') then
    begin
      execute 'alter default privileges for role postgres in schema public revoke all on sequences from public, anon, authenticated';
    exception when insufficient_privilege then
      -- Supabase owns some of these roles and they carry SUPERUSER, which only
      -- another superuser may alter. Skipping is correct rather than fatal:
      -- such a grantor's defaults govern only objects it creates itself, and
      -- the ownership probe fails if any of those exist in this schema.
      raise notice 'e01: cannot alter default privileges for postgres; ownership probe covers the residual case';
    end;
  end if;
end
$$
--> statement-breakpoint
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'postgres') then
    begin
      execute 'alter default privileges for role postgres in schema public revoke all on functions from public, anon, authenticated';
    exception when insufficient_privilege then
      -- Supabase owns some of these roles and they carry SUPERUSER, which only
      -- another superuser may alter. Skipping is correct rather than fatal:
      -- such a grantor's defaults govern only objects it creates itself, and
      -- the ownership probe fails if any of those exist in this schema.
      raise notice 'e01: cannot alter default privileges for postgres; ownership probe covers the residual case';
    end;
  end if;
end
$$
--> statement-breakpoint
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    begin
      execute 'alter default privileges for role supabase_admin in schema public revoke all on tables from public, anon, authenticated';
    exception when insufficient_privilege then
      -- Supabase owns some of these roles and they carry SUPERUSER, which only
      -- another superuser may alter. Skipping is correct rather than fatal:
      -- such a grantor's defaults govern only objects it creates itself, and
      -- the ownership probe fails if any of those exist in this schema.
      raise notice 'e01: cannot alter default privileges for supabase_admin; ownership probe covers the residual case';
    end;
  end if;
end
$$
--> statement-breakpoint
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    begin
      execute 'alter default privileges for role supabase_admin in schema public revoke all on sequences from public, anon, authenticated';
    exception when insufficient_privilege then
      -- Supabase owns some of these roles and they carry SUPERUSER, which only
      -- another superuser may alter. Skipping is correct rather than fatal:
      -- such a grantor's defaults govern only objects it creates itself, and
      -- the ownership probe fails if any of those exist in this schema.
      raise notice 'e01: cannot alter default privileges for supabase_admin; ownership probe covers the residual case';
    end;
  end if;
end
$$
--> statement-breakpoint
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    begin
      execute 'alter default privileges for role supabase_admin in schema public revoke all on functions from public, anon, authenticated';
    exception when insufficient_privilege then
      -- Supabase owns some of these roles and they carry SUPERUSER, which only
      -- another superuser may alter. Skipping is correct rather than fatal:
      -- such a grantor's defaults govern only objects it creates itself, and
      -- the ownership probe fails if any of those exist in this schema.
      raise notice 'e01: cannot alter default privileges for supabase_admin; ownership probe covers the residual case';
    end;
  end if;
end
$$
--> statement-breakpoint
revoke all on all tables in schema public from public, anon, authenticated
--> statement-breakpoint
revoke all on all sequences in schema public from public, anon, authenticated
--> statement-breakpoint
revoke all on all functions in schema public from public, anon, authenticated
--> statement-breakpoint
revoke all on all routines in schema public from public, anon, authenticated
--> statement-breakpoint
revoke all on schema public from public, anon, authenticated
--> statement-breakpoint
grant usage on schema public to forma_api
--> statement-breakpoint
grant usage, create on schema public to forma_migrator
--> statement-breakpoint
alter table public.analysis_imports enable row level security
--> statement-breakpoint
drop policy if exists analysis_imports_forma_api_service_dataplane on public.analysis_imports
--> statement-breakpoint
grant select, insert, update on public.analysis_imports to forma_api
--> statement-breakpoint
create policy analysis_imports_forma_api_service_dataplane on public.analysis_imports as permissive for all to forma_api using (true) with check (true)
--> statement-breakpoint
comment on policy analysis_imports_forma_api_service_dataplane on public.analysis_imports is 'E01 service data-plane policy. Scoped to forma_api only; tenant enforcement is in the API authorization layer until E03 propagates actor context. Never widen to anon/authenticated/PUBLIC.'
--> statement-breakpoint
comment on table public.analysis_imports is 'E01: internal. Browser roles hold no grant and no policy. Import lifecycle rows are read and advanced by the pipeline service.'
--> statement-breakpoint
alter table public.analysis_tasks enable row level security
--> statement-breakpoint
drop policy if exists analysis_tasks_forma_api_service_dataplane on public.analysis_tasks
--> statement-breakpoint
grant select, insert, update on public.analysis_tasks to forma_api
--> statement-breakpoint
create policy analysis_tasks_forma_api_service_dataplane on public.analysis_tasks as permissive for all to forma_api using (true) with check (true)
--> statement-breakpoint
comment on policy analysis_tasks_forma_api_service_dataplane on public.analysis_tasks is 'E01 service data-plane policy. Scoped to forma_api only; tenant enforcement is in the API authorization layer until E03 propagates actor context. Never widen to anon/authenticated/PUBLIC.'
--> statement-breakpoint
comment on table public.analysis_tasks is 'E01: internal. Browser roles hold no grant and no policy. Work rows are claimed with FOR UPDATE SKIP LOCKED and transitioned in place.'
--> statement-breakpoint
alter table public.beta_signups enable row level security
--> statement-breakpoint
drop policy if exists beta_signups_forma_api_service_dataplane on public.beta_signups
--> statement-breakpoint
grant select, insert, update on public.beta_signups to forma_api
--> statement-breakpoint
create policy beta_signups_forma_api_service_dataplane on public.beta_signups as permissive for all to forma_api using (true) with check (true)
--> statement-breakpoint
comment on policy beta_signups_forma_api_service_dataplane on public.beta_signups is 'E01 service data-plane policy. Scoped to forma_api only; tenant enforcement is in the API authorization layer until E03 propagates actor context. Never widen to anon/authenticated/PUBLIC.'
--> statement-breakpoint
comment on table public.beta_signups is 'E01: internal. Browser roles hold no grant and no policy. Public signup form writes through the API; upsert on email needs SELECT and UPDATE.'
--> statement-breakpoint
alter table public.canonical_moves enable row level security
--> statement-breakpoint
drop policy if exists canonical_moves_forma_api_service_dataplane on public.canonical_moves
--> statement-breakpoint
grant select, insert, delete on public.canonical_moves to forma_api
--> statement-breakpoint
create policy canonical_moves_forma_api_service_dataplane on public.canonical_moves as permissive for all to forma_api using (true) with check (true)
--> statement-breakpoint
comment on policy canonical_moves_forma_api_service_dataplane on public.canonical_moves is 'E01 service data-plane policy. Scoped to forma_api only; tenant enforcement is in the API authorization layer until E03 propagates actor context. Never widen to anon/authenticated/PUBLIC.'
--> statement-breakpoint
comment on table public.canonical_moves is 'E01: internal. Browser roles hold no grant and no policy. Legacy re-import deletes and reinserts the replay; A-04 replaces this in E08.'
--> statement-breakpoint
alter table public.game_sources enable row level security
--> statement-breakpoint
drop policy if exists game_sources_forma_api_service_dataplane on public.game_sources
--> statement-breakpoint
grant select, insert, update on public.game_sources to forma_api
--> statement-breakpoint
create policy game_sources_forma_api_service_dataplane on public.game_sources as permissive for all to forma_api using (true) with check (true)
--> statement-breakpoint
comment on policy game_sources_forma_api_service_dataplane on public.game_sources is 'E01 service data-plane policy. Scoped to forma_api only; tenant enforcement is in the API authorization layer until E03 propagates actor context. Never widen to anon/authenticated/PUBLIC.'
--> statement-breakpoint
comment on table public.game_sources is 'E01: internal. Browser roles hold no grant and no policy. Per-account provenance row is upserted on each sync checkpoint.'
--> statement-breakpoint
alter table public.games enable row level security
--> statement-breakpoint
drop policy if exists games_forma_api_service_dataplane on public.games
--> statement-breakpoint
grant select, insert, update on public.games to forma_api
--> statement-breakpoint
create policy games_forma_api_service_dataplane on public.games as permissive for all to forma_api using (true) with check (true)
--> statement-breakpoint
comment on policy games_forma_api_service_dataplane on public.games is 'E01 service data-plane policy. Scoped to forma_api only; tenant enforcement is in the API authorization layer until E03 propagates actor context. Never widen to anon/authenticated/PUBLIC.'
--> statement-breakpoint
comment on table public.games is 'E01: internal. Browser roles hold no grant and no policy. Games are listed, joined, and upserted by provider game id.'
--> statement-breakpoint
alter table public.lesson_progress enable row level security
--> statement-breakpoint
drop policy if exists lesson_progress_forma_api_service_dataplane on public.lesson_progress
--> statement-breakpoint
grant select, insert, update on public.lesson_progress to forma_api
--> statement-breakpoint
create policy lesson_progress_forma_api_service_dataplane on public.lesson_progress as permissive for all to forma_api using (true) with check (true)
--> statement-breakpoint
comment on policy lesson_progress_forma_api_service_dataplane on public.lesson_progress is 'E01 service data-plane policy. Scoped to forma_api only; tenant enforcement is in the API authorization layer until E03 propagates actor context. Never widen to anon/authenticated/PUBLIC.'
--> statement-breakpoint
comment on table public.lesson_progress is 'E01: internal. Browser roles hold no grant and no policy. Lesson progress is upserted per user and slug.'
--> statement-breakpoint
alter table public.linked_accounts enable row level security
--> statement-breakpoint
drop policy if exists linked_accounts_forma_api_service_dataplane on public.linked_accounts
--> statement-breakpoint
grant select, insert, update on public.linked_accounts to forma_api
--> statement-breakpoint
create policy linked_accounts_forma_api_service_dataplane on public.linked_accounts as permissive for all to forma_api using (true) with check (true)
--> statement-breakpoint
comment on policy linked_accounts_forma_api_service_dataplane on public.linked_accounts is 'E01 service data-plane policy. Scoped to forma_api only; tenant enforcement is in the API authorization layer until E03 propagates actor context. Never widen to anon/authenticated/PUBLIC.'
--> statement-breakpoint
comment on table public.linked_accounts is 'E01: internal. Browser roles hold no grant and no policy. Account resolution reads on every authorized request; linking upserts the display name.'
--> statement-breakpoint
alter table public.mistakes enable row level security
--> statement-breakpoint
drop policy if exists mistakes_forma_api_service_dataplane on public.mistakes
--> statement-breakpoint
grant select on public.mistakes to forma_api
--> statement-breakpoint
create policy mistakes_forma_api_service_dataplane on public.mistakes as permissive for all to forma_api using (true) with check (true)
--> statement-breakpoint
comment on policy mistakes_forma_api_service_dataplane on public.mistakes is 'E01 service data-plane policy. Scoped to forma_api only; tenant enforcement is in the API authorization layer until E03 propagates actor context. Never widen to anon/authenticated/PUBLIC.'
--> statement-breakpoint
comment on table public.mistakes is 'E01: internal. Browser roles hold no grant and no policy. Read-only join in the review path; the legacy table is superseded in E13.'
--> statement-breakpoint
alter table public.opening_drills enable row level security
--> statement-breakpoint
drop policy if exists opening_drills_forma_api_service_dataplane on public.opening_drills
--> statement-breakpoint
grant select, insert, update on public.opening_drills to forma_api
--> statement-breakpoint
create policy opening_drills_forma_api_service_dataplane on public.opening_drills as permissive for all to forma_api using (true) with check (true)
--> statement-breakpoint
comment on policy opening_drills_forma_api_service_dataplane on public.opening_drills is 'E01 service data-plane policy. Scoped to forma_api only; tenant enforcement is in the API authorization layer until E03 propagates actor context. Never widen to anon/authenticated/PUBLIC.'
--> statement-breakpoint
comment on table public.opening_drills is 'E01: internal. Browser roles hold no grant and no policy. Drill creation upserts and requeues an existing drill.'
--> statement-breakpoint
alter table public.opening_edges enable row level security
--> statement-breakpoint
drop policy if exists opening_edges_forma_api_service_dataplane on public.opening_edges
--> statement-breakpoint
grant select, insert, update on public.opening_edges to forma_api
--> statement-breakpoint
create policy opening_edges_forma_api_service_dataplane on public.opening_edges as permissive for all to forma_api using (true) with check (true)
--> statement-breakpoint
comment on policy opening_edges_forma_api_service_dataplane on public.opening_edges is 'E01 service data-plane policy. Scoped to forma_api only; tenant enforcement is in the API authorization layer until E03 propagates actor context. Never widen to anon/authenticated/PUBLIC.'
--> statement-breakpoint
comment on table public.opening_edges is 'E01: internal. Browser roles hold no grant and no policy. Shared opening catalogue read by the explorer and upserted by catalogue import.'
--> statement-breakpoint
alter table public.opening_positions enable row level security
--> statement-breakpoint
drop policy if exists opening_positions_forma_api_service_dataplane on public.opening_positions
--> statement-breakpoint
grant select, insert, update on public.opening_positions to forma_api
--> statement-breakpoint
create policy opening_positions_forma_api_service_dataplane on public.opening_positions as permissive for all to forma_api using (true) with check (true)
--> statement-breakpoint
comment on policy opening_positions_forma_api_service_dataplane on public.opening_positions is 'E01 service data-plane policy. Scoped to forma_api only; tenant enforcement is in the API authorization layer until E03 propagates actor context. Never widen to anon/authenticated/PUBLIC.'
--> statement-breakpoint
comment on table public.opening_positions is 'E01: internal. Browser roles hold no grant and no policy. Shared opening catalogue read by the explorer and upserted by catalogue import.'
--> statement-breakpoint
alter table public.opening_repertoire_moves enable row level security
--> statement-breakpoint
drop policy if exists opening_repertoire_moves_forma_api_service_dataplane on public.opening_repertoire_moves
--> statement-breakpoint
grant select, insert, update, delete on public.opening_repertoire_moves to forma_api
--> statement-breakpoint
create policy opening_repertoire_moves_forma_api_service_dataplane on public.opening_repertoire_moves as permissive for all to forma_api using (true) with check (true)
--> statement-breakpoint
comment on policy opening_repertoire_moves_forma_api_service_dataplane on public.opening_repertoire_moves is 'E01 service data-plane policy. Scoped to forma_api only; tenant enforcement is in the API authorization layer until E03 propagates actor context. Never widen to anon/authenticated/PUBLIC.'
--> statement-breakpoint
comment on table public.opening_repertoire_moves is 'E01: internal. Browser roles hold no grant and no policy. Repertoire choices are set, replaced, and cleared by the owning user.'
--> statement-breakpoint
alter table public.opening_training_results enable row level security
--> statement-breakpoint
drop policy if exists opening_training_results_forma_api_service_dataplane on public.opening_training_results
--> statement-breakpoint
grant select, insert on public.opening_training_results to forma_api
--> statement-breakpoint
create policy opening_training_results_forma_api_service_dataplane on public.opening_training_results as permissive for all to forma_api using (true) with check (true)
--> statement-breakpoint
comment on policy opening_training_results_forma_api_service_dataplane on public.opening_training_results is 'E01 service data-plane policy. Scoped to forma_api only; tenant enforcement is in the API authorization layer until E03 propagates actor context. Never widen to anon/authenticated/PUBLIC.'
--> statement-breakpoint
comment on table public.opening_training_results is 'E01: internal. Browser roles hold no grant and no policy. Append-only drill results; read back for practice activity.'
--> statement-breakpoint
alter table public.player_opening_observations enable row level security
--> statement-breakpoint
drop policy if exists player_opening_observations_forma_api_service_dataplane on public.player_opening_observations
--> statement-breakpoint
grant select, insert, update on public.player_opening_observations to forma_api
--> statement-breakpoint
create policy player_opening_observations_forma_api_service_dataplane on public.player_opening_observations as permissive for all to forma_api using (true) with check (true)
--> statement-breakpoint
comment on policy player_opening_observations_forma_api_service_dataplane on public.player_opening_observations is 'E01 service data-plane policy. Scoped to forma_api only; tenant enforcement is in the API authorization layer until E03 propagates actor context. Never widen to anon/authenticated/PUBLIC.'
--> statement-breakpoint
comment on table public.player_opening_observations is 'E01: internal. Browser roles hold no grant and no policy. Per-game opening observations are upserted during materialization.'
--> statement-breakpoint
alter table public.player_opening_stats enable row level security
--> statement-breakpoint
drop policy if exists player_opening_stats_forma_api_service_dataplane on public.player_opening_stats
--> statement-breakpoint
comment on table public.player_opening_stats is 'E01: legacy, no live reader. Denied to forma_api and to all browser roles. No statement in server/src references it. Denied to the runtime until E10 rebuilds it.'
--> statement-breakpoint
alter table public.player_style enable row level security
--> statement-breakpoint
drop policy if exists player_style_forma_api_service_dataplane on public.player_style
--> statement-breakpoint
comment on table public.player_style is 'E01: legacy, no live reader. Denied to forma_api and to all browser roles. Mutable singleton with no live reader. Denied to the runtime; replaced in E15.'
--> statement-breakpoint
alter table public.position_eval enable row level security
--> statement-breakpoint
drop policy if exists position_eval_forma_api_service_dataplane on public.position_eval
--> statement-breakpoint
grant select, insert on public.position_eval to forma_api
--> statement-breakpoint
create policy position_eval_forma_api_service_dataplane on public.position_eval as permissive for all to forma_api using (true) with check (true)
--> statement-breakpoint
comment on policy position_eval_forma_api_service_dataplane on public.position_eval is 'E01 service data-plane policy. Scoped to forma_api only; tenant enforcement is in the API authorization layer until E03 propagates actor context. Never widen to anon/authenticated/PUBLIC.'
--> statement-breakpoint
comment on table public.position_eval is 'E01: internal. Browser roles hold no grant and no policy. Anonymous engine cache; inserted with ON CONFLICT DO NOTHING, never updated.'
--> statement-breakpoint
alter table public.profiles enable row level security
--> statement-breakpoint
drop policy if exists profiles_forma_api_service_dataplane on public.profiles
--> statement-breakpoint
grant select, insert, update, delete on public.profiles to forma_api
--> statement-breakpoint
create policy profiles_forma_api_service_dataplane on public.profiles as permissive for all to forma_api using (true) with check (true)
--> statement-breakpoint
comment on policy profiles_forma_api_service_dataplane on public.profiles is 'E01 service data-plane policy. Scoped to forma_api only; tenant enforcement is in the API authorization layer until E03 propagates actor context. Never widen to anon/authenticated/PUBLIC.'
--> statement-breakpoint
comment on table public.profiles is 'E01: internal. Browser roles hold no grant and no policy. Profile mirror is upserted on first authenticated request and removed on account deletion.'
--> statement-breakpoint
alter table public.puzzles enable row level security
--> statement-breakpoint
drop policy if exists puzzles_forma_api_service_dataplane on public.puzzles
--> statement-breakpoint
comment on table public.puzzles is 'E01: legacy, no live reader. Denied to forma_api and to all browser roles. No statement in server/src references it. Denied to the runtime; replaced in E18.'
--> statement-breakpoint
alter table public.repertoire_openings enable row level security
--> statement-breakpoint
drop policy if exists repertoire_openings_forma_api_service_dataplane on public.repertoire_openings
--> statement-breakpoint
grant select, insert, delete on public.repertoire_openings to forma_api
--> statement-breakpoint
create policy repertoire_openings_forma_api_service_dataplane on public.repertoire_openings as permissive for all to forma_api using (true) with check (true)
--> statement-breakpoint
comment on policy repertoire_openings_forma_api_service_dataplane on public.repertoire_openings is 'E01 service data-plane policy. Scoped to forma_api only; tenant enforcement is in the API authorization layer until E03 propagates actor context. Never widen to anon/authenticated/PUBLIC.'
--> statement-breakpoint
comment on table public.repertoire_openings is 'E01: internal. Browser roles hold no grant and no policy. Family selections are inserted with DO NOTHING and cleared; never updated in place.'
--> statement-breakpoint
alter table public.usage_events enable row level security
--> statement-breakpoint
drop policy if exists usage_events_forma_api_service_dataplane on public.usage_events
--> statement-breakpoint
grant select, insert on public.usage_events to forma_api
--> statement-breakpoint
create policy usage_events_forma_api_service_dataplane on public.usage_events as permissive for all to forma_api using (true) with check (true)
--> statement-breakpoint
comment on policy usage_events_forma_api_service_dataplane on public.usage_events is 'E01 service data-plane policy. Scoped to forma_api only; tenant enforcement is in the API authorization layer until E03 propagates actor context. Never widen to anon/authenticated/PUBLIC.'
--> statement-breakpoint
comment on table public.usage_events is 'E01: internal. Browser roles hold no grant and no policy. Append-only usage ledger; summarized by read queries.'
--> statement-breakpoint
do $$
declare
  seq record;
begin
  for seq in
    select c.oid::regclass as name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'S'
  loop
    execute format('grant usage, select on sequence %s to forma_api', seq.name);
  end loop;
end
$$

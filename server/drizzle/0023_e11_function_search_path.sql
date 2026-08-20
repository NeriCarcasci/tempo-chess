-- 0023_e11_function_search_path
--
-- Pin `search_path` on the trigger functions.
--
-- Supabase's security linter flags a function whose `search_path` is left to the
-- caller: a function that resolves an unqualified name does so through whatever
-- schema list the invoking role happens to have, so a role that can create a
-- schema earlier on that path can decide which object the function touches.
-- These four are SECURITY INVOKER and every reference in them is already
-- schema-qualified, so the exposure is theoretical -- but the fix is one clause,
-- and leaving a new warning behind for a reason that reads as "it is probably
-- fine" is how a real one gets lost among them later.
--
-- A separate migration rather than an edit to 0022, which is already applied.
-- Editing an applied migration file is the unsafe way to fix one: the database
-- and the committed history stop agreeing about what ran.
--
-- `chess.refuse_revision_mutation` is E09's and carries the same warning. It is
-- corrected here because this is a `create or replace`, not a change to E09's
-- committed file, and because the fix is identical.

set local role forma_migrator
--> statement-breakpoint
create or replace function analysis.refuse_mutation() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '%.% is immutable; append a new row instead', tg_table_schema, tg_table_name
    using errcode = 'restrict_violation';
end;
$$
--> statement-breakpoint
create or replace function analysis.refuse_dependency_cycle() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    with recursive reachable as (
      select d.dependency_version_id as id
        from analysis.component_version_dependencies d
       where d.dependent_version_id = new.dependency_version_id
      union
      select d.dependency_version_id
        from analysis.component_version_dependencies d
        join reachable r on d.dependent_version_id = r.id
    )
    select 1 from reachable where id = new.dependent_version_id
  ) then
    raise exception 'component version dependency would create a cycle'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$
--> statement-breakpoint
create or replace function analysis.refuse_run_rewrite() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'analysis runs are append-only; cancel a run instead of deleting it'
      using errcode = 'restrict_violation';
  end if;
  if new.id <> old.id
     or new.run_type <> old.run_type
     or new.recipe_version_id <> old.recipe_version_id
     or new.subject_id <> old.subject_id
     or new.subject_game_id is distinct from old.subject_game_id
     or new.replay_revision_id is distinct from old.replay_revision_id
     or new.subject_data_snapshot_id is distinct from old.subject_data_snapshot_id
     or new.input_manifest_hash <> old.input_manifest_hash
     or new.parent_run_id is distinct from old.parent_run_id
     or new.created_at <> old.created_at then
    raise exception 'a run''s identity and inputs are immutable'
      using errcode = 'restrict_violation';
  end if;
  if old.status in ('succeeded', 'failed', 'cancelled') and new.status <> old.status then
    raise exception 'a terminal run status is final' using errcode = 'restrict_violation';
  end if;
  if old.output_manifest_hash is not null
     and new.output_manifest_hash is distinct from old.output_manifest_hash then
    raise exception 'a run output manifest is written once'
      using errcode = 'restrict_violation';
  end if;
  if old.completed_at is not null and new.completed_at is distinct from old.completed_at then
    raise exception 'a completed run keeps its completion time'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$
--> statement-breakpoint
create or replace function chess.refuse_revision_mutation() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'replay revisions are immutable; append a new revision instead'
    using errcode = 'restrict_violation';
end;
$$
--> statement-breakpoint
revoke all on function analysis.refuse_mutation() from public
--> statement-breakpoint
revoke all on function analysis.refuse_dependency_cycle() from public
--> statement-breakpoint
revoke all on function analysis.refuse_run_rewrite() from public
--> statement-breakpoint
revoke all on function chess.refuse_revision_mutation() from public
--> statement-breakpoint
reset role

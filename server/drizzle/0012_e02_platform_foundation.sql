-- 0012_e02_platform_foundation
--
-- E02 — additive target schema namespaces, least-privilege roles, safe default
-- privileges, the schema catalogue, and the transaction-local actor helpers.
--
-- Hand-written and reviewed. Drizzle's journal is the one migration authority;
-- this file is applied by `npm run db:migrate` like every migration before it.
--
-- Additive and forward-only. It creates no credential, drops nothing, renames
-- nothing, and does not touch a single object in the legacy `public` schema.
-- Re-running it is a no-op. Rollback is a paired forward migration, never a
-- destructive undo; see docs/platform/E02-runbook.md.

--
-- 1. Roles
--
-- `forma_api` and `forma_migrator` already exist from 0011. The four worker
-- roles are created here with the same attribute set. No password is set: the
-- credential lives only in Secret Manager and is applied out of band.
--
do $$
declare
  role_name text;
begin
  foreach role_name in array array[
    'forma_ops', 'forma_ingestion', 'forma_stockfish', 'forma_analysis'
  ] loop
    if not exists (select 1 from pg_roles where rolname = role_name) then
      execute format(
        'create role %I with login noinherit nosuperuser nocreatedb nocreaterole nobypassrls',
        role_name
      );
    end if;
  end loop;
end
$$
--> statement-breakpoint
do $$
declare
  role_name text;
begin
  foreach role_name in array array[
    'forma_api', 'forma_ops', 'forma_ingestion', 'forma_stockfish',
    'forma_analysis', 'forma_migrator'
  ] loop
    begin
      execute format(
        'alter role %I nosuperuser nocreatedb nocreaterole nobypassrls',
        role_name
      );
    exception when insufficient_privilege then
      raise notice 'e02: cannot re-assert attributes on %; the database gate verifies them instead', role_name;
    end;
  end loop;
end
$$
--> statement-breakpoint
--
-- The deploy role is not a superuser. It holds CREATEROLE, and the membership
-- CREATEROLE grants automatically is ADMIN TRUE, SET FALSE, INHERIT FALSE.
-- Under exactly that posture `comment on role` is denied and `create schema ...
-- authorization forma_migrator` fails with `must be able to SET ROLE
-- "forma_migrator"`, so the migration cannot complete.
--
-- It therefore takes SET and INHERIT on memberships it already administers.
-- That grants no privilege the deployer could not already grant itself, and it
-- is the posture the hosted project owner role already has.
--
do $$
declare
  role_name text;
begin
  if current_user = 'forma_migrator' then
    return;
  end if;
  if (select rolsuper from pg_roles where rolname = current_user) then
    return;
  end if;
  foreach role_name in array array[
    'forma_api', 'forma_ops', 'forma_ingestion', 'forma_stockfish',
    'forma_analysis', 'forma_migrator'
  ] loop
    begin
      execute format('grant %I to %I with inherit true, set true', role_name, current_user);
    exception when insufficient_privilege then
      raise notice 'e02: cannot take SET/INHERIT on % as %; the statements that need it fail loudly rather than silently creating unowned objects', role_name, current_user;
    end;
  end loop;
end
$$
--> statement-breakpoint
--
-- Role comments. Guarded like the attribute assertion above: a role this
-- deployer did not create is one it cannot comment on, and in that case the
-- comment is already whatever the run that created the role set. The database
-- gate asserts the end state either way.
--
do $$
declare
  entry text[];
begin
  foreach entry slice 1 in array array[
    ['forma_ops', 'E02: private-ingress operator role for forma-ops: outbox dispatch, due-sync enqueue, lease recovery, retention and deletion sweeps. Never browser-facing, so no api schema.'],
    ['forma_ingestion', 'E02: provider sync worker role. Reads linked accounts, commits canonical chess records with their sync checkpoint, and advances the ops work ledger. No analysis, coaching, or social access.'],
    ['forma_stockfish', 'E02: objective engine worker role. Reads positions and writes immutable evaluation outputs. It never reaches user-owned identity, social, or coaching data and holds no actor helper.'],
    ['forma_analysis', 'E02: deterministic analysis, estimation, finding, coaching, and publication worker role. Writes subject-owned derived outputs and the social projections it publishes.']
  ] loop
    begin
      execute format('comment on role %I is %L', entry[1], entry[2]);
    exception when insufficient_privilege then
      raise notice 'e02: cannot comment on role %; the database gate verifies the comment instead', entry[1];
    end;
  end loop;
end
$$
--> statement-breakpoint
--
-- 2. Deploy posture
--
-- Best-effort, and deliberately not load-bearing: a deployer holding CREATE on
-- the database without GRANT OPTION cannot pass it on. The schemas below are
-- therefore created by the deployer with forma_migrator as their owner, and a
-- later migration that needs to add a namespace needs this grant or the same
-- privileged bootstrap. Everything else forma_migrator does, it does as owner.
do $$
begin
  begin
    execute format('grant create on database %I to forma_migrator', current_database());
  exception when insufficient_privilege then
    raise notice 'e02: cannot grant create on database to forma_migrator; adding a namespace later needs the privileged deploy path';
  end;
end
$$
--> statement-breakpoint
--
-- The Drizzle ledger is created by the migration runner before this file runs,
-- and is owned by whoever ran it first. Later migrations run as forma_migrator,
-- and the documented recovery replay clears this migration's ledger row and
-- re-runs, so the migration role needs the ledger itself -- not just the
-- objects the ledger records. Ownership deliberately stays where it is: the
-- bootstrap run must still insert its own row after this file returns.
--
do $$
declare
  ledger_sequence text;
begin
  begin
    if exists (select 1 from pg_namespace where nspname = 'drizzle') then
      execute 'grant usage, create on schema drizzle to forma_migrator';
    end if;
    if to_regclass('drizzle.__drizzle_migrations') is not null then
      execute 'grant select, insert, delete on drizzle.__drizzle_migrations to forma_migrator';
      for ledger_sequence in
        select c.oid::regclass::text
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'drizzle' and c.relkind = 'S'
      loop
        execute format('grant usage, select on sequence %s to forma_migrator', ledger_sequence);
      end loop;
    end if;
  exception when insufficient_privilege then
    raise notice 'e02: cannot grant the migration ledger to forma_migrator; a later migration run as that role will fail on schema drizzle';
  end;
end
$$
--> statement-breakpoint
--
-- 3. Namespaces
--
-- Created by the deployer, owned by forma_migrator. This is the statement that
-- needs the SET option taken above; without it PostgreSQL refuses to create an
-- object for a role the session cannot become. Ownership is asserted rather
-- than assumed, so a schema that somehow already exists converges.
--
do $$
declare
  schema_name text;
begin
  foreach schema_name in array array[
    'app', 'social', 'chess', 'analysis', 'coaching', 'ops', 'api', 'private'
  ] loop
    execute format('create schema if not exists %I authorization forma_migrator', schema_name);
    begin
      execute format('alter schema %I owner to forma_migrator', schema_name);
    exception when insufficient_privilege then
      raise notice 'e02: cannot transfer schema % to forma_migrator; the database gate verifies ownership instead', schema_name;
    end;
  end loop;
end
$$
--> statement-breakpoint
-- Become the owner for the rest of the file. Transaction-local: the migration
-- runner's own ledger insert, after the last statement below, runs as the
-- deploying role again.
set local role forma_migrator
--> statement-breakpoint
--
-- 4. Safe default privileges for anything this role creates later
--
-- PostgreSQL grants `PUBLIC` EXECUTE on every new function. The database-wide
-- form below removes that from `forma_migrator`'s future functions and persists
-- in `pg_default_acl`. The `IN SCHEMA` form of the same statement is silently
-- discarded on PostgreSQL 17.6 — verified against the production server version
-- — so it is deliberately not used. Tables and sequences already default to
-- owner-only, which is the fail-closed state we want.
--
do $$
begin
  begin
    execute 'alter default privileges for role forma_migrator revoke execute on functions from public';
  exception when insufficient_privilege then
    raise notice 'e02: cannot set default privileges for forma_migrator; every shipped function still carries an explicit revoke';
  end;
end
$$
--> statement-breakpoint

comment on schema app is 'Profiles, analysis subjects, linked accounts, entitlements. Internal: never Data-API exposed; forma-api serves it. Default data class user_owned, deleted with the subject.'
--> statement-breakpoint
comment on schema social is 'Public player directory projections and future relationships. Internal: reached through the API, never directly by the browser. Default data class user_owned, deleted with the subject.'
--> statement-breakpoint
comment on schema chess is 'Provider games, immutable replay revisions, core positions, occurrences, transitions. Internal. Shared canonical rows are reference-counted: removing one user never erases another user''s evidence.'
--> statement-breakpoint
comment on schema analysis is 'Methods, runs, evaluations, evidence, estimates, findings. Internal. Immutable derived outputs tied to exact method versions; user-owned results are deleted with the subject.'
--> statement-breakpoint
comment on schema coaching is 'Onboarding, reports, goals, practice, transfer. Internal. Default data class user_owned, deleted with the subject.'
--> statement-breakpoint
comment on schema ops is 'Syncs, work ledger, outbox, deletion workflows, schema catalogue. Internal. Operational rows are retained for a bounded window, never for the life of the account.'
--> statement-breakpoint
comment on schema api is 'Deliberately exposed security-invoker views and functions, if ever needed. Empty in v1: product data goes through forma-api. Exposure is opt-in per object and per reviewed migration, never by default.'
--> statement-breakpoint
comment on schema private is 'Privileged helper functions and authorization helpers. Never exposed to any browser role. Helpers set an empty search_path and are granted only to the roles that need them.'
--> statement-breakpoint
--
-- 5. Browser and PUBLIC exclusion
--
-- Supabase ships `anon`, `authenticated`, and `service_role`. None of them may
-- reach an internal schema. The roles may be absent outside Supabase, so each
-- revoke is guarded rather than assumed.
--
do $$
declare
  schema_name text;
  denied_role text;
begin
  foreach schema_name in array array[
    'app', 'social', 'chess', 'analysis', 'coaching', 'ops', 'api', 'private'
  ] loop
    -- A new schema carries no PUBLIC grant, but a pre-existing one might.
    execute format('revoke all on schema %I from public', schema_name);
    foreach denied_role in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = denied_role) then
        execute format('revoke all on schema %I from %I', schema_name, denied_role);
      end if;
    end loop;
  end loop;
end
$$
--> statement-breakpoint
--
-- 6. Named schema grants
--
-- USAGE only. A role that can reach a schema still holds no privilege on any
-- table in it: every future table is granted explicitly by the migration that
-- creates it. There is no blanket `grant all on all tables`, and no default
-- privilege hands a runtime role a table it was never reviewed for.
--
grant usage on schema app to forma_api
--> statement-breakpoint
grant usage on schema app to forma_ops
--> statement-breakpoint
grant usage on schema app to forma_ingestion
--> statement-breakpoint
grant usage on schema app to forma_analysis
--> statement-breakpoint
grant usage on schema social to forma_api
--> statement-breakpoint
grant usage on schema social to forma_ops
--> statement-breakpoint
grant usage on schema social to forma_analysis
--> statement-breakpoint
grant usage on schema chess to forma_api
--> statement-breakpoint
grant usage on schema chess to forma_ops
--> statement-breakpoint
grant usage on schema chess to forma_ingestion
--> statement-breakpoint
grant usage on schema chess to forma_stockfish
--> statement-breakpoint
grant usage on schema chess to forma_analysis
--> statement-breakpoint
grant usage on schema analysis to forma_api
--> statement-breakpoint
grant usage on schema analysis to forma_ops
--> statement-breakpoint
grant usage on schema analysis to forma_stockfish
--> statement-breakpoint
grant usage on schema analysis to forma_analysis
--> statement-breakpoint
grant usage on schema coaching to forma_api
--> statement-breakpoint
grant usage on schema coaching to forma_ops
--> statement-breakpoint
grant usage on schema coaching to forma_analysis
--> statement-breakpoint
grant usage on schema ops to forma_api
--> statement-breakpoint
grant usage on schema ops to forma_ops
--> statement-breakpoint
grant usage on schema ops to forma_ingestion
--> statement-breakpoint
grant usage on schema ops to forma_stockfish
--> statement-breakpoint
grant usage on schema ops to forma_analysis
--> statement-breakpoint
grant usage on schema api to forma_api
--> statement-breakpoint
grant usage on schema private to forma_api
--> statement-breakpoint
grant usage on schema private to forma_ops
--> statement-breakpoint
grant usage on schema private to forma_ingestion
--> statement-breakpoint
grant usage on schema private to forma_analysis
--> statement-breakpoint
--
-- 7. Transaction-local actor context
--
-- The API opens a short transaction, binds the actor it verified, and lets RLS
-- read it. `set_config(..., true)` is transaction-local, so a pooled connection
-- cannot carry an actor into the next request.
--
-- This is defence in depth, not authentication. PostgreSQL lets any connected
-- role set a custom setting directly, so a policy must always combine the actor
-- with the connecting role's grants — which is why `forma_stockfish` receives
-- neither the helper nor USAGE on `private`.
--
create or replace function private.current_actor_id()
returns uuid
language sql
stable
security invoker
set search_path = ''
as $function$
  select case
    when pg_catalog.current_setting('forma.actor_id', true)
      ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then pg_catalog.current_setting('forma.actor_id', true)::uuid
    else null
  end
$function$
--> statement-breakpoint
create or replace function private.set_actor_context(p_actor_id uuid)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
begin
  if p_actor_id is null then
    raise exception 'actor context requires a non-null actor id' using errcode = '22004';
  end if;
  perform pg_catalog.set_config('forma.actor_id', p_actor_id::text, true);
end
$function$
--> statement-breakpoint
do $$
declare
  helper text;
  denied_role text;
  granted_role text;
begin
  foreach helper in array array[
    'private.current_actor_id()', 'private.set_actor_context(uuid)'
  ] loop
    begin
      execute format('alter function %s owner to forma_migrator', helper);
    exception when insufficient_privilege then
      raise notice 'e02: cannot transfer function % to forma_migrator; the database gate verifies ownership instead', helper;
    end;
    execute format('revoke all on function %s from public', helper);
    foreach denied_role in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = denied_role) then
        execute format('revoke all on function %s from %I', helper, denied_role);
      end if;
    end loop;
    foreach granted_role in array array[
      'forma_api', 'forma_ops', 'forma_ingestion', 'forma_analysis'
    ] loop
      execute format('grant execute on function %s to %I', helper, granted_role);
    end loop;
  end loop;
end
$$
--> statement-breakpoint
comment on function private.current_actor_id() is 'The verified actor bound to the current transaction, or null when none is bound. Null denies rather than widens: a policy comparing an owner column to null matches no row. A malformed setting is treated as unset.'
--> statement-breakpoint
comment on function private.set_actor_context(uuid) is 'Bind the verified actor to the current transaction. Transaction-local, so a pooled connection cannot carry an actor into the next request. Rejects a null actor so an unset context stays unset rather than becoming a wildcard.'
--> statement-breakpoint
--
-- 8. Schema catalogue
--
-- Eight rows recording what each namespace is for, whether it is browser
-- exposed, and how its rows are classified and retained. Read-only to every
-- runtime role; only a reviewed migration writes it.
--
create table if not exists ops.schema_catalogue (
  schema_name text primary key,
  purpose text not null,
  browser_exposed boolean not null,
  data_class text not null,
  retention_class text not null,
  owning_role text not null,
  recorded_at timestamptz not null default now(),
  constraint schema_catalogue_data_class_check
    check (data_class in ('user_owned', 'shared_canonical', 'operational', 'none')),
  constraint schema_catalogue_retention_check
    check (retention_class in ('subject_deletion', 'reference_counted', 'operational_window', 'none'))
)
--> statement-breakpoint
comment on table ops.schema_catalogue is 'Ownership, exposure class, and default retention for every target namespace. A shared operational catalogue, not tenant data: access is by named grant, and only a reviewed migration writes a row.'
--> statement-breakpoint
comment on column ops.schema_catalogue.browser_exposed is 'True only when a reviewed security-invoker object in the schema is deliberately reachable by anon/authenticated. False for every namespace in v1.'
--> statement-breakpoint
comment on column ops.schema_catalogue.data_class is 'Default classification for rows in the schema: user_owned, shared_canonical, operational, or none when the schema holds no rows.'
--> statement-breakpoint
comment on column ops.schema_catalogue.retention_class is 'Default retention treatment: subject_deletion, reference_counted, operational_window, or none.'
--> statement-breakpoint
comment on column ops.schema_catalogue.owning_role is 'The role that owns the schema and its objects. Always forma_migrator: no runtime role owns anything.'
--> statement-breakpoint
alter table ops.schema_catalogue enable row level security
--> statement-breakpoint
drop policy if exists schema_catalogue_runtime_read on ops.schema_catalogue
--> statement-breakpoint
create policy schema_catalogue_runtime_read on ops.schema_catalogue
  as permissive for select
  to forma_api, forma_ops, forma_ingestion, forma_stockfish, forma_analysis
  using (true)
--> statement-breakpoint
comment on policy schema_catalogue_runtime_read on ops.schema_catalogue is 'The catalogue is not tenant data, so it carries no actor predicate. Runtime roles read it; none of them holds insert, update, or delete, so the read-only policy is the whole access model.'
--> statement-breakpoint
grant select on ops.schema_catalogue to forma_api
--> statement-breakpoint
grant select on ops.schema_catalogue to forma_ops
--> statement-breakpoint
grant select on ops.schema_catalogue to forma_ingestion
--> statement-breakpoint
grant select on ops.schema_catalogue to forma_stockfish
--> statement-breakpoint
grant select on ops.schema_catalogue to forma_analysis
--> statement-breakpoint
insert into ops.schema_catalogue
  (schema_name, purpose, browser_exposed, data_class, retention_class, owning_role)
values
  ('app', 'Profiles, analysis subjects, linked accounts, entitlements', false, 'user_owned', 'subject_deletion', 'forma_migrator'),
  ('social', 'Public player directory projections and future relationships', false, 'user_owned', 'subject_deletion', 'forma_migrator'),
  ('chess', 'Provider games, immutable replay revisions, positions, transitions', false, 'shared_canonical', 'reference_counted', 'forma_migrator'),
  ('analysis', 'Methods, runs, evaluations, evidence, estimates, findings', false, 'user_owned', 'subject_deletion', 'forma_migrator'),
  ('coaching', 'Onboarding, reports, goals, practice, transfer', false, 'user_owned', 'subject_deletion', 'forma_migrator'),
  ('ops', 'Syncs, work ledger, outbox, deletion workflows', false, 'operational', 'operational_window', 'forma_migrator'),
  ('api', 'Deliberately exposed security-invoker views and functions, if ever needed', false, 'none', 'none', 'forma_migrator'),
  ('private', 'Privileged helper functions and authorization helpers', false, 'none', 'none', 'forma_migrator')
on conflict (schema_name) do update set
  purpose = excluded.purpose,
  browser_exposed = excluded.browser_exposed,
  data_class = excluded.data_class,
  retention_class = excluded.retention_class,
  owning_role = excluded.owning_role
--> statement-breakpoint
-- Hand the session back. The migration runner inserts this migration's ledger
-- row immediately after this statement, in the same transaction, and that row
-- must be written by the role that owns the ledger.
reset role

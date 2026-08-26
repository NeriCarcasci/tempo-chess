-- 0046_the_report_can_read_the_opening_book
--
-- The step that writes a baseline report could never run.
--
-- `aggregateSubjectReport` names the opening each game left the book in, and it
-- reads that from the opening catalogue -- `public.opening_positions`, joined by
-- position key in `readGameOpenings`. `forma_api` has held select on that table
-- since it serves `/openings`. `forma_analysis`, which is the only deployment
-- that executes `coaching_examination_report`, never did.
--
-- So every examination died at the same step, on every run, from the first one:
-- five attempts, `handler_error`, then `coaching_baseline_examination` and
-- `coaching_onboarding_advance` behind it as `dependency_failed`. It took a
-- while to find because an unclassified handler failure recorded no detail --
-- once the executor started storing the redacted throw site, the answer was one
-- line: `Error/db_permission_denied | at estimates/aggregate.js:93`.
--
-- Read-only, and on catalogue rather than tenant data: the opening book is
-- reference material every subject's report consults and no subject owns. It
-- lives under `public` only because it predates the schema split, which is a
-- fact about its age rather than about who should read it -- see
-- 0040_the_opening_book_is_not_legacy, which already established that this
-- table is current and not a leftover.
--
-- No role gains anything it can write.
--
-- ## Why there is no `set local role forma_migrator` here
--
-- Because these two tables are not `forma_migrator`'s. `postgres` owns them, as
-- 0040 already found out and guarded for, and only an owner (or a holder of the
-- grant option) may grant on them. The first version of this file did set the
-- role, and the result was a migration that could not be applied at all: on a
-- fresh database it failed with `42501: permission denied for table
-- opening_positions` and took every migration after it down with it. The grant
-- it describes had to be applied to production by hand, which left the ledger a
-- migration behind the repository -- the worst of both, because the next
-- ordinary deploy would have hit the same wall.
--
-- So it runs as whoever is applying the batch, exactly as 0011 does for the
-- `forma_api` grants on the same two tables, and it survives being applied by a
-- role that cannot grant. `insufficient_privilege` is caught and reported
-- rather than raised: the security gates compare the live grant set against the
-- frozen contract, so a grant that silently did not land is caught there by a
-- check whose whole job is that, instead of blocking a deploy that has nothing
-- to do with it.
--
-- ## Why it opens with `reset role`
--
-- Because `set local role` outlives the file that set it. Drizzle applies every
-- pending migration in one transaction, and 0043, 0044 and 0045 each set the
-- role to `forma_migrator` without resetting it, so a file that says nothing
-- about roles inherits whatever the last one left behind. That is the trap 0042
-- already wrote down. Without this line the grants below run as
-- `forma_migrator` however carefully this file avoids naming it, get refused,
-- and are swallowed by the handler underneath -- a migration that reports
-- success and changes nothing, which is worse than the failure it replaced.
--
-- Idempotent: granting a privilege twice is a no-op.

reset role
--> statement-breakpoint

do $$
begin
  -- Reaching a table needs two grants, not one.
  --
  -- The first version of this migration granted only the tables, and the live
  -- database duly reported `has_table_privilege = true` for both -- while the
  -- report step went on failing, now with `permission denied for schema
  -- public`. A table privilege is not checked until the schema around it has
  -- been entered, so a role with select on a table and no usage on its schema
  -- holds a privilege it can never exercise, and every tool that asks about the
  -- table says the grant is fine.
  --
  -- `forma_api` has held this since 0011, which is the other half of why the
  -- product surface worked and the report did not. Usage on a schema opens
  -- nothing on its own: every table in `public` still answers to its own grant,
  -- and `forma_analysis` holds one on exactly the two named below.
  execute 'grant usage on schema public to forma_analysis';

  -- The catalogue the report resolves each game's opening against.
  execute 'grant select on public.opening_positions to forma_analysis';

  -- Its edges come with it. `readGameOpenings` tests membership by position
  -- rather than by walking edges, so this is not needed today -- but the two
  -- are one catalogue, and a grant that covers only half of it invites the next
  -- reader to discover the other half the way this one was discovered.
  execute 'grant select on public.opening_edges to forma_analysis';
exception when insufficient_privilege then
  raise notice '0046: this role may not grant on the opening catalogue; the security gate checks the grant instead';
end
$$

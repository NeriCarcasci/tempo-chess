-- 0036_ops_can_survey_what_it_plans
--
-- Let `forma_ops` read the tenant tables it has to survey in order to plan.
--
-- Hand-written and reviewed. Four SELECT policies, no schema change, no row
-- touched. Each policy is dropped if present before it is created, so
-- re-running it really is a no-op -- `create policy` is not idempotent on its
-- own, and this file claimed to be before it was.
--
-- ## Why a policy and not a grant
--
-- 0035 already granted `forma_ops` SELECT on these tables and it changed
-- nothing, because a grant and a policy are different gates. Every tenant table
-- carries `force row level security` and an owner policy of the shape
-- `owner_user_id = private.current_actor_id()`. On a connection with no bound
-- actor that function is null, so the policy matches no row and the table reads
-- as empty -- not as an error.
--
-- That is exactly right for a worker acting on behalf of one person, and it is
-- exactly wrong for a planner. The sweep's whole job is to look across every
-- subject and ask which ones have games nobody has materialized or analysed
-- yet. There is no single actor it could bind: binding one would hide the other
-- subjects, which is the question it was asked.
--
-- So it read zero rows, planned zero work, and reported success. Three hundred
-- and thirty-two synced games sat with no position graph and no analysis behind
-- them, and every screen that depends on analysis was empty while every
-- component reported healthy.
--
-- ## Why this is not a hole
--
-- `forma_ops` could already create work for any subject -- E04 reserves work
-- creation to `forma_api` and `forma_ops` precisely so that a worker cannot
-- create unbounded work. It could act on subjects it could not see. Letting it
-- see them narrows the gap between what the role may do and what it may know,
-- which is the direction that makes a role easier to reason about, not harder.
--
-- The precedent is `ops.work_items`, whose policy is `using (true)`: the work
-- ledger is role-scoped rather than actor-scoped for the same reason.
--
-- Three limits keep this narrow, and they are the reason it is four policies
-- rather than a blanket grant:
--
--   * SELECT only. `forma_ops` still cannot write a subject's rows.
--   * Named tables only -- the four the planner actually reads. It gains
--     nothing on games, positions, evaluations, reports or goals.
--   * `to forma_ops` only. No browser role, and no other service role, is
--     affected; `forma_api` and the workers keep the actor-scoped view they
--     have now, which is what makes a request answer for one person.

set local role forma_migrator
--> statement-breakpoint
-- Which subjects exist, and which of their games have arrived.
drop policy if exists subject_games_ops_survey on chess.subject_games
--> statement-breakpoint
create policy subject_games_ops_survey on chess.subject_games
  for select to forma_ops using (true)
--> statement-breakpoint
drop policy if exists analysis_subjects_ops_survey on app.analysis_subjects
--> statement-breakpoint
create policy analysis_subjects_ops_survey on app.analysis_subjects
  for select to forma_ops using (true)
--> statement-breakpoint
-- What has already been planned, so a sweep does not plan it twice.
drop policy if exists runs_ops_survey on analysis.runs
--> statement-breakpoint
create policy runs_ops_survey on analysis.runs
  for select to forma_ops using (true)
--> statement-breakpoint
-- Which subjects have a live publication, so a stale progress reading can be
-- told apart from one that was never taken.
drop policy if exists subject_live_publications_ops_survey on analysis.subject_live_publications
--> statement-breakpoint
create policy subject_live_publications_ops_survey on analysis.subject_live_publications
  for select to forma_ops using (true)
--> statement-breakpoint
-- Unrelated to the policies above, and found immediately behind them: 0020
-- granted `select, insert` on `chess.core_positions`, but the materializer
-- upserts it -- `on conflict (core_key_hash) do update` -- and ON CONFLICT DO
-- UPDATE requires UPDATE as well as INSERT. Every materialization died on its
-- first position, which is why no game had a position graph.
grant update on chess.core_positions to forma_analysis
--> statement-breakpoint
grant update on chess.core_positions to forma_ingestion
--> statement-breakpoint
-- Planning a game analysis writes an `analysis.runs` row, and E04 reserves work
-- creation to `forma_api` and `forma_ops` precisely so a worker cannot create
-- unbounded work -- but `forma_ops` was never granted the insert, so the one
-- role allowed to plan could not. The row itself stays actor-scoped: the
-- planner binds the owner of each game before writing, so the grant says "may
-- plan" while the policy still says "for this subject".
grant insert on analysis.runs to forma_ops
--> statement-breakpoint
grant insert on analysis.run_dependencies to forma_ops
--> statement-breakpoint
reset role

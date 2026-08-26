-- 0047_the_sweep_can_see_the_snapshot_it_plans_for
--
-- Let `forma_ops` read the snapshot membership its own sweep now filters on.
--
-- Hand-written and reviewed. One SELECT policy, no schema change, no row
-- touched. The policy is dropped if present before it is created, so re-running
-- it really is a no-op.
--
-- ## What broke
--
-- `planPendingGameAnalyses` used to sweep every game a subject owned. That
-- analysed a third more games than any report would ever read, so it was
-- narrowed to the games some frozen snapshot actually names:
--
--   and exists (select 1 from analysis.subject_data_snapshot_games sdg
--               where sdg.subject_game_id = sg.id)
--
-- The narrowing is right. The table it reads is forced row level security with
-- one owner policy, `owner_user_id = private.current_actor_id()`, and the sweep
-- runs with no actor bound -- deliberately, because its whole job is to look
-- across every subject at once and binding one would hide the rest.
--
-- So the EXISTS was false for every game on the platform. The sweep planned
-- zero analyses and reported success; `coaching_examination_report` then waited
-- out its attempts for analysis that nobody was ever going to plan, and the
-- examination died on a dependency that could not arrive. Two hundred snapshot
-- games were visible to `postgres` and invisible to the only role allowed to
-- plan work over them.
--
-- This is 0036 exactly, one table later, and for the same reason: a grant and a
-- policy are different gates, and `forma_ops` already held the grant. The
-- general rule is worth restating because it has now caught us twice -- when
-- the planner learns to read a new tenant table, the planner needs a survey
-- policy on it, or it silently plans nothing.
--
-- ## Why this is not a hole
--
-- The same three limits 0036 argued for hold here. SELECT only, so `forma_ops`
-- still cannot write a subject's rows. One named table, the one the planner
-- reads. `to forma_ops` only, so no browser role and no other service role is
-- affected and every request still answers for one person.
--
-- The row it exposes is a membership: this subject game is in that snapshot. It
-- carries no evaluation, no move and no name. `forma_ops` could already see
-- `chess.subject_games` and `analysis.runs`, which is strictly more.

set local role forma_migrator
--> statement-breakpoint
-- Which games a frozen snapshot names, so the sweep plans the analysis a report
-- is actually waiting on and skips the rest of the archive.
drop policy if exists snapshot_games_ops_survey on analysis.subject_data_snapshot_games
--> statement-breakpoint
create policy snapshot_games_ops_survey on analysis.subject_data_snapshot_games
  for select to forma_ops using (true)
--> statement-breakpoint
reset role

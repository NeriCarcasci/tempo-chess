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

set local role forma_migrator
--> statement-breakpoint

-- The catalogue the report resolves each game's opening against.
grant select on public.opening_positions to forma_analysis
--> statement-breakpoint

-- Its edges come with it. `readGameOpenings` tests membership by position
-- rather than by walking edges, so this is not needed today -- but the two are
-- one catalogue, and a grant that covers only half of it invites the next
-- reader to discover the other half the way this one was discovered.
grant select on public.opening_edges to forma_analysis

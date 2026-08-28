-- 0049_practice_items_name_their_source
--
-- A rendered reason is useful to a person but cannot power a link back to the
-- game, a pattern label, or a phase filter. Keep that sentence and pin the
-- structured source beside it when the assignment is created.
--
-- Existing assignments predate this contract and cannot be reconstructed
-- safely here. The columns are therefore nullable for those rows; every new
-- selector write supplies the complete concept/phase/move provenance. No data
-- backfill runs under forma_migrator: FORCE RLS would make such a write look
-- successful while changing nothing.

set local role forma_migrator
--> statement-breakpoint
alter table coaching.learning_assignments
  add column if not exists source_game_id uuid
    references chess.subject_games(id) on delete set null,
  add column if not exists concept_slug text
    references analysis.concepts(slug) on delete restrict,
  add column if not exists role text,
  add column if not exists phase text,
  add column if not exists move_number integer,
  add column if not exists side text
--> statement-breakpoint
alter table coaching.learning_assignments
  drop constraint if exists assignments_provenance_role_check,
  add constraint assignments_provenance_role_check check (
    role is null or role in ('recognize', 'execute', 'respond', 'convert')
  ),
  drop constraint if exists assignments_provenance_phase_check,
  add constraint assignments_provenance_phase_check check (
    phase is null or phase in ('opening', 'middlegame', 'endgame')
  ),
  drop constraint if exists assignments_provenance_side_check,
  add constraint assignments_provenance_side_check check (
    side is null or side in ('white', 'black')
  ),
  drop constraint if exists assignments_provenance_move_check,
  add constraint assignments_provenance_move_check check (
    move_number is null or move_number >= 1
  ),
  drop constraint if exists assignments_provenance_complete,
  add constraint assignments_provenance_complete check (
    (concept_slug is null and role is null and phase is null and move_number is null and side is null)
    or
    (concept_slug is not null and role is not null and phase is not null
      and move_number is not null and side is not null)
  )
--> statement-breakpoint
comment on column coaching.learning_assignments.source_game_id is 'The subject game this drill position came from. Null only for legacy assignments or when the source game is genuinely unavailable.'
--> statement-breakpoint
comment on column coaching.learning_assignments.concept_slug is 'The stable catalogue concept selected for this assignment, stored at assignment time rather than inferred when the queue is read.'
--> statement-breakpoint
comment on column coaching.learning_assignments.role is 'The concept role selected for this assignment: recognize, execute, respond, or convert.'
--> statement-breakpoint
comment on column coaching.learning_assignments.phase is 'The game phase recorded for the selected opportunity.'
--> statement-breakpoint
comment on column coaching.learning_assignments.move_number is 'The full move number of the source position.'
--> statement-breakpoint
comment on column coaching.learning_assignments.side is 'The side to move in the source position.'
--> statement-breakpoint
create index if not exists assignments_source_game
  on coaching.learning_assignments (source_game_id)
--> statement-breakpoint
create index if not exists assignments_concept_role_phase
  on coaching.learning_assignments (subject_id, concept_slug, role, phase)
--> statement-breakpoint
reset role

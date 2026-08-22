-- 0038_concepts_are_versioned_one_at_a_time
--
-- FOR-122. Two additions, both additive and forward-only. No existing object
-- changes, no row is touched, nothing is dropped or renamed. Re-running it is a
-- no-op.
--
-- The problem this fixes is that detection had exactly one unit of identity:
-- the whole game. `concepts/worker.ts` asked whether *any* opportunity existed
-- for the materialization run and returned early if one did. That is correct
-- for a re-delivery of the same message and wrong for everything else. Adding a
-- seventh concept to the catalogue could never backfill the six games that
-- already had rows from the first six concepts, because the game "already had
-- opportunities". Correcting a detector had the same problem. The only way to
-- pick up a new version was to delete evidence, which `forma_analysis` is
-- rightly not granted.
--
-- So identity moves down to the thing that actually repeats:
--
--   * a physical occurrence is identified by `detection_key`, unique within the
--     materialization run it was detected from;
--   * an observation is identified by the event it hangs from, the concept
--     version that labelled it, and the role.
--
-- With those, a second run inserts what is missing and conflicts on what is
-- not, and neither one needs a delete.
--
-- Note what is deliberately *not* added. `analysis.event_concepts` already
-- carries `detector_version` on every label, so recording it a second time on
-- the event would be two places to disagree about one fact. And a physical
-- occurrence is version-independent by construction -- a fork is a fork whether
-- or not the detector that named it was later corrected -- so `detection_key`
-- excludes the detector version on purpose. A corrected detector attaches a new
-- label to the same event rather than claiming a second fork happened.

set local role forma_migrator
--> statement-breakpoint
alter table analysis.chess_events
  add column if not exists detection_key text
--> statement-breakpoint
comment on column analysis.chess_events.detection_key is 'Deterministic identity of the physical occurrence within its materialization run (FOR-122). Composed by the detector from the event type, the ply range, the actor and the squares involved -- never from the detector version, because a corrected detector observes the same occurrence rather than a new one. Null on rows written before this column existed; the unique index treats those as distinct, which is what leaves E13 evidence alone.'
--> statement-breakpoint
-- Nulls are distinct in a Postgres unique index by default, so every row E13
-- already wrote stays legal and unconstrained. New rows carry a key and are
-- deduplicated against each other. That is the whole compatibility story.
create unique index if not exists chess_events_detection_key_unique
  on analysis.chess_events (run_id, detection_key)
  where detection_key is not null
--> statement-breakpoint
-- One observation per (occurrence, concept version, role). The role is part of
-- it because recognize and execute are separate observations of the same
-- moment -- that distinction is E13's reason to exist, and collapsing it here
-- would undo it in the index.
create unique index if not exists opportunities_event_concept_role_unique
  on analysis.concept_opportunities (event_id, concept_version_id, role)
--> statement-breakpoint
reset role

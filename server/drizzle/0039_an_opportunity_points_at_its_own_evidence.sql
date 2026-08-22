-- 0039_an_opportunity_points_at_its_own_evidence
--
-- FOR-123. One additive column and its index. No existing object changes, no
-- row is touched, nothing is dropped or renamed. Re-running it is a no-op.
--
-- `analysis.evidence_items` exists so a finding in a report can point at the
-- thing it was derived from with a real foreign key. The producer wrote one
-- evidence item per opportunity and then had nowhere to record which was which:
-- `concept_opportunities` had no column for it, so the id went into the
-- `context` jsonb blob, and `estimates/aggregate.ts` -- which needs the id to
-- attach evidence to a finding -- could not join on a jsonb field it did not
-- know was there. What it did instead was
--
--   (select e.id from analysis.evidence_items e
--     where e.subject_game_id = o.subject_game_id
--       and e.evidence_kind = 'opportunity'
--     order by e.id limit 1)
--
-- the lowest-numbered opportunity evidence item *in the same game*. For a game
-- with one opportunity that is right by accident. For a game with thirty it
-- attaches all thirty findings to whichever one happened to be inserted first,
-- so "here is the evidence for this claim" shows the player a different moment
-- from the one the claim is about. A citation that points at the wrong thing is
-- worse than no citation, because it looks checked.
--
-- The column is nullable, and stays nullable. Rows E13 already wrote carry
-- their evidence id in `context->>'evidenceItemId'`, which is the correct id --
-- it was recorded accurately and simply had nowhere typed to live. The
-- aggregate reads the column and falls back to that jsonb field, so old rows
-- resolve to exactly the evidence they always meant. Backfilling the column
-- would be a mutation of existing evidence for no gain; FOR-136 may do it as
-- part of reconciliation if it turns out to be worth doing.

set local role forma_migrator
--> statement-breakpoint
alter table analysis.concept_opportunities
  add column if not exists evidence_item_id bigint
    references analysis.evidence_items(id) on delete restrict
--> statement-breakpoint
comment on column analysis.concept_opportunities.evidence_item_id is 'The evidence item recorded for this specific observation (FOR-123). Null on rows written before the column existed, whose id is in context->>''evidenceItemId''. Never null on rows written after it: an observation that cannot be cited is one a report cannot defend.'
--> statement-breakpoint
create index if not exists opportunities_evidence_item
  on analysis.concept_opportunities (evidence_item_id)
  where evidence_item_id is not null
--> statement-breakpoint
reset role

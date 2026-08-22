-- A concept opportunity is immutable evidence about a materialized position
-- graph, so its existing run_id correctly names the materialization run. A
-- game-review publication, however, names an analysis run. Keep the evidence
-- row reusable and record the exact analysis runs that concluded it.
set local role forma_migrator
--> statement-breakpoint
create table if not exists analysis.run_concept_opportunities (
  analysis_run_id uuid not null references analysis.runs(id) on delete restrict,
  opportunity_id bigint not null references analysis.concept_opportunities(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (analysis_run_id, opportunity_id)
)
--> statement-breakpoint
comment on table analysis.run_concept_opportunities is 'Exact provenance from an analysis run artifact manifest to the immutable concept opportunities that run concluded. A publication reads this mapping so later backfills on the same materialization cannot change an older published review.'
--> statement-breakpoint
create index if not exists run_concept_opportunities_opportunity
  on analysis.run_concept_opportunities (opportunity_id)
--> statement-breakpoint
alter table analysis.run_concept_opportunities enable row level security
--> statement-breakpoint
alter table analysis.run_concept_opportunities force row level security
--> statement-breakpoint
create policy run_concept_opportunities_owner on analysis.run_concept_opportunities
  using (exists (
    select 1
    from analysis.concept_opportunities o
    join app.analysis_subjects s on s.id = o.subject_id
    where o.id = opportunity_id
      and s.owner_user_id = private.current_actor_id()
  ))
  with check (exists (
    select 1
    from analysis.concept_opportunities o
    join app.analysis_subjects s on s.id = o.subject_id
    where o.id = opportunity_id
      and s.owner_user_id = private.current_actor_id()
  ))
--> statement-breakpoint
grant select, insert on analysis.run_concept_opportunities to forma_analysis
--> statement-breakpoint
grant select on analysis.run_concept_opportunities to forma_api
--> statement-breakpoint
revoke all on analysis.run_concept_opportunities from public
--> statement-breakpoint
reset role

-- 0025_e13_events_concepts
--
-- E13 — concepts, deterministic events, atomic opportunities, evidence,
-- relations and trajectory episodes.
--
-- Hand-written and reviewed. Additive and forward-only: nine tables in the
-- `analysis` namespace E02 established. No existing object changes, no row is
-- touched, nothing is dropped or renamed. Re-running it is a no-op.
--
-- The reason this epic exists is that a single mistakes table cannot express
-- what actually happened at the board. Recognising a chance and then botching
-- it is two observations, not one blended score. A chance the opponent never
-- gave you a reply to is not a failure. A number without the rubric that
-- produced it is not a measurement.
--
-- All three are constraints here rather than conventions in a detector, because
-- a detector is rewritten every time a version is promoted and a constraint is
-- not.

set local role forma_migrator
--> statement-breakpoint
create table if not exists analysis.concepts (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  family text not null,
  parent_concept_id uuid references analysis.concepts(id) on delete restrict,
  category text not null,
  display_name text not null,
  created_at timestamptz not null default now(),
  constraint concepts_category_check check (category in (
    'tactical', 'positional', 'strategic', 'defensive',
    'temporal', 'conversion', 'game_management'
  )),
  -- A concept cannot be its own parent. Deeper cycles are prevented by the
  -- catalogue being curated and versioned rather than user-supplied.
  constraint concepts_no_self_parent check (parent_concept_id is null or parent_concept_id <> id)
)
--> statement-breakpoint
comment on table analysis.concepts is 'Stable concept identity and hierarchy (database architecture 17.1). Deliberately wider than named tactics: prevention, quiet moves, move order, plan recognition, tempo, stabilization, resourcefulness and conversion are first-class categories, because a player who never blunders and never converts has a real problem that a mistake list cannot describe.'
--> statement-breakpoint
create index if not exists concepts_family on analysis.concepts (family)
--> statement-breakpoint
create index if not exists concepts_parent on analysis.concepts (parent_concept_id)
--> statement-breakpoint
create table if not exists analysis.concept_versions (
  id uuid primary key default gen_random_uuid(),
  concept_id uuid not null references analysis.concepts(id) on delete restrict,
  version_no integer not null,
  human_definition text not null,
  detector_contract jsonb not null,
  supported_roles text[] not null,
  -- Present only when graded evidence is possible. A version that scores must
  -- say how; a version that does not score must not pretend to.
  rubric_contract jsonb,
  version_hash text not null,
  promoted_at timestamptz,
  created_at timestamptz not null default now(),
  constraint concept_versions_unique unique (concept_id, version_no),
  constraint concept_versions_hash_shape check (version_hash ~ '^[0-9a-f]{64}$'),
  constraint concept_versions_no_positive check (version_no > 0),
  constraint concept_versions_roles_known check (
    supported_roles <@ array['create','recognize','execute','avoid','prevent','respond','convert']::text[]
    and array_length(supported_roles, 1) > 0
  )
)
--> statement-breakpoint
comment on table analysis.concept_versions is 'Immutable definition of what counts as an opportunity for a concept (database architecture 17.2). A promoted version is what a detector run cites, so changing the definition means a new version rather than an edit -- an observation recorded under version 1 keeps meaning what it meant.'
--> statement-breakpoint
create unique index if not exists concept_versions_hash_unique on analysis.concept_versions (version_hash)
--> statement-breakpoint
create index if not exists concept_versions_promoted
  on analysis.concept_versions (concept_id, version_no desc) where promoted_at is not null
--> statement-breakpoint
create table if not exists analysis.chess_events (
  id bigint generated always as identity primary key,
  run_id uuid not null references chess.materialization_runs(id) on delete restrict,
  replay_revision_id bigint not null references chess.game_replay_revisions(id) on delete restrict,
  subject_game_id uuid references chess.subject_games(id) on delete restrict,
  event_type text not null,
  start_ply integer not null,
  focal_ply integer not null,
  end_ply integer not null,
  actor_color text,
  affected_color text,
  facts jsonb not null,
  detection_confidence numeric(4,3),
  completeness text not null,
  created_at timestamptz not null default now(),
  constraint chess_events_completeness_check
    check (completeness in ('complete', 'incomplete', 'censored')),
  constraint chess_events_color_check check (
    (actor_color is null or actor_color in ('white','black'))
    and (affected_color is null or affected_color in ('white','black'))
  ),
  -- A multi-ply occurrence runs forward and contains its focal moment.
  constraint chess_events_ply_ordering check (start_ply <= focal_ply and focal_ply <= end_ply),
  constraint chess_events_ply_non_negative check (start_ply >= 0),
  constraint chess_events_confidence_range
    check (detection_confidence is null or (detection_confidence >= 0 and detection_confidence <= 1))
)
--> statement-breakpoint
comment on table analysis.chess_events is 'A physical or multi-ply occurrence in a game (database architecture 17.3), produced deterministically from a published materialization run. Facts are observed, not judged: whether the occurrence was good is a separate labelling step, and whether the subject handled it is a separate observation again.'
--> statement-breakpoint
create index if not exists chess_events_run on analysis.chess_events (run_id, focal_ply)
--> statement-breakpoint
create index if not exists chess_events_subject_game on analysis.chess_events (subject_game_id)
--> statement-breakpoint
create index if not exists chess_events_revision on analysis.chess_events (replay_revision_id)
--> statement-breakpoint
create table if not exists analysis.event_concepts (
  id bigint generated always as identity primary key,
  event_id bigint not null references analysis.chess_events(id) on delete restrict,
  concept_version_id uuid not null references analysis.concept_versions(id) on delete restrict,
  color text not null,
  role text not null,
  label_confidence numeric(4,3),
  detector_version text not null,
  constraint event_concepts_unique unique (event_id, concept_version_id, color, role),
  constraint event_concepts_color_check check (color in ('white','black')),
  constraint event_concepts_role_check check (
    role in ('create','recognize','execute','avoid','prevent','respond','convert')
  ),
  constraint event_concepts_confidence_range
    check (label_confidence is null or (label_confidence >= 0 and label_confidence <= 1))
)
--> statement-breakpoint
comment on table analysis.event_concepts is 'Many-to-many semantic labelling of events (database architecture 17.4). There is deliberately no universal partial-success column: "half worked" is not a measurement, and the roles exist so that recognizing a chance and executing it are labelled separately rather than averaged.'
--> statement-breakpoint
create index if not exists event_concepts_version on analysis.event_concepts (concept_version_id)
--> statement-breakpoint
create table if not exists analysis.concept_opportunities (
  id bigint generated always as identity primary key,
  run_id uuid not null references chess.materialization_runs(id) on delete restrict,
  subject_id uuid not null references app.analysis_subjects(id) on delete restrict,
  subject_game_id uuid not null references chess.subject_games(id) on delete restrict,
  event_id bigint not null references analysis.chess_events(id) on delete restrict,
  concept_version_id uuid not null references analysis.concept_versions(id) on delete restrict,
  role text not null,
  opportunity_ply integer not null,
  response_ply integer,
  response_observed boolean not null,
  censored_reason text,
  success boolean,
  score numeric(6,3),
  rubric_component_version_id uuid references analysis.concept_versions(id) on delete restrict,
  difficulty jsonb,
  phase text,
  speed text,
  context jsonb,
  confidence numeric(4,3),
  evidence_source_kind text not null,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint opportunities_role_check check (
    role in ('create','recognize','execute','avoid','prevent','respond','convert')
  ),
  constraint opportunities_source_check
    check (evidence_source_kind in ('engine', 'deterministic', 'human_model')),
  -- §17.5, and the whole point of the epic.
  --
  -- An unobserved response is not a failure. If the opponent resigned, the game
  -- ended, or the position never gave the subject the move, there is no
  -- observation to record -- so success and score must both be null, and a
  -- reason must say why.
  constraint opportunities_censored_is_null check (
    response_observed
    or (success is null and score is null and censored_reason is not null)
  ),
  -- An observed response is an observation: it must say what happened.
  constraint opportunities_observed_has_success check (not response_observed or success is not null),
  constraint opportunities_observed_has_ply check (not response_observed or response_ply is not null),
  -- A number without the rubric that produced it is not a measurement.
  constraint opportunities_score_pins_rubric check (
    score is null or rubric_component_version_id is not null
  ),
  constraint opportunities_ply_ordering check (
    response_ply is null or response_ply >= opportunity_ply
  ),
  constraint opportunities_confidence_range
    check (confidence is null or (confidence >= 0 and confidence <= 1))
)
--> statement-breakpoint
comment on table analysis.concept_opportunities is 'The statistical observation unit: one specific chance for a subject to show a concept in a role (database architecture 17.5). The constraints are the epic. An unobserved response is censored, never a failure -- counting silence as a mistake is how a skill estimate slanders a player who was never given the move. Difficulty is recorded from the position before the outcome is known, so it can never be contaminated by whether the subject succeeded.'
--> statement-breakpoint
comment on column analysis.concept_opportunities.difficulty is 'Computed from the pre-response position only. If this were derived from the outcome, every hard chance would look easy in hindsight and the estimate built on it would be circular.'
--> statement-breakpoint
create index if not exists opportunities_subject
  on analysis.concept_opportunities (subject_id, occurred_at desc)
--> statement-breakpoint
create index if not exists opportunities_concept_role
  on analysis.concept_opportunities (concept_version_id, role) where response_observed
--> statement-breakpoint
create index if not exists opportunities_subject_game
  on analysis.concept_opportunities (subject_game_id)
--> statement-breakpoint
create index if not exists opportunities_event on analysis.concept_opportunities (event_id)
--> statement-breakpoint
create table if not exists analysis.evidence_items (
  id bigint generated always as identity primary key,
  run_id uuid not null references chess.materialization_runs(id) on delete restrict,
  evidence_kind text not null,
  subject_id uuid references app.analysis_subjects(id) on delete restrict,
  subject_game_id uuid references chess.subject_games(id) on delete restrict,
  occurred_at timestamptz,
  confidence numeric(4,3),
  created_at timestamptz not null default now(),
  constraint evidence_kind_check check (
    evidence_kind in ('opportunity', 'episode', 'relation', 'event')
  ),
  constraint evidence_confidence_range
    check (confidence is null or (confidence >= 0 and confidence <= 1))
)
--> statement-breakpoint
comment on table analysis.evidence_items is 'Uniform registry so a finding can reference heterogeneous evidence with real foreign keys (database architecture 17.7). Specialised tables key to this by evidence_item_id, which gives a common reference without a polymorphic id column. It is deliberately not a generic JSON fact store and does not replace typed columns.'
--> statement-breakpoint
create index if not exists evidence_items_subject
  on analysis.evidence_items (subject_id, occurred_at desc)
--> statement-breakpoint
create table if not exists analysis.event_relations (
  id bigint generated always as identity primary key,
  from_event_id bigint not null references analysis.chess_events(id) on delete restrict,
  to_event_id bigint not null references analysis.chess_events(id) on delete restrict,
  relation_type text not null,
  run_id uuid not null references chess.materialization_runs(id) on delete restrict,
  method_version text not null,
  components jsonb not null,
  similarity numeric(4,3),
  confidence numeric(4,3),
  created_at timestamptz not null default now(),
  constraint relations_type_check check (relation_type in (
    'responds_to', 'prevents', 'exact_repeat', 'structural_repeat',
    'improved_response', 'repeated_failure', 'transfer_variant'
  )),
  constraint relations_not_self check (from_event_id <> to_event_id),
  constraint relations_unique unique (from_event_id, to_event_id, relation_type, method_version),
  constraint relations_similarity_range
    check (similarity is null or (similarity >= 0 and similarity <= 1))
)
--> statement-breakpoint
comment on table analysis.event_relations is 'Versioned connections between events, including across games (database architecture 17.6). components carries the comparability evidence and method_version names what judged it, because "these two positions are alike" is a claim that has to be auditable rather than asserted. An improved_response relation links earlier evidence, later evidence and the method that compared them.'
--> statement-breakpoint
create index if not exists relations_from on analysis.event_relations (from_event_id, relation_type)
--> statement-breakpoint
create index if not exists relations_to on analysis.event_relations (to_event_id, relation_type)
--> statement-breakpoint
create table if not exists analysis.trajectory_episodes (
  evidence_item_id bigint primary key references analysis.evidence_items(id) on delete restrict,
  run_id uuid not null references chess.materialization_runs(id) on delete restrict,
  subject_game_id uuid not null references chess.subject_games(id) on delete restrict,
  episode_kind text not null,
  start_ply integer not null,
  focal_ply integer not null,
  end_ply integer not null,
  expected_score_start numeric(5,4),
  expected_score_extreme numeric(5,4),
  expected_score_end numeric(5,4),
  created_at timestamptz not null default now(),
  constraint episodes_kind_check check (episode_kind in (
    'setback', 'collapse', 'opponent_concession', 'stabilization', 'second_chance',
    'capitalization', 'recovery', 'renewed_decline', 'conversion'
  )),
  constraint episodes_ply_ordering check (start_ply <= focal_ply and focal_ply <= end_ply),
  constraint episodes_expected_score_range check (
    (expected_score_start is null or (expected_score_start between 0 and 1))
    and (expected_score_extreme is null or (expected_score_extreme between 0 and 1))
    and (expected_score_end is null or (expected_score_end between 0 and 1))
  )
)
--> statement-breakpoint
comment on table analysis.trajectory_episodes is 'Versioned multi-transition interpretations (database architecture 18.1). opponent_concession and recovery are separate kinds on purpose: a position that improved because the opponent erred is not the subject recovering, and relabelling one as the other would credit a player for someone else''s mistake.'
--> statement-breakpoint
create index if not exists episodes_subject_game
  on analysis.trajectory_episodes (subject_game_id, start_ply)
--> statement-breakpoint
create index if not exists episodes_kind on analysis.trajectory_episodes (episode_kind)
--> statement-breakpoint
-- Tenancy. Opportunities carry a subject directly; episodes and evidence reach
-- one through their subject game. The catalogue and the raw events are provider
-- and detector truth, not anyone's data.
alter table analysis.concept_opportunities enable row level security
--> statement-breakpoint
alter table analysis.concept_opportunities force row level security
--> statement-breakpoint
create policy opportunities_owner on analysis.concept_opportunities
  using (exists (
    select 1 from app.analysis_subjects s
    where s.id = subject_id and s.owner_user_id = private.current_actor_id()
  ))
  with check (exists (
    select 1 from app.analysis_subjects s
    where s.id = subject_id and s.owner_user_id = private.current_actor_id()
  ))
--> statement-breakpoint
alter table analysis.evidence_items enable row level security
--> statement-breakpoint
alter table analysis.evidence_items force row level security
--> statement-breakpoint
create policy evidence_items_owner on analysis.evidence_items
  using (
    subject_id is null
    or exists (
      select 1 from app.analysis_subjects s
      where s.id = subject_id and s.owner_user_id = private.current_actor_id()
    )
  )
  with check (
    subject_id is null
    or exists (
      select 1 from app.analysis_subjects s
      where s.id = subject_id and s.owner_user_id = private.current_actor_id()
    )
  )
--> statement-breakpoint
alter table analysis.trajectory_episodes enable row level security
--> statement-breakpoint
alter table analysis.trajectory_episodes force row level security
--> statement-breakpoint
create policy episodes_owner on analysis.trajectory_episodes
  using (exists (
    select 1 from chess.subject_games sg
    join app.analysis_subjects s on s.id = sg.subject_id
    where sg.id = subject_game_id and s.owner_user_id = private.current_actor_id()
  ))
  with check (exists (
    select 1 from chess.subject_games sg
    join app.analysis_subjects s on s.id = sg.subject_id
    where sg.id = subject_game_id and s.owner_user_id = private.current_actor_id()
  ))
--> statement-breakpoint
grant select, insert on analysis.concepts to forma_analysis
--> statement-breakpoint
grant select on analysis.concepts to forma_api, forma_stockfish
--> statement-breakpoint
grant select, insert, update on analysis.concept_versions to forma_analysis
--> statement-breakpoint
grant select on analysis.concept_versions to forma_api, forma_stockfish
--> statement-breakpoint
grant select, insert on analysis.chess_events to forma_analysis
--> statement-breakpoint
grant select on analysis.chess_events to forma_api
--> statement-breakpoint
grant select, insert on analysis.event_concepts to forma_analysis
--> statement-breakpoint
grant select on analysis.event_concepts to forma_api
--> statement-breakpoint
grant select, insert on analysis.concept_opportunities to forma_analysis
--> statement-breakpoint
grant select on analysis.concept_opportunities to forma_api
--> statement-breakpoint
grant select, insert on analysis.evidence_items to forma_analysis
--> statement-breakpoint
grant select on analysis.evidence_items to forma_api
--> statement-breakpoint
grant select, insert on analysis.event_relations to forma_analysis
--> statement-breakpoint
grant select on analysis.event_relations to forma_api
--> statement-breakpoint
grant select, insert on analysis.trajectory_episodes to forma_analysis
--> statement-breakpoint
grant select on analysis.trajectory_episodes to forma_api
--> statement-breakpoint
revoke all on analysis.concepts, analysis.concept_versions, analysis.chess_events from public
--> statement-breakpoint
revoke all on analysis.event_concepts, analysis.concept_opportunities from public
--> statement-breakpoint
revoke all on analysis.evidence_items, analysis.event_relations, analysis.trajectory_episodes from public
--> statement-breakpoint
reset role

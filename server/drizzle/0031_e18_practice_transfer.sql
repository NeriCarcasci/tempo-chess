-- 0031_e18_practice_transfer
--
-- E18 — training items, interventions, assignments, practice attempts, review
-- schedules and real-game transfer.
--
-- Hand-written and reviewed. Additive and forward-only: seven tables in the
-- `coaching` namespace. No existing object changes shape, no row is touched,
-- nothing is dropped or renamed. Re-running it is a no-op.
--
-- This is the epic where "practice is not improvement" stops being a sentence
-- in a document and becomes a mechanism. Four constraints carry it:
--
--   * A practice attempt and a real-game opportunity are different tables with
--     different names, and nothing joins them except a transfer match that has
--     to state why the two situations were comparable.
--   * A transfer match records positive, negative *or* inconclusive. A matcher
--     that can only find successes is a matcher that will find them everywhere.
--   * A player-derived training item carries its owning subject and cannot be
--     shared. Somebody's own blunder is not editorial content.
--   * Attempts are append-only and idempotent by the client's own id, so a
--     retried submit is one attempt and a changed schedule never rewrites what
--     somebody actually did.

set local role forma_migrator
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 23.1 / 23.2 — training items
-- ---------------------------------------------------------------------------
create table if not exists coaching.training_items (
  id uuid primary key default gen_random_uuid(),
  source_kind text not null,
  /* Null for shared or editorial content. Set for anything derived from one
     person's games, which is what makes the privacy rule enforceable. */
  owner_subject_id uuid references app.analysis_subjects(id) on delete restrict,
  provenance text not null,
  retention_class text not null,
  created_at timestamptz not null default now(),
  constraint training_items_source_check check (source_kind in (
    'player_evidence', 'transfer_variant', 'editorial', 'licensed_dataset'
  )),
  constraint training_items_retention_check
    check (retention_class in ('subject_owned', 'shared', 'licensed')),
  constraint training_items_provenance_present check (length(btrim(provenance)) >= 10),
  -- The privacy rule, as a constraint rather than a convention: an item derived
  -- from somebody's own games is owned by them and retained as theirs. A
  -- player-derived item with no owner would be exactly the silent conversion
  -- into public content that 23.2 forbids.
  constraint training_items_player_derived_is_owned check (
    (source_kind in ('player_evidence', 'transfer_variant'))
      = (owner_subject_id is not null and retention_class = 'subject_owned')
  )
)
--> statement-breakpoint
comment on table coaching.training_items is 'Stable identity of a reusable exercise (database architecture 23.1). An item derived from a player''s own games is owned by that subject and retained as theirs: somebody''s own blunder is not editorial content, and the constraint is what keeps that true when a content pipeline is written later.'
--> statement-breakpoint
create table if not exists coaching.training_item_versions (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references coaching.training_items(id) on delete restrict,
  version integer not null,
  core_position_id bigint references chess.core_positions(id) on delete restrict,
  fen text not null,
  prompt text not null,
  /* The moves the rubric accepts. Ordered, because the first is the answer and
     the rest are acceptable alternatives. */
  solution_uci text[] not null,
  concept_version_id uuid references analysis.concept_versions(id) on delete restrict,
  difficulty numeric(4, 3),
  generation_method text not null,
  licence text,
  content_sha256 text not null,
  created_at timestamptz not null default now(),
  constraint training_item_versions_unique unique (item_id, version),
  constraint training_item_versions_content_unique unique (content_sha256),
  constraint training_item_versions_version_positive check (version >= 1),
  constraint training_item_versions_prompt_present check (length(btrim(prompt)) >= 10),
  constraint training_item_versions_solution_present check (cardinality(solution_uci) >= 1),
  constraint training_item_versions_checksum_shape check (content_sha256 ~ '^[0-9a-f]{64}$'),
  constraint training_item_versions_difficulty_range
    check (difficulty is null or difficulty between 0 and 1),
  constraint training_item_versions_method_shape
    check (generation_method ~ '^[a-z][a-z0-9_]{2,63}$')
)
--> statement-breakpoint
comment on table coaching.training_item_versions is 'The immutable content of one item version (database architecture 23.2). The content checksum is unique, so the same exercise cannot be registered twice under two identities and then scheduled as if it were two things to learn.'
--> statement-breakpoint
drop trigger if exists training_item_versions_immutable on coaching.training_item_versions
--> statement-breakpoint
create trigger training_item_versions_immutable
  before update or delete on coaching.training_item_versions
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 23.3 — interventions
-- ---------------------------------------------------------------------------
create table if not exists coaching.interventions (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references app.analysis_subjects(id) on delete restrict,
  cycle_id uuid references coaching.coaching_cycles(id) on delete restrict,
  /* What evidence this was a response to. An intervention that addresses
     nothing is a notification. */
  finding_id uuid references analysis.findings(id) on delete restrict,
  evidence_item_id bigint references analysis.evidence_items(id) on delete restrict,
  intervention_type text not null,
  training_item_version_id uuid references coaching.training_item_versions(id) on delete restrict,
  channel text not null,
  delivered_at timestamptz not null default now(),
  engagement_state text not null default 'delivered',
  engaged_at timestamptz,
  constraint interventions_type_check check (intervention_type in (
    'explanation', 'lesson', 'drill', 'review', 'recommendation'
  )),
  constraint interventions_channel_check check (channel in ('in_app', 'email', 'digest')),
  constraint interventions_engagement_check
    check (engagement_state in ('delivered', 'opened', 'completed', 'dismissed')),
  constraint interventions_engaged_when_engaged check (
    (engagement_state in ('opened', 'completed', 'dismissed')) = (engaged_at is not null)
  ),
  -- Something has to have prompted this. Delivering an exercise that addresses
  -- no finding and no evidence is a product filling a screen.
  constraint interventions_addresses_something check (
    finding_id is not null or evidence_item_id is not null
  ),
  -- A drill or a lesson is content, so it names the version it delivered.
  constraint interventions_content_when_needed check (
    intervention_type not in ('drill', 'lesson') or training_item_version_id is not null
  )
)
--> statement-breakpoint
comment on table coaching.interventions is 'The append-only record of what Forma delivered and why (database architecture 23.3). An intervention must address a finding or a piece of evidence: delivering an exercise that answers nothing is a product filling a screen.'
--> statement-breakpoint
create index if not exists interventions_subject
  on coaching.interventions (subject_id, delivered_at desc)
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 23.4 — assignments
-- ---------------------------------------------------------------------------
create table if not exists coaching.learning_assignments (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references app.analysis_subjects(id) on delete restrict,
  cycle_id uuid references coaching.coaching_cycles(id) on delete restrict,
  training_item_version_id uuid not null
    references coaching.training_item_versions(id) on delete restrict,
  intervention_id uuid references coaching.interventions(id) on delete restrict,
  finding_id uuid references analysis.findings(id) on delete restrict,
  /* Why this item, in the selector's own words. Every assignment states its
     source and reason: an exercise a user cannot see the point of is one they
     will do resentfully or not at all. */
  reason text not null,
  selection_component_version_id uuid not null
    references analysis.component_versions(id) on delete restrict,
  priority smallint not null,
  status text not null default 'assigned',
  assigned_at timestamptz not null default now(),
  due_at timestamptz,
  completed_at timestamptz,
  constraint assignments_status_check
    check (status in ('assigned', 'in_progress', 'completed', 'skipped', 'expired')),
  constraint assignments_priority_range check (priority between 0 and 100),
  constraint assignments_reason_present check (length(btrim(reason)) >= 15),
  constraint assignments_completed_when_terminal check (
    (status in ('completed', 'skipped', 'expired')) = (completed_at is not null)
  ),
  constraint assignments_due_after_assigned check (due_at is null or due_at >= assigned_at)
)
--> statement-breakpoint
comment on table coaching.learning_assignments is 'Why and when an item was assigned (database architecture 23.4). The reason is required and the selector version is pinned, so "why am I doing this" always has an answer that is not "the algorithm".'
--> statement-breakpoint
create index if not exists assignments_subject_due
  on coaching.learning_assignments (subject_id, status, due_at)
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 23.5 — practice attempts
--
-- Deliberately a different table from analysis.concept_opportunities and from
-- coaching.diagnostic_attempts. Three names for three kinds of evidence, and
-- nothing joins practice to real games except a transfer match that has to say
-- why the two were comparable.
-- ---------------------------------------------------------------------------
create table if not exists coaching.practice_attempts (
  id bigint generated always as identity primary key,
  assignment_id uuid not null references coaching.learning_assignments(id) on delete restrict,
  training_item_version_id uuid not null
    references coaching.training_item_versions(id) on delete restrict,
  client_attempt_id text not null,
  submitted_uci text[] not null,
  response_time_ms integer,
  hints_used smallint not null default 0,
  retries smallint not null default 0,
  revealed boolean not null default false,
  success boolean not null,
  score numeric(4, 3),
  rubric_component_version_id uuid not null
    references analysis.component_versions(id) on delete restrict,
  evidence_item_id bigint references analysis.evidence_items(id) on delete restrict,
  attempted_at timestamptz not null default now(),
  -- Idempotent by the client's own id: a retried submit over a flaky connection
  -- is one attempt, not two, and the deduplication does not depend on the
  -- server guessing.
  constraint practice_attempts_idempotent unique (assignment_id, client_attempt_id),
  constraint practice_attempts_client_id_shape
    check (client_attempt_id ~ '^[A-Za-z0-9_-]{8,128}$'),
  constraint practice_attempts_moves_present check (cardinality(submitted_uci) >= 1),
  constraint practice_attempts_score_range check (score is null or score between 0 and 1),
  constraint practice_attempts_time_range check (
    response_time_ms is null or (response_time_ms >= 0 and response_time_ms <= 3_600_000)
  ),
  constraint practice_attempts_hints_range check (hints_used between 0 and 5),
  constraint practice_attempts_retries_range check (retries between 0 and 20),
  -- A revealed answer is not a success. Counting it as one would make the
  -- scheduler believe something was learned that was only read.
  constraint practice_attempts_revealed_is_not_success check (not revealed or not success)
)
--> statement-breakpoint
comment on table coaching.practice_attempts is 'The append-only record of one practice attempt (database architecture 23.5). A separate table from real-game evidence and from diagnostic attempts, on purpose: three kinds of evidence with three names, and nothing joins practice to a real game except a transfer match that states why they were comparable.'
--> statement-breakpoint
drop trigger if exists practice_attempts_immutable on coaching.practice_attempts
--> statement-breakpoint
create trigger practice_attempts_immutable
  before update or delete on coaching.practice_attempts
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 23.6 — review schedules
--
-- The one mutable table in this epic. A schedule is current state; the history
-- it was derived from is the attempts, which are immutable. That split is what
-- lets a scheduler be replaced without rewriting what anybody did.
-- ---------------------------------------------------------------------------
create table if not exists coaching.review_schedules (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references app.analysis_subjects(id) on delete restrict,
  training_item_version_id uuid not null
    references coaching.training_item_versions(id) on delete restrict,
  scheduler_component_version_id uuid not null
    references analysis.component_versions(id) on delete restrict,
  due_at timestamptz not null,
  interval_days numeric(7, 3) not null,
  stability numeric(7, 3),
  difficulty numeric(4, 3),
  /* The attempt this state was computed from. A schedule that cannot name it
     cannot be rebuilt. */
  last_attempt_id bigint references coaching.practice_attempts(id) on delete restrict,
  updated_at timestamptz not null default now(),
  constraint review_schedules_unique unique (subject_id, training_item_version_id),
  constraint review_schedules_interval_positive check (interval_days > 0),
  constraint review_schedules_stability_positive check (stability is null or stability > 0),
  constraint review_schedules_difficulty_range check (difficulty is null or difficulty between 0 and 1)
)
--> statement-breakpoint
comment on table coaching.review_schedules is 'Current scheduling state per subject and item (database architecture 23.6). Mutable, and the only mutable table here: the history it derives from is the attempts, which are not, so replacing a scheduler rebuilds state without rewriting what anybody actually did.'
--> statement-breakpoint
create index if not exists review_schedules_due on coaching.review_schedules (subject_id, due_at)
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 23.7 — transfer matches
--
-- The only bridge between practice and real games, and it is a bridge with a
-- toll: every crossing states the method, the similarity it measured, whether
-- the contexts were comparable at all, and an outcome that is allowed to be
-- negative or inconclusive.
-- ---------------------------------------------------------------------------
create table if not exists coaching.transfer_matches (
  id bigint generated always as identity primary key,
  subject_id uuid not null references app.analysis_subjects(id) on delete restrict,
  /* The earlier work. At least one of these, or there is nothing to transfer
     from. */
  intervention_id uuid references coaching.interventions(id) on delete restrict,
  assignment_id uuid references coaching.learning_assignments(id) on delete restrict,
  source_finding_id uuid references analysis.findings(id) on delete restrict,
  /* The later real-game opportunity. Not an attempt: transfer is measured in
     games, which is the whole point. */
  opportunity_id bigint not null
    references analysis.concept_opportunities(id) on delete restrict,
  match_component_version_id uuid not null
    references analysis.component_versions(id) on delete restrict,
  exact_similarity numeric(5, 4),
  structural_similarity numeric(5, 4),
  semantic_similarity numeric(5, 4),
  comparable_context boolean not null,
  incomparable_reason text,
  outcome text not null,
  confidence numeric(5, 4) not null,
  created_at timestamptz not null default now(),
  constraint transfer_matches_unique
    unique (opportunity_id, assignment_id, match_component_version_id),
  constraint transfer_matches_has_source check (
    intervention_id is not null or assignment_id is not null or source_finding_id is not null
  ),
  constraint transfer_matches_similarity_range check (
    (exact_similarity is null or exact_similarity between 0 and 1)
    and (structural_similarity is null or structural_similarity between 0 and 1)
    and (semantic_similarity is null or semantic_similarity between 0 and 1)
  ),
  constraint transfer_matches_confidence_range check (confidence between 0 and 1),
  -- Three outcomes, not two. A matcher that can only record successes is a
  -- matcher that will find them everywhere, and `inconclusive` is the honest
  -- answer most of the time.
  constraint transfer_matches_outcome_check
    check (outcome in ('positive', 'negative', 'inconclusive')),
  -- An incomparable context explains itself, and cannot claim a directional
  -- outcome: if the two situations were not alike, nothing was transferred
  -- either way.
  constraint transfer_matches_incomparable_explained check (
    (not comparable_context) = (incomparable_reason is not null)
  ),
  constraint transfer_matches_incomparable_is_inconclusive check (
    comparable_context or outcome = 'inconclusive'
  ),
  constraint transfer_matches_incomparable_reason_shape check (
    incomparable_reason is null or incomparable_reason in (
      'different_concept', 'different_phase', 'different_speed', 'too_distant_in_time',
      'similarity_below_threshold', 'opportunity_censored'
    )
  )
)
--> statement-breakpoint
comment on table coaching.transfer_matches is 'The only link between earlier practice and a later real-game opportunity (database architecture 23.7). Every match states its method, its similarity components, whether the contexts were comparable at all, and an outcome that may be negative or inconclusive. A practice solve supports engagement; it cannot by itself create an improvement finding.'
--> statement-breakpoint
comment on column coaching.transfer_matches.outcome is 'positive, negative or inconclusive. The third is the honest answer most of the time, and a matcher without it would find successes everywhere.'
--> statement-breakpoint
create index if not exists transfer_matches_subject
  on coaching.transfer_matches (subject_id, created_at desc)
--> statement-breakpoint
drop trigger if exists transfer_matches_immutable on coaching.transfer_matches
--> statement-breakpoint
create trigger transfer_matches_immutable
  before update or delete on coaching.transfer_matches
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Grants. Practice is a user surface: the API records attempts and reads the
-- queue. The analysis worker assigns work and matches transfer.
-- ---------------------------------------------------------------------------
grant select on coaching.training_items to forma_api
--> statement-breakpoint
grant select on coaching.training_item_versions to forma_api
--> statement-breakpoint
grant select on coaching.interventions to forma_api
--> statement-breakpoint
grant update (engagement_state, engaged_at) on coaching.interventions to forma_api
--> statement-breakpoint
grant select on coaching.learning_assignments to forma_api
--> statement-breakpoint
grant update (status, completed_at) on coaching.learning_assignments to forma_api
--> statement-breakpoint
grant select, insert on coaching.practice_attempts to forma_api
--> statement-breakpoint
grant select, insert, update on coaching.review_schedules to forma_api
--> statement-breakpoint
grant select on coaching.transfer_matches to forma_api
--> statement-breakpoint
grant select, insert on coaching.training_items to forma_analysis
--> statement-breakpoint
grant select, insert on coaching.training_item_versions to forma_analysis
--> statement-breakpoint
grant select, insert on coaching.interventions to forma_analysis
--> statement-breakpoint
grant select, insert on coaching.learning_assignments to forma_analysis
--> statement-breakpoint
grant select on coaching.practice_attempts to forma_analysis
--> statement-breakpoint
grant select, insert, update on coaching.review_schedules to forma_analysis
--> statement-breakpoint
grant select, insert on coaching.transfer_matches to forma_analysis

-- 0030_e17_goals_cycles
--
-- E17 — goal templates, goals, fixed-baseline coaching cycles, metric targets,
-- requirements, commitments and progress.
--
-- Hand-written and reviewed. Additive and forward-only: eight tables in the
-- `coaching` namespace, plus one nullable column and one foreign key on E16's
-- onboarding run. No existing object changes shape, no row is touched, nothing
-- is dropped or renamed. Re-running it is a no-op.
--
-- A goal is a promise the product makes to a person about their own
-- improvement, which makes this the schema where a shortcut does the most
-- damage. Four constraints are the promise rather than the bookkeeping:
--
--   * A cycle pins its baseline, its target and the model that judged them, and
--     is immutable. Moving the goalposts requires a new cycle with a new
--     sequence number, so "you are 80% of the way there" cannot silently become
--     "you are 40% of the way there" because an estimator was promoted.
--   * A commitment is something the user confirmed. `confirmed_at` is not null,
--     always, because a commitment inferred from activity is the product
--     telling someone what they agreed to.
--   * Progress, readiness and adherence are three separate columns. Doing the
--     work is not the same as being ready, and being ready is not the same as
--     having demonstrated it in a real game.
--   * `target_achieved` requires real-game evidence. Practice cannot complete a
--     goal, and the check constraint is what makes that true when a later
--     handler forgets.

set local role forma_migrator
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 22.1 — goal templates
-- ---------------------------------------------------------------------------
create table if not exists coaching.goal_templates (
  id uuid primary key default gen_random_uuid(),
  template_key text not null unique,
  category text not null,
  display_name text not null,
  created_at timestamptz not null default now(),
  constraint goal_templates_key_shape check (template_key ~ '^[a-z][a-z0-9_]{2,63}$'),
  constraint goal_templates_category_check check (category in (
    'rating', 'tactical_reliability', 'endgame_conversion', 'resilience',
    'decision_speed', 'opening_repertoire', 'custom'
  ))
)
--> statement-breakpoint
comment on table coaching.goal_templates is 'Stable goal identity (database architecture 22.1). The definition lives in the versions table, so a template can be improved without rewriting what somebody already agreed to.'
--> statement-breakpoint
create table if not exists coaching.goal_template_versions (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references coaching.goal_templates(id) on delete restrict,
  version text not null,
  supported_outcome text not null,
  /* The rules, as immutable documents: which subjects may use it, what metrics
     it needs, how a target is set, and what counts as success. */
  eligibility jsonb not null,
  required_metrics jsonb not null,
  target_rules jsonb not null,
  success_contract jsonb not null,
  plan_generator_component_version_id uuid
    references analysis.component_versions(id) on delete restrict,
  /*
   * Whether this template's target can be stated in a calibrated way at all.
   *
   * A rating goal outside the calibrated band is still a legitimate thing to
   * want; what Forma cannot do is promise a number. The flag makes the caveat a
   * property of the template rather than something a handler remembers.
   */
  requires_calibrated_cohort boolean not null default true,
  promoted_at timestamptz,
  created_at timestamptz not null default now(),
  constraint goal_template_versions_unique unique (template_id, version),
  constraint goal_template_versions_outcome_shape
    check (supported_outcome ~ '^[a-z][a-z0-9_]{2,63}$'),
  constraint goal_template_versions_documents_shape check (
    jsonb_typeof(eligibility) = 'object' and jsonb_typeof(required_metrics) = 'array'
    and jsonb_typeof(target_rules) = 'object' and jsonb_typeof(success_contract) = 'object'
  ),
  -- A success contract with no rule in it would let anything count as success.
  constraint goal_template_versions_success_not_empty
    check (success_contract <> '{}'::jsonb)
)
--> statement-breakpoint
comment on table coaching.goal_template_versions is 'The immutable definition of a goal: who may set it, which metrics it needs, how a target is derived and what counts as success (database architecture 22.1). Promoting a new version never changes what an existing goal agreed to.'
--> statement-breakpoint
drop trigger if exists goal_template_versions_immutable on coaching.goal_template_versions
--> statement-breakpoint
create trigger goal_template_versions_immutable
  before update or delete on coaching.goal_template_versions
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 22.2 — goals
-- ---------------------------------------------------------------------------
create table if not exists coaching.goals (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references app.analysis_subjects(id) on delete restrict,
  template_version_id uuid references coaching.goal_template_versions(id) on delete restrict,
  status text not null default 'draft',
  /* What the user said they wanted, kept verbatim beside the normalized form.
     A goal a person cannot recognise as theirs is not their goal. */
  stated_objective text not null,
  target_provider text,
  target_pool text,
  target_speed text,
  comparison_frame text not null,
  horizon_days integer,
  /* Set when the target could not be stated in calibrated terms. The goal is
     still legal; what it may not carry is a confident number. */
  uncalibrated_caveat text,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  closed_at timestamptz,
  close_outcome text,
  close_note text,
  constraint goals_status_check
    check (status in ('draft', 'active', 'achieved', 'abandoned', 'superseded')),
  constraint goals_frame_check check (comparison_frame in (
    'personal_current', 'peer_current', 'peer_stretch', 'objective'
  )),
  constraint goals_provider_check
    check (target_provider is null or target_provider in ('lichess', 'chesscom')),
  constraint goals_speed_check check (target_speed is null or target_speed in (
    'bullet', 'blitz', 'rapid', 'classical', 'correspondence'
  )),
  constraint goals_horizon_range check (horizon_days is null or horizon_days between 7 and 730),
  constraint goals_stated_objective_present check (length(btrim(stated_objective)) >= 3),
  constraint goals_activated_when_active check (
    (status in ('active', 'achieved')) <= (activated_at is not null)
  ),
  constraint goals_closed_states check (
    (status in ('achieved', 'abandoned', 'superseded')) = (closed_at is not null)
  ),
  constraint goals_close_outcome_check check (
    close_outcome is null or close_outcome in ('completed', 'abandoned', 'replaced')
  ),
  constraint goals_close_outcome_present check ((closed_at is not null) = (close_outcome is not null)),
  -- A custom goal has no template; a templated one has no invented outcome.
  constraint goals_custom_or_templated check (
    template_version_id is not null or length(btrim(stated_objective)) >= 10
  )
)
--> statement-breakpoint
comment on table coaching.goals is 'One user-owned intended outcome (database architecture 22.2). The user''s own words are stored beside the normalized target because a goal somebody cannot recognise as theirs is not their goal.'
--> statement-breakpoint
-- One active goal per subject. v1 permits a single active primary goal, and a
-- partial unique index is how that survives a double-submitted form.
create unique index if not exists goals_one_active_per_subject
  on coaching.goals (subject_id) where status = 'active'
--> statement-breakpoint
create index if not exists goals_subject on coaching.goals (subject_id, created_at desc)
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 22.3 — coaching cycles
--
-- The immutable part. A cycle names the baseline it measures from, the target
-- it measures towards, and the model versions that judged both. Nothing about
-- it can be edited: changing any of those is a new cycle, which is what stops
-- a promotion from silently rewriting how far along somebody is.
-- ---------------------------------------------------------------------------
create table if not exists coaching.coaching_cycles (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid not null references coaching.goals(id) on delete restrict,
  sequence_no integer not null,
  baseline_report_id uuid references coaching.baseline_reports(id) on delete restrict,
  baseline_analysis_run_id uuid not null references analysis.runs(id) on delete restrict,
  baseline_snapshot_id uuid not null
    references analysis.subject_data_snapshots(id) on delete restrict,
  /* The frozen comparison. A cycle judges progress against the cohort and the
     estimator that were current when it started, never against today's. */
  target_cohort_version_id uuid references analysis.cohort_definition_versions(id) on delete restrict,
  estimator_component_version_id uuid not null
    references analysis.component_versions(id) on delete restrict,
  plan_generator_component_version_id uuid not null
    references analysis.component_versions(id) on delete restrict,
  status text not null default 'active',
  starts_on date not null,
  ends_on date,
  /* Set when this cycle replaced an earlier one. A rebasing is a recorded
     event with a reason, not an edit. */
  rebased_from_cycle_id uuid references coaching.coaching_cycles(id) on delete restrict,
  rebase_reason text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint cycles_sequence_unique unique (goal_id, sequence_no),
  constraint cycles_sequence_positive check (sequence_no >= 1),
  constraint cycles_status_check
    check (status in ('active', 'completed', 'abandoned', 'superseded')),
  constraint cycles_dates_ordered check (ends_on is null or starts_on <= ends_on),
  constraint cycles_terminal_has_completion check (
    (status in ('completed', 'abandoned', 'superseded')) = (completed_at is not null)
  ),
  constraint cycles_no_self_rebase
    check (rebased_from_cycle_id is null or rebased_from_cycle_id <> id),
  -- A rebasing states its reason. An unexplained one is indistinguishable from
  -- a target that moved because the number was inconvenient.
  constraint cycles_rebase_explained check (
    (rebased_from_cycle_id is not null) = (rebase_reason is not null)
  ),
  constraint cycles_rebase_reason_shape check (
    rebase_reason is null or rebase_reason in (
      'estimator_promoted', 'target_cohort_recalibrated', 'user_changed_target',
      'baseline_superseded'
    )
  )
)
--> statement-breakpoint
comment on table coaching.coaching_cycles is 'One fixed-baseline attempt at a goal (database architecture 22.3). Immutable, and that is the point: changing the baseline, the target standard or the estimator creates a new cycle, so "you are 80% of the way there" cannot quietly become "40%" because a model was promoted.'
--> statement-breakpoint
create unique index if not exists cycles_one_active_per_goal
  on coaching.coaching_cycles (goal_id) where status = 'active'
--> statement-breakpoint
drop trigger if exists coaching_cycles_immutable on coaching.coaching_cycles
--> statement-breakpoint
create trigger coaching_cycles_immutable
  before delete on coaching.coaching_cycles
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 22.4 — metric targets
-- ---------------------------------------------------------------------------
create table if not exists coaching.goal_metric_targets (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references coaching.coaching_cycles(id) on delete cascade,
  metric_key text not null,
  skill_dimension_id uuid references analysis.skill_dimensions(id) on delete restrict,
  baseline_value numeric(10, 5) not null,
  baseline_interval_low numeric(10, 5),
  baseline_interval_high numeric(10, 5),
  target_value numeric(10, 5) not null,
  direction text not null,
  /* Below this, a change is noise. Stored per target because "meaningful" is a
     property of the metric, not a global constant. */
  meaningful_change numeric(10, 5) not null,
  weight numeric(4, 3) not null default 1,
  /* What has to be observed before this target may be called met. */
  required_evidence_count integer not null,
  required_coverage_state text not null default 'limited',
  created_at timestamptz not null default now(),
  constraint metric_targets_unique unique (cycle_id, metric_key),
  constraint metric_targets_key_shape check (metric_key ~ '^[a-z][a-z0-9_]{2,63}$'),
  constraint metric_targets_direction_check check (direction in ('increase', 'decrease')),
  constraint metric_targets_interval_ordered check (
    baseline_interval_low is null or baseline_interval_high is null
    or baseline_interval_low <= baseline_interval_high
  ),
  constraint metric_targets_weight_range check (weight > 0 and weight <= 1),
  constraint metric_targets_meaningful_positive check (meaningful_change > 0),
  constraint metric_targets_evidence_positive check (required_evidence_count >= 1),
  constraint metric_targets_coverage_check
    check (required_coverage_state in ('limited', 'sufficient')),
  -- A target must actually be a target: it has to lie beyond the baseline in
  -- the stated direction, by more than the noise floor. Otherwise the goal is
  -- met the moment it is set.
  constraint metric_targets_moves_the_bar check (
    (direction = 'increase' and target_value >= baseline_value + meaningful_change)
    or (direction = 'decrease' and target_value <= baseline_value - meaningful_change)
  )
)
--> statement-breakpoint
comment on table coaching.goal_metric_targets is 'One measurable target for a cycle (database architecture 22.4). The bar has to move: a target inside the noise floor would be met the moment it was set, which is the most flattering possible way to build a coaching product that does nothing.'
--> statement-breakpoint
drop trigger if exists goal_metric_targets_immutable on coaching.goal_metric_targets
--> statement-breakpoint
create trigger goal_metric_targets_immutable
  before update or delete on coaching.goal_metric_targets
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 22.5 — requirements
--
-- What the plan asks for. Per cycle, never global: platform spec is explicit
-- that there is no universal "four games per day" rule, and a requirement with
-- no cycle would be exactly that.
-- ---------------------------------------------------------------------------
create table if not exists coaching.goal_requirements (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references coaching.coaching_cycles(id) on delete cascade,
  requirement_key text not null,
  kind text not null,
  quantity numeric(8, 2) not null,
  unit text not null,
  window_days integer not null,
  essential boolean not null,
  /* Why this is being asked for, in the plan's own terms. A requirement whose
     rationale is empty is a chore. */
  rationale text not null,
  generator_component_version_id uuid not null
    references analysis.component_versions(id) on delete restrict,
  cohort_filter jsonb not null default '{}'::jsonb,
  display_rank smallint not null,
  created_at timestamptz not null default now(),
  constraint requirements_unique unique (cycle_id, requirement_key),
  constraint requirements_key_shape check (requirement_key ~ '^[a-z][a-z0-9_]{2,63}$'),
  constraint requirements_kind_check check (kind in (
    'play_games', 'review_games', 'targeted_practice', 'study_material', 'rest'
  )),
  constraint requirements_unit_check check (unit in ('games', 'reviews', 'sessions', 'minutes', 'days')),
  constraint requirements_quantity_positive check (quantity > 0),
  constraint requirements_window_range check (window_days between 1 and 90),
  constraint requirements_rationale_present check (length(btrim(rationale)) >= 20),
  constraint requirements_filter_shape check (jsonb_typeof(cohort_filter) = 'object'),
  constraint requirements_rank_range check (display_rank between 0 and 99)
)
--> statement-breakpoint
comment on table coaching.goal_requirements is 'One prescribed activity for one cycle (database architecture 22.5). Per cycle rather than global, because there is no universal "four games per day" rule and a requirement with no cycle would be exactly that. The rationale is required: a requirement that cannot say why is a chore.'
--> statement-breakpoint
drop trigger if exists goal_requirements_immutable on coaching.goal_requirements
--> statement-breakpoint
create trigger goal_requirements_immutable
  before update or delete on coaching.goal_requirements
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 22.6 — commitments
--
-- Append-only. What somebody agreed to do, when they agreed to it, and what
-- changed since. Never inferred from what they actually did.
-- ---------------------------------------------------------------------------
create table if not exists coaching.goal_commitments (
  id bigint generated always as identity primary key,
  cycle_id uuid not null references coaching.coaching_cycles(id) on delete restrict,
  commitment_key text not null,
  revision integer not null,
  target numeric(8, 2) not null,
  cadence text not null,
  unit text not null,
  enabled boolean not null default true,
  accepted_requirement_keys text[] not null default '{}'::text[],
  effective_from date not null,
  effective_to date,
  /*
   * When the user said yes. Not null, always.
   *
   * A commitment inferred from activity is the product telling somebody what
   * they agreed to, and then holding them to it. The column being `not null` is
   * the whole guarantee.
   */
  confirmed_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint commitments_revision_unique unique (cycle_id, commitment_key, revision),
  constraint commitments_key_shape check (commitment_key ~ '^[a-z][a-z0-9_]{2,63}$'),
  constraint commitments_revision_positive check (revision >= 1),
  constraint commitments_cadence_check check (cadence in ('daily', 'weekly', 'fortnightly')),
  constraint commitments_unit_check check (unit in ('games', 'reviews', 'sessions', 'minutes')),
  constraint commitments_target_positive check (target > 0),
  constraint commitments_dates_ordered check (effective_to is null or effective_from <= effective_to)
)
--> statement-breakpoint
comment on table coaching.goal_commitments is 'The append-only history of what a user agreed to do (database architecture 22.6). `confirmed_at` is not null on purpose: a commitment inferred from activity is the product deciding what somebody signed up for and then holding them to it.'
--> statement-breakpoint
drop trigger if exists goal_commitments_immutable on coaching.goal_commitments
--> statement-breakpoint
create trigger goal_commitments_immutable
  before update or delete on coaching.goal_commitments
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 22.7 — progress snapshots
--
-- The three numbers a coaching product is most tempted to blend. They stay
-- apart: doing the work is not being ready, and being ready is not having done
-- it in a real game.
-- ---------------------------------------------------------------------------
create table if not exists coaching.goal_progress_snapshots (
  id bigint generated always as identity primary key,
  cycle_id uuid not null references coaching.coaching_cycles(id) on delete restrict,
  analysis_run_id uuid not null references analysis.runs(id) on delete restrict,
  metric_key text not null,
  current_value numeric(10, 5),
  interval_low numeric(10, 5),
  interval_high numeric(10, 5),
  /* Movement from the frozen baseline, in the target's own units. */
  progress_from_baseline numeric(10, 5),
  /* How close the current estimate is to the frozen target, 0 to 1. */
  readiness numeric(5, 4),
  /* What the user actually did, against what they committed to. Deliberately
     not an input to readiness. */
  adherence_ratio numeric(5, 4),
  requirements_met integer not null default 0,
  requirements_total integer not null default 0,
  /* Real-game opportunities observed since the baseline. The only evidence
     that can complete a goal. */
  real_game_evidence_count integer not null default 0,
  practice_evidence_count integer not null default 0,
  coverage_state text not null,
  claim_state text not null,
  target_achieved boolean not null default false,
  unavailable_reason text,
  created_at timestamptz not null default now(),
  constraint progress_unique unique (analysis_run_id, cycle_id, metric_key),
  constraint progress_metric_shape check (metric_key ~ '^[a-z][a-z0-9_]{2,63}$'),
  constraint progress_interval_present check (
    (current_value is null) = (interval_low is null)
    and (interval_low is null) = (interval_high is null)
  ),
  constraint progress_interval_ordered check (
    interval_low is null or (interval_low <= current_value and current_value <= interval_high)
  ),
  constraint progress_readiness_range check (readiness is null or readiness between 0 and 1),
  constraint progress_adherence_range check (
    adherence_ratio is null or adherence_ratio between 0 and 1
  ),
  constraint progress_counts_non_negative check (
    requirements_met >= 0 and requirements_total >= 0
    and real_game_evidence_count >= 0 and practice_evidence_count >= 0
  ),
  constraint progress_requirements_within_total check (requirements_met <= requirements_total),
  constraint progress_coverage_check
    check (coverage_state in ('insufficient', 'limited', 'sufficient')),
  constraint progress_claim_check check (claim_state in (
    'no_evidence', 'early_signal', 'improving', 'target_met', 'declined', 'unavailable'
  )),
  -- Measured or explained, never silently null.
  constraint progress_value_or_reason check (
    (current_value is not null) <> (unavailable_reason is not null)
  ),
  constraint progress_reason_shape check (
    unavailable_reason is null or unavailable_reason in (
      'no_observations', 'below_minimum_sample', 'estimator_unavailable',
      'outside_calibrated_range'
    )
  ),
  /*
   * A goal cannot be completed by practice.
   *
   * Platform spec 3.4: a chess-strength improvement claim requires a comparable
   * later real-game opportunity. So `target_achieved` needs real-game evidence,
   * a readiness of 1, and coverage that is at least limited. Adherence appears
   * nowhere in this constraint, deliberately — doing the exercises is not the
   * same as having got better, and this is the exact place a coaching product
   * is tempted to pretend otherwise.
   */
  constraint progress_completion_needs_real_games check (
    not target_achieved or (
      real_game_evidence_count > 0
      and readiness is not null and readiness >= 1
      and coverage_state in ('limited', 'sufficient')
      and claim_state = 'target_met'
    )
  )
)
--> statement-breakpoint
comment on table coaching.goal_progress_snapshots is 'One immutable progress reading (database architecture 22.7). Progress, readiness and adherence are three columns, not one: doing the work is not being ready, being ready is not having demonstrated it, and target_achieved requires real-game evidence because practice cannot complete a goal.'
--> statement-breakpoint
comment on column coaching.goal_progress_snapshots.adherence_ratio is 'What the user did against what they committed to. Deliberately not an input to readiness or to target_achieved: an activity counter is not demonstrated progress.'
--> statement-breakpoint
create index if not exists progress_cycle
  on coaching.goal_progress_snapshots (cycle_id, created_at desc)
--> statement-breakpoint
drop trigger if exists goal_progress_immutable on coaching.goal_progress_snapshots
--> statement-breakpoint
create trigger goal_progress_immutable
  before update or delete on coaching.goal_progress_snapshots
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- E16's follow-through.
--
-- The onboarding run recorded `goal_selected_at` with no reference, because the
-- table it would have pointed at did not exist yet and a dangling id is worse
-- than a timestamp. It exists now.
-- ---------------------------------------------------------------------------
alter table coaching.onboarding_runs
  add column if not exists goal_id uuid references coaching.goals(id) on delete restrict
--> statement-breakpoint
comment on column coaching.onboarding_runs.goal_id is 'The goal the user chose during onboarding. Added by E17, which owns the table it points at; E16 recorded only the timestamp because a dangling reference would have been worse than none.'
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Grants. Goals are a user surface, so the API writes them; the analysis worker
-- writes progress and reads everything it needs to compute it.
-- ---------------------------------------------------------------------------
grant select on coaching.goal_templates to forma_api
--> statement-breakpoint
grant select on coaching.goal_template_versions to forma_api
--> statement-breakpoint
grant select, insert, update on coaching.goals to forma_api
--> statement-breakpoint
grant select, insert on coaching.coaching_cycles to forma_api
--> statement-breakpoint
grant update (status, completed_at) on coaching.coaching_cycles to forma_api
--> statement-breakpoint
grant select, insert on coaching.goal_metric_targets to forma_api
--> statement-breakpoint
grant select on coaching.goal_requirements to forma_api
--> statement-breakpoint
grant select, insert on coaching.goal_commitments to forma_api
--> statement-breakpoint
grant select on coaching.goal_progress_snapshots to forma_api
--> statement-breakpoint
grant select, insert on coaching.goal_templates to forma_analysis
--> statement-breakpoint
grant select, insert on coaching.goal_template_versions to forma_analysis
--> statement-breakpoint
grant select on coaching.goals to forma_analysis
--> statement-breakpoint
grant select on coaching.coaching_cycles to forma_analysis
--> statement-breakpoint
grant select on coaching.goal_metric_targets to forma_analysis
--> statement-breakpoint
grant select, insert on coaching.goal_requirements to forma_analysis
--> statement-breakpoint
grant select on coaching.goal_commitments to forma_analysis
--> statement-breakpoint
grant select, insert on coaching.goal_progress_snapshots to forma_analysis

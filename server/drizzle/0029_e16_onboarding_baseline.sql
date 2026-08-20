-- 0029_e16_onboarding_baseline
--
-- E16 — onboarding orchestration, the adaptive diagnostic, and the immutable
-- baseline examination.
--
-- Hand-written and reviewed. Additive and forward-only: eight tables in the
-- `coaching` namespace E02 established, which until now was empty. No existing
-- object changes shape, no row is touched, nothing is dropped or renamed.
-- Re-running it is a no-op.
--
-- This is the first schema a new user actually meets, and three of its
-- constraints are promises rather than bookkeeping:
--
--   * A baseline pins the exact snapshot, run and coverage decision it was
--     built from, forever. It never follows the live pointer afterwards. The
--     report you were shown on day one stays readable on day three hundred even
--     though every estimator has been promoted twice since.
--   * A coverage limitation is never redactable. Entitlements may control depth
--     and continuity; they may not hide the sentence that says the evidence is
--     thin. A paying reader and a free reader must see the same uncertainty.
--   * Activation requires that the user actually saw the report, chose a goal
--     and accepted a commitment. All three, checked by the database, because
--     "activated" is the state the whole product's honesty rests on and it is
--     the easiest one to set by accident.

set local role forma_migrator
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 21.1 — the onboarding run
--
-- One resumable journey. Resumable is the operative word: a user closes the
-- tab during a six-minute sync and comes back tomorrow, and the row is what
-- lets the product pick up rather than start again.
-- ---------------------------------------------------------------------------
create table if not exists coaching.onboarding_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app.profiles(user_id) on delete cascade,
  subject_id uuid not null references app.analysis_subjects(id) on delete restrict,
  stage text not null default 'linking',
  status text not null default 'active',
  -- The work the stages are waiting on. Null until each is created.
  sync_workflow_id uuid references ops.workflows(id) on delete set null,
  examination_run_id uuid references analysis.runs(id) on delete restrict,
  subject_data_snapshot_id uuid references analysis.subject_data_snapshots(id) on delete restrict,
  diagnostic_choice text not null default 'adaptive',
  -- The three things activation requires, each recorded when it happened.
  report_viewed_at timestamptz,
  goal_selected_at timestamptz,
  commitment_accepted_at timestamptz,
  activated_at timestamptz,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint onboarding_stage_check check (stage in (
    'linking', 'syncing', 'analysing', 'diagnostic', 'report_ready',
    'goal_setting', 'activated'
  )),
  constraint onboarding_status_check
    check (status in ('active', 'activated', 'abandoned', 'failed')),
  constraint onboarding_diagnostic_choice_check
    check (diagnostic_choice in ('adaptive', 'skip')),
  -- Activation is the product's central honesty claim, so it is checked here
  -- rather than trusted to a handler: a run cannot be activated without the
  -- user having seen the report, chosen a goal and accepted a commitment.
  constraint onboarding_activation_requires_all_three check (
    activated_at is null or (
      report_viewed_at is not null
      and goal_selected_at is not null
      and commitment_accepted_at is not null
    )
  ),
  constraint onboarding_activated_states_agree check (
    (activated_at is not null) = (status = 'activated' and stage = 'activated')
  ),
  constraint onboarding_terminal_has_completion check (
    (status in ('activated', 'abandoned', 'failed')) = (completed_at is not null)
  ),
  constraint onboarding_failure_explained check (
    (status = 'failed') = (failure_reason is not null)
  ),
  constraint onboarding_failure_reason_shape check (
    failure_reason is null or failure_reason in (
      'no_linked_account', 'provider_unavailable', 'no_eligible_games',
      'analysis_failed', 'abandoned_by_user'
    )
  )
)
--> statement-breakpoint
comment on table coaching.onboarding_runs is 'One resumable onboarding journey for a personal subject (database architecture 21.1). Activation is recorded only after the user viewed the baseline report, selected a goal and accepted a commitment, and the constraint enforcing that is deliberate: activated is the state the product''s honesty rests on and the easiest one to set by accident.'
--> statement-breakpoint
create index if not exists onboarding_runs_user on coaching.onboarding_runs (user_id, created_at desc)
--> statement-breakpoint
-- One active journey per subject. A second is a resume, not a new start. A
-- partial unique index rather than an exclusion constraint: equality on a uuid
-- needs btree_gist, and pulling in an extension to express "at most one" would
-- be a dependency bought for nothing.
create unique index if not exists onboarding_one_active_per_subject
  on coaching.onboarding_runs (subject_id) where status = 'active'
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 21.2 / 21.3 — the coverage decision
--
-- "Fifty games" is a versioned policy hypothesis, not a database constraint and
-- not a promise that every skill has enough evidence. So the snapshot records
-- what the policy decided *and* the per-dimension detail that lets a user see
-- which parts of their game are thin, rather than one number they cannot act on.
-- ---------------------------------------------------------------------------
create table if not exists coaching.data_coverage_snapshots (
  id uuid primary key default gen_random_uuid(),
  subject_data_snapshot_id uuid not null
    references analysis.subject_data_snapshots(id) on delete restrict,
  policy_component_version_id uuid not null
    references analysis.component_versions(id) on delete restrict,
  overall_state text not null,
  total_games integer not null,
  eligible_games integer not null,
  decision_count integer not null,
  earliest_played_at timestamptz,
  latest_played_at timestamptz,
  speeds_covered text[] not null default '{}'::text[],
  clock_available_games integer not null default 0,
  opening_reach_count integer not null default 0,
  middlegame_reach_count integer not null default 0,
  endgame_reach_count integer not null default 0,
  rating_in_calibrated_range boolean,
  limitations text[] not null default '{}'::text[],
  created_at timestamptz not null default now(),
  constraint coverage_snapshot_unique
    unique (subject_data_snapshot_id, policy_component_version_id),
  constraint coverage_state_check
    check (overall_state in ('insufficient', 'limited', 'sufficient')),
  constraint coverage_counts_non_negative check (
    total_games >= 0 and eligible_games >= 0 and decision_count >= 0
    and clock_available_games >= 0 and opening_reach_count >= 0
    and middlegame_reach_count >= 0 and endgame_reach_count >= 0
  ),
  -- Eligibility is a filter, so it cannot produce more games than it was given.
  constraint coverage_eligible_within_total check (eligible_games <= total_games),
  constraint coverage_clock_within_eligible check (clock_available_games <= eligible_games),
  -- A phase cannot be reached by more games than were eligible.
  constraint coverage_reach_within_eligible check (
    opening_reach_count <= eligible_games
    and middlegame_reach_count <= eligible_games
    and endgame_reach_count <= eligible_games
  ),
  constraint coverage_range_ordered check (
    earliest_played_at is null or latest_played_at is null
    or earliest_played_at <= latest_played_at
  ),
  -- Anything short of sufficient has to say what is short. A limited report
  -- with no stated limitation is the failure screen this epic exists to avoid,
  -- wearing a friendlier face.
  constraint coverage_limitation_stated check (
    overall_state = 'sufficient' or cardinality(limitations) > 0
  )
)
--> statement-breakpoint
comment on table coaching.data_coverage_snapshots is 'The immutable coverage decision for one frozen snapshot under one policy version (database architecture 21.2). Anything short of sufficient must name its limitations: platform spec 14.5 requires a user with thin evidence to see a useful limited report and the exact missing evidence, and an unstated limitation is a failure screen with better manners.'
--> statement-breakpoint
drop trigger if exists coverage_snapshots_immutable on coaching.data_coverage_snapshots
--> statement-breakpoint
create trigger coverage_snapshots_immutable
  before update or delete on coaching.data_coverage_snapshots
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
create table if not exists coaching.data_coverage_dimensions (
  coverage_snapshot_id uuid not null
    references coaching.data_coverage_snapshots(id) on delete cascade,
  dimension_key text not null,
  skill_dimension_id uuid references analysis.skill_dimensions(id) on delete restrict,
  observation_count integer not null,
  effective_count numeric(9, 4) not null,
  earliest_played_at timestamptz,
  latest_played_at timestamptz,
  state text not null,
  limitation_reason text,
  primary key (coverage_snapshot_id, dimension_key),
  constraint coverage_dimension_key_shape check (dimension_key ~ '^[a-z][a-z0-9_]{2,63}$'),
  constraint coverage_dimension_state_check
    check (state in ('insufficient', 'limited', 'sufficient')),
  constraint coverage_dimension_counts check (
    observation_count >= 0 and effective_count >= 0
  ),
  -- Time weighting can only remove weight, never add it. Same rule E15's
  -- estimates carry, restated where the user reads the coverage figure.
  constraint coverage_dimension_effective_within_observed
    check (effective_count <= observation_count),
  constraint coverage_dimension_limitation_stated check (
    (state = 'sufficient') = (limitation_reason is null)
  )
)
--> statement-breakpoint
comment on table coaching.data_coverage_dimensions is 'One measured slice of a subject''s coverage (database architecture 21.3). The per-dimension detail is what turns "we need more games" into "we have never seen you defend a fork in a rapid endgame", which is a sentence a player can act on.'
--> statement-breakpoint
drop trigger if exists coverage_dimensions_immutable on coaching.data_coverage_dimensions
--> statement-breakpoint
create trigger coverage_dimensions_immutable
  before update or delete on coaching.data_coverage_dimensions
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 21.4-21.6 — the adaptive diagnostic
--
-- An examination, not a puzzle set. Each item names the uncertainty it was
-- selected to reduce, and the attempt is append-only: a second try is practice,
-- and practice is not examination evidence (platform spec 3.4).
-- ---------------------------------------------------------------------------
create table if not exists coaching.diagnostic_sessions (
  id uuid primary key default gen_random_uuid(),
  onboarding_run_id uuid not null references coaching.onboarding_runs(id) on delete restrict,
  subject_id uuid not null references app.analysis_subjects(id) on delete restrict,
  selection_component_version_id uuid not null
    references analysis.component_versions(id) on delete restrict,
  rubric_component_version_id uuid not null
    references analysis.component_versions(id) on delete restrict,
  status text not null default 'open',
  -- Platform spec 14.7: the user is told what an item is testing before they
  -- answer it. Recorded as a flag so a session run without that guarantee is
  -- visibly a different kind of evidence.
  pre_explanation_guaranteed boolean not null default true,
  item_count smallint not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint diagnostic_sessions_status_check
    check (status in ('open', 'completed', 'abandoned')),
  constraint diagnostic_sessions_terminal_has_completion check (
    (status in ('completed', 'abandoned')) = (completed_at is not null)
  ),
  -- Bounded: platform spec 14.7 calls for a short bounded set. An unbounded
  -- diagnostic is a puzzle trainer, which is a different product.
  constraint diagnostic_sessions_bounded check (item_count between 1 and 20)
)
--> statement-breakpoint
-- One open session per run. A repeated request resumes rather than forking.
create unique index if not exists diagnostic_one_open_per_run
  on coaching.diagnostic_sessions (onboarding_run_id) where status = 'open'
--> statement-breakpoint
comment on table coaching.diagnostic_sessions is 'A bounded adaptive examination used to reduce uncertainty (database architecture 21.4), not a generic puzzle set. The rubric version is pinned at creation so an attempt is scored by the rules that were in force when it was asked, not by whatever was promoted since.'
--> statement-breakpoint
create table if not exists coaching.diagnostic_session_items (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references coaching.diagnostic_sessions(id) on delete cascade,
  ordinal smallint not null,
  purpose text not null,
  core_position_id bigint not null references chess.core_positions(id) on delete restrict,
  fen text not null,
  -- What this item was chosen to find out. A diagnostic item with no stated
  -- uncertainty is a puzzle, and its result cannot update anything.
  investigates_dimension_key text not null,
  investigates_finding_id uuid references analysis.findings(id) on delete set null,
  /* The move the rubric treats as correct, and the tolerance around it. Never
     returned by the API before an attempt is submitted. */
  expected_uci text not null,
  acceptable_uci text[] not null default '{}'::text[],
  presented_at timestamptz,
  constraint diagnostic_items_unique unique (session_id, ordinal),
  constraint diagnostic_items_ordinal_range check (ordinal between 0 and 19),
  constraint diagnostic_items_purpose_check check (purpose in (
    'earlier_mishandled', 'transfer_variant', 'strength_confirmation',
    'target_level', 'timed_decision'
  )),
  constraint diagnostic_items_dimension_shape
    check (investigates_dimension_key ~ '^[a-z][a-z0-9_]{2,63}$'),
  constraint diagnostic_items_uci_shape
    check (expected_uci ~ '^[a-h][1-8][a-h][1-8][qrbn]?$')
)
--> statement-breakpoint
comment on table coaching.diagnostic_session_items is 'One assigned item with a declared purpose and the uncertainty it investigates (database architecture 21.5). An item that names no uncertainty is a puzzle, and a puzzle result cannot update an estimate.'
--> statement-breakpoint
drop trigger if exists diagnostic_items_immutable on coaching.diagnostic_session_items
--> statement-breakpoint
create trigger diagnostic_items_immutable
  before delete on coaching.diagnostic_session_items
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
create table if not exists coaching.diagnostic_attempts (
  id bigint generated always as identity primary key,
  session_item_id uuid not null
    references coaching.diagnostic_session_items(id) on delete restrict,
  client_attempt_id text not null,
  move_uci text not null,
  think_time_ms integer,
  hints_used smallint not null default 0,
  correct boolean not null,
  score numeric(4, 3) not null,
  rubric_component_version_id uuid not null
    references analysis.component_versions(id) on delete restrict,
  evidence_item_id bigint references analysis.evidence_items(id) on delete restrict,
  submitted_at timestamptz not null default now(),
  -- One attempt per item, forever. A second try is practice, and platform spec
  -- 3.4 is explicit that practice performance cannot become a chess-strength
  -- claim; letting a user retry an examination item until it scores would do
  -- exactly that.
  constraint diagnostic_attempts_one_per_item unique (session_item_id),
  constraint diagnostic_attempts_idempotent unique (session_item_id, client_attempt_id),
  constraint diagnostic_attempts_uci_shape
    check (move_uci ~ '^[a-h][1-8][a-h][1-8][qrbn]?$'),
  constraint diagnostic_attempts_score_range check (score between 0 and 1),
  constraint diagnostic_attempts_think_time check (
    think_time_ms is null or (think_time_ms >= 0 and think_time_ms <= 3_600_000)
  ),
  constraint diagnostic_attempts_hints_range check (hints_used between 0 and 3),
  constraint diagnostic_attempts_client_id_shape
    check (client_attempt_id ~ '^[A-Za-z0-9_-]{8,128}$')
)
--> statement-breakpoint
comment on table coaching.diagnostic_attempts is 'The append-only response to one diagnostic item (database architecture 21.6). One attempt per item, forever: a second try is practice, and platform spec 3.4 forbids practice performance becoming a chess-strength claim.'
--> statement-breakpoint
drop trigger if exists diagnostic_attempts_immutable on coaching.diagnostic_attempts
--> statement-breakpoint
create trigger diagnostic_attempts_immutable
  before update or delete on coaching.diagnostic_attempts
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 21.7 / 21.8 — the immutable baseline
-- ---------------------------------------------------------------------------
create table if not exists coaching.baseline_reports (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references app.analysis_subjects(id) on delete restrict,
  onboarding_run_id uuid not null references coaching.onboarding_runs(id) on delete restrict,
  subject_data_snapshot_id uuid not null
    references analysis.subject_data_snapshots(id) on delete restrict,
  analysis_run_id uuid not null references analysis.runs(id) on delete restrict,
  coverage_snapshot_id uuid not null
    references coaching.data_coverage_snapshots(id) on delete restrict,
  layout_component_version_id uuid not null
    references analysis.component_versions(id) on delete restrict,
  diagnostic_session_id uuid references coaching.diagnostic_sessions(id) on delete restrict,
  manifest_sha256 text not null,
  published_at timestamptz not null default now(),
  -- One baseline per journey. A second examination is a new run, not a second
  -- opinion on the first.
  constraint baseline_one_per_run unique (onboarding_run_id),
  constraint baseline_manifest_shape check (manifest_sha256 ~ '^[0-9a-f]{64}$')
)
--> statement-breakpoint
comment on table coaching.baseline_reports is 'The immutable examination result (database architecture 21.7). It pins the exact snapshot, run and coverage decision it was built from and never follows the live publication pointer afterwards, so the report a user was shown on day one is still readable on day three hundred after two estimator promotions.'
--> statement-breakpoint
drop trigger if exists baseline_reports_immutable on coaching.baseline_reports
--> statement-breakpoint
create trigger baseline_reports_immutable
  before update or delete on coaching.baseline_reports
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
create table if not exists coaching.baseline_report_items (
  baseline_report_id uuid not null references coaching.baseline_reports(id) on delete cascade,
  section text not null,
  display_order smallint not null,
  item_kind text not null,
  finding_id uuid references analysis.findings(id) on delete restrict,
  player_skill_estimate_id bigint
    references analysis.player_skill_estimates(id) on delete restrict,
  trajectory_snapshot_id uuid
    references analysis.player_trajectory_snapshots(id) on delete restrict,
  coverage_dimension_key text,
  rendered_explanation_id bigint
    references analysis.rendered_explanations(id) on delete restrict,
  entitlement_key text not null,
  primary key (baseline_report_id, section, display_order),
  constraint baseline_items_section_check check (section in (
    'headline', 'coverage', 'strengths', 'constraints', 'trajectory',
    'diagnostic', 'next_steps'
  )),
  constraint baseline_items_kind_check check (item_kind in (
    'finding', 'estimate', 'trajectory', 'coverage', 'narrative'
  )),
  -- An item points at exactly one thing. Two references is a row nobody can
  -- render; none is a row that says nothing.
  constraint baseline_items_one_reference check (
    (finding_id is not null)::int
    + (player_skill_estimate_id is not null)::int
    + (trajectory_snapshot_id is not null)::int
    + (coverage_dimension_key is not null)::int
    + (item_kind = 'narrative')::int = 1
  ),
  constraint baseline_items_entitlement_shape
    check (entitlement_key ~ '^[a-z][a-z0-9_]{2,63}$'),
  -- The promise this whole table exists to keep. Entitlements may control depth
  -- and continuity; they may not hide the sentence saying the evidence is thin.
  -- A free reader and a paying reader see the same uncertainty.
  constraint baseline_items_coverage_is_always_visible check (
    item_kind <> 'coverage' or entitlement_key = 'always'
  )
)
--> statement-breakpoint
comment on table coaching.baseline_report_items is 'The ordered contents of a baseline report (database architecture 21.8). A coverage item must carry the `always` entitlement: the free report stays truthful, and entitlements control depth and continuity rather than hiding uncertainty or reversing a conclusion.'
--> statement-breakpoint
drop trigger if exists baseline_report_items_immutable on coaching.baseline_report_items
--> statement-breakpoint
create trigger baseline_report_items_immutable
  before update or delete on coaching.baseline_report_items
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Grants. The API drives onboarding, so unusually it writes here: linking a
-- run, recording that a report was viewed and submitting a diagnostic attempt
-- are all synchronous user actions, not background work.
-- ---------------------------------------------------------------------------
grant select, insert, update on coaching.onboarding_runs to forma_api
--> statement-breakpoint
grant select, insert on coaching.diagnostic_sessions to forma_api
--> statement-breakpoint
grant select, insert on coaching.diagnostic_session_items to forma_api
--> statement-breakpoint
grant update (presented_at) on coaching.diagnostic_session_items to forma_api
--> statement-breakpoint
grant select, insert on coaching.diagnostic_attempts to forma_api
--> statement-breakpoint
grant select on coaching.data_coverage_snapshots to forma_api
--> statement-breakpoint
grant select on coaching.data_coverage_dimensions to forma_api
--> statement-breakpoint
grant select on coaching.baseline_reports to forma_api
--> statement-breakpoint
grant select on coaching.baseline_report_items to forma_api
--> statement-breakpoint
grant select, insert, update on coaching.onboarding_runs to forma_analysis
--> statement-breakpoint
grant select, insert on coaching.data_coverage_snapshots to forma_analysis
--> statement-breakpoint
grant select, insert on coaching.data_coverage_dimensions to forma_analysis
--> statement-breakpoint
grant select, insert on coaching.baseline_reports to forma_analysis
--> statement-breakpoint
grant select, insert on coaching.baseline_report_items to forma_analysis
--> statement-breakpoint
grant select on coaching.diagnostic_sessions to forma_analysis
--> statement-breakpoint
grant select on coaching.diagnostic_session_items to forma_analysis
--> statement-breakpoint
grant select on coaching.diagnostic_attempts to forma_analysis

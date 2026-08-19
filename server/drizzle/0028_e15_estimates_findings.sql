-- 0028_e15_estimates_findings
--
-- E15 — skill estimates, phase-aligned trajectory, structured findings and the
-- renderer boundary.
--
-- Hand-written and reviewed. Additive and forward-only: nine tables in the
-- `analysis` namespace E02 established. No existing object changes shape, no
-- row is touched, nothing is dropped or renamed. Re-running it is a no-op.
--
-- This epic is where evidence becomes a claim about a person, which is the
-- point at which a schema stops being bookkeeping and starts being an ethical
-- commitment. Four of those commitments are constraints here rather than
-- conventions in an estimator:
--
--   * A number arrives with its uncertainty, its raw sample and its effective
--     sample, or it does not arrive. An estimate with no interval is a claim
--     wearing the costume of a measurement.
--   * Coverage adds up. Successes, failures, graded partials and censored
--     chances must account for every observation the estimate was built from,
--     so "we saw 40 chances" and "we scored 12" cannot quietly be about
--     different sets.
--   * A finding cites evidence, checked at commit rather than at insert, so a
--     claim and the evidence for it land together or not at all. The one
--     exception is a finding whose content is "there is not enough evidence",
--     which is the only honest claim that needs none.
--   * Prose lives in its own table and pins the hash of the structured input it
--     was rendered from. Changing wording cannot change a fact, and a renderer
--     that invented one is detectable by re-deriving the hash.

set local role forma_migrator
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 19.1 — skill dimensions
--
-- A measurable slice, defined once and referenced, rather than a column per
-- question. The uniqueness key is the whole slice, so two dimensions cannot
-- describe the same thing under different names and then disagree.
-- ---------------------------------------------------------------------------
create table if not exists analysis.skill_dimensions (
  id uuid primary key default gen_random_uuid(),
  dimension_key text not null,
  version text not null,
  concept_version_id uuid references analysis.concept_versions(id) on delete restrict,
  role text,
  speed text,
  phase text,
  -- Which of the four comparison frames this dimension is measured against
  -- (platform spec 3.2). Frames are never mixed inside one estimate: "good for
  -- your level" and "objectively strong" are different questions.
  frame text not null,
  display_name text not null,
  created_at timestamptz not null default now(),
  constraint skill_dimensions_unique unique (dimension_key, version),
  -- The slice itself is unique too, so the same measurement cannot be
  -- registered twice under two keys and then reported as two findings.
  constraint skill_dimensions_slice_unique
    unique (concept_version_id, role, speed, phase, frame, version),
  constraint skill_dimensions_key_shape check (dimension_key ~ '^[a-z][a-z0-9_]{2,63}$'),
  constraint skill_dimensions_frame_check
    check (frame in ('personal_current', 'peer_current', 'peer_stretch', 'objective')),
  constraint skill_dimensions_role_check check (role is null or role in (
    'create', 'recognize', 'execute', 'avoid', 'prevent', 'respond', 'convert'
  )),
  constraint skill_dimensions_speed_check check (speed is null or speed in (
    'bullet', 'blitz', 'rapid', 'classical', 'correspondence'
  )),
  constraint skill_dimensions_phase_check
    check (phase is null or phase in ('opening', 'middlegame', 'endgame'))
)
--> statement-breakpoint
comment on table analysis.skill_dimensions is 'A measurable skill slice, defined once and referenced (database architecture 19.1). The slice is unique as a whole, not just by key: two dimensions that describe the same concept, role, speed, phase and frame would be one measurement reported as two findings.'
--> statement-breakpoint
drop trigger if exists skill_dimensions_immutable on analysis.skill_dimensions
--> statement-breakpoint
create trigger skill_dimensions_immutable
  before update or delete on analysis.skill_dimensions
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 19.2 — player skill estimates
-- ---------------------------------------------------------------------------
create table if not exists analysis.player_skill_estimates (
  id bigint generated always as identity primary key,
  analysis_run_id uuid not null references analysis.runs(id) on delete restrict,
  subject_id uuid not null references app.analysis_subjects(id) on delete restrict,
  subject_data_snapshot_id uuid not null
    references analysis.subject_data_snapshots(id) on delete restrict,
  skill_dimension_id uuid not null references analysis.skill_dimensions(id) on delete restrict,
  estimator_component_version_id uuid not null
    references analysis.component_versions(id) on delete restrict,
  window_kind text not null,
  -- The estimate and its interval. All three or none: an estimate with no
  -- interval is a claim wearing the costume of a measurement.
  estimate numeric(6, 5),
  interval_low numeric(6, 5),
  interval_high numeric(6, 5),
  -- Raw is how many observations there were; effective is how many they are
  -- worth after time weighting and discounting. Reporting only the first
  -- overstates confidence; reporting only the second hides how much was seen.
  raw_sample_size integer not null,
  effective_sample_size numeric(9, 4) not null,
  success_count integer not null default 0,
  failure_count integer not null default 0,
  graded_count integer not null default 0,
  censored_count integer not null default 0,
  evidence_from timestamptz,
  evidence_to timestamptz,
  -- The comparison this estimate moved against, when there was one. Null means
  -- first measurement, which is different from "no change".
  comparison_estimate_id bigint references analysis.player_skill_estimates(id) on delete restrict,
  delta numeric(7, 5),
  improvement_probability numeric(6, 5),
  coverage_status text not null,
  unavailable_reason text,
  created_at timestamptz not null default now(),
  constraint estimates_unique unique (analysis_run_id, skill_dimension_id, window_kind),
  constraint estimates_window_check
    check (window_kind in ('lifetime', 'baseline', 'recent_form')),
  constraint estimates_coverage_status_check
    check (coverage_status in ('sufficient', 'limited', 'insufficient', 'out_of_range')),
  -- Measured or explained, never silently null: the same rule E11's validation
  -- metrics use, applied to the number a user actually reads.
  constraint estimates_value_or_reason check (
    (estimate is not null) <> (unavailable_reason is not null)
  ),
  -- An estimate arrives with its interval or not at all.
  constraint estimates_interval_present check (
    (estimate is null) = (interval_low is null)
    and (interval_low is null) = (interval_high is null)
  ),
  constraint estimates_interval_ordered check (
    interval_low is null or (interval_low <= estimate and estimate <= interval_high)
  ),
  constraint estimates_range check (
    (estimate is null or estimate between 0 and 1)
    and (interval_low is null or interval_low between 0 and 1)
    and (interval_high is null or interval_high between 0 and 1)
  ),
  constraint estimates_samples_non_negative check (
    raw_sample_size >= 0 and effective_sample_size >= 0
    and success_count >= 0 and failure_count >= 0
    and graded_count >= 0 and censored_count >= 0
  ),
  -- Discounting and time weighting can only remove weight, never add it.
  constraint estimates_effective_within_raw check (effective_sample_size <= raw_sample_size),
  -- Coverage adds up. Otherwise "we saw 40 chances" and "you succeeded 12
  -- times" can quietly be about different sets of moves.
  constraint estimates_coverage_accounts_for_everything check (
    success_count + failure_count + graded_count + censored_count = raw_sample_size
  ),
  -- A censored chance is not a failure (platform spec 3.3), so an estimate
  -- built only from censored evidence has nothing to estimate.
  constraint estimates_censored_only_is_unavailable check (
    censored_count < raw_sample_size or raw_sample_size = 0 or estimate is null
  ),
  constraint estimates_range_ordered check (
    evidence_from is null or evidence_to is null or evidence_from <= evidence_to
  ),
  -- A delta needs something to be a delta from.
  constraint estimates_delta_needs_comparison check (
    delta is null or comparison_estimate_id is not null
  ),
  constraint estimates_improvement_range check (
    improvement_probability is null or improvement_probability between 0 and 1
  ),
  constraint estimates_reason_shape check (
    unavailable_reason is null or unavailable_reason in (
      'no_observations', 'all_evidence_censored', 'below_minimum_sample',
      'outside_calibrated_range', 'estimator_unavailable'
    )
  )
)
--> statement-breakpoint
comment on table analysis.player_skill_estimates is 'One immutable estimate of one skill dimension from one frozen snapshot (database architecture 19.2). Raw and effective sample size are both required: the first is how much was seen, the second is what it is worth after time weighting, and a reader given only one of them will draw the wrong conclusion from either.'
--> statement-breakpoint
comment on column analysis.player_skill_estimates.censored_count is 'Chances the opponent never gave the player a reply to. Platform spec 3.3: censored evidence does not become success or failure, so it is counted separately and an estimate made only of it is unavailable rather than zero.'
--> statement-breakpoint
create index if not exists estimates_subject_dimension
  on analysis.player_skill_estimates (subject_id, skill_dimension_id, created_at desc)
--> statement-breakpoint
create index if not exists estimates_run on analysis.player_skill_estimates (analysis_run_id)
--> statement-breakpoint
drop trigger if exists player_skill_estimates_immutable on analysis.player_skill_estimates
--> statement-breakpoint
create trigger player_skill_estimates_immutable
  before update or delete on analysis.player_skill_estimates
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 19.4 — rating-pool calibration and Forma scales
--
-- Provider ratings are observations, not universal ability units. These two
-- tables exist so a cross-pool comparison has to name the mapping it used, and
-- so a comparison outside the validated range is suppressed rather than
-- extrapolated confidently.
-- ---------------------------------------------------------------------------
create table if not exists analysis.rating_pool_calibration_versions (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  pool text not null,
  version text not null,
  effective_from date not null,
  effective_to date,
  supported_rating_low integer not null,
  supported_rating_high integer not null,
  population_filter text not null,
  method_component_version_id uuid not null
    references analysis.component_versions(id) on delete restrict,
  validation_run_id uuid references analysis.validation_runs(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint rating_pool_unique unique (provider, pool, version),
  constraint rating_pool_provider_check check (provider in ('lichess', 'chesscom')),
  constraint rating_pool_speed_check check (pool in (
    'bullet', 'blitz', 'rapid', 'classical', 'correspondence'
  )),
  constraint rating_pool_range_ordered
    check (supported_rating_low >= 100 and supported_rating_high > supported_rating_low),
  constraint rating_pool_dates_ordered
    check (effective_to is null or effective_from <= effective_to)
)
--> statement-breakpoint
comment on table analysis.rating_pool_calibration_versions is 'An immutable mapping between one provider rating pool and a calibrated scale, with the range it was validated over (database architecture 19.4). Outside that range a comparison is suppressed, not extrapolated.'
--> statement-breakpoint
drop trigger if exists rating_pool_calibration_immutable on analysis.rating_pool_calibration_versions
--> statement-breakpoint
create trigger rating_pool_calibration_immutable
  before update or delete on analysis.rating_pool_calibration_versions
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
create table if not exists analysis.subject_rating_scale_estimates (
  id bigint generated always as identity primary key,
  analysis_run_id uuid not null references analysis.runs(id) on delete restrict,
  subject_id uuid not null references app.analysis_subjects(id) on delete restrict,
  calibration_version_id uuid not null
    references analysis.rating_pool_calibration_versions(id) on delete restrict,
  speed text not null,
  observed_rating integer,
  scale_estimate numeric(8, 3),
  interval_low numeric(8, 3),
  interval_high numeric(8, 3),
  in_supported_range boolean not null,
  suppressed_reason text,
  created_at timestamptz not null default now(),
  constraint rating_scale_unique unique (analysis_run_id, calibration_version_id, speed),
  constraint rating_scale_speed_check check (speed in (
    'bullet', 'blitz', 'rapid', 'classical', 'correspondence'
  )),
  -- An estimate exists exactly when the observation was inside the validated
  -- range. Outside it, the row says so and carries no number, because a
  -- confident extrapolation is the failure this table exists to prevent.
  constraint rating_scale_range_gates_estimate check (
    (in_supported_range and scale_estimate is not null and suppressed_reason is null)
    or (not in_supported_range and scale_estimate is null and suppressed_reason is not null)
  ),
  constraint rating_scale_interval_present check (
    (scale_estimate is null) = (interval_low is null)
    and (interval_low is null) = (interval_high is null)
  ),
  constraint rating_scale_interval_ordered check (
    interval_low is null or (interval_low <= scale_estimate and scale_estimate <= interval_high)
  )
)
--> statement-breakpoint
comment on table analysis.subject_rating_scale_estimates is 'One subject''s calibrated scale position, per pool and speed (database architecture 19.4). There is deliberately no column that collapses these into one number: the product does not present a single intellect Elo, and the absence of the column is what makes that true rather than a rule someone has to remember.'
--> statement-breakpoint
drop trigger if exists subject_rating_scale_immutable on analysis.subject_rating_scale_estimates
--> statement-breakpoint
create trigger subject_rating_scale_immutable
  before update or delete on analysis.subject_rating_scale_estimates
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 18.2 / 18.3 — phase-aligned trajectory
-- ---------------------------------------------------------------------------
create table if not exists analysis.player_trajectory_snapshots (
  id uuid primary key default gen_random_uuid(),
  analysis_run_id uuid not null references analysis.runs(id) on delete restrict,
  subject_id uuid not null references app.analysis_subjects(id) on delete restrict,
  subject_data_snapshot_id uuid not null
    references analysis.subject_data_snapshots(id) on delete restrict,
  phase_component_version_id uuid not null
    references analysis.component_versions(id) on delete restrict,
  alignment_component_version_id uuid not null
    references analysis.component_versions(id) on delete restrict,
  expected_score_calibration_version_id uuid not null
    references analysis.component_versions(id) on delete restrict,
  included_game_count integer not null,
  speed text,
  color text,
  created_at timestamptz not null default now(),
  constraint trajectory_snapshot_unique unique (analysis_run_id, speed, color),
  constraint trajectory_snapshot_count_non_negative check (included_game_count >= 0),
  constraint trajectory_snapshot_speed_check check (speed is null or speed in (
    'bullet', 'blitz', 'rapid', 'classical', 'correspondence'
  )),
  constraint trajectory_snapshot_color_check check (color is null or color in ('white', 'black'))
)
--> statement-breakpoint
comment on table analysis.player_trajectory_snapshots is 'One immutable phase-aligned trajectory aggregate (database architecture 18.2). It names the phase detector, the aligner and the expected-score calibration, because a curve computed under three different versions is three different curves.'
--> statement-breakpoint
drop trigger if exists trajectory_snapshots_immutable on analysis.player_trajectory_snapshots
--> statement-breakpoint
create trigger trajectory_snapshots_immutable
  before update or delete on analysis.player_trajectory_snapshots
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
create table if not exists analysis.player_trajectory_bins (
  trajectory_snapshot_id uuid not null
    references analysis.player_trajectory_snapshots(id) on delete cascade,
  phase text not null,
  bin_ordinal smallint not null,
  progress_low numeric(5, 4) not null,
  progress_high numeric(5, 4) not null,
  games_contributing integer not null,
  median_expected_score numeric(6, 5) not null,
  p25_expected_score numeric(6, 5) not null,
  p75_expected_score numeric(6, 5) not null,
  interval_low numeric(6, 5),
  interval_high numeric(6, 5),
  -- What fraction of the snapshot's games reached this phase at all. This is
  -- the survival information 3.5 requires: a smooth endgame curve drawn from
  -- the 20% of games that reached an endgame is a different claim from one
  -- drawn from all of them.
  phase_reach_rate numeric(5, 4) not null,
  adverse_change_rate numeric(5, 4),
  recovery_slope numeric(7, 5),
  primary key (trajectory_snapshot_id, phase, bin_ordinal),
  constraint trajectory_bins_phase_check check (phase in ('opening', 'middlegame', 'endgame')),
  constraint trajectory_bins_ordinal_range check (bin_ordinal between 0 and 63),
  constraint trajectory_bins_progress_ordered check (
    progress_low >= 0 and progress_high <= 1 and progress_low < progress_high
  ),
  -- A bin with no games is not a bin. Unreached phases are absent rows, never
  -- rows of zero: 18.3 forbids imputing an endgame nobody played.
  constraint trajectory_bins_has_games check (games_contributing > 0),
  constraint trajectory_bins_percentiles_ordered check (
    p25_expected_score <= median_expected_score and median_expected_score <= p75_expected_score
  ),
  constraint trajectory_bins_range check (
    median_expected_score between 0 and 1
    and p25_expected_score between 0 and 1
    and p75_expected_score between 0 and 1
  ),
  constraint trajectory_bins_interval_ordered check (
    interval_low is null or interval_high is null or interval_low <= interval_high
  ),
  constraint trajectory_bins_reach_rate_range check (phase_reach_rate > 0 and phase_reach_rate <= 1)
)
--> statement-breakpoint
comment on table analysis.player_trajectory_bins is 'One reached phase-bin of a trajectory (database architecture 18.3). An unreached phase produces no rows at all rather than rows of zero, and every bin carries the share of games that reached its phase, so the display cannot imply that every game followed one curve.'
--> statement-breakpoint
drop trigger if exists trajectory_bins_immutable on analysis.player_trajectory_bins
--> statement-breakpoint
create trigger trajectory_bins_immutable
  before update or delete on analysis.player_trajectory_bins
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 19.5 / 19.6 — findings and their evidence
-- ---------------------------------------------------------------------------
create table if not exists analysis.findings (
  id uuid primary key default gen_random_uuid(),
  analysis_run_id uuid not null references analysis.runs(id) on delete restrict,
  subject_id uuid not null references app.analysis_subjects(id) on delete restrict,
  player_skill_estimate_id bigint references analysis.player_skill_estimates(id) on delete restrict,
  finding_type text not null,
  concept_version_id uuid references analysis.concept_versions(id) on delete restrict,
  role text,
  context jsonb not null default '{}'::jsonb,
  priority smallint not null,
  confidence_tier text not null,
  claim jsonb not null,
  -- The family a hypothesis belongs to and the correction applied across it.
  -- Publishing every fluctuation is the failure mode 13 names; the correction
  -- version is stored so a later change of method is a new set of findings
  -- rather than a silent re-ranking of the old ones.
  claim_family text not null,
  correction_component_version_id uuid
    references analysis.component_versions(id) on delete restrict,
  adjusted_probability numeric(6, 5),
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  supersedes_finding_id uuid references analysis.findings(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint findings_type_check check (finding_type in (
    'strength', 'foundational_miss', 'development_frontier', 'repeated_pattern',
    'inconsistency', 'early_improvement_signal', 'established_improvement',
    'transfer', 'insufficient_evidence'
  )),
  constraint findings_role_check check (role is null or role in (
    'create', 'recognize', 'execute', 'avoid', 'prevent', 'respond', 'convert'
  )),
  constraint findings_priority_range check (priority between 0 and 100),
  constraint findings_confidence_check
    check (confidence_tier in ('low', 'moderate', 'high')),
  constraint findings_claim_shape check (jsonb_typeof(claim) = 'object'),
  constraint findings_context_shape check (jsonb_typeof(context) = 'object'),
  constraint findings_family_shape check (claim_family ~ '^[a-z][a-z0-9_]{2,63}$'),
  constraint findings_adjusted_range check (
    adjusted_probability is null or adjusted_probability between 0 and 1
  ),
  -- A corrected probability needs the method that corrected it.
  constraint findings_correction_pairs check (
    (adjusted_probability is null) or (correction_component_version_id is not null)
  ),
  constraint findings_validity_ordered check (valid_to is null or valid_from <= valid_to),
  constraint findings_no_self_supersede
    check (supersedes_finding_id is null or supersedes_finding_id <> id),
  -- An improvement claim is about the player's own later real games. It has to
  -- name the estimate that measured it; a claim with no estimate behind it is
  -- the "practice made you better" shortcut 3.4 forbids.
  constraint findings_improvement_needs_estimate check (
    finding_type not in ('early_improvement_signal', 'established_improvement')
    or player_skill_estimate_id is not null
  )
)
--> statement-breakpoint
comment on table analysis.findings is 'A structured conclusion about a player, never prose (database architecture 19.5). Improvement claims must cite the estimate that measured them, because platform spec 3.4 requires a comparable later real-game opportunity and not a practice score.'
--> statement-breakpoint
create index if not exists findings_subject on analysis.findings (subject_id, created_at desc)
--> statement-breakpoint
create index if not exists findings_run on analysis.findings (analysis_run_id, priority desc)
--> statement-breakpoint
drop trigger if exists findings_immutable on analysis.findings
--> statement-breakpoint
create trigger findings_immutable
  before update or delete on analysis.findings
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
create table if not exists analysis.finding_evidence (
  finding_id uuid not null references analysis.findings(id) on delete cascade,
  evidence_item_id bigint not null references analysis.evidence_items(id) on delete restrict,
  role text not null,
  weight numeric(6, 5),
  display_rank smallint not null,
  primary key (finding_id, evidence_item_id),
  constraint finding_evidence_role_check
    check (role in ('supports', 'contradicts', 'example', 'context')),
  constraint finding_evidence_rank_range check (display_rank between 0 and 999),
  constraint finding_evidence_weight_range check (weight is null or weight between 0 and 1)
)
--> statement-breakpoint
comment on table analysis.finding_evidence is 'What a finding is built from (database architecture 19.6). Contradicting evidence is a role, not a deletion: an example that cuts against the claim is kept and shown, because removing it to make a cleaner story is how a report stops being true.'
--> statement-breakpoint
drop trigger if exists finding_evidence_immutable on analysis.finding_evidence
--> statement-breakpoint
create trigger finding_evidence_immutable
  before update or delete on analysis.finding_evidence
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
-- Every factual finding cites evidence. Checked at commit rather than at
-- insert, because a finding and its evidence are written in one transaction and
-- neither can exist first. `insufficient_evidence` is exempt: its whole content
-- is that there is not enough to say, which is the one claim that needs none.
create or replace function analysis.enforce_finding_evidence() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.finding_type = 'insufficient_evidence' then
    return new;
  end if;
  if not exists (
    select 1 from analysis.finding_evidence e
    where e.finding_id = new.id and e.role in ('supports', 'example')
  ) then
    raise exception 'finding % of type % has no supporting evidence',
      new.id, new.finding_type using errcode = 'check_violation';
  end if;
  return new;
end;
$$
--> statement-breakpoint
comment on function analysis.enforce_finding_evidence() is 'Refuses a factual finding with no supporting evidence at commit time (database architecture 19.6). Deferred rather than immediate because the finding and its evidence are written together and neither row can exist first.'
--> statement-breakpoint
revoke all on function analysis.enforce_finding_evidence() from public
--> statement-breakpoint
drop trigger if exists findings_have_evidence on analysis.findings
--> statement-breakpoint
create constraint trigger findings_have_evidence
  after insert on analysis.findings
  deferrable initially deferred
  for each row execute function analysis.enforce_finding_evidence()
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 19.7 — rendered explanations
--
-- Prose is a separate artifact that points at a finding and pins the hash of
-- the structured input it was given. Changing wording cannot change a fact, and
-- a renderer that invented one is caught by re-deriving the hash from the
-- finding and comparing.
-- ---------------------------------------------------------------------------
create table if not exists analysis.rendered_explanations (
  id bigint generated always as identity primary key,
  finding_id uuid not null references analysis.findings(id) on delete restrict,
  renderer_component_version_id uuid not null
    references analysis.component_versions(id) on delete restrict,
  locale text not null,
  tone text not null,
  reading_level text not null,
  structured_input_hash text not null,
  rendered_text text not null,
  safety_state text not null,
  safety_note text,
  created_at timestamptz not null default now(),
  constraint rendered_unique
    unique (finding_id, renderer_component_version_id, locale, tone, reading_level),
  constraint rendered_locale_shape check (locale ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  constraint rendered_hash_shape check (structured_input_hash ~ '^[0-9a-f]{64}$'),
  constraint rendered_safety_check
    check (safety_state in ('passed', 'held', 'rejected')),
  -- Held and rejected text is kept, so an operator can see what was refused,
  -- but the state has to say why.
  constraint rendered_state_explained check (
    safety_state = 'passed' or safety_note is not null
  ),
  constraint rendered_text_present check (length(btrim(rendered_text)) > 0),
  constraint rendered_tone_shape check (tone ~ '^[a-z][a-z0-9_]{2,31}$'),
  constraint rendered_reading_level_shape check (reading_level ~ '^[a-z][a-z0-9_]{2,31}$')
)
--> statement-breakpoint
comment on table analysis.rendered_explanations is 'Prose rendered from one finding (database architecture 19.7). The structured-input hash is what makes the boundary checkable: re-derive it from the finding and the renderer either had exactly those facts or it did not.'
--> statement-breakpoint
create index if not exists rendered_finding on analysis.rendered_explanations (finding_id)
--> statement-breakpoint
drop trigger if exists rendered_explanations_immutable on analysis.rendered_explanations
--> statement-breakpoint
create trigger rendered_explanations_immutable
  before update or delete on analysis.rendered_explanations
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Grants, matching E12 and E14: the analysis worker writes, the API reads.
-- ---------------------------------------------------------------------------
grant select, insert on analysis.skill_dimensions to forma_analysis
--> statement-breakpoint
grant select, insert on analysis.player_skill_estimates to forma_analysis
--> statement-breakpoint
grant select, insert on analysis.rating_pool_calibration_versions to forma_analysis
--> statement-breakpoint
grant select, insert on analysis.subject_rating_scale_estimates to forma_analysis
--> statement-breakpoint
grant select, insert on analysis.player_trajectory_snapshots to forma_analysis
--> statement-breakpoint
grant select, insert on analysis.player_trajectory_bins to forma_analysis
--> statement-breakpoint
grant select, insert on analysis.findings to forma_analysis
--> statement-breakpoint
grant select, insert on analysis.finding_evidence to forma_analysis
--> statement-breakpoint
grant select, insert on analysis.rendered_explanations to forma_analysis
--> statement-breakpoint
grant select on analysis.skill_dimensions to forma_api
--> statement-breakpoint
grant select on analysis.player_skill_estimates to forma_api
--> statement-breakpoint
grant select on analysis.rating_pool_calibration_versions to forma_api
--> statement-breakpoint
grant select on analysis.subject_rating_scale_estimates to forma_api
--> statement-breakpoint
grant select on analysis.player_trajectory_snapshots to forma_api
--> statement-breakpoint
grant select on analysis.player_trajectory_bins to forma_api
--> statement-breakpoint
grant select on analysis.findings to forma_api
--> statement-breakpoint
grant select on analysis.finding_evidence to forma_api
--> statement-breakpoint
grant select on analysis.rendered_explanations to forma_api

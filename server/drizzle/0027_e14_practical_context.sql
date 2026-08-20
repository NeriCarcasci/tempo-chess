-- 0027_e14_practical_context
--
-- E14 — calibrated human context and practical counterplay.
--
-- Hand-written and reviewed. Additive and forward-only: seven tables in the
-- `analysis` namespace E02 established. No existing object changes shape, no
-- row is touched, nothing is dropped or renamed. Re-running it is a no-op.
--
-- The whole point of this epic is a separation, so the schema draws it rather
-- than trusting a caller to respect it:
--
--   * Stockfish says what is true. A human model says what someone of a stated
--     strength is likely to play. Those are different claims, so they live in
--     different tables, and neither trigger will accept the other's output.
--   * A human claim that was never calibrated on the slice it is applied to is
--     not a weaker claim, it is not a claim at all. `unavailable` is a recorded
--     state with a reason, not a missing row.
--   * Practical context is keyed by the objective assessment rather than being
--     columns on it, so the human layer can be recomputed under a new
--     calibration, or withdrawn entirely, without rewriting one objective row.
--     That is what "rollback with no result overwrite" has to mean in a schema.

set local role forma_migrator
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Licence review (platform spec 12.1)
--
-- Maia-family weights require licence review before promotion. A status column
-- on the profile can be set by whoever writes the insert; this is the evidence
-- that has to exist first, and the trigger below makes "cleared" unwritable
-- without it.
-- ---------------------------------------------------------------------------
create table if not exists analysis.model_licence_reviews (
  component_version_id uuid primary key references analysis.component_versions(id) on delete restrict,
  decision text not null,
  licence_spdx text not null,
  source_url text not null,
  -- What the licence actually obliges us to do, in words, because "GPL-3.0" is
  -- an identifier and not an answer to "may we deploy this".
  obligations text not null,
  distribution_posture text not null,
  reviewer text not null,
  reviewed_at timestamptz not null default now(),
  note text,
  constraint model_licence_reviews_decision_check
    check (decision in ('cleared', 'restricted', 'rejected')),
  constraint model_licence_reviews_spdx_shape
    check (licence_spdx ~ '^[A-Za-z0-9][A-Za-z0-9.+-]{1,63}$'),
  constraint model_licence_reviews_source_shape
    check (source_url ~ '^https://[a-z0-9.-]+/'),
  constraint model_licence_reviews_posture_check
    check (distribution_posture in ('server_side_only', 'redistributed', 'not_deployed')),
  constraint model_licence_reviews_text_present check (
    length(btrim(obligations)) >= 20 and length(btrim(reviewer)) >= 2
  )
)
--> statement-breakpoint
comment on table analysis.model_licence_reviews is 'The licence and provenance review a model must pass before its output may be stored (platform spec 12.1). Immutable: a review is a dated statement by a named reviewer about one component version, so revising it means writing a new component version rather than editing the record of what was decided about the old one.'
--> statement-breakpoint
drop trigger if exists model_licence_reviews_immutable on analysis.model_licence_reviews
--> statement-breakpoint
create trigger model_licence_reviews_immutable
  before update or delete on analysis.model_licence_reviews
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
create or replace function analysis.enforce_licence_review() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.licence_review_status = 'cleared'
     and not exists (
       select 1 from analysis.model_licence_reviews r
       where r.component_version_id = new.component_version_id
         and r.decision = 'cleared'
     ) then
    raise exception
      'model profile % cannot be cleared without a cleared licence review',
      new.component_version_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$
--> statement-breakpoint
comment on function analysis.enforce_licence_review() is 'A model profile may only claim a cleared licence when analysis.model_licence_reviews holds a cleared decision for the same component version (platform spec 12.1).'
--> statement-breakpoint
revoke all on function analysis.enforce_licence_review() from public
--> statement-breakpoint
drop trigger if exists model_profiles_licence_reviewed on analysis.model_profiles
--> statement-breakpoint
create trigger model_profiles_licence_reviewed
  before insert on analysis.model_profiles
  for each row execute function analysis.enforce_licence_review()
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Checksum-addressed assets
--
-- "Import checksum-addressed licensed assets", from the rollout evidence. The
-- artifact reference is optional because a binary we run but do not
-- redistribute is recorded by hash and origin, not copied into our storage.
-- ---------------------------------------------------------------------------
create table if not exists analysis.model_assets (
  id uuid primary key default gen_random_uuid(),
  component_version_id uuid not null references analysis.component_versions(id) on delete restrict,
  asset_kind text not null,
  sha256 text not null,
  byte_size bigint not null,
  source_url text not null,
  artifact_id uuid references ops.artifacts(id) on delete restrict,
  imported_at timestamptz not null default now(),
  constraint model_assets_unique unique (component_version_id, asset_kind, sha256),
  constraint model_assets_kind_check check (asset_kind in ('binary', 'weights', 'network', 'config')),
  constraint model_assets_sha_shape check (sha256 ~ '^[0-9a-f]{64}$'),
  constraint model_assets_size_positive check (byte_size > 0),
  constraint model_assets_source_shape check (source_url ~ '^https://[a-z0-9.-]+/')
)
--> statement-breakpoint
comment on table analysis.model_assets is 'Every executable and weight file a model version depends on, addressed by content hash and origin. Two runs that disagree about a result must be able to prove whether they disagreed about the model.'
--> statement-breakpoint
drop trigger if exists model_assets_immutable on analysis.model_assets
--> statement-breakpoint
create trigger model_assets_immutable
  before update or delete on analysis.model_assets
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 15.4 — model inferences
--
-- Immutable non-Stockfish inference. The declared input context sits beside the
-- output because a human-policy result is meaningless without the strength it
-- was conditioned on: the same position has a different answer for 1100 and for
-- 1900, and a row that does not say which is not reusable.
-- ---------------------------------------------------------------------------
create table if not exists analysis.model_inferences (
  id bigint generated always as identity primary key,
  model_component_version_id uuid not null
    references analysis.model_profiles(component_version_id) on delete restrict,
  core_position_id bigint not null references chess.core_positions(id) on delete restrict,
  -- The exact occurrence, when this inference was produced for one. Null makes
  -- the row anonymous and separately retainable (15.4).
  occurrence_run_id uuid,
  occurrence_ply integer,
  output_kind text not null,
  -- Declared input context. Nulls are honest: an inference conditioned on a
  -- rating we did not have is a different inference from one conditioned on
  -- 1500, and the cache key has to be able to tell them apart.
  context_provider text,
  context_actor_rating integer,
  context_opponent_rating integer,
  context_speed text,
  context_clock_bucket text,
  context_has_move_history boolean not null,
  input_contract_hash text not null,
  cache_key text not null,
  -- Calibrated scalars. Which of these is populated is decided by output_kind
  -- and enforced below.
  retained_probability_mass numeric(9, 8),
  retained_move_count smallint,
  policy_entropy_bits numeric(8, 5),
  human_win numeric(9, 8),
  human_draw numeric(9, 8),
  human_loss numeric(9, 8),
  calibration_component_version_id uuid references analysis.component_versions(id) on delete restrict,
  -- Unindexed raw payload (15.4): what the model actually said, for a later
  -- reader who does not trust our summary of it.
  raw_payload jsonb not null default '{}'::jsonb,
  computed_at timestamptz not null default now(),
  -- Generated, so retention cannot be misreported: an inference is anonymous
  -- exactly when it names no occurrence.
  anonymous boolean generated always as (occurrence_run_id is null) stored,
  unretained_probability_mass numeric(9, 8) generated always as
    (case when retained_probability_mass is null then null
          else 1 - retained_probability_mass end) stored,
  constraint model_inferences_cache_unique unique (model_component_version_id, cache_key),
  constraint model_inferences_occurrence_fk
    foreign key (occurrence_run_id, occurrence_ply)
    references chess.position_occurrences(run_id, ply) on delete restrict,
  constraint model_inferences_occurrence_shape
    check ((occurrence_run_id is null) = (occurrence_ply is null)),
  constraint model_inferences_kind_check
    check (output_kind in ('human_policy', 'human_outcome', 'secondary_eval', 'detector', 'embedding')),
  constraint model_inferences_provider_check
    check (context_provider is null or context_provider in ('lichess', 'chesscom')),
  constraint model_inferences_speed_check
    check (context_speed is null or context_speed in
      ('bullet', 'blitz', 'rapid', 'classical', 'correspondence')),
  constraint model_inferences_rating_range check (
    (context_actor_rating is null or context_actor_rating between 100 and 4000)
    and (context_opponent_rating is null or context_opponent_rating between 100 and 4000)
  ),
  constraint model_inferences_clock_shape check (
    context_clock_bucket is null or context_clock_bucket ~ '^[a-z][a-z0-9_]{1,31}$'
  ),
  constraint model_inferences_hash_shape check (input_contract_hash ~ '^[0-9a-f]{64}$'),
  constraint model_inferences_cache_shape check (cache_key ~ '^[0-9a-f]{64}$'),
  constraint model_inferences_payload_shape check (jsonb_typeof(raw_payload) = 'object'),
  -- A policy inference carries a distribution; nothing else does.
  constraint model_inferences_policy_shape check (
    (output_kind = 'human_policy') =
    (retained_probability_mass is not null and retained_move_count is not null
      and policy_entropy_bits is not null)
  ),
  constraint model_inferences_policy_range check (
    (retained_probability_mass is null or retained_probability_mass between 0 and 1)
    and (retained_move_count is null or retained_move_count >= 0)
    and (policy_entropy_bits is null or policy_entropy_bits >= 0)
  ),
  -- Human WDL is answerable together or not at all, and only for the kind that
  -- means it. It is deliberately here and not in analysis.position_evaluations:
  -- it is a claim about people, not about chess.
  constraint model_inferences_outcome_shape check (
    (human_win is null) = (human_draw is null)
    and (human_draw is null) = (human_loss is null)
    and (human_win is null or output_kind = 'human_outcome')
  ),
  constraint model_inferences_outcome_sums check (
    human_win is null or (human_win + human_draw + human_loss) between 0.999 and 1.001
  )
)
--> statement-breakpoint
comment on table analysis.model_inferences is 'Immutable non-Stockfish inference: human policy, human outcome, secondary oracle or detector output (database architecture 15.4). Maia human-game WDL is stored here under the human_outcome kind and is never placed in Stockfish objective-WDL columns.'
--> statement-breakpoint
comment on column analysis.model_inferences.unretained_probability_mass is 'The probability the model assigned to moves we did not keep. Explicit (15.5) so entropy and adequate-set probability are read as the bounds they are rather than as exact values.'
--> statement-breakpoint
comment on column analysis.model_inferences.anonymous is 'True when the row names no occurrence, which is the condition under which 15.4 permits anonymous retention. Generated, so it cannot drift from the reference it describes.'
--> statement-breakpoint
create index if not exists model_inferences_position
  on analysis.model_inferences (core_position_id, output_kind)
--> statement-breakpoint
create index if not exists model_inferences_occurrence
  on analysis.model_inferences (occurrence_run_id, occurrence_ply)
  where occurrence_run_id is not null
--> statement-breakpoint
drop trigger if exists model_inferences_immutable on analysis.model_inferences
--> statement-breakpoint
create trigger model_inferences_immutable
  before update or delete on analysis.model_inferences
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
-- The mirror of analysis.enforce_objective_engine: that trigger keeps human
-- output out of the objective table, this one keeps objective output out of the
-- human table, and it refuses any model whose licence was never cleared.
create or replace function analysis.enforce_model_inference_source() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  profile_role text;
  licence_status text;
begin
  select role, licence_review_status into profile_role, licence_status
  from analysis.model_profiles
  where component_version_id = new.model_component_version_id;

  if profile_role is null then
    raise exception 'no model profile for component version %',
      new.model_component_version_id using errcode = 'foreign_key_violation';
  end if;

  if profile_role = 'objective_engine' then
    raise exception
      'objective_engine output belongs in analysis.position_evaluations, not analysis.model_inferences'
      using errcode = 'check_violation';
  end if;

  if licence_status <> 'cleared' then
    raise exception
      'model profile % has licence review status %, so its output may not be stored',
      new.model_component_version_id, licence_status
      using errcode = 'check_violation';
  end if;

  if (new.output_kind = 'human_policy' and profile_role <> 'human_policy')
     or (new.output_kind = 'human_outcome' and profile_role <> 'human_outcome') then
    raise exception 'output kind % does not match model role %',
      new.output_kind, profile_role using errcode = 'check_violation';
  end if;

  return new;
end;
$$
--> statement-breakpoint
comment on function analysis.enforce_model_inference_source() is 'Refuses an inference from an objective engine, from a model whose licence review is not cleared, or whose declared output kind contradicts its registered role (platform spec 12.1, database architecture 15.4).'
--> statement-breakpoint
revoke all on function analysis.enforce_model_inference_source() from public
--> statement-breakpoint
drop trigger if exists model_inferences_source on analysis.model_inferences
--> statement-breakpoint
create trigger model_inferences_source
  before insert on analysis.model_inferences
  for each row execute function analysis.enforce_model_inference_source()
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 15.5 — retained policy moves
-- ---------------------------------------------------------------------------
create table if not exists analysis.model_move_probabilities (
  model_inference_id bigint not null
    references analysis.model_inferences(id) on delete cascade,
  rank smallint not null,
  uci text not null,
  probability numeric(9, 8) not null,
  logit double precision,
  visits bigint,
  primary key (model_inference_id, rank),
  constraint model_move_probabilities_rank_check check (rank between 1 and 256),
  constraint model_move_probabilities_uci_shape check (uci ~ '^[a-h][1-8][a-h][1-8][qrbn]?$'),
  constraint model_move_probabilities_range check (probability between 0 and 1),
  constraint model_move_probabilities_move_unique unique (model_inference_id, uci)
)
--> statement-breakpoint
comment on table analysis.model_move_probabilities is 'One row per retained policy move (database architecture 15.5). The mass outside these rows lives on the parent inference, so entropy and adequate-set probability are never overstated.'
--> statement-breakpoint
drop trigger if exists model_move_probabilities_immutable on analysis.model_move_probabilities
--> statement-breakpoint
create trigger model_move_probabilities_immutable
  before update or delete on analysis.model_move_probabilities
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 15.6 — agreement between oracles
-- ---------------------------------------------------------------------------
create table if not exists analysis.model_agreement_assessments (
  id bigint generated always as identity primary key,
  analysis_run_id uuid not null references analysis.runs(id) on delete restrict,
  objective_evaluation_id bigint not null
    references analysis.position_evaluations(id) on delete restrict,
  secondary_inference_id bigint not null
    references analysis.model_inferences(id) on delete restrict,
  comparison_component_version_id uuid not null
    references analysis.component_versions(id) on delete restrict,
  value_disagreement numeric(7, 5) not null,
  candidate_disagreement boolean not null,
  review_priority smallint not null,
  created_at timestamptz not null default now(),
  constraint model_agreement_unique
    unique (analysis_run_id, objective_evaluation_id, secondary_inference_id),
  constraint model_agreement_value_range check (value_disagreement between 0 and 1),
  constraint model_agreement_priority_range check (review_priority between 0 and 100)
)
--> statement-breakpoint
comment on table analysis.model_agreement_assessments is 'A versioned comparison between the objective oracle and a secondary one (database architecture 15.6). Disagreement raises review priority. There is no write path from this table back into analysis.position_evaluations, which is the point: a secondary model can flag the objective answer for review and can never replace it.'
--> statement-breakpoint
drop trigger if exists model_agreement_immutable on analysis.model_agreement_assessments
--> statement-breakpoint
create trigger model_agreement_immutable
  before update or delete on analysis.model_agreement_assessments
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 15.4 — which runs reused which inference
-- ---------------------------------------------------------------------------
create table if not exists analysis.run_model_inference_uses (
  analysis_run_id uuid not null references analysis.runs(id) on delete restrict,
  model_inference_id bigint not null references analysis.model_inferences(id) on delete restrict,
  primary key (analysis_run_id, model_inference_id)
)
--> statement-breakpoint
comment on table analysis.run_model_inference_uses is 'Links a run to the inferences it read, including ones it did not compute (database architecture 15.4). A cached inference is still an input a rebuild has to be able to find.'
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Calibrated slices
--
-- The runtime answer to "may we say anything at all about this player". It is a
-- table and not a constant in code because the supported range is a
-- measurement, and a measurement that lives in a deploy is one nobody can audit.
-- ---------------------------------------------------------------------------
create table if not exists analysis.model_calibration_slices (
  id uuid primary key default gen_random_uuid(),
  calibration_component_version_id uuid not null
    references analysis.component_versions(id) on delete restrict,
  model_component_version_id uuid not null
    references analysis.model_profiles(component_version_id) on delete restrict,
  validation_run_id uuid not null references analysis.validation_runs(id) on delete restrict,
  provider text not null,
  speed text not null,
  rating_band_low integer not null,
  rating_band_high integer not null,
  supported boolean not null,
  unsupported_reason text,
  sample_size integer not null,
  top1_accuracy double precision,
  expected_calibration_error double precision,
  brier_score double precision,
  created_at timestamptz not null default now(),
  constraint model_calibration_slices_unique unique
    (calibration_component_version_id, provider, speed, rating_band_low),
  constraint model_calibration_slices_provider_check
    check (provider in ('lichess', 'chesscom')),
  constraint model_calibration_slices_speed_check
    check (speed in ('bullet', 'blitz', 'rapid', 'classical', 'correspondence')),
  constraint model_calibration_slices_band_ordered
    check (rating_band_low >= 100 and rating_band_high > rating_band_low and rating_band_high <= 4000),
  constraint model_calibration_slices_sample_non_negative check (sample_size >= 0),
  -- Supported means measured. Unsupported means explained. There is no third
  -- state where a slice is neither, because that is the state that gets read as
  -- support by the next person to write a query.
  constraint model_calibration_slices_evidence check (
    (supported and unsupported_reason is null
      and top1_accuracy is not null and expected_calibration_error is not null
      and brier_score is not null and sample_size > 0)
    or (not supported and unsupported_reason is not null)
  ),
  constraint model_calibration_slices_metric_range check (
    (top1_accuracy is null or top1_accuracy between 0 and 1)
    and (expected_calibration_error is null or expected_calibration_error between 0 and 1)
    and (brier_score is null or brier_score between 0 and 2)
  )
)
--> statement-breakpoint
comment on table analysis.model_calibration_slices is 'Per-slice calibration evidence for a human model, by provider, speed and rating band (platform spec 12.2 and 13). A slice absent from this table is unsupported by omission; a slice present with supported=false is unsupported on the record, with a reason. Both produce practical_context_status unavailable, never a Stockfish-derived substitute.'
--> statement-breakpoint
drop trigger if exists model_calibration_slices_immutable on analysis.model_calibration_slices
--> statement-breakpoint
create trigger model_calibration_slices_immutable
  before update or delete on analysis.model_calibration_slices
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- 16.3 — the practical counterplay contract
--
-- One row per objective assessment a run considered, whether or not a human
-- claim could be made about it. The unavailable row is as much the deliverable
-- of this epic as the available one.
-- ---------------------------------------------------------------------------
create table if not exists analysis.practical_context_assessments (
  id bigint generated always as identity primary key,
  transition_assessment_id bigint not null
    references analysis.transition_assessments(id) on delete restrict,
  analysis_run_id uuid not null references analysis.runs(id) on delete restrict,
  status text not null,
  unavailable_reason text,
  policy_inference_id bigint references analysis.model_inferences(id) on delete restrict,
  outcome_inference_id bigint references analysis.model_inferences(id) on delete restrict,
  calibration_slice_id uuid references analysis.model_calibration_slices(id) on delete restrict,
  pressure_method text,
  adequate_reply_count smallint,
  adequate_reply_probability numeric(9, 8),
  unretained_probability_mass numeric(9, 8),
  policy_entropy_bits numeric(8, 5),
  entropy_is_lower_bound boolean,
  best_refutation_uci text,
  best_refutation_probability numeric(9, 8),
  best_refutation_rank smallint,
  human_expected_score numeric(6, 5),
  out_of_domain boolean not null default false,
  -- Separate evidence (platform spec 12.2): what the opponent actually did and
  -- whether the subject used it. Null means not yet observable, not "no".
  opponent_conceded boolean,
  subject_capitalized boolean,
  created_at timestamptz not null default now(),
  -- Practical pressure is an interval, not a number, because the model's
  -- unretained mass could be adequate or could be anything. Reporting
  -- 1 - adequate_reply_probability alone silently assumes every move we did not
  -- keep was a losing one.
  practical_pressure_upper numeric(9, 8) generated always as
    (case when adequate_reply_probability is null then null
          else 1 - adequate_reply_probability end) stored,
  practical_pressure_lower numeric(9, 8) generated always as
    (case when adequate_reply_probability is null then null
          else greatest(0, 1 - adequate_reply_probability - coalesce(unretained_probability_mass, 0))
     end) stored,
  constraint practical_context_unique unique (analysis_run_id, transition_assessment_id),
  constraint practical_context_status_check check (status in ('available', 'unavailable')),
  -- Available means the whole vector is present. Unavailable means the whole
  -- vector is absent and a reason is present. A half-populated row is the shape
  -- a fabricated claim takes.
  constraint practical_context_available_shape check (
    (status = 'available'
      and unavailable_reason is null
      and policy_inference_id is not null
      and calibration_slice_id is not null
      and pressure_method is not null
      and adequate_reply_count is not null
      and adequate_reply_probability is not null
      and unretained_probability_mass is not null
      and policy_entropy_bits is not null
      and entropy_is_lower_bound is not null)
    or (status = 'unavailable'
      and unavailable_reason is not null
      and policy_inference_id is null
      and outcome_inference_id is null
      and calibration_slice_id is null
      and pressure_method is null
      and adequate_reply_count is null
      and adequate_reply_probability is null
      and unretained_probability_mass is null
      and policy_entropy_bits is null
      and entropy_is_lower_bound is null
      and best_refutation_uci is null
      and best_refutation_probability is null
      and best_refutation_rank is null
      and human_expected_score is null)
  ),
  constraint practical_context_ranges check (
    (adequate_reply_count is null or adequate_reply_count >= 0)
    and (adequate_reply_probability is null or adequate_reply_probability between 0 and 1)
    and (unretained_probability_mass is null or unretained_probability_mass between 0 and 1)
    and (policy_entropy_bits is null or policy_entropy_bits >= 0)
    and (best_refutation_probability is null or best_refutation_probability between 0 and 1)
    and (best_refutation_rank is null or best_refutation_rank between 1 and 256)
    and (human_expected_score is null or human_expected_score between 0 and 1)
  ),
  constraint practical_context_mass_sane check (
    adequate_reply_probability is null
    or adequate_reply_probability + unretained_probability_mass <= 1.000001
  ),
  -- The three refutation columns describe one move. Two of them without the
  -- third is a rank pointing at nothing.
  constraint practical_context_refutation_shape check (
    (best_refutation_uci is null) = (best_refutation_probability is null)
    and (best_refutation_probability is null) = (best_refutation_rank is null)
  ),
  constraint practical_context_refutation_uci_shape check (
    best_refutation_uci is null or best_refutation_uci ~ '^[a-h][1-8][a-h][1-8][qrbn]?$'
  ),
  constraint practical_context_method_shape check (
    pressure_method is null or pressure_method ~ '^[a-z][a-z0-9_]{2,63}$'
  ),
  constraint practical_context_reason_shape check (
    unavailable_reason is null or unavailable_reason in (
      'no_promoted_model', 'slice_not_calibrated', 'slice_unsupported',
      'context_incomplete', 'inference_failed', 'objective_candidates_missing',
      'model_withdrawn'
    )
  )
)
--> statement-breakpoint
comment on table analysis.practical_context_assessments is 'The practical counterplay vector for one objective transition assessment (database architecture 16.3, platform spec 12.2). Separate from the assessment so a human layer can be recomputed under a new calibration or withdrawn to unavailable without rewriting one objective row, which is what rollback without result overwrite has to mean here.'
--> statement-breakpoint
comment on column analysis.practical_context_assessments.practical_pressure_lower is 'The lower bound on 1 - adequate_reply_probability, obtained by assuming every move the model did not retain was adequate. Reporting only the upper bound assumes the opposite, and neither assumption is evidence.'
--> statement-breakpoint
comment on column analysis.practical_context_assessments.opponent_conceded is 'What the opponent actually did next. Separate evidence: an opponent failing later does not make an objectively bad move brilliant in retrospect (platform spec 12.2).'
--> statement-breakpoint
create index if not exists practical_context_run
  on analysis.practical_context_assessments (analysis_run_id, status)
--> statement-breakpoint
create index if not exists practical_context_assessment
  on analysis.practical_context_assessments (transition_assessment_id)
--> statement-breakpoint
drop trigger if exists practical_context_immutable on analysis.practical_context_assessments
--> statement-breakpoint
create trigger practical_context_immutable
  before update or delete on analysis.practical_context_assessments
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
-- An available row must cite a slice that is actually supported, and one that
-- describes the model whose inference it cites. Cross-checking this only in the
-- application is how a blitz slice ends up justifying a bullet claim.
create or replace function analysis.enforce_practical_context() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  slice_supported boolean;
  slice_model uuid;
  inference_model uuid;
  inference_kind text;
begin
  if new.status <> 'available' then
    return new;
  end if;

  select supported, model_component_version_id into slice_supported, slice_model
  from analysis.model_calibration_slices where id = new.calibration_slice_id;

  if slice_supported is null then
    raise exception 'calibration slice % does not exist', new.calibration_slice_id
      using errcode = 'foreign_key_violation';
  end if;

  if not slice_supported then
    raise exception
      'practical context cannot be available on calibration slice %, which is not supported',
      new.calibration_slice_id using errcode = 'check_violation';
  end if;

  select model_component_version_id, output_kind into inference_model, inference_kind
  from analysis.model_inferences where id = new.policy_inference_id;

  if inference_kind is distinct from 'human_policy' then
    raise exception 'practical context requires a human_policy inference, not %',
      coalesce(inference_kind, 'a missing inference') using errcode = 'check_violation';
  end if;

  if inference_model <> slice_model then
    raise exception
      'calibration slice % describes a different model than inference %',
      new.calibration_slice_id, new.policy_inference_id using errcode = 'check_violation';
  end if;

  if new.outcome_inference_id is not null then
    select output_kind into inference_kind
    from analysis.model_inferences where id = new.outcome_inference_id;
    if inference_kind is distinct from 'human_outcome' then
      raise exception 'outcome_inference_id must name a human_outcome inference, not %',
        coalesce(inference_kind, 'a missing inference') using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$
--> statement-breakpoint
comment on function analysis.enforce_practical_context() is 'An available practical context must cite a supported calibration slice for the same model that produced its policy inference (platform spec 12.2). Otherwise a slice calibrated for one provider, speed or model silently licenses a claim about another.'
--> statement-breakpoint
revoke all on function analysis.enforce_practical_context() from public
--> statement-breakpoint
drop trigger if exists practical_context_evidence on analysis.practical_context_assessments
--> statement-breakpoint
create trigger practical_context_evidence
  before insert on analysis.practical_context_assessments
  for each row execute function analysis.enforce_practical_context()
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Grants, matching E12's posture: the analysis worker writes, the API reads.
-- ---------------------------------------------------------------------------
grant select, insert on analysis.model_licence_reviews to forma_analysis
--> statement-breakpoint
grant select, insert on analysis.model_assets to forma_analysis
--> statement-breakpoint
grant select, insert on analysis.model_inferences to forma_analysis
--> statement-breakpoint
grant select, insert on analysis.model_move_probabilities to forma_analysis
--> statement-breakpoint
grant select, insert on analysis.model_agreement_assessments to forma_analysis
--> statement-breakpoint
grant select, insert on analysis.run_model_inference_uses to forma_analysis
--> statement-breakpoint
grant select, insert on analysis.model_calibration_slices to forma_analysis
--> statement-breakpoint
grant select, insert on analysis.practical_context_assessments to forma_analysis
--> statement-breakpoint
grant select on analysis.model_licence_reviews to forma_api
--> statement-breakpoint
grant select on analysis.model_assets to forma_api
--> statement-breakpoint
grant select on analysis.model_inferences to forma_api
--> statement-breakpoint
grant select on analysis.model_move_probabilities to forma_api
--> statement-breakpoint
grant select on analysis.model_agreement_assessments to forma_api
--> statement-breakpoint
grant select on analysis.run_model_inference_uses to forma_api
--> statement-breakpoint
grant select on analysis.model_calibration_slices to forma_api
--> statement-breakpoint
grant select on analysis.practical_context_assessments to forma_api

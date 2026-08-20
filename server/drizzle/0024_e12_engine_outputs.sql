-- 0024_e12_engine_outputs
--
-- E12 — isolated Stockfish screening, deep analysis, and cache scopes.
--
-- Hand-written and reviewed. Additive and forward-only: five new tables in the
-- `analysis` namespace, one widened check constraint on `ops.workflows`, and no
-- row rewritten, column dropped or table renamed. Re-running the file is a
-- no-op.
--
-- What this epic makes storable, and why the shape is what it is.
--
-- An engine result is only reusable if you can say exactly what it was computed
-- over. Database architecture §10.5 gives four scopes, and they are not a
-- quality ladder -- they are four different claims. A `core` result knows the
-- board and nothing about the clock or the history, so it is genuinely useful
-- for "what is this structure worth" and genuinely unusable as evidence that a
-- player threw away a draw that was one move from being claimable. That
-- distinction is enforced here rather than remembered: a transition assessment
-- may not cite a core-scoped evaluation, and the trigger says so.
--
-- The cache is anonymous by construction. `analysis.position_evaluations`
-- carries no subject, user, game or account column, which is what lets one
-- player's screening result answer another player's transposition without
-- either of them learning anything about the other. Runs link to evaluations
-- through `analysis.run_evaluation_uses`, so deleting a run removes the use and
-- leaves the anonymous entry alone. Occurrence-scoped rows are the deliberate
-- exception: they name a materialization run, they are not anonymous, and they
-- follow that occurrence's retention.
--
-- Uniqueness is stated twice on purpose. `cache_key` is unique, and so is the
-- natural tuple of every compatibility-relevant input. The key is what callers
-- look up by; the tuple is what stops a miscomputed key from silently splitting
-- one computation into two rows or, worse, letting two different computations
-- share one. `nulls not distinct` is required for the tuple index to mean
-- anything, because the scope qualifiers are null exactly when the scope does
-- not use them.

set local role forma_migrator
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- §15.1 — model profiles
--
-- A searchable projection over the component versions that are executable
-- engines or models. It is a projection and not a second identity: the primary
-- key *is* the component version, so a profile cannot exist for a version that
-- was never registered, and two profiles cannot disagree about one engine.
-- ---------------------------------------------------------------------------
create table if not exists analysis.model_profiles (
  component_version_id uuid primary key references analysis.component_versions(id) on delete restrict,
  role text not null,
  -- The executable's own identity. Separate columns rather than one blob
  -- because "which NNUE produced this" is a question an operator asks during an
  -- incident, not a field an archaeologist reconstructs from JSON.
  binary_sha256 text,
  weights_sha256 text,
  network_hash text,
  hardware_class text not null,
  -- Named contracts, in E11's vocabulary: what the profile must be given, and
  -- how its output is to be read.
  input_context_contract text not null,
  output_interpretation_contract text not null,
  licence_review_status text not null default 'pending',
  licence_note text,
  created_at timestamptz not null default now(),
  constraint model_profiles_role_check check (role in (
    'objective_engine', 'human_policy', 'human_outcome', 'secondary_oracle',
    'detector', 'embedding'
  )),
  constraint model_profiles_hardware_check
    check (hardware_class in ('cpu_engine', 'cpu_model', 'gpu_model')),
  constraint model_profiles_licence_check
    check (licence_review_status in ('pending', 'cleared', 'restricted', 'rejected')),
  constraint model_profiles_binary_shape
    check (binary_sha256 is null or binary_sha256 ~ '^[0-9a-f]{64}$'),
  constraint model_profiles_weights_shape
    check (weights_sha256 is null or weights_sha256 ~ '^[0-9a-f]{64}$'),
  constraint model_profiles_network_shape
    check (network_hash is null or network_hash ~ '^[0-9a-f]{8,64}$'),
  constraint model_profiles_contract_shape check (
    input_context_contract ~ '^[a-z][a-z0-9_.]{2,95}$'
    and output_interpretation_contract ~ '^[a-z][a-z0-9_.]{2,95}$'
  )
)
--> statement-breakpoint
comment on table analysis.model_profiles is 'The executable engines and models, projected over their component versions (database architecture 15.1). The primary key is the component version, so a profile cannot describe an engine nobody registered and two rows cannot disagree about one binary. licence_review_status is a state and not an assumption: platform spec 12.1 forbids promoting Maia-family weights before review, and a column is how that survives a handover.'
--> statement-breakpoint
comment on column analysis.model_profiles.role is 'What this executable is for. An objective_engine may write analysis.position_evaluations; a human_policy or human_outcome model may not, which is how Maia WDL is kept out of objective WDL columns (database architecture 15.4).'
--> statement-breakpoint
create index if not exists model_profiles_role on analysis.model_profiles (role, licence_review_status)
--> statement-breakpoint
drop trigger if exists model_profiles_immutable on analysis.model_profiles
--> statement-breakpoint
create trigger model_profiles_immutable
  before update or delete on analysis.model_profiles
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- §15.2 — position evaluations
--
-- One immutable objective engine result, and the reusable cache in one table.
-- There is no separate "cache" table because there is no separate thing: an
-- evaluation is reusable exactly when another request presents identical
-- inputs, and that is what the key says.
-- ---------------------------------------------------------------------------
create table if not exists analysis.position_evaluations (
  id bigint generated always as identity primary key,
  core_position_id bigint not null references chess.core_positions(id) on delete restrict,
  scope text not null,
  -- The scope's qualifiers. Null exactly when the scope does not use them,
  -- which the check constraints below make structural rather than conventional.
  halfmove_clock integer,
  history_signature text,
  occurrence_run_id uuid,
  occurrence_ply integer,
  model_profile_id uuid not null
    references analysis.model_profiles(component_version_id) on delete restrict,
  -- The calibration that turned the engine's output into expected_score. Part
  -- of the cache key: a different curve is a different number, so it must be a
  -- different row rather than a silent reinterpretation of an old one.
  calibration_component_version_id uuid not null
    references analysis.component_versions(id) on delete restrict,
  limit_type text not null,
  limit_value integer not null,
  multipv smallint not null,
  threads smallint not null,
  hash_mb integer not null,
  tablebase boolean not null default false,
  perspective text not null default 'white',
  score_cp integer,
  mate_in integer,
  wdl_win smallint,
  wdl_draw smallint,
  wdl_loss smallint,
  expected_score numeric(6, 5) not null,
  expected_score_method text not null,
  best_move_uci text,
  depth smallint,
  seldepth smallint,
  nodes bigint,
  nps bigint,
  engine_time_ms integer,
  wall_time_ms integer,
  -- Which worker build produced it. Provenance, not routing: platform spec §6.4
  -- requires the worker revision alongside the binary and network hashes.
  worker_revision text not null,
  cache_key text not null,
  computed_at timestamptz not null default now(),
  constraint position_evaluations_scope_check
    check (scope in ('core', 'rule50', 'history_exact', 'occurrence')),
  constraint position_evaluations_limit_type_check
    check (limit_type in ('nodes', 'depth', 'movetime')),
  constraint position_evaluations_perspective_check check (perspective in ('white', 'black')),
  constraint position_evaluations_cache_key_shape check (cache_key ~ '^[0-9a-f]{64}$'),
  constraint position_evaluations_history_shape
    check (history_signature is null or history_signature ~ '^[0-9a-f]{64}$'),
  constraint position_evaluations_bounds_check check (
    limit_value > 0 and multipv between 1 and 32 and threads between 1 and 64
    and hash_mb between 1 and 32768
  ),
  constraint position_evaluations_counters_check check (
    (halfmove_clock is null or halfmove_clock >= 0)
    and (occurrence_ply is null or occurrence_ply >= 0)
    and (nodes is null or nodes >= 0) and (nps is null or nps >= 0)
    and (engine_time_ms is null or engine_time_ms >= 0)
    and (wall_time_ms is null or wall_time_ms >= 0)
    and (depth is null or depth >= 0) and (seldepth is null or seldepth >= 0)
  ),
  -- §10.5's scopes, as structure. A core evaluation that carried a clock would
  -- be claiming to be something it is not, and an occurrence-scoped row without
  -- an occurrence would be an anonymous row pretending to be specific.
  constraint position_evaluations_scope_shape check (
    (halfmove_clock is null) = (scope = 'core')
    and (history_signature is null) = (scope in ('core', 'rule50'))
    and (occurrence_run_id is null) = (scope <> 'occurrence')
    and (occurrence_ply is null) = (scope <> 'occurrence')
  ),
  -- §15.2: "exactly one of centipawn or mate representation".
  constraint position_evaluations_value_check
    check ((score_cp is null) <> (mate_in is null)),
  -- §15.2: WDL members are non-negative and normalized. All three or none:
  -- two thirds of a triplet is not a partial answer, it is a corrupt one.
  constraint position_evaluations_wdl_shape check (
    (wdl_win is null) = (wdl_draw is null) and (wdl_draw is null) = (wdl_loss is null)
  ),
  constraint position_evaluations_wdl_normalized check (
    wdl_win is null or (
      wdl_win >= 0 and wdl_draw >= 0 and wdl_loss >= 0
      and wdl_win + wdl_draw + wdl_loss = 1000
    )
  ),
  constraint position_evaluations_expected_score_range
    check (expected_score >= 0 and expected_score <= 1),
  constraint position_evaluations_expected_method_check
    check (expected_score_method in ('wdl', 'mate', 'logistic')),
  -- A `wdl` expected score without a WDL triplet is a number whose stated
  -- provenance is false.
  constraint position_evaluations_expected_method_supported check (
    (expected_score_method = 'wdl') = (wdl_win is not null)
    and (expected_score_method <> 'mate' or mate_in is not null)
    and (expected_score_method <> 'logistic' or score_cp is not null)
  ),
  constraint position_evaluations_best_move_shape
    check (best_move_uci is null or best_move_uci ~ '^[a-h][1-8][a-h][1-8][qrbn]?$'),
  constraint position_evaluations_occurrence_fk
    foreign key (occurrence_run_id, occurrence_ply)
    references chess.position_occurrences(run_id, ply) on delete cascade
)
--> statement-breakpoint
comment on table analysis.position_evaluations is 'One immutable objective engine result, and the reusable cache in the same table (database architecture 15.2). It carries no subject, user, game or account column: that absence is what makes an entry shareable across players. Occurrence-scoped rows are the deliberate exception -- they name a materialization run, are not anonymous, and cascade with the occurrence they belong to.'
--> statement-breakpoint
comment on column analysis.position_evaluations.scope is 'What this result was computed over (database architecture 10.5). Not a quality ladder: core is history-free and reusable across transpositions but may never be cited as exact evidence about an occurrence, which analysis.enforce_assessment_evidence() enforces.'
--> statement-breakpoint
comment on column analysis.position_evaluations.cache_key is 'The deterministic identity of this computation. Unique, and shadowed by a unique index over the natural tuple, so a miscomputed key cannot split one computation into two rows or let two different computations share one.'
--> statement-breakpoint
comment on column analysis.position_evaluations.expected_score is 'White''s expected points, by the calibration this row pins. Stored rather than derived on read because the curve is versioned: recomputing it later with a newer calibration would silently restate what a published run concluded.'
--> statement-breakpoint
-- The lookup every screening and deep search performs first.
create unique index if not exists position_evaluations_cache_key
  on analysis.position_evaluations (cache_key)
--> statement-breakpoint
-- The same claim, stated over the columns themselves. `nulls not distinct`
-- because the scope qualifiers are null exactly when the scope does not use
-- them, and the default null-distinct semantics would make every core row
-- unique regardless of its inputs.
create unique index if not exists position_evaluations_inputs
  on analysis.position_evaluations (
    core_position_id, scope, halfmove_clock, history_signature, occurrence_run_id,
    occurrence_ply, model_profile_id, calibration_component_version_id, limit_type,
    limit_value, multipv, threads, hash_mb, tablebase, perspective
  ) nulls not distinct
--> statement-breakpoint
-- "Every evaluation of this position, whatever scope" -- the transposition
-- lookup behind exact position retrieval (database architecture 11.1).
create index if not exists position_evaluations_by_core
  on analysis.position_evaluations (core_position_id, model_profile_id, scope)
--> statement-breakpoint
create index if not exists position_evaluations_occurrence
  on analysis.position_evaluations (occurrence_run_id, occurrence_ply)
  where occurrence_run_id is not null
--> statement-breakpoint
create index if not exists position_evaluations_calibration
  on analysis.position_evaluations (calibration_component_version_id)
--> statement-breakpoint
-- Leads with the profile so "everything this engine version produced" is a
-- range scan, which is what a profile retirement or a shadow comparison walks.
-- It is also the index the profile foreign key needs; the two indexes above
-- both lead with the core position and would leave it unserved.
create index if not exists position_evaluations_profile
  on analysis.position_evaluations (model_profile_id, computed_at desc)
--> statement-breakpoint
drop trigger if exists position_evaluations_immutable on analysis.position_evaluations
--> statement-breakpoint
-- Update only, unlike E11's version tables. An evaluation must never be
-- *restated* -- that is the immutability this epic needs -- but an
-- occurrence-scoped row has to be able to disappear with the occurrence it
-- belongs to, and a BEFORE DELETE trigger fires on a cascade too, so refusing
-- delete here would make `chess.position_occurrences` undeletable. Deletion is
-- withheld by grant instead: no runtime role holds it, which is the control
-- that actually applies to a compromised process.
create trigger position_evaluations_immutable
  before update on analysis.position_evaluations
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- §15.2 again — an objective evaluation may only come from an objective engine
--
-- The role lives on the profile, so without this a human-policy profile could
-- be written into the objective columns and Maia's human WDL would become
-- Stockfish's objective WDL. Database architecture §15.4 forbids exactly that,
-- and a foreign key cannot express it.
-- ---------------------------------------------------------------------------
create or replace function analysis.enforce_objective_engine() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  profile_role text;
begin
  select role into profile_role from analysis.model_profiles
   where component_version_id = new.model_profile_id;
  if profile_role is distinct from 'objective_engine' then
    raise exception 'analysis.position_evaluations accepts objective_engine profiles only, not %',
      coalesce(profile_role, 'an unregistered profile')
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$
--> statement-breakpoint
comment on function analysis.enforce_objective_engine() is 'Keeps human-policy and human-outcome output out of the objective evaluation columns (database architecture 15.4). Maia WDL is a human-outcome claim; storing it here would make it read as objective truth.'
--> statement-breakpoint
revoke all on function analysis.enforce_objective_engine() from public
--> statement-breakpoint
drop trigger if exists position_evaluations_objective on analysis.position_evaluations
--> statement-breakpoint
create trigger position_evaluations_objective
  before insert on analysis.position_evaluations
  for each row execute function analysis.enforce_objective_engine()
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- §15.3 — MultiPV candidates
-- ---------------------------------------------------------------------------
create table if not exists analysis.evaluation_candidates (
  position_evaluation_id bigint not null
    references analysis.position_evaluations(id) on delete cascade,
  rank smallint not null,
  uci text not null,
  score_cp integer,
  mate_in integer,
  wdl_win smallint,
  wdl_draw smallint,
  wdl_loss smallint,
  expected_score numeric(6, 5) not null,
  expected_score_method text not null,
  -- Ordered JSONB because a principal variation is replayed, not searched:
  -- §15.3 is explicit that this is a sequence, so it is stored as one rather
  -- than exploded into rows nothing ever queries individually.
  pv jsonb not null default '[]'::jsonb,
  nodes bigint,
  visits bigint,
  primary key (position_evaluation_id, rank),
  constraint evaluation_candidates_rank_check check (rank between 1 and 32),
  constraint evaluation_candidates_uci_shape check (uci ~ '^[a-h][1-8][a-h][1-8][qrbn]?$'),
  constraint evaluation_candidates_value_check check ((score_cp is null) <> (mate_in is null)),
  constraint evaluation_candidates_wdl_shape check (
    (wdl_win is null) = (wdl_draw is null) and (wdl_draw is null) = (wdl_loss is null)
  ),
  constraint evaluation_candidates_wdl_normalized check (
    wdl_win is null or (
      wdl_win >= 0 and wdl_draw >= 0 and wdl_loss >= 0
      and wdl_win + wdl_draw + wdl_loss = 1000
    )
  ),
  constraint evaluation_candidates_expected_range
    check (expected_score >= 0 and expected_score <= 1),
  constraint evaluation_candidates_expected_method_check
    check (expected_score_method in ('wdl', 'mate', 'logistic')),
  constraint evaluation_candidates_pv_shape check (jsonb_typeof(pv) = 'array'),
  constraint evaluation_candidates_counters_check
    check ((nodes is null or nodes >= 0) and (visits is null or visits >= 0))
)
--> statement-breakpoint
comment on table analysis.evaluation_candidates is 'One retained MultiPV line of one evaluation (database architecture 15.3). The unique move index is what makes an adequate-move count a count of distinct moves rather than of lines the engine happened to emit twice.'
--> statement-breakpoint
create unique index if not exists evaluation_candidates_move
  on analysis.evaluation_candidates (position_evaluation_id, uci)
--> statement-breakpoint
drop trigger if exists evaluation_candidates_immutable on analysis.evaluation_candidates
--> statement-breakpoint
-- Update only, for the same reason as the evaluation it hangs from: the rows
-- cascade with their evaluation, and a trigger that refused that cascade would
-- turn one retention rule into a foreign key violation.
create trigger evaluation_candidates_immutable
  before update on analysis.evaluation_candidates
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- §15.2 — run uses
--
-- "Reusable evaluations do not reference the run that first requested them."
-- The link lives here instead, with the typed role the evaluation played, so
-- deleting a run removes the use row and leaves the anonymous cache entry.
-- ---------------------------------------------------------------------------
create table if not exists analysis.run_evaluation_uses (
  run_id uuid not null references analysis.runs(id) on delete cascade,
  position_evaluation_id bigint not null
    references analysis.position_evaluations(id) on delete restrict,
  input_role text not null,
  recorded_at timestamptz not null default now(),
  primary key (run_id, position_evaluation_id, input_role),
  constraint run_evaluation_uses_role_check check (input_role in (
    'transition_before', 'transition_after', 'deep_multipv', 'interactive'
  ))
)
--> statement-breakpoint
comment on table analysis.run_evaluation_uses is 'Which cached evaluations a run read, and in what role (database architecture 15.2). on delete cascade from the run and on delete restrict to the evaluation is the asymmetry the spec asks for: removing a run must not remove an entry other runs and other players still share.'
--> statement-breakpoint
create index if not exists run_evaluation_uses_evaluation
  on analysis.run_evaluation_uses (position_evaluation_id)
--> statement-breakpoint
drop trigger if exists run_evaluation_uses_immutable on analysis.run_evaluation_uses
--> statement-breakpoint
-- Update is refused; delete is not, because the cascade from a deleted run has
-- to be able to run. `analysis.refuse_mutation` refuses both, so this table
-- gets a trigger scoped to update alone.
create trigger run_evaluation_uses_immutable
  before update on analysis.run_evaluation_uses
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- §16.1 — transition assessments
--
-- The objective assessment of every transition, independent of any subject.
-- Perspective belongs here rather than on the evaluation: an evaluation is a
-- fact about a position and is stored from White's side, and "the actor lost
-- this much" is a statement about a decision.
-- ---------------------------------------------------------------------------
create table if not exists analysis.transition_assessments (
  id bigint generated always as identity primary key,
  -- Restrict, matching E11's run_artifacts and run_dependencies: an assessment
  -- is the claim a publication cites, so a run cannot be removed while one
  -- exists. E21 owns deletion and will remove these first, deliberately.
  analysis_run_id uuid not null references analysis.runs(id) on delete restrict,
  -- E09 identifies a transition by (materialization run, from_ply); the
  -- composite foreign key is what keeps this pointing at a real one.
  materialization_run_id uuid not null,
  from_ply integer not null,
  before_evaluation_id bigint not null
    references analysis.position_evaluations(id) on delete restrict,
  after_evaluation_id bigint not null
    references analysis.position_evaluations(id) on delete restrict,
  -- Set when the position was selected for a deeper look and the look
  -- succeeded. deep_status carries the rest of the story.
  deep_evaluation_id bigint references analysis.position_evaluations(id) on delete restrict,
  deep_status text not null default 'not_selected',
  deep_selection_reasons jsonb not null default '[]'::jsonb,
  actor_color text not null,
  played_move_uci text not null,
  best_move_uci text,
  played_move_rank smallint,
  expected_score_before numeric(6, 5) not null,
  expected_score_after numeric(6, 5) not null,
  -- Generated, so it cannot disagree with the two numbers it is derived from.
  decision_loss numeric(7, 5) generated always as
    (expected_score_before - expected_score_after) stored,
  tolerance_component_version_id uuid not null
    references analysis.component_versions(id) on delete restrict,
  played_move_acceptable boolean not null,
  -- Null when the search returned one line: a one-line search never looked at
  -- an alternative, so "how many were adequate" has no answer and inventing one
  -- is how a screening result gets quoted as if it were a deep one.
  acceptable_move_count smallint,
  only_move boolean,
  criticality numeric(6, 5),
  difficulty_features jsonb not null default '{}'::jsonb,
  phase text,
  phase_confidence numeric(4, 3),
  created_at timestamptz not null default now(),
  constraint transition_assessments_transition_fk
    foreign key (materialization_run_id, from_ply)
    references chess.position_transitions(run_id, from_ply) on delete restrict,
  constraint transition_assessments_unique unique (analysis_run_id, materialization_run_id, from_ply),
  constraint transition_assessments_actor_check check (actor_color in ('white', 'black')),
  constraint transition_assessments_played_shape
    check (played_move_uci ~ '^[a-h][1-8][a-h][1-8][qrbn]?$'),
  constraint transition_assessments_best_shape
    check (best_move_uci is null or best_move_uci ~ '^[a-h][1-8][a-h][1-8][qrbn]?$'),
  constraint transition_assessments_rank_check
    check (played_move_rank is null or played_move_rank between 1 and 32),
  constraint transition_assessments_expected_range check (
    expected_score_before between 0 and 1 and expected_score_after between 0 and 1
  ),
  constraint transition_assessments_deep_status_check
    check (deep_status in ('not_selected', 'selected', 'completed', 'unavailable')),
  -- A deep evaluation exists exactly when the deeper look completed. Any other
  -- combination is a row claiming something it cannot show.
  constraint transition_assessments_deep_shape
    check ((deep_evaluation_id is not null) = (deep_status = 'completed')),
  constraint transition_assessments_reasons_shape
    check (jsonb_typeof(deep_selection_reasons) = 'array'),
  constraint transition_assessments_features_shape
    check (jsonb_typeof(difficulty_features) = 'object'),
  -- The three candidate-derived columns are answerable together or not at all.
  constraint transition_assessments_candidate_shape check (
    (acceptable_move_count is null) = (only_move is null)
    and (only_move is null) = (criticality is null)
  ),
  constraint transition_assessments_candidate_range check (
    (acceptable_move_count is null or acceptable_move_count >= 1)
    and (criticality is null or criticality between 0 and 1)
  ),
  constraint transition_assessments_phase_check
    check (phase is null or phase in ('opening', 'middlegame', 'endgame')),
  -- A confidence needs a phase to be about; a phase does not need a
  -- confidence. E12's phase classifier is deterministic and reports a phase,
  -- not a probability, so it writes the phase and leaves this null rather than
  -- manufacturing a number. A later probabilistic classifier can fill it.
  constraint transition_assessments_phase_confidence check (
    (phase_confidence is null or phase is not null)
    and (phase_confidence is null or phase_confidence between 0 and 1)
  )
)
--> statement-breakpoint
comment on table analysis.transition_assessments is 'The objective assessment of one transition under one run (database architecture 16.1). "Good", "mistake" and "blunder" are deliberately absent: 16.1 makes them optional versioned presentation classifications derived from measurements, and this table stores the measurement -- decision loss against a pinned tolerance rule, with the candidate-derived columns null when the search that produced them had one line.'
--> statement-breakpoint
comment on column analysis.transition_assessments.decision_loss is 'Actor-perspective expected score given up by the move played. Generated from the two columns above so the three can never disagree. Negative values are legitimate: a screening search can rate the played move above its own best line, and clamping that to zero would hide search noise instead of recording it.'
--> statement-breakpoint
comment on column analysis.transition_assessments.deep_status is 'Whether this position was selected for deeper MultiPV and what came of it. unavailable is the honest state after an engine failure or an exhausted budget -- the screening evidence stands, and the fact that a closer look was wanted and not obtained stays visible.'
--> statement-breakpoint
create index if not exists transition_assessments_by_run
  on analysis.transition_assessments (analysis_run_id, from_ply)
--> statement-breakpoint
create index if not exists transition_assessments_transition
  on analysis.transition_assessments (materialization_run_id, from_ply)
--> statement-breakpoint
create index if not exists transition_assessments_before_eval
  on analysis.transition_assessments (before_evaluation_id)
--> statement-breakpoint
create index if not exists transition_assessments_after_eval
  on analysis.transition_assessments (after_evaluation_id)
--> statement-breakpoint
create index if not exists transition_assessments_deep_eval
  on analysis.transition_assessments (deep_evaluation_id)
  where deep_evaluation_id is not null
--> statement-breakpoint
create index if not exists transition_assessments_tolerance
  on analysis.transition_assessments (tolerance_component_version_id)
--> statement-breakpoint
drop trigger if exists transition_assessments_immutable on analysis.transition_assessments
--> statement-breakpoint
create trigger transition_assessments_immutable
  before update or delete on analysis.transition_assessments
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- The compatibility rule, enforced.
--
-- This is the epic's central claim -- "all published transitions have
-- compatible before/after objective evidence" -- and it is the one thing a
-- foreign key cannot say. Three conditions:
--
--   1. Neither cited evaluation is core-scoped. A core result is history-free
--      and cannot be exact evidence about an occurrence (§10.5).
--   2. Before and after came from the same profile under the same search limit
--      and the same calibration. Subtracting a 500k-node number from a 50k-node
--      one produces a "decision loss" that is mostly the difference between two
--      searches.
--   3. A deep evaluation, when present, is of the same position as the before
--      evaluation and used at least the before evaluation's MultiPV. It is
--      meant to be a closer look at the same decision, not a different one.
-- ---------------------------------------------------------------------------
create or replace function analysis.enforce_assessment_evidence() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  before_row analysis.position_evaluations%rowtype;
  after_row analysis.position_evaluations%rowtype;
  deep_row analysis.position_evaluations%rowtype;
begin
  select * into before_row from analysis.position_evaluations where id = new.before_evaluation_id;
  select * into after_row from analysis.position_evaluations where id = new.after_evaluation_id;

  if before_row.scope = 'core' or after_row.scope = 'core' then
    raise exception 'a transition assessment may not cite a core-scoped evaluation as exact evidence'
      using errcode = 'restrict_violation';
  end if;

  if before_row.model_profile_id <> after_row.model_profile_id
     or before_row.calibration_component_version_id <> after_row.calibration_component_version_id
     or before_row.limit_type <> after_row.limit_type
     or before_row.limit_value <> after_row.limit_value
     or before_row.threads <> after_row.threads
     or before_row.hash_mb <> after_row.hash_mb
     or before_row.tablebase <> after_row.tablebase
     or before_row.perspective <> after_row.perspective then
    raise exception 'before and after evidence must come from the same profile, limit and calibration'
      using errcode = 'restrict_violation';
  end if;

  if new.deep_evaluation_id is not null then
    select * into deep_row from analysis.position_evaluations where id = new.deep_evaluation_id;
    if deep_row.core_position_id <> before_row.core_position_id then
      raise exception 'a deep evaluation must be of the position the decision was made in'
        using errcode = 'restrict_violation';
    end if;
    if deep_row.scope = 'core' then
      raise exception 'a deep evaluation may not be core-scoped'
        using errcode = 'restrict_violation';
    end if;
    if deep_row.multipv < before_row.multipv then
      raise exception 'a deep evaluation must retain at least as many lines as the screening one'
        using errcode = 'restrict_violation';
    end if;
  end if;

  return new;
end;
$$
--> statement-breakpoint
comment on function analysis.enforce_assessment_evidence() is 'The compatibility rule of database architecture 16.1: before and after evidence share a profile, limit and calibration, neither is core-scoped, and a deep evaluation is a closer look at the same position. Without it a decision loss can be the difference between two searches rather than between two moves.'
--> statement-breakpoint
revoke all on function analysis.enforce_assessment_evidence() from public
--> statement-breakpoint
drop trigger if exists transition_assessments_evidence on analysis.transition_assessments
--> statement-breakpoint
create trigger transition_assessments_evidence
  before insert on analysis.transition_assessments
  for each row execute function analysis.enforce_assessment_evidence()
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- One widened check constraint on ops.workflows.
--
-- API contract §14's bounded interactive evaluation is a durable operation with
-- an owner and a work item, so it is a workflow; it is not a game analysis, and
-- labelling it one would make "how many game analyses ran today" wrong. The
-- constraint is widened, never narrowed, so no existing row is invalidated and
-- re-applying the file is a no-op.
-- ---------------------------------------------------------------------------
alter table ops.workflows drop constraint if exists workflows_kind_check
--> statement-breakpoint
alter table ops.workflows add constraint workflows_kind_check
  check (kind in (
    'account_sync', 'game_import', 'initial_examination', 'game_analysis',
    'model_backfill', 'subject_estimation', 'maintenance', 'position_evaluation'
  ))
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Tenancy.
--
-- The evaluation cache and the profile catalogue carry no subject and are
-- protected by grants: that is the point of an anonymous cache, and a row-level
-- owner policy on a table with no owner column could only be a lie.
--
-- Transition assessments and run uses belong to a run, which belongs to a
-- subject, so they get E11's forced owner policy: defence in depth behind an
-- API that already takes the owner as an argument.
-- ---------------------------------------------------------------------------
alter table analysis.transition_assessments enable row level security
--> statement-breakpoint
alter table analysis.transition_assessments force row level security
--> statement-breakpoint
drop policy if exists transition_assessments_owner on analysis.transition_assessments
--> statement-breakpoint
create policy transition_assessments_owner on analysis.transition_assessments
  using (
    exists (
      select 1 from analysis.runs r
      join app.analysis_subjects s on s.id = r.subject_id
      where r.id = analysis_run_id and s.owner_user_id = private.current_actor_id()
    )
  )
  with check (
    exists (
      select 1 from analysis.runs r
      join app.analysis_subjects s on s.id = r.subject_id
      where r.id = analysis_run_id and s.owner_user_id = private.current_actor_id()
    )
  )
--> statement-breakpoint
alter table analysis.run_evaluation_uses enable row level security
--> statement-breakpoint
alter table analysis.run_evaluation_uses force row level security
--> statement-breakpoint
drop policy if exists run_evaluation_uses_owner on analysis.run_evaluation_uses
--> statement-breakpoint
create policy run_evaluation_uses_owner on analysis.run_evaluation_uses
  using (
    exists (
      select 1 from analysis.runs r
      join app.analysis_subjects s on s.id = r.subject_id
      where r.id = run_id and s.owner_user_id = private.current_actor_id()
    )
  )
  with check (
    exists (
      select 1 from analysis.runs r
      join app.analysis_subjects s on s.id = r.subject_id
      where r.id = run_id and s.owner_user_id = private.current_actor_id()
    )
  )
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Grants.
--
-- forma_stockfish is the only role that writes evaluations, and it writes
-- nothing else: platform spec §6.4 gives it Stockfish processes and objective
-- analysis only, and E02 withholds `private.set_actor_context` from it, so it
-- could not exercise a grant on a subject-scoped table even if one existed.
-- That is why it has no grant on transition assessments or run uses -- those
-- rows belong to a subject, and the role that writes them is forma_analysis.
--
-- forma_api reads. It cannot write an evaluation, an assessment or a use, so a
-- compromised browser-facing process cannot manufacture evidence.
-- ---------------------------------------------------------------------------
-- The one widened grant on an existing table. API contract §14's interactive
-- evaluation validates a client FEN and interns it as a core position, because
-- otherwise the only durable handle for the request would be the board itself
-- and it would have to travel through the work ledger. A core position is an
-- anonymous board arrangement with no owner and a content-addressed unique key,
-- so interning one is idempotent and reveals nothing; the evaluation it leads
-- to is still written by the engine role, not by the API.
grant insert on chess.core_positions to forma_api
--> statement-breakpoint
-- The analysis worker is the first deployment that writes subject-scoped
-- analysis rows on the real path, and E11's owner policies are expressed as
-- `exists (select 1 from app.analysis_subjects ...)`. A policy expression runs
-- with the invoking role's privileges, so without select here the worker could
-- not satisfy a policy it is bound to satisfy -- and the alternative would have
-- been a permissive worker policy, which is a tenancy claim withdrawn rather
-- than met. Read-only, and the subject table's own owner policy still applies,
-- so a worker bound to one owner sees exactly that owner's subjects.
grant select on app.analysis_subjects to forma_analysis
--> statement-breakpoint
-- The API plans a game analysis when a user asks for one (API contract §7), so
-- it needs to create the run row that makes planning idempotent. Insert only:
-- it cannot record an artifact, so it cannot make a run succeed, and it cannot
-- publish or promote. The forced owner policy on analysis.runs restricts it
-- further to subjects the bound actor owns, so the widest thing a compromised
-- API process can do here is create a planned run for its own caller.
grant insert on analysis.runs to forma_api
--> statement-breakpoint
grant select, insert on analysis.model_profiles to forma_analysis, forma_ops
--> statement-breakpoint
grant select on analysis.model_profiles to forma_api, forma_stockfish
--> statement-breakpoint
grant select, insert on analysis.position_evaluations to forma_stockfish, forma_analysis
--> statement-breakpoint
grant select on analysis.position_evaluations to forma_api, forma_ops
--> statement-breakpoint
grant select, insert on analysis.evaluation_candidates to forma_stockfish, forma_analysis
--> statement-breakpoint
grant select on analysis.evaluation_candidates to forma_api, forma_ops
--> statement-breakpoint
grant select, insert on analysis.run_evaluation_uses to forma_analysis
--> statement-breakpoint
grant select on analysis.run_evaluation_uses to forma_api, forma_ops
--> statement-breakpoint
grant select, insert on analysis.transition_assessments to forma_analysis
--> statement-breakpoint
grant select on analysis.transition_assessments to forma_api, forma_ops
--> statement-breakpoint
revoke all on analysis.model_profiles, analysis.position_evaluations from public
--> statement-breakpoint
revoke all on analysis.evaluation_candidates, analysis.run_evaluation_uses from public
--> statement-breakpoint
revoke all on analysis.transition_assessments from public
--> statement-breakpoint
reset role

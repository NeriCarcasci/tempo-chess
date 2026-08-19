-- 0022_e11_analysis_versions
--
-- E11 — component/recipe versions, frozen snapshots, runs, and publication.
--
-- Hand-written and reviewed. Additive and forward-only: new tables in the
-- `analysis` namespace, one new history table in `chess`, two unique
-- constraints added to existing tables so a composite foreign key can exist,
-- and one backfill that records the publications E09 already made. Nothing is
-- dropped, renamed, or rewritten, and re-running the file is a no-op.
--
-- What this epic is for: an analytical result is only evidence if you can say
-- exactly what produced it. So every derived output here pins its inputs by
-- identity rather than by description -- the component versions, the recipe
-- manifest, the exact replay revision and materialization run of every game in
-- a frozen snapshot -- and those pins are immutable rows, enforced by triggers
-- rather than by convention. A method change is a new version, a new recipe, a
-- new run. It is never an edit.
--
-- Publication is a pointer move guarded by a lock, and every move appends to a
-- history table carrying the old run, the new run, the actor and the reason.
-- Rollback is another append that restores the earlier run: history is never
-- rewritten, so "we reverted" stays a visible fact.
--
-- One asymmetry is deliberate. Database architecture §13.4 names three
-- publication targets. Two of them -- subject-live and subject-game -- get a
-- current-pointer table and a history table here, because no pointer existed.
-- The third, replay materialization, already has its pointer: E09's
-- `chess.materialization_runs.state = 'published'`, made single by a partial
-- unique index. Adding a second current-pointer table beside it would create
-- two rows that must agree about one fact, which is worse than the asymmetry.
-- So materialization gains only the history table it was missing, and the
-- existing published runs are backfilled into it.

set local role forma_migrator
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Immutability, enforced.
--
-- §12.2 and §13.4 both rest on rows that cannot change under a pointer that
-- cites them. A comment saying "immutable" is not that; a trigger is.
-- ---------------------------------------------------------------------------
create or replace function analysis.refuse_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '%.% is immutable; append a new row instead', tg_table_schema, tg_table_name
    using errcode = 'restrict_violation';
end;
$$
--> statement-breakpoint
comment on function analysis.refuse_mutation() is 'Refuses update and delete on the immutable version, manifest and history tables (database architecture 12, 13.4). A method change is a new version; a pointer change is a new history row.'
--> statement-breakpoint
revoke all on function analysis.refuse_mutation() from public
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- §12.1–12.3 — components, versions, and the dependency DAG
-- ---------------------------------------------------------------------------
create table if not exists analysis.components (
  id uuid primary key default gen_random_uuid(),
  component_key text not null,
  category text not null,
  description text not null,
  -- Named contracts, not schemas. A dependency is compatible when the producer
  -- emits the contract the consumer declares it needs; the shape behind the
  -- name is owned by the epic that implements the method.
  input_contract text not null,
  output_contract text not null,
  created_at timestamptz not null default now(),
  constraint components_key_unique unique (component_key),
  constraint components_key_shape check (component_key ~ '^[a-z][a-z0-9_]{2,63}$'),
  constraint components_category_check check (category in (
    'normalizer', 'materializer', 'canonicalizer', 'engine_profile', 'human_policy',
    'calibration', 'phase_detector', 'feature_extractor', 'event_detector',
    'concept_model', 'estimator', 'trajectory_aligner', 'finding_rules', 'renderer',
    'projection'
  )),
  constraint components_contract_shape check (
    input_contract ~ '^[a-z][a-z0-9_.]{2,95}$' and output_contract ~ '^[a-z][a-z0-9_.]{2,95}$'
  )
)
--> statement-breakpoint
comment on table analysis.components is 'The catalogue of replaceable analytical responsibilities (database architecture 12.1). A category is a role in the pipeline, not an implementation: Stockfish and Lc0 are both engine_profile, and swapping them is a component version. Rows are immutable, including the description -- it is part of what a published run cited, and editing it under that citation is the silent rewrite this epic exists to prevent.'
--> statement-breakpoint
drop trigger if exists components_immutable on analysis.components
--> statement-breakpoint
create trigger components_immutable
  before update or delete on analysis.components
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
create table if not exists analysis.component_versions (
  id uuid primary key default gen_random_uuid(),
  component_id uuid not null references analysis.components(id) on delete restrict,
  version text not null,
  -- The implementation itself: source tree, binary, or model weights.
  implementation_sha256 text not null,
  configuration jsonb not null default '{}'::jsonb,
  configuration_hash text not null,
  -- Content hash over key, version, implementation, configuration and model
  -- identity. Two rows with this value are the same version, which is what
  -- makes registration idempotent instead of forking history on a retry.
  content_hash text not null,
  model_identity jsonb,
  licence text,
  provenance text,
  -- False for anything whose output can differ between two identical runs, such
  -- as a time-limited engine search. Recorded rather than assumed, because a
  -- reproducibility claim over a non-deterministic component would be false.
  deterministic boolean not null,
  created_at timestamptz not null default now(),
  constraint component_versions_unique unique (component_id, version),
  constraint component_versions_content_unique unique (content_hash),
  constraint component_versions_version_shape check (version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'),
  constraint component_versions_impl_shape check (implementation_sha256 ~ '^[0-9a-f]{64}$'),
  constraint component_versions_config_hash_shape check (configuration_hash ~ '^[0-9a-f]{64}$'),
  constraint component_versions_content_hash_shape check (content_hash ~ '^[0-9a-f]{64}$'),
  -- Platform spec §12.1: model weights require licence review before promotion.
  -- A version that names a model artifact and no licence cannot be stored, so
  -- the review cannot be skipped by forgetting.
  constraint component_versions_model_needs_licence
    check (model_identity is null or licence is not null)
)
--> statement-breakpoint
comment on table analysis.component_versions is 'One immutable implementation and configuration of a component (database architecture 12.2). Validation and promotion state live in analysis.component_lifecycle_events so approving a version does not change the version. content_hash is the identity: re-registering identical content returns the existing row.'
--> statement-breakpoint
comment on column analysis.component_versions.model_identity is 'Model, binary or weights identity when applicable: family, revision and artifact digest. Never a credential, endpoint or prompt.'
--> statement-breakpoint
drop trigger if exists component_versions_immutable on analysis.component_versions
--> statement-breakpoint
create trigger component_versions_immutable
  before update or delete on analysis.component_versions
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
create index if not exists component_versions_component
  on analysis.component_versions (component_id, created_at desc)
--> statement-breakpoint
create table if not exists analysis.component_version_dependencies (
  dependent_version_id uuid not null references analysis.component_versions(id) on delete restrict,
  dependency_version_id uuid not null references analysis.component_versions(id) on delete restrict,
  -- The contract the dependent declares it needs. Compatibility is checked
  -- against the dependency component's output_contract, so an upgrade that
  -- changes what a component emits is rejected rather than silently consumed.
  required_contract text not null,
  created_at timestamptz not null default now(),
  primary key (dependent_version_id, dependency_version_id),
  constraint component_dependencies_no_self check (dependent_version_id <> dependency_version_id),
  constraint component_dependencies_contract_shape
    check (required_contract ~ '^[a-z][a-z0-9_.]{2,95}$')
)
--> statement-breakpoint
comment on table analysis.component_version_dependencies is 'The directed acyclic graph of component-version dependencies (database architecture 12.3). Cycles are refused by trigger at insert, so a cyclic graph is unrepresentable rather than rejected by whichever validation pass remembers to look.'
--> statement-breakpoint
create index if not exists component_dependencies_dependency
  on analysis.component_version_dependencies (dependency_version_id)
--> statement-breakpoint
create or replace function analysis.refuse_dependency_cycle() returns trigger
language plpgsql as $$
begin
  if exists (
    with recursive reachable as (
      select d.dependency_version_id as id
        from analysis.component_version_dependencies d
       where d.dependent_version_id = new.dependency_version_id
      union
      select d.dependency_version_id
        from analysis.component_version_dependencies d
        join reachable r on d.dependent_version_id = r.id
    )
    select 1 from reachable where id = new.dependent_version_id
  ) then
    raise exception 'component version dependency would create a cycle'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$
--> statement-breakpoint
comment on function analysis.refuse_dependency_cycle() is 'Refuses an edge whose dependency can already reach its dependent (database architecture 12.3). union rather than union all, so the walk terminates even if a cycle somehow exists.'
--> statement-breakpoint
revoke all on function analysis.refuse_dependency_cycle() from public
--> statement-breakpoint
drop trigger if exists component_dependencies_acyclic on analysis.component_version_dependencies
--> statement-breakpoint
create trigger component_dependencies_acyclic
  before insert on analysis.component_version_dependencies
  for each row execute function analysis.refuse_dependency_cycle()
--> statement-breakpoint
drop trigger if exists component_dependencies_immutable on analysis.component_version_dependencies
--> statement-breakpoint
create trigger component_dependencies_immutable
  before update or delete on analysis.component_version_dependencies
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- §12.4–12.5 — recipes
-- ---------------------------------------------------------------------------
create table if not exists analysis.recipe_versions (
  id uuid primary key default gen_random_uuid(),
  recipe_key text not null,
  version text not null,
  manifest_sha256 text not null,
  input_schema_version text not null,
  output_schema_version text not null,
  run_type text not null,
  -- The output families a run of this recipe must produce to be complete. The
  -- set is declared per recipe rather than fixed per run type: E11 owns
  -- reproducibility, not chess meaning, and a hardcoded list here would either
  -- invent families no method produces or bless whatever a later epic writes.
  required_artifacts text[] not null,
  -- True when every pinned component version is deterministic. A recipe that is
  -- not deterministic still runs; it simply cannot claim byte-identical reruns.
  deterministic boolean not null,
  created_at timestamptz not null default now(),
  constraint recipe_versions_unique unique (recipe_key, version),
  constraint recipe_versions_manifest_unique unique (manifest_sha256),
  constraint recipe_versions_key_shape check (recipe_key ~ '^[a-z][a-z0-9_]{2,63}$'),
  constraint recipe_versions_version_shape check (version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'),
  constraint recipe_versions_manifest_shape check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  constraint recipe_versions_run_type_check
    check (run_type in ('game_analysis', 'subject_baseline', 'subject_live')),
  -- A recipe promising nothing would let an empty run "succeed".
  constraint recipe_versions_artifacts_present check (cardinality(required_artifacts) between 1 and 32)
)
--> statement-breakpoint
comment on table analysis.recipe_versions is 'An immutable manifest defining one coherent analysis contract (database architecture 12.4). manifest_sha256 is computed from the pinned components content hashes rather than their row ids, so two deployments that registered the same versions independently agree on what the recipe is.'
--> statement-breakpoint
drop trigger if exists recipe_versions_immutable on analysis.recipe_versions
--> statement-breakpoint
create trigger recipe_versions_immutable
  before update or delete on analysis.recipe_versions
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
create table if not exists analysis.recipe_components (
  recipe_version_id uuid not null references analysis.recipe_versions(id) on delete restrict,
  role text not null,
  component_version_id uuid not null references analysis.component_versions(id) on delete restrict,
  primary key (recipe_version_id, role),
  constraint recipe_components_role_shape check (role ~ '^[a-z][a-z0-9_]{2,63}$')
)
--> statement-breakpoint
comment on table analysis.recipe_components is 'Maps every named recipe role to exactly one component version (database architecture 12.5). One role, one version: the primary key is what stops a recipe pinning two engines and leaving the choice to whichever query sorted first.'
--> statement-breakpoint
create index if not exists recipe_components_version
  on analysis.recipe_components (component_version_id)
--> statement-breakpoint
drop trigger if exists recipe_components_immutable on analysis.recipe_components
--> statement-breakpoint
create trigger recipe_components_immutable
  before update or delete on analysis.recipe_components
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- §12.10 — validation evidence, and §12.6 — promotion
--
-- Ordered before promotions because a promotion references the validation run
-- that justified it.
-- ---------------------------------------------------------------------------
create table if not exists analysis.validation_datasets (
  id uuid primary key default gen_random_uuid(),
  dataset_key text not null,
  version text not null,
  manifest_sha256 text not null,
  -- The immutable corpus body, in private Storage. Never inlined here.
  artifact_id uuid references ops.artifacts(id) on delete restrict,
  sampling_description text not null,
  -- §12.10: the two split rules that decide whether a metric means anything.
  account_disjoint boolean not null,
  chronological_split boolean not null,
  licence text,
  governance_class text not null,
  created_at timestamptz not null default now(),
  constraint validation_datasets_unique unique (dataset_key, version),
  constraint validation_datasets_manifest_shape check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  constraint validation_datasets_key_shape check (dataset_key ~ '^[a-z][a-z0-9_]{2,63}$'),
  constraint validation_datasets_governance_check
    check (governance_class in ('public', 'licensed', 'internal', 'restricted'))
)
--> statement-breakpoint
comment on table analysis.validation_datasets is 'An immutable labelled or holdout corpus identified by manifest hash (database architecture 12.10). account_disjoint and chronological_split are recorded because a metric measured on a corpus that shares accounts or leaks the future is not evidence about generalisation.'
--> statement-breakpoint
drop trigger if exists validation_datasets_immutable on analysis.validation_datasets
--> statement-breakpoint
create trigger validation_datasets_immutable
  before update or delete on analysis.validation_datasets
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
create table if not exists analysis.validation_runs (
  id uuid primary key default gen_random_uuid(),
  dataset_id uuid not null references analysis.validation_datasets(id) on delete restrict,
  -- Exactly one of these is the thing being evaluated.
  candidate_component_version_id uuid references analysis.component_versions(id) on delete restrict,
  candidate_recipe_version_id uuid references analysis.recipe_versions(id) on delete restrict,
  -- What it was compared against. Null on the first evaluation of a lineage.
  baseline_component_version_id uuid references analysis.component_versions(id) on delete restrict,
  baseline_recipe_version_id uuid references analysis.recipe_versions(id) on delete restrict,
  execution_revision text not null,
  status text not null,
  output_checksum text not null,
  summary jsonb not null default '{}'::jsonb,
  evaluated_at timestamptz not null default now(),
  constraint validation_runs_status_check check (status in ('passed', 'failed', 'inconclusive')),
  constraint validation_runs_checksum_shape check (output_checksum ~ '^[0-9a-f]{64}$'),
  -- One candidate, not two and not none.
  constraint validation_runs_one_candidate check (
    (candidate_component_version_id is not null)::int
    + (candidate_recipe_version_id is not null)::int = 1
  ),
  -- A baseline must be the same kind of thing as the candidate.
  constraint validation_runs_baseline_matches_candidate check (
    (baseline_component_version_id is null or candidate_component_version_id is not null)
    and (baseline_recipe_version_id is null or candidate_recipe_version_id is not null)
  )
)
--> statement-breakpoint
comment on table analysis.validation_runs is 'One completed evaluation of a candidate against a fixed dataset (database architecture 12.10). It records evidence, not progress: in-flight execution is the work ledger''s job, so a row here is always a finished comparison and is immutable.'
--> statement-breakpoint
comment on column analysis.validation_runs.summary is 'Aggregate outcome counts and thresholds. Carries no position, replay, account or player identifier.'
--> statement-breakpoint
drop trigger if exists validation_runs_immutable on analysis.validation_runs
--> statement-breakpoint
create trigger validation_runs_immutable
  before update or delete on analysis.validation_runs
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
create index if not exists validation_datasets_artifact
  on analysis.validation_datasets (artifact_id)
--> statement-breakpoint
create index if not exists validation_runs_dataset on analysis.validation_runs (dataset_id, evaluated_at desc)
--> statement-breakpoint
create index if not exists validation_runs_candidate_component
  on analysis.validation_runs (candidate_component_version_id, evaluated_at desc)
--> statement-breakpoint
create index if not exists validation_runs_candidate_recipe
  on analysis.validation_runs (candidate_recipe_version_id, evaluated_at desc)
--> statement-breakpoint
create index if not exists validation_runs_baseline_component
  on analysis.validation_runs (baseline_component_version_id)
--> statement-breakpoint
create index if not exists validation_runs_baseline_recipe
  on analysis.validation_runs (baseline_recipe_version_id)
--> statement-breakpoint
create table if not exists analysis.validation_metrics (
  id bigint generated always as identity primary key,
  validation_run_id uuid not null references analysis.validation_runs(id) on delete cascade,
  metric_key text not null,
  -- The declared slice: provider, rating band, time control, phase, clock
  -- availability, concept. Empty object means the overall population.
  slice jsonb not null default '{}'::jsonb,
  sample_size integer not null,
  value double precision,
  interval_low double precision,
  interval_high double precision,
  -- Kept separately so an unmeasurable slice is a stated absence rather than a
  -- missing row a reader mistakes for "not applicable".
  unavailable_reason text,
  constraint validation_metrics_key_shape check (metric_key ~ '^[a-z][a-z0-9_]{2,63}$'),
  constraint validation_metrics_sample_non_negative check (sample_size >= 0),
  constraint validation_metrics_interval_ordered check (
    interval_low is null or interval_high is null or interval_low <= interval_high
  ),
  -- A metric is either measured or explained. Never silently null.
  constraint validation_metrics_value_or_reason check (
    (value is not null) <> (unavailable_reason is not null)
  )
)
--> statement-breakpoint
comment on table analysis.validation_metrics is 'Named metrics by declared slice for one validation run (database architecture 12.10). A slice with no measurable evidence carries an unavailable_reason rather than a null value, so "we could not measure this" is never rendered as a result.'
--> statement-breakpoint
create unique index if not exists validation_metrics_unique
  on analysis.validation_metrics (validation_run_id, metric_key, slice)
--> statement-breakpoint
drop trigger if exists validation_metrics_immutable on analysis.validation_metrics
--> statement-breakpoint
create trigger validation_metrics_immutable
  before update or delete on analysis.validation_metrics
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
create table if not exists analysis.component_lifecycle_events (
  id bigint generated always as identity primary key,
  component_version_id uuid not null references analysis.component_versions(id) on delete restrict,
  from_state text,
  to_state text not null,
  -- The evidence that justified the move. Required to reach validated or
  -- production: a promotion with no validation run is an opinion.
  validation_run_id uuid references analysis.validation_runs(id) on delete restrict,
  actor_kind text not null,
  actor_id uuid references app.profiles(user_id) on delete set null,
  reason text not null,
  occurred_at timestamptz not null default now(),
  constraint lifecycle_state_check check (
    to_state in ('draft', 'shadow', 'validated', 'production', 'retired')
    and (from_state is null or from_state in ('draft', 'shadow', 'validated', 'production', 'retired'))
  ),
  constraint lifecycle_actor_kind_check check (actor_kind in ('user', 'system')),
  constraint lifecycle_actor_id_present check ((actor_kind = 'user') = (actor_id is not null)),
  constraint lifecycle_evidence_required check (
    to_state not in ('validated', 'production') or validation_run_id is not null
  ),
  constraint lifecycle_first_event_is_draft check (from_state is not null or to_state = 'draft')
)
--> statement-breakpoint
comment on table analysis.component_lifecycle_events is 'Append-only lifecycle history for a component version (database architecture 12.10). Reaching validated or production requires a validation run, which is the executable form of "data does not continuously retrain or silently promote production behaviour". The current state is the latest event, never a mutable column on the immutable version.'
--> statement-breakpoint
create index if not exists lifecycle_events_version
  on analysis.component_lifecycle_events (component_version_id, id desc)
--> statement-breakpoint
create index if not exists lifecycle_events_validation
  on analysis.component_lifecycle_events (validation_run_id)
--> statement-breakpoint
create index if not exists lifecycle_events_actor on analysis.component_lifecycle_events (actor_id)
--> statement-breakpoint
drop trigger if exists lifecycle_events_immutable on analysis.component_lifecycle_events
--> statement-breakpoint
create trigger lifecycle_events_immutable
  before update or delete on analysis.component_lifecycle_events
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
create table if not exists analysis.recipe_promotions (
  -- Identity ordering, so "the current recipe for this surface" is a total
  -- order and two promotions in the same millisecond still resolve.
  id bigint generated always as identity primary key,
  surface text not null,
  recipe_version_id uuid not null references analysis.recipe_versions(id) on delete restrict,
  previous_recipe_version_id uuid references analysis.recipe_versions(id) on delete restrict,
  validation_run_id uuid references analysis.validation_runs(id) on delete restrict,
  actor_kind text not null,
  actor_id uuid references app.profiles(user_id) on delete set null,
  reason text not null,
  promoted_at timestamptz not null default now(),
  constraint recipe_promotions_surface_check check (surface in (
    'screening', 'deep_game_analysis', 'onboarding_examination',
    'live_player_profile', 'research_shadow'
  )),
  constraint recipe_promotions_actor_kind_check check (actor_kind in ('user', 'system')),
  constraint recipe_promotions_actor_id_present check ((actor_kind = 'user') = (actor_id is not null)),
  constraint recipe_promotions_moves check (recipe_version_id <> previous_recipe_version_id),
  -- Every production surface needs evidence. research_shadow is exactly the
  -- surface a candidate runs on *before* it has any, so it is the exception.
  constraint recipe_promotions_evidence_required
    check (surface = 'research_shadow' or validation_run_id is not null)
)
--> statement-breakpoint
comment on table analysis.recipe_promotions is 'Append-only history of which recipe a surface uses (database architecture 12.6). Promotion changes what new runs use; it never changes an existing run or baseline. Rolling back is another promotion row, so the fact that a rollback happened survives.'
--> statement-breakpoint
create index if not exists recipe_promotions_surface
  on analysis.recipe_promotions (surface, id desc)
--> statement-breakpoint
create index if not exists recipe_promotions_recipe on analysis.recipe_promotions (recipe_version_id)
--> statement-breakpoint
create index if not exists recipe_promotions_previous
  on analysis.recipe_promotions (previous_recipe_version_id)
--> statement-breakpoint
create index if not exists recipe_promotions_validation
  on analysis.recipe_promotions (validation_run_id)
--> statement-breakpoint
create index if not exists recipe_promotions_actor on analysis.recipe_promotions (actor_id)
--> statement-breakpoint
drop trigger if exists recipe_promotions_immutable on analysis.recipe_promotions
--> statement-breakpoint
create trigger recipe_promotions_immutable
  before update or delete on analysis.recipe_promotions
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- §12.7–12.9 — cohorts and frozen subject snapshots
-- ---------------------------------------------------------------------------
create table if not exists analysis.cohort_definition_versions (
  id uuid primary key default gen_random_uuid(),
  cohort_key text not null,
  version text not null,
  definition jsonb not null,
  definition_hash text not null,
  created_at timestamptz not null default now(),
  constraint cohort_versions_unique unique (cohort_key, version),
  constraint cohort_versions_hash_unique unique (definition_hash),
  constraint cohort_versions_key_shape check (cohort_key ~ '^[a-z][a-z0-9_]{2,63}$'),
  constraint cohort_versions_version_shape check (version ~ '^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$'),
  constraint cohort_versions_hash_shape check (definition_hash ~ '^[0-9a-f]{64}$')
)
--> statement-breakpoint
comment on table analysis.cohort_definition_versions is 'Immutable rules describing which subject games form a coherent dataset (database architecture 12.7). Changing "minimum 50 games" or the default speed mix creates a new version, not a hidden behaviour change: the hash is unique, so the same rules cannot be registered twice under different names.'
--> statement-breakpoint
drop trigger if exists cohort_versions_immutable on analysis.cohort_definition_versions
--> statement-breakpoint
create trigger cohort_versions_immutable
  before update or delete on analysis.cohort_definition_versions
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
create table if not exists analysis.subject_data_snapshots (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references app.analysis_subjects(id) on delete restrict,
  cohort_definition_version_id uuid not null
    references analysis.cohort_definition_versions(id) on delete restrict,
  -- The watermark. No game played after this is in the manifest.
  cutoff timestamptz not null,
  snapshot_hash text not null,
  game_count integer not null,
  earliest_played_at timestamptz,
  latest_played_at timestamptz,
  -- True when the cohort's minGames floor was not reached. The snapshot still
  -- exists -- refusing to freeze would hide the shortfall -- but a claim built
  -- on it must say so rather than presenting thin evidence as complete.
  under_covered boolean not null,
  created_at timestamptz not null default now(),
  -- Lets a run carry (snapshot_id, subject_id) as a composite foreign key, so a
  -- run cannot cite a snapshot belonging to another subject.
  constraint subject_snapshots_id_subject_unique unique (id, subject_id),
  constraint subject_snapshots_hash_shape check (snapshot_hash ~ '^[0-9a-f]{64}$'),
  constraint subject_snapshots_count_non_negative check (game_count >= 0),
  constraint subject_snapshots_range_ordered check (
    earliest_played_at is null or latest_played_at is null
    or earliest_played_at <= latest_played_at
  ),
  -- An empty snapshot has no date range, and a non-empty one has both ends.
  constraint subject_snapshots_range_present check (
    (game_count = 0) = (earliest_played_at is null and latest_played_at is null)
  )
)
--> statement-breakpoint
comment on table analysis.subject_data_snapshots is 'The frozen manifest of exactly which games a subject-level analysis used (database architecture 12.8). snapshot_hash covers each game''s replay revision and materialization run, so a provider correction or a new materializer produces a different snapshot instead of quietly changing what a published baseline was computed from.'
--> statement-breakpoint
-- The same subject, cohort and cutoff must freeze to the same manifest.
-- Recomputing is therefore idempotent rather than a second snapshot.
create unique index if not exists subject_snapshots_identity
  on analysis.subject_data_snapshots (subject_id, cohort_definition_version_id, cutoff, snapshot_hash)
--> statement-breakpoint
create index if not exists subject_snapshots_subject
  on analysis.subject_data_snapshots (subject_id, created_at desc)
--> statement-breakpoint
create index if not exists subject_snapshots_cohort
  on analysis.subject_data_snapshots (cohort_definition_version_id)
--> statement-breakpoint
drop trigger if exists subject_snapshots_immutable on analysis.subject_data_snapshots
--> statement-breakpoint
create trigger subject_snapshots_immutable
  before update or delete on analysis.subject_data_snapshots
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
create table if not exists analysis.subject_data_snapshot_games (
  snapshot_id uuid not null references analysis.subject_data_snapshots(id) on delete restrict,
  subject_game_id uuid not null references chess.subject_games(id) on delete restrict,
  -- The exact revision and materialization the analysis reads. Not "latest".
  replay_revision_id bigint not null references chess.game_replay_revisions(id) on delete restrict,
  materialization_run_id uuid not null references chess.materialization_runs(id) on delete restrict,
  inclusion_reason text not null,
  weight double precision,
  primary key (snapshot_id, subject_game_id),
  constraint snapshot_games_weight_positive check (weight is null or weight > 0)
)
--> statement-breakpoint
comment on table analysis.subject_data_snapshot_games is 'One frozen game in a snapshot manifest (database architecture 12.9). It pins the replay revision and the materialization run, which is what makes a baseline reproducible after a provider correction or a new materializer version.'
--> statement-breakpoint
create index if not exists snapshot_games_game on analysis.subject_data_snapshot_games (subject_game_id)
--> statement-breakpoint
create index if not exists snapshot_games_revision
  on analysis.subject_data_snapshot_games (replay_revision_id)
--> statement-breakpoint
create index if not exists snapshot_games_materialization
  on analysis.subject_data_snapshot_games (materialization_run_id)
--> statement-breakpoint
drop trigger if exists snapshot_games_immutable on analysis.subject_data_snapshot_games
--> statement-breakpoint
create trigger snapshot_games_immutable
  before update or delete on analysis.subject_data_snapshot_games
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- A composite key on the existing subject-game table.
--
-- Additive: a unique index on a column pair whose first member is already the
-- primary key. It exists so analysis.runs can carry (subject_game_id,
-- subject_id) as one foreign key, which makes "this run's game belongs to this
-- run's subject" a constraint instead of a check some call site performs.
-- ---------------------------------------------------------------------------
-- Added conditionally rather than dropped and recreated: once analysis.runs
-- references it, a drop is refused, and a migration that cannot be re-applied
-- cannot recover forward from an interruption.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'chess.subject_games'::regclass
      and conname = 'subject_games_id_subject_unique'
  ) then
    alter table chess.subject_games
      add constraint subject_games_id_subject_unique unique (id, subject_id);
  end if;
end $$
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- §13.1–13.3 — runs, their reused dependencies, and their output manifest
-- ---------------------------------------------------------------------------
create table if not exists analysis.runs (
  id uuid primary key default gen_random_uuid(),
  run_type text not null,
  recipe_version_id uuid not null references analysis.recipe_versions(id) on delete restrict,
  -- Every run type is subject-scoped, so this is the tenancy column and it is
  -- never null. The other three are constrained by run type below.
  subject_id uuid not null references app.analysis_subjects(id) on delete restrict,
  subject_game_id uuid,
  replay_revision_id bigint references chess.game_replay_revisions(id) on delete restrict,
  subject_data_snapshot_id uuid,
  status text not null default 'planned',
  input_manifest_hash text not null,
  output_manifest_hash text,
  -- The comparison run this one was produced against, for shadow evaluation.
  parent_run_id uuid references analysis.runs(id) on delete restrict,
  trigger_kind text not null,
  actor_kind text not null,
  actor_id uuid references app.profiles(user_id) on delete set null,
  -- How this run was scheduled. The ledger owns retries and leases; the run
  -- owns what was produced. One link, not two, so they cannot disagree.
  work_item_id bigint references ops.work_items(id) on delete set null,
  started_at timestamptz,
  completed_at timestamptz,
  -- Sanitized: a classification from the work ledger's closed set, never a
  -- provider body, stack trace or position.
  failure_class text,
  created_at timestamptz not null default now(),
  constraint runs_game_belongs_to_subject
    foreign key (subject_game_id, subject_id) references chess.subject_games(id, subject_id)
    on delete restrict,
  constraint runs_snapshot_belongs_to_subject
    foreign key (subject_data_snapshot_id, subject_id)
    references analysis.subject_data_snapshots(id, subject_id) on delete restrict,
  constraint runs_type_check check (run_type in ('game_analysis', 'subject_baseline', 'subject_live')),
  constraint runs_status_check
    check (status in ('planned', 'running', 'succeeded', 'failed', 'cancelled')),
  constraint runs_input_hash_shape check (input_manifest_hash ~ '^[0-9a-f]{64}$'),
  constraint runs_output_hash_shape
    check (output_manifest_hash is null or output_manifest_hash ~ '^[0-9a-f]{64}$'),
  constraint runs_trigger_check
    check (trigger_kind in ('user_request', 'scheduled', 'backfill', 'promotion', 'shadow')),
  constraint runs_actor_kind_check check (actor_kind in ('user', 'system')),
  constraint runs_actor_id_present check ((actor_kind = 'user') = (actor_id is not null)),
  constraint runs_no_self_parent check (parent_run_id is null or parent_run_id <> id),
  -- §13.1: the scope columns are constrained according to run type. A game
  -- analysis pins the exact revision it read; a subject run pins a snapshot and
  -- never a single game.
  constraint runs_scope_by_type check (
    case run_type
      when 'game_analysis' then
        subject_game_id is not null and replay_revision_id is not null
        and subject_data_snapshot_id is null
      else
        subject_data_snapshot_id is not null
        and subject_game_id is null and replay_revision_id is null
    end
  ),
  -- Only a succeeded run has an output manifest, and only a terminal run has
  -- finished. "Succeeded" here means the manifest passed its integrity check.
  constraint runs_output_only_on_success
    check ((output_manifest_hash is not null) = (status = 'succeeded')),
  constraint runs_completed_when_terminal
    check ((status in ('succeeded', 'failed', 'cancelled')) = (completed_at is not null)),
  constraint runs_started_before_completed
    check (started_at is null or completed_at is null or started_at <= completed_at),
  constraint runs_failure_class_check check (
    failure_class is null or failure_class in (
      'transient', 'rate_limit', 'invalid_input', 'unsupported', 'unauthorized',
      'budget', 'permanent'
    )
  ),
  constraint runs_failure_class_only_on_failure
    check (failure_class is null or status = 'failed')
)
--> statement-breakpoint
comment on table analysis.runs is 'One coherent immutable attempt to produce a declared output contract (database architecture 13.1). "Succeeded" means the output manifest passed integrity checks, not that every worker exited zero. Identity, inputs and terminal status are frozen by trigger, so a result is never overwritten -- a rerun is a new run.'
--> statement-breakpoint
comment on column analysis.runs.input_manifest_hash is 'Covers run type, recipe manifest, scope, snapshot hash and the output hashes of every reused upstream run. It is both the reproducibility claim and the idempotency key: planning identical work twice finds the first run.'
--> statement-breakpoint
-- Durable idempotency. Identical inputs cannot produce a second live run, while
-- a failed or cancelled attempt leaves the input free to be retried.
create unique index if not exists runs_input_manifest_live
  on analysis.runs (input_manifest_hash)
  where status in ('planned', 'running', 'succeeded')
--> statement-breakpoint
create index if not exists runs_subject on analysis.runs (subject_id, run_type, created_at desc)
--> statement-breakpoint
create index if not exists runs_recipe on analysis.runs (recipe_version_id)
--> statement-breakpoint
-- Leads with the composite foreign key's columns, in the constraint's order,
-- so `runs_game_belongs_to_subject` is served by an index rather than a scan.
-- created_at trails it, which is the order "this game's runs, newest first"
-- wants anyway.
create index if not exists runs_subject_game
  on analysis.runs (subject_game_id, subject_id, created_at desc)
--> statement-breakpoint
create index if not exists runs_revision on analysis.runs (replay_revision_id)
--> statement-breakpoint
create index if not exists runs_snapshot
  on analysis.runs (subject_data_snapshot_id, subject_id)
--> statement-breakpoint
create index if not exists runs_parent on analysis.runs (parent_run_id)
--> statement-breakpoint
create index if not exists runs_work_item on analysis.runs (work_item_id)
--> statement-breakpoint
create index if not exists runs_actor on analysis.runs (actor_id)
--> statement-breakpoint
create or replace function analysis.refuse_run_rewrite() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'analysis runs are append-only; cancel a run instead of deleting it'
      using errcode = 'restrict_violation';
  end if;
  if new.id <> old.id
     or new.run_type <> old.run_type
     or new.recipe_version_id <> old.recipe_version_id
     or new.subject_id <> old.subject_id
     or new.subject_game_id is distinct from old.subject_game_id
     or new.replay_revision_id is distinct from old.replay_revision_id
     or new.subject_data_snapshot_id is distinct from old.subject_data_snapshot_id
     or new.input_manifest_hash <> old.input_manifest_hash
     or new.parent_run_id is distinct from old.parent_run_id
     or new.created_at <> old.created_at then
    raise exception 'a run''s identity and inputs are immutable'
      using errcode = 'restrict_violation';
  end if;
  if old.status in ('succeeded', 'failed', 'cancelled') and new.status <> old.status then
    raise exception 'a terminal run status is final' using errcode = 'restrict_violation';
  end if;
  if old.output_manifest_hash is not null
     and new.output_manifest_hash is distinct from old.output_manifest_hash then
    raise exception 'a run output manifest is written once'
      using errcode = 'restrict_violation';
  end if;
  if old.completed_at is not null and new.completed_at is distinct from old.completed_at then
    raise exception 'a completed run keeps its completion time'
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$
--> statement-breakpoint
comment on function analysis.refuse_run_rewrite() is 'Freezes a run''s identity, inputs, terminal status, output manifest and completion time (database architecture 13.1). A run may move planned -> running -> terminal and nothing else; a different answer is a different run.'
--> statement-breakpoint
revoke all on function analysis.refuse_run_rewrite() from public
--> statement-breakpoint
drop trigger if exists runs_append_only on analysis.runs
--> statement-breakpoint
create trigger runs_append_only
  before update or delete on analysis.runs
  for each row execute function analysis.refuse_run_rewrite()
--> statement-breakpoint
create table if not exists analysis.run_dependencies (
  run_id uuid not null references analysis.runs(id) on delete restrict,
  upstream_run_id uuid not null references analysis.runs(id) on delete restrict,
  -- Why the upstream output is still valid for this run: which recipe role was
  -- unchanged. This is what makes a method-only rerun auditable rather than an
  -- assertion that reuse was safe.
  reused_role text not null,
  -- The upstream output manifest hash as it was when reuse was decided.
  upstream_output_hash text not null,
  primary key (run_id, upstream_run_id, reused_role),
  constraint run_dependencies_no_self check (run_id <> upstream_run_id),
  constraint run_dependencies_role_shape check (reused_role ~ '^[a-z][a-z0-9_]{2,63}$'),
  constraint run_dependencies_hash_shape check (upstream_output_hash ~ '^[0-9a-f]{64}$')
)
--> statement-breakpoint
comment on table analysis.run_dependencies is 'The exact upstream runs a run reused (database architecture 13.2). Changing only the estimator produces a new run that reuses the same snapshot, engine output and observations, and this table is the record of which roles were carried over and what their outputs hashed to at the time.'
--> statement-breakpoint
create index if not exists run_dependencies_upstream on analysis.run_dependencies (upstream_run_id)
--> statement-breakpoint
drop trigger if exists run_dependencies_immutable on analysis.run_dependencies
--> statement-breakpoint
create trigger run_dependencies_immutable
  before update or delete on analysis.run_dependencies
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
create table if not exists analysis.run_artifacts (
  run_id uuid not null references analysis.runs(id) on delete restrict,
  family text not null,
  -- Zero is a legitimate answer: a quiet game produced no events. What is not
  -- legitimate is the row being absent, because then nothing distinguishes
  -- "none" from "the step never ran".
  row_count integer not null,
  checksum text not null,
  -- Set when the family's body lives in private Storage rather than in a table.
  artifact_id uuid references ops.artifacts(id) on delete restrict,
  recorded_at timestamptz not null default now(),
  primary key (run_id, family),
  constraint run_artifacts_family_shape check (family ~ '^[a-z][a-z0-9_]{2,63}$'),
  constraint run_artifacts_count_non_negative check (row_count >= 0),
  constraint run_artifacts_checksum_shape check (checksum ~ '^[0-9a-f]{64}$')
)
--> statement-breakpoint
comment on table analysis.run_artifacts is 'The manifest of output families a run produced, with counts and checksums (database architecture 13.3). A run succeeds only when this covers exactly the families its recipe declared: a missing family is an incomplete run, and an undeclared one is not the run that was planned.'
--> statement-breakpoint
create index if not exists run_artifacts_artifact on analysis.run_artifacts (artifact_id)
--> statement-breakpoint
drop trigger if exists run_artifacts_immutable on analysis.run_artifacts
--> statement-breakpoint
create trigger run_artifacts_immutable
  before update or delete on analysis.run_artifacts
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- §13.4 — type-safe publications and their append-only history
-- ---------------------------------------------------------------------------
create table if not exists analysis.subject_live_publication_history (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references app.analysis_subjects(id) on delete restrict,
  previous_run_id uuid references analysis.runs(id) on delete restrict,
  run_id uuid not null references analysis.runs(id) on delete restrict,
  reason text not null,
  actor_kind text not null,
  actor_id uuid references app.profiles(user_id) on delete set null,
  published_at timestamptz not null default now(),
  constraint subject_live_history_reason_check check (reason in (
    'first_publication', 'new_run', 'recipe_promotion', 'rollback', 'reconciliation'
  )),
  constraint subject_live_history_actor_kind_check check (actor_kind in ('user', 'system')),
  constraint subject_live_history_actor_id_present
    check ((actor_kind = 'user') = (actor_id is not null)),
  constraint subject_live_history_moves check (run_id is distinct from previous_run_id),
  constraint subject_live_history_first_has_no_previous
    check (reason <> 'first_publication' or previous_run_id is null)
)
--> statement-breakpoint
comment on table analysis.subject_live_publication_history is 'Append-only record of every subject live-publication pointer move (database architecture 13.4), carrying the old run, the new run, the actor and the reason. Rollback appends a row restoring the earlier run rather than deleting this one, so the fact that a rollback happened survives it.'
--> statement-breakpoint
create index if not exists subject_live_history_subject
  on analysis.subject_live_publication_history (subject_id, published_at desc, id desc)
--> statement-breakpoint
create index if not exists subject_live_history_run
  on analysis.subject_live_publication_history (run_id)
--> statement-breakpoint
create index if not exists subject_live_history_previous
  on analysis.subject_live_publication_history (previous_run_id)
--> statement-breakpoint
create index if not exists subject_live_history_actor
  on analysis.subject_live_publication_history (actor_id)
--> statement-breakpoint
drop trigger if exists subject_live_history_immutable on analysis.subject_live_publication_history
--> statement-breakpoint
create trigger subject_live_history_immutable
  before update or delete on analysis.subject_live_publication_history
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
create table if not exists analysis.subject_live_publications (
  subject_id uuid primary key references app.analysis_subjects(id) on delete restrict,
  run_id uuid not null references analysis.runs(id) on delete restrict,
  -- The history row that installed this pointer. It is the publicationId the
  -- API's version block carries, so a cached response keyed by it is
  -- invalidated by the next switch rather than by a guessed TTL.
  publication_id uuid not null
    references analysis.subject_live_publication_history(id) on delete restrict,
  subject_data_snapshot_id uuid not null
    references analysis.subject_data_snapshots(id) on delete restrict,
  recipe_version_id uuid not null references analysis.recipe_versions(id) on delete restrict,
  published_at timestamptz not null default now(),
  constraint subject_live_publication_id_unique unique (publication_id)
)
--> statement-breakpoint
comment on table analysis.subject_live_publications is 'The one current live publication per subject (database architecture 13.4). The row is the pointer and is the only mutable thing in this graph; every value it has ever held is a row in the history table beside it.'
--> statement-breakpoint
create index if not exists subject_live_publications_run on analysis.subject_live_publications (run_id)
--> statement-breakpoint
create index if not exists subject_live_publications_snapshot
  on analysis.subject_live_publications (subject_data_snapshot_id)
--> statement-breakpoint
create index if not exists subject_live_publications_recipe
  on analysis.subject_live_publications (recipe_version_id)
--> statement-breakpoint
create table if not exists analysis.subject_game_publication_history (
  id uuid primary key default gen_random_uuid(),
  subject_game_id uuid not null references chess.subject_games(id) on delete restrict,
  previous_run_id uuid references analysis.runs(id) on delete restrict,
  run_id uuid not null references analysis.runs(id) on delete restrict,
  reason text not null,
  actor_kind text not null,
  actor_id uuid references app.profiles(user_id) on delete set null,
  published_at timestamptz not null default now(),
  constraint subject_game_history_reason_check check (reason in (
    'first_publication', 'new_run', 'recipe_promotion', 'rollback', 'reconciliation'
  )),
  constraint subject_game_history_actor_kind_check check (actor_kind in ('user', 'system')),
  constraint subject_game_history_actor_id_present
    check ((actor_kind = 'user') = (actor_id is not null)),
  constraint subject_game_history_moves check (run_id is distinct from previous_run_id),
  constraint subject_game_history_first_has_no_previous
    check (reason <> 'first_publication' or previous_run_id is null)
)
--> statement-breakpoint
comment on table analysis.subject_game_publication_history is 'Append-only record of every subject-game publication pointer move (database architecture 13.4). A provider correction produces a new replay revision, a new run and a new row here; it never edits the analysis a reader already saw.'
--> statement-breakpoint
create index if not exists subject_game_history_game
  on analysis.subject_game_publication_history (subject_game_id, published_at desc, id desc)
--> statement-breakpoint
create index if not exists subject_game_history_run
  on analysis.subject_game_publication_history (run_id)
--> statement-breakpoint
create index if not exists subject_game_history_previous
  on analysis.subject_game_publication_history (previous_run_id)
--> statement-breakpoint
create index if not exists subject_game_history_actor
  on analysis.subject_game_publication_history (actor_id)
--> statement-breakpoint
drop trigger if exists subject_game_history_immutable on analysis.subject_game_publication_history
--> statement-breakpoint
create trigger subject_game_history_immutable
  before update or delete on analysis.subject_game_publication_history
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
create table if not exists analysis.subject_game_publications (
  subject_game_id uuid primary key references chess.subject_games(id) on delete restrict,
  run_id uuid not null references analysis.runs(id) on delete restrict,
  publication_id uuid not null
    references analysis.subject_game_publication_history(id) on delete restrict,
  replay_revision_id bigint not null references chess.game_replay_revisions(id) on delete restrict,
  recipe_version_id uuid not null references analysis.recipe_versions(id) on delete restrict,
  published_at timestamptz not null default now(),
  constraint subject_game_publication_id_unique unique (publication_id)
)
--> statement-breakpoint
comment on table analysis.subject_game_publications is 'The one current published analysis per subject game (database architecture 13.4). It pins the replay revision the published run read, so a later correction makes reanalysis pending without ever mixing a corrected replay with older assessments.'
--> statement-breakpoint
create index if not exists subject_game_publications_run on analysis.subject_game_publications (run_id)
--> statement-breakpoint
create index if not exists subject_game_publications_revision
  on analysis.subject_game_publications (replay_revision_id)
--> statement-breakpoint
create index if not exists subject_game_publications_recipe
  on analysis.subject_game_publications (recipe_version_id)
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Replay materialization publication history.
--
-- The pointer itself stays where E09 put it: the single run with
-- state = 'published', guarded by a partial unique index. What was missing is
-- the record of the moves -- who switched it, when, away from what, and why --
-- which is what makes rollback an append rather than an edit. Existing
-- published runs are backfilled below so the history is complete from the start
-- rather than beginning mid-story.
-- ---------------------------------------------------------------------------
create table if not exists chess.replay_materialization_publication_history (
  id uuid primary key default gen_random_uuid(),
  replay_revision_id bigint not null references chess.game_replay_revisions(id) on delete restrict,
  previous_run_id uuid references chess.materialization_runs(id) on delete restrict,
  run_id uuid not null references chess.materialization_runs(id) on delete restrict,
  reason text not null,
  actor_kind text not null,
  actor_id uuid references app.profiles(user_id) on delete set null,
  published_at timestamptz not null default now(),
  constraint materialization_history_reason_check check (reason in (
    'first_publication', 'new_run', 'recipe_promotion', 'rollback', 'reconciliation'
  )),
  constraint materialization_history_actor_kind_check check (actor_kind in ('user', 'system')),
  constraint materialization_history_actor_id_present
    check ((actor_kind = 'user') = (actor_id is not null)),
  constraint materialization_history_moves check (run_id is distinct from previous_run_id),
  constraint materialization_history_first_has_no_previous
    check (reason <> 'first_publication' or previous_run_id is null)
)
--> statement-breakpoint
comment on table chess.replay_materialization_publication_history is 'Append-only record of every materialization pointer move (database architecture 13.4). The current pointer remains chess.materialization_runs.state = ''published'', made single by its partial unique index; a second current-pointer table would be two rows that must agree about one fact.'
--> statement-breakpoint
create index if not exists materialization_history_revision
  on chess.replay_materialization_publication_history (replay_revision_id, published_at desc, id desc)
--> statement-breakpoint
create index if not exists materialization_history_run
  on chess.replay_materialization_publication_history (run_id)
--> statement-breakpoint
create index if not exists materialization_history_previous
  on chess.replay_materialization_publication_history (previous_run_id)
--> statement-breakpoint
create index if not exists materialization_history_actor
  on chess.replay_materialization_publication_history (actor_id)
--> statement-breakpoint
drop trigger if exists materialization_history_immutable
  on chess.replay_materialization_publication_history
--> statement-breakpoint
create trigger materialization_history_immutable
  before update or delete on chess.replay_materialization_publication_history
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint
-- Backfill: one 'reconciliation' row per already-published run, recording the
-- state this migration found rather than inventing a promotion that nobody
-- performed. Guarded by not exists, so re-running the migration adds nothing.
insert into chess.replay_materialization_publication_history
  (replay_revision_id, previous_run_id, run_id, reason, actor_kind, published_at)
select r.replay_revision_id, null, r.id, 'reconciliation', 'system',
       coalesce(r.published_at, r.created_at)
from chess.materialization_runs r
where r.state = 'published'
  and not exists (
    select 1 from chess.replay_materialization_publication_history h where h.run_id = r.id
  )
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Two foreign keys E08 left unindexed.
--
-- Platform spec §10 requires an index on every foreign key column, and E02's
-- database gate has flagged these since E08 shipped. They are added here rather
-- than by editing an applied migration, which is the unsafe way to fix a
-- committed file. Purely additive, and they matter on the paths they guard: the
-- revision pointer is followed on every correction, and the sync-run reference
-- is walked when a run is retired.
create index if not exists provider_games_current_revision
  on chess.provider_games (current_replay_revision_id)
--> statement-breakpoint
create index if not exists subject_game_sources_sync_run
  on chess.subject_game_sources (sync_run_id)
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Tenancy.
--
-- The version catalogue, recipes, cohorts and validation evidence are shared
-- and carry no subject, so they are protected by grants and API authorization,
-- per platform spec §10. Everything below holds one subject's rows, so it gets
-- a forced owner policy as well: defence in depth behind an API that already
-- takes the owner as an argument rather than as a filter it might forget.
-- ---------------------------------------------------------------------------
alter table analysis.subject_data_snapshots enable row level security
--> statement-breakpoint
alter table analysis.subject_data_snapshots force row level security
--> statement-breakpoint
drop policy if exists subject_snapshots_owner on analysis.subject_data_snapshots
--> statement-breakpoint
create policy subject_snapshots_owner on analysis.subject_data_snapshots
  using (
    exists (
      select 1 from app.analysis_subjects s
      where s.id = subject_id and s.owner_user_id = private.current_actor_id()
    )
  )
  with check (
    exists (
      select 1 from app.analysis_subjects s
      where s.id = subject_id and s.owner_user_id = private.current_actor_id()
    )
  )
--> statement-breakpoint
alter table analysis.subject_data_snapshot_games enable row level security
--> statement-breakpoint
alter table analysis.subject_data_snapshot_games force row level security
--> statement-breakpoint
drop policy if exists snapshot_games_owner on analysis.subject_data_snapshot_games
--> statement-breakpoint
create policy snapshot_games_owner on analysis.subject_data_snapshot_games
  using (
    exists (
      select 1 from analysis.subject_data_snapshots snap
      join app.analysis_subjects s on s.id = snap.subject_id
      where snap.id = snapshot_id and s.owner_user_id = private.current_actor_id()
    )
  )
  with check (
    exists (
      select 1 from analysis.subject_data_snapshots snap
      join app.analysis_subjects s on s.id = snap.subject_id
      where snap.id = snapshot_id and s.owner_user_id = private.current_actor_id()
    )
  )
--> statement-breakpoint
alter table analysis.runs enable row level security
--> statement-breakpoint
alter table analysis.runs force row level security
--> statement-breakpoint
drop policy if exists runs_owner on analysis.runs
--> statement-breakpoint
create policy runs_owner on analysis.runs
  using (
    exists (
      select 1 from app.analysis_subjects s
      where s.id = subject_id and s.owner_user_id = private.current_actor_id()
    )
  )
  with check (
    exists (
      select 1 from app.analysis_subjects s
      where s.id = subject_id and s.owner_user_id = private.current_actor_id()
    )
  )
--> statement-breakpoint
alter table analysis.run_dependencies enable row level security
--> statement-breakpoint
alter table analysis.run_dependencies force row level security
--> statement-breakpoint
drop policy if exists run_dependencies_owner on analysis.run_dependencies
--> statement-breakpoint
create policy run_dependencies_owner on analysis.run_dependencies
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
alter table analysis.run_artifacts enable row level security
--> statement-breakpoint
alter table analysis.run_artifacts force row level security
--> statement-breakpoint
drop policy if exists run_artifacts_owner on analysis.run_artifacts
--> statement-breakpoint
create policy run_artifacts_owner on analysis.run_artifacts
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
alter table analysis.subject_live_publications enable row level security
--> statement-breakpoint
alter table analysis.subject_live_publications force row level security
--> statement-breakpoint
drop policy if exists subject_live_publications_owner on analysis.subject_live_publications
--> statement-breakpoint
create policy subject_live_publications_owner on analysis.subject_live_publications
  using (
    exists (
      select 1 from app.analysis_subjects s
      where s.id = subject_id and s.owner_user_id = private.current_actor_id()
    )
  )
  with check (
    exists (
      select 1 from app.analysis_subjects s
      where s.id = subject_id and s.owner_user_id = private.current_actor_id()
    )
  )
--> statement-breakpoint
alter table analysis.subject_live_publication_history enable row level security
--> statement-breakpoint
alter table analysis.subject_live_publication_history force row level security
--> statement-breakpoint
drop policy if exists subject_live_history_owner on analysis.subject_live_publication_history
--> statement-breakpoint
create policy subject_live_history_owner on analysis.subject_live_publication_history
  using (
    exists (
      select 1 from app.analysis_subjects s
      where s.id = subject_id and s.owner_user_id = private.current_actor_id()
    )
  )
  with check (
    exists (
      select 1 from app.analysis_subjects s
      where s.id = subject_id and s.owner_user_id = private.current_actor_id()
    )
  )
--> statement-breakpoint
alter table analysis.subject_game_publications enable row level security
--> statement-breakpoint
alter table analysis.subject_game_publications force row level security
--> statement-breakpoint
drop policy if exists subject_game_publications_owner on analysis.subject_game_publications
--> statement-breakpoint
create policy subject_game_publications_owner on analysis.subject_game_publications
  using (
    exists (
      select 1 from chess.subject_games g
      join app.analysis_subjects s on s.id = g.subject_id
      where g.id = subject_game_id and s.owner_user_id = private.current_actor_id()
    )
  )
  with check (
    exists (
      select 1 from chess.subject_games g
      join app.analysis_subjects s on s.id = g.subject_id
      where g.id = subject_game_id and s.owner_user_id = private.current_actor_id()
    )
  )
--> statement-breakpoint
alter table analysis.subject_game_publication_history enable row level security
--> statement-breakpoint
alter table analysis.subject_game_publication_history force row level security
--> statement-breakpoint
drop policy if exists subject_game_history_owner on analysis.subject_game_publication_history
--> statement-breakpoint
create policy subject_game_history_owner on analysis.subject_game_publication_history
  using (
    exists (
      select 1 from chess.subject_games g
      join app.analysis_subjects s on s.id = g.subject_id
      where g.id = subject_game_id and s.owner_user_id = private.current_actor_id()
    )
  )
  with check (
    exists (
      select 1 from chess.subject_games g
      join app.analysis_subjects s on s.id = g.subject_id
      where g.id = subject_game_id and s.owner_user_id = private.current_actor_id()
    )
  )
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Grants.
--
-- forma_analysis produces this graph and is the only role that writes it.
-- forma_api reads it and cannot promote, publish or roll back: those are
-- operator and worker actions, so a compromised browser-facing process cannot
-- move a pointer. forma_ops promotes recipes and records lifecycle events --
-- the two deliberate human decisions here -- and nothing else.
--
-- forma_stockfish reads the shared version catalogue, because it needs to know
-- which engine profile it is running, and reaches no subject-scoped table at
-- all. E02 withholds `private.set_actor_context` from it deliberately: it
-- evaluates positions, which are anonymous, and has no business claiming to act
-- for a user. Granting it select on analysis.runs would have been a grant it
-- could never exercise -- the owner policy calls a function it may not execute
-- -- which is worse than no grant, because it reads as intended access.
-- ---------------------------------------------------------------------------
grant select, insert on analysis.components to forma_analysis, forma_ops
--> statement-breakpoint
grant select on analysis.components to forma_api, forma_stockfish
--> statement-breakpoint
grant select, insert on analysis.component_versions to forma_analysis, forma_ops
--> statement-breakpoint
grant select on analysis.component_versions to forma_api, forma_stockfish
--> statement-breakpoint
grant select, insert on analysis.component_version_dependencies to forma_analysis, forma_ops
--> statement-breakpoint
grant select on analysis.component_version_dependencies to forma_api, forma_stockfish
--> statement-breakpoint
grant select, insert on analysis.recipe_versions to forma_analysis, forma_ops
--> statement-breakpoint
grant select on analysis.recipe_versions to forma_api, forma_stockfish
--> statement-breakpoint
grant select, insert on analysis.recipe_components to forma_analysis, forma_ops
--> statement-breakpoint
grant select on analysis.recipe_components to forma_api, forma_stockfish
--> statement-breakpoint
grant select, insert on analysis.recipe_promotions to forma_ops
--> statement-breakpoint
grant select on analysis.recipe_promotions to forma_api, forma_analysis, forma_stockfish
--> statement-breakpoint
grant select, insert on analysis.cohort_definition_versions to forma_analysis, forma_ops
--> statement-breakpoint
grant select on analysis.cohort_definition_versions to forma_api
--> statement-breakpoint
grant select, insert on analysis.validation_datasets to forma_analysis, forma_ops
--> statement-breakpoint
grant select on analysis.validation_datasets to forma_api
--> statement-breakpoint
grant select, insert on analysis.validation_runs to forma_analysis
--> statement-breakpoint
grant select on analysis.validation_runs to forma_api, forma_ops
--> statement-breakpoint
grant select, insert on analysis.validation_metrics to forma_analysis
--> statement-breakpoint
grant usage, select on sequence analysis.validation_metrics_id_seq to forma_analysis
--> statement-breakpoint
grant select on analysis.validation_metrics to forma_api, forma_ops
--> statement-breakpoint
grant select, insert on analysis.component_lifecycle_events to forma_ops
--> statement-breakpoint
grant usage, select on sequence analysis.component_lifecycle_events_id_seq to forma_ops
--> statement-breakpoint
grant select on analysis.component_lifecycle_events to forma_api, forma_analysis
--> statement-breakpoint
grant usage, select on sequence analysis.recipe_promotions_id_seq to forma_ops
--> statement-breakpoint
grant select, insert on analysis.subject_data_snapshots to forma_analysis
--> statement-breakpoint
grant select on analysis.subject_data_snapshots to forma_api, forma_ops
--> statement-breakpoint
grant select, insert on analysis.subject_data_snapshot_games to forma_analysis
--> statement-breakpoint
grant select on analysis.subject_data_snapshot_games to forma_api, forma_ops
--> statement-breakpoint
-- update, because a run moves planned -> running -> terminal. The trigger is
-- what bounds that update; the grant only says who may attempt it.
grant select, insert, update on analysis.runs to forma_analysis
--> statement-breakpoint
grant select on analysis.runs to forma_api, forma_ops
--> statement-breakpoint
grant select, insert on analysis.run_dependencies to forma_analysis
--> statement-breakpoint
grant select on analysis.run_dependencies to forma_api, forma_ops
--> statement-breakpoint
grant select, insert on analysis.run_artifacts to forma_analysis
--> statement-breakpoint
grant select on analysis.run_artifacts to forma_api, forma_ops
--> statement-breakpoint
grant select, insert, update on analysis.subject_live_publications to forma_analysis
--> statement-breakpoint
grant select on analysis.subject_live_publications to forma_api, forma_ops
--> statement-breakpoint
grant select, insert on analysis.subject_live_publication_history to forma_analysis
--> statement-breakpoint
grant select on analysis.subject_live_publication_history to forma_api, forma_ops
--> statement-breakpoint
grant select, insert, update on analysis.subject_game_publications to forma_analysis
--> statement-breakpoint
grant select on analysis.subject_game_publications to forma_api, forma_ops
--> statement-breakpoint
grant select, insert on analysis.subject_game_publication_history to forma_analysis
--> statement-breakpoint
grant select on analysis.subject_game_publication_history to forma_api, forma_ops
--> statement-breakpoint
grant select, insert on chess.replay_materialization_publication_history to forma_analysis
--> statement-breakpoint
grant select on chess.replay_materialization_publication_history
  to forma_api, forma_ops, forma_ingestion, forma_stockfish
--> statement-breakpoint
-- The browser roles reach none of it. E01's containment is per-object, so a new
-- table is only contained once it says so.
revoke all on analysis.components, analysis.component_versions from public
--> statement-breakpoint
revoke all on analysis.component_version_dependencies, analysis.component_lifecycle_events from public
--> statement-breakpoint
revoke all on analysis.recipe_versions, analysis.recipe_components from public
--> statement-breakpoint
revoke all on analysis.recipe_promotions, analysis.cohort_definition_versions from public
--> statement-breakpoint
revoke all on analysis.validation_datasets, analysis.validation_runs from public
--> statement-breakpoint
revoke all on analysis.validation_metrics from public
--> statement-breakpoint
revoke all on analysis.subject_data_snapshots, analysis.subject_data_snapshot_games from public
--> statement-breakpoint
revoke all on analysis.runs, analysis.run_dependencies, analysis.run_artifacts from public
--> statement-breakpoint
revoke all on analysis.subject_live_publications, analysis.subject_live_publication_history from public
--> statement-breakpoint
revoke all on analysis.subject_game_publications, analysis.subject_game_publication_history from public
--> statement-breakpoint
revoke all on chess.replay_materialization_publication_history from public
--> statement-breakpoint
reset role

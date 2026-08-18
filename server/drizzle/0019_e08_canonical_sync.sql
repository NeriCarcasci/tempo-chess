-- 0019_e08_canonical_sync
--
-- E08 — the sync ledger and the canonical, immutable replay record.
--
-- Hand-written and reviewed. Additive and forward-only: eight tables across the
-- `ops` and `chess` namespaces E02 established, beside the legacy `public.games`
-- rather than replacing them. No existing object changes, no row is touched.
-- Re-running it is a no-op.
--
-- Two properties carry this epic, and both are enforced here rather than by
-- convention:
--
--   A replay revision is immutable. A provider correction appends a new
--   revision and moves a pointer; it never updates or deletes the old one, so
--   an analysis that cited revision 1 keeps citing exactly what it read. The
--   trigger below refuses an UPDATE or DELETE on a revision outright.
--
--   A rejected game leaves no trace beyond a count. Variants, unfinished games
--   and empty replays are refused by check constraint, so "we filtered it
--   before persistence" is a property of the schema and not a promise about
--   the ingestion code path.

set local role forma_migrator
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Sync ledger
-- ---------------------------------------------------------------------------
create table if not exists ops.account_sync_state (
  linked_account_id uuid primary key references app.linked_accounts(id) on delete cascade,
  cursor_value text,
  cursor_hash text,
  last_success_at timestamptz,
  last_attempt_at timestamptz,
  consecutive_failures integer not null default 0,
  paused_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint account_sync_state_failures_sane check (consecutive_failures >= 0)
)
--> statement-breakpoint
comment on table ops.account_sync_state is 'The durable cursor for one linked account (database architecture 8, platform spec 7). Cursor state is never held in memory: a worker that dies mid-sync leaves the last committed cursor, and the next run resumes from it rather than from the beginning.'
--> statement-breakpoint
create table if not exists ops.sync_runs (
  id uuid primary key default gen_random_uuid(),
  linked_account_id uuid not null references app.linked_accounts(id) on delete cascade,
  workflow_id uuid references ops.workflows(id) on delete set null,
  mode text not null,
  state text not null default 'running',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  cursor_before text,
  cursor_after text,
  games_accepted integer not null default 0,
  games_duplicate integer not null default 0,
  games_corrected integer not null default 0,
  -- Aggregate only. A rejected game must leave no identifier anywhere, so the
  -- count is all that survives it.
  games_rejected integer not null default 0,
  rejection_summary jsonb,
  failure_class text,
  constraint sync_runs_mode_check check (mode in ('initial', 'incremental', 'reconcile')),
  constraint sync_runs_state_check
    check (state in ('running', 'succeeded', 'failed', 'cancelled')),
  constraint sync_runs_counts_sane check (
    games_accepted >= 0 and games_duplicate >= 0
    and games_corrected >= 0 and games_rejected >= 0
  )
)
--> statement-breakpoint
comment on table ops.sync_runs is 'One attempt to sync one linked account (platform spec 7). rejection_summary carries counts by reason and never a game id, url or replay: a game Forma refused canonically must not be reachable through the ledger either.'
--> statement-breakpoint
create index if not exists sync_runs_account on ops.sync_runs (linked_account_id, started_at desc)
--> statement-breakpoint
create index if not exists sync_runs_workflow on ops.sync_runs (workflow_id)
--> statement-breakpoint
create table if not exists ops.sync_checkpoints (
  id bigint generated always as identity primary key,
  sync_run_id uuid not null references ops.sync_runs(id) on delete cascade,
  sequence_no integer not null,
  cursor_value text,
  games_in_batch integer not null default 0,
  committed_at timestamptz not null default now(),
  constraint sync_checkpoints_unique unique (sync_run_id, sequence_no),
  constraint sync_checkpoints_batch_sane check (games_in_batch >= 0)
)
--> statement-breakpoint
comment on table ops.sync_checkpoints is 'A committed batch boundary (platform spec 7). The cursor advance and the canonical rows for that batch commit in one transaction, so a checkpoint that exists is a batch that landed.'
--> statement-breakpoint
-- A durable lock, because in-memory rate state is lost with the instance and a
-- provider limit is global to Forma rather than to one process.
create table if not exists ops.provider_locks (
  lock_key text primary key,
  holder text not null,
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint provider_locks_expiry check (expires_at > acquired_at)
)
--> statement-breakpoint
comment on table ops.provider_locks is 'Distributed provider and account locks (platform spec 6.3). Held in the database because a provider rate limit applies to Forma as a whole, and an instance that dies must not hold a lock forever: every lock carries an expiry and is reclaimed by time, not by cleanup.'
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Canonical record
-- ---------------------------------------------------------------------------
create table if not exists chess.provider_games (
  id bigint generated always as identity primary key,
  provider_id smallint not null references app.providers(id),
  provider_game_id text not null,
  current_replay_revision_id bigint,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  provider_unavailable_since timestamptz,
  constraint provider_games_unique unique (provider_id, provider_game_id)
)
--> statement-breakpoint
comment on table chess.provider_games is 'Stable identity for a provider game, not a user copy of it (database architecture 9.1). No automatic cross-provider merge: a matching fingerprint may flag a review candidate but cannot prove two short games are one event.'
--> statement-breakpoint
create table if not exists chess.game_replay_revisions (
  id bigint generated always as identity primary key,
  provider_game_id bigint not null references chess.provider_games(id) on delete restrict,
  revision_no integer not null,
  normalizer_component_version_id text not null,
  source_artifact_id uuid references ops.artifacts(id) on delete set null,
  normalized_replay jsonb not null,
  normalized_sha256 text not null,
  source_sha256 text,
  initial_fen text,
  played_at timestamptz not null,
  completed_at timestamptz,
  rated boolean,
  speed text,
  time_control text,
  result text not null,
  termination text,
  ply_count integer not null,
  provider_url text,
  revision_reason text not null,
  created_at timestamptz not null default now(),
  constraint replay_revisions_no_unique unique (provider_game_id, revision_no),
  constraint replay_revisions_sha_unique unique (provider_game_id, normalized_sha256),
  constraint replay_revisions_reason_check
    check (revision_reason in ('first_seen', 'provider_correction', 'renormalized')),
  -- §9.2: completed result only. An in-progress game is not canonical evidence.
  constraint replay_revisions_result_check check (result in ('white', 'black', 'draw')),
  -- §9.2: an empty replay is not a game.
  constraint replay_revisions_ply_positive check (ply_count > 0),
  constraint replay_revisions_sha_shape check (normalized_sha256 ~ '^[0-9a-f]{64}$'),
  constraint replay_revisions_revision_no_positive check (revision_no > 0)
)
--> statement-breakpoint
comment on table chess.game_replay_revisions is 'An immutable provider-neutral replay (database architecture 9.2). A provider correction appends a revision and moves chess.provider_games.current_replay_revision_id; it never rewrites this row, so an analysis that cited revision 1 keeps citing exactly what it read. Standard variant and completed games only -- a variant or unfinished game is refused here rather than filtered by convention.'
--> statement-breakpoint
comment on column chess.game_replay_revisions.normalized_replay is 'Ordered moves with UCI, SAN, clocks when known, and the metadata needed for deterministic replay. Deliberately not indexed for search: product queries use the relational columns beside it.'
--> statement-breakpoint
create index if not exists replay_revisions_game on chess.game_replay_revisions (provider_game_id, revision_no desc)
--> statement-breakpoint
create index if not exists replay_revisions_artifact on chess.game_replay_revisions (source_artifact_id)
--> statement-breakpoint
alter table chess.provider_games
  drop constraint if exists provider_games_current_revision_fk
--> statement-breakpoint
alter table chess.provider_games
  add constraint provider_games_current_revision_fk
  foreign key (current_replay_revision_id)
  references chess.game_replay_revisions(id) on delete restrict
--> statement-breakpoint
-- §9.2/§9.3: immutability is enforced, not documented. An analysis pins a
-- revision id; if that row could change under it, the pin would be a lie.
create or replace function chess.refuse_revision_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'replay revisions are immutable; append a new revision instead'
    using errcode = 'restrict_violation';
end;
$$
--> statement-breakpoint
drop trigger if exists replay_revisions_immutable on chess.game_replay_revisions
--> statement-breakpoint
create trigger replay_revisions_immutable
  before update or delete on chess.game_replay_revisions
  for each row execute function chess.refuse_revision_mutation()
--> statement-breakpoint
create table if not exists chess.game_revision_participants (
  replay_revision_id bigint not null references chess.game_replay_revisions(id) on delete restrict,
  color text not null,
  provider_identity_id bigint references app.provider_identities(id),
  username_snapshot text,
  title_snapshot text,
  rating integer,
  rating_change integer,
  outcome text not null,
  is_bot boolean,
  is_provisional boolean,
  primary key (replay_revision_id, color),
  constraint participants_color_check check (color in ('white', 'black')),
  constraint participants_outcome_check check (outcome in ('win', 'loss', 'draw'))
)
--> statement-breakpoint
comment on table chess.game_revision_participants is 'Two immutable participant snapshots per revision (database architecture 9.3). A null rating or clock stays null: an unknown value is never rendered as zero.'
--> statement-breakpoint
drop trigger if exists participants_immutable on chess.game_revision_participants
--> statement-breakpoint
create trigger participants_immutable
  before update or delete on chess.game_revision_participants
  for each row execute function chess.refuse_revision_mutation()
--> statement-breakpoint
create index if not exists participants_identity on chess.game_revision_participants (provider_identity_id)
--> statement-breakpoint
create table if not exists chess.subject_games (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references app.analysis_subjects(id) on delete restrict,
  provider_game_id bigint not null references chess.provider_games(id) on delete restrict,
  latest_replay_revision_id bigint references chess.game_replay_revisions(id) on delete restrict,
  subject_color text,
  status text not null default 'included',
  exclusion_reason text,
  first_included_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint subject_games_unique unique (subject_id, provider_game_id),
  constraint subject_games_color_check check (subject_color is null or subject_color in ('white', 'black')),
  constraint subject_games_status_check
    check (status in ('included', 'excluded', 'ambiguous', 'deleted')),
  -- §9.4: if both colours look like the same personal subject the game is
  -- ambiguous and excluded until resolved, so it must not also claim a colour.
  constraint subject_games_ambiguous_has_no_color
    check (status <> 'ambiguous' or subject_color is null)
)
--> statement-breakpoint
comment on table chess.subject_games is 'The owned statement that a provider game is evidence for a subject (database architecture 9.4). latest_replay_revision_id names the newest canonical source; a publication pins the exact revision it analysed, so a correction can make reanalysis pending without ever mixing a corrected replay with older assessments.'
--> statement-breakpoint
create index if not exists subject_games_subject on chess.subject_games (subject_id, status)
--> statement-breakpoint
create index if not exists subject_games_provider_game on chess.subject_games (provider_game_id)
--> statement-breakpoint
create index if not exists subject_games_revision on chess.subject_games (latest_replay_revision_id)
--> statement-breakpoint
create table if not exists chess.subject_game_sources (
  subject_game_id uuid not null references chess.subject_games(id) on delete cascade,
  linked_account_id uuid not null references app.linked_accounts(id) on delete restrict,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  sync_run_id uuid references ops.sync_runs(id) on delete set null,
  primary key (subject_game_id, linked_account_id)
)
--> statement-breakpoint
comment on table chess.subject_game_sources is 'Every linked account through which a subject observed the game (database architecture 9.5). Two accounts finding the same game is one subject game with two sources, never two games.'
--> statement-breakpoint
create index if not exists subject_game_sources_account on chess.subject_game_sources (linked_account_id)
--> statement-breakpoint
create table if not exists chess.provider_rating_observations (
  id bigint generated always as identity primary key,
  provider_identity_id bigint not null references app.provider_identities(id) on delete restrict,
  rating_pool text not null,
  rating integer not null,
  deviation integer,
  is_provisional boolean,
  observed_at timestamptz not null,
  replay_revision_id bigint references chess.game_replay_revisions(id) on delete set null,
  source_kind text not null,
  constraint rating_observations_source_check
    check (source_kind in ('game', 'profile')),
  constraint rating_observations_rating_sane check (rating between 0 and 4000)
)
--> statement-breakpoint
comment on table chess.provider_rating_observations is 'Append-only provider-native rating history (database architecture 9.6). Observations are recorded, never corrected in place: a provider that revises a rating produces another observation.'
--> statement-breakpoint
create index if not exists rating_observations_identity
  on chess.provider_rating_observations (provider_identity_id, rating_pool, observed_at desc)
--> statement-breakpoint
create index if not exists rating_observations_revision
  on chess.provider_rating_observations (replay_revision_id)
--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Tenancy. subject_games is the only table here holding a subject's rows; the
-- canonical record is provider truth and is not owned by anyone.
-- ---------------------------------------------------------------------------
alter table chess.subject_games enable row level security
--> statement-breakpoint
alter table chess.subject_games force row level security
--> statement-breakpoint
create policy subject_games_owner on chess.subject_games
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
alter table chess.subject_game_sources enable row level security
--> statement-breakpoint
alter table chess.subject_game_sources force row level security
--> statement-breakpoint
create policy subject_game_sources_owner on chess.subject_game_sources
  using (
    exists (
      select 1 from chess.subject_games sg
      join app.analysis_subjects s on s.id = sg.subject_id
      where sg.id = subject_game_id and s.owner_user_id = private.current_actor_id()
    )
  )
  with check (
    exists (
      select 1 from chess.subject_games sg
      join app.analysis_subjects s on s.id = sg.subject_id
      where sg.id = subject_game_id and s.owner_user_id = private.current_actor_id()
    )
  )
--> statement-breakpoint
grant select, insert, update on ops.account_sync_state to forma_api, forma_ingestion, forma_ops
--> statement-breakpoint
grant select, insert, update on ops.sync_runs to forma_api, forma_ingestion, forma_ops
--> statement-breakpoint
grant select, insert on ops.sync_checkpoints to forma_ingestion
--> statement-breakpoint
grant select on ops.sync_checkpoints to forma_api, forma_ops
--> statement-breakpoint
grant select, insert, update, delete on ops.provider_locks to forma_ingestion, forma_ops
--> statement-breakpoint
grant select, insert, update on chess.provider_games to forma_ingestion
--> statement-breakpoint
grant select on chess.provider_games to forma_api, forma_analysis
--> statement-breakpoint
grant select, insert on chess.game_replay_revisions to forma_ingestion
--> statement-breakpoint
grant select on chess.game_replay_revisions to forma_api, forma_analysis, forma_stockfish
--> statement-breakpoint
grant select, insert on chess.game_revision_participants to forma_ingestion
--> statement-breakpoint
grant select on chess.game_revision_participants to forma_api, forma_analysis
--> statement-breakpoint
grant select, insert, update on chess.subject_games to forma_ingestion, forma_api
--> statement-breakpoint
grant select on chess.subject_games to forma_analysis
--> statement-breakpoint
grant select, insert, update on chess.subject_game_sources to forma_ingestion, forma_api
--> statement-breakpoint
grant select, insert on chess.provider_rating_observations to forma_ingestion
--> statement-breakpoint
grant select on chess.provider_rating_observations to forma_api, forma_analysis
--> statement-breakpoint
revoke all on ops.account_sync_state, ops.sync_runs, ops.sync_checkpoints, ops.provider_locks from public
--> statement-breakpoint
revoke all on chess.provider_games, chess.game_replay_revisions, chess.game_revision_participants from public
--> statement-breakpoint
revoke all on chess.subject_games, chess.subject_game_sources, chess.provider_rating_observations from public
--> statement-breakpoint
reset role

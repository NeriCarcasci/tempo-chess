-- 0020_e09_positions
--
-- E09 — core positions, occurrence chains, transitions and their publication.
--
-- Hand-written and reviewed. Additive and forward-only: four tables in the
-- `chess` namespace beside the legacy `public` moves, no existing object
-- changed, no row touched. Re-running it is a no-op.
--
-- The separation this epic exists for: a *core position* is the board, side to
-- move, castling rights and a legal en-passant square, and nothing else. It is
-- history-free, which is what makes a transposition findable. An *occurrence*
-- is that position at a ply of a replay, and carries the history the key omits
-- -- halfmove clock, fullmove number, repetition count. The same core with
-- different history stays distinct here because they are different rows in
-- different tables, not because a query remembers to check.
--
-- Materialization is immutable and published by pointer. A rebuild writes a new
-- run, its checksum is compared, and only then does it become the published one
-- -- so a rebuild that disagrees with its predecessor is a visible fact rather
-- than a silent overwrite.

set local role forma_migrator
--> statement-breakpoint
create table if not exists chess.core_positions (
  id bigint generated always as identity primary key,
  core_key_hash text not null,
  core_key text not null,
  board text not null,
  turn text not null,
  castling text not null,
  en_passant text not null,
  first_seen_at timestamptz not null default now(),
  constraint core_positions_hash_unique unique (core_key_hash),
  constraint core_positions_turn_check check (turn in ('w', 'b')),
  constraint core_positions_hash_shape check (core_key_hash ~ '^[0-9a-f]{64}$'),
  -- The key is four fields. A five-field key would mean a clock leaked in, and
  -- every transposition would become a distinct position.
  constraint core_positions_key_shape
    check (array_length(string_to_array(core_key, ' '), 1) = 4)
)
--> statement-breakpoint
comment on table chess.core_positions is 'A position identified by board, side to move, castling rights and a legal en-passant square only (database architecture 10). Deliberately history-free: halfmove and fullmove counters live on the occurrence, because including them would make every transposition a different position. The en-passant square is present only when a capture onto it is legal, so a pawn double-step with no taker does not split one position in two.'
--> statement-breakpoint
create table if not exists chess.materialization_runs (
  id uuid primary key default gen_random_uuid(),
  replay_revision_id bigint not null references chess.game_replay_revisions(id) on delete restrict,
  materializer_version text not null,
  checksum text not null,
  state text not null default 'building',
  occurrence_count integer not null default 0,
  transition_count integer not null default 0,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  failure_class text,
  constraint materialization_runs_state_check
    check (state in ('building', 'published', 'superseded', 'failed')),
  constraint materialization_runs_checksum_shape check (checksum ~ '^[0-9a-f]{64}$'),
  -- A published run has a chain: ply+1 occurrences for its transitions.
  constraint materialization_runs_chain_shape check (
    state <> 'published' or occurrence_count = transition_count + 1
  ),
  constraint materialization_runs_published_at check (
    (state = 'published') = (published_at is not null)
  )
)
--> statement-breakpoint
comment on table chess.materialization_runs is 'One immutable attempt to materialize a replay (database architecture 11). A rebuild is a new run; publication is a pointer move after its checksum has been compared, so a rebuild that disagrees is visible rather than silently overwriting the chain an analysis cited.'
--> statement-breakpoint
-- Exactly one published run per replay revision. Partial, so superseded and
-- failed runs are retained for comparison.
create unique index if not exists materialization_runs_one_published
  on chess.materialization_runs (replay_revision_id) where state = 'published'
--> statement-breakpoint
create index if not exists materialization_runs_revision
  on chess.materialization_runs (replay_revision_id, created_at desc)
--> statement-breakpoint
create table if not exists chess.position_occurrences (
  run_id uuid not null references chess.materialization_runs(id) on delete cascade,
  ply integer not null,
  core_position_id bigint not null references chess.core_positions(id) on delete restrict,
  fen text not null,
  halfmove_clock integer not null,
  fullmove_number integer not null,
  repetition_count integer not null,
  side_to_move text not null,
  threefold boolean not null default false,
  fivefold boolean not null default false,
  fifty_move_available boolean not null default false,
  seventy_five_move_forced boolean not null default false,
  primary key (run_id, ply),
  constraint occurrences_ply_non_negative check (ply >= 0),
  constraint occurrences_side_check check (side_to_move in ('w', 'b')),
  constraint occurrences_counters_sane check (
    halfmove_clock >= 0 and fullmove_number >= 1 and repetition_count >= 1
  ),
  -- The draw flags are derived, so they may not disagree with what they derive
  -- from. A row claiming threefold at the first occurrence is a bug, not data.
  constraint occurrences_threefold_consistent check (threefold = (repetition_count >= 3)),
  constraint occurrences_fivefold_consistent check (fivefold = (repetition_count >= 5)),
  constraint occurrences_fifty_consistent check (fifty_move_available = (halfmove_clock >= 100)),
  constraint occurrences_seventyfive_consistent
    check (seventy_five_move_forced = (halfmove_clock >= 150))
)
--> statement-breakpoint
comment on table chess.position_occurrences is 'A core position at one ply of one materialization run (database architecture 10). Carries the history the core key omits, so two games reaching the same board share a core_position_id and keep separate occurrence context. The draw flags are constrained to agree with the counters they derive from.'
--> statement-breakpoint
-- The exact-position lookup: every occurrence of a core position. Keyset order
-- is (core_position_id, run_id, ply), which is the index below.
create index if not exists occurrences_by_core
  on chess.position_occurrences (core_position_id, run_id, ply)
--> statement-breakpoint
create table if not exists chess.position_transitions (
  run_id uuid not null references chess.materialization_runs(id) on delete cascade,
  from_ply integer not null,
  to_ply integer not null,
  uci text not null,
  san text,
  clock_ms integer,
  primary key (run_id, from_ply),
  -- A transition always advances exactly one ply. This is what makes the chain
  -- unbroken by construction rather than by a validation pass.
  constraint transitions_adjacent check (to_ply = from_ply + 1),
  constraint transitions_from_non_negative check (from_ply >= 0),
  constraint transitions_uci_shape check (uci ~ '^[a-h][1-8][a-h][1-8][qrbn]?$')
)
--> statement-breakpoint
comment on table chess.position_transitions is 'The move between two adjacent occurrences of one run (database architecture 10). to_ply = from_ply + 1 is a constraint, so a chain with a hole cannot be stored.'
--> statement-breakpoint
create index if not exists transitions_by_run on chess.position_transitions (run_id, from_ply)
--> statement-breakpoint
-- Materialization is derived from provider truth, not owned by a subject, so it
-- is readable by any bound actor and writable only by the analysis worker.
grant select, insert on chess.core_positions to forma_analysis, forma_ingestion
--> statement-breakpoint
grant select on chess.core_positions to forma_api, forma_stockfish
--> statement-breakpoint
grant select, insert, update on chess.materialization_runs to forma_analysis
--> statement-breakpoint
grant select on chess.materialization_runs to forma_api, forma_stockfish, forma_ingestion
--> statement-breakpoint
grant select, insert on chess.position_occurrences to forma_analysis
--> statement-breakpoint
grant select on chess.position_occurrences to forma_api, forma_stockfish
--> statement-breakpoint
grant select, insert on chess.position_transitions to forma_analysis
--> statement-breakpoint
grant select on chess.position_transitions to forma_api, forma_stockfish
--> statement-breakpoint
revoke all on chess.core_positions, chess.materialization_runs from public
--> statement-breakpoint
revoke all on chess.position_occurrences, chess.position_transitions from public
--> statement-breakpoint
reset role

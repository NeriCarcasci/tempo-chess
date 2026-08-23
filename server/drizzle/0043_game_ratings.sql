-- 0043_game_ratings
--
-- Rating a game somebody pasted is durable work with no subject, no game row
-- and no player. It is its own workflow kind and its own queue for one reason:
-- a rating is a few hundred human-policy inferences and a player's move is one,
-- so sharing `maia-play` would put an interactive reply behind a stranger's
-- pasted game. Cloud Tasks makes concurrency a property of the queue, so a
-- separate queue is the only place that can be stated.
--
-- `forma-maia` goes from two instances to three: two stay with play, one is the
-- rating worker. Not four, which is what ratings would want, because the
-- aggregate connection budget has exactly one connection spare.

alter role forma_maia connection limit 3
--> statement-breakpoint
comment on role forma_maia is
  'Interactive Maia CPU policy-serving role. Reads canonical positions and promoted model identity, writes anonymous policy cache rows, and advances only its durable work attempts. Serves both maia-play and maia-rating; the queues differ, the role does not.'
--> statement-breakpoint

set local role forma_migrator
--> statement-breakpoint
alter table ops.workflows drop constraint if exists workflows_kind_check
--> statement-breakpoint
alter table ops.workflows add constraint workflows_kind_check
  check (kind in (
    'account_sync', 'game_import', 'initial_examination', 'game_analysis',
    'model_backfill', 'subject_estimation', 'maintenance', 'position_evaluation',
    'position_continuation', 'game_rating'
  ))
--> statement-breakpoint
comment on constraint workflows_kind_check on ops.workflows is
  'Closed product-operation vocabulary. game_rating is deliberately distinct from game_analysis: it owns no subject, writes no game row, and produces one number about a game Forma may never see again.'
--> statement-breakpoint
alter table ops.work_items drop constraint if exists work_items_queue_check
--> statement-breakpoint
alter table ops.work_items add constraint work_items_queue_check
  check (queue is null or queue in (
    'provider-lichess', 'provider-chesscom', 'stockfish-screen', 'stockfish-deep',
    'analysis', 'maia-play', 'maia-rating', 'maintenance'
  ))
--> statement-breakpoint

-- The rating itself.
--
-- Keyed by the game and the method, never by the person who asked. Two people
-- pasting the same moves under the same method get the same row, which is what
-- makes a famous game cheap after the first time and is the whole economics of
-- the public page.
--
-- `game_key` covers the starting position, the moves, and any declared ratings,
-- because those are exactly the inputs the rating depends on. It deliberately
-- does not cover the result: the metric never reads who won, so two pastes that
-- disagree about the result tag must not produce two rows.
create table if not exists analysis.game_ratings (
  id uuid primary key default gen_random_uuid(),
  game_key text not null,
  method_key text not null,
  method_version text not null,
  method_hash text not null,
  workflow_id uuid not null references ops.workflows(id) on delete restrict,
  status text not null,
  unavailable_reason text,
  rating numeric(3, 1),
  rating_low numeric(3, 1),
  rating_high numeric(3, 1),
  -- The published decomposition, whole. The headline is not stored without it,
  -- for the same reason the API never returns one without the other. Named
  -- `rating_view` rather than `view` so no reader and no parser has to decide
  -- whether a bare keyword was meant as a column.
  rating_view jsonb not null,
  created_at timestamptz not null default now(),
  constraint game_ratings_unique unique (game_key, method_hash),
  constraint game_ratings_status_check check (status in ('available', 'unavailable')),
  constraint game_ratings_hash_shape check (method_hash ~ '^[0-9a-f]{64}$'),
  -- Available means the whole headline is present. Unavailable means none of it
  -- is and a reason is. A half-populated row is the shape a fabricated rating
  -- takes, and the same rule the practical-context table already applies.
  constraint game_ratings_shape check (
    (status = 'available'
      and rating is not null and rating_low is not null and rating_high is not null
      and unavailable_reason is null)
    or
    (status = 'unavailable'
      and rating is null and rating_low is null and rating_high is null
      and unavailable_reason is not null)
  ),
  constraint game_ratings_scale check (
    rating is null or (rating >= 0 and rating <= 10)
  ),
  constraint game_ratings_interval check (
    rating_low is null or rating_high is null or rating_low <= rating_high
  ),
  constraint game_ratings_contains_point check (
    rating is null or (rating >= rating_low and rating <= rating_high)
  )
)
--> statement-breakpoint
comment on table analysis.game_ratings is
  'One published game rating, keyed by the game and the method that produced it. Immutable: a method change is a new row, so a rating quoted in public never silently moves.'
--> statement-breakpoint
create index if not exists game_ratings_game_key_idx on analysis.game_ratings (game_key)
--> statement-breakpoint
create index if not exists game_ratings_workflow_idx on analysis.game_ratings (workflow_id)
--> statement-breakpoint
drop trigger if exists game_ratings_immutable on analysis.game_ratings
--> statement-breakpoint
create trigger game_ratings_immutable
  before update or delete on analysis.game_ratings
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint

-- forma-analysis assembles and writes the rating; forma-api reads it to answer
-- the public page. Neither needs the other's grant, and forma-maia needs no new
-- grant at all: it writes policy inferences, which it could already do.
grant select, insert on analysis.game_ratings to forma_analysis
--> statement-breakpoint
grant select on analysis.game_ratings to forma_api
--> statement-breakpoint
grant select on analysis.game_ratings to forma_ops

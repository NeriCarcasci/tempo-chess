-- 0044_game_rating_plans
--
-- Where the engine leaves its half of a rating for the scheduler to pick up.
--
-- A rating is two stages and the second cannot be described until the first has
-- run: which positions deserve the human policy depends on what the engine said
-- about them. The first attempt had the engine service create the second
-- workflow itself, and the database refused, correctly. `forma_stockfish` holds
-- `select, update` on `ops.workflows` and no `insert`, because workers execute
-- work and only `forma_api` schedules it. That is a boundary worth keeping: a
-- worker that can enqueue arbitrary work is a worker that can spend the
-- platform's budget without anybody asking it to.
--
-- So the engine writes a plan here and schedules nothing. The API reads it on
-- the next poll it is already serving and creates the second workflow, which is
-- the one thing it has always been allowed to do. No role gains a privilege.

set local role forma_migrator
--> statement-breakpoint

create table if not exists analysis.game_rating_plans (
  id uuid primary key default gen_random_uuid(),
  game_key text not null,
  method_hash text not null,
  workflow_id uuid not null references ops.workflows(id) on delete restrict,
  -- The selected plies and the positions to ask about, and the deeper searches
  -- that justified the selection. Both are needed again at assembly, so they
  -- are stored rather than recomputed: a second search would cost the same
  -- money to reach the same answer, and could reach a different one.
  plan jsonb not null,
  deep jsonb not null,
  -- The game itself, so the scheduler and the assembler both work from what was
  -- actually rated rather than from whatever a later caller happens to paste.
  -- It also means the poll can advance the chain without the client resending
  -- anything, which is what lets a shared link finish somebody else's rating.
  pgn text not null,
  white_rating integer,
  black_rating integer,
  created_at timestamptz not null default now(),
  constraint game_rating_plans_unique unique (game_key, method_hash),
  constraint game_rating_plans_hash_shape check (method_hash ~ '^[0-9a-f]{64}$')
)
--> statement-breakpoint
comment on table analysis.game_rating_plans is
  'The engine half of a game rating, handed to the scheduler. Immutable: a plan describes one set of searches, and rewriting it would change what the rating was computed from after the fact.'
--> statement-breakpoint
create index if not exists game_rating_plans_game_key_idx
  on analysis.game_rating_plans (game_key)
--> statement-breakpoint
drop trigger if exists game_rating_plans_immutable on analysis.game_rating_plans
--> statement-breakpoint
create trigger game_rating_plans_immutable
  before update or delete on analysis.game_rating_plans
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint

-- The engine writes it, the API schedules from it, analysis assembles from it.
grant select, insert on analysis.game_rating_plans to forma_stockfish
--> statement-breakpoint
grant select on analysis.game_rating_plans to forma_api, forma_analysis
--> statement-breakpoint
grant select on analysis.game_rating_plans to forma_ops

-- 0045_game_rating_submissions
--
-- Where a pasted game lives while it is being rated.
--
-- The first version put the PGN in the prepare item's payload, and the ledger
-- refused it: `work_items_payload_size_check` caps a payload at 4096 bytes, for
-- the same reason `output_summary` is capped. The work ledger routes work, it
-- does not carry cargo. A hand-typed game slipped under the limit and the first
-- real Lichess export, four and a half kilobytes of clocks, evaluations and
-- variations, did not.
--
-- So the API writes the submission here and the item carries a key. The engine
-- reads the game it is meant to screen, and the assembler reads the game it is
-- meant to rate, both from the row rather than from whatever a later caller
-- happens to paste.

set local role forma_migrator
--> statement-breakpoint

create table if not exists analysis.game_rating_submissions (
  id uuid primary key default gen_random_uuid(),
  game_key text not null,
  pgn text not null,
  -- Declared ratings, when the game carried them. They are part of the game key
  -- already, because they change what the rating is conditioned on.
  white_rating integer,
  black_rating integer,
  created_at timestamptz not null default now(),
  constraint game_rating_submissions_unique unique (game_key),
  -- Long enough for a heavily annotated correspondence game and short enough
  -- that the table is not a file store. A game past this is refused at the API
  -- with a reason rather than truncated into something that rates differently.
  constraint game_rating_submissions_size check (length(pgn) <= 200000)
)
--> statement-breakpoint
comment on table analysis.game_rating_submissions is
  'The game somebody asked to have rated. Immutable, and keyed by the game rather than the asker: two people pasting the same moves share one row and one rating.'
--> statement-breakpoint
drop trigger if exists game_rating_submissions_immutable on analysis.game_rating_submissions
--> statement-breakpoint
create trigger game_rating_submissions_immutable
  before update or delete on analysis.game_rating_submissions
  for each row execute function analysis.refuse_mutation()
--> statement-breakpoint

-- The API writes it because the API is what receives it. The engine and the
-- assembler only read.
grant select, insert on analysis.game_rating_submissions to forma_api
--> statement-breakpoint
grant select on analysis.game_rating_submissions to forma_stockfish, forma_analysis
--> statement-breakpoint
grant select on analysis.game_rating_submissions to forma_ops

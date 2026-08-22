-- 0038_the_opening_book_is_not_legacy
--
-- Record, on the tables themselves, that the opening catalogue is retained
-- reference data and not part of the legacy `public` schema being retired.
--
-- Every statement is guarded on ownership. `forma_migrator` does not own the
-- prototype's `public` tables -- `postgres` does -- and only an owner may
-- COMMENT, so an unguarded version fails and takes the whole migration batch
-- down with it, including other people's. The note is worth having where a
-- person reading the database will meet it, but not at the cost of blocking
-- every deploy behind it; where it cannot be set, this file is still the
-- record.
--
-- Hand-written and reviewed. Comments only: no column, constraint, policy,
-- grant or row is touched, and re-running it is a no-op.
--
-- ## Why this is a migration and not a note in a file
--
-- `public` currently holds two unrelated things. Almost all of it is the
-- prototype's tenant data -- games, moves, mistakes, observations -- which the
-- canonical schemas replaced and which is on its way out. Two tables in it are
-- not that: `opening_positions` (13,448 rows) and `opening_edges` (13,722) are
-- the Lichess CC0 named-opening catalogue, replayed into position keys. They
-- have no owner, no subject column, and the row-level policy 0011 gave them is
-- `using (true)`, which is role scoping rather than tenancy.
--
-- The person who eventually drops the rest of `public` will be reading the
-- database, not this repository. A `\d+` shows them a comment; it does not show
-- them a design document. Since the whole risk here is one `drop table` taken
-- for tidiness, the comment is the artifact that prevents it.
--
-- ## Why the tables did not move to `chess`
--
-- `chess` is where shared canonical rows live -- it is declared
-- `shared_canonical` / `reference_counted` in E02's platform contract -- and
-- the catalogue joins `chess.core_positions` on an identical key, so on shape
-- alone it belongs there. Three things say not yet, and not as part of this
-- change:
--
--   1. `plans/database-architecture.md` §31 maps every legacy object to a
--      target treatment. Every row says split, rebuild or migrate except one:
--      "Opening catalogue/edges -- Retain as versioned shared catalogue /
--      structural data with clear source/version". Moving them would be the
--      single unplanned schema change inside a planned decommission.
--   2. `server/src/security/contract.ts` is frozen: an exact 22-table
--      containment allowlist and 54 named grants, both naming
--      `public.opening_positions` and `public.opening_edges`, both compared
--      against the live database by the security gates. The file states that
--      its values may never be derived from observed output, so a move is a
--      contract revision and a security re-review rather than a refactor.
--   3. Migrations here are applied by a separate deployment step. A move would
--      leave `server/src/openings/book.ts` and the explorer's name join
--      querying a schema the live database does not have yet, and the book
--      would answer 500 for the entire window between merge and migrate.
--
-- The move is its own piece of work: one relocation migration, one contract
-- revision, one deploy ordering. Until it happens, the tables say what they are.

set local role forma_migrator
--> statement-breakpoint
do $$
begin
  if pg_catalog.pg_get_userbyid((select relowner from pg_class
       where oid = 'public.opening_positions'::regclass)) = current_user then
    execute 'comment on table public.opening_positions is ''Retained shared reference data, not legacy tenant data: the Lichess CC0 named-opening catalogue (database architecture 31, "Retain as versioned shared catalogue/structural data with clear source/version"). No owner, no subject column; position_key is the same four-field core key as chess.core_positions.core_key, which is how the explorer names an opening. The forma_api policy is using (true), which is role scoping rather than tenancy. Do NOT drop this with the rest of the prototype public schema; relocating it to chess needs its own migration, a revision of the frozen E01 containment contract, and a deploy ordered ahead of the API.''';
  else
    raise notice 'not the owner of public.opening_positions; the note stays in the migration file';
  end if;
end $$
--> statement-breakpoint
do $$
begin
  if pg_catalog.pg_get_userbyid((select relowner from pg_class
       where oid = 'public.opening_edges'::regclass)) = current_user then
    execute 'comment on table public.opening_edges is ''Retained shared reference data, not legacy tenant data: the move graph of the Lichess CC0 opening catalogue (database architecture 31). (from_key, move_uci) -> to_key is what lets a UCI line be followed through the book without a legal-move generator, which is how server/src/openings/book.ts finds where a player left the book. Same retention and relocation notes as public.opening_positions.''';
  else
    raise notice 'not the owner of public.opening_edges; the note stays in the migration file';
  end if;
end $$
--> statement-breakpoint
do $$
begin
  if pg_catalog.pg_get_userbyid((select relowner from pg_class
       where oid = 'public.opening_positions'::regclass)) = current_user then
    execute 'comment on column public.opening_positions.source_revision is ''The chess-openings commit the row was imported from. This is the "clear source/version" database architecture 31 asks retained catalogue data to carry: a name on this table is only checkable against the revision that produced it.''';
  else
    raise notice 'not the owner of public.opening_positions; the note stays in the migration file';
  end if;
end $$
--> statement-breakpoint
do $$
begin
  if pg_catalog.pg_get_userbyid((select relowner from pg_class
       where oid = 'public.opening_positions'::regclass)) = current_user then
    execute 'comment on column public.opening_positions.catalogue is ''True for a row the catalogue import wrote. A false row is a position the product recorded for its own reasons and is not part of the CC0 source, so it may not be re-exported under that licence.''';
  else
    raise notice 'not the owner of public.opening_positions; the note stays in the migration file';
  end if;
end $$
--> statement-breakpoint
reset role

/**
 * The opening book: what a line is called, what the book plays, and where the
 * player left it.
 *
 * The explorer answers "which of my lines is going wrong". This module answers
 * the question that follows it — "so what should I have played" — and the two
 * are deliberately different reads. The explorer is a whole graph shipped once
 * so a walk costs nothing; this is one position, answered in depth, asked for
 * when somebody has decided which position they care about.
 *
 * ## Where the catalogue lives, and why it did not move
 *
 * `public.opening_positions` (13,448 rows) and `public.opening_edges` (13,722)
 * are the Lichess CC0 catalogue replayed into position keys by
 * `openings/catalogue.ts`. They are reference data: no owner, no subject, no
 * tenant column, and the row-level policy 0011 put on them is
 * `using (true)` — role scoping, not tenancy.
 *
 * They stay in `public` rather than moving to `chess` alongside
 * `chess.core_positions`, which is where shared canonical rows otherwise live.
 * Three concrete reasons, in the order they bite:
 *
 *   1. `plans/database-architecture.md` §31 is the migration map for every
 *      legacy object, and it is the only row in that table that says
 *      **retain**: "Opening catalogue/edges — Retain as versioned shared
 *      catalogue/structural data with clear source/version". Every other
 *      legacy table is marked split, rebuild or migrate. Moving these would be
 *      the one unplanned schema change in a planned decommission.
 *   2. `server/src/security/contract.ts` is a frozen containment contract —
 *      an exact 22-table allowlist and 54 named grants, both of which name
 *      `public.opening_positions` and `public.opening_edges`, and both of which
 *      are compared against the live database by `npm run security:*`. The file
 *      says its values may never be derived from observed output, so a move is
 *      a contract revision and a security re-review, not a refactor.
 *   3. Migrations here are hand-written and applied by a separate deployment
 *      step. A move would leave this module querying a schema the live database
 *      does not have yet, so the book would 500 for the whole window between
 *      merge and migrate — and this module is the book's only reader.
 *
 * None of that is an argument that `public` is the right home forever. It is an
 * argument that the move is its own piece of work: one migration that relocates
 * both tables, one contract revision, and one deploy ordering. Migration 0038
 * writes the decision onto the tables themselves so that whoever sweeps the
 * rest of `public` reads it before typing `drop`.
 *
 * ## Why no chess engine appears in this file
 *
 * Resolving "where did this line leave the book" looks like it needs a board.
 * It does not: `opening_edges` is `(from_key, move_uci) -> to_key`, so walking
 * the player's UCI moves through the catalogue *is* the resolution, and the
 * first move with no edge is the departure by construction. The walk cannot
 * drift from the catalogue because it is the catalogue, and a legal-move
 * generator here would be a second opinion about a position the book already
 * has an answer for.
 *
 * The walk follows real edges rather than matching `representative_line_uci`,
 * which is stored on every position and would have made this a single equality.
 * A position reached by more than one move order keeps only one representative
 * line, so the equality would report "off book" for every transposition — which
 * is precisely the case a chess player most wants named.
 */

import type { Queryable } from "../db/queryable.js";
import { toDate } from "../db/timestamps.js";

/**
 * The initial position's core key.
 *
 * Four fields, en-passant `-`: the same key `canonicalPositionKey` produces for
 * the starting FEN and the same one `chess.core_positions` stores. Pinned as a
 * constant and asserted in `book.test.ts` rather than recomputed here, because
 * a mismatch would silently make every line walk start nowhere and report every
 * opening as off book from move one.
 */
export const BOOK_START_KEY = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -";

/**
 * How long a line this endpoint will follow.
 *
 * The catalogue's deepest line is well under this, so the bound never truncates
 * a book line; it bounds the recursion against a hand-edited query string.
 */
export const MAX_BOOK_LINE_PLIES = 40;

const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

/**
 * The moves of a line, as the query string gives them.
 *
 * Accepts spaces or commas because both are what a hand-written URL contains.
 * A malformed move is a validation failure rather than a silently dropped ply:
 * dropping one would shift every move after it onto the wrong position and the
 * answer would be confidently wrong instead of refused.
 */
export function parseLine(raw: string): string[] {
  const moves = raw
    .split(/[\s,]+/)
    .map((move) => move.trim().toLowerCase())
    .filter((move) => move.length > 0);
  for (const move of moves) {
    if (!UCI.test(move)) throw new Error(`not a UCI move: ${move}`);
  }
  if (moves.length > MAX_BOOK_LINE_PLIES) {
    throw new Error(`a line may be at most ${MAX_BOOK_LINE_PLIES} plies`);
  }
  return moves;
}

/** One step of the line that the catalogue still recognises. */
export interface BookStep {
  /** 1 for the first move of the game. */
  readonly idx: number;
  readonly fromKey: string;
  readonly uci: string;
  readonly toKey: string;
  /** The opening the position reached by this step is called, when named. */
  readonly name: string | null;
  readonly eco: string | null;
  readonly family: string | null;
  readonly variation: string | null;
  readonly ply: number;
  readonly lineSan: string | null;
  readonly lineUci: string | null;
}

export interface BookOpening {
  readonly name: string;
  readonly eco: string | null;
  readonly family: string;
  readonly variation: string | null;
  /** Ply of the named position, 0 for the initial position. */
  readonly ply: number;
  readonly lineSan: string;
  readonly lineUci: string;
  /**
   * False when the name comes from an earlier position on the line, which is
   * the normal case one move past the book. The screen has to say so: "your
   * Sicilian" and "a position the book stops naming two moves ago" are
   * different claims.
   */
  readonly atRequestedPosition: boolean;
}

export interface BookContinuation {
  readonly uci: string;
  readonly san: string;
  /** What the resulting position is called, when the catalogue names it. */
  readonly name: string | null;
  readonly eco: string | null;
  /** The caller's own games that played this move from here. */
  readonly yourGames: number;
}

/**
 * A move the caller actually played from this position.
 *
 * `games` and `judged` are separate on purpose and the difference is the point:
 * a move played in eleven games of which two carry a published verdict is not a
 * move that went well nine times. `analysis.transition_assessments` only exists
 * for a game with a published analysis run, so the gap is unanalysed games, and
 * a screen that subtracted `mistakes` from `games` would render that gap as
 * success.
 */
export interface PlayerBookMove {
  readonly uci: string;
  /** SAN as the caller's own game recorded it. Null when only the book has it. */
  readonly san: string | null;
  /** Whether the catalogue has this move from this position. */
  readonly inBook: boolean;
  readonly games: number;
  /** Of `games`, the ones a published analysis judged. */
  readonly judged: number;
  /** Of `judged`, the ones outside the versioned tolerance. */
  readonly mistakes: number;
}

export interface BookDeparture {
  /** Zero-based ply of the off-book move, matching `position_occurrences.ply`. */
  readonly ply: number;
  readonly uci: string;
  /** Whose move it was, from ply parity. Ply 0 is White's. */
  readonly side: "white" | "black";
  /** The deepest position on the line the catalogue still had. */
  readonly lastBookKey: string;
  readonly lastBookName: string | null;
}

export interface OpeningBook {
  /**
   * The newest row behind this answer: the catalogue revision's own
   * `updated_at`, or a publication behind the caller's counts, whichever is
   * later. Never a clock — a body carrying the time it was built has a
   * different ETag on every request, and the conditional-request path becomes
   * decoration.
   */
  readonly asOf: string | null;
  readonly requested: { readonly position: string; readonly line: string | null };
  /** Null when the catalogue does not recognise the position or the line. */
  readonly opening: BookOpening | null;
  readonly book: {
    /**
     * The position the continuations leave from: the requested one when the
     * catalogue has it, otherwise the deepest position on the line it still
     * had. Named rather than implied, because "here is what the book plays"
     * about a different position than the one you asked about is a lie the
     * reader cannot detect.
     */
    readonly fromKey: string;
    readonly atRequestedPosition: boolean;
    /** Plies of the line the catalogue followed. */
    readonly inBookPlies: number;
    readonly continuations: BookContinuation[];
  };
  /** Every move the caller played from `book.fromKey`, book or not. */
  readonly yourMoves: PlayerBookMove[];
  /** Null when the whole line is book, or when no line could be resolved. */
  readonly departure: BookDeparture | null;
}

interface PositionRow {
  position_key: string;
  eco: string | null;
  opening_name: string | null;
  family: string | null;
  variation: string | null;
  ply: number;
  representative_line_uci: string | null;
  representative_line_san: string | null;
  updated_at: string | Date | null;
}

interface StepRow {
  idx: number;
  from_key: string;
  uci: string;
  to_key: string;
  opening_name: string | null;
  eco: string | null;
  family: string | null;
  variation: string | null;
  ply: number | null;
  representative_line_uci: string | null;
  representative_line_san: string | null;
  updated_at: string | Date | null;
}

interface ContinuationRow {
  move_uci: string;
  move_san: string;
  opening_name: string | null;
  eco: string | null;
  updated_at: string | Date | null;
}

interface PlayerMoveRow {
  uci: string;
  san: string | null;
  games: number;
  judged: number;
  mistakes: number;
  materialized_at: string | Date | null;
  analysed_at: string | Date | null;
}

async function positionRow(sql: Queryable, key: string): Promise<PositionRow | null> {
  const rows = await sql<PositionRow[]>`
    select position_key, eco, opening_name, family, variation, ply,
           representative_line_uci, representative_line_san, updated_at
    from public.opening_positions
    where position_key = ${key}
  `;
  return rows[0] ?? null;
}

/**
 * Follow a UCI line through the catalogue, stopping where it runs out.
 *
 * One round trip rather than one per ply. The recursion terminates on the join:
 * a move with no `opening_edges` row produces no next row, so the walk ends at
 * exactly the departure without needing to know in advance where that is.
 */
async function walkRows(
  sql: Queryable,
  moves: readonly string[],
): Promise<StepRow[]> {
  if (moves.length === 0) return [];
  return sql<StepRow[]>`
    with recursive line as (
      select ${moves as string[]}::text[] as moves
    ),
    step (idx, from_key, uci, to_key) as (
      select 1, ${BOOK_START_KEY}::text, l.moves[1], e.to_key
      from line l
      join public.opening_edges e
        on e.from_key = ${BOOK_START_KEY} and e.move_uci = l.moves[1]
      union all
      select s.idx + 1, s.to_key, l.moves[s.idx + 1], e.to_key
      from step s
      join line l on true
      join public.opening_edges e
        on e.from_key = s.to_key and e.move_uci = l.moves[s.idx + 1]
      where s.idx < array_length(l.moves, 1)
    )
    select s.idx, s.from_key, s.uci, s.to_key,
           p.opening_name, p.eco, p.family, p.variation, p.ply,
           p.representative_line_uci, p.representative_line_san, p.updated_at
    from step s
    left join public.opening_positions p on p.position_key = s.to_key
    order by s.idx
  `;
}

async function continuationRows(sql: Queryable, fromKey: string): Promise<ContinuationRow[]> {
  return sql<ContinuationRow[]>`
    select e.move_uci, e.move_san, p.opening_name, p.eco, p.updated_at
    from public.opening_edges e
    left join public.opening_positions p on p.position_key = e.to_key
    where e.from_key = ${fromKey}
  `;
}

/**
 * How often the caller left this position by each move.
 *
 * The scoping chain is `subject_games -> game_replay_revisions ->
 * materialization_runs(published) -> position_occurrences`, walked in that
 * direction for the reason `subject-explorer.ts` gives: starting from the
 * occurrences and filtering to the subject afterwards would make the tenancy
 * boundary a property of the `where` clause rather than of the join.
 *
 * Whose move it was comes from ply parity, not from the assessment. An
 * unanalysed game has no assessment and its moves still belong to somebody, and
 * reading the actor off the verdict would quietly restrict this answer to
 * analysed games only.
 *
 * Everything is counted in distinct games so the three numbers share one unit.
 * Counting occurrences would let a repetition inside one game report two
 * decisions, and `games` and `judged` would then be comparable only by accident.
 */
async function playerMoveRows(
  sql: Queryable,
  subjectId: string,
  fromKey: string,
): Promise<PlayerMoveRow[]> {
  return sql<PlayerMoveRow[]>`
    select
      t.uci,
      min(t.san)                                                        as san,
      count(distinct sg.id)::int                                        as games,
      count(distinct sg.id) filter (
        where ta.played_move_acceptable is not null)::int               as judged,
      count(distinct sg.id) filter (
        where ta.played_move_acceptable is false)::int                  as mistakes,
      max(mr.published_at)                                              as materialized_at,
      max(sgp.published_at)                                             as analysed_at
    from chess.subject_games sg
    join chess.game_replay_revisions rev
      on rev.id = sg.latest_replay_revision_id
    join chess.materialization_runs mr
      on mr.replay_revision_id = rev.id and mr.state = 'published'
    join chess.position_occurrences o on o.run_id = mr.id
    join chess.core_positions cp
      on cp.id = o.core_position_id and cp.core_key = ${fromKey}
    join chess.position_transitions t
      on t.run_id = o.run_id and t.from_ply = o.ply
    left join analysis.subject_game_publications sgp
      on sgp.subject_game_id = sg.id
    left join analysis.transition_assessments ta
      on ta.analysis_run_id = sgp.run_id
     and ta.materialization_run_id = mr.id
     and ta.from_ply = o.ply
    where sg.subject_id = ${subjectId}
      and sg.status = 'included'
      and sg.latest_replay_revision_id is not null
      and (case when o.ply % 2 = 0 then 'white' else 'black' end) = sg.subject_color
    group by t.uci
  `;
}

/**
 * The opening a line is called, from the walk and the requested position.
 *
 * The rule is "the deepest position the catalogue still names". A position one
 * move out of book has no catalogue row and no name, and answering "unknown"
 * for it would be true and useless — the player is two plies into a Najdorf and
 * knows it. Naming the deepest named ancestor on their own move order is the
 * answer a person would give.
 *
 * `atRequestedPosition` carries the difference rather than hiding it.
 */
export function pickOpening(
  requestedKey: string,
  requested: {
    name: string | null;
    eco: string | null;
    family: string | null;
    variation: string | null;
    ply: number;
    lineUci: string | null;
    lineSan: string | null;
  } | null,
  steps: readonly BookStep[],
): BookOpening | null {
  if (requested?.name && requested.family) {
    return {
      name: requested.name,
      eco: requested.eco,
      family: requested.family,
      variation: requested.variation,
      ply: requested.ply,
      lineSan: requested.lineSan ?? "",
      lineUci: requested.lineUci ?? "",
      atRequestedPosition: true,
    };
  }
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i]!;
    if (!step.name || !step.family) continue;
    return {
      name: step.name,
      eco: step.eco,
      family: step.family,
      variation: step.variation,
      ply: step.ply,
      lineSan: step.lineSan ?? "",
      lineUci: step.lineUci ?? "",
      atRequestedPosition: step.toKey === requestedKey,
    };
  }
  return null;
}

/**
 * Where the line left the catalogue.
 *
 * Null when every move of the line is book, and null when there was no line to
 * follow. Those are different facts, and the caller distinguishes them by
 * whether it sent a line at all — an endpoint that reported "no departure" for
 * a question nobody asked would read as a clean bill of health.
 *
 * A line that leaves the catalogue and transposes back is reported as leaving
 * it here, which is true of this move order. The position's own name still
 * arrives through `pickOpening`, so the two answers together say the useful
 * thing: this move order is not in the book, and the board you reached is
 * called something.
 */
export function departureOf(
  moves: readonly string[],
  steps: readonly BookStep[],
): BookDeparture | null {
  if (moves.length === 0) return null;
  const inBook = steps.length;
  if (inBook >= moves.length) return null;
  const uci = moves[inBook]!;
  const last = steps[inBook - 1];
  // Ply 0 is the initial position with White to move, so the nth move of the
  // game (1-based) is played at ply n-1 and `inBook` is exactly that index.
  return {
    ply: inBook,
    uci,
    side: inBook % 2 === 0 ? "white" : "black",
    lastBookKey: last?.toKey ?? BOOK_START_KEY,
    lastBookName: last?.name ?? null,
  };
}

/**
 * The book's moves and the caller's, as one comparable pair of lists.
 *
 * Continuations are ordered by the caller's own games first, then by whether
 * the catalogue names where the move leads, then alphabetically. A book has no
 * popularity data of its own, so ordering by anything intrinsic would be
 * arbitrary; ordering by what the player actually plays puts their own line at
 * the top of the list they are being asked to compare against. The last two
 * keys are there so the order is total and the ETag is stable.
 */
export function mergeMoves(
  book: ReadonlyArray<{ uci: string; san: string; name: string | null; eco: string | null }>,
  played: ReadonlyArray<{ uci: string; san: string | null; games: number; judged: number; mistakes: number }>,
): { continuations: BookContinuation[]; yourMoves: PlayerBookMove[] } {
  const byUci = new Map(played.map((move) => [move.uci, move]));
  const bookMoves = new Set(book.map((move) => move.uci));

  const continuations = book
    .map((move) => ({
      uci: move.uci,
      san: move.san,
      name: move.name,
      eco: move.eco,
      yourGames: byUci.get(move.uci)?.games ?? 0,
    }))
    .sort(
      (left, right) =>
        right.yourGames - left.yourGames ||
        Number(Boolean(right.name)) - Number(Boolean(left.name)) ||
        left.san.localeCompare(right.san),
    );

  const yourMoves = played
    .map((move) => ({
      uci: move.uci,
      san: move.san,
      inBook: bookMoves.has(move.uci),
      games: move.games,
      judged: move.judged,
      mistakes: move.mistakes,
    }))
    .sort(
      (left, right) =>
        right.games - left.games ||
        right.mistakes - left.mistakes ||
        left.uci.localeCompare(right.uci),
    );

  return { continuations, yourMoves };
}

function newest(current: Date | null, value: string | Date | null | undefined): Date | null {
  const stamp = toDate(value ?? null);
  if (!stamp) return current;
  return current === null || stamp > current ? stamp : current;
}

export interface BookQuery {
  /** A core position key: the four-field FEN prefix. */
  readonly position: string;
  /** UCI moves from the initial position that reached it, or null. */
  readonly line: readonly string[] | null;
}

/**
 * The whole read.
 *
 * Carries no clock, so two identical reads produce the same ETag and the 304
 * path works. Everything in the body comes from a row.
 */
export async function readOpeningBook(
  sql: Queryable,
  subjectId: string | null,
  query: BookQuery,
): Promise<OpeningBook> {
  const requested = await positionRow(sql, query.position);

  // With no line from the caller, the catalogue's own representative line for
  // this position is used instead. It is the shortest telling of how the
  // position is reached, which is the right default for "what is this called"
  // and the wrong one for "where did *you* leave the book" — so `departure` is
  // only reported for a line the caller actually sent.
  const callerMoves = query.line ? [...query.line] : null;
  const moves = callerMoves ?? splitUci(requested?.representative_line_uci ?? null);

  const stepRows = await walkRows(sql, moves);
  const steps: BookStep[] = stepRows.map((row) => ({
    idx: row.idx,
    fromKey: row.from_key,
    uci: row.uci,
    toKey: row.to_key,
    name: row.opening_name,
    eco: row.eco,
    family: row.family,
    variation: row.variation,
    ply: row.ply ?? row.idx,
    lineSan: row.representative_line_san,
    lineUci: row.representative_line_uci,
  }));

  // The continuations come from the requested position when the catalogue has
  // it. When it does not, they come from the deepest position on the line that
  // it did have, because "the book has nothing here" is a true answer that
  // helps nobody study.
  const inBook = requested !== null;
  const fallbackKey = steps.length ? steps[steps.length - 1]!.toKey : BOOK_START_KEY;
  const fromKey = inBook ? query.position : moves.length ? fallbackKey : query.position;

  const [continuations, playerRows] = await Promise.all([
    continuationRows(sql, fromKey),
    subjectId ? playerMoveRows(sql, subjectId, fromKey) : Promise.resolve([]),
  ]);

  const merged = mergeMoves(
    continuations.map((row) => ({
      uci: row.move_uci,
      san: row.move_san,
      name: row.opening_name,
      eco: row.eco,
    })),
    playerRows.map((row) => ({
      uci: row.uci,
      san: row.san,
      games: row.games,
      judged: row.judged,
      mistakes: row.mistakes,
    })),
  );

  let asOf: Date | null = null;
  asOf = newest(asOf, requested?.updated_at);
  for (const row of stepRows) asOf = newest(asOf, row.updated_at);
  for (const row of continuations) asOf = newest(asOf, row.updated_at);
  for (const row of playerRows) {
    asOf = newest(asOf, row.materialized_at);
    asOf = newest(asOf, row.analysed_at);
  }

  return {
    asOf: asOf === null ? null : asOf.toISOString(),
    requested: {
      position: query.position,
      line: callerMoves === null ? null : callerMoves.join(" "),
    },
    opening: pickOpening(
      query.position,
      requested === null
        ? null
        : {
            name: requested.opening_name,
            eco: requested.eco,
            family: requested.family,
            variation: requested.variation,
            ply: requested.ply,
            lineUci: requested.representative_line_uci,
            lineSan: requested.representative_line_san,
          },
      steps,
    ),
    book: {
      fromKey,
      atRequestedPosition: fromKey === query.position,
      inBookPlies: steps.length,
      continuations: merged.continuations,
    },
    yourMoves: merged.yourMoves,
    departure: callerMoves === null ? null : departureOf(callerMoves, steps),
  };
}

function splitUci(line: string | null): string[] {
  if (!line) return [];
  return line.split(/\s+/).filter((move) => UCI.test(move));
}

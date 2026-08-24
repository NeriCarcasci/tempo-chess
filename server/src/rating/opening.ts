/**
 * What the game opened with, and where the players left theory.
 *
 * This is not part of the rating and never feeds it. It is context a coach
 * would give before saying anything about quality: which opening this was, and
 * the move at which both players stopped reciting and started deciding. A
 * rating that says 6.2 without saying "and they were out of book by move 9"
 * makes the reader do the work of finding the game themselves.
 *
 * The catalogue is the same Lichess CC0 opening data the repertoire trainer
 * reads, so a name here and a name there cannot disagree.
 */

import type { Sql } from "postgres";
import type { ParsedPgnMove } from "../ingest/pgn.js";
import { canonicalPositionKey } from "../openings/model.js";
import type { Color } from "./contract.js";

/** How deep the catalogue itself goes; looking past it cannot match. */
const CATALOGUE_MAX_PLY = 40;

export interface OpeningView {
  eco: string | null;
  name: string | null;
  family: string | null;
  variation: string | null;
  /** The last ply that the catalogue still recognised. */
  bookPly: number;
  /**
   * The first move the catalogue does not know, when there is one. Null means
   * the game never left theory, which for a short game is a real answer.
   */
  leftBookAt: { ply: number; moveNumber: number; san: string; side: Color } | null;
}

/**
 * Name the opening from the positions the game actually reached.
 *
 * Walks forward from the start and stops at the first position the catalogue
 * does not hold. Stopping is deliberate: a transposition back into a named line
 * twenty moves later is not the opening the players prepared, and treating it
 * as one would report theory the game had long since left.
 */
export async function readOpening(
  sql: Sql,
  moves: readonly ParsedPgnMove[],
): Promise<OpeningView | null> {
  if (moves.length === 0) return null;
  const considered = moves.slice(0, CATALOGUE_MAX_PLY);

  const keys = considered.map((move) => canonicalPositionKey(move.fenAfter));
  const rows = await sql<
    {
      position_key: string;
      eco: string | null;
      opening_name: string | null;
      family: string | null;
      variation: string | null;
    }[]
  >`select position_key, eco, opening_name, family, variation
      from opening_positions
     where catalogue = true and position_key = any(${sql.array(keys as string[])})`;

  const byKey = new Map(rows.map((row) => [row.position_key, row]));

  // The deepest *contiguous* hit. `named` lags `bookPly` because the catalogue
  // holds unnamed joining positions too, and the reader wants the last position
  // that had a name rather than the last one that merely existed.
  let bookPly = 0;
  let named: (typeof rows)[number] | null = null;
  for (let index = 0; index < considered.length; index += 1) {
    const row = byKey.get(keys[index]!);
    if (!row) break;
    bookPly = index + 1;
    if (row.opening_name) named = row;
  }

  if (bookPly === 0) return null;

  const departure = considered[bookPly] ?? null;
  return {
    eco: named?.eco ?? null,
    name: named?.opening_name ?? null,
    family: named?.family ?? null,
    variation: named?.variation ?? null,
    bookPly,
    leftBookAt: departure
      ? {
          ply: departure.ply,
          moveNumber: departure.moveNumber,
          san: departure.san,
          side: departure.color,
        }
      : null,
  };
}

import { client } from "../db/client.js";

/**
 * One game's replay, for scrubbing through it.
 *
 * This is the first route in the API that takes an id belonging to a row the
 * caller might not own: every other read filters by the authenticated profile
 * directly, so a game id from a URL has to be checked against ownership here or
 * it is a straightforward way to read other people's games. The join is the
 * check, and it is not optional.
 */

export interface ReplayMove {
  ply: number;
  moveNumber: number;
  color: "white" | "black";
  san: string;
  uci: string;
  fenBefore: string;
  fenAfter: string;
}

export async function getGameMoves(gameId: string, userId: string): Promise<ReplayMove[]> {
  const rows = await client`
    select cm.ply, cm.move_number, cm.color, cm.san, cm.uci, cm.fen_before, cm.fen_after
    from canonical_moves cm
    join games g on g.id = cm.game_id
    where cm.game_id = ${gameId} and g.user_id = ${userId}
    order by cm.ply`;
  return rows.map((row) => ({
    ply: Number(row.ply),
    moveNumber: Number(row.move_number),
    color: String(row.color) as "white" | "black",
    san: String(row.san),
    uci: String(row.uci),
    fenBefore: String(row.fen_before),
    fenAfter: String(row.fen_after),
  }));
}

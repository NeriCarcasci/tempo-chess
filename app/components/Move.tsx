import { PieceGlyph } from "./PieceGlyph";

/**
 * A move in algebraic notation, with the piece drawn instead of spelled.
 *
 * `Nxe6` reads as a knight taking on e6 to anyone who already plays chess, and
 * as a typo to everyone else. Swapping the letter for the piece the board is
 * already showing costs nothing to the first group and gives the second group
 * something to recognise — and it uses the same Cburnett vectors as the board
 * two inches away, so the page never looks like two products.
 *
 * Pawn moves have no letter and get no glyph, which is correct: there is
 * nothing to name.
 */

/** SAN piece letters, upper-case by definition — `b` is a file, `B` is a bishop. */
const PIECES = "KQRBN";

export function Move({
  san,
  white,
  className = "",
}: {
  /** Algebraic, optionally with its move number: "Nxe6", "8.Nxe6", "7...h6". */
  san: string;
  /** Whose piece it is. Wrong here means a white knight on a black move. */
  white: boolean;
  className?: string;
}) {
  // Split any leading move number so "8." stays plain text and does not get
  // mistaken for part of the move.
  const [, number = "", body = san] = /^(\d+\.*)?(.*)$/.exec(san) ?? [];
  const first = body[0] ?? "";
  const isPiece = PIECES.includes(first);

  return (
    <span className={`move ${className}`}>
      {number ? <i className="move-no">{number}</i> : null}
      {isPiece ? (
        <PieceGlyph letter={first.toLowerCase()} white={white} className="move-glyph" />
      ) : null}
      {isPiece ? body.slice(1) : body}
    </span>
  );
}

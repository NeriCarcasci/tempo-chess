import { PIECE_SETS } from "../lib/pieceSets";

/**
 * One chess piece, drawn with the same Cburnett vectors the app plays on.
 * Shared so the hero board and the marketing scenes can never drift into
 * looking like different products.
 */

const set = PIECE_SETS[0]!; // Cburnett, the app's default

export function PieceGlyph({
  letter,
  white,
  className,
  style,
}: {
  /** Lower-case piece letter: k q r b n p. */
  letter: string;
  white: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <svg
      viewBox="0 0 45 45"
      className={className}
      aria-hidden="true"
      style={{
        ["--pc-fill" as string]: white ? set.whiteFill : set.blackFill,
        ["--pc-line" as string]: white ? set.whiteStroke : set.blackStroke,
        ...style,
      }}
    >
      <g
        fill="var(--pc-fill)"
        stroke="var(--pc-line)"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        dangerouslySetInnerHTML={{ __html: set.svg?.[letter] ?? "" }}
      />
    </svg>
  );
}

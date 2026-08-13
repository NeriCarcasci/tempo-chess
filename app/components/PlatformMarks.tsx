/**
 * Marks for the chess platforms Tempo connects to.
 *
 * Licensing, checked August 2026, because the two platforms differ:
 *
 * - **Lichess.** lila's COPYING.md lists the logo, favicon and apple-touch-icon
 *   under "Exceptions (non-free)" with the single condition "Only use to refer
 *   to lichess.org". Naming lichess.org as a place you can connect an account
 *   from is precisely that, so the official mark ships here unmodified, in ink
 *   rather than recoloured. Source path taken from
 *   https://github.com/lichess-org/lila/blob/master/public/logo/lichess.svg
 *   (logo by sadsnake1).
 *
 * - **Chess.com.** Their User Agreement says you "agree not to display or use
 *   Chess.com's trademarks in any manner without their prior permission", and
 *   their brand guidance separately forbids creating materials similar to their
 *   marks. So we do NOT ship their logo and we do NOT draw an approximation of
 *   it. Naming the service in plain text is ordinary nominative use and is what
 *   we do instead, paired with a piece from our own Cburnett set.
 *
 *   To use the real mark: email brand@chess.com, get written permission, drop
 *   their official unmodified asset into `public/brand/chesscom.svg`, and render
 *   it from `ChessComMark` in place of the piece glyph.
 */

import { PieceGlyph } from "./PieceGlyph";

/** The official Lichess mark. Shape unmodified; sized by the caller. */
export function LichessMark({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 50 50"
      aria-hidden="true"
      fill="currentColor"
    >
      <path
        stroke="currentColor"
        strokeLinejoin="round"
        d="M38.956.5c-3.53.418-6.452.902-9.286 2.984C5.534 1.786-.692 18.533.68 29.364 3.493 50.214 31.918 55.785 41.329 41.7c-7.444 7.696-19.276 8.752-28.323 3.084S-.506 27.392 4.683 17.567C9.873 7.742 18.996 4.535 29.03 6.405c2.43-1.418 5.225-3.22 7.655-3.187l-1.694 4.86 12.752 21.37c-.439 5.654-5.459 6.112-5.459 6.112-.574-1.47-1.634-2.942-4.842-6.036-3.207-3.094-17.465-10.177-15.788-16.207-2.001 6.967 10.311 14.152 14.04 17.663 3.73 3.51 5.426 6.04 5.795 6.756 0 0 9.392-2.504 7.838-8.927L37.4 7.171z"
      />
    </svg>
  );
}

/**
 * Stand-in for Chess.com: one of our own pieces, never their trademark.
 * Swap for their official asset once permission is granted.
 */
export function ChessComMark({ size = 20 }: { size?: number }) {
  return (
    <PieceGlyph
      letter="p"
      white={false}
      className="sc-node-glyph"
      style={{ width: size, height: size }}
    />
  );
}

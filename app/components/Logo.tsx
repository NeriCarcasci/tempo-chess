/**
 * Tempo's identity: a rook drawn as a single closed outline, plus the wordmark.
 *
 * The rook is the piece that only matters once the position opens up, which is
 * the product's argument about your games. It is drawn on a 24 grid with real
 * piece anatomy (three merlons, a collar, a flared plinth) so it stays legible
 * at 20px in the nav and holds up at 200px on the hero.
 */

const ROOK_PATH =
  "M4 20.6 L20 20.6 L20 18.3 L18.3 18.3 L17.4 11.8 L18.6 11.8 L18.6 6.6 " +
  "L15.9 6.6 L15.9 8.5 L13.5 8.5 L13.5 6.6 L10.5 6.6 L10.5 8.5 L8.1 8.5 " +
  "L8.1 6.6 L5.4 6.6 L5.4 11.8 L6.6 11.8 L5.7 18.3 L4 18.3 Z";

/** The collar and plinth, drawn as separate strokes so the silhouette reads. */
const ROOK_DETAIL = "M6.6 11.8 H17.4 M5.7 18.3 H18.3";

export function RookMark({
  size = 24,
  className,
  title,
}: {
  size?: number;
  className?: string;
  /** Set only when the mark stands alone as the accessible name. */
  title?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinejoin="round"
      strokeLinecap="round"
    >
      <path d={ROOK_PATH} />
      <path d={ROOK_DETAIL} opacity={0.55} />
    </svg>
  );
}

/**
 * Lockup for the nav, auth cards, and footer. The mark carries the accent; the
 * wordmark stays ink so the pair reads as one object rather than two colours
 * competing.
 */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <span className="logo">
      <RookMark size={size} className="logo-mark" />
      <span className="logo-word">Tempo</span>
    </span>
  );
}

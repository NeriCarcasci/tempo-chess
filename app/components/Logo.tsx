/**
 * Tempo's identity: the crown of a rook, plus the wordmark.
 *
 * The turret only, three merlons over a tapered wall on a flared plinth. A whole
 * rook has to shrink its own body to fit a 20px nav, which reads as a squashed
 * piece; the crown is the part that identifies a rook anyway, and it gives the
 * mark a wide, stable stance at any size.
 */
const TURRET =
  "M3 6 H7.4 V9.8 H9.8 V6 H14.2 V9.8 H16.6 V6 H21 L19.4 16 H4.6 Z";

/** The flared plinth, sharing the turret's bottom edge so the two read as one. */
const PLINTH = "M3.2 16 H20.8 V19.6 H3.2 Z";

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
      <path d={TURRET} />
      <path d={PLINTH} />
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

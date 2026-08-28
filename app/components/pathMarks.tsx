/**
 * The path's own marks: bold outline, flat fill.
 *
 * A different family from `marks.tsx` on purpose, and the difference is the
 * job. Those marks are small figures set inside dials and rows, where two
 * tints of one hue is exactly right. These are the faces of the stops on a
 * path - 96px objects a reader is meant to want to press - and at that size a
 * two-tint glyph reads as a faint diagram. A heavy outline with flat colour
 * inside it is what gives an object presence, which is why every product that
 * draws a path this way draws it like this.
 *
 * Three rules keep it from becoming a second design language:
 *
 *   * **one ink, one fill, and the accent.** Not a palette. The outline is the
 *     product's own ink-block, the fill is a surface, and the one coloured
 *     thing in any mark is the thing the mark is about;
 *   * **the board colours are the board's.** Where a mark draws squares it
 *     uses `--color-board-light` and `--color-board-dark`, so a position drawn
 *     at 24px and the same position drawn at 300px are the same object;
 *   * **still no piece artwork.** DESIGN.md's rule survives the restyle: the
 *     pieces are the Cburnett vectors the boards use, and a second hand-drawn
 *     set beside them is how a product starts looking like two products.
 */

const STROKE = {
  stroke: "var(--color-ink-block)",
  strokeWidth: 2.6,
  strokeLinejoin: "round" as const,
  strokeLinecap: "round" as const,
};

function Mark({ children, label }: { children: React.ReactNode; label?: string }) {
  return (
    <svg
      className="pathmark"
      viewBox="0 0 48 48"
      fill="none"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {children}
    </svg>
  );
}

/** A position out of the player's own games: a board with one square marked. */
export function MarkPosition() {
  return (
    <Mark>
      <rect x="6" y="6" width="36" height="36" rx="5" fill="var(--color-board-light)" {...STROKE} />
      <path d="M24 6v36M6 24h36" {...STROKE} strokeWidth={2} opacity="0.5" />
      <rect x="6" y="6" width="18" height="18" rx="5" fill="var(--color-board-dark)" stroke="none" />
      <path d="M24 6H11a5 5 0 0 0-5 5v13h18V6Z" fill="var(--color-board-dark)" stroke="none" />
      <rect x="26" y="26" width="14" height="14" rx="3" fill="var(--color-accent)" {...STROKE} />
      <path d="M30 33l2.6 2.6L36 31" stroke="var(--color-accent-ink)" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />
      <rect x="6" y="6" width="36" height="36" rx="5" {...STROKE} />
    </Mark>
  );
}

/**
 * A tactical moment: the burst, on the square it happened on.
 *
 * Review stops take their face from the concept's *published category*, so a
 * path is legible before a word of it is read: six identical board marks down
 * one route told a reader only that six things happened, which is the least
 * interesting fact available. The catalogue already classes every concept, so
 * the variety is earned rather than decorative.
 */
export function MarkTactic() {
  return (
    <Mark>
      <rect x="6" y="6" width="36" height="36" rx="5" fill="var(--color-board-light)" {...STROKE} />
      <path
        d="M24 11l3.6 8.1 8.8 1-6.6 5.9 1.8 8.7L24 30.4l-7.6 4.3 1.8-8.7-6.6-5.9 8.8-1L24 11Z"
        fill="var(--color-accent)"
        {...STROKE}
      />
      <rect x="6" y="6" width="36" height="36" rx="5" {...STROKE} />
    </Mark>
  );
}

/** A defensive moment: the shield. */
export function MarkDefend() {
  return (
    <Mark>
      <path
        d="M24 6l14 5v13c0 9-6 15-14 18-8-3-14-9-14-18V11l14-5Z"
        fill="var(--color-surface)"
        {...STROKE}
      />
      <path d="M24 12l8 3v9c0 5.5-3.4 9.3-8 11.2V12Z" fill="var(--color-accent)" stroke="none" />
      <path d="M24 6v36" {...STROKE} strokeWidth={2.2} />
    </Mark>
  );
}

/** A conversion: the flag, because a won position is a finish to reach. */
export function MarkConvert() {
  return (
    <Mark>
      <path d="M14 42V8" {...STROKE} strokeWidth={3.4} />
      <path d="M14 9h20l-4.5 7.5L34 24H14V9Z" fill="var(--color-accent)" {...STROKE} />
      <path d="M9 42h16" {...STROKE} strokeWidth={3.4} />
    </Mark>
  );
}

/** Done. The one badge in the product, and it is never awarded for effort. */
export function MarkDone() {
  return (
    <Mark>
      <path d="M13 24.5l7.5 7.5L35 17.5" {...STROKE} strokeWidth={5} />
    </Mark>
  );
}

/** Written teaching: an open book. */
export function MarkLesson() {
  return (
    <Mark>
      <path
        d="M24 13c-3.4-2.6-7.7-4-12-4H7a1 1 0 0 0-1 1v25a1 1 0 0 0 1 1h5c4.3 0 8.6 1.4 12 4V13Z"
        fill="var(--color-surface)"
        {...STROKE}
      />
      <path
        d="M24 13c3.4-2.6 7.7-4 12-4h5a1 1 0 0 1 1 1v25a1 1 0 0 1-1 1h-5c-4.3 0-8.6 1.4-12 4V13Z"
        fill="var(--color-accent-wash)"
        {...STROKE}
      />
      <path d="M24 13v27" {...STROKE} />
      <path d="M30 20h7M30 26h7" {...STROKE} strokeWidth={2.2} opacity="0.65" />
    </Mark>
  );
}

/** Practice: a target, because the queue is the thing you aim at. */
export function MarkDrill() {
  return (
    <Mark>
      <circle cx="24" cy="24" r="17" fill="var(--color-surface)" {...STROKE} />
      <circle cx="24" cy="24" r="10.5" fill="var(--color-accent-wash)" {...STROKE} />
      <circle cx="24" cy="24" r="4.5" fill="var(--color-accent)" {...STROKE} />
    </Mark>
  );
}

/** Nothing here yet: a padlock, faded by the node that carries it. */
export function MarkLocked() {
  return (
    <Mark>
      <path d="M16 21v-5a8 8 0 0 1 16 0v5" fill="none" {...STROKE} />
      <rect x="10" y="21" width="28" height="20" rx="4" fill="var(--color-surface-2)" {...STROKE} />
      <circle cx="24" cy="30" r="3" fill="var(--color-ink-block)" stroke="none" />
      <path d="M24 32.5V35" {...STROKE} strokeWidth={2.4} />
    </Mark>
  );
}

/**
 * The three parts of a game, as one board with different ground lit up.
 *
 * A family rather than three unrelated symbols, and the family is the reading:
 * the opening is the rank you start from, the middlegame is the centre you
 * fight over, and the endgame is what is left. Drawn as the same board every
 * time so the three are obviously three states of one thing, which is exactly
 * what a phase is.
 *
 * Still no piece artwork - the pieces are the Cburnett vectors the boards use,
 * and a second hand-drawn set beside them is how a product starts looking like
 * two products.
 */
export function PhaseFace({ phase }: { phase: string }) {
  const lit =
    phase === "opening" ? (
      <rect x="9" y="30" width="30" height="9" rx="2" fill="var(--color-accent)" {...STROKE} />
    ) : phase === "middlegame" ? (
      <rect x="15" y="15" width="18" height="18" rx="2" fill="var(--color-accent)" {...STROKE} />
    ) : (
      <rect x="19.5" y="19.5" width="9" height="9" rx="2" fill="var(--color-accent)" {...STROKE} />
    );

  return (
    <Mark>
      <rect x="6" y="6" width="36" height="36" rx="5" fill="var(--color-board-light)" {...STROKE} />
      <path d="M6 18h36M6 30h36M18 6v36M30 6v36" stroke="var(--color-ink-block)" strokeWidth={1.6} opacity="0.28" />
      {lit}
      <rect x="6" y="6" width="36" height="36" rx="5" {...STROKE} />
    </Mark>
  );
}

/**
 * A star, filled or empty.
 *
 * Drawn in ink rather than gold: a star here records a score on one task the
 * player finished, not a trophy, and the canvas already spends its one colour
 * on the route. An empty star is the same outline unfilled, so three of them
 * read as a row rather than as a gap.
 */
export function MarkStar({ filled }: { filled: boolean }) {
  return (
    <svg className="pathstar" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3.2l2.6 5.8 6.3.7-4.7 4.3 1.3 6.2L12 17.1 6.5 20.2l1.3-6.2L3.1 9.7l6.3-.7L12 3.2Z"
        fill={filled ? "var(--color-ink-block)" : "none"}
        stroke="var(--color-ink-block)"
        strokeWidth={1.9}
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The way back. Bold enough to stand alone where a nav bar used to. */
export function MarkBack() {
  return (
    <Mark>
      <path d="M28 12 16 24l12 12" {...STROKE} strokeWidth={4} />
    </Mark>
  );
}

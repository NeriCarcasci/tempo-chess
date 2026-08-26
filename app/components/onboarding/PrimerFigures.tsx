import { RookMascot } from "../RookMascot";

/**
 * The accent half of the introduction, one figure per card.
 *
 * DESIGN.md lets a picture ship only once it can say what it is *for*, and the
 * rule these four hold to is that each one draws the sentence beside it rather
 * than decorating it. A stock icon of a magnifying glass would be the failure:
 * it would sit there looking like software and say nothing about chess.
 *
 * They are deliberately abstract. A screenshot would date the moment the screen
 * behind it changed, and a photograph of a board would be a claim about a
 * position nobody played. These are the product's own marks -- a grid of games,
 * a ladder of candidate moves, a ranked stack -- at a size where they read as
 * shapes rather than as data, which is exactly what an introduction wants.
 *
 * Everything is drawn in `--color-accent-ink` at varying opacity, because the
 * panel underneath is the accent itself. Nothing here carries meaning by colour
 * alone: each figure is legible as an arrangement in one flat tone.
 */

/** The panel's own coordinate space. Square, so the four never jump in size. */
const BOX = "0 0 200 200";

/**
 * One: the archive.
 *
 * Thirty-six games, a handful of which are the same mistake. The point of the
 * card is that a pattern only exists across many games, so the figure is mostly
 * quantity — and the marked tiles are scattered rather than adjacent, because a
 * repeat that showed up as a neat block would be a different, easier problem.
 *
 * Job of the motion: the tiles arriving one after another *is* an archive being
 * read. It plays once, on arrival, and the final state is the whole grid.
 */
function ArchiveFigure() {
  const COLS = 6;
  const ROWS = 6;
  const TILE = 26;
  const GAP = 6;
  const OFFSET = (200 - (COLS * TILE + (COLS - 1) * GAP)) / 2;
  /** The same idea missed, five times, spread across a year of play. */
  const MARKED = new Set([3, 9, 14, 22, 27, 33]);

  return (
    <svg viewBox={BOX} className="pf" focusable="false">
      {Array.from({ length: COLS * ROWS }, (_, index) => {
        const col = index % COLS;
        const row = Math.floor(index / COLS);
        return (
          <rect
            key={index}
            className={`pf-tile${MARKED.has(index) ? " is-marked" : ""}`}
            x={OFFSET + col * (TILE + GAP)}
            y={OFFSET + row * (TILE + GAP)}
            width={TILE}
            height={TILE}
            rx={7}
            style={{ animationDelay: `${index * 16}ms` }}
          />
        );
      })}
    </svg>
  );
}

/**
 * Two: what was findable.
 *
 * The candidate moves in a position, longest bar for the strongest, and the
 * band across the top three is the part players around this rating actually
 * find. The move played sits below it, so the picture says the same thing the
 * copy does: this was not there to be seen, and this one was.
 *
 * Job of the motion: the bars grow to their real lengths, because the length
 * *is* the value — the same reason the evaluation bars on the landing page are
 * allowed to animate.
 */
function FindableFigure() {
  const BARS = [150, 132, 118, 96, 74, 52, 34];
  const TOP = 26;
  const STEP = 24;
  const HEIGHT = 12;
  /** Where a player at this rating stops finding it. Three bars deep. */
  const BAND = TOP - 8 + 3 * STEP;
  /** The move actually played: the fifth candidate, well under the band. */
  const PLAYED = 4;

  return (
    <svg viewBox={BOX} className="pf" focusable="false">
      {/* The findable region, drawn behind the bars so it reads as ground
          rather than as another bar. */}
      <rect className="pf-band" x={8} y={TOP - 9} width={184} height={BAND - (TOP - 9)} rx={10} />
      {BARS.map((width, index) => (
        <rect
          key={index}
          className={`pf-bar${index === PLAYED ? " is-played" : ""}`}
          x={24}
          y={TOP + index * STEP}
          width={width}
          height={HEIGHT}
          rx={6}
          style={{ animationDelay: `${120 + index * 70}ms`, transformOrigin: "24px center" }}
        />
      ))}
      {/* The one that was played, marked by shape as well as by tone: colour
          alone may never carry meaning. */}
      <circle className="pf-dot" cx={14} cy={TOP + PLAYED * STEP + HEIGHT / 2} r={4} />
    </svg>
  );
}

/**
 * Three: the report.
 *
 * The ranked stack from `/today`, at a size where it reads as an ordered list
 * and not as figures: four measured areas, worst movement first, each with the
 * evidence behind it as a shorter bar underneath. Reading down the stack is
 * reading the priority order, which is the whole argument for ranking them.
 */
function ReportFigure() {
  const ROWS = [
    { measure: 132, evidence: 84 },
    { measure: 108, evidence: 66 },
    { measure: 88, evidence: 52 },
    { measure: 62, evidence: 38 },
  ];
  const TOP = 26;
  const STEP = 40;

  return (
    <svg viewBox={BOX} className="pf" focusable="false">
      {ROWS.map((row, index) => (
        <g
          key={index}
          className={`pf-row${index === 0 ? " is-lead" : ""}`}
          style={{ animationDelay: `${140 + index * 90}ms` }}
        >
          {/* The rank, as a filled counter rather than a numeral: at this size a
              digit is three pixels of noise, and the position in the column
              already says which rank it is. */}
          <circle className="pf-rank" cx={26} cy={TOP + index * STEP + 12} r={9} />
          <rect className="pf-measure" x={46} y={TOP + index * STEP + 4} width={row.measure} height={12} rx={6} />
          <rect className="pf-evidence" x={46} y={TOP + index * STEP + 22} width={row.evidence} height={7} rx={4} />
        </g>
      ))}
    </svg>
  );
}

/**
 * Four: it is running.
 *
 * The mascot, which is the one place in this product a character belongs: the
 * card is about waiting, and a wait is the moment a person most needs something
 * to be alive on the screen. `curious` is the resting loop — it looks up and
 * around, which is what the system is doing.
 *
 * The track underneath is the examination bar from the dashboard behind this
 * card, and it travels for the same reason that one does: at this point there
 * is no denominator to draw, and a fill sitting at zero would read as broken.
 */
function RunningFigure({ live }: { live: boolean }) {
  return (
    <div className="pf-rook">
      <RookMascot mood={live ? "curious" : "idle"} size={150} label="" />
      {live ? (
        <span className="pf-track" aria-hidden="true">
          <span className="pf-track-fill" />
        </span>
      ) : null}
    </div>
  );
}

export function PrimerFigure({ index, live }: { index: number; live: boolean }) {
  if (index === 0) return <ArchiveFigure />;
  if (index === 1) return <FindableFigure />;
  if (index === 2) return <ReportFigure />;
  return <RunningFigure live={live} />;
}

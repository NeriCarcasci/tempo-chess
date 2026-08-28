import { Link } from "react-router";
import { MoveChip } from "./instruments";
import { usePrefersReducedMotion } from "./charts";
import { PhaseFace } from "./pathMarks";
import { FigureNote } from "./FigureNote";
import { MOVEMENT_COPY, type PhaseReading } from "../lib/v1/dashboard";

/**
 * The three phases, as one row of dials — shared by `/today` and `/profile`.
 *
 * One component rather than two renderings, because the profile is the hub's
 * own reading with everything behind it, not a second product. A reader who
 * opens `/profile` and meets a different drawing of the same three figures has
 * to work out whether they disagree.
 */
/**
 * Where a dial goes.
 *
 * All three land on one scrolled page, at their own section. They used to be
 * three routes, and two of those were the same component with a different
 * noun; the third was a different kind of page sharing their nav row.
 */
const PHASE_TILE: Record<string, { name: string; to: string }> = {
  opening: { name: "Opening", to: "/path#opening" },
  middlegame: { name: "Middlegame", to: "/path#middlegame" },
  endgame: { name: "Endgame", to: "/path#endgame" },
};

/**
 * What the note behind the phase figures says, wherever they are drawn.
 *
 * One body shared by the row's own note and the trajectory's note on the hub,
 * so the same three dials are never explained two different ways depending on
 * which figure they happen to be standing under.
 */
export const PHASE_NOTE_BODY = (
  <>
    <p>
      A <b>key moment</b> is a position where one move was clearly
      better than the rest and you were the one to find it: a piece
      hanging, a tactic on the board, a won endgame to convert, a threat
      that had exactly one answer. Forma counts only the ones it can
      grade, and a moment that ended before your turn is set aside rather
      than counted against you.
    </p>
    <p>
      All three dials are counted the same way, on purpose. The moments
      themselves differ - an opening moment is a move in your own lines,
      an endgame moment is a position that could still be won or thrown
      away - but the unit does not, so the three can be read across.
    </p>
    <p>
      The colour is not the figure. It says which way that phase has moved
      since your earlier games, which is the one comparison Forma treats as
      valid. A phase it has not compared stays grey rather than being
      coloured on a guess, and a phase can go from green back to grey.
    </p>
  </>
);

/**
 * The caveat under the three dials, on the page and not behind the mark.
 *
 * A reader who takes the three rates as a ranking has been misled, and a
 * caveat that only exists inside a dialog nobody opens has not prevented
 * that. `note` is the figure's own mark when this caveat owns one; on the
 * hub the trajectory carries the note instead, and this line stands alone.
 *
 * A `div`, not a `p`: `FigureNote` renders a `<dialog>`, which the HTML
 * parser will not accept inside a paragraph.
 */
export function PhaseCaveat({ note }: { note?: React.ReactNode }) {
  return (
    <div className="today-phases-caveat">
      <span>
        Each phase counts a different kind of moment. Read one against
        itself, not against the others.
      </span>
      {note}
    </div>
  );
}

export function PhaseRow({
  readings,
  /** Provenance for the note: the cohort every figure here was measured over. */
  provenance,
}: {
  readings: readonly PhaseReading[];
  provenance?: string;
}) {
  if (readings.length === 0) return null;

  return (
    <section className="today-phases" aria-label="Your three phases">
      <ol className="phase-row">
        {readings.map((reading) => (
          <li key={reading.phase}>
            <PhaseNode reading={reading} />
          </li>
        ))}
      </ol>

      <PhaseCaveat
        note={
          <FigureNote title="How the three are judged">
            {provenance ? <p>{provenance}</p> : null}
            {PHASE_NOTE_BODY}
          </FigureNote>
        }
      />
    </section>
  );
}

/**
 * The hub's phase mark: the reading drawn on the circle's own edge.
 *
 * It was a `Dial` sitting inside a drawn disc, and the two fought. The dial
 * carries its own arc, its own interval and its own inner disc, so wrapping it
 * in an outline and a plinth produced four concentric rings around one icon -
 * the ring the eye reads first was the furthest one from the figure, and the
 * figure itself was a thin arc buried between them.
 *
 * One circle now. The edge *is* the track: a full ring in ink, the published
 * interval as a soft accent band on it, and the rate as the solid accent arc
 * over that, sweeping from twelve o'clock. The mark sits in the middle with
 * nothing else in the way, and the plinth is the object's own, so the whole
 * thing presses like every other drawn object in the product.
 *
 * A full circle rather than the dial's three-quarter sweep, because a ring is
 * a proportion of a whole and that is exactly what a rate is.
 *
 * The interval is drawn and never dropped: a rate without it is the
 * estimator's hedged answer printed as a flat assertion.
 */
function PhaseOrb({ reading, name }: { reading: PhaseReading; name: string }) {
  const reduced = usePrefersReducedMotion();
  const size = 152;
  /** How thick the reading is drawn. It is the mark's one quantity. */
  const band = 15;
  /** The plinth's depth, drawn as geometry rather than as a shadow. */
  const lip = 10;
  const outer = size / 2;
  const centre = { x: outer, y: outer };
  const radius = outer - band / 2;
  const circumference = 2 * Math.PI * radius;
  const arc = (value: number) => Math.max(0, Math.min(1, value)) * circumference;

  const { rate, intervalLow, intervalHigh } = reading;
  const low = intervalLow ?? rate;
  const high = intervalHigh ?? rate;

  return (
    <span className="phase-orb">
      {/*
        Every part of this is drawn in the one SVG, plinth included, and that
        is the fix rather than the flourish. The plinth was a `box-shadow`
        behind a white disc while the ring was an SVG stroke on top of it, so
        the two were laid out by different systems and could not be made to
        meet: there was a white seam under the ring wherever the rounding
        disagreed. Nested circles cannot disagree.

        The order is back to front: the plinth, the ink face it sits under,
        the paper inside that, then the reading on the band between them.
      */}
      <svg viewBox={`0 0 ${size} ${size + lip}`} aria-hidden="true">
        <circle cx={centre.x} cy={centre.y + lip} r={outer} fill="var(--color-ink-block)" />
        <circle cx={centre.x} cy={centre.y} r={outer} fill="var(--color-ink-block)" />
        <circle cx={centre.x} cy={centre.y} r={outer - band} fill="var(--color-surface)" />

        {/* The published interval, on the same band as the rate and never
            dropped: a rate without it is a hedged answer printed flat. */}
        {rate !== null && low !== null && high !== null && high > low ? (
          <circle
            className="phase-orb-band"
            cx={centre.x}
            cy={centre.y}
            r={radius}
            fill="none"
            strokeWidth={band}
            strokeDasharray={`${arc(high - low)} ${circumference}`}
            strokeDashoffset={-arc(low)}
            transform={`rotate(-90 ${centre.x} ${centre.y})`}
          />
        ) : null}

        {rate !== null ? (
          <circle
            className={`phase-orb-value${reduced ? " is-still" : ""}`}
            cx={centre.x}
            cy={centre.y}
            r={radius}
            fill="none"
            strokeWidth={band}
            strokeDasharray={`${arc(rate)} ${circumference}`}
            transform={`rotate(-90 ${centre.x} ${centre.y})`}
          />
        ) : null}
      </svg>

      <span className="phase-orb-mark" aria-hidden="true">
        <PhaseFace phase={reading.phase} />
      </span>
      <span className="sr-only">
        {name}:{" "}
        {rate === null
          ? unmeasuredText(reading)
          : `${Math.round(rate * 100)}% of key moments handled`}
      </span>
    </span>
  );
}

/**
 * Why a phase has no percentage, in the few words a tile can hold.
 *
 * The contract's rule: a phase with no publishable rate shows the reason in
 * place of the figure, never an empty dial read as 0%. The reason is derived
 * from what was published — the games that reached the phase and the
 * estimator's own `unavailableReason` — and an unrecognised reason gets a true
 * vague sentence rather than a slug.
 */
function unmeasuredText(reading: PhaseReading): string {
  if (reading.gamesReaching === 0) return "None of your games reached here";
  switch (reading.unavailableReason) {
    case "no_observations":
      return "No key moments here yet";
    case "below_minimum_sample":
      return "Too few key moments yet";
    case "all_evidence_censored":
      return "Every moment here ended before your turn";
    default:
      return "Not measured yet";
  }
}

/**
 * One phase, as a drawn ring.
 *
 * Everything on it is published. The edge is the phase's own pooled rate with
 * the estimator's interval on the same track; the counts under it are the
 * numerator and denominator of that rate; the chip is the posterior the
 * estimator wrote for this phase's recent window.
 *
 * The claim wears the emphasis and the rate sits under it as context — never
 * the other way round. A 72% opening beside a 41% middlegame reads as "I am
 * better at openings", and `dashboard.ts` is explicit that this is exactly the
 * comparison the pooled figures cannot support: the concepts that fire are not
 * the same mix in every phase, so the two rates measure different work.
 */
export function PhaseNode({ reading }: { reading: PhaseReading }) {
  const tile = PHASE_TILE[reading.phase];
  if (!tile) return null;

  const { movement, rate } = reading;
  const figure =
    reading.chances > 0
      ? `${reading.took.toLocaleString()} of ${reading.chances.toLocaleString()}`
      : null;

  return (
    <Link
      to={tile.to}
      className={`phase-node is-${movement}`}
      prefetch="intent"
      aria-label={`${tile.name}. ${
        figure ? `${figure} key moments handled. ` : `${unmeasuredText(reading)}. `
      }${MOVEMENT_COPY[movement].label}.`}
    >
      <span className="phase-node-mark">
        <PhaseOrb reading={reading} name={tile.name} />
      </span>
      <span className="phase-node-name">{tile.name}</span>
      {/* The figure says what it is of. It used to be a bare "59%" with a count
          beside it, and a percentage with no statement of what it measures is a
          number the reader has to guess at. */}
      {rate !== null ? (
        <span className="phase-node-read">
          <span className="phase-node-read-head">
            <span>Handled</span>
            <b>{Math.round(rate * 100)}%</b>
          </span>
          {figure ? <small>{figure} key moments</small> : null}
        </span>
      ) : (
        <span className="phase-node-read is-none">
          <small>{unmeasuredText(reading)}</small>
        </span>
      )}
      <MoveChip movement={movement} />
    </Link>
  );
}

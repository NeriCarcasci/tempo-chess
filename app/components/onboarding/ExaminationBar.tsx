import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { useJourney } from "../../lib/onboarding/useJourney";
import { PHASE_LABEL } from "../../lib/onboarding/sync";

/**
 * The examination, as one line across the top of the product.
 *
 * `/onboarding` is still there, and it is still the better screen to watch: it
 * takes the viewport, it replays real games, and it is what somebody who wants
 * to see the work should get. This is the other half of the same idea. A person
 * whose first read takes twenty minutes should not have to choose between
 * watching a progress screen and using the product, so the product opens
 * immediately with the wait moved to a strip above it.
 *
 * It draws exactly what the full screen draws, from the same reading, and it
 * refuses a number the same way: where there is no denominator there is no
 * percentage, only a stripe that says work is happening. The games count sits
 * beside the fill because a raw tally cannot regress, so it keeps moving
 * through the moments the ratcheted bar has to wait.
 *
 * When the run settles this calls `onSettled` once. The dashboard's panels are
 * loader data with a cache behind them, so nothing under this bar would notice
 * the report arriving without being told.
 */
export function ExaminationBar({
  runStage,
  onSettled,
}: {
  /** The run's own stage. It decides which phase is current, never how full. */
  runStage: string;
  /** Called once, when every game has been read and the write-up has landed. */
  onSettled?: () => void;
}) {
  const { journey, fraction, eta } = useJourney(runStage);
  const percent = fraction === null ? null : Math.round(fraction * 100);
  const unknown = percent === null;

  // Once, and only on the edge. `onSettled` revalidates the page under this
  // bar; firing it on every poll of a finished run would put the dashboard in a
  // refetch loop for as long as the tab stayed open.
  const settled = useRef(false);
  useEffect(() => {
    if (journey.phase !== "done" || settled.current) return;
    settled.current = true;
    onSettled?.();
  }, [journey.phase, onSettled]);

  return (
    /* Full width, with the content in the page's own column inside it. The
       first version centred the whole strip and stretched a full-bleed
       pseudo-element behind it with `calc(50% - 50vw)`, which paints the wash
       twice down the middle and can put a horizontal scrollbar on the page by
       the width of the vertical one. A wrapper costs one element and neither. */
    <section className="exam-bar" aria-labelledby="exam-bar-head">
      <div className="exam-bar-inner">
      <div className="exam-bar-line">
        <p className="cap exam-bar-phase" id="exam-bar-head">
          {journey.phase === "done" ? "Reading finished" : PHASE_LABEL[journey.phase]}
        </p>

        {/* The concrete version of the same fact, and the one a person actually
            feels. A percentage of an abstract work unit means little; "412 of
            4,317 games" means exactly what it says — so the two figures carry
            the ink and the words around them step back, which is how every
            other counted line in this product is set. */}
        {journey.games.total > 0 ? (
          <p className="exam-bar-count">
            <b>{journey.games.done.toLocaleString()}</b> of{" "}
            <b>{journey.games.total.toLocaleString()}</b> games
          </p>
        ) : (
          <p className="exam-bar-count is-quiet">Reading your archive</p>
        )}

        {/* The estimate, in words rather than as a clock, and only once there
            is something to estimate from. Before the first game workflow exists
            `etaLabel` can only say "working out how long this will take", which
            sat beside "reading your archive" as a second sentence hedging the
            first — two thirds of the line spent saying the same nothing twice.
            A count is exactly the evidence a projection needs, so it is the
            condition.

            It is also the first thing to go when the strip narrows: the count
            beside it is a fact and this is a projection, so on a phone the fact
            keeps the room. */}
        {journey.phase !== "done" && journey.games.total > 0 ? (
          <p className="exam-bar-eta">{eta}</p>
        ) : null}

        {/* The slot is held open whether or not there is a number in it. It used
            to print an em dash while the run had no denominator, which reads as
            a value rather than as the absence of one — and filling the gap later
            shunted the whole line sideways. Empty and reserved is the honest
            version of both. */}
        <p className="exam-bar-figure">{percent === null ? "" : `${percent}%`}</p>

        {/* The way out of the strip and into the screen that shows the work.
            Not a duplicate of the nav: this is the only link on the product to
            the running examination, and it disappears with the bar. */}
        <Link to="/onboarding" className="exam-bar-watch">
          Watch
          <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" focusable="false">
            <path
              d="M5.5 3l5 5-5 5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </Link>
      </div>

      <div
        className="exam-bar-track"
        role="progressbar"
        aria-label="Examination progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
      >
        <span
          className={unknown ? "exam-bar-fill is-unknown" : "exam-bar-fill"}
          style={unknown ? undefined : { width: `${percent}%` }}
        />
      </div>
      </div>
    </section>
  );
}

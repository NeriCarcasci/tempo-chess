import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { useJourney } from "../../lib/onboarding/useJourney";
import type { Step } from "../../lib/onboarding/sync";

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
 * ## Four segments, not one bar
 *
 * The first version drew a single fill and it could only measure one of the
 * four things that happen — so for minutes it said IMPORTING with no count, no
 * estimate and nothing marked finished, while the work had in fact moved on
 * twice. A person cannot tell a system that is working from one that is stuck
 * if it never says what it has done.
 *
 * So the rail is the four steps, each answering for itself: filled when that
 * step is finished, filling when it has a settled denominator, and travelling
 * when it is running with nothing honest to divide by. The line above names the
 * step running now and counts it. See `readSteps` for why a step may show a
 * tally and refuse a bar.
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
  const { steps, step, stepNumber, eta } = useJourney(runStage);
  const settledNow = step === null;

  // Once, and only on the edge. `onSettled` revalidates the page under this
  // bar; firing it on every poll of a finished run would put the dashboard in a
  // refetch loop for as long as the tab stayed open.
  const settled = useRef(false);
  useEffect(() => {
    if (!settledNow || settled.current) return;
    settled.current = true;
    onSettled?.();
  }, [settledNow, onSettled]);

  return (
    <section className="exam-bar" aria-labelledby="exam-bar-head">
      <div className="exam-bar-inner">
        <div className="exam-bar-line">
          <p className="cap exam-bar-phase" id="exam-bar-head">
            {step ? step.label : "Reading finished"}
          </p>

          {/* The concrete version of the same fact, and the one a person
              actually feels. A percentage of an abstract work unit means
              little; "412 of 4,317 games" means exactly what it says — so the
              figures carry the ink and the words around them step back. */}
          {step?.detail ? <Tally detail={step.detail} /> : null}

          {/* Only while studying, because that is the only step whose rate was
              ever measured. Beside anything else it would be a number attached
              to work it did not come from. */}
          {eta ? <p className="exam-bar-eta">{eta}</p> : null}

          {/* Which of the four, which is the question a single bar could never
              answer. The slot is held open whether or not there is a number in
              it, so nothing shunts sideways when the run settles. */}
          <p className="exam-bar-figure">{stepNumber > 0 ? `${stepNumber} / ${steps.length}` : ""}</p>

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
          className="exam-bar-rail"
          role="progressbar"
          aria-label="Examination progress"
          aria-valuemin={0}
          aria-valuemax={steps.length}
          aria-valuenow={steps.filter((entry) => entry.state === "done").length}
          aria-valuetext={step ? `${step.label}, step ${stepNumber} of ${steps.length}` : "Finished"}
        >
          {steps.map((entry) => (
            <RailSegment key={entry.key} step={entry} />
          ))}
        </div>
      </div>
    </section>
  );
}

/** The two figures in the ink, the grammar around them in the muted tone. */
function Tally({ detail }: { detail: string }) {
  // Split on the numbers rather than rebuilding the sentence here: the copy for
  // a tally belongs to `readSteps`, and a component that reassembles it would be
  // a second place to change when the wording does.
  const parts = detail.split(/(\d[\d,]*)/);
  return (
    <p className="exam-bar-count">
      {parts.map((part, index) =>
        /^\d/.test(part) ? <b key={index}>{part}</b> : <span key={index}>{part}</span>,
      )}
    </p>
  );
}

function RailSegment({ step }: { step: Step }) {
  if (step.state === "done") {
    return <span className="exam-seg is-done" />;
  }
  if (step.state !== "running") {
    return <span className="exam-seg" />;
  }
  return (
    <span className="exam-seg is-running">
      {/* A width when there is a denominator that has stopped moving, and a
          travelling stripe when there is not. The stripe is the honest reading
          of "working, with nothing true to divide by" — a fill sitting at zero
          through a whole import read as broken. */}
      <span
        className={step.fraction === null ? "exam-seg-fill is-unknown" : "exam-seg-fill"}
        style={step.fraction === null ? undefined : { width: `${Math.round(step.fraction * 100)}%` }}
      />
    </span>
  );
}

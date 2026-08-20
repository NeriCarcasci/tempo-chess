import { STAGE_LABEL, STAGE_ORDER, type Stage } from "../../lib/onboarding/copy";

/**
 * Where the journey is now.
 *
 * Deliberately not a stepper with ticks. `stage` is derived from evidence on
 * every read and legitimately moves *backwards* — a run that has finished the
 * diagnostic but has no report yet returns to `analysing` — so a trail that
 * latched "done" would be claiming something it cannot know. It marks the
 * current stage and nothing else.
 */
export function StageTrail({ stage }: { stage: string }) {
  const current = stage as Stage;
  return (
    <ol className="stage-trail" aria-label="Progress">
      {STAGE_ORDER.map((step) => {
        const isCurrent = step === current;
        return (
          <li key={step}>
            <span className={isCurrent ? "tag tag-accent" : "tag tag-sub"}>
              {STAGE_LABEL[step]}
            </span>
            {isCurrent ? <span className="sr-only"> (current)</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

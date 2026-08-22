import { CoverageBadge } from "../v1/Honesty";
import { limitationText } from "../../lib/onboarding/copy";
import { measureName } from "../../lib/v1/measures";
import type { OnboardingCoverage } from "../../lib/v1/types";

/**
 * What Forma could actually read, before anything it concluded.
 *
 * This leads the report rather than trailing it. A reader who does not know how
 * much evidence is behind a claim cannot judge the claim, and the product's
 * whole position is that they should be able to.
 *
 * The `unavailable` shape has every field null and is deliberately not a 404.
 * Rendering `0` for a null game count would be the exact lie this panel exists
 * to prevent: nothing has been counted yet, which is not the same as counting
 * nothing.
 */
export function CoveragePanel({ coverage }: { coverage: OnboardingCoverage }) {
  if (coverage.state === "unavailable") {
    return (
      <section className="coverage-panel">
        <p className="cap">What Forma could read</p>
        <p className="tag-note">
          This has not been worked out yet. It appears once your games have been read and
          analysed.
        </p>
      </section>
    );
  }

  const eligible = coverage.eligibleGames ?? 0;
  const total = coverage.totalGames ?? 0;
  const share = total > 0 ? Math.round((eligible / total) * 100) : 0;

  return (
    <section className="coverage-panel">
      <p className="cap">What Forma could read</p>

      <div className="coverage-lead">
        <CoverageBadge state={coverage.overallState as never} showBlurb />
        <p className="coverage-count">
          <span className="figure">{eligible}</span> of{" "}
          <span className="figure">{total}</span> games could be read
        </p>
        <div className="coverage-track" aria-hidden="true">
          <span style={{ width: `${share}%` }} />
        </div>
      </div>

      {coverage.limitations.length > 0 ? (
        <ul className="coverage-limits">
          {coverage.limitations.map((slug) => (
            <li key={slug}>{limitationText(slug)}</li>
          ))}
        </ul>
      ) : null}

      {coverage.dimensions.length > 0 ? (
        <ul className="line-list coverage-dimensions">
          {coverage.dimensions.map((dimension) => (
            <li key={dimension.dimensionKey} className="line-row">
              <div className="coverage-dimension">
                {/* The catalogue's name, not the humanised key. "Only move
                    recognize" is a slug with the underscores taken out, and
                    `measureName` falls back to that only for a concept this
                    build has never met. */}
                <strong>{measureName(dimension.dimensionKey)}</strong>
                <CoverageBadge state={dimension.state as never} />
                {/* Non-null exactly when the state is not sufficient, and
                    already a sentence — rendered verbatim rather than
                    re-worded, because the server counted the observations. */}
                {dimension.limitationReason ? (
                  <p className="tag-note">{dimension.limitationReason}</p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

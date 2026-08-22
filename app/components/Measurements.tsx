import type { ReactNode } from "react";
import { CoverageBadge, EmptyState } from "./v1/Honesty";
import {
  confidenceLabel,
  findingLabel,
  splitFindings,
  unavailableText,
  type MeasureGroup,
} from "../lib/v1/dashboard";
import type { Dashboard, Finding, RatingProfile, SkillEstimate } from "../lib/v1/types";

/**
 * The measurements, as sections both `/profile` and `/report` render.
 *
 * One content set, two presentations. Whatever the report says the profile
 * says, because they are the same components reading the same publication —
 * the routes differ in chrome, in mutability and in what a page break means,
 * never in what is claimed. Anything that lives in only one of them is a bug in
 * one of them.
 *
 * ## The rule these components exist to enforce
 *
 * **Never a rate without its interval and its sample size.** Half of two
 * hundred chances and 84% of seventeen hundred are different claims, and a page
 * that prints "50%" and "84%" side by side in the same weight says they are the
 * same kind of statement. `MeasureRate` cannot be rendered without all three,
 * because it takes the whole estimate rather than a number.
 *
 * **A censored chance is set aside, never a failure.** `coverage.censored`
 * counts chances the player never got to answer, and it is excluded from the
 * rate rather than counted against it. `EvidenceLine` prints the three counts
 * as three separate facts with three different words, so nothing can add the
 * wrong two together.
 *
 * **A null estimate keeps its reason.** "Not enough evidence" and "measured at
 * zero" are opposite statements; a blank where a figure belongs reads as the
 * second.
 */

const pct = (value: number): string => `${Math.round(value * 100)}%`;

/** Percentage points, signed, for a change between two rates. */
const points = (value: number): string => `${Math.abs(Math.round(value * 100))}`;

// ---------------------------------------------------------------------------
// One measured thing
// ---------------------------------------------------------------------------

/**
 * A rate, its interval and the evidence behind it, or the reason there is none.
 *
 * The interval is not a footnote. `intervalLow`/`intervalHigh` come from the
 * same posterior the estimate does, and dropping them turns the estimator's
 * hedged answer into a flat assertion. When the API sends a value without an
 * interval the component says so rather than implying the number is exact.
 */
export function MeasureRate({ estimate }: { estimate: SkillEstimate }) {
  if (estimate.estimate === null) {
    return (
      <p className="rate-figure is-none">
        <span className="rate-none">No figure</span>
        <small>
          {estimate.rawSampleSize.toLocaleString()}{" "}
          {estimate.rawSampleSize === 1 ? "chance" : "chances"} seen
        </small>
      </p>
    );
  }

  const hasInterval = estimate.intervalLow !== null && estimate.intervalHigh !== null;
  return (
    <p className="rate-figure">
      <b>{pct(estimate.estimate)}</b>
      <small>
        {hasInterval
          ? `${pct(estimate.intervalLow!)} to ${pct(estimate.intervalHigh!)}`
          : "range not published"}
      </small>
      <small>
        over {estimate.rawSampleSize.toLocaleString()}{" "}
        {estimate.rawSampleSize === 1 ? "chance" : "chances"}
      </small>
    </p>
  );
}

/**
 * The rate drawn against the same 0–100% axis on every row.
 *
 * The bar is the interval, and the tick inside it is the estimate. Drawing the
 * point alone would be the same overstatement `MeasureRate` refuses in words;
 * drawing the interval is what makes a measure standing on forty chances look
 * different from one standing on seventeen hundred, because the thin one is
 * visibly wider.
 */
function RateTrack({ estimate }: { estimate: SkillEstimate }) {
  if (estimate.estimate === null) return <span className="rate-track is-empty" aria-hidden="true" />;
  const low = estimate.intervalLow ?? estimate.estimate;
  const high = estimate.intervalHigh ?? estimate.estimate;
  return (
    <span className="rate-track" aria-hidden="true">
      <i className="rate-interval" style={{ left: `${low * 100}%`, width: `${(high - low) * 100}%` }} />
      <i className="rate-point" style={{ left: `${estimate.estimate * 100}%` }} />
    </span>
  );
}

/**
 * What is behind the rate, as three counts that cannot be confused.
 *
 * `graded` is the denominator of the rate and `censored` is not in it. A chance
 * the opponent resigned into was never a question, and folding it into the
 * failures would turn "you never got to answer" into "you got it wrong" — which
 * is the single thing the estimator is most careful about and the easiest thing
 * for an interface to undo.
 */
function EvidenceLine({ estimate }: { estimate: SkillEstimate }) {
  const { success, failure, censored, graded } = estimate.coverage;
  return (
    <p className="rate-evidence">
      <span>
        <b>{graded.toLocaleString()}</b> graded
      </span>
      <span>
        <b>{success.toLocaleString()}</b> taken
      </span>
      <span>
        <b>{failure.toLocaleString()}</b> missed
      </span>
      {censored > 0 ? (
        <span className="is-aside">
          <b>{censored.toLocaleString()}</b> set aside
        </span>
      ) : null}
    </p>
  );
}

/**
 * Whether the measure is moving, from the two windows the estimator stored.
 *
 * `delta` is the recent window minus the earlier half, and
 * `improvementProbability` is `P(recent > earlier)` computed from the two
 * posteriors rather than from the two points — so a move of six points is
 * confident or meaningless depending on how much evidence stands under each.
 * That probability is the sentence, not the delta.
 */
function ChangeNote({ recent }: { recent: SkillEstimate }) {
  if (recent.delta === null) return null;
  if (Math.abs(recent.delta) < 0.005) {
    return <p className="rate-change">Unchanged against your earlier games.</p>;
  }

  const up = recent.delta > 0;
  const probability = recent.improvementProbability;
  // `P(recent > earlier)` is the field. For a fall, the probability the reader
  // means is its complement, and printing the raw figure would report a
  // confident decline as an unlikely improvement.
  const chance = probability === null ? null : up ? probability : 1 - probability;

  return (
    <p className="rate-change">
      Your recent games are {points(recent.delta)} {up ? "up" : "down"} on your earlier ones.
      {chance === null
        ? " Forma did not publish how sure it is of that."
        : ` Forma puts the chance it has genuinely gone ${up ? "up" : "down"} at ${pct(chance)}.`}
    </p>
  );
}

function MeasureRow({ group }: { group: MeasureGroup }) {
  const { headline } = group;
  return (
    <li className="rate-row">
      <div className="rate-name">
        <strong>{group.name}</strong>
        <CoverageBadge state={headline.coverageStatus} />
      </div>
      <RateTrack estimate={headline} />
      <MeasureRate estimate={headline} />

      <div className="rate-body">
        {group.definition ? <p className="measure-def">{group.definition}</p> : null}
        {headline.estimate === null ? (
          <p className="rate-why">{unavailableText(headline.unavailableReason)}</p>
        ) : (
          <EvidenceLine estimate={headline} />
        )}
        {group.recent ? <ChangeNote recent={group.recent} /> : null}
        {/* Only rendered when the measure can actually censor, and set apart
            from everything above it: one says the evidence is thin, the other
            says some of it was never a question the player got to answer. */}
        {group.censoring && headline.coverage.censored > 0 ? (
          <p className="measure-censor">{group.censoring}</p>
        ) : null}
      </div>
    </li>
  );
}

export function MeasureList({ groups }: { groups: readonly MeasureGroup[] }) {
  if (groups.length === 0) {
    return (
      <EmptyState
        title="No measure has any chances behind it"
        detail="Your games were read, but none of them produced a moment Forma knows how to judge. That is a statement about what Forma can currently see, not about how you play."
      />
    );
  }

  return (
    <>
      {/* Drawn once, above the column every bar shares. A per-row axis would be
          five copies of the same ruler and would stop the rows reading as one
          picture, which is the only reason the bars are aligned at all. */}
      <div className="rate-axis" aria-hidden="true">
        <span className="rate-name" />
        <span className="rate-scale">
          <i>0%</i>
          <i>50%</i>
          <i>100%</i>
        </span>
        <span />
      </div>
      <ul className="rate-list">
        {groups.map((group) => (
          <MeasureRow key={group.baseKey} group={group} />
        ))}
      </ul>
    </>
  );
}

// ---------------------------------------------------------------------------
// What Forma concluded
// ---------------------------------------------------------------------------

function FindingItem({ finding }: { finding: Finding }) {
  return (
    <li className="finding">
      <p className="finding-head">
        <span className="cap">{findingLabel(finding.findingType)}</span>
        <span className="tag tag-sub">{confidenceLabel(finding.confidenceTier)}</span>
      </p>
      <p className="finding-text">{finding.explanation}</p>
      {finding.evidence.length > 0 ? (
        <p className="finding-evidence">
          Drawn from {finding.evidence.length.toLocaleString()}{" "}
          {finding.evidence.length === 1 ? "position" : "positions"} in your own games.
        </p>
      ) : null}
    </li>
  );
}

/**
 * The conclusions, strongest first.
 *
 * A finding whose text failed the renderer's own safety check arrives with a
 * null explanation and there is no endpoint that turns an id into a sentence.
 * Those are counted rather than described. An invented sentence attributed to a
 * measurement is the one failure this product cannot survive.
 */
export function FindingList({ findings }: { findings: readonly Finding[] }) {
  const { readable, silent } = splitFindings(findings);

  if (readable.length === 0) {
    return (
      <EmptyState
        title={silent > 0 ? "Nothing here can be put into words yet" : "There is nothing to conclude yet"}
        detail={
          silent > 0
            ? `Forma reached ${silent} ${silent === 1 ? "conclusion" : "conclusions"} whose written form did not pass its own check, so ${silent === 1 ? "it is" : "they are"} counted here rather than printed. A sentence Forma cannot stand behind is worse than none.`
            : "Your games were read and analysed, and nothing in them rose to something worth telling you. That is a statement about what Forma can currently read, not about how you play."
        }
      />
    );
  }

  return (
    <>
      <ul className="finding-list">
        {readable.map((finding) => (
          <FindingItem key={finding.id} finding={finding} />
        ))}
      </ul>
      {silent > 0 ? (
        <p className="provenance">
          {silent} further {silent === 1 ? "conclusion" : "conclusions"} had no written form that
          passed Forma's own check, so {silent === 1 ? "it is" : "they are"} counted rather than
          printed.
        </p>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Rating
// ---------------------------------------------------------------------------

/**
 * The rating pools, never combined.
 *
 * There is deliberately no single number for a person's chess ability here, and
 * the API refuses to produce one: ratings from different pools are not
 * comparable, so a client that wants one figure has to invent it. This renders
 * a row per pool and prints the server's own note about why.
 */
export function RatingPools({ profile }: { profile: RatingProfile }) {
  if (profile.state !== "published" || profile.pools.length === 0) {
    return (
      <EmptyState
        title="No rating has been calibrated yet"
        detail="Forma reads the rating each site gave you and works out where it sits on its own scale. That needs a calibrated pool, and none of yours has one in this report."
      />
    );
  }

  return (
    <>
      <ul className="pool-list">
        {profile.pools.map((pool) => (
          <li key={`${pool.provider}-${pool.pool}-${pool.speed}`} className="pool">
            <p className="pool-head">
              <strong>{pool.speed}</strong>
              <span className="cap">{pool.provider}</span>
            </p>
            <p className="pool-figure">
              {pool.observedRating === null ? (
                <span className="rate-none">No rating recorded</span>
              ) : (
                <b>{pool.observedRating.toLocaleString()}</b>
              )}
              {pool.scaleEstimate !== null ? (
                <small>
                  Forma&rsquo;s own scale: {Math.round(pool.scaleEstimate).toLocaleString()}
                  {pool.intervalLow !== null && pool.intervalHigh !== null
                    ? ` (${Math.round(pool.intervalLow).toLocaleString()} to ${Math.round(pool.intervalHigh).toLocaleString()})`
                    : ""}
                </small>
              ) : null}
            </p>
            {pool.suppressedReason ? (
              <p className="rate-why">{pool.suppressedReason}</p>
            ) : pool.inSupportedRange ? null : (
              <p className="rate-why">
                This rating sits outside the band Forma calibrated against, so it is shown as the
                site reported it and not placed on Forma&rsquo;s scale.
              </p>
            )}
          </li>
        ))}
      </ul>
      <p className="provenance">{profile.note}</p>
    </>
  );
}

// ---------------------------------------------------------------------------
// What Forma could read
// ---------------------------------------------------------------------------

/**
 * The report's own sentences about its limits, printed verbatim.
 *
 * `coverageWarnings` is written by `estimates/dashboard.ts` and is already
 * prose. Rewriting it on the client is how a screen ends up describing a
 * different report from the one it is showing.
 */
export function CoverageWarnings({ warnings }: { warnings: readonly string[] }) {
  if (warnings.length === 0) {
    return (
      <p className="profile-lede">
        Forma raised nothing about the evidence behind this report. Every figure on this page still
        carries the number of chances it was counted from.
      </p>
    );
  }
  return (
    <ul className="coverage-limits">
      {warnings.map((warning, index) => (
        <li key={index}>{warning}</li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Where this came from
// ---------------------------------------------------------------------------

/**
 * Which analysis said this, and when.
 *
 * A claim without "as of when" is a statement about the present that was true
 * about the past. The publication id is the thing support can look up, so it is
 * selectable text rather than a tooltip.
 */
export function PublicationNote({
  dashboard,
  children,
}: {
  dashboard: Dashboard;
  children?: ReactNode;
}) {
  const published = new Date(dashboard.publishedAt).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  return (
    <div className="publication">
      <p className="provenance">
        Published {published} from a frozen snapshot of your archive. It will not change under you:
        a new examination publishes a new one beside it.
      </p>
      <p className="provenance publication-id">
        Publication {dashboard.publicationId} · recipe {dashboard.version.recipeVersionId} ·
        snapshot {dashboard.version.snapshotId}
      </p>
      {children}
    </div>
  );
}

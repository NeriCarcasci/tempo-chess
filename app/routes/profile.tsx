import { Link, useLoaderData } from "react-router";
import type { Route } from "./+types/profile";
import { TopNav } from "../components/TopNav";
import { RouteError } from "../components/RouteError";
import { ChessComMark, LichessMark } from "../components/PlatformMarks";
import { CoverageBadge, EmptyState } from "../components/v1/Honesty";
import { WithheldNote } from "../components/onboarding/WithheldNote";
import { getCoverage, getDashboard, getMe, getOnboarding, getReport } from "../lib/onboarding/api";
import { reportAlreadyOpened } from "../lib/onboarding/nextScreen";
import { limitationText, STAGE_LABEL, type Stage } from "../lib/onboarding/copy";
import { fetchRecentGames, type RecentGame } from "../lib/v1/games";
import {
  holdings,
  measureFor,
  measureName,
  orderDimensions,
  summariseReport,
  widestEvidence,
} from "../lib/v1/measures";
import type {
  BaselineReport,
  Dashboard,
  Me,
  OnboardingCoverage,
  OnboardingState,
  SkillEstimate,
} from "../lib/v1/types";
import { requireSession } from "../lib/session";

/**
 * Everything Forma has measured about you, in one place.
 *
 * The product measures a great deal and, until this page, showed almost none of
 * it: `/report` renders one immutable document and the rest sat in the database
 * with no surface at all. This is that surface, and it is organised the way the
 * report is — what Forma could read first, then what it measured, then what it
 * concluded — because a reader who does not know how much evidence is behind a
 * claim cannot judge the claim.
 *
 * Three rules shape it, and each of them is a thing that would otherwise go
 * wrong quietly.
 *
 * **It states the evidence rather than a bare rate.** Every measure comes with
 * the number of chances behind it, its coverage state, and the server's own
 * sentence about why that state is not `sufficient`. Nothing here draws a
 * percentage: the rate, its interval and the success/failure/censored split are
 * computed and stored (`analysis.player_skill_estimates`) but no `/v1` route
 * publishes them, and a point estimate without its interval is a stronger claim
 * than the estimator made. When a route starts returning them this page gains
 * the number *and* the range in the same change, never one without the other.
 *
 * **A censored chance is never a failure.** A conversion the opponent resigned
 * into is left out of the rate rather than counted against the player. The
 * measure that can censor says so in its own words; the footer says the counts
 * themselves are not published yet, rather than letting silence imply zero.
 *
 * **It never opens the report on the reader's behalf.** Fetching a baseline
 * report is a write — it is what records `report_viewed_at` and moves the run
 * out of `report_ready` — so this page reads one only once the run has already
 * left that stage, and otherwise sends the reader to `/report` to open it
 * themselves. See `reportAlreadyOpened`.
 */

export function meta() {
  return [{ title: "Your profile · Forma" }];
}

interface LoaderData {
  me: Me;
  state: OnboardingState;
  coverage: OnboardingCoverage | null;
  report: BaselineReport | null;
  games: RecentGame[];
  dashboard: Dashboard | null;
}

/**
 * The lifetime, objective estimate for a coverage dimension.
 *
 * Coverage strips the frame suffix from a dimension key -- `critical_moment_execute`
 * -- while an estimate keeps it, because the same chances are estimated under
 * several frames and windows. `objective` over the `lifetime` window is the one
 * that answers "how often, across everything we have", which is what this page
 * asks. The other frames compare a player to their own earlier form and belong
 * on a trend surface, not here.
 */
export function estimatesByDimension(dashboard: Dashboard | null): Map<string, SkillEstimate> {
  const found = new Map<string, SkillEstimate>();
  // Absent as well as null: a caller that has not fetched the dashboard yet and
  // one that fetched a 404 both mean "no measurements to attach", and throwing
  // on the first would take the whole page down over a missing optional read.
  if (!dashboard) return found;
  for (const estimate of dashboard.estimates) {
    if (estimate.frame !== "objective" || estimate.windowKind !== "lifetime") continue;
    found.set(estimate.dimensionKey.replace(/_objective$/, ""), estimate);
  }
  return found;
}

export async function clientLoader(): Promise<LoaderData> {
  await requireSession();
  const [me, state] = await Promise.all([getMe(), getOnboarding()]);

  // `fetchRecentGames` never throws and never blocks the rest of the page: the
  // games are the raw material, not the measurement, and an empty list is a
  // section that does not render rather than a page that does not.
  const [coverage, games] = await Promise.all([
    state.runId === null ? Promise.resolve(null) : getCoverage(state.runId),
    fetchRecentGames(12),
  ]);

  const reportId = state.baselineReportId ?? state.nextAction.reportId ?? null;
  const report =
    reportId !== null && reportAlreadyOpened(state) ? (await getReport(reportId)).data : null;

  // The measurements themselves. A 404 is "nothing published yet", which is an
  // empty account rather than a broken page, so it degrades to null and the
  // sections fall back to showing the evidence without the rates. Unlike the
  // report, reading this records nothing and advances nothing.
  const dashboard = await getDashboard()
    .then((result) => result.data)
    .catch(() => null);

  return { me, state, coverage, report, games, dashboard };
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <RouteError title="Could not open your profile" error={error} />;
}

export default function Profile() {
  const { me, state, coverage, report, games, dashboard } = useLoaderData<LoaderData>();
  const published = coverage !== null && coverage.state === "published";

  return (
    <div className="relative z-10 min-h-dvh">
      <TopNav current="account" />
      <main className="profile-shell">
        <ProfileHead me={me} />

        {published ? (
          <>
            <ReadSection coverage={coverage} />
            <MeasureSection coverage={coverage} dashboard={dashboard} />
            <ReportSection report={report} state={state} />
            <GameSection games={games} />
            <Provenance report={report} />
          </>
        ) : (
          <NothingMeasured state={state} />
        )}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Who this is
// ---------------------------------------------------------------------------

function ProviderMark({ provider }: { provider: Me["accounts"][number]["provider"] }) {
  return provider === "chesscom" ? <ChessComMark size={16} /> : <LichessMark size={16} />;
}

/** The two statuses that are not "active", as words rather than as enum values. */
const ACCOUNT_STATUS: Record<string, string> = {
  paused: "Paused",
  disconnected: "Disconnected",
};

function ProfileHead({ me }: { me: Me }) {
  const accounts = me.accounts;
  const primary = accounts.find((account) => account.status === "active") ?? accounts[0] ?? null;

  return (
    <header className="profile-head">
      <p className="eyebrow">Your profile</p>
      <h1>{primary?.handle ?? "Not connected yet"}</h1>
      {accounts.length === 0 ? null : (
        <ul className="profile-accounts">
          {accounts.map((account) => (
            <li key={account.id}>
              <ProviderMark provider={account.provider} />
              <span>{account.handle ?? "Unnamed account"}</span>
              {/* A paused or disconnected account keeps the games already in
                  the archive and stops contributing new ones, which changes
                  what the counts below cover. Saying so is cheaper than a
                  reader wondering why their figures stopped moving. */}
              {account.status === "active" ? null : (
                <span className="tag tag-sub">
                  {ACCOUNT_STATUS[account.status] ?? account.status}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </header>
  );
}

// ---------------------------------------------------------------------------
// Nothing to show — which is four different days, not one
// ---------------------------------------------------------------------------

/**
 * Nothing to show is three different days, and only one of them is a problem.
 *
 * A brand new account, an examination still running and a run that failed all
 * render as an absence, and collapsing them into one apology would leave two
 * thirds of the people who see it with no idea what to do next.
 */
function NothingMeasured({ state }: { state: OnboardingState }) {
  const copy =
    state.runId === null
      ? {
          title: "Nothing has been measured yet",
          detail:
            "Forma reads your own games and works out where your play actually costs you. Connect a chess account and it will start from its archive.",
          cta: "Start",
          primary: true,
        }
      : state.status === "failed" || state.status === "abandoned"
        ? {
            title: "The examination did not finish",
            detail:
              "Nothing was measured, so there is nothing here to show. The onboarding screen says what stopped it and whether it can be run again.",
            cta: "See what happened",
            primary: false,
          }
        : {
            title: "Forma is still reading your games",
            detail: `Nothing is measured until the examination finishes, because a half-read archive gives numbers that change under you. Current stage: ${
              STAGE_LABEL[state.stage as Stage] ?? state.stage
            }.`,
            cta: "Watch it run",
            primary: false,
          };

  return (
    <section className="profile-section">
      <EmptyState
        title={copy.title}
        detail={copy.detail}
        action={
          <Link
            to="/onboarding"
            className={`${copy.primary ? "primary-button" : "secondary-button"} inline-flex`}
          >
            {copy.cta}
          </Link>
        }
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// What Forma could read
// ---------------------------------------------------------------------------

function ReadSection({ coverage }: { coverage: OnboardingCoverage }) {
  const eligible = coverage.eligibleGames ?? 0;
  const total = coverage.totalGames ?? 0;
  // Layout only: the same two numbers the sentence states, drawn as the share
  // of the archive they are. Nothing is derived that is not already written
  // out in words beside it.
  const share = total > 0 ? Math.round((eligible / total) * 100) : 0;

  return (
    <section className="profile-section">
      <div className="profile-section-head">
        <h2>What Forma could read</h2>
        <CoverageBadge state={coverage.overallState} />
      </div>
      <p className="profile-count">
        <span className="figure">{eligible.toLocaleString()}</span> of{" "}
        <span className="figure">{total.toLocaleString()}</span> synced games could be read. Forma
        reads rated standard games against human opponents, which is the limit of what it can say
        something honest about.
      </p>
      <div className="coverage-track" aria-hidden="true">
        <span style={{ width: `${share}%` }} />
      </div>
      {coverage.limitations.length > 0 ? (
        <ul className="coverage-limits">
          {coverage.limitations.map((slug) => (
            <li key={slug}>{limitationText(slug)}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The measures themselves
// ---------------------------------------------------------------------------

function MeasureSection({
  coverage,
  dashboard,
}: {
  coverage: OnboardingCoverage;
  dashboard: Dashboard | null;
}) {
  const rows = orderDimensions(coverage.dimensions);
  const widest = widestEvidence(rows);
  const estimates = estimatesByDimension(dashboard);

  return (
    <section className="profile-section">
      <h2>What Forma measures</h2>
      <p className="profile-lede">
        Each row is a named chance Forma can find in your games: how many it found, how often you
        took them, and the range that rate could plausibly sit in. The range is not decoration.
        A rate over two hundred chances and a rate over seventeen hundred are different claims,
        and the interval is what says so.
      </p>

      {rows.length === 0 ? (
        <EmptyState
          title="No measure has any chances behind it"
          detail="Your games were read, but none of them produced a moment Forma knows how to judge. That is a statement about what Forma can currently see, not about how you play."
        />
      ) : (
        <ul className="measure-list">
          {rows.map((row) => {
            const measure = measureFor(row.dimensionKey);
            return (
              <li key={row.dimensionKey} className="measure-row">
                <div className="measure-head">
                  <strong>{measureName(row.dimensionKey)}</strong>
                  <CoverageBadge state={row.state} />
                </div>
                <p className="measure-def">
                  {measure?.definition ??
                    "Forma measures this, and this build does not carry a description of it yet."}
                </p>
                <MeasureRate estimate={estimates.get(row.dimensionKey) ?? null} />
                <p className="measure-count">
                  <span className="figure">{row.observationCount.toLocaleString()}</span>{" "}
                  {row.observationCount === 1 ? "chance seen" : "chances seen"}
                </p>
                {/* The figure is the accessible value; the bar is the same
                    number against the largest on the page, so 1,698 chances
                    and 200 stop looking like the same claim. */}
                <span className="measure-bar" aria-hidden="true">
                  <i
                    style={{
                      width: widest === null ? "0%" : `${(row.observationCount / widest) * 100}%`,
                    }}
                  />
                </span>
                {/* Non-null exactly when the state is not sufficient, and
                    already a sentence the server counted. Rendered verbatim. */}
                {row.limitationReason ? <p className="tag-note">{row.limitationReason}</p> : null}
                {measure?.censoring ? <p className="measure-censor">{measure.censoring}</p> : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * The rate, and never without its range.
 *
 * An estimate with no value carries a reason instead, and the reason is shown
 * rather than swallowed: a dimension nobody has enough evidence for is a
 * different statement from one measured at zero, and rendering the first as the
 * second says the player always fails at something nobody has watched them do.
 *
 * The interval is rendered at the same weight as the rate on purpose. 0.502
 * over two hundred chances spans ±0.06; 0.844 over seventeen hundred spans
 * ±0.015. Printing the first digit-for-digit beside the second, with nothing to
 * separate them, is the most common way a measurement lies.
 */
export function MeasureRate({ estimate }: { estimate: SkillEstimate | null }) {
  if (estimate === null) return null;

  if (estimate.estimate === null) {
    return (
      <p className="measure-unmeasured">
        {estimate.unavailableReason ?? "Not enough evidence to state a rate yet."}
      </p>
    );
  }

  const pct = (value: number) => `${Math.round(value * 100)}%`;
  const low = estimate.intervalLow;
  const high = estimate.intervalHigh;

  return (
    <p className="measure-rate">
      <span className="figure">{pct(estimate.estimate)}</span>
      {low !== null && high !== null ? (
        <span className="measure-range">
          {" "}
          {pct(low)}&ndash;{pct(high)}
        </span>
      ) : null}
      {estimate.coverage.censored > 0 ? (
        <span className="measure-set-aside">
          {" "}
          · {estimate.coverage.censored.toLocaleString()} set aside
        </span>
      ) : null}
    </p>
  );
}

// ---------------------------------------------------------------------------
// What the report holds
// ---------------------------------------------------------------------------

function ReportSection({ report, state }: { report: BaselineReport | null; state: OnboardingState }) {
  if (report === null) {
    const waiting = (state.baselineReportId ?? state.nextAction.reportId ?? null) !== null;
    return (
      <section className="profile-section">
        <h2>Your report</h2>
        {waiting ? (
          <EmptyState
            title="Your report is written and has not been opened"
            detail="Opening it is what marks it read and moves your journey on, so this page will not do it for you."
            action={
              <Link to="/report" className="primary-button inline-flex">
                Open your report
              </Link>
            }
          />
        ) : (
          <EmptyState
            title="No report has been published yet"
            detail="The measures above exist before the report does. A report is published once the examination has finished laying them out."
          />
        )}
      </section>
    );
  }

  const sections = summariseReport(report.items).filter(
    (section) => section.notes.length > 0 || section.unreadable > 0,
  );
  const published = new Date(report.publishedAt).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  return (
    <section className="profile-section">
      <div className="profile-section-head">
        <h2>Your report</h2>
        <Link to="/report" className="text-link">
          Open it
        </Link>
      </div>
      <p className="profile-lede">
        Published {published} on the {report.plan === "pro" ? "Pro" : "Free"} plan. A conclusion
        carries an id and no text, and there is no endpoint that turns an id into a sentence, so
        what the report holds is counted here rather than written out.
      </p>

      {sections.length === 0 ? (
        <EmptyState
          title="The report is empty"
          detail="Your games were read and analysed, and nothing in them rose to something worth telling you. That is a statement about what Forma can currently read, not about how you play."
        />
      ) : (
        <ul className="report-sections">
          {sections.map((section) => (
            <li key={section.section}>
              <p className="cap">{section.title}</p>
              {section.notes.length > 0 ? (
                <ul className="coverage-limits">
                  {section.notes.map((note, index) => (
                    <li key={`${section.section}-${index}`}>{note}</li>
                  ))}
                </ul>
              ) : null}
              {section.unreadable > 0 ? (
                <p className="report-count">
                  {holdings(section.counts)
                    .filter((entry) => entry.kind !== "coverage")
                    .map((entry) => `${entry.count} ${entry.label}`)
                    .join(" · ")}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {report.withheld.length > 0 ? (
        <div className="report-withheld">
          {report.withheld.map((entry) => (
            <WithheldNote key={`${entry.section}-${entry.entitlementKey}`} entry={entry} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The games underneath all of it
// ---------------------------------------------------------------------------

const OUTCOME_LETTER: Record<string, { letter: string; label: string; tone: string }> = {
  win: { letter: "W", label: "Win", tone: "result-win" },
  loss: { letter: "L", label: "Loss", tone: "result-loss" },
  draw: { letter: "D", label: "Draw", tone: "result-draw" },
};

function GameSection({ games }: { games: RecentGame[] }) {
  if (games.length === 0) return null;

  return (
    <section className="profile-section">
      <h2>Your newest games</h2>
      <p className="profile-lede">
        The most recent games Forma has synced. The measures above were taken from a frozen
        snapshot of your archive, so a game here may be newer than the examination that read it.
      </p>
      <table className="profile-games">
        <thead>
          <tr>
            <th scope="col">Played</th>
            <th scope="col">As</th>
            <th scope="col">Opponent</th>
            <th scope="col">Time control</th>
            <th scope="col">Result</th>
          </tr>
        </thead>
        <tbody>
          {games.map((game) => {
            const outcome = game.outcome === null ? null : OUTCOME_LETTER[game.outcome];
            return (
              <tr key={game.id}>
                <td data-label="Played">
                  {game.playedAt === null
                    ? "Unknown"
                    : new Date(game.playedAt).toLocaleDateString(undefined, {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })}
                </td>
                <td data-label="As">{game.colour ?? "Unknown"}</td>
                <td data-label="Opponent">
                  {game.opponent ?? "Unnamed"}
                  {game.opponentRating === null ? null : (
                    <span className="figure profile-rating">{game.opponentRating}</span>
                  )}
                </td>
                <td data-label="Time control">{game.speed ?? "Unknown"}</td>
                <td data-label="Result">
                  {/* The letter carries the meaning and the colour only
                      reinforces it, so the column survives being read in
                      greyscale or by somebody who cannot separate the two. */}
                  {outcome === null ? (
                    <span className="tag tag-sub">Unknown</span>
                  ) : (
                    <span className={`result-chip ${outcome.tone}`}>
                      <span aria-hidden="true">{outcome.letter}</span>
                      <span className="sr-only">{outcome.label}</span>
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Where all of this came from, and what is still missing
// ---------------------------------------------------------------------------

function Provenance({ report }: { report: BaselineReport | null }) {
  return (
    <footer className="profile-provenance">
      {report === null ? null : (
        <p className="provenance" title={report.manifestSha256}>
          This report is immutable. It will not change under you.
        </p>
      )}
      {/* Named rather than left blank. Silence where a number belongs reads as
          a zero, and for the censored count in particular a zero would mean
          "you were given every chance and missed them", which is the opposite
          of what a censored observation says. */}
      <p className="provenance">
        Not on this screen yet: how often you took each chance, the range around that figure, and
        how many chances were set aside because you never got to answer. Forma records all three.
        None of them is published by the API this page reads, and it will not estimate them here.
      </p>
    </footer>
  );
}

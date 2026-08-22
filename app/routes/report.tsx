import { redirect, useLoaderData } from "react-router";
import type { ReactNode } from "react";
import type { Route } from "./+types/report";
import { TopNav } from "../components/TopNav";
import { RookMark } from "../components/Logo";
import { RouteError } from "../components/RouteError";
import { WithheldNote } from "../components/onboarding/WithheldNote";
import { Trajectory } from "../components/Trajectory";
import {
  CoverageWarnings,
  FindingList,
  MeasureList,
  RatingPools,
} from "../components/Measurements";
import { EmptyState } from "../components/v1/Honesty";
import { getCoverage, getMe, getOnboarding, getReport } from "../lib/onboarding/api";
import { limitationText } from "../lib/onboarding/copy";
import { getDashboard, groupMeasures } from "../lib/v1/dashboard";
import { coneFrom } from "../lib/trajectory";
import { ProblemError } from "../lib/v1/problem";
import type { BaselineReport, Dashboard, Me, OnboardingCoverage } from "../lib/v1/types";
import { requireSession } from "../lib/session";

/**
 * Your baseline report: the profile, frozen and printable.
 *
 * One content set, two presentations. `/profile` and this page render the same
 * components over the same publication, so nothing can be true on one and
 * missing from the other. What differs is what a page is *for*.
 *
 * **The order is inverted.** The profile opens on the trajectory, because a
 * page somebody visits should answer "how is my chess going" before it
 * qualifies itself. A document argues the other way round: coverage first, then
 * the picture, then the measures, then the conclusions. A reader who does not
 * know how much evidence is behind a claim cannot judge the claim, and unlike a
 * web page a printed sheet cannot be scrolled back up.
 *
 * **It is dated, numbered and provenanced.** A masthead, a section number on
 * every heading, and a colophon naming the publication, the recipe and the
 * snapshot hash. This is a thing somebody could send to a coach, so it has to
 * say what produced it.
 *
 * **It prints.** Sections avoid breaking across pages, the navigation and the
 * print control disappear, and the trajectory keeps its wash because a band
 * whose colour the printer dropped would be a grey blob.
 *
 * ## Reading a report is a write
 *
 * `getReport` records `report_viewed_at` and moves the run out of
 * `report_ready`; the write happens before the ETag is even compared, so even a
 * 304 has marked it. That is why this page fetches it and `/profile` does not,
 * and why coverage is fetched first: a coverage failure must not silently
 * consume the one thing that can only happen once.
 *
 * The baseline report is fetched tolerantly. Its content is now the dashboard's
 * — the report ships identifiers, and `/v1/dashboard` is what dereferences them
 * — so what it uniquely carries is the withheld list and the manifest hash. A
 * document that refused to render because that read failed would be withholding
 * the whole publication over its footer.
 */

export function meta() {
  return [{ title: "Your baseline report · Forma" }];
}

interface LoaderData {
  me: Me;
  dashboard: Dashboard | null;
  report: BaselineReport | null;
  coverage: OnboardingCoverage | null;
}

export async function clientLoader(): Promise<LoaderData> {
  await requireSession();
  const state = await getOnboarding();
  const reportId = state.baselineReportId ?? state.nextAction.reportId ?? null;

  // Coverage first. Reading the report is a *write*, so a coverage failure must
  // not consume the one thing that can only happen once.
  const coverage = state.runId === null ? null : await getCoverage(state.runId);

  const report =
    reportId === null
      ? null
      : await getReport(reportId)
          .then((result) => result.data)
          .catch((error: unknown) => {
            if (error instanceof Response) throw error; // the 401 redirect must land
            if (error instanceof ProblemError) return null;
            throw error;
          });

  const [dashboard, me] = await Promise.all([getDashboard(), getMe()]);

  // Nothing published and no report is not an empty document, it is somebody
  // who has not been examined yet, and /onboarding owns that conversation.
  if (dashboard === null && report === null) throw redirect("/onboarding");

  return { me, dashboard: dashboard?.data ?? null, report, coverage };
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <RouteError title="Could not open your report" error={error} />;
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/**
 * One numbered section.
 *
 * `break-inside: avoid` lives on this class rather than on each caller, so a
 * new section cannot be added that splits across a page fold by omission.
 */
function Part({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="report-part">
      <h2>
        <span className="report-part-n">{n}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

export default function Report() {
  const { me, dashboard, report, coverage } = useLoaderData<LoaderData>();
  const handle =
    me.accounts.find((account) => account.status === "active")?.handle ??
    me.accounts[0]?.handle ??
    "Your games";

  const published = new Date(
    dashboard?.publishedAt ?? report?.publishedAt ?? Date.now(),
  ).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });

  const cone = dashboard ? coneFrom(dashboard.trajectory) : null;
  const groups = dashboard ? groupMeasures(dashboard.estimates) : [];
  const eligible = coverage?.eligibleGames ?? null;
  const total = coverage?.totalGames ?? null;

  return (
    <div className="relative z-10 min-h-dvh">
      <a className="skip-link" href="#report-main">
        Skip to content
      </a>
      <TopNav current="account" />

      <main id="report-main" className="report-doc">
        <header className="report-masthead">
          <div className="report-mast-brand">
            <RookMark size={26} />
            <span>Forma</span>
          </div>
          <p className="report-kind">Baseline report</p>
          <h1>{handle}</h1>
          <dl className="report-facts">
            <div>
              <dt>Published</dt>
              <dd>{published}</dd>
            </div>
            <div>
              <dt>Games read</dt>
              <dd>{(dashboard?.trajectory.includedGameCount ?? 0).toLocaleString()}</dd>
            </div>
            {/* Only when the baseline report was readable. Printing "Free" for
                a plan nobody looked up would be a fact on a document that
                nothing stands behind. */}
            {report === null ? null : (
              <div>
                <dt>Plan</dt>
                <dd>{report.plan === "pro" ? "Pro" : "Free"}</dd>
              </div>
            )}
          </dl>
          {/* Hidden in print, because a document does not offer to print itself
              onto the page it is already printed on. */}
          <button type="button" className="secondary-button report-print" onClick={() => window.print()}>
            Print or save as PDF
          </button>
        </header>

        {dashboard === null ? (
          <EmptyState
            title="This report holds nothing that can be read yet"
            detail="A report was published for you, and the measurements behind it are not available on this account. Nothing here has been guessed at to fill the gap."
          />
        ) : (
          <>
            <Part n={1} title="What Forma could read">
              {eligible !== null && total !== null ? (
                <p className="report-lede">
                  <span className="figure">{eligible.toLocaleString()}</span> of{" "}
                  <span className="figure">{total.toLocaleString()}</span> synced games could be
                  read. Forma reads rated standard games against human opponents, which is the
                  limit of what it can say something honest about.
                </p>
              ) : null}
              <CoverageWarnings warnings={dashboard.coverageWarnings} />
              {coverage && coverage.limitations.length > 0 ? (
                <ul className="coverage-limits">
                  {coverage.limitations.map((slug) => (
                    <li key={slug}>{limitationText(slug)}</li>
                  ))}
                </ul>
              ) : null}
            </Part>

            <Part n={2} title="Where your games are decided">
              {cone === null ? (
                <p className="report-lede">
                  No trajectory was built for this report. Forma lines every game up by phase and
                  measures how far apart they are at each point, and that needs games whose
                  positions have been read all the way through.
                </p>
              ) : (
                <Trajectory cone={cone} />
              )}
            </Part>

            <Part n={3} title="What Forma measured">
              <p className="report-lede">
                Each row is a named chance Forma can find in your games and how often you took it,
                with the range that figure could plausibly sit in and the number of chances behind
                it. The bars share one scale so the rows read together; the measures do not, so read
                down the column for shape rather than for a ranking.
              </p>
              <MeasureList groups={groups} />
            </Part>

            <Part n={4} title="What Forma concluded">
              <FindingList findings={dashboard.findings} />
            </Part>

            <Part n={5} title="Your rating">
              <RatingPools profile={dashboard.ratingProfile} />
            </Part>

            {report !== null && report.withheld.length > 0 ? (
              <Part n={6} title="Not shown on your plan">
                {report.withheld.map((entry) => (
                  <WithheldNote key={`${entry.section}-${entry.entitlementKey}`} entry={entry} />
                ))}
              </Part>
            ) : null}

            <footer className="report-colophon">
              <p>
                This report is a publication, not a page. It was produced once from a frozen
                snapshot of your archive and will not change under you; a later examination
                publishes a new one beside it.
              </p>
              <dl>
                <div>
                  <dt>Publication</dt>
                  <dd>{dashboard.publicationId}</dd>
                </div>
                <div>
                  <dt>Recipe</dt>
                  <dd>{dashboard.version.recipeVersionId}</dd>
                </div>
                <div>
                  <dt>Snapshot</dt>
                  <dd>{dashboard.version.snapshotId}</dd>
                </div>
                {dashboard.version.estimatorVersions.length > 0 ? (
                  <div>
                    <dt>Estimators</dt>
                    <dd>{dashboard.version.estimatorVersions.join(", ")}</dd>
                  </div>
                ) : null}
                {report === null ? null : (
                  <div>
                    <dt>Manifest</dt>
                    <dd>{report.manifestSha256}</dd>
                  </div>
                )}
              </dl>
            </footer>
          </>
        )}
      </main>
    </div>
  );
}

import { Link, useLoaderData } from "react-router";
import type { Route } from "./+types/profile";
import { TopNav } from "../components/TopNav";
import { RouteError } from "../components/RouteError";
import { ChessComMark, LichessMark } from "../components/PlatformMarks";
import { CoverageBadge, EmptyState, RedactionNote } from "../components/v1/Honesty";
import { Trajectory } from "../components/Trajectory";
import {
  CoverageWarnings,
  FindingList,
  MeasureList,
  PublicationNote,
  RatingPools,
} from "../components/Measurements";
import { getCoverage, getMe, getOnboarding } from "../lib/onboarding/api";
import { limitationText, STAGE_LABEL, type Stage } from "../lib/onboarding/copy";
import { fetchRecentGames, type RecentGame } from "../lib/v1/games";
import { getDashboard, groupMeasures } from "../lib/v1/dashboard";
import { coneFrom } from "../lib/trajectory";
import type { Redaction } from "../lib/v1/client";
import type { Dashboard, Me, OnboardingCoverage, OnboardingState } from "../lib/v1/types";
import { requireSession } from "../lib/session";

/**
 * Everything Forma has measured about you, current and explorable.
 *
 * `/profile` and `/report` are one content set in two presentations. Whatever
 * the report says, this page says: both render the same components over the
 * same publication, and the difference is chrome and mutability rather than
 * content. What this page adds is that it is *alive* — it sits beside your
 * newest games, it links onward, and it is read rather than filed.
 *
 * ## What it reads
 *
 * `GET /v1/dashboard`, which is the endpoint that made this page possible. The
 * baseline report ships its items as identifiers — a finding id, an estimate
 * id, a trajectory snapshot id — and until that route existed there was nothing
 * to dereference them against, so a subject with sixty-three skill estimates
 * and a full trajectory had no endpoint that would return a single number of
 * it. The previous version of this page said so in a footer. It no longer has
 * to.
 *
 * It also reads the onboarding coverage route for how much of the archive was
 * eligible, and `/v1/games/recent` for the games underneath everything.
 *
 * It deliberately does **not** read the baseline report. Fetching one is a
 * write: it records `report_viewed_at` and moves the run out of `report_ready`.
 * A hub that opened somebody's report on their behalf would consume the one
 * thing that can only happen once, so the link to `/report` is a link and the
 * reader presses it.
 *
 * ## The order, and why
 *
 * The head carries the evidence — games read, date published — before any claim
 * is made, so nothing on this page is a figure without a scale. Then the
 * trajectory, because it is the one thing here that answers "how is my chess
 * going" in a glance and it carries its own sample decay in the picture. Then
 * what Forma could read, what it measured, what it concluded, the ratings, and
 * the games it all came from. That is the report's own order with the
 * conclusion pulled to the front, which is the difference between a document
 * you file and a page you visit.
 */

export function meta() {
  return [{ title: "Your profile · Forma" }];
}

interface LoaderData {
  me: Me;
  state: OnboardingState;
  dashboard: Dashboard | null;
  /** Sections the plan withheld. Named, never silently absent. */
  redactions: Redaction[];
  coverage: OnboardingCoverage | null;
  games: RecentGame[];
}

export async function clientLoader(): Promise<LoaderData> {
  await requireSession();
  const [me, state] = await Promise.all([getMe(), getOnboarding()]);

  // `fetchRecentGames` never throws and never blocks the rest of the page: the
  // games are the raw material, not the measurement, and an empty list is a
  // section that does not render rather than a page that does not.
  const [dashboard, coverage, games] = await Promise.all([
    getDashboard(),
    state.runId === null ? Promise.resolve(null) : getCoverage(state.runId),
    fetchRecentGames(12),
  ]);

  return {
    me,
    state,
    dashboard: dashboard?.data ?? null,
    redactions: dashboard?.meta.redactions ?? [],
    coverage,
    games,
  };
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return <RouteError title="Could not open your profile" error={error} />;
}

export default function Profile() {
  const { me, state, dashboard, redactions, coverage, games } = useLoaderData<LoaderData>();

  return (
    <div className="relative z-10 min-h-dvh">
      <a className="skip-link" href="#profile-main">
        Skip to content
      </a>
      <TopNav current="account" />
      <main id="profile-main" className="profile-shell">
        <ProfileHead me={me} dashboard={dashboard} />

        {dashboard === null ? (
          <NothingMeasured state={state} />
        ) : (
          <>
            <TrajectorySection dashboard={dashboard} />
            <ReadSection dashboard={dashboard} coverage={coverage} />
            <MeasureSection dashboard={dashboard} />
            <FindingSection dashboard={dashboard} />
            <RatingSection dashboard={dashboard} />
            <GameSection games={games} />
            <DocumentSection dashboard={dashboard} redactions={redactions} />
          </>
        )}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Who this is, and how much is behind what follows
// ---------------------------------------------------------------------------

function ProviderMark({ provider }: { provider: Me["accounts"][number]["provider"] }) {
  return provider === "chesscom" ? <ChessComMark size={16} /> : <LichessMark size={16} />;
}

/** The two statuses that are not "active", as words rather than as enum values. */
const ACCOUNT_STATUS: Record<string, string> = {
  paused: "Paused",
  disconnected: "Disconnected",
};

function ProfileHead({ me, dashboard }: { me: Me; dashboard: Dashboard | null }) {
  const accounts = me.accounts;
  const primary = accounts.find((account) => account.status === "active") ?? accounts[0] ?? null;
  const games = dashboard?.trajectory.includedGameCount ?? 0;

  return (
    <header className="profile-head">
      <p className="eyebrow">Your profile</p>
      <h1>{primary?.handle ?? "Not connected yet"}</h1>
      {/* The scale of the evidence, before the first claim rather than after
          it. Every figure below is drawn from this many games, and a reader who
          learns that at the bottom of the page has already read the numbers
          without it. */}
      {dashboard === null ? null : (
        <p className="profile-standing">
          Measured from <span className="figure">{games.toLocaleString()}</span>{" "}
          {games === 1 ? "game" : "games"}, published{" "}
          {new Date(dashboard.publishedAt).toLocaleDateString("en-GB", {
            day: "numeric",
            month: "long",
            year: "numeric",
          })}
          .
        </p>
      )}
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
// Nothing to show — which is several different days, not one
// ---------------------------------------------------------------------------

/**
 * Nothing to show is four different days, and only one of them is a problem.
 *
 * A brand new account, an examination still running, a run that failed and a
 * finished run with nothing published all render as an absence, and collapsing
 * them into one apology would leave most of the people who see it with no idea
 * what to do next.
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
            detail: `Nothing is published until the examination finishes, because a half-read archive gives numbers that change under you. Current stage: ${
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
// Where your games are decided
// ---------------------------------------------------------------------------

/**
 * The trajectory, which is the one picture on this page.
 *
 * It leads because it is the only thing here that answers "how is my chess
 * going" without being read line by line, and because it carries its own
 * evidence: the games behind each phase, and the share of the archive that
 * reached it, are drawn into the figure rather than qualified underneath it.
 */
function TrajectorySection({ dashboard }: { dashboard: Dashboard }) {
  const trajectory = dashboard.trajectory;
  const cone = coneFrom(trajectory);

  if (trajectory.state !== "published" || cone === null) {
    return (
      <section className="profile-section">
        <h2>Where your games are decided</h2>
        <EmptyState
          title="No trajectory has been built yet"
          detail="Forma lines every game up by phase and looks at how far apart they are at each point. That needs games whose positions have been read all the way through, and this report has none."
        />
      </section>
    );
  }

  return (
    <section className="profile-section profile-section-lead">
      <h2>Where your games are decided</h2>
      <Trajectory cone={cone} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// What Forma could read
// ---------------------------------------------------------------------------

function ReadSection({
  dashboard,
  coverage,
}: {
  dashboard: Dashboard;
  coverage: OnboardingCoverage | null;
}) {
  const eligible = coverage?.eligibleGames ?? null;
  const total = coverage?.totalGames ?? null;
  // Layout only: the same two numbers the sentence states, drawn as the share
  // of the archive they are. Nothing is derived that is not already written
  // out in words beside it.
  const share = eligible !== null && total !== null && total > 0 ? (eligible / total) * 100 : null;

  return (
    <section className="profile-section">
      <div className="profile-section-head">
        <h2>What Forma could read</h2>
        {coverage ? <CoverageBadge state={coverage.overallState} /> : null}
      </div>

      {eligible !== null && total !== null ? (
        <>
          <p className="profile-count">
            <span className="figure">{eligible.toLocaleString()}</span> of{" "}
            <span className="figure">{total.toLocaleString()}</span> synced games could be read.
            Forma reads rated standard games against human opponents, which is the limit of what it
            can say something honest about.
          </p>
          {share === null ? null : (
            <div className="coverage-track" aria-hidden="true">
              <span style={{ width: `${share}%` }} />
            </div>
          )}
        </>
      ) : null}

      <CoverageWarnings warnings={dashboard.coverageWarnings} />

      {coverage && coverage.limitations.length > 0 ? (
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
// What Forma measured
// ---------------------------------------------------------------------------

function MeasureSection({ dashboard }: { dashboard: Dashboard }) {
  // Sixty-odd rows arrive because every measure is estimated in two frames and
  // over two windows. They are one measure each, and a page that listed rows
  // would name the same thing three times under three unreadable keys.
  const groups = groupMeasures(dashboard.estimates);

  return (
    <section className="profile-section">
      <h2>What Forma measured</h2>
      <p className="profile-lede">
        Each row is a named chance Forma can find in your games and how often you took it, with the
        range that figure could plausibly sit in and the number of chances behind it. The bars share
        one scale so the rows read together, but the measures do not: taking a piece your opponent
        left hanging is not the same difficulty as converting a won endgame, so read down the column
        for shape rather than for a ranking.
      </p>
      <MeasureList groups={groups} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// What Forma concluded
// ---------------------------------------------------------------------------

function FindingSection({ dashboard }: { dashboard: Dashboard }) {
  return (
    <section className="profile-section">
      <h2>What Forma concluded</h2>
      <p className="profile-lede">
        Conclusions are drawn from the measures above and are held to a false-discovery correction,
        so a pattern that is only chance does not become a sentence about you.
      </p>
      <FindingList findings={dashboard.findings} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Rating
// ---------------------------------------------------------------------------

function RatingSection({ dashboard }: { dashboard: Dashboard }) {
  return (
    <section className="profile-section">
      <h2>Your rating</h2>
      <RatingPools profile={dashboard.ratingProfile} />
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
        The most recent games Forma has synced. Everything above was measured from a frozen snapshot
        of your archive, so a game here may be newer than the examination that read it.
      </p>
      <div className="table-scroll">
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
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The same thing, as a document
// ---------------------------------------------------------------------------

/**
 * The report, named as what it is: this page frozen and printable.
 *
 * Not a nav item called "Report". A reader who has just scrolled through the
 * content has no reason to visit a second page that holds the same content
 * unless the link says what the difference is, so it says.
 */
function DocumentSection({
  dashboard,
  redactions,
}: {
  dashboard: Dashboard;
  redactions: Redaction[];
}) {
  return (
    <section className="profile-section">
      <h2>Take it with you</h2>
      <p className="profile-lede">
        Everything above, dated and laid out to print or send. It is a publication rather than a
        page: it names the analysis that produced it and will not change under you.
      </p>
      <Link to="/report" className="primary-button inline-flex">
        Open the printable report
      </Link>

      {redactions.map((redaction) => (
        <RedactionNote
          key={redaction.path}
          redaction={redaction}
          what={redaction.path.replace(/^data\./, "").replace(/([A-Z])/g, " $1").toLowerCase()}
        />
      ))}

      <PublicationNote dashboard={dashboard} />
    </section>
  );
}

import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, test, vi } from "vitest";
import type { OpeningShape } from "../lib/todayShape";
import type { RecentGame } from "../lib/v1/games";
import type { TodayReport } from "../lib/v1/dashboard";
import type { GoalProgress, GoalView } from "../lib/v1/goals";
import type { TrajectoryBin } from "../lib/v1/types";
import type { PhaseReading } from "../lib/v1/dashboard";
import { buildCone } from "../lib/trajectory";
import type { Destination } from "../lib/onboarding/nextScreen";

/**
 * The hub, tested where it would go back to claiming things.
 *
 * Every case here is a sentence the page used to print from the prototype API
 * and can no longer stand behind: a rating and a lifetime record, "no opening
 * mistakes" over a graph that has not been built yet, and a game result read
 * off the winning colour instead of the player's own outcome.
 *
 * `TopNav` is stubbed because it is chrome with its own settings menus, sound
 * and board-theme storage, none of which this page's honesty depends on.
 */

vi.mock("./TopNav", () => ({ TopNav: () => null }));

const { Today } = await import("./Today");

const shape = (over: Partial<OpeningShape> = {}): OpeningShape => ({
  bars: [{ moveNo: 1, mistakes: 0, moves: 4 }],
  total: 0,
  peak: null,
  ...over,
});

const game = (over: Partial<RecentGame> = {}): RecentGame => ({
  id: "g1",
  opponent: "someone",
  opponentRating: null,
  colour: "black",
  speed: "blitz",
  result: "white",
  outcome: "loss",
  playedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  providerUrl: "https://lichess.org/g1",
  initialFen: null,
  moves: [{ uci: "e2e4" }],
  ...over,
});

function draw(props: Partial<Parameters<typeof Today>[0]> = {}) {
  return render(
    <MemoryRouter>
      <Today
        shape={shape()}
        lead={null}
        empty={null}
        games={40}
        unanalysed={0}
        lastGame={null}
        run={null}
        report={null}
        queue={null}
        goal={null}
        goalProgress={null}
        {...props}
      />
    </MemoryRouter>,
  );
}

const bin = (
  over: Partial<TrajectoryBin> & { phase: string; binOrdinal: number },
): TrajectoryBin => ({
  progressLow: over.binOrdinal / 4,
  progressHigh: (over.binOrdinal + 1) / 4,
  gamesContributing: 200,
  medianExpectedScore: 0.5,
  p25ExpectedScore: 0.34,
  p75ExpectedScore: 0.68,
  intervalLow: null,
  intervalHigh: null,
  phaseReachRate: 1,
  ...over,
});

/** A real cone, so the figure that carries the provenance actually renders. */
const cone = () =>
  buildCone([
    bin({ phase: "opening", binOrdinal: 0 }),
    bin({ phase: "opening", binOrdinal: 1 }),
    bin({ phase: "middlegame", binOrdinal: 0, gamesContributing: 160, phaseReachRate: 0.8 }),
    bin({ phase: "middlegame", binOrdinal: 1, gamesContributing: 160, phaseReachRate: 0.8 }),
  ])!;

/** One published phase, so the dials the provenance hangs off actually draw. */
const reading = (over: Partial<PhaseReading> = {}): PhaseReading => ({
  phase: "opening",
  rate: 0.62,
  intervalLow: 0.58,
  intervalHigh: 0.66,
  took: 124,
  chances: 200,
  setAside: 8,
  gamesReaching: 200,
  coverageStatus: "sufficient",
  unavailableReason: null,
  movement: "unclear",
  change: null,
  ...over,
});

const report = (over: Partial<TodayReport> = {}): TodayReport => ({
  headline: "Your games are decided in the middlegame.",
  detail: "At the start of the opening the middle half of your games sit between 51% and 52%.",
  finding: null,
  cone: null,
  phases: [],
  accuracy: [],
  readings: [],
  milestones: [],
  measured: 5,
  conclusions: 3,
  games: 200,
  rating: null,
  measures: [],
  publishedAt: "2026-08-20T18:22:33.011Z",
  ...over,
});

const goal = (over: Partial<GoalView> = {}): GoalView => ({
  goalId: "goal-1",
  subjectId: "subject-1",
  status: "active",
  statedObjective: "Reach 1600 blitz on lichess",
  comparisonFrame: "personal_current",
  targetProvider: "lichess",
  targetSpeed: "blitz",
  horizonDays: 90,
  uncalibratedCaveat: null,
  createdAt: new Date().toISOString(),
  activatedAt: new Date().toISOString(),
  closedAt: null,
  closeOutcome: null,
  closeNote: null,
  ...over,
});

const progress = (over: Partial<GoalProgress> = {}): GoalProgress => ({
  state: "published",
  metrics: [
    {
      metricKey: "rating_blitz",
      currentValue: 1540,
      readiness: 0.7,
      claimState: "improving",
      targetAchieved: false,
      unavailableReason: null,
    },
  ],
  adherence: { ratio: 0.8, note: "This is how much of what you committed to you did." },
  realGameEvidence: 12,
  practiceEvidence: 30,
  ...over,
});

describe("Today", () => {
  test("with nothing published the opening shape takes the heading back", () => {
    // A page still has to open on something it means, and the shape's own
    // empty states are the right thing to say to somebody whose games have not
    // been read yet.
    draw();
    expect(screen.getByRole("heading", { level: 1 }).id).toBe("today-shape-head");
  });

  test("a published report takes the heading, and the mistake bars step down", () => {
    // The owner asked twice for the opening-mistake bar chart not to be the
    // hero. With a report it is not rendered here at all; /openings owns it.
    draw({
      report: report(),
      shape: shape({ total: 12, peak: { from: 5, to: 7, mistakes: 4 }, bars: [{ moveNo: 5, mistakes: 4, moves: 9 }] }),
    });
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toMatch(/decided in the middlegame/i);
    expect(screen.queryByText(/of your opening mistakes land between moves/i)).toBeNull();
  });

  test("the link to the report says what is inside it, and never counts conclusions", () => {
    // "Report" as a bare nav item gave nobody a reason to press it. The
    // conclusion count is deliberately absent: the published findings are
    // duplicated across two statistical frames, so the row count is not an
    // honest figure to put in front of somebody.
    draw({ report: report({ measured: 5, conclusions: 12, games: 200 }) });
    expect(screen.getByText(/over 200 games/i)).toBeTruthy();
    expect(screen.getByText(/5 areas/i)).toBeTruthy();
    expect(screen.queryByText(/12 conclusions/i)).toBeNull();
  });

  test("the cohort and its date travel with the figure they qualify", () => {
    // A report is a frozen cohort, and 200 with no date invites a reader with
    // 333 synced games to conclude the product cannot count. It is provenance
    // rather than a statistic, though, so it sits in the figure's own note
    // instead of standing under the heading as a chip.
    draw({
      report: report({
        games: 200,
        publishedAt: "2026-08-20T18:22:33.011Z",
        readings: [reading()],
      }),
    });
    const text = document.body.textContent ?? "";
    expect(text).toContain("Measured over 200 games");
    expect(text).toContain("published 20 August");
  });

  test("a rating is quoted with the pool it came from, never on its own", () => {
    draw({
      report: report({
        rating: { provider: "lichess", speed: "blitz", rating: 1842 },
        readings: [reading()],
      }),
    });
    const text = document.body.textContent ?? "";
    // Pools are not comparable, so the figure never appears without the one
    // it came from.
    expect(text).toContain("1,842");
    // As words, never as the wire's keys: "blitz on chesscom" is a database
    // key reaching a customer.
    expect(text).toContain("Blitz on Lichess");
  });

  test("the three dials are read in one unit, and never in three", () => {
    // The row this replaced said "1.4 mistakes per game", "-34 points given
    // up" and "62% winning positions converted" side by side. Those cannot be
    // ranked against each other, and two of the three were coloured from
    // thresholds that appear nowhere in the contract.
    const { container } = draw({
      report: report({
        readings: [
          reading({ phase: "opening", rate: 0.72, movement: "gaining" }),
          reading({ phase: "middlegame", rate: 0.41, movement: "declined" }),
          reading({ phase: "endgame", rate: 0.58, movement: "unclear" }),
        ],
      }),
    });
    const figures = container.querySelectorAll(".phase-node-read");
    expect(figures).toHaveLength(3);
    for (const figure of figures) {
      // Label, figure, then what the figure is of - in one unit, every time.
      expect(figure.textContent).toMatch(/^Handled\d+%[\d,]+ of [\d,]+ key moments$/);
    }
    // And the row says out loud that it is not a ranking, on the page rather
    // than inside a dialog nobody opens.
    expect(container.querySelector(".today-phases-caveat")!.textContent).toMatch(
      /not against the others/,
    );
  });

  test("the trajectory graph is not drawn on the hub, even when published", () => {
    // It was, for one revision, with the rings as its legend - and the two
    // instruments disagreed on sight: the line reads the median, the rings
    // count key moments handled, and a hero that needs a footnote to hold
    // its own two pictures apart is arguing with itself. The conclusion
    // survives as the headline; the picture lives on /profile and /report.
    const { container } = draw({
      report: report({
        cone: cone(),
        readings: [reading({ phase: "opening" }), reading({ phase: "middlegame" })],
      }),
    });
    expect(container.querySelector(".cone")).toBeNull();
    expect(container.querySelector(".phase-row")).toBeTruthy();
    expect(container.querySelector(".today-phases-caveat")!.textContent).toMatch(
      /not against the others/,
    );
  });

  test("a phase with no publishable rate shows the reason, never a score", () => {
    // The contract's rule: an empty phase is never rendered as 0%, and the
    // reason stands where the percentage would.
    const { container } = draw({
      report: report({
        readings: [
          reading({
            phase: "endgame",
            rate: null,
            intervalLow: null,
            intervalHigh: null,
            took: 0,
            chances: 0,
            gamesReaching: 0,
            unavailableReason: "no_observations",
          }),
        ],
      }),
    });
    const read = container.querySelector(".phase-node-read.is-none");
    expect(read?.textContent).toMatch(/None of your games reached here/);
    expect(container.querySelector(".phase-node-read")!.textContent).not.toMatch(/0%/);
  });

  test("a phase nobody has compared is grey, not a verdict", () => {
    // Colouring an uncompared phase either way is the product issuing a
    // judgement the estimator declined to issue.
    const { container } = draw({
      report: report({ readings: [reading({ movement: "unclear", change: null })] }),
    });
    expect(container.querySelector(".phase-node")!.className).toContain("is-unclear");
  });

  test("a conclusion with no readable text leaves the slot empty", () => {
    // There is no endpoint that turns a finding id into prose, so nothing is
    // written here to fill the gap.
    const { container } = draw({ report: report({ finding: null }) });
    expect(container.querySelector(".today-verdict-finding")).toBeNull();
  });

  test("a graph that has not been built yet does not read as a clean sheet", () => {
    // The three reasons for an empty graph produced one sentence, and this was
    // the one that lied: work still running, reported as nothing found.
    draw({ empty: "not_materialized", games: 333 });
    expect(screen.queryByText(/No opening mistakes/i)).toBeNull();
    expect(screen.getByText(/have not been broken into positions yet/i)).toBeTruthy();
  });

  test("no games connected is its own sentence", () => {
    draw({ empty: "no_games", games: 0 });
    expect(screen.getByText(/No games yet/i)).toBeTruthy();
  });

  test("a graph with no mistakes says so, and says over how many games", () => {
    draw({ empty: null, games: 40 });
    expect(screen.getByText(/No opening mistakes found/i)).toBeTruthy();
  });

  test("the last game is reported by the player's outcome, not the winning colour", () => {
    // `result` is "white" here and `outcome` is "loss". Reading the first would
    // congratulate a player on a game they lost.
    draw({ lastGame: game() });
    expect(screen.getByText(/Lost against someone, 2d ago/)).toBeTruthy();
  });

  test("a game with no link is stated, not turned into a link to this page", () => {
    // `providerUrl` is nullable, and the card used to fall through to
    // `to={item.to ?? "/today"}` - so a game Forma could not link to became a
    // control that sent the reader to the page they were already on.
    const { container } = draw({ lastGame: game({ providerUrl: null }) });
    const card = container.querySelector(".deck-card.is-inert");
    expect(card).toBeTruthy();
    expect(card!.tagName).toBe("DIV");
    expect(container.querySelector('.deck-card[href="/today"]')).toBeNull();
  });

  test("a game with no provider link still states the fact", () => {
    draw({ lastGame: game({ providerUrl: null, opponent: null, outcome: null }) });
    expect(screen.getByText(/Played, 2d ago/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open" })).toBeNull();
  });

  test("a written report is a row that goes to it", () => {
    const run: Destination = { kind: "report", reportId: "r1" };
    draw({ run });
    expect(
      screen.getByRole("link", { name: /baseline report is ready/i }).getAttribute("href"),
    ).toBe("/report");
  });

  test("a dead sync is not reported as work in progress", () => {
    const run: Destination = { kind: "stuck", reason: null, workflowFailed: true };
    draw({ run });
    expect(screen.getByText(/The examination stopped/)).toBeTruthy();
    expect(screen.queryByText(/Forma is reading your games/)).toBeNull();
  });

  test("a stopped run is the one thing to do, and is not also a card below it", () => {
    // The act and the deck both know how to render a run that needs attention,
    // and a page that says "The examination stopped" twice reads as two
    // different problems. Whatever the act takes, the deck gives up.
    const run: Destination = { kind: "stuck", reason: null, workflowFailed: true };
    draw({ run });
    expect(screen.getAllByText(/The examination stopped/)).toHaveLength(1);
  });

  test("the queue is a counted destination, not the page's one big box", () => {
    // The hub carried a large accented card saying "10 positions ready" and it
    // was the last thing still trying to be the decision. The path is the
    // decision; the queue is a real destination with a counted reason, which
    // is the only test a deck card has to pass.
    const { container } = draw({ queue: { due: 14, overdue: 3 }, lead: null });
    const card = screen.getByRole("link", { name: /14 positions ready/i });
    expect(card.getAttribute("href")).toBe("/practice");
    expect(card.className).toContain("deck-card");
    expect(container.querySelector(".today-act")).toBeNull();
  });

  test("a run that could not be read produces no row at all", () => {
    draw({ run: null });
    expect(screen.queryByLabelText("Then")).toBeNull();
  });

  test("no goal is an honest empty state, not a hidden section", () => {
    draw();
    expect(screen.getByText(/No goal set yet/i)).toBeTruthy();
  });

  test("a goal with nothing measured yet says so by name", () => {
    draw({ goal: goal({ statedObjective: "Reach 1600 blitz on lichess" }) });
    expect(screen.getByText("Reach 1600 blitz on lichess")).toBeTruthy();
    expect(screen.getByText(/Nothing measured on it yet/i)).toBeTruthy();
  });

  test("progress counts targets met, and never a metric's database key", () => {
    // `/v1/goals` returns each metric under a key and no display name, so the
    // rows this replaced printed a slug per line. How many of the goal's
    // targets are met is the one thing that can be said without naming a
    // metric, and it is also what somebody wants to know.
    const { container } = draw({ goal: goal(), goalProgress: progress() });
    const targets = container.querySelector(".today-progress-targets");
    expect(targets?.textContent).toMatch(/^\d+\/\d+ targets? met$/);
    expect(container.querySelector(".today-progress-card")!.textContent).not.toMatch(/_/);
  });

  test("adherence never stands in for progress", () => {
    // An activity counter is not a measurement. A page that renders "you did
    // 80% of what you committed to" beside a goal is telling somebody that
    // practising and improving are the same thing.
    draw({ goal: goal(), goalProgress: progress() });
    expect(screen.queryByText(/what you committed to/i)).toBeNull();
    expect(screen.getByText(/real games count toward this/i)).toBeTruthy();
  });
});

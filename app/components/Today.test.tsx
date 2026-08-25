import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, test, vi } from "vitest";
import type { OpeningShape } from "../lib/todayShape";
import type { RecentGame } from "../lib/v1/games";
import type { Measure, TodayReport } from "../lib/v1/dashboard";
import type { GoalProgress, GoalView } from "../lib/v1/goals";
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
        goal={null}
        goalProgress={null}
        {...props}
      />
    </MemoryRouter>,
  );
}

const measure = (over: Partial<Measure> = {}): Measure => ({
  baseKey: "material_safety_respond",
  name: "Keeping your pieces safe",
  role: "Responding to it",
  definition: null,
  rate: 0.431,
  intervalLow: 0.411,
  intervalHigh: 0.45,
  sample: 1940,
  coverageStatus: "sufficient",
  unavailableReason: null,
  // The real published figures for this measure, so the fixture exercises the
  // same rounding the live page does.
  change: {
    from: 0.465,
    to: 0.4,
    delta: -0.06502,
    improvementProbability: 0.00348,
    movement: "declined",
    sample: 970,
  },
  ...over,
});

const report = (over: Partial<TodayReport> = {}): TodayReport => ({
  headline: "Your games are decided in the middlegame.",
  detail: "At the start of the opening the middle half of your games sit between 51% and 52%.",
  finding: null,
  cone: null,
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
    expect(screen.getByText(/5 measured areas across 200 games/i)).toBeTruthy();
    expect(screen.queryByText(/12 conclusions/i)).toBeNull();
  });

  test("the cohort is dated, so a smaller count than the archive reads as correct", () => {
    // A report is a frozen cohort. Printing 200 with no date invites a reader
    // with 333 synced games to conclude the product cannot count.
    draw({ report: report({ games: 200, publishedAt: "2026-08-20T18:22:33.011Z" }) });
    expect(screen.getByText(/measured over/i).textContent).toMatch(/200.*20 August/);
  });

  test("a rating is quoted with the pool it came from, never on its own", () => {
    draw({ report: report({ rating: { provider: "lichess", speed: "blitz", rating: 1842 } }) });
    expect(screen.getByText(/1,842/)).toBeTruthy();
    expect(screen.getByText(/blitz on lichess/i)).toBeTruthy();
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

  test("a game with no provider link still states the fact", () => {
    draw({ lastGame: game({ providerUrl: null, opponent: null, outcome: null }) });
    expect(screen.getByText(/Played, 2d ago/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open" })).toBeNull();
  });

  test("a written report is a row that goes to it", () => {
    const run: Destination = { kind: "report", reportId: "r1" };
    draw({ run });
    expect(screen.getByRole("link", { name: "Read it" }).getAttribute("href")).toBe("/report");
  });

  test("a dead sync is not reported as work in progress", () => {
    const run: Destination = { kind: "stuck", reason: null, workflowFailed: true };
    draw({ run });
    expect(screen.getByText(/The examination stopped/)).toBeTruthy();
    expect(screen.queryByText(/Forma is reading your games/)).toBeNull();
  });

  test("a run that could not be read produces no row at all", () => {
    draw({ run: null });
    expect(screen.queryByLabelText("Then")).toBeNull();
  });

  test("the stack leads with the measure going most clearly wrong", () => {
    // Ranked by the posterior, not by rate: the rates are over different jobs
    // and sorting them would rank the catalogue's difficulty, not the player.
    // Here the worst *rate* is deliberately the one that is holding steady.
    draw({
      report: report({
        measures: [
          measure({
            baseKey: "worse_position_defence_respond",
            name: "Defending a worse position",
            rate: 0.844,
            change: {
              from: 0.892, to: 0.8, delta: -0.0927,
              improvementProbability: 0, movement: "declined", sample: 849,
            },
          }),
          measure({
            baseKey: "only_move_recognize",
            name: "Finding the move that held",
            rate: 0.047,
            change: {
              from: 0.046, to: 0.051, delta: 0.0049,
              improvementProbability: 0.58, movement: "unclear", sample: 168,
            },
          }),
        ],
      }),
    });
    const rows = screen.getAllByRole("button", { expanded: true })
      .concat(screen.getAllByRole("button", { expanded: false }));
    expect(rows[0]!.textContent).toMatch(/Defending a worse position/);
    expect(screen.getByText("Gone backwards")).toBeTruthy();
  });

  test("a decline is reported, not only an improvement", () => {
    // The findings vocabulary has no decline type at all, so a page built from
    // findings alone can report every gain and no loss. PRODUCT.md's whole
    // first principle is that the unflattering figure is the one that earns
    // trust, so the posterior is read directly.
    draw({ report: report({ measures: [measure()] }) });
    expect(screen.getByText("−7")).toBeTruthy();
    expect(screen.getByText("Gone backwards")).toBeTruthy();
  });

  test("two measures of one concept are told apart by their job", () => {
    // `critical_moment` is scored twice — noticing the position, and playing
    // it — and both carry the concept name. Without the role the stack shows
    // the same name twice and reads as a duplicated row.
    draw({
      report: report({
        measures: [
          measure({
            baseKey: "critical_moment_recognize",
            name: "Positions that decide the game",
            role: "Recognising the chance",
          }),
          measure({
            baseKey: "critical_moment_execute",
            name: "Positions that decide the game",
            role: "Following it through",
          }),
        ],
      }),
    });
    expect(screen.getByText("Recognising the chance")).toBeTruthy();
    expect(screen.getByText("Following it through")).toBeTruthy();
  });

  test("a near-zero posterior is never printed as impossible", () => {
    // 0.3% rounds to "0%", which tells somebody it is impossible their play
    // improved. The server's renderer refuses the same rounding at the other
    // end, and this is that rule mirrored.
    draw({ report: report({ measures: [measure()] }) });
    expect(screen.getByText(/under 1%/i)).toBeTruthy();
  });

  test("a posterior stored as exactly zero is still not impossible", () => {
    // `worse_position_defence` really is published as 0.00000: the column keeps
    // five decimal places and the model cannot produce a true zero, so this is
    // a rounded small number wearing an absolute.
    draw({
      report: report({
        measures: [
          measure({
            change: {
              from: 0.892, to: 0.8, delta: -0.09267,
              improvementProbability: 0, movement: "declined", sample: 849,
            },
          }),
        ],
      }),
    });
    expect(screen.getByText(/under 1%/i)).toBeTruthy();
    expect(screen.queryByText(/at 0%/i)).toBeNull();
  });

  test("a movement that rounds to nothing does not wear a sign", () => {
    draw({
      report: report({
        measures: [
          measure({
            change: {
              from: 0.046, to: 0.051, delta: 0.0049,
              improvementProbability: 0.58, movement: "unclear", sample: 168,
            },
          }),
        ],
      }),
    });
    expect(screen.getByText("0")).toBeTruthy();
    expect(screen.queryByText("+0")).toBeNull();
  });

  test("a measure with no second window is not reported as holding steady", () => {
    draw({ report: report({ measures: [measure({ change: null })] }) });
    expect(screen.getByText(/Not compared yet/i)).toBeTruthy();
  });

  test("no goal is an honest empty state, not a hidden section", () => {
    draw();
    expect(screen.getByText(/No goal set yet/i)).toBeTruthy();
  });

  test("a goal with nothing measured yet says so by name", () => {
    draw({ goal: goal({ statedObjective: "Reach 1600 blitz on lichess" }) });
    expect(screen.getByText("Reach 1600 blitz on lichess")).toBeTruthy();
    expect(screen.getByText(/Nothing has been measured on this goal yet/i)).toBeTruthy();
  });

  test("progress keeps adherence and evidence apart from the claim", () => {
    // An activity counter is not the same field as the claim state, and the
    // page must not let one stand in for the other.
    draw({ goal: goal(), goalProgress: progress() });
    expect(screen.getByText("Improving")).toBeTruthy();
    expect(screen.getByText(/12 real games have counted as evidence/i)).toBeTruthy();
    expect(screen.getByText(/This is how much of what you committed to you did/i)).toBeTruthy();
  });
});

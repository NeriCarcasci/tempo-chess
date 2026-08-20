/**
 * The profile page, tested on the promises it makes about numbers.
 *
 * Every test here is one way this page could start overstating what Forma
 * knows. It could print a rate the API never sent. It could print a raw
 * dimension key at somebody. It could let a chance the player never got to
 * answer read as a chance they missed. It could show a thin measure looking
 * exactly like a well-evidenced one. And it could open the baseline report on
 * the reader's behalf, which is a write.
 */

import { render } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { MemoryRouter } from "react-router";
import type {
  BaselineReport,
  Me,
  OnboardingCoverage,
  OnboardingState,
} from "../lib/v1/types";
import type { RecentGame } from "../lib/v1/games";

let data: unknown = null;
vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return { ...actual, useLoaderData: () => data };
});

const Profile = (await import("./profile")).default;

const me = (over: Partial<Me> = {}): Me =>
  ({
    profileId: "p1",
    locale: null,
    timezone: null,
    personalSubject: null,
    accounts: [
      {
        id: "a1",
        provider: "lichess",
        handle: "someone",
        connectionKind: "public_lookup",
        verificationStatus: "unverified",
        status: "active",
        providerHandleDiscoverable: false,
        createdAt: "2026-01-01T00:00:00Z",
      },
    ],
    ...over,
  }) as Me;

const state = (over: Partial<OnboardingState> = {}): OnboardingState =>
  ({
    runId: "run-1",
    stage: "activated",
    status: "activated",
    diagnosticChoice: "skip",
    syncWorkflowId: "wf-1",
    baselineReportId: "report-1",
    diagnosticSessionId: null,
    failureReason: null,
    nextAction: { action: "none" },
    ...over,
  }) as OnboardingState;

const coverage = (over: Partial<OnboardingCoverage> = {}): OnboardingCoverage =>
  ({
    state: "published",
    overallState: "limited",
    totalGames: 214,
    eligibleGames: 200,
    limitations: ["thin_dimensions"],
    dimensions: [
      {
        dimensionKey: "worse_position_defence_respond",
        observationCount: 1698,
        state: "sufficient",
        limitationReason: null,
      },
      {
        dimensionKey: "winning_conversion_convert",
        observationCount: 200,
        state: "limited",
        limitationReason: "41.2 chances after time weighting",
      },
      {
        dimensionKey: "only_move_recognize",
        observationCount: 335,
        state: "sufficient",
        limitationReason: null,
      },
    ],
    ...over,
  }) as OnboardingCoverage;

const report = (over: Partial<BaselineReport> = {}): BaselineReport =>
  ({
    reportId: "report-1",
    publishedAt: "2026-08-01T00:00:00Z",
    manifestSha256: "abc123",
    plan: "free",
    items: [
      { section: "headline", displayOrder: 0, itemKind: "narrative", findingId: null, estimateId: null, trajectorySnapshotId: null, coverageDimensionKey: null },
      { section: "coverage", displayOrder: 0, itemKind: "coverage", findingId: null, estimateId: null, trajectorySnapshotId: null, coverageDimensionKey: "few_games" },
      { section: "constraints", displayOrder: 0, itemKind: "finding", findingId: "finding-9f3", estimateId: null, trajectorySnapshotId: null, coverageDimensionKey: null },
    ],
    withheld: [{ section: "constraints", count: 14, entitlementKey: "pro_detail" }],
    ...over,
  }) as BaselineReport;

const shown = (over: Partial<Record<string, unknown>> = {}): string => {
  data = {
    me: me(),
    state: state(),
    coverage: coverage(),
    report: report(),
    games: [] as RecentGame[],
    ...over,
  };
  const { container } = render(
    <MemoryRouter>
      <Profile />
    </MemoryRouter>,
  );
  return container.textContent ?? "";
};

describe("the measures", () => {
  test("no rate is drawn, because no rate is published", () => {
    // The estimate, its interval and the graded/censored split live in
    // `analysis.player_skill_estimates` and no /v1 route returns them. A page
    // that filled the gap with a figure of its own would be making a claim
    // nobody computed, and it would be making it without an interval.
    const text = shown();
    expect(text).not.toMatch(/\d+(\.\d+)?%/);
    expect(text).not.toMatch(/0\.\d\d\b/);
  });

  test("a measure is named and defined, never shown as a slug", () => {
    const text = shown();
    expect(text).not.toContain("worse_position_defence");
    expect(text).not.toContain("(respond)");
    expect(text).toContain("Defending a worse position");
    expect(text).toContain("keep the game alive");
  });

  test("the sample size behind each measure is on the page", () => {
    // Precision is the whole point: 1,698 chances and 200 are not the same
    // claim, and the page has to make that visible even without the interval.
    const text = shown();
    expect(text).toContain("1,698");
    expect(text).toContain("200");
    expect(text).toContain("335");
  });

  test("a measure that is not sufficient says so, in the server's own words", () => {
    const text = shown();
    expect(text).toContain("Limited");
    expect(text).toContain("41.2 chances after time weighting");
  });

  test("a censored chance is described as set aside, never as a failure", () => {
    const text = shown();
    expect(text).toContain("set aside rather than counted against you");
    expect(text).toContain("resigned");
  });

  test("what is missing is named rather than left blank", () => {
    // Silence where a number belongs reads as a zero, and a censored count of
    // zero says the opposite of what a censored observation means.
    const text = shown();
    expect(text).toContain("never got to answer");
  });

  test("nothing measured is a sentence, not an empty page", () => {
    const text = shown({ coverage: coverage({ dimensions: [], limitations: [] }) });
    expect(text).toContain("No measure has any chances behind it");
  });
});

describe("the report", () => {
  test("a withheld group is counted and named, never silently absent", () => {
    const text = shown();
    expect(text).toContain("14 items on a paid plan");
  });

  test("a finding is counted rather than described, and its id never shown", () => {
    const text = shown();
    expect(text).not.toContain("finding-9f3");
    expect(text).toContain("1 conclusion");
  });

  test("a report that has not been opened is a link, not a fetch", () => {
    // Reading the report is a write: it records `report_viewed_at` and moves
    // the run on. The page offers the door instead of walking through it.
    const text = shown({ report: null, state: state({ stage: "report_ready", status: "active" }) });
    expect(text).toContain("has not been opened");
    expect(text).toContain("Open your report");
  });
});

describe("before anything has been measured", () => {
  test("a brand new account is taught, not shown an empty frame", () => {
    const text = shown({
      state: state({ runId: null, stage: "not_started", status: "not_started", baselineReportId: null }),
      coverage: null,
      report: null,
    });
    expect(text).toContain("Nothing has been measured yet");
    expect(text).not.toContain("What Forma measures");
  });

  test("coverage the server has not worked out yet is a wait, not a zero", () => {
    const text = shown({
      state: state({ stage: "analysing", status: "active", baselineReportId: null }),
      coverage: coverage({
        state: "unavailable",
        overallState: null,
        totalGames: null,
        eligibleGames: null,
        limitations: [],
        dimensions: [],
      }),
      report: null,
    });
    expect(text).toContain("still reading your games");
    expect(text).not.toContain("0 of 0");
  });

  test("a failed examination says so instead of showing nothing", () => {
    const text = shown({
      state: state({ status: "failed", stage: "analysing", baselineReportId: null }),
      coverage: null,
      report: null,
    });
    expect(text).toContain("did not finish");
  });
});

describe("the games", () => {
  const game = (over: Partial<RecentGame> = {}): RecentGame => ({
    id: "g1",
    opponent: "kasparov",
    opponentRating: 2812,
    colour: "black",
    speed: "blitz",
    result: "white",
    outcome: "loss",
    playedAt: "2026-07-30T00:00:00Z",
    providerUrl: null,
    initialFen: null,
    moves: [{ uci: "e2e4" }],
    ...over,
  });

  test("a result carries a letter, so the colour is never the only thing saying it", () => {
    data = {
      me: me(),
      state: state(),
      coverage: coverage(),
      report: report(),
      games: [game()],
    };
    const { container } = render(
      <MemoryRouter>
        <Profile />
      </MemoryRouter>,
    );
    const chip = container.querySelector(".result-chip");
    expect(chip?.textContent).toContain("L");
    expect(chip?.textContent).toContain("Loss");
  });

  test("no games synced yet is no section at all", () => {
    expect(shown({ games: [] })).not.toContain("Your newest games");
  });
});

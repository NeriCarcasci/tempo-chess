/**
 * The profile page, tested on the promises it makes about numbers.
 *
 * Every test here is one way this page could start overstating what Forma
 * knows. It could print a rate without the interval the estimator hedged it
 * with, or without the sample size that makes 50% of two hundred a different
 * claim from 84% of seventeen hundred. It could print a raw dimension key at
 * somebody. It could let a chance the player never got to answer read as a
 * chance they missed. It could draw a blank where an estimator refused to give
 * a number, which reads as a zero. And it could list sixty-three rows of the
 * same seven measures under three unreadable names each.
 */

import { render } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { MemoryRouter } from "react-router";
import type {
  Dashboard,
  Finding,
  Me,
  OnboardingCoverage,
  OnboardingState,
  SkillEstimate,
  TrajectoryBin,
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
    dimensions: [],
    ...over,
  }) as OnboardingCoverage;

/**
 * The words the API sends beside an estimate.
 *
 * They used to come from a table in the client, so a fixture only had to name a
 * dimension key and the right sentence appeared. They come off the wire now, so
 * a fixture that wants a row to read as "Defending a worse position" has to say
 * so -- which is the point: the page shows what it was sent, and a test that
 * could not get that wrong would not be testing it.
 */
const WIRE_COPY: Record<string, { name: string; definition: string }> = {
  material_safety_respond: {
    name: "Keeping your pieces safe",
    definition: "One of your pieces was available to be taken for less than it is worth.",
  },
  free_material_recognize: {
    name: "Taking what is offered",
    definition: "Your opponent left something available to be taken for less than it is worth.",
  },
  only_move_recognize: {
    name: "Finding the only move",
    definition: "Of the moves the engine examined, exactly one held.",
  },
  winning_conversion_convert: {
    name: "Converting a winning position",
    definition: "You reached a position that should win.",
  },
  worse_position_defence_respond: {
    name: "Defending a worse position",
    definition: "You were worse and had to keep the game alive.",
  },
};

const FRAMES = ["objective", "personal_current", "personal_baseline"];

/** The base key of a wire key, dropping the frame suffix the API appends. */
function baseOf(dimensionKey: string): string {
  for (const frame of FRAMES) {
    if (dimensionKey.endsWith(`_${frame}`)) {
      return dimensionKey.slice(0, -(frame.length + 1));
    }
  }
  return dimensionKey;
}

function wireCopy(dimensionKey: string) {
  const base = baseOf(dimensionKey);
  const known = WIRE_COPY[base];
  const match = /^(.*)_(recognize|execute|respond|convert)$/.exec(base);
  return {
    name: known?.name ?? "A measurement",
    copy: {
      conceptSlug: match?.[1] ?? null,
      role: match?.[2] ?? null,
      category: "tactical",
      roleLabel: "A measured role",
      definition: known?.definition ?? "",
      narrative: null,
    },
  };
}

const estimate = (over: Partial<SkillEstimate> & { dimensionKey: string }): SkillEstimate => ({
  displayName: wireCopy(over.dimensionKey).name,
  copy: wireCopy(over.dimensionKey).copy,
  frame: "objective",
  // Null on the per-concept rows; set only on the pooled per-phase ones.
  phase: null,
  windowKind: "lifetime",
  estimate: 0.5,
  intervalLow: 0.45,
  intervalHigh: 0.55,
  rawSampleSize: 200,
  effectiveSampleSize: 120,
  coverage: { success: 100, failure: 100, graded: 200, censored: 0 },
  coverageStatus: "sufficient",
  unavailableReason: null,
  delta: null,
  improvementProbability: null,
  ...over,
});

const bin = (over: Partial<TrajectoryBin> & { phase: string; binOrdinal: number }): TrajectoryBin => ({
  progressLow: over.binOrdinal / 2,
  progressHigh: (over.binOrdinal + 1) / 2,
  gamesContributing: 200,
  medianExpectedScore: 0.5,
  p25ExpectedScore: 0.4,
  p75ExpectedScore: 0.6,
  intervalLow: null,
  intervalHigh: null,
  phaseReachRate: 1,
  ...over,
});

const finding = (over: Partial<Finding> & { id: string }): Finding => ({
  findingType: "foundational_miss",
  priority: 10,
  confidenceTier: "moderate",
  claim: {},
  adjustedProbability: 0.01,
  evidence: [{ evidenceItemId: "e1", role: "primary", displayRank: 0 }],
  explanation: "You lose material to a capture you could have seen.",
  explanationState: "passed",
  ...over,
});

const dashboard = (over: Partial<Dashboard> = {}): Dashboard =>
  ({
    subjectId: "s1",
    publicationId: "pub-2f9",
    runId: "run-1",
    publishedAt: "2026-08-01T00:00:00Z",
    sections: {
      estimates: "published",
      findings: "published",
      trajectory: "published",
      ratingProfile: "published",
      goal: "unavailable",
      connections: "unavailable",
    },
    estimates: [
      estimate({
        dimensionKey: "worse_position_defence_respond_objective",
        estimate: 0.42,
        intervalLow: 0.39,
        intervalHigh: 0.45,
        rawSampleSize: 1698,
        coverage: { success: 713, failure: 985, graded: 1698, censored: 0 },
      }),
      estimate({
        dimensionKey: "worse_position_defence_respond_personal_current",
        frame: "personal_current",
        windowKind: "recent_form",
        estimate: 0.48,
        delta: 0.06,
        improvementProbability: 0.82,
      }),
      estimate({
        dimensionKey: "winning_conversion_convert_objective",
        estimate: 0.61,
        intervalLow: 0.5,
        intervalHigh: 0.72,
        rawSampleSize: 200,
        coverageStatus: "limited",
        coverage: { success: 97, failure: 62, graded: 159, censored: 41 },
      }),
      estimate({
        dimensionKey: "only_move_recognize_objective",
        estimate: null,
        intervalLow: null,
        intervalHigh: null,
        unavailableReason: "below_minimum_sample",
        coverageStatus: "insufficient",
        rawSampleSize: 12,
        coverage: { success: 0, failure: 0, graded: 12, censored: 0 },
      }),
    ],
    findings: [finding({ id: "finding-9f3" }), finding({ id: "finding-silent", explanation: null })],
    trajectory: {
      state: "published",
      snapshotId: "snap-1",
      includedGameCount: 200,
      bins: [
        bin({ phase: "opening", binOrdinal: 0, p25ExpectedScore: 0.511, p75ExpectedScore: 0.521 }),
        bin({ phase: "opening", binOrdinal: 1, p25ExpectedScore: 0.18, p75ExpectedScore: 0.961 }),
        bin({
          phase: "middlegame",
          binOrdinal: 0,
          p25ExpectedScore: 0,
          p75ExpectedScore: 0.667,
          gamesContributing: 163,
          phaseReachRate: 0.8,
        }),
        bin({
          phase: "endgame",
          binOrdinal: 0,
          p25ExpectedScore: 0.012,
          p75ExpectedScore: 0.741,
          gamesContributing: 48,
          phaseReachRate: 0.24,
        }),
      ],
      unreachedPhases: [],
    },
    ratingProfile: {
      state: "published",
      pools: [
        {
          provider: "lichess",
          pool: "lichess_blitz",
          speed: "blitz",
          observedRating: 1642,
          scaleEstimate: 1590,
          intervalLow: 1520,
          intervalHigh: 1660,
          inSupportedRange: true,
          suppressedReason: null,
        },
      ],
      note: "Ratings from different pools are not comparable. Forma does not combine them into one number.",
    },
    coverageWarnings: ["1 of 4 areas have too little evidence to estimate yet."],
    version: { recipeVersionId: "recipe-7", snapshotId: "snap-1", estimatorVersions: ["est-3"] },
    ...over,
  }) as Dashboard;

function draw(over: Record<string, unknown> = {}) {
  data = {
    me: me(),
    state: state(),
    dashboard: dashboard(),
    redactions: [],
    coverage: coverage(),
    games: [] as RecentGame[],
    ...over,
  };
  return render(
    <MemoryRouter>
      <Profile />
    </MemoryRouter>,
  );
}

const shown = (over: Record<string, unknown> = {}): string =>
  draw(over).container.textContent ?? "";

describe("the measures", () => {
  test("a rate never appears without its interval and its sample size", () => {
    // 50% over two hundred chances and 84% over seventeen hundred are different
    // claims. A page that prints both in the same weight says they are not.
    const { container } = draw();
    const figures = [...container.querySelectorAll(".rate-figure")];
    expect(figures.length).toBeGreaterThan(0);
    for (const figure of figures) {
      const text = figure.textContent ?? "";
      if (!text.includes("No figure")) {
        expect(text).toMatch(/\d+% to \d+%/);
      }
      expect(text).toMatch(/chances?/);
    }
  });

  test("a measure is named and defined, never shown as a slug", () => {
    const text = shown();
    expect(text).not.toContain("worse_position_defence");
    expect(text).not.toContain("(respond)");
    expect(text).toContain("Defending a worse position");
    expect(text).toContain("keep the game alive");
  });

  test("sixty-odd rows become one row per measure", () => {
    // Every measure arrives in two frames and over two windows. Listing rows
    // would name the same measure three times under three unreadable keys.
    const { container } = draw();
    expect(container.querySelectorAll(".rate-row")).toHaveLength(3);
  });

  test("a censored chance is set aside, never added to the failures", () => {
    const text = shown();
    expect(text).toContain("41 set aside");
    // 159 graded, not 200: the forty-one are out of the rate, not in it.
    expect(text).toContain("159 graded");
    expect(text).toContain("set aside rather than counted against you");
  });

  test("an estimate with no number keeps the reason it has none", () => {
    // A blank where a figure belongs reads as a zero, and "not enough evidence"
    // and "measured at zero" are opposite statements.
    const text = shown();
    expect(text).toContain("No figure");
    expect(text).toContain("Too few chances so far to put a number on this.");
  });

  test("a change is reported with how sure Forma is of it", () => {
    const text = shown();
    expect(text).toContain("6 up on your earlier ones");
    expect(text).toContain("82%");
  });

  test("nothing measured is a sentence, not an empty page", () => {
    const text = shown({ dashboard: dashboard({ estimates: [] }) });
    expect(text).toContain("No measure has any chances behind it");
  });
});

describe("the trajectory", () => {
  test("the graph carries a card per phase, each with its own game count", () => {
    const { container } = draw();
    const cards = [...container.querySelectorAll(".phase-card")];
    expect(cards).toHaveLength(3);
    expect(cards[2]!.textContent).toContain("48 games");
    expect(cards[2]!.textContent).toContain("24% of your games reach it");
  });

  test("the picture states its finding in words, not just in a shape", () => {
    const text = shown();
    expect(text).toMatch(/decided in the|stay close throughout/);
    expect(text).toContain("the middle half of your games");
  });

  test("a per-phase rate nobody publishes is named as absent, never derived", () => {
    // The evidence is phase-tagged in the database and no route returns it.
    // Splitting the published estimates here would invent a measurement.
    const text = shown();
    expect(text).toContain("is not published to this screen yet");
  });

  test("no trajectory is a sentence rather than a missing section", () => {
    const text = shown({
      dashboard: dashboard({
        trajectory: {
          state: "unavailable",
          snapshotId: null,
          includedGameCount: 0,
          bins: [],
          unreachedPhases: ["opening", "middlegame", "endgame"],
        },
      }),
    });
    expect(text).toContain("No trajectory has been built yet");
  });
});

describe("the conclusions", () => {
  test("a conclusion is printed in Forma's own words, and its id never shown", () => {
    const text = shown();
    expect(text).not.toContain("finding-9f3");
    expect(text).toContain("You lose material to a capture you could have seen.");
  });

  test("a conclusion with no readable form is counted, never described", () => {
    const text = shown();
    expect(text).toContain("1 further conclusion");
  });
});

describe("the rating", () => {
  test("pools are named and never combined into one figure", () => {
    const text = shown();
    expect(text).toContain("1,642");
    expect(text).toContain("blitz");
    expect(text).toContain("are not comparable");
  });
});

describe("coverage and provenance", () => {
  test("the server's own warnings are printed rather than reworded", () => {
    expect(shown()).toContain("1 of 4 areas have too little evidence to estimate yet.");
  });

  test("the page says how many games and when, before it says anything else", () => {
    const text = shown();
    expect(text).toContain("Measured from 200 games");
    expect(text).toContain("pub-2f9");
  });

  test("the report is offered as a link, never opened on the reader's behalf", () => {
    // Fetching a baseline report is a write: it records that it was read and
    // moves the run on. A hub must not consume that.
    const { container } = draw();
    const link = [...container.querySelectorAll("a")].find(
      (anchor) => anchor.getAttribute("href") === "/report",
    );
    expect(link?.textContent).toContain("printable report");
  });

  test("a withheld section is named, never silently absent", () => {
    const text = shown({
      redactions: [{ path: "data.findings", reason: "entitlement" }],
    });
    expect(text).toContain("part of a paid plan");
  });
});

describe("before anything has been published", () => {
  test("a brand new account is taught, not shown an empty frame", () => {
    const text = shown({
      dashboard: null,
      state: state({ runId: null, stage: "not_started", status: "not_started", baselineReportId: null }),
      coverage: null,
    });
    expect(text).toContain("Nothing has been measured yet");
    expect(text).not.toContain("What Forma measured");
  });

  test("an examination still running is a wait, not a zero", () => {
    const text = shown({
      dashboard: null,
      state: state({ stage: "analysing", status: "active", baselineReportId: null }),
      coverage: null,
    });
    expect(text).toContain("still reading your games");
    expect(text).not.toContain("0 of 0");
  });

  test("a failed examination says so instead of showing nothing", () => {
    const text = shown({
      dashboard: null,
      state: state({ status: "failed", stage: "analysing", baselineReportId: null }),
      coverage: null,
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

  test("a result carries a letter, so colour is never the only thing saying it", () => {
    const { container } = draw({ games: [game()] });
    const chip = container.querySelector(".result-chip");
    expect(chip?.textContent).toContain("L");
    expect(chip?.textContent).toContain("Loss");
  });

  test("no games synced yet is no section at all", () => {
    expect(shown({ games: [] })).not.toContain("Your newest games");
  });
});

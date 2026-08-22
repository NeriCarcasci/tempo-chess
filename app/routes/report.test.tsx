/**
 * The report, tested as a document rather than as a page.
 *
 * It holds the same content as `/profile` — the same components over the same
 * publication — so the tests that matter here are about the things a document
 * has and a page does not. It argues from evidence to conclusion rather than
 * the other way round. It is numbered, so a reader can refer to a part of it.
 * It names the analysis that produced it, so somebody who is sent it can check
 * where it came from. And it does not lose the whole publication because the
 * one read that only adds a footer failed.
 */

import { render } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { MemoryRouter } from "react-router";
import type {
  BaselineReport,
  Dashboard,
  Me,
  OnboardingCoverage,
  TrajectoryBin,
} from "../lib/v1/types";

let data: unknown = null;
vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return { ...actual, useLoaderData: () => data };
});
vi.mock("../components/TopNav", () => ({ TopNav: () => null }));

const Report = (await import("./report")).default;

const me = (): Me =>
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
  }) as Me;

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
      ratingProfile: "unavailable",
      goal: "unavailable",
      connections: "unavailable",
    },
    estimates: [
      {
        dimensionKey: "free_material_recognize_objective",
        displayName: "free_material (recognize)",
        frame: "objective",
        windowKind: "lifetime",
        estimate: 0.84,
        intervalLow: 0.82,
        intervalHigh: 0.86,
        rawSampleSize: 1698,
        effectiveSampleSize: 940,
        coverage: { success: 1426, failure: 272, graded: 1698, censored: 0 },
        coverageStatus: "sufficient",
        unavailableReason: null,
        delta: null,
        improvementProbability: null,
      },
    ],
    findings: [],
    trajectory: {
      state: "published",
      snapshotId: "snap-1",
      includedGameCount: 200,
      bins: [
        bin({ phase: "opening", binOrdinal: 0, p25ExpectedScore: 0.51, p75ExpectedScore: 0.52 }),
        bin({ phase: "middlegame", binOrdinal: 0, p25ExpectedScore: 0.05, p75ExpectedScore: 0.9, phaseReachRate: 0.8, gamesContributing: 160 }),
      ],
      unreachedPhases: ["endgame"],
    },
    ratingProfile: { state: "unavailable", pools: [], note: "" },
    coverageWarnings: ["1 areas are based on limited evidence and carry wide ranges."],
    version: { recipeVersionId: "recipe-7", snapshotId: "snap-1", estimatorVersions: ["est-3"] },
    ...over,
  }) as Dashboard;

const report = (over: Partial<BaselineReport> = {}): BaselineReport =>
  ({
    reportId: "report-1",
    publishedAt: "2026-08-01T00:00:00Z",
    manifestSha256: "abc123def456",
    plan: "free",
    items: [],
    withheld: [{ section: "constraints", count: 14, entitlementKey: "pro_detail" }],
    ...over,
  }) as BaselineReport;

const coverage = (): OnboardingCoverage =>
  ({
    state: "published",
    overallState: "limited",
    totalGames: 214,
    eligibleGames: 200,
    limitations: ["few_endgames"],
    dimensions: [],
  }) as OnboardingCoverage;

function draw(over: Record<string, unknown> = {}) {
  data = { me: me(), dashboard: dashboard(), report: report(), coverage: coverage(), ...over };
  return render(
    <MemoryRouter>
      <Report />
    </MemoryRouter>,
  );
}

const shown = (over: Record<string, unknown> = {}): string =>
  draw(over).container.textContent ?? "";

describe("the document", () => {
  test("it argues from evidence to conclusion, the opposite way round to the page", () => {
    // A printed sheet cannot be scrolled back up, so what Forma could read has
    // to come before what it concluded. `/profile` leads on the trajectory
    // because a page somebody visits should answer the question first.
    const { container } = draw();
    const parts = [...container.querySelectorAll(".report-part > h2")].map(
      (heading) => heading.textContent ?? "",
    );
    expect(parts[0]).toContain("What Forma could read");
    expect(parts[1]).toContain("Where your games are decided");
    expect(parts[2]).toContain("What Forma measured");
  });

  test("every part is numbered, so it can be referred to", () => {
    const { container } = draw();
    const numbers = [...container.querySelectorAll(".report-part-n")].map(
      (span) => span.textContent,
    );
    expect(numbers).toEqual(numbers.map((_, index) => String(index + 1)));
  });

  test("the masthead dates it and says how much is behind it", () => {
    const text = shown();
    expect(text).toContain("Baseline report");
    expect(text).toContain("someone");
    expect(text).toContain("1 August 2026");
    expect(text).toContain("200");
  });

  test("the colophon names what produced it", () => {
    // Somebody could send this to a coach. It has to say where it came from.
    const text = shown();
    expect(text).toContain("pub-2f9");
    expect(text).toContain("recipe-7");
    expect(text).toContain("abc123def456");
    expect(text).toContain("will not change under you");
  });

  test("the print control is a control, and is the only one on the page", () => {
    const { container } = draw();
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.textContent).toContain("Print");
  });

  test("it says the same things the profile says, from the same components", () => {
    const { container } = draw();
    expect(container.querySelector(".cone")).toBeTruthy();
    expect(container.querySelectorAll(".phase-card")).toHaveLength(2);
    expect(container.querySelectorAll(".rate-row")).toHaveLength(1);
    // The same honesty rule: a rate carries its interval and its sample size.
    expect(container.querySelector(".rate-figure")!.textContent).toContain("82% to 86%");
    expect(container.querySelector(".rate-figure")!.textContent).toContain("1,698");
  });

  test("a withheld group is a numbered part of its own, never a silent gap", () => {
    expect(shown()).toContain("14 items on a paid plan");
  });

  test("no withheld group means no part for it", () => {
    expect(shown({ report: report({ withheld: [] }) })).not.toContain("Not shown on your plan");
  });
});

describe("what it does when a read fails", () => {
  test("losing the baseline report costs the footer, not the publication", () => {
    // The report ships identifiers; `/v1/dashboard` is what dereferences them.
    // Refusing to render because the footer read failed would withhold the
    // whole document over its provenance line.
    const text = shown({ report: null });
    expect(text).toContain("What Forma measured");
    expect(text).toContain("pub-2f9");
    expect(text).not.toContain("abc123def456");
  });

  test("a report with no measurements behind it says so rather than filling in", () => {
    const text = shown({ dashboard: null });
    expect(text).toContain("holds nothing that can be read yet");
    expect(text).not.toContain("What Forma measured");
  });
});

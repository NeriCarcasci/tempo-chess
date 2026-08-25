import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { CoveragePanel } from "./CoveragePanel";
import { JourneyFailure } from "./JourneyFailure";
import { WithheldNote } from "./WithheldNote";
import { FAILURE_REASONS } from "../../lib/onboarding/copy";
import type { OnboardingCoverage } from "../../lib/v1/types";

/**
 * The onboarding components, tested at the points where they would otherwise
 * quietly stop telling the truth: a null count rendered as zero, a withheld
 * item rendered as absent, and a workflow's internals rendered at a
 * reader.
 */

const coverage = (over: Partial<OnboardingCoverage> = {}): OnboardingCoverage =>
  ({
    state: "published",
    overallState: "limited",
    totalGames: 138,
    eligibleGames: 120,
    limitations: [],
    dimensions: [],
    ...over,
  }) as OnboardingCoverage;

describe("CoveragePanel", () => {
  test("unavailable coverage renders words, not zeros", () => {
    const { container } = render(
      <CoveragePanel
        coverage={coverage({
          state: "unavailable",
          overallState: null,
          totalGames: null,
          eligibleGames: null,
        })}
      />,
    );
    // Null is not zero: nothing has been counted yet.
    expect(container.textContent).not.toContain("0");
    expect(container.textContent).toContain("not been worked out yet");
  });

  test("published coverage states both counts", () => {
    const { container } = render(<CoveragePanel coverage={coverage()} />);
    expect(container.textContent).toContain("120");
    expect(container.textContent).toContain("138");
  });

  test("a limitation is a sentence, never a slug", () => {
    const { container } = render(
      <CoveragePanel coverage={coverage({ limitations: ["outside_calibrated_rating"] })} />,
    );
    expect(container.textContent).not.toContain("outside_calibrated_rating");
    expect(container.textContent).toContain("calibrated");
  });

  test("a thin dimension states its reason verbatim", () => {
    render(
      <CoveragePanel
        coverage={coverage({
          dimensions: [
            {
              dimensionKey: "king_safety",
              observationCount: 2,
              state: "limited",
              limitationReason: "only 2 chances observed",
            },
          ],
        })}
      />,
    );
    expect(screen.getByText("only 2 chances observed")).toBeTruthy();
    // This endpoint carries no catalogue copy, so the fallback stays generic
    // rather than turning an internal key into a reader-facing claim.
    expect(screen.getByText("A measured area")).toBeTruthy();
  });

  test("a sufficient dimension states no reason", () => {
    const { container } = render(
      <CoveragePanel
        coverage={coverage({
          dimensions: [
            {
              dimensionKey: "tactics",
              observationCount: 90,
              state: "sufficient",
              limitationReason: null,
            },
          ],
        })}
      />,
    );
    // Scoped to the dimension row: the panel's own overall badge renders a
    // blurb of its own, which is not what this test is about.
    const row = container.querySelector(".coverage-dimension");
    expect(row?.querySelectorAll(".tag-note").length).toBe(0);
  });
});

describe("JourneyFailure", () => {
  test("each failure reason gets its own sentence", () => {
    const titles = FAILURE_REASONS.map((reason) => {
      const { container, unmount } = render(<JourneyFailure reason={reason} />);
      const title = container.querySelector("strong")?.textContent ?? "";
      unmount();
      return title;
    });
    expect(new Set(titles).size).toBe(FAILURE_REASONS.length);
    for (const title of titles) {
      expect(title.toLowerCase()).not.toBe("something went wrong");
    }
  });

  test("a dead workflow is its own branch, and names no step it cannot know", () => {
    const { container } = render(<JourneyFailure reason={null} workflowFailed />);
    // Its own branch, distinct from the generic one.
    expect(container.querySelector("strong")?.textContent).toBe("Reading your games stopped");
    // Still says the reassuring, certainly-true part.
    expect(container.textContent).toContain("untouched");
    // But not which step stopped. This copy is printed for a failure anywhere
    // in the examination, and it used to blame the import every time — on a run
    // where the import had finished, the games were read, and the engine was
    // working through them, it told the reader there was nothing to analyse.
    expect(container.textContent).not.toContain("import");
    expect(container.textContent).not.toContain("nothing to analyse");
  });

  test("whatever way forward the caller offers is always shown", () => {
    // `retryable` says whether *this journey* can be retried, which is a
    // different question from whether there is a way forward. Gating the action
    // on it left `no_linked_account` — the only failure anything actually
    // writes — with no button at all: a dead end on the one path a user reaches.
    const retry = <button type="button">Start again</button>;
    for (const reason of FAILURE_REASONS) {
      const { container, unmount } = render(<JourneyFailure reason={reason} retry={retry} />);
      expect(container.querySelector("button"), reason).toBeTruthy();
      unmount();
    }
  });

  test("a failure with nothing to offer renders no empty control", () => {
    const { container } = render(<JourneyFailure reason="no_eligible_games" />);
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent?.length ?? 0).toBeGreaterThan(40);
  });
});

describe("WithheldNote", () => {
  test("a withheld item is named and counted, never absent", () => {
    const { container } = render(
      <WithheldNote entry={{ section: "constraints", count: 2, entitlementKey: "pro_detail" }} />,
    );
    const text = container.textContent ?? "";
    expect(text.trim().length).toBeGreaterThan(0);
    expect(text).toContain("2");
    expect(text.toLowerCase()).toContain("detail");
    // Named in the reader's words, not as a key.
    expect(text).not.toContain("pro_detail");
  });

  test("one withheld item reads as one, not as items", () => {
    const { container } = render(
      <WithheldNote entry={{ section: "constraints", count: 1, entitlementKey: "pro_detail" }} />,
    );
    expect(container.textContent).toContain("1 item");
    expect(container.textContent).not.toContain("1 items");
  });
});


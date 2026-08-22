import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { CoveragePanel } from "./CoveragePanel";
import { JourneyFailure } from "./JourneyFailure";
import { StageTrail } from "./StageTrail";
import { WithheldNote } from "./WithheldNote";
import { FAILURE_REASONS } from "../../lib/onboarding/copy";
import type { OnboardingCoverage } from "../../lib/v1/types";

/**
 * The onboarding components, tested at the points where they would otherwise
 * quietly stop telling the truth: a null count rendered as zero, a withheld
 * item rendered as absent, a workflow's internals rendered at a reader, and a
 * progress trail claiming a stage is finished when the server can still move
 * it backwards.
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

  test("a dead workflow is its own branch, not a generic error", () => {
    const { container } = render(<JourneyFailure reason={null} workflowFailed />);
    expect(container.textContent).toContain("did not finish");
    expect(container.textContent).toContain("untouched");
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

describe("StageTrail", () => {
  test("the trail has no memory", () => {
    // `stage` is derived from evidence and legitimately moves backwards, so a
    // stage must never be marked finished.
    const first = render(<StageTrail stage="diagnostic" />);
    const currentFirst = first.container.querySelectorAll(".tag-accent");
    expect(currentFirst.length).toBe(1);
    expect(currentFirst[0]?.textContent).toBe("Examining");
    first.unmount();

    const second = render(<StageTrail stage="analysing" />);
    const currentSecond = second.container.querySelectorAll(".tag-accent");
    expect(currentSecond.length).toBe(1);
    expect(currentSecond[0]?.textContent).toBe("Analysing");
    // Nothing anywhere claims the earlier stage is done.
    expect(second.container.textContent).not.toContain("✓");
    expect(second.container.querySelector(".tag-win")).toBeNull();
  });

  test("an unknown stage marks nothing rather than guessing", () => {
    const { container } = render(<StageTrail stage="not_started" />);
    expect(container.querySelectorAll(".tag-accent").length).toBe(0);
  });
});

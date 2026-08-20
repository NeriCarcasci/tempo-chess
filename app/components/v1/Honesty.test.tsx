import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import {
  ClaimBadge,
  CoverageBadge,
  Estimate,
  Figure,
  ProblemNote,
  WorkingStrip,
} from "./Honesty";
import { ProblemError } from "../../lib/v1/problem";
import { CLAIM_STATES, COVERAGE_STATES } from "../../lib/v1/types";

/**
 * The claims these components exist to keep.
 *
 * Each test is one way the product could quietly start lying: a null rendered
 * as zero, a withheld figure rendered as a dash, an activity state rendered as
 * success, a 500's internals rendered at a reader.
 */

describe("WorkingStrip", () => {
  test("a null percent is not 0%", () => {
    const { container } = render(<WorkingStrip label="Importing your games" percent={null} />);
    expect(screen.queryByText("0%")).toBeNull();
    expect(container.textContent).not.toContain("0%");
  });

  test("an unknown total leaves the progressbar without a value", () => {
    render(<WorkingStrip label="Importing your games" percent={null} />);
    const bar = screen.getByRole("progressbar");
    // Not "0" — absent. A screen reader must not be told a total that is unknown.
    expect(bar.getAttribute("aria-valuenow")).toBeNull();
  });

  test("a known percent is stated exactly once", () => {
    render(<WorkingStrip label="Analysing" percent={64} />);
    expect(screen.getByText("64%")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("64");
  });
});

describe("Estimate", () => {
  test("a null estimate is not zero", () => {
    const { container } = render(<Estimate value={null} />);
    expect(screen.getByText(/Not enough evidence yet/)).toBeTruthy();
    expect(container.textContent).not.toContain("0.00");
    expect(container.textContent).not.toContain("0");
  });

  test("an unmeasured metric says so specifically", () => {
    render(<Estimate value={null} unavailableReason="metric_not_estimated" />);
    expect(screen.getByText(/Not measured in this report/)).toBeTruthy();
  });

  test("an estimate carries its interval", () => {
    const { container } = render(<Estimate value={0.62} low={0.51} high={0.73} />);
    expect(container.textContent).toContain("0.62");
    expect(container.textContent).toContain("0.51");
    expect(container.textContent).toContain("0.73");
  });
});

describe("Figure", () => {
  test("a suppressed figure is not a dash and not a zero", () => {
    const { container } = render(<Figure figure={{ disclosure: "suppressed", below: 10 }} />);
    expect(container.textContent).toContain("fewer than 10");
    expect(container.textContent).not.toContain("—");
    // Not a bare zero. ("fewer than 10" contains a 0, which is why this asks
    // whether the whole output *is* a zero rather than whether one appears.)
    expect(container.textContent?.trim()).not.toBe("0");
    expect(container.textContent).not.toMatch(/(^|\s)0(\s|$)/);
  });

  test("an exact figure is the number", () => {
    const { container } = render(<Figure figure={{ disclosure: "exact", value: 1284 }} />);
    expect(container.textContent).toMatch(/1,?284/);
  });
});

describe("ClaimBadge", () => {
  test("only target_met reads as success", () => {
    const winners: string[] = [];
    for (const state of CLAIM_STATES) {
      const { container, unmount } = render(<ClaimBadge state={state} />);
      const tag = container.querySelector(".tag");
      if (tag?.classList.contains("tag-win")) winners.push(state);
      unmount();
    }
    expect(winners).toEqual(["target_met"]);
  });

  test("going backwards is shown, not hidden", () => {
    const { container } = render(<ClaimBadge state="declined" />);
    expect(container.textContent?.trim().length).toBeGreaterThan(0);
    expect(container.querySelector(".tag-loss")).toBeTruthy();
  });

  test("every claim state renders a distinct sentence", () => {
    const labels = CLAIM_STATES.map((state) => {
      const { container, unmount } = render(<ClaimBadge state={state} />);
      const text = container.textContent ?? "";
      unmount();
      return text;
    });
    // `no_evidence` and `unavailable` are different things and must read so.
    expect(new Set(labels).size).toBe(CLAIM_STATES.length);
  });
});

describe("CoverageBadge", () => {
  test("every coverage state says what it means", () => {
    for (const state of COVERAGE_STATES) {
      const { container, unmount } = render(<CoverageBadge state={state} showBlurb />);
      expect(container.textContent?.length ?? 0, state).toBeGreaterThan(20);
      unmount();
    }
  });

  test("insufficient never reads as a success colour", () => {
    const { container } = render(<CoverageBadge state="insufficient" />);
    expect(container.querySelector(".tag-win")).toBeNull();
  });
});

describe("ProblemNote", () => {
  test("a 500 never shows its internals", () => {
    const error = new ProblemError({
      type: "about:blank",
      title: "Internal error",
      status: 500,
      code: "INTERNAL_ERROR",
      detail: "pg: relation \"app.profiles\" does not exist",
      requestId: "req_abc123",
    });
    const { container } = render(<ProblemNote error={error} />);
    expect(container.textContent).not.toContain("relation");
    expect(container.textContent).not.toContain("pg:");
    // The reference is shown, because it is the one thing that helps.
    expect(container.textContent).toContain("req_abc123");
  });

  test("a rate limit says how long to wait", () => {
    const error = new ProblemError(
      { type: "about:blank", title: "Too many", status: 429, code: "RATE_LIMITED" },
      26,
    );
    const { container } = render(<ProblemNote error={error} />);
    expect(container.textContent).toContain("26");
  });

  test("an entitlement failure is an offer, not an error", () => {
    const error = new ProblemError({
      type: "about:blank",
      title: "Not on your plan",
      status: 402,
      code: "ENTITLEMENT_REQUIRED",
    });
    const { container } = render(<ProblemNote error={error} />);
    const text = (container.textContent ?? "").toLowerCase();
    expect(text).not.toContain("went wrong");
    expect(text).toContain("plan");
  });

  test("an error that is not a ProblemError still says something", () => {
    const { container } = render(<ProblemNote error={new Error("boom")} />);
    expect(container.textContent).not.toContain("boom");
    expect(container.textContent?.length ?? 0).toBeGreaterThan(10);
  });
});

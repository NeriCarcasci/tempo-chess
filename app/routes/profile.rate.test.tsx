import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Dashboard, SkillEstimate } from "../lib/v1/types";

vi.mock("../lib/session", () => ({ requireSession: vi.fn() }));

const { MeasureRate, estimatesByDimension } = await import("./profile");

function estimate(over: Partial<SkillEstimate> = {}): SkillEstimate {
  return {
    dimensionKey: "material_safety_respond_objective",
    displayName: "material_safety (respond)",
    frame: "objective",
    windowKind: "lifetime",
    estimate: 0.431,
    intervalLow: 0.411,
    intervalHigh: 0.45,
    rawSampleSize: 1940,
    effectiveSampleSize: 1940,
    coverage: { success: 800, failure: 1140, graded: 1940, censored: 0 },
    coverageStatus: "sufficient",
    unavailableReason: null,
    delta: null,
    improvementProbability: null,
    ...over,
  } as SkillEstimate;
}

describe("a rate is never shown without its range", () => {
  test("the interval is rendered beside the figure", () => {
    render(<MeasureRate estimate={estimate()} />);
    expect(screen.getByText("43%")).toBeTruthy();
    // 41–45, so the reader can see how firm 43% actually is.
    expect(screen.getByText(/41%.*45%/)).toBeTruthy();
  });

  test("an unmeasured dimension gives its reason, never a zero", () => {
    render(
      <MeasureRate
        estimate={estimate({ estimate: null, intervalLow: null, intervalHigh: null,
          unavailableReason: "Too few chances to state a rate." })}
      />,
    );
    expect(screen.getByText("Too few chances to state a rate.")).toBeTruthy();
    expect(screen.queryByText("0%")).toBeNull();
  });

  test("censored chances are named as set aside, not as failures", () => {
    render(<MeasureRate estimate={estimate({
      coverage: { success: 44, failure: 53, graded: 97, censored: 12 },
    })} />);
    expect(screen.getByText(/12 set aside/)).toBeTruthy();
    expect(screen.queryByText(/12 failed/)).toBeNull();
  });

  test("nothing renders when there is no estimate at all", () => {
    const { container } = render(<MeasureRate estimate={null} />);
    expect(container.textContent).toBe("");
  });
});

describe("matching an estimate to its coverage row", () => {
  const dashboard = { estimates: [
    estimate(),
    estimate({ dimensionKey: "material_safety_respond_personal_current", frame: "personal_current" }),
    estimate({ dimensionKey: "free_material_recognize_objective", windowKind: "recent_form" }),
  ] } as unknown as Dashboard;

  test("only the objective lifetime frame is used, and the suffix is stripped", () => {
    const found = estimatesByDimension(dashboard);
    // Coverage strips the frame suffix, so the key must match without it.
    expect(found.has("material_safety_respond")).toBe(true);
    // A different frame answers a different question and must not be picked up.
    expect(found.size).toBe(1);
  });

  test("no dashboard is an empty map rather than a throw", () => {
    expect(estimatesByDimension(null).size).toBe(0);
  });
});

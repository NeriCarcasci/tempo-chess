import { describe, expect, test } from "vitest";
import {
  currentSection,
  emptyTracker,
  etaLabel,
  fractionOf,
  observe,
  overallPercent,
  remainingAt,
  sectionOfWorkflow,
  weighSections,
  type SyncTracker,
  type WorkflowLike,
} from "./sync";

/**
 * The bar's two claims, tested where they would quietly become lies.
 *
 * The first is that a section's fill is a measurement: real completed weight
 * over real total weight, and never a stand-in for which phase is running. The
 * second is that neither the fill nor the countdown may go backwards — which is
 * the natural behaviour of both, because the examination keeps discovering work
 * and the denominators keep growing.
 */

const wf = (
  kind: string,
  completed: number,
  total: number,
  over: Partial<WorkflowLike["progress"]> & { state?: string } = {},
): WorkflowLike => ({
  kind,
  state: over.state ?? "running",
  progress: { completedWeight: completed, totalWeight: total, stage: over.stage ?? null },
});

/** One game's analysis: screening 80, deep 12, transitions 4, context 4. */
const game = (completed: number): WorkflowLike => wf("game_analysis", completed, 100);

const poll = (tracker: SyncTracker, at: number, workflows: WorkflowLike[]): SyncTracker =>
  observe(tracker, { at, weights: weighSections(workflows) });

describe("sectionOfWorkflow", () => {
  test("a workflow per game is analysis weight", () => {
    expect(sectionOfWorkflow(game(0))).toBe("analysing");
    expect(sectionOfWorkflow(wf("game_import", 0, 40))).toBe("importing");
  });

  test("the examination workflow moves from importing to writing with its own task", () => {
    // Its five items straddle two sections and only the aggregate weight is on
    // the wire, so the oldest outstanding task decides which side it is on.
    // Counting the whole thing as writing would show the report a fifth
    // written while the archive was still downloading.
    expect(sectionOfWorkflow(wf("initial_examination", 0, 5, { stage: "provider_account_sync" }))).toBe(
      "importing",
    );
    expect(
      sectionOfWorkflow(wf("initial_examination", 1, 5, { stage: "coaching_examination_report" })),
    ).toBe("reporting");
  });

  test("a workflow that is nothing to do with this journey is not counted", () => {
    expect(sectionOfWorkflow(wf("position_evaluation", 0, 1))).toBeNull();
    expect(sectionOfWorkflow(wf("some_new_kind", 0, 1))).toBeNull();
  });
});

describe("weighSections", () => {
  test("a section's fill is its own weight, not a phase", () => {
    const weights = weighSections([game(100), game(100), game(20), game(0)]);
    expect(weights.analysing).toEqual({ completed: 220, total: 400 });
    expect(fractionOf(weights.analysing)).toBeCloseTo(0.55);
  });

  test("cancelled work leaves both sides of the fraction", () => {
    // Left in the denominator it would hold the section short of full for ever.
    const weights = weighSections([game(100), wf("game_analysis", 0, 100, { state: "cancelled" })]);
    expect(fractionOf(weights.analysing)).toBe(1);
  });

  test("a section nobody has planned work for has no fraction, not a zero", () => {
    expect(fractionOf(weighSections([]).analysing)).toBeNull();
  });

  test("the overall figure is every section's weight together", () => {
    const weights = weighSections([
      wf("game_import", 40, 40),
      game(100),
      game(0),
      wf("initial_examination", 1, 5, { stage: "coaching_examination_report" }),
    ]);
    // 141 of 245.
    expect(overallPercent(weights)).toBe(58);
    expect(overallPercent(weighSections([]))).toBeNull();
  });
});

describe("currentSection", () => {
  test("engine work outstanding beats every other signal", () => {
    // The examination workflow reaches its report step early and then waits for
    // exactly this work, so believing its task type would put the bar on
    // "Writing" while a hundred games were still queued.
    const weights = weighSections([
      game(100),
      game(0),
      wf("initial_examination", 2, 5, { stage: "coaching_examination_report" }),
    ]);
    expect(currentSection(weights, "analysing")).toBe("analysing");
  });

  test("before any analysis is planned, the run's stage is all there is", () => {
    const weights = weighSections([
      wf("initial_examination", 0, 5, { stage: "provider_account_sync" }),
    ]);
    expect(currentSection(weights, "syncing")).toBe("importing");
    expect(currentSection(weights, "not_started")).toBe("importing");
    // Past the sync with nothing weighed yet: analysis is what happens next,
    // and naming it beats naming the section that is already over.
    expect(currentSection(weights, "analysing")).toBe("analysing");
  });

  test("every game analysed means the report is what is left", () => {
    const weights = weighSections([game(100), game(100)]);
    expect(currentSection(weights, "analysing")).toBe("reporting");
  });
});

describe("the section fill", () => {
  test("discovering more work never sends a fill backwards", () => {
    let tracker = poll(emptyTracker(), 0, [game(60)]);
    expect(tracker.fractions.analysing).toBeCloseTo(0.6);

    // Five more games are planned. The raw fraction is now 0.1, and a bar that
    // jumped from 60% back to 10% reads as a bug.
    tracker = poll(tracker, 6_000, [game(60), game(0), game(0), game(0), game(0), game(0)]);
    expect(tracker.fractions.analysing).toBeCloseTo(0.6);
  });

  test("a section with no work planned yet stays without a fraction", () => {
    const tracker = poll(emptyTracker(), 0, [
      wf("initial_examination", 0, 5, { stage: "provider_account_sync" }),
    ]);
    expect(tracker.fractions.analysing).toBeNull();
    expect(tracker.fractions.importing).toBe(0);
  });
});

describe("the estimate", () => {
  test("one reading is not a rate", () => {
    const tracker = poll(emptyTracker(), 0, [game(10)]);
    expect(remainingAt(tracker, 0)).toBeNull();
  });

  test("two readings too close together are not a rate either", () => {
    let tracker = poll(emptyTracker(), 0, [game(0)]);
    tracker = poll(tracker, 1_000, [game(40)]);
    // 40 units in a second extrapolates to a promise of 1.5 seconds, which is
    // the fabricated number this whole file exists to keep off the screen.
    expect(remainingAt(tracker, 1_000)).toBeNull();
  });

  test("a measured rate becomes a time", () => {
    let tracker = poll(emptyTracker(), 0, [game(0)]);
    tracker = poll(tracker, 60_000, [game(50)]);
    // Half the work in a minute, so about a minute left.
    expect(remainingAt(tracker, 60_000)).toBeCloseTo(60_000, -3);
    expect(etaLabel(remainingAt(tracker, 60_000))).toBe("About a minute left");
  });

  test("it counts down between readings rather than freezing", () => {
    let tracker = poll(emptyTracker(), 0, [game(0)]);
    tracker = poll(tracker, 60_000, [game(50)]);
    expect(remainingAt(tracker, 90_000)!).toBeLessThan(remainingAt(tracker, 60_000)!);
  });

  test("work discovered mid-run never turns the countdown upward", () => {
    let tracker = poll(emptyTracker(), 0, [game(0)]);
    tracker = poll(tracker, 60_000, [game(50)]);
    const before = remainingAt(tracker, 60_000)!;

    // Nine more games are planned. The true estimate is now far longer, and a
    // countdown that counts up reads as broken however true it is.
    const many = [game(60), ...Array.from({ length: 9 }, () => game(0))];
    tracker = poll(tracker, 120_000, many);
    expect(remainingAt(tracker, 120_000)!).toBeLessThanOrEqual(before);
  });
});

describe("etaLabel", () => {
  test("no evidence says so in words rather than showing a number", () => {
    expect(etaLabel(null)).not.toMatch(/\d/);
    expect(etaLabel(null)).toContain("how long");
  });

  test("the buckets are coarse and never claim it is finished", () => {
    expect(etaLabel(0)).toBe("Under a minute left");
    expect(etaLabel(30_000)).toBe("Under a minute left");
    expect(etaLabel(4 * 60_000)).toBe("About 4 minutes left");
    expect(etaLabel(3 * 3_600_000)).not.toMatch(/\d/);
  });
});

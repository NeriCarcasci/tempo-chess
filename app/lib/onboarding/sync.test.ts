import { describe, expect, test } from "vitest";
import {
  currentStep,
  emptyTracker,
  etaLabel,
  observe,
  readJourney,
  readSteps,
  remainingAt,
  type SyncTracker,
  type WorkflowLike,
} from "./sync";

/**
 * The bar's claims, tested where they would quietly become lies.
 *
 * The fill is a measurement — real completed work over real total work — and
 * never a stand-in for which phase is running. It does not walk backwards, and
 * the countdown does not count up on ordinary progress. Both of those are the
 * natural behaviour of the raw numbers, because the examination keeps
 * discovering work.
 *
 * The exception took longest to find and has its own case below: when the
 * discovered work is orders of magnitude larger than what came before, holding
 * the old estimate is not stability, it is a screen that says "under a minute
 * left" for an hour.
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
const game = (completed: number, state = "running"): WorkflowLike =>
  wf("game_analysis", completed, 100, { state });

/** The examination: one sync, then prepare, report, examine, advance. */
const exam = (completed: number, stage: string | null = null): WorkflowLike =>
  wf("initial_examination", completed, 5, { stage });

const poll = (tracker: SyncTracker, at: number, workflows: WorkflowLike[]): SyncTracker =>
  observe(tracker, { at, journey: readJourney(workflows, "analysing") });

describe("readJourney", () => {
  test("the archive still arriving has no number, only a phase", () => {
    // A sync is one work item per account and an item scores only when it
    // finishes, so any percentage here is the unit being bigger than anything
    // that has happened yet. The screen this replaced printed "0%" through the
    // whole download and read as stuck.
    const journey = readJourney([exam(0, "provider_account_sync")], "syncing");
    expect(journey.phase).toBe("importing");
    expect(journey.fraction).toBeNull();
  });

  test("the run calling itself analysing does not make it so", () => {
    // The run reports `analysing` the moment its sync item completes, which is
    // before prepare has planned a single game. Believing it lit a phase with
    // no work in it while the archive was still being rebuilt.
    const journey = readJourney([exam(1, "coaching_onboarding_prepare")], "analysing");
    expect(journey.phase).toBe("importing");
    expect(journey.fraction).toBeNull();
  });

  test("analysis is measured on its own weight, across every game", () => {
    const journey = readJourney(
      [exam(2), game(100, "succeeded"), game(100, "succeeded"), game(20), game(0)],
      "analysing",
    );
    expect(journey.phase).toBe("analysing");
    expect(journey.fraction).toBeCloseTo(0.55);
    expect(journey.games).toEqual({ done: 2, total: 4 });
    expect(journey.weight).toEqual({ done: 220, total: 400 });
  });

  test("prepare finishing is not the write-up starting", () => {
    // `coaching_onboarding_prepare` freezes the snapshot and plans the
    // analysis: the last act of ingestion. Counting it as writing put
    // "Writing 25%" on screen before a single game had been analysed.
    const journey = readJourney([exam(2, "coaching_examination_report"), game(0)], "analysing");
    expect(journey.phase).toBe("analysing");
    expect(journey.fraction).toBe(0);
  });

  test("every game read leaves the write-up, measured on its three steps", () => {
    const journey = readJourney(
      [exam(3, "coaching_baseline_examination"), game(100, "succeeded")],
      "analysing",
    );
    expect(journey.phase).toBe("writing");
    expect(journey.fraction).toBeCloseTo(1 / 3);
  });

  test("the whole examination finished reads as done", () => {
    const journey = readJourney([exam(5), game(100, "succeeded")], "analysing");
    expect(journey.phase).toBe("done");
    expect(journey.fraction).toBe(1);
  });

  test("a dead-lettered side workflow is not part of the journey", () => {
    // Linking an account enqueues a `subject_estimation` workflow no deployment
    // has a handler for, so it dies at once while the examination carries on.
    // Counted, it would hold the journey short of finished for ever.
    const journey = readJourney(
      [
        exam(5),
        game(100, "succeeded"),
        wf("subject_estimation", 0, 1, { state: "failed" }),
        wf("subject_estimation", 0, 1, { state: "failed" }),
      ],
      "analysing",
    );
    expect(journey.phase).toBe("done");
  });

  test("nothing read yet falls back to the run's own stage", () => {
    expect(readJourney([], "syncing").phase).toBe("importing");
    expect(readJourney([], "not_started").phase).toBe("importing");
    expect(readJourney([], "analysing").phase).toBe("analysing");
  });

  test("an archive with nothing worth reading goes straight to the write-up", () => {
    // Prepare succeeded and planned no analysis, so there is no game workflow
    // to wait for and the run is already writing.
    const journey = readJourney([exam(3, "coaching_baseline_examination")], "analysing");
    expect(journey.phase).toBe("writing");
    expect(journey.games.total).toBe(0);
  });
});

describe("the fill", () => {
  test("a batch of new work never sends the fill backwards", () => {
    // The analysis run is planned in batches rather than all at once, so the
    // denominator grows in steps the whole way through and the raw fraction
    // drops every time one lands.
    let tracker = poll(emptyTracker(), 0, [exam(2), game(60)]);
    expect(tracker.fraction).toBeCloseTo(0.6);

    tracker = poll(tracker, 6_000, [exam(2), game(60), game(0)]);
    expect(tracker.fraction).toBeCloseTo(0.6);

    // Even a tenfold replan leaves the bar where it was. It pauses rather than
    // sliding back; the games count beside it is what keeps moving.
    tracker = poll(tracker, 12_000, [exam(2), game(60), ...Array.from({ length: 9 }, () => game(0))]);
    expect(tracker.fraction).toBeCloseTo(0.6);
  });

  test("nothing planned to analyse leaves the fill absent, not zero", () => {
    const tracker = poll(emptyTracker(), 0, [exam(0, "provider_account_sync")]);
    expect(tracker.fraction).toBeNull();
  });

  test("the games count is a raw tally, so it moves when the bar cannot", () => {
    const journey = readJourney(
      [exam(2), game(100, "succeeded"), game(100, "succeeded"), game(5)],
      "analysing",
    );
    expect(journey.games).toEqual({ done: 2, total: 3 });
  });
});

describe("the estimate", () => {
  test("one reading is not a rate", () => {
    const tracker = poll(emptyTracker(), 0, [exam(2), game(10)]);
    expect(remainingAt(tracker, 0)).toBeNull();
  });

  test("two readings too close together are not a rate either", () => {
    let tracker = poll(emptyTracker(), 0, [exam(2), game(0)]);
    tracker = poll(tracker, 1_000, [exam(2), game(40)]);
    // 40 units in a second extrapolates to a promise of 1.5 seconds, which is
    // the fabricated number this whole file exists to keep off the screen.
    expect(remainingAt(tracker, 1_000)).toBeNull();
  });

  test("a measured rate becomes a time", () => {
    let tracker = poll(emptyTracker(), 0, [exam(2), game(0)]);
    tracker = poll(tracker, 60_000, [exam(2), game(50)]);
    // Half the work in a minute, so about a minute left.
    expect(remainingAt(tracker, 60_000)).toBeCloseTo(60_000, -3);
    expect(etaLabel(remainingAt(tracker, 60_000))).toBe("About a minute left");
  });

  test("it counts down between readings rather than freezing", () => {
    let tracker = poll(emptyTracker(), 0, [exam(2), game(0)]);
    tracker = poll(tracker, 60_000, [exam(2), game(50)]);
    expect(remainingAt(tracker, 90_000)!).toBeLessThan(remainingAt(tracker, 60_000)!);
  });

  test("a batch of new work corrects the countdown upward", () => {
    /*
     * The bug this pins is the one that said "under a minute left" for the
     * better part of an hour.
     *
     * The estimate used to only ever fall. Early on it measured a handful of
     * games, found them nearly done and promised a minute — and then the next
     * batch multiplied the real total. The old figure had been measured against
     * a fraction of the job, and the ratchet would not let go of it. Being
     * stuck and wrong is worse than moving and right.
     */
    let tracker = poll(emptyTracker(), 0, [exam(2), game(0)]);
    tracker = poll(tracker, 60_000, [exam(2), game(90)]);
    const promised = remainingAt(tracker, 60_000)!;
    expect(etaLabel(promised)).toBe("Under a minute left");

    // Ninety-nine more games are planned. The honest answer is now far longer.
    const many = [exam(2), game(90), ...Array.from({ length: 99 }, () => game(0))];
    let grown = poll(tracker, 120_000, many);
    grown = poll(grown, 180_000, [exam(2), game(90), ...Array.from({ length: 99 }, () => game(10))]);
    expect(remainingAt(grown, 180_000)!).toBeGreaterThan(promised);
  });
});

describe("etaLabel", () => {
  test("no evidence says so in words rather than showing a number", () => {
    expect(etaLabel(null)).not.toMatch(/\d/);
  });

  test("it never counts in seconds", () => {
    expect(etaLabel(20_000)).toBe("Under a minute left");
    expect(etaLabel(65_000)).toBe("About a minute left");
    expect(etaLabel(9 * 60_000)).toBe("About 9 minutes left");
    expect(etaLabel(3 * 3_600_000)).toBe("Over an hour left");
  });
});

describe("readSteps", () => {
  /** A batch of materialization: one item per game the sweep has found. */
  const rebuild = (completed: number, total: number, state = "running"): WorkflowLike =>
    wf("game_import", completed, total, { state });

  const at = (steps: ReturnType<typeof readSteps>, key: string) =>
    steps.find((step) => step.key === key)!;

  test("nothing has happened yet, so reading is the one thing running", () => {
    const steps = readSteps([], "syncing");
    expect(at(steps, "import").state).toBe("running");
    expect(at(steps, "rebuild").state).toBe("waiting");
    expect(at(steps, "analyse").state).toBe("waiting");
    expect(at(steps, "write").state).toBe("waiting");
  });

  test("the import counts up and never draws a bar", () => {
    // A provider does not say how large an archive is before it sends it, so a
    // fraction here would be a guess wearing a measurement.
    const steps = readSteps([exam(0, "provider_account_sync"), rebuild(0, 120)], "syncing");
    const step = at(steps, "import");
    expect(step.state).toBe("running");
    expect(step.fraction).toBeNull();
    expect(step.detail).toBe("120 games");
  });

  test("rebuilding shows its tally while the archive is still arriving, and no fill", () => {
    // The denominator grows every time the sweep finds more games. A fill would
    // slide backwards on a run going perfectly well; a tally cannot.
    const steps = readSteps([exam(0, "provider_account_sync"), rebuild(40, 120)], "syncing");
    const step = at(steps, "rebuild");
    expect(step.fraction).toBeNull();
    expect(step.detail).toBe("40 of 120 games");
  });

  test("once reading is done the rebuild denominator is settled, so it fills", () => {
    const steps = readSteps([exam(1, "chess_materialize_replay"), rebuild(60, 120)], "analysing");
    expect(at(steps, "import").state).toBe("done");
    const step = at(steps, "rebuild");
    expect(step.state).toBe("running");
    expect(step.fraction).toBeCloseTo(0.5);
  });

  test("prepare finishing is what proves every game was rebuilt", () => {
    // It refuses to freeze a snapshot while anything is outstanding, so its own
    // completion is stronger evidence than counting the rebuild workflows.
    const steps = readSteps([exam(2, "coaching_examination_report"), rebuild(120, 120)], "analysing");
    expect(at(steps, "rebuild").state).toBe("done");
    expect(at(steps, "analyse").state).toBe("running");
  });

  test("studying counts games and fills from their weight", () => {
    const steps = readSteps(
      [exam(2), rebuild(120, 120), game(100, "succeeded"), game(50), game(0)],
      "analysing",
    );
    const step = at(steps, "analyse");
    expect(step.detail).toBe("1 of 3 games");
    expect(step.fraction).toBeCloseTo(0.5);
  });

  test("an archive with nothing analysable still finishes its studying step", () => {
    // No game workflow was ever planned, so the only evidence that the step is
    // over is the examination having moved past the item that waits for them.
    const steps = readSteps([exam(3, "coaching_baseline_examination")], "analysing");
    expect(at(steps, "analyse").state).toBe("done");
    expect(at(steps, "write").state).toBe("running");
  });

  test("everything done leaves nothing running", () => {
    const steps = readSteps([exam(5), rebuild(120, 120), game(100, "succeeded")], "analysing");
    expect(steps.every((step) => step.state === "done")).toBe(true);
    expect(currentStep(steps)).toBeNull();
  });

  test("a dead sibling workflow does not hold the journey open", () => {
    // Linking enqueues a `subject_estimation` workflow no deployment handles,
    // so it dead-letters at once beside an examination that is going fine.
    const steps = readSteps(
      [exam(5), rebuild(1, 1), game(100, "succeeded"), wf("subject_estimation", 0, 1, { state: "failed" })],
      "analysing",
    );
    expect(steps.every((step) => step.state === "done")).toBe(true);
  });

  test("exactly one step runs at a time", () => {
    const steps = readSteps([exam(1), rebuild(3, 10)], "analysing");
    expect(steps.filter((step) => step.state === "running")).toHaveLength(1);
  });
});

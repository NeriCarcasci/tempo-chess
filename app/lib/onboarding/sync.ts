/**
 * What the sync screen knows, as pure functions.
 *
 * ## Why this is one bar and not three
 *
 * It was three: importing, analysing, writing, each filling from its own
 * weight. Every version of that was incoherent on screen, and the reason is
 * structural rather than a bug that could be patched out. The three phases do
 * not have denominators at the same time. The examination is five work items
 * until `prepare` runs, and then it is five items plus one analysis workflow
 * *per game* — so the total work jumps from 5 units to tens of thousands in a
 * single poll. Before that jump the early phases show confident percentages of
 * a denominator about to be revealed as a rounding error; after it they freeze,
 * because a bar that walks backwards has to be ratcheted.
 *
 * That produced, in order: an import stuck at 0%, a "Writing" bar a quarter
 * full before a game had been read, a highlight on a phase with no work in it,
 * and a countdown that said "under a minute" for the better part of an hour.
 *
 * So the screen now measures the one thing that is stable, dominant and
 * countable: **the games**. Analysis is one workflow per game and the
 * overwhelming majority of the wall clock. Its denominator is known as soon as
 * the run is planned and grows only in whole games. The other two phases are
 * named in the caption rather than given bars of their own, because neither is
 * measurable while it happens — the import is one work item per account, and
 * the write-up is three.
 *
 * The rule that survives from the old model is the one that mattered: a fill is
 * real completed work over real total work, and where there is no denominator
 * there is no number, only a stripe that says "working".
 */

/** The part of a workflow this screen reads. Widened so tests need no fixtures. */
export interface WorkflowLike {
  kind: string;
  state: string;
  progress: { completedWeight: number; totalWeight: number; stage: string | null };
}

/**
 * The steps that are actually *writing*: report, examine, advance.
 *
 * `server/src/onboarding/planner.ts` plans one sync item per syncable account
 * and then four more — prepare, report, examine, advance. Three of those four
 * are the write-up. `coaching_onboarding_prepare` is not: it freezes the
 * snapshot and plans the analysis run, which is the last act of ingestion and
 * the step every game workflow waits on. Counting it as writing is what put
 * "Writing 25%" on screen before a single game had been analysed.
 */
export const WRITE_UP_WEIGHT = 3;

/**
 * Work that will never finish and is not running either.
 *
 * Cancelled is the obvious case. `failed` belongs with it: linking an account
 * enqueues a `subject_estimation` workflow whose task no deployment registers a
 * handler for, so it dead-letters at once, once per account, while the
 * examination beside it carries on perfectly well. Counted, those hold the
 * journey short of finished for ever on a run that is going to succeed.
 */
const ABANDONED = new Set(["cancelled", "failed"]);

export type Phase = "importing" | "analysing" | "writing" | "done";

export const PHASE_LABEL: Record<Phase, string> = {
  importing: "Importing",
  analysing: "Analysing",
  writing: "Writing",
  done: "Done",
};

export interface Journey {
  phase: Phase;
  /**
   * How far through, 0 to 1, or null while there is nothing to measure.
   *
   * Null is the honest answer during the import: a sync is one work item per
   * account and an item scores only when it finishes, so any number there is
   * the unit being bigger than anything that has happened yet.
   */
  fraction: number | null;
  /** Games whose analysis has finished, against games planned. */
  games: { done: number; total: number };
  /** Analysis work units, which is what the fraction is measured on. */
  weight: { done: number; total: number };
}

const bare = (phase: Phase, fraction: number | null = null): Journey => ({
  phase,
  fraction,
  games: { done: 0, total: 0 },
  weight: { done: 0, total: 0 },
});

/**
 * Where the examination has got to, from the workflows it has produced.
 *
 * The phase is read from what exists rather than from what the run calls
 * itself. The run starts reporting `analysing` the moment its sync item
 * completes, which is before a single analysis workflow has been planned, so
 * believing it lit a phase with no work in it while the archive was still
 * arriving. Its stage is consulted only in the opening seconds, when no
 * workflow has been read at all and there is genuinely nothing else to go on.
 */
export function readJourney(workflows: readonly WorkflowLike[], runStage: string): Journey {
  const live = workflows.filter((workflow) => !ABANDONED.has(workflow.state));
  const games = live.filter((workflow) => workflow.kind === "game_analysis");
  const examination = live.find((workflow) => workflow.kind === "initial_examination") ?? null;

  // The write-up is whatever the examination has completed beyond its ingestion
  // share: `totalWeight - 3` is the syncs plus prepare, and the three after it
  // are report, examine and advance.
  const ingestion = examination
    ? Math.max(0, examination.progress.totalWeight - WRITE_UP_WEIGHT)
    : 0;
  const writeTotal = examination
    ? Math.min(examination.progress.totalWeight, WRITE_UP_WEIGHT)
    : 0;
  const writeDone = examination
    ? Math.max(0, examination.progress.completedWeight - ingestion)
    : 0;

  if (games.length === 0) {
    // Nothing has been planned to analyse yet. Either the archive is still
    // coming in, or it arrived with nothing worth reading in it and the run
    // went straight to its write-up.
    if (examination === null) {
      return bare(
        runStage === "linking" || runStage === "syncing" || runStage === "not_started"
          ? "importing"
          : "analysing",
      );
    }
    if (writeTotal > 0 && examination.progress.completedWeight > ingestion) {
      return bare(writeDone >= writeTotal ? "done" : "writing", writeDone / writeTotal);
    }
    return bare("importing");
  }

  let weightDone = 0;
  let weightTotal = 0;
  let gamesDone = 0;
  for (const workflow of games) {
    weightDone += workflow.progress.completedWeight;
    weightTotal += workflow.progress.totalWeight;
    if (workflow.state === "succeeded") gamesDone += 1;
  }
  const counted = { done: gamesDone, total: games.length };
  const weight = { done: weightDone, total: weightTotal };

  if (weightTotal > 0 && weightDone < weightTotal) {
    return { phase: "analysing", fraction: weightDone / weightTotal, games: counted, weight };
  }

  // Every game is read. What is left is the write-up: three items, so not
  // something to draw a smooth bar from, but short, and saying so beats a full
  // bar sitting there while the report is written.
  return {
    phase: writeTotal > 0 && writeDone >= writeTotal ? "done" : "writing",
    fraction: writeTotal === 0 ? 1 : writeDone / writeTotal,
    games: counted,
    weight,
  };
}

/** Boards are worth showing as soon as there are games to show. */
export function boardsBelongHere(): boolean {
  return true;
}

// ---------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------

/**
 * The examination as four named steps, each answering for itself.
 *
 * The bar above measures one thing well and says nothing about the other
 * three-quarters of the wall clock. Watching a real first run made the cost
 * obvious: for minutes the screen said IMPORTING while the caption underneath
 * said "Gathering what to read" — which is `coaching_onboarding_prepare`, a
 * step that runs *after* the import and waits on something else entirely. The
 * phase was wrong, there was no count, no estimate, and nothing that had been
 * finished was ever marked finished. A person cannot tell a system that is
 * working from one that is stuck if it never says what it has done.
 *
 * ## Why four, and why these
 *
 * They are the four things that actually happen, and each leaves its own
 * evidence in the workflow list:
 *
 *   * **Reading** — the sync items on the examination workflow.
 *   * **Rebuilding** — one `game_import` workflow per batch, one item per game.
 *   * **Studying** — one `game_analysis` workflow per game.
 *   * **Writing** — the last three items on the examination workflow.
 *
 * ## Why every step here counts and none of them fills
 *
 * Because a snapshot cannot tell you whether a denominator has settled, and
 * three of the four never have. The import has none at all — a provider does not
 * say how large an archive is before it sends it. Rebuilding and studying both
 * have one that *grows*: the sweep plans fifty games a minute, so each new batch
 * enlarges the total and the raw fraction drops. Measured against a real run,
 * rebuilding read 89% and then 74% a minute later, on a run going perfectly
 * well. A fill that walks backwards reads as a bug however correct the
 * arithmetic is; a tally that only rises cannot.
 *
 * So this function returns counts and no fractions at all, and the one bar the
 * product draws is attached in `useJourney`, from the ratchet that has always
 * guarded exactly this. See `observe`.
 */
export type StepKey = "import" | "rebuild" | "analyse" | "write";
export type StepState = "waiting" | "running" | "done";

export interface Step {
  key: StepKey;
  /** What this step is, in the product's voice. */
  label: string;
  state: StepState;
  /**
   * A fill, or null.
   *
   * Always null from `readSteps` itself: a fraction here would be measured
   * against a denominator that grows. `useJourney` attaches the ratcheted one
   * to the studying step, which is the only place a bar is honest.
   */
  fraction: number | null;
  /** The concrete tally, or null when there is nothing true to count yet. */
  detail: string | null;
}

const STEP_LABEL: Record<StepKey, string> = {
  import: "Reading your games",
  rebuild: "Rebuilding the positions",
  analyse: "Studying every move",
  write: "Writing your report",
};

/** Games, counted the way a person counts them. */
const games = (n: number): string => `${n.toLocaleString()} ${n === 1 ? "game" : "games"}`;
const outOf = (done: number, total: number): string =>
  `${done.toLocaleString()} of ${total.toLocaleString()} ${total === 1 ? "game" : "games"}`;

export function readSteps(workflows: readonly WorkflowLike[], runStage: string): Step[] {
  const live = workflows.filter((workflow) => !ABANDONED.has(workflow.state));
  const examination = live.find((workflow) => workflow.kind === "initial_examination") ?? null;
  const analyses = live.filter((workflow) => workflow.kind === "game_analysis");
  const rebuilds = live.filter((workflow) => workflow.kind === "game_import");

  /*
   * How many of the examination's items are syncs.
   *
   * The planner writes one sync per readable account and then exactly four more
   * — prepare, report, examine, advance — so the count falls out of the total
   * rather than needing to be sent. `max(1, …)` because a workflow read before
   * its items are all committed can report a total smaller than the tail.
   */
  const settled = examination ? Math.max(1, examination.progress.totalWeight - 4) : 1;
  const passed = examination ? examination.progress.completedWeight : 0;
  const total = examination ? examination.progress.totalWeight : 0;

  const importDone = examination !== null && passed >= settled;
  // Prepare finishing *is* the definition of "every game rebuilt and the
  // snapshot frozen": it refuses to freeze while anything is outstanding. That
  // is a stronger signal than counting the rebuild workflows, which only says
  // that everything discovered so far is done.
  const rebuildDone = examination !== null && passed >= settled + 1;
  const rebuiltWeight = rebuilds.reduce(
    (sum, workflow) => sum + workflow.progress.completedWeight,
    0,
  );
  const rebuildTotal = rebuilds.reduce((sum, workflow) => sum + workflow.progress.totalWeight, 0);

  const analysed = analyses.filter((workflow) => workflow.state === "succeeded").length;
  let weightDone = 0;
  let weightTotal = 0;
  for (const workflow of analyses) {
    weightDone += workflow.progress.completedWeight;
    weightTotal += workflow.progress.totalWeight;
  }
  // Either every planned game is read, or the examination has moved past the
  // step that waits for them — which is the same fact from the other side, and
  // the only evidence available for an archive with nothing analysable in it.
  const analyseDone =
    (analyses.length > 0 && analysed === analyses.length) ||
    (examination !== null && passed >= settled + 2);
  const writeDone = examination !== null && total > 0 && passed >= total;

  const finished: Record<StepKey, boolean> = {
    import: importDone,
    rebuild: rebuildDone,
    analyse: analyseDone,
    write: writeDone,
  };
  const order: StepKey[] = ["import", "rebuild", "analyse", "write"];
  // Exactly one step is running: the first that has not finished. Marking every
  // unfinished step as running would say four things are happening at once, and
  // marking none would leave a screen with no subject.
  const current = order.find((key) => !finished[key]) ?? null;

  const state = (key: StepKey): StepState =>
    finished[key] ? "done" : key === current ? "running" : "waiting";

  return [
    {
      key: "import",
      label: STEP_LABEL.import,
      state: state("import"),
      // A provider does not say how large an archive is before it sends it, so
      // any bar here is a guess wearing a measurement.
      fraction: null,
      // The rebuild queue is the only live count of games that have landed:
      // the sweep plans one item per game as it finds them. It lags the sync by
      // up to a sweep, which is the right kind of wrong — it never overstates.
      detail: rebuildTotal > 0 ? games(rebuildTotal) : null,
    },
    {
      key: "rebuild",
      label: STEP_LABEL.rebuild,
      state: state("rebuild"),
      // This denominator grows every time the sweep plans another batch, which
      // it keeps doing long after the import is finished — so the fill would
      // slide backwards on a run going perfectly well. The tally does not: both
      // its numbers only ever rise.
      fraction: null,
      detail: rebuildTotal > 0 ? outOf(Math.min(rebuiltWeight, rebuildTotal), rebuildTotal) : null,
    },
    {
      key: "analyse",
      label: STEP_LABEL.analyse,
      state: state("analyse"),
      // Attached by `useJourney` from the ratchet, for the same reason as the
      // rebuild above: the snapshot is planned in batches, so the raw fraction
      // drops every time one lands.
      fraction: null,
      detail: analyses.length > 0 ? outOf(analysed, analyses.length) : null,
    },
    {
      key: "write",
      label: STEP_LABEL.write,
      // The run's own stage is the last resort, and only here: a workflow list
      // read before the examination exists says nothing, and "writing" is the
      // one step whose start the run announces on its own.
      state:
        !finished.write && current === "write" && runStage === "report_ready" ? "done" : state("write"),
      fraction: null,
      detail: null,
    },
  ];
}

/** The step being worked on now, or null once everything has finished. */
export function currentStep(steps: readonly Step[]): Step | null {
  return steps.find((step) => step.state === "running") ?? null;
}

// ---------------------------------------------------------------------------
// The estimate
// ---------------------------------------------------------------------------

/** How long two samples must span before their throughput means anything. */
const MIN_SPAN_MS = 8_000;
/** Roughly a minute of polling, so a slow patch pulls the rate down. */
const SAMPLE_LIMIT = 10;
interface Sample {
  at: number;
  done: number;
}

interface Held {
  ms: number;
  at: number;
}

export interface SyncTracker {
  /** The furthest the bar has been drawn. Never falls back except on a replan. */
  fraction: number | null;
  /** Samples of completed analysis weight, oldest first. */
  samples: Sample[];
  /** The last time-remaining shown, and when it was worked out. */
  held: Held | null;
  /** The denominator those samples were measured against. */
  total: number;
}

export function emptyTracker(): SyncTracker {
  return { fraction: null, samples: [], held: null, total: 0 };
}

function throughputRemaining(samples: Sample[], total: number): number | null {
  if (samples.length < 2) return null;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const span = last.at - first.at;
  const done = last.done - first.done;
  // No span, or no movement, is not a rate. Saying "working it out" is the
  // honest reading of both, and inventing one from a single sample is how a
  // first paint ends up promising four seconds.
  if (span < MIN_SPAN_MS || done <= 0) return null;
  const left = total - last.done;
  if (left <= 0) return 0;
  return (left / done) * span;
}

/**
 * The time remaining, recomputed from the rate rather than ratcheted.
 *
 * This used to only ever fall, on the reasoning that a countdown which counts
 * up reads as broken. That reasoning is right when the job is a known quantity
 * and badly wrong here, because it is not: the analysis run is planned in
 * batches, so early on the estimate is measured against a fraction of the work
 * and is *far* too low. Locked to falling, it promised "under a minute" and
 * then sat there for the better part of an hour while the real total grew ten
 * times over. Being stuck and wrong is worse than moving and right.
 *
 * So a freshly measured rate always wins. Between measurements the previous
 * figure is aged by the time that has actually passed, which is what makes it
 * tick down rather than freeze, and the labels are coarse enough that ordinary
 * variation in throughput never shows as jitter.
 */
function holdDown(previous: Held | null, fresh: number | null, at: number): Held | null {
  if (fresh !== null) return { ms: fresh, at };
  if (previous === null) return null;
  return { ms: Math.max(0, previous.ms - (at - previous.at)), at };
}

/** Fold one reading of the journey into the tracker. */
export function observe(
  tracker: SyncTracker,
  reading: { at: number; journey: Journey },
): SyncTracker {
  const { journey } = reading;
  const total = journey.weight.total;

  /*
   * The bar holds its high-water mark, always.
   *
   * The analysis run is planned in batches — fifty games at a time, not the
   * whole archive at once — so the denominator grows in steps all the way
   * through and the raw fraction drops every time a batch lands. Letting the
   * fill follow that would have it slide backwards repeatedly on a run that is
   * going perfectly well, which reads as a bug whatever the arithmetic says.
   *
   * The cost is that the fill pauses while a batch is absorbed. That is exactly
   * why the games count sits beside it: a raw tally cannot regress, so it keeps
   * moving through the moments the bar has to wait.
   */
  const fraction =
    journey.fraction === null
      ? tracker.fraction
      : Math.max(tracker.fraction ?? 0, journey.fraction);

  const samples = tracker.samples.concat({ at: reading.at, done: journey.weight.done }).slice(-SAMPLE_LIMIT);

  return {
    fraction,
    samples,
    total: Math.max(tracker.total, total),
    held: holdDown(tracker.held, throughputRemaining(samples, total), reading.at),
  };
}

/** Milliseconds left as of `now`, or null while there is not enough evidence. */
export function remainingAt(tracker: SyncTracker, now: number): number | null {
  if (tracker.held === null) return null;
  return Math.max(0, tracker.held.ms - (now - tracker.held.at));
}

/**
 * The estimate as a sentence.
 *
 * Coarse on purpose. A figure derived from a throughput measured over a minute
 * does not support "3 min 40 s", and a countdown ticking second by second
 * invites somebody to watch it instead of the chess.
 */
export function etaLabel(remainingMs: number | null): string {
  if (remainingMs === null) return "Working out how long this will take";
  const minutes = remainingMs / 60_000;
  if (minutes < 0.75) return "Under a minute left";
  if (minutes < 1.5) return "About a minute left";
  if (minutes < 60) return `About ${Math.round(minutes)} minutes left`;
  return "Over an hour left";
}

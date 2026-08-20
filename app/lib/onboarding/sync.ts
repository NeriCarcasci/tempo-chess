/**
 * What the sync screen knows, as pure functions.
 *
 * The screen shows three named sections filling up, and every one of them fills
 * from a real numerator over a real denominator. That is harder than it sounds,
 * because the examination is not one workflow:
 *
 *   * `initial_examination` holds five items — the account sync, then prepare,
 *     report, examine, advance;
 *   * `game_import` workflows hold one item per game to rebuild;
 *   * a `game_analysis` workflow exists **per game**, and its items carry the
 *     weights the planner set precisely so that progress reflects work rather
 *     than counting items of wildly different size (screening 80, deep 12,
 *     transitions 4, practical context 4).
 *
 * So the honest picture is the weights of all of them, bucketed by kind. There
 * is no endpoint that exposes work items — `server/src/v1/routes/workflows.ts`
 * refuses one on purpose — so bucketing happens at workflow granularity, which
 * is as fine as the API goes.
 *
 * Two things are estimates rather than facts, and both are ratcheted before a
 * person sees them: the denominators grow as the workflow discovers work, so a
 * raw fraction walks backwards and a raw countdown counts upward. Neither is
 * allowed to.
 */

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/**
 * The three parts of the examination, in the order they happen.
 *
 * Three, not the two the bar strictly needs. Writing the report is real work at
 * the end, and a bar that stopped at "Analysing" would sit full and
 * finished-looking for the whole of it — the same lie as a bar stuck at zero,
 * told at the other end.
 */
export const SYNC_SECTIONS = [
  {
    id: "importing",
    label: "Importing",
    detail: "Reading your archive and rebuilding every position in it.",
  },
  {
    id: "analysing",
    label: "Analysing",
    detail: "Every move you played, through the engine, one game at a time.",
  },
  {
    id: "reporting",
    label: "Writing",
    detail: "Turning what the engine found into something worth reading.",
  },
] as const;

export type SectionId = (typeof SYNC_SECTIONS)[number]["id"];

/** The part of a workflow this screen reads. Widened so tests need no fixtures. */
export interface WorkflowLike {
  kind: string;
  state: string;
  progress: { completedWeight: number; totalWeight: number; stage: string | null };
}

const KIND_SECTION: Record<string, SectionId> = {
  account_sync: "importing",
  game_import: "importing",
  game_analysis: "analysing",
  subject_estimation: "reporting",
};

/**
 * Which section a workflow's weight belongs to, or null for one that is not
 * part of this journey at all.
 *
 * `initial_examination` is the awkward one: its five items straddle two
 * sections, and only its aggregate weight is on the wire. `progress.stage` is
 * the task type of its oldest outstanding item, which says which side of the
 * split it is still on — and counting the whole thing as writing would show the
 * report a fifth written while the archive was still downloading.
 */
export function sectionOfWorkflow(workflow: WorkflowLike): SectionId | null {
  if (workflow.kind === "initial_examination") {
    return workflow.progress.stage === "provider_account_sync" ? "importing" : "reporting";
  }
  return KIND_SECTION[workflow.kind] ?? null;
}

export interface Weight {
  completed: number;
  total: number;
}

export type SectionWeights = Record<SectionId, Weight>;

export function emptyWeights(): SectionWeights {
  return {
    importing: { completed: 0, total: 0 },
    analysing: { completed: 0, total: 0 },
    reporting: { completed: 0, total: 0 },
  };
}

export function weighSections(workflows: readonly WorkflowLike[]): SectionWeights {
  const weights = emptyWeights();
  for (const workflow of workflows) {
    // Cancelled work is neither done nor outstanding, and leaving it in the
    // denominator would hold every section short of full for ever.
    if (workflow.state === "cancelled") continue;
    const section = sectionOfWorkflow(workflow);
    if (section === null) continue;
    weights[section].completed += workflow.progress.completedWeight;
    weights[section].total += workflow.progress.totalWeight;
  }
  return weights;
}

/** A section's own fill, or null while it has no denominator. */
export function fractionOf(weight: Weight): number | null {
  if (weight.total <= 0) return null;
  return Math.min(1, Math.max(0, weight.completed / weight.total));
}

/** The whole examination as one figure, for assistive technology. */
export function overallPercent(weights: SectionWeights): number | null {
  let completed = 0;
  let total = 0;
  for (const section of SYNC_SECTIONS) {
    completed += weights[section.id].completed;
    total += weights[section.id].total;
  }
  if (total <= 0) return null;
  return Math.round((completed / total) * 100);
}

const outstanding = (weight: Weight): boolean =>
  weight.total > 0 && weight.completed < weight.total;

/**
 * Which section to name and highlight.
 *
 * Engine work outstanding beats every other signal. The examination workflow
 * reaches its report step early and then waits for exactly that work, so its
 * own task type would put the bar on "Writing" while a hundred games were still
 * queued. Before any analysis has been planned there is nothing to weigh, and
 * the run's own stage is the only thing left to go on.
 *
 * The stage decides *which* section is current and never how full one is.
 */
export function currentSection(weights: SectionWeights, runStage: string): SectionId {
  if (outstanding(weights.analysing)) return "analysing";
  if (weights.analysing.total === 0) {
    return runStage === "linking" || runStage === "syncing" || runStage === "not_started"
      ? "importing"
      : "analysing";
  }
  return "reporting";
}

/** Boards are worth showing once there are analysed games to show. */
export function boardsBelongHere(weights: SectionWeights, current: SectionId): boolean {
  return current !== "importing" || weights.analysing.total > 0;
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
  completed: number;
}

interface Held {
  ms: number;
  at: number;
}

/**
 * Everything the screen remembers between polls.
 *
 * One value, so the component keeps a single piece of state and the whole thing
 * stays testable without a browser.
 */
export interface SyncTracker {
  /** The furthest each section has been drawn. Never falls back. */
  fractions: Record<SectionId, number | null>;
  /** Samples of total completed weight, oldest first. */
  samples: Sample[];
  /** The last time-remaining shown, and when it was worked out. */
  held: Held | null;
}

export function emptyTracker(): SyncTracker {
  return {
    fractions: { importing: null, analysing: null, reporting: null },
    samples: [],
    held: null,
  };
}

function throughputRemaining(samples: Sample[], weights: SectionWeights): number | null {
  if (samples.length < 2) return null;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const span = last.at - first.at;
  const done = last.completed - first.completed;
  // No span, or no movement, is not a rate. Saying "working it out" is the
  // honest reading of both, and inventing one from a single sample is how a
  // first paint ends up promising four seconds.
  if (span < MIN_SPAN_MS || done <= 0) return null;

  let completed = 0;
  let total = 0;
  for (const section of SYNC_SECTIONS) {
    completed += weights[section.id].completed;
    total += weights[section.id].total;
  }
  const left = total - completed;
  if (left <= 0) return 0;
  return (left / done) * span;
}

/**
 * The new time remaining, which is never longer than the old one.
 *
 * The previous figure is first aged by the time that has actually passed, so
 * holding it is not the same as freezing it. A fresh estimate only ever
 * replaces it downwards: work discovered mid-run pushes the true estimate up,
 * and a countdown that counts up reads as broken however true it is. When there
 * is no fresh estimate at all the aged figure carries on, because dropping back
 * to "working it out" after having said a number takes information away.
 */
function holdDown(previous: Held | null, fresh: number | null, at: number): Held | null {
  const aged =
    previous === null ? null : { ms: Math.max(0, previous.ms - (at - previous.at)), at };
  if (fresh === null) return aged;
  if (aged === null) return { ms: fresh, at };
  return { ms: Math.min(aged.ms, fresh), at };
}

/** Fold one reading of the workflow list into the tracker. */
export function observe(
  tracker: SyncTracker,
  reading: { at: number; weights: SectionWeights },
): SyncTracker {
  const fractions = { ...tracker.fractions };
  let completed = 0;
  for (const section of SYNC_SECTIONS) {
    const weight = reading.weights[section.id];
    completed += weight.completed;
    const raw = fractionOf(weight);
    // The denominator grows every time the workflow discovers work — a sync of
    // 300 games becomes 300 analysis workflows — so the raw fraction dips. Each
    // section holds its high-water mark instead: a bar that walks backwards
    // reads as a bug whatever the arithmetic says.
    if (raw !== null) {
      fractions[section.id] = Math.max(fractions[section.id] ?? 0, raw);
    }
  }

  const samples = tracker.samples.concat({ at: reading.at, completed }).slice(-SAMPLE_LIMIT);
  return {
    fractions,
    samples,
    held: holdDown(tracker.held, throughputRemaining(samples, reading.weights), reading.at),
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

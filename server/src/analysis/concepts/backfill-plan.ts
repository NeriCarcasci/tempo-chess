/**
 * What a backfill will do, decided before it does any of it.
 *
 * The command that runs this touches other people's evidence, so the parts
 * worth being sure about — which games are in scope, what each one is for, and
 * whether the counts add up afterwards — are here as pure functions rather than
 * inside a script that needs a database and a person's archive to exercise.
 *
 * ## Why a run that already has a manifest is not simply redone
 *
 * A run's artifact manifest is immutable (E11) and records what that analysis
 * run concluded. `run_concept_opportunities` records which observations it
 * concluded them from. Together they are what stops a later backfill changing
 * an already-published review in place.
 *
 * So a run with no manifest has never been measured and is the backfill's
 * proper target. A run *with* one has been measured, and if this build would
 * now conclude something different — because the catalogue gained a concept, or
 * a detector was corrected — that is a different conclusion about the game and
 * needs a new analysis run rather than an edit of the old one. The worker
 * refuses it, deliberately, and this plan names those runs instead of throwing
 * the whole batch away over them.
 */

/** What the backfill intends to do with one analysed run. */
export type Disposition =
  /** Never measured. The backfill's proper target. */
  | "detect"
  /** Measured already. Re-run only to reconcile, never to change. */
  | "verify";

export interface RunCandidate {
  readonly runId: string;
  readonly subjectGameId: string;
  /** True when the run already carries a concept artifact manifest. */
  readonly hasManifest: boolean;
}

export type BackfillMode =
  /** Only runs that have never been measured. The default, and the safe one. */
  | "missing"
  /** Those, plus a no-op re-run of measured ones to reconcile their counts. */
  | "verify";

export interface BackfillOptions {
  readonly profileId: string;
  readonly mode: BackfillMode;
  /** Report the scope and write nothing. */
  readonly dryRun: boolean;
  /** Stop after this many runs. Zero means no bound. */
  readonly limit: number;
}

export class OptionError extends Error {}

/**
 * Options from the command line and the environment.
 *
 * `PROFILE_ID` stays an environment variable rather than becoming a flag,
 * because it is the one input that decides whose evidence is touched and a flag
 * is easier to leave in a shell history and reuse against the wrong person.
 */
export function parseOptions(argv: readonly string[], env: Record<string, string | undefined>): BackfillOptions {
  const profileId = env.PROFILE_ID?.trim();
  if (!profileId) throw new OptionError("PROFILE_ID is not set; this command acts on exactly one person");

  let mode: BackfillMode = "missing";
  let dryRun = false;
  let limit = 0;

  for (const argument of argv) {
    if (argument === "--dry-run") { dryRun = true; continue; }
    if (argument === "--verify") { mode = "verify"; continue; }
    if (argument === "--missing-only") { mode = "missing"; continue; }
    if (argument.startsWith("--limit=")) {
      const value = Number(argument.slice("--limit=".length));
      if (!Number.isInteger(value) || value < 1) {
        throw new OptionError(`--limit needs a whole number of runs, not ${argument.slice("--limit=".length)}`);
      }
      limit = value;
      continue;
    }
    throw new OptionError(`unknown option ${argument}`);
  }
  return { profileId, mode, dryRun, limit };
}

/** What this run is for, given what it already has. */
export function classify(candidate: RunCandidate): Disposition {
  // Zero assessments is still a complete, empty detector conclusion. The
  // worker records a zero-row manifest for it so the review can distinguish
  // `published: []` from `unavailable`; selection must not hide it here.
  return candidate.hasManifest ? "verify" : "detect";
}

/** The runs a mode acts on, in a stable order, bounded by the limit. */
export function selectRuns(
  candidates: readonly RunCandidate[],
  options: BackfillOptions,
): { readonly selected: RunCandidate[]; readonly skipped: Record<Disposition, number> } {
  const skipped: Record<Disposition, number> = { detect: 0, verify: 0 };
  const selected: RunCandidate[] = [];

  // Sorted by run id rather than by discovery order: an interrupted batch is
  // resumed by running the same command again, and that only picks up where it
  // left off if the order does not move under it.
  const ordered = [...candidates].sort((a, b) => a.runId.localeCompare(b.runId));

  for (const candidate of ordered) {
    const disposition = classify(candidate);
    const wanted = disposition === "detect"
      || (disposition === "verify" && options.mode === "verify");
    if (!wanted || (options.limit > 0 && selected.length >= options.limit)) {
      skipped[disposition] += 1;
      continue;
    }
    selected.push(candidate);
  }
  return { selected, skipped };
}

// ---------------------------------------------------------------------------
// What happened
// ---------------------------------------------------------------------------

export type RunOutcome =
  /** Detection ran and recorded a manifest. */
  | { readonly kind: "completed"; readonly runId: string; readonly checksum: string | null; readonly opportunities: number; readonly censored: number }
  /** Detection could not read the evidence; explicitly named, never failed. */
  | { readonly kind: "abstained"; readonly runId: string; readonly reason: string }
  /**
   * This build concludes something different from what the run recorded.
   *
   * Not a failure of the backfill and not something it may fix: the run's
   * manifest is immutable, so a different conclusion needs a new analysis run.
   * Named here so an operator can plan those rather than discover them.
   */
  | { readonly kind: "needs_new_run"; readonly runId: string }
  /** Something else went wrong with this one game. */
  | { readonly kind: "failed"; readonly runId: string; readonly code: string };

export interface BackfillReport {
  considered: number;
  eligible: number;
  /** Selected but deliberately not executed by a dry run. */
  planned: number;
  completed: number;
  abstained: number;
  needsNewRun: number;
  failed: number;
  skipped: Record<Disposition, number>;
  opportunities: number;
  censored: number;
  abstentions: { unregisteredConcept: number; unrecordableDraft: number };
  byConcept: Record<string, number>;
}

export function summarise(
  considered: number,
  skipped: Record<Disposition, number>,
  outcomes: readonly RunOutcome[],
  counts: { opportunities: number; censored: number; unregisteredConcept: number; unrecordableDraft: number; byConcept: Record<string, number> },
  planned = 0,
): BackfillReport {
  return {
    considered,
    eligible: outcomes.length + planned,
    planned,
    completed: outcomes.filter((outcome) => outcome.kind === "completed").length,
    abstained: outcomes.filter((outcome) => outcome.kind === "abstained").length,
    needsNewRun: outcomes.filter((outcome) => outcome.kind === "needs_new_run").length,
    failed: outcomes.filter((outcome) => outcome.kind === "failed").length,
    skipped,
    opportunities: counts.opportunities,
    censored: counts.censored,
    abstentions: {
      unregisteredConcept: counts.unregisteredConcept,
      unrecordableDraft: counts.unrecordableDraft,
    },
    byConcept: counts.byConcept,
  };
}

/**
 * Whether every run in scope is accounted for.
 *
 * The property FOR-136 asks for, stated as arithmetic: each eligible run is
 * completed, deliberately abstained, named as needing a new run, or named as
 * failed. A run that is none of those has been silently lost, and a backfill
 * that loses runs silently is worse than one that does not run.
 */
export function reconcile(report: BackfillReport): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const accounted = report.planned + report.completed + report.abstained
    + report.needsNewRun + report.failed;
  if (accounted !== report.eligible) {
    problems.push(
      `${report.eligible} runs were selected but ${accounted} are accounted for; `
      + `${report.eligible - accounted} vanished without an outcome`,
    );
  }
  const skippedTotal = report.skipped.detect + report.skipped.verify;
  if (report.eligible + skippedTotal !== report.considered) {
    problems.push(
      `${report.considered} runs were considered but ${report.eligible + skippedTotal} were `
      + "either selected or skipped",
    );
  }
  if (report.opportunities < 0 || report.censored < 0) {
    problems.push("a count went negative, which means the tally is wrong rather than the data");
  }
  return { ok: problems.length === 0, problems };
}

/** Machine-readable outcome: action-required is not a complete success. */
export function exitCodeFor(
  report: BackfillReport,
  reconciled: boolean,
  databaseDeltaMatches: boolean,
): 0 | 1 | 2 {
  if (!reconciled || !databaseDeltaMatches || report.failed > 0) return 1;
  return report.needsNewRun > 0 || report.abstained > 0 ? 2 : 0;
}

/** The report as lines, for an operator reading a terminal. */
export function reportLines(report: BackfillReport, options: BackfillOptions): string[] {
  const lines = [
    `mode         ${options.mode}${options.dryRun ? " (dry run — nothing was written)" : ""}`,
    `considered   ${report.considered} analysed runs`,
    `selected     ${report.eligible}`,
    ...(report.planned > 0 ? [`  planned    ${report.planned} (not executed)`] : []),
    `  completed  ${report.completed}`,
    `  abstained  ${report.abstained}`,
    `  new run    ${report.needsNewRun} (this build concludes differently; plan a new analysis run)`,
    `  failed     ${report.failed}`,
    `skipped      ${report.skipped.detect} unmeasured, ${report.skipped.verify} measured`,
    `written      ${report.opportunities} opportunities (${report.censored} censored)`,
  ];
  if (report.abstentions.unregisteredConcept > 0) {
    lines.push(`unregistered ${report.abstentions.unregisteredConcept} drafts against concepts this database does not have`);
  }
  if (report.abstentions.unrecordableDraft > 0) {
    lines.push(`unrecordable ${report.abstentions.unrecordableDraft} drafts the validators refused`);
  }
  for (const [slug, count] of Object.entries(report.byConcept).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${slug.padEnd(24)} ${count}`);
  }
  return lines;
}

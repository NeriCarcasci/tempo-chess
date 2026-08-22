/**
 * `npm run concepts:backfill` — measure games that were analysed before the
 * detector existed, or before a concept it now knows about did.
 *
 * Every game in this environment already has a succeeded analysis run with its
 * transitions assessed and its position graph materialized. Replanning them
 * would repeat the screening and deep searches, which are the expensive part
 * and whose output has not changed. The detector reads that output, so this
 * walks the runs that already succeeded and calls exactly the same
 * `detectForRun` the worker calls — not a second implementation, and not a
 * shortcut past the actor binding.
 *
 * ## Safe invocation
 *
 * ```bash
 * # See the scope. Writes nothing.
 * PROFILE_ID=<uuid> npm run concepts:backfill -- --dry-run
 *
 * # Measure the runs that have never been measured. The default, and the safe one.
 * PROFILE_ID=<uuid> npm run concepts:backfill
 *
 * # In bounded batches, for a large archive.
 * PROFILE_ID=<uuid> npm run concepts:backfill -- --limit=100
 *
 * # Also re-run already-measured runs, to reconcile their counts. Writes nothing
 * # new when they agree, and names them when they do not.
 * PROFILE_ID=<uuid> npm run concepts:backfill -- --verify
 * ```
 *
 * `PROFILE_ID` decides whose evidence is touched, and it is an environment
 * variable rather than a flag so it is harder to leave in a shell history and
 * reuse against the wrong person. Every read and write runs under
 * `withActor`, so row level security is the boundary rather than the `where`
 * clause.
 *
 * ## Recovering an interrupted batch
 *
 * Run the same command again. A run that completed carries an artifact
 * manifest, so the default mode no longer selects it; the selection is sorted
 * by run id so the order does not move under a resumed batch; and each run is
 * its own transaction, so an interruption leaves completed games written and
 * the interrupted one untouched rather than half-written. A second completed
 * run over the same scope selects nothing and writes nothing.
 *
 * ## What it will not do
 *
 * It will not change what a published review already said. A run whose manifest
 * disagrees with this build's conclusions — because the catalogue gained a
 * concept, or a detector was corrected — needs a *new* analysis run, and
 * planning those is the pipeline's job rather than this command's. Such runs are
 * counted and named so an operator can plan them, and the batch carries on.
 *
 * It performs no production mutation on its own account: it writes only the
 * evidence the detector concludes, for the one profile named, and `--dry-run`
 * writes nothing at all.
 */

import postgres from "postgres";
import { detectForRun } from "./worker.js";
import { withActor } from "../../db/actor.js";
import {
  OptionError,
  parseOptions,
  reconcile,
  reportLines,
  selectRuns,
  summarise,
  type RunCandidate,
  type RunOutcome,
} from "./backfill-plan.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

let options;
try {
  options = parseOptions(process.argv.slice(2), process.env);
} catch (error) {
  console.error(error instanceof OptionError ? error.message : String(error));
  process.exit(1);
}

const client = postgres(url, { max: 1, prepare: false });

try {
  // Bound, like everything else that touches a tenant table. These force row
  // level security against `private.current_actor_id()`, so unbound this
  // returns no rows and reports "0 analysed games" for a subject with a hundred
  // and ninety-six of them -- which is exactly what it did the first time it
  // ran, under a comment claiming it was bound.
  const candidates = await withActor(client, options.profileId, (tx) =>
    tx<{ run_id: string; subject_game_id: string; has_manifest: boolean; has_assessments: boolean }[]>`
      select r.id as run_id,
             r.subject_game_id,
             exists (
               select 1 from analysis.run_artifacts a
               where a.run_id = r.id and a.family = 'concept_opportunities'
             ) as has_manifest,
             exists (
               select 1 from analysis.transition_assessments t where t.analysis_run_id = r.id
             ) as has_assessments
      from analysis.runs r
      join chess.subject_games g on g.id = r.subject_game_id
      join app.analysis_subjects s on s.id = g.subject_id
      where s.owner_user_id = ${options.profileId}
        and r.status = 'succeeded'
        and r.subject_game_id is not null
      order by r.id
    `,
  );

  const { selected, skipped } = selectRuns(
    candidates.map((row): RunCandidate => ({
      runId: row.run_id,
      subjectGameId: row.subject_game_id,
      hasManifest: row.has_manifest,
      hasAssessments: row.has_assessments,
    })),
    options,
  );

  // Counted before anything is written, so the reconciliation at the end has
  // something to be a difference from.
  const [before] = await withActor(client, options.profileId, (tx) =>
    tx<{ opportunities: string; events: string }[]>`
      select (select count(*)::text from analysis.concept_opportunities) as opportunities,
             (select count(*)::text from analysis.chess_events) as events
    `,
  );

  console.log(`profile      ${options.profileId}`);
  console.log(`candidates   ${candidates.length} succeeded analysis runs`);
  console.log(`selected     ${selected.length} for ${options.mode}`);

  const outcomes: RunOutcome[] = [];
  const counts = {
    opportunities: 0,
    censored: 0,
    unregisteredConcept: 0,
    unrecordableDraft: 0,
    byConcept: {} as Record<string, number>,
  };

  if (options.dryRun) {
    console.log("dry run      nothing was written");
  } else {
    for (const [index, candidate] of selected.entries()) {
      try {
        const result = await detectForRun(client, candidate.runId, options.profileId);
        const summary = result.outputSummary as {
          detection?: string;
          reason?: string;
          checksum?: string;
          opportunities?: number;
          censored?: number;
          abstentions?: { unregisteredConcept?: number; unrecordableDraft?: number };
          concepts?: Record<string, number>;
        };
        counts.opportunities += summary.opportunities ?? 0;
        counts.censored += summary.censored ?? 0;
        counts.unregisteredConcept += summary.abstentions?.unregisteredConcept ?? 0;
        counts.unrecordableDraft += summary.abstentions?.unrecordableDraft ?? 0;
        for (const [slug, count] of Object.entries(summary.concepts ?? {})) {
          counts.byConcept[slug] = (counts.byConcept[slug] ?? 0) + count;
        }
        outcomes.push(summary.detection === "abstained"
          ? { kind: "abstained", runId: candidate.runId, reason: summary.reason ?? "unstated" }
          : {
            kind: "completed",
            runId: candidate.runId,
            checksum: summary.checksum ?? null,
            opportunities: summary.opportunities ?? 0,
            censored: summary.censored ?? 0,
          });
      } catch (error) {
        // One unreadable game must not stop the other hundred and ninety-five,
        // and each run is its own transaction so a failure here leaves nothing
        // half-written.
        const code = (error as { code?: string }).code
          ?? (error as { failureCode?: string }).failureCode
          ?? (error as Error).name;
        if (String(code).includes("concept_manifest_drift")
          || String((error as Error).message).includes("manifest disagrees")) {
          // Expected, and not a failure: this build concludes something
          // different from what the run recorded, and an immutable manifest
          // means that needs a new run rather than an edit of this one.
          outcomes.push({ kind: "needs_new_run", runId: candidate.runId });
        } else {
          outcomes.push({ kind: "failed", runId: candidate.runId, code: String(code) });
          console.error(`run ${candidate.runId} failed: ${code}`);
        }
      }
      if ((index + 1) % 25 === 0) console.log(`progress     ${index + 1}/${selected.length}`);
    }
  }

  const report = summarise(candidates.length, skipped, outcomes, counts);
  for (const line of reportLines(report, options)) console.log(line);

  const [after] = await withActor(client, options.profileId, (tx) =>
    tx<{ opportunities: string; events: string }[]>`
      select (select count(*)::text from analysis.concept_opportunities) as opportunities,
             (select count(*)::text from analysis.chess_events) as events
    `,
  );
  const wrote = Number(after?.opportunities ?? 0) - Number(before?.opportunities ?? 0);
  console.log(
    `reconciled   ${wrote} new opportunity rows visible to this actor, `
    + `${report.opportunities} reported written`,
  );
  if (!options.dryRun && wrote !== report.opportunities) {
    // Not fatal, and worth saying loudly: the two disagree when something wrote
    // rows this command did not, or when a row it wrote is not visible to the
    // actor that wrote it.
    console.error("reconciled   the database delta and the reported writes disagree");
  }

  const check = reconcile(report);
  for (const problem of check.problems) console.error(`unreconciled ${problem}`);
  if (!check.ok) process.exitCode = 1;
  if (report.failed > 0) process.exitCode = 1;
} finally {
  await client.end({ timeout: 5 });
}
process.exit(process.exitCode ?? 0);

/**
 * `npm run concepts:backfill` — measure games that were analysed before the
 * detector existed.
 *
 * Every game in this environment already has a succeeded analysis run with its
 * transitions assessed and its position graph materialized. What those runs do
 * not have is any concept evidence, because the step that produces it was
 * planned into the per-game workflow only after they finished.
 *
 * Replanning them would work and would be wasteful: it would repeat the
 * screening and deep searches, which are the expensive part and whose output
 * has not changed. The detector reads that output. So this walks the runs that
 * already succeeded and calls exactly the same `detectForRun` the worker calls
 * -- not a second implementation, and not a shortcut past the actor binding.
 *
 * Idempotent, because evidence is append-only: `detectForRun` declines to write
 * a second copy for a run that already has one. Running it twice is safe and
 * the second run writes nothing.
 *
 * Usage: PROFILE_ID=<uuid> npm run concepts:backfill
 */

import postgres from "postgres";
import { detectForRun } from "./worker.js";
import { withActor } from "../../db/actor.js";

const url = process.env.DATABASE_URL;
const profileId = process.env.PROFILE_ID;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
if (!profileId) {
  console.error("PROFILE_ID is not set; this command acts on exactly one person");
  process.exit(1);
}
const client = postgres(url, { max: 1, prepare: false });

try {
  // Bound, like everything else that touches a tenant table. All three of
  // these force row level security against `private.current_actor_id()`, so
  // unbound this returns no rows and reports "0 analysed games to measure" for
  // a subject with a hundred and ninety-six of them -- which is exactly what it
  // did the first time it ran, under a comment claiming it was bound.
  const runs = await withActor(client, profileId, (tx) =>
    tx<{ id: string }[]>`
      select r.id
      from analysis.runs r
      join chess.subject_games g on g.id = r.subject_game_id
      join app.analysis_subjects s on s.id = g.subject_id
      where s.owner_user_id = ${profileId}
        and r.status = 'succeeded'
        and r.subject_game_id is not null
        and exists (select 1 from analysis.transition_assessments t where t.analysis_run_id = r.id)
      order by r.id
    `,
  );
  console.log(`runs       ${runs.length} analysed games to measure`);

  let opportunities = 0;
  let censored = 0;
  let failed = 0;
  const byConcept = new Map<string, number>();

  for (const [index, run] of runs.entries()) {
    try {
      const result = await detectForRun(client, run.id, profileId);
      const summary = result.outputSummary as {
        opportunities?: number;
        censored?: number;
        concepts?: Record<string, number>;
      };
      opportunities += summary.opportunities ?? 0;
      censored += summary.censored ?? 0;
      for (const [slug, count] of Object.entries(summary.concepts ?? {})) {
        byConcept.set(slug, (byConcept.get(slug) ?? 0) + count);
      }
    } catch (error) {
      // One unreadable game must not stop the other hundred and ninety-five.
      // The count is reported at the end rather than swallowed.
      failed += 1;
      // The SQLSTATE, not the message: a bare error name says a thing went
      // wrong a hundred and ninety-six times and refuses to say which thing.
      const code = (error as { code?: string }).code;
      console.error(`run ${run.id} failed: ${(error as Error).name}${code ? ` [${code}]` : ""}`);
    }
    if ((index + 1) % 25 === 0) console.log(`progress   ${index + 1}/${runs.length}`);
  }

  console.log(`written    ${opportunities} opportunities (${censored} censored)`);
  if (failed > 0) console.log(`failed     ${failed} runs`);
  for (const [slug, count] of [...byConcept].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${slug.padEnd(24)} ${count}`);
  }
} finally {
  await client.end({ timeout: 5 });
}
process.exit(0);

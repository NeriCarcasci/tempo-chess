/**
 * `npm run backfill:games`, `backfill:reconcile`, `backfill:cutover`.
 *
 * The E10 functions were exported and reachable from nothing: the 342-row
 * backfill was produced by an ad-hoc invocation nobody could reproduce, and the
 * cutover gate -- which has to be re-run once E08's adapters supply replays --
 * had no way to be invoked. This is that entry point.
 *
 * Read-only by default. `backfill:games` writes; the other two only report.
 */

import postgres from "postgres";
import { assessCutover, backfillLegacyGames, reconcile } from "./legacy.js";

const mode = process.argv[2];
if (!mode || !["games", "reconcile", "cutover"].includes(mode)) {
  console.error("usage: tsx src/backfill/cli.ts <games|reconcile|cutover> [resumeRunId]");
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(2);
}

const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });

try {
  if (mode === "games") {
    const report = await backfillLegacyGames(sql, process.argv[3]);
    console.log(`run ${report.runId}`);
    console.log(
      `processed ${report.processed}, created ${report.created}, skipped ${report.skipped}`,
    );
    console.log(`source checksum ${report.sourceChecksum.slice(0, 16)}`);
    console.log(`target checksum ${report.targetChecksum.slice(0, 16)}`);
    console.log(JSON.stringify(report.manifest, null, 2));
  } else if (mode === "reconcile") {
    const result = await reconcile(sql);
    console.log(`source checksum ${result.sourceChecksum.slice(0, 16)}`);
    console.log(`target checksum ${result.targetChecksum.slice(0, 16)}`);
    console.log(JSON.stringify(result.manifest, null, 2));
  } else {
    const gate = await assessCutover(sql);
    console.log(`cutover ready: ${gate.ready}`);
    for (const blocker of gate.blockers) console.log(`  blocker: ${blocker}`);
    console.log(JSON.stringify(gate.manifest, null, 2));
    // A gate that is not ready is not a failure of this command, so the exit
    // code stays 0: the answer is the output, and a runbook prints it.
  }
} finally {
  await sql.end({ timeout: 5 });
}

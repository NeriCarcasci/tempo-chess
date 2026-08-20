/** Start an onboarding run the way POST /v1/onboarding/runs does. */
import { client } from "./src/db/client.js";
import { withActorContext } from "./src/v1/auth/context.js";
import { startRun } from "./src/onboarding/store.js";
import { beginOnboarding } from "./src/onboarding/planner.js";

const OWNER = process.env.PROBE_OWNER!;
const SUBJECT = process.env.PROBE_SUBJECT!;

const started = await startRun(client, {
  userId: OWNER,
  subjectId: SUBJECT,
  diagnosticChoice: "skip",
});
console.log("run:", started.runId, "created:", started.created);
if (started.created) {
  const planned = await withActorContext(OWNER, (sql) =>
    beginOnboarding(sql, { runId: started.runId, userId: OWNER, subjectId: SUBJECT }),
  );
  console.log("planned:", JSON.stringify(planned));
}
process.exit(0);

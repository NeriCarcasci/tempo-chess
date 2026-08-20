import { client } from "./src/db/client.js";
import { withActor } from "./src/db/actor.js";
import { syncAccount } from "./src/sync/worker.js";
const OWNER = process.env.PROBE_OWNER!;
const ACCOUNT = process.env.PROBE_ACCOUNT!;
const SUBJECT = process.env.PROBE_SUBJECT!;
try {
  const s = await withActor(client, OWNER, (tx) =>
    syncAccount({ payload: { linkedAccountId: ACCOUNT, subjectId: SUBJECT, mode: "initial" },
      holder: "probe", workflowId: null, checkpoint: async () => {} }, tx));
  console.log("OK", JSON.stringify(s));
} catch (e: unknown) {
  const err = e as Record<string, unknown>;
  for (const k of ["name", "message", "code", "detail", "table", "routine"]) {
    if (err?.[k] !== undefined) console.log(`  ${k}:`, String(err[k]).slice(0, 400));
  }
  if (err?.query) console.log("  query:", String(err.query).replace(/\s+/g, " ").slice(0, 300));
  if (err?.stack) for (const l of String(err.stack).split("\n").slice(0, 16)) console.log("   ", l.trim());
}
process.exit(0);

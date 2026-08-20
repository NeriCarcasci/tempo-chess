/**
 * `npm run onboarding:reexamine` — start a subject's examination again.
 *
 * An operator command, and deliberately a thin one: it calls the same
 * `startRun` and `beginOnboarding` the API route calls, in the same order, with
 * the actor bound the same way. It exists because the route is the only thing
 * that can plan an examination -- E04 grants ledger inserts to `forma_api` and
 * `forma_ops` and to no worker role -- and an operator re-running a baseline
 * after a fix should not have to impersonate a browser session to do it.
 *
 * What it does not do is invent a path. Anything this command can produce, a
 * person clicking "start" produces identically; if the two ever diverge, this
 * file is the one that is wrong.
 *
 * A run is per subject and at most one is active, enforced by a partial unique
 * index rather than by this checking first. So re-running against a subject
 * that already has an active run resumes it and plans nothing, which is the
 * same answer the route gives.
 *
 * It takes the profile, not the subject, for the same reason the route does:
 * `app.analysis_subjects` is actor-scoped, so "which subject is this?" cannot be
 * asked before there is an actor to ask it as. Identity comes first and the
 * subject is resolved inside the binding -- taking a subject id would mean
 * reading it unbound, which returns nothing and looks exactly like a subject
 * that does not exist.
 *
 * Usage: PROFILE_ID=<uuid> npm run onboarding:reexamine
 */

import postgres from "postgres";
import { startRun } from "./store.js";
import { beginOnboarding } from "./planner.js";
import { withActor } from "../db/actor.js";

// Standalone, and not `db/client.js`, for the reason `ops/migrate.ts` and
// `analysis/promote.ts` are standalone: importing that runs E01's startup gates,
// which admit only a deployment role serving requests. This serves none.
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
  const [subject] = await withActor(client, profileId, (tx) =>
    tx<{ id: string }[]>`
      select id from app.analysis_subjects where owner_user_id = ${profileId} order by id limit 1
    `,
  );
  if (!subject) throw new Error(`no subject for profile ${profileId}`);
  const subjectId = subject.id;
  const userId = profileId;
  console.log(`subject    ${subjectId}`);

  const started = await startRun(client, {
    userId,
    subjectId,
    diagnosticChoice: "skip",
  });
  console.log(`run        ${started.runId} (${started.created ? "created" : "resumed"})`);

  if (!started.created) {
    console.log("planned    nothing; a run was already active and its work already exists");
  } else {
    // Bound, for the reason the route documents: the planner counts the
    // subject's accounts through `app.subject_account_memberships`, which forces
    // RLS against `private.current_actor_id()`. Unbound it reads no accounts and
    // reports `no_linked_account` for a subject that has one.
    const planned = await withActor(client, userId, (tx) =>
      beginOnboarding(tx, { runId: started.runId, userId, subjectId }),
    );
    console.log(
      planned.planned
        ? `planned    workflow ${planned.workflowId} over ${planned.accounts} account(s)`
        : `refused    ${planned.reason}`,
    );
  }
} finally {
  await client.end({ timeout: 5 });
}
process.exit(0);

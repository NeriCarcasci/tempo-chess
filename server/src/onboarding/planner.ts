/**
 * What "start onboarding" actually starts.
 *
 * E16 shipped the run row, the stages, the coverage decision and the baseline
 * report. What it never had was the thing that makes a stage change on its own:
 * nothing enqueued a sync, nothing froze a snapshot, nothing planned the
 * analysis run the examination reads. `startOnboarding` created a row that sat
 * at `linking` forever.
 *
 * This is the planner. It composes work that already exists — E08's sync, E11's
 * snapshot and run, E15's report, E16's examination — into the order the
 * contract's stages describe:
 *
 *   sync every linked account -> prepare (freeze the snapshot, plan the
 *   analysis run) -> report -> examine -> advance the stage.
 *
 * One workflow, written here, by the API. E04 grants `insert` on the ledger to
 * `forma_api` and `forma_ops` and to no worker role, which is a real safety
 * property rather than an oversight: a worker that could create work can create
 * unbounded work. So the whole chain is planned up front with its dependencies,
 * and the steps that need something a later step produces resolve it at
 * execution rather than carrying it in a payload written before it existed.
 *
 * That is why the report step is E16's task rather than E15's: it reads the
 * analysis run id off the onboarding run that `prepare` wrote, then hands the
 * work to E15 unchanged. The coupling to a coaching table stays in the coaching
 * module, and no payload has to be mutated after the fact.
 */

import type { Sql } from "postgres";
import { createWorkflow, type CreateWorkflowInput } from "../ops/ledger.js";
import { ACCOUNT_SYNC_TASK } from "../sync/worker.js";
import { COVERAGE_POLICY } from "./contract.js";
import type { CohortDefinition } from "../analysis/contract.js";
import { fetcherFor } from "../sync/providers.js";

export const PREPARE_TASK = "coaching_onboarding_prepare";
export const ADVANCE_TASK = "coaching_onboarding_advance";
export const EXAMINATION_TASK = "coaching_baseline_examination";
export const EXAMINATION_REPORT_TASK = "coaching_examination_report";

/**
 * The games a baseline is allowed to read.
 *
 * Versioned policy, hashed into the snapshot, so "we changed what counts" is a
 * new cohort version rather than a quiet shift in what every baseline compares
 * against. The choices worth defending:
 *
 *   * **Rated only.** A casual game is not evidence about how somebody plays
 *     when it counts, and the whole report is a claim about that.
 *   * **No bot opponents.** A bot game says something about the bot.
 *   * **Two hundred games.** Enough for the estimators, few enough that a first
 *     baseline arrives while the person is still interested.
 *   * **Clocks not required.** A player whose provider hides clocks still
 *     deserves a report; time pressure is one signal among several, and E14's
 *     practical context says so rather than pretending.
 */
export const ONBOARDING_COHORT = Object.freeze({
  key: "onboarding_baseline",
  version: "1",
  definition: Object.freeze({
    providers: null,
    rated: "rated",
    speeds: ["bullet", "blitz", "rapid", "classical"],
    includeBotOpponents: false,
    playedFrom: null,
    playedTo: null,
    maxGames: 200,
    minGames: COVERAGE_POLICY.minimumGames,
    requireClocks: false,
    ratingMin: null,
    ratingMax: null,
  }) as CohortDefinition,
});

export interface PlanInput {
  runId: string;
  userId: string;
  subjectId: string;
}

export interface PlannedOnboarding {
  workflowId: string;
  /** One per linked account this subject syncs. Zero is a real answer. */
  syncItemIds: readonly string[];
}

/**
 * Plan the whole examination: sync, prepare, report, examine, advance.
 *
 * Idempotent through the ledger's own idempotency keys, which are derived from
 * the onboarding run. A retried start finds the work already there rather than
 * queueing a second sync of the same archive.
 */
export async function planOnboardingWork(
  sql: Sql,
  input: PlanInput,
): Promise<PlannedOnboarding> {
  const linked = await sql<{ id: string; provider_slug: string }[]>`
    select la.id, pr.slug as provider_slug
    from app.subject_account_memberships m
    join app.linked_accounts la on la.id = m.linked_account_id
    join app.provider_identities pi on pi.id = la.provider_identity_id
    join app.providers pr on pr.id = pi.provider_id
    where m.subject_id = ${input.subjectId}
      and m.valid_to is null
      and la.status = 'active'
    order by la.id
  `;

  // Only providers there is a canonical sync adapter for. Chess.com can be
  // linked today and cannot be read yet, and the connect screen says so -- but
  // the planner did not know it, so it queued a sync that could only ever
  // raise `UnsupportedProvider`. That task exhausted its retries, and every
  // step that depended on it failed `dependency_failed`: one unreadable
  // account took down the whole examination, including the games that had
  // already synced successfully from the other one.
  //
  // Planning no work for an account is not the same as hiding it. The accounts
  // are still linked and still shown; they simply contribute nothing until
  // there is an adapter, which is a fact about Forma rather than about the
  // player.
  const accounts = linked.filter((account) => fetcherFor(account.provider_slug) !== null);

  const syncCount = accounts.length;
  const prepareIndex = syncCount;
  const reportIndex = prepareIndex + 1;
  const examineIndex = reportIndex + 1;

  const items: CreateWorkflowInput["items"] = [
    ...[...accounts].map((account) => ({
      taskType: ACCOUNT_SYNC_TASK,
      resourceClass: "ingestion" as const,
      payload: {
        linkedAccountId: account.id,
        subjectId: input.subjectId,
        mode: "initial" as const,
      },
      idempotencyKey: `onboarding:${input.runId}:sync:${account.id}`,
      queue:
        account.provider_slug === "chesscom"
          ? ("provider-chesscom" as const)
          : ("provider-lichess" as const),
    })),
    {
      taskType: PREPARE_TASK,
      resourceClass: "aggregation" as const,
      payload: { onboardingRunId: input.runId },
      idempotencyKey: `onboarding:${input.runId}:prepare`,
      queue: "analysis" as const,
      // Every sync first. A snapshot frozen while a sync is still landing games
      // is a baseline about a partial archive, which reads as a worse player.
      dependsOn: accounts.map((_, index) => index),
    },
    {
      taskType: EXAMINATION_REPORT_TASK,
      resourceClass: "aggregation" as const,
      payload: { onboardingRunId: input.runId },
      idempotencyKey: `onboarding:${input.runId}:report`,
      queue: "analysis" as const,
      dependsOn: [prepareIndex],
    },
    {
      taskType: EXAMINATION_TASK,
      resourceClass: "aggregation" as const,
      payload: { onboardingRunId: input.runId },
      idempotencyKey: `onboarding:${input.runId}:examine`,
      queue: "analysis" as const,
      dependsOn: [reportIndex],
    },
    {
      taskType: ADVANCE_TASK,
      // Aggregation rather than `api_light`: one UPDATE, but it is dispatched
      // on the analysis queue with the examination it follows, and splitting it
      // onto another deployment would buy a hop and no isolation.
      resourceClass: "aggregation" as const,
      payload: { onboardingRunId: input.runId, stage: "report_ready" },
      idempotencyKey: `onboarding:${input.runId}:advance-report-ready`,
      queue: "analysis" as const,
      dependsOn: [examineIndex],
    },
  ];

  const created = await createWorkflow({
    kind: "initial_examination",
    ownerProfileId: input.userId,
    // The resource the workflow is about, so a user watching `/v1/workflows`
    // sees "your examination" rather than an opaque row.
    resource: { type: "onboarding_run", id: input.runId },
    items,
  });

  return {
    workflowId: created.workflowId,
    syncItemIds: created.itemIds.slice(0, syncCount),
  };
}

/**
 * Start the journey, or say why it cannot start.
 *
 * A subject with no active linked account has nothing to sync and nothing to
 * analyse. That is a failure with a name — `no_linked_account` — rather than an
 * empty workflow that succeeds at doing nothing and leaves the person watching
 * a spinner. The run is failed here, at the moment the truth is known.
 */
export async function beginOnboarding(
  sql: Sql,
  input: PlanInput,
): Promise<
  | { planned: true; workflowId: string; accounts: number }
  | { planned: false; reason: "no_linked_account" }
> {
  const planned = await planOnboardingWork(sql, input);
  if (planned.syncItemIds.length === 0) {
    await sql`
      update coaching.onboarding_runs
      set status = 'failed', failure_reason = 'no_linked_account',
          completed_at = now(), updated_at = now()
      where id = ${input.runId} and status = 'active'
    `;
    return { planned: false, reason: "no_linked_account" };
  }
  await sql`
    update coaching.onboarding_runs
    set sync_workflow_id = ${planned.workflowId},
        stage = case when stage = 'linking' then 'syncing' else stage end,
        updated_at = now()
    where id = ${input.runId}
  `;
  return { planned: true, workflowId: planned.workflowId, accounts: planned.syncItemIds.length };
}

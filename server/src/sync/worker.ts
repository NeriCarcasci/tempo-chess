/**
 * The provider sync task.
 *
 * E08 built both ends of this and never the middle: the normalizer that decides
 * what may become a canonical game, and the atomic commit that writes a batch
 * with its cursor. `commitBatch` had no caller in the product. A user's games
 * reached the canonical tables only through the operator's backfill of the
 * legacy importer, which means the onboarding journey could not start.
 *
 * This is the middle. One work item syncs one linked account:
 *
 *   lock the account -> open a sync run -> fetch a page -> normalize it ->
 *   commit the batch and its cursor -> checkpoint the lease -> repeat.
 *
 * Three properties are the reason it looks like this rather than like a loop
 * that fetches everything and writes once:
 *
 *   * No provider call happens inside a database transaction. Fetch, then
 *     normalize, then commit — `commitBatch` takes only what is already
 *     normalized.
 *   * A cursor that advanced is a batch that landed. The checkpoint, the
 *     canonical rows and the cursor commit together, so a worker that dies
 *     mid-archive resumes from a position that is true.
 *   * The lease is extended between pages. A sync of a large archive is
 *     bounded work repeated, not one long operation that cannot be cancelled.
 */

import type { Sql } from "postgres";
import { registerHandler, type WorkContext, type WorkResult } from "../ops/handlers.js";
import { WorkFailure } from "../ops/retry.js";
import { withActor } from "../db/actor.js";
import {
  accountLockKey,
  acquireLock,
  commitBatch,
  finishSyncRun,
  releaseLock,
  startSyncRun,
} from "./commit.js";
import { normalizeGame, tallyRejections, type NormalizedGame, type RejectionReason, type SyncMode } from "./contract.js";
import { fetcherFor, type ProviderFetch } from "./providers.js";

export const ACCOUNT_SYNC_TASK = "provider_account_sync";

/** How many games one page asks for. Bounded so a lease is never a hostage. */
export const SYNC_PAGE_SIZE = 100;

/**
 * How many pages one work item will walk before handing back.
 *
 * A first sync of a ten-year archive is thousands of games. Rather than one
 * item that runs for an hour, the item stops and the planner re-enqueues from
 * the cursor it left — which is also what makes cancellation and retry cheap.
 */
export const MAX_PAGES_PER_ITEM = 20;

export interface SyncPayload {
  linkedAccountId: string;
  subjectId: string;
  mode: SyncMode;
}

export class UnsupportedProvider extends Error {
  constructor(readonly providerSlug: string) {
    super(`no canonical sync adapter for ${providerSlug}`);
    this.name = "UnsupportedProvider";
  }
}

export class SyncLockHeld extends Error {
  constructor() {
    super("another sync holds this account");
    this.name = "SyncLockHeld";
  }
}

function payloadOf(raw: unknown): SyncPayload {
  const value = (raw ?? {}) as Partial<SyncPayload>;
  if (typeof value.linkedAccountId !== "string" || typeof value.subjectId !== "string") {
    throw new Error("provider_account_sync needs linkedAccountId and subjectId");
  }
  const mode: SyncMode = value.mode === "reconcile" ? "reconcile" : value.mode === "initial" ? "initial" : "incremental";
  return { linkedAccountId: value.linkedAccountId, subjectId: value.subjectId, mode };
}

interface AccountRow {
  provider_id: number;
  provider_slug: string;
  username: string | null;
  status: string;
}

export interface SyncSummary {
  accepted: number;
  duplicate: number;
  corrected: number;
  rejected: number;
  pages: number;
  cursorAfter: string | null;
  /** True when the provider had more to give than this item was willing to walk. */
  moreAvailable: boolean;
}

/**
 * Sync one linked account.
 *
 * Exported separately from the handler so a gate can call it with a fake
 * provider against a real database. That split is the whole reason the cursor
 * behaviour is testable: the interesting failures here are "the cursor moved
 * when the batch did not" and "the second run re-read the first run's games",
 * and neither needs a provider to demonstrate.
 */
export async function syncAccount(
  input: {
    payload: SyncPayload;
    fetchPage?: ProviderFetch;
    holder: string;
    workflowId?: string | null;
    checkpoint?: () => Promise<{ continue: boolean }>;
  },
  sql: Sql,
): Promise<SyncSummary> {
  const { payload } = input;

  const [account] = await sql<AccountRow[]>`
    select pi.provider_id,
           pr.slug as provider_slug,
           coalesce(pi.current_display_username, pi.current_normalized_username) as username,
           la.status
    from app.linked_accounts la
    join app.provider_identities pi on pi.id = la.provider_identity_id
    join app.providers pr on pr.id = pi.provider_id
    where la.id = ${payload.linkedAccountId}
  `;
  if (!account) throw new Error("no such linked account");
  if (account.status !== "active") throw new Error("linked account is not active");
  if (!account.username) throw new Error("linked account has no provider username");

  const fetchPage = input.fetchPage ?? fetcherFor(account.provider_slug);
  if (!fetchPage) throw new UnsupportedProvider(account.provider_slug);

  // Every username the subject owns, so a game's colour is resolved from the
  // subject rather than from the account that happened to fetch it: two linked
  // accounts in one subject must not disagree about which side the player was.
  const usernameRows = await sql<{ username: string | null }[]>`
    select coalesce(pi.current_display_username, pi.current_normalized_username) as username
    from app.subject_account_memberships m
    join app.linked_accounts la on la.id = m.linked_account_id
    join app.provider_identities pi on pi.id = la.provider_identity_id
    where m.subject_id = ${payload.subjectId} and m.valid_to is null
  `;
  const subjectUsernames = [...usernameRows]
    .map((row) => row.username)
    .filter((name): name is string => name !== null);

  const lock = await acquireLock(sql, accountLockKey(payload.linkedAccountId), input.holder, 900);
  if (!lock) throw new SyncLockHeld();

  const syncRunId = await startSyncRun(sql, payload.linkedAccountId, payload.mode, input.workflowId ?? null);
  const summary: SyncSummary = {
    accepted: 0,
    duplicate: 0,
    corrected: 0,
    rejected: 0,
    pages: 0,
    cursorAfter: null,
    moreAvailable: false,
  };
  const rejections: RejectionReason[] = [];

  try {
    const [state] = await sql<{ cursor_value: string | null }[]>`
      select cursor_value from ops.account_sync_state
      where linked_account_id = ${payload.linkedAccountId}
    `;
    // A reconcile is the operator's "read it all again", and an initial sync
    // has nothing to resume from: both start at the beginning and rely on the
    // commit being idempotent per game rather than on
    // deleting anything first.
    let cursor = payload.mode === "reconcile" || payload.mode === "initial" ? null : (state?.cursor_value ?? null);

    for (let page = 0; page < MAX_PAGES_PER_ITEM; page += 1) {
      const fetched = await fetchPage({
        username: account.username,
        since: cursor,
        limit: SYNC_PAGE_SIZE,
      });
      if (fetched.games.length === 0) break;

      const accepted: NormalizedGame[] = [];
      const pageRejections: RejectionReason[] = [];
      for (const raw of fetched.games) {
        const outcome = normalizeGame(raw);
        if (outcome.accepted) accepted.push(outcome.game);
        else pageRejections.push(outcome.reason);
      }
      rejections.push(...pageRejections);

      summary.pages += 1;
      const result = await commitBatch(sql, {
        syncRunId,
        linkedAccountId: payload.linkedAccountId,
        subjectId: payload.subjectId,
        providerId: account.provider_id,
        sequenceNo: summary.pages,
        cursorAfter: fetched.cursorAfter,
        games: accepted,
        subjectUsernames,
        rejections: pageRejections,
      });
      summary.accepted += result.accepted;
      summary.duplicate += result.duplicate;
      summary.corrected += result.corrected;
      summary.rejected += result.rejected;
      summary.cursorAfter = fetched.cursorAfter;

      // A page that did not move the cursor would be re-read forever.
      if (fetched.cursorAfter === null || fetched.cursorAfter === cursor) break;
      cursor = fetched.cursorAfter;

      if (fetched.games.length < SYNC_PAGE_SIZE) break;
      if (page === MAX_PAGES_PER_ITEM - 1) summary.moreAvailable = true;

      const decision = await input.checkpoint?.();
      if (decision && !decision.continue) break;
    }

    await finishSyncRun(sql, syncRunId, "succeeded", tallyRejections(rejections));
    return summary;
  } catch (error) {
    await finishSyncRun(
      sql,
      syncRunId,
      "failed",
      tallyRejections(rejections),
      error instanceof UnsupportedProvider ? "unsupported" : "transient",
    );
    throw error;
  } finally {
    await releaseLock(sql, accountLockKey(payload.linkedAccountId), input.holder);
  }
}

async function runSyncItem(context: WorkContext, sql: Sql): Promise<WorkResult> {
  const startedAt = Date.now();
  const payload = payloadOf(context.item.payload);

  // Bound to the subject's owner, like every other worker. A sync writes
  // `chess.subject_games` and `chess.subject_game_sources`, both of which force
  // row level security against `private.current_actor_id()`. Unbound, the
  // policy refuses the insert with 42501 -- indistinguishable from a missing
  // grant, and reported as `db_permission_denied` -- so the games were fetched
  // from the provider and then silently dropped on the floor.
  //
  // The actor comes from the workflow the API wrote, never from the queue
  // payload: a forged id has to meet a policy, not a check somebody remembered.
  const [workflow] = await sql<{ owner_profile_id: string | null }[]>`
    select owner_profile_id from ops.workflows where id = ${context.item.workflowId}
  `;
  if (!workflow?.owner_profile_id) {
    throw new WorkFailure("invalid_input", "unowned_workflow", "the workflow names no owner");
  }

  const summary = await withActor(sql, workflow.owner_profile_id, (tx) =>
    syncAccount(
      {
        payload,
        holder: `work-item:${context.item.id}`,
        workflowId: context.item.workflowId ?? null,
        checkpoint: () => context.checkpoint(),
      },
      tx,
    ),
  );
  return {
    outputRef: `linked-account:${payload.linkedAccountId}`,
    outputSummary: {
      accepted: summary.accepted,
      duplicate: summary.duplicate,
      corrected: summary.corrected,
      rejected: summary.rejected,
      pages: summary.pages,
      moreAvailable: summary.moreAvailable,
    },
    metrics: {
      inputCount: summary.accepted + summary.duplicate + summary.rejected,
      outputCount: summary.accepted + summary.corrected,
      computeMs: Date.now() - startedAt,
    },
  };
}

let registered = false;

export function registerSyncHandlers(): void {
  if (registered) return;
  registered = true;
  registerHandler(ACCOUNT_SYNC_TASK, async (context) => runSyncItem(context, await runtimeSql()));
}

/** The runtime connection, resolved lazily so an offline import stays offline. */
async function runtimeSql(): Promise<Sql> {
  const { client } = await import("../db/client.js");
  return client as unknown as Sql;
}

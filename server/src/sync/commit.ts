/**
 * Durable provider locks and the atomic checkpoint commit.
 *
 * Two rules from the epic are implemented here and nowhere else:
 *
 *   No provider call happens inside a database transaction. Fetching and
 *   normalizing are the caller's job and happen first; this file only takes
 *   what has already been normalized and writes it.
 *
 *   The cursor advance, the canonical rows and the outbox event commit
 *   together or not at all. A checkpoint that exists is a batch that landed,
 *   so a worker that dies mid-sync resumes from a cursor that is true.
 */

import type { Sql } from "postgres";
import { NORMALIZER_VERSION, type NormalizedGame, type RejectionReason, type SyncMode } from "./contract.js";
import { isoOf } from "../db/timestamps.js";

// ---------------------------------------------------------------------------
// Locks
// ---------------------------------------------------------------------------

export interface HeldLock {
  key: string;
  holder: string;
  expiresAt: Date;
}

/**
 * Take a provider or account lock, or return null.
 *
 * An expired lock is taken over rather than waited on: the holder is gone and
 * the row is only evidence that it once existed. This is why every lock has an
 * expiry — a crashed instance must not hold a provider limit forever.
 */
export async function acquireLock(
  sql: Sql,
  key: string,
  holder: string,
  ttlSeconds: number,
): Promise<HeldLock | null> {
  const rows = await sql<{ lock_key: string; holder: string; expires_at: Date | string }[]>`
    insert into ops.provider_locks (lock_key, holder, expires_at)
    values (${key}, ${holder}, now() + make_interval(secs => ${ttlSeconds}))
    on conflict (lock_key) do update
      set holder = excluded.holder,
          acquired_at = now(),
          expires_at = excluded.expires_at
      where ops.provider_locks.expires_at <= now()
    returning lock_key, holder, expires_at
  `;
  if (rows.length === 0) return null;
  const expiresAt = rows[0].expires_at;
  return {
    key: rows[0].lock_key,
    holder: rows[0].holder,
    expiresAt: expiresAt instanceof Date ? expiresAt : new Date(expiresAt),
  };
}

/** Release only if still held by this holder: a lock that expired is not ours. */
export async function releaseLock(sql: Sql, key: string, holder: string): Promise<boolean> {
  const rows = await sql<{ lock_key: string }[]>`
    delete from ops.provider_locks where lock_key = ${key} and holder = ${holder}
    returning lock_key
  `;
  return rows.length > 0;
}

export function providerLockKey(providerSlug: string): string {
  return `provider:${providerSlug}`;
}

export function accountLockKey(linkedAccountId: string): string {
  return `account:${linkedAccountId}`;
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

export interface CommitBatchInput {
  syncRunId: string;
  linkedAccountId: string;
  subjectId: string;
  providerId: number;
  sequenceNo: number;
  cursorAfter: string | null;
  /** Already normalized, outside any transaction. */
  games: readonly NormalizedGame[];
  /** Usernames the subject owns, for colour resolution. */
  subjectUsernames: readonly string[];
  rejections: readonly RejectionReason[];
}

export interface CommitBatchResult {
  accepted: number;
  duplicate: number;
  corrected: number;
  rejected: number;
}

/**
 * Commit one batch: canonical rows, subject links, cursor and checkpoint.
 *
 * Idempotent per game. A redelivered batch finds each game already present at
 * the same digest and counts it as a duplicate rather than appending a spurious
 * revision, so "duplicate fetch, duplicate delivery, duplicate checkpoint" all
 * converge on one canonical result and one cursor position.
 */
export async function commitBatch(
  sql: Sql,
  input: CommitBatchInput,
): Promise<CommitBatchResult> {
  const result: CommitBatchResult = {
    accepted: 0,
    duplicate: 0,
    corrected: 0,
    rejected: input.rejections.length,
  };

  await sql.begin(async (tx) => {
    for (const game of input.games) {
      // 1. Provider game identity. Shared across every user who saw it.
      const [providerGame] = await tx<{ id: string; current_replay_revision_id: string | null }[]>`
        insert into chess.provider_games (provider_id, provider_game_id)
        values (${input.providerId}, ${game.providerGameId})
        on conflict (provider_id, provider_game_id) do update set last_seen_at = now()
        returning id, current_replay_revision_id
      `;

      // 2. Has this exact replay already been recorded for this game?
      const existing = await tx<{ id: string; revision_no: number }[]>`
        select id, revision_no from chess.game_replay_revisions
        where provider_game_id = ${providerGame.id} and normalized_sha256 = ${game.normalizedSha256}
      `;

      let revisionId: string;
      if (existing.length > 0) {
        revisionId = existing[0].id;
        result.duplicate += 1;
      } else {
        const [{ next_no, had_prior }] = await tx<{ next_no: number; had_prior: boolean }[]>`
          select coalesce(max(revision_no), 0) + 1 as next_no,
                 count(*) > 0 as had_prior
          from chess.game_replay_revisions where provider_game_id = ${providerGame.id}
        `;
        // A first revision is first_seen; a later one for the same game is the
        // provider telling us something changed.
        const reason = had_prior ? "provider_correction" : "first_seen";
        // The timestamps go over as ISO strings, not Date objects.
        // `drizzle(client, { schema })` replaces postgres.js's handlers for
        // every date and timestamp OID when it is constructed, and it replaces
        // the *serialiser* along with the parser -- so a Date bound as a
        // parameter reaches `Buffer.byteLength` and throws
        // "Received an instance of Date" before the statement is ever sent.
        // Every game the provider returned was normalized and then lost here.
        const [inserted] = await tx<{ id: string }[]>`
          insert into chess.game_replay_revisions (
            provider_game_id, revision_no, normalizer_component_version_id, normalized_replay,
            normalized_sha256, initial_fen, played_at, completed_at, rated, speed, time_control,
            result, termination, ply_count, provider_url, revision_reason
          ) values (
            ${providerGame.id}, ${next_no}, ${NORMALIZER_VERSION},
            ${JSON.stringify(game.normalizedReplay)}::jsonb, ${game.normalizedSha256},
            ${game.initialFen}, ${isoOf(game.playedAt)}, ${isoOf(game.completedAt)}, ${game.rated},
            ${game.speed}, ${game.timeControl}, ${game.result}, ${game.termination},
            ${game.plyCount}, ${game.providerUrl}, ${reason}
          ) returning id
        `;
        revisionId = inserted.id;
        for (const participant of game.participants) {
          await tx`
            insert into chess.game_revision_participants (
              replay_revision_id, color, username_snapshot, title_snapshot, rating,
              rating_change, outcome, is_bot, is_provisional
            ) values (
              ${revisionId}, ${participant.color}, ${participant.username}, ${participant.title},
              ${participant.rating}, ${participant.ratingChange}, ${participant.outcome},
              ${participant.isBot}, ${participant.isProvisional}
            )
          `;
        }
        // The pointer moves; the old revision is untouched.
        await tx`
          update chess.provider_games set current_replay_revision_id = ${revisionId}
          where id = ${providerGame.id}
        `;
        if (had_prior) result.corrected += 1;
        else result.accepted += 1;
      }

      // 3. The subject's owned statement about the game.
      const owned = new Set(input.subjectUsernames.map((n) => n.trim().toLowerCase()));
      const white = game.participants.find((p) => p.color === "white")?.username?.toLowerCase() ?? "";
      const black = game.participants.find((p) => p.color === "black")?.username?.toLowerCase() ?? "";
      const isWhite = owned.has(white);
      const isBlack = owned.has(black);
      const ambiguous = isWhite && isBlack;
      const color = ambiguous ? null : isWhite ? "white" : isBlack ? "black" : null;

      const [subjectGame] = await tx<{ id: string }[]>`
        insert into chess.subject_games (
          subject_id, provider_game_id, latest_replay_revision_id, subject_color, status
        ) values (
          ${input.subjectId}, ${providerGame.id}, ${revisionId}, ${color},
          ${ambiguous ? "ambiguous" : "included"}
        )
        on conflict (subject_id, provider_game_id) do update
          set latest_replay_revision_id = ${revisionId}, updated_at = now()
        returning id
      `;

      await tx`
        insert into chess.subject_game_sources (subject_game_id, linked_account_id, sync_run_id)
        values (${subjectGame.id}, ${input.linkedAccountId}, ${input.syncRunId})
        on conflict (subject_game_id, linked_account_id) do update set last_seen_at = now()
      `;
    }

    // 4. The checkpoint and the cursor, in the same transaction as the rows
    // above. This is the whole point: a checkpoint that exists is a batch that
    // landed, so resuming from it cannot skip or repeat work.
    await tx`
      insert into ops.sync_checkpoints (sync_run_id, sequence_no, cursor_value, games_in_batch)
      values (${input.syncRunId}, ${input.sequenceNo}, ${input.cursorAfter}, ${input.games.length})
      on conflict (sync_run_id, sequence_no) do nothing
    `;
    await tx`
      insert into ops.account_sync_state (linked_account_id, cursor_value, last_success_at)
      values (${input.linkedAccountId}, ${input.cursorAfter}, now())
      on conflict (linked_account_id) do update
        set cursor_value = ${input.cursorAfter}, last_success_at = now(),
            consecutive_failures = 0, updated_at = now()
    `;
    await tx`
      update ops.sync_runs
      set games_accepted = games_accepted + ${result.accepted},
          games_duplicate = games_duplicate + ${result.duplicate},
          games_corrected = games_corrected + ${result.corrected},
          games_rejected = games_rejected + ${result.rejected},
          cursor_after = ${input.cursorAfter}
      where id = ${input.syncRunId}
    `;
  });

  return result;
}

export async function startSyncRun(
  sql: Sql,
  linkedAccountId: string,
  mode: SyncMode,
  workflowId?: string | null,
): Promise<string> {
  const [existing] = await sql<{ cursor_value: string | null }[]>`
    select cursor_value from ops.account_sync_state where linked_account_id = ${linkedAccountId}
  `;
  const [run] = await sql<{ id: string }[]>`
    insert into ops.sync_runs (linked_account_id, workflow_id, mode, cursor_before)
    values (${linkedAccountId}, ${workflowId ?? null}, ${mode}, ${existing?.cursor_value ?? null})
    returning id
  `;
  return run.id;
}

export async function finishSyncRun(
  sql: Sql,
  syncRunId: string,
  state: "succeeded" | "failed" | "cancelled",
  rejectionSummary?: Record<string, number>,
  failureClass?: string | null,
): Promise<void> {
  await sql`
    update ops.sync_runs
    set state = ${state}, finished_at = now(),
        rejection_summary = ${rejectionSummary ? JSON.stringify(rejectionSummary) : null}::jsonb,
        failure_class = ${failureClass ?? null}
    where id = ${syncRunId}
  `;
}

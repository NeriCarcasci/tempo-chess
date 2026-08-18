/**
 * Persisting a materialization run, and publishing it by pointer.
 *
 * A run is built in full and only then published. Publication is a single
 * statement that moves the `published` state, guarded by the partial unique
 * index, so two workers racing to publish the same revision cannot both win and
 * a reader never observes a half-written chain as current.
 *
 * A rebuild does not overwrite: it writes a new run, its checksum is compared
 * to the published one, and only a deliberate switch makes it current.
 */

import type { Sql } from "postgres";
import { CORE_KEY_VERSION, materializeReplay, type MaterializedReplay, type ReplayInput } from "./canonical.js";

export interface PersistedRun {
  runId: string;
  checksum: string;
  occurrenceCount: number;
  transitionCount: number;
  /** True when an identical published run already existed. */
  alreadyPublished: boolean;
}

/**
 * Build and store a run for a replay revision, without publishing it.
 *
 * Core positions are upserted by hash and shared across every game that reaches
 * them: that sharing is what makes a transposition findable.
 */
export async function buildRun(
  sql: Sql,
  replayRevisionId: string,
  replay: ReplayInput,
): Promise<PersistedRun> {
  const materialized = materializeReplay(replay);

  const published = await sql<{ id: string; checksum: string }[]>`
    select id, checksum from chess.materialization_runs
    where replay_revision_id = ${replayRevisionId} and state = 'published'
  `;
  if (published.length > 0 && published[0].checksum === materialized.checksum) {
    // A rebuild that agrees with what is published is a no-op, not a new run.
    return {
      runId: published[0].id,
      checksum: materialized.checksum,
      occurrenceCount: materialized.occurrences.length,
      transitionCount: materialized.transitions.length,
      alreadyPublished: true,
    };
  }

  const runId = await sql.begin(async (tx) => {
    const [run] = await tx<{ id: string }[]>`
      insert into chess.materialization_runs (
        replay_revision_id, materializer_version, checksum, state,
        occurrence_count, transition_count
      ) values (
        ${replayRevisionId}, ${CORE_KEY_VERSION}, ${materialized.checksum}, 'building',
        ${materialized.occurrences.length}, ${materialized.transitions.length}
      ) returning id
    `;

    for (const occurrence of materialized.occurrences) {
      const [core] = await tx<{ id: string }[]>`
        insert into chess.core_positions (core_key_hash, core_key, board, turn, castling, en_passant)
        values (
          ${occurrence.coreKeyHash}, ${occurrence.coreKey},
          ${occurrence.coreKey.split(" ")[0]}, ${occurrence.sideToMove},
          ${occurrence.coreKey.split(" ")[2]}, ${occurrence.coreKey.split(" ")[3]}
        )
        on conflict (core_key_hash) do update set core_key = excluded.core_key
        returning id
      `;
      await tx`
        insert into chess.position_occurrences (
          run_id, ply, core_position_id, fen, halfmove_clock, fullmove_number,
          repetition_count, side_to_move, threefold, fivefold,
          fifty_move_available, seventy_five_move_forced
        ) values (
          ${run.id}, ${occurrence.ply}, ${core.id}, ${occurrence.fen},
          ${occurrence.halfmoveClock}, ${occurrence.fullmoveNumber},
          ${occurrence.repetitionCount}, ${occurrence.sideToMove},
          ${occurrence.threefold}, ${occurrence.fivefold},
          ${occurrence.fiftyMoveAvailable}, ${occurrence.seventyFiveMoveForced}
        )
      `;
    }

    for (const transition of materialized.transitions) {
      await tx`
        insert into chess.position_transitions (run_id, from_ply, to_ply, uci, san, clock_ms)
        values (
          ${run.id}, ${transition.fromPly}, ${transition.toPly},
          ${transition.uci}, ${transition.san}, ${transition.clockMs}
        )
      `;
    }

    return run.id;
  });

  return {
    runId,
    checksum: materialized.checksum,
    occurrenceCount: materialized.occurrences.length,
    transitionCount: materialized.transitions.length,
    alreadyPublished: false,
  };
}

export interface PublishResult {
  published: boolean;
  supersededRunId: string | null;
  /** Set when a prior run existed and its checksum differs. */
  checksumChanged: boolean;
}

/**
 * Make a built run the published one, atomically.
 *
 * The prior run is marked superseded rather than deleted, so the chain an older
 * analysis cited is still there to be read.
 */
export async function publishRun(sql: Sql, runId: string): Promise<PublishResult> {
  return sql.begin(async (tx) => {
    const [run] = await tx<{ id: string; replay_revision_id: string; checksum: string; state: string }[]>`
      select id, replay_revision_id, checksum, state
      from chess.materialization_runs where id = ${runId} for update
    `;
    if (!run) throw new Error("no such materialization run");
    if (run.state === "published") {
      return { published: true, supersededRunId: null, checksumChanged: false };
    }
    if (run.state === "failed") throw new Error("a failed run cannot be published");

    const [prior] = await tx<{ id: string; checksum: string }[]>`
      select id, checksum from chess.materialization_runs
      where replay_revision_id = ${run.replay_revision_id} and state = 'published'
      for update
    `;
    if (prior) {
      await tx`
        update chess.materialization_runs set state = 'superseded', published_at = null
        where id = ${prior.id}
      `;
    }
    await tx`
      update chess.materialization_runs set state = 'published', published_at = now()
      where id = ${runId}
    `;
    return {
      published: true,
      supersededRunId: prior?.id ?? null,
      checksumChanged: Boolean(prior && prior.checksum !== run.checksum),
    };
  });
}

export interface OccurrenceHit {
  runId: string;
  ply: number;
  fen: string;
  repetitionCount: number;
  halfmoveClock: number;
}

/**
 * Every published occurrence of an exact position, keyset-paginated.
 *
 * Ordered by (run_id, ply), which is the trailing half of `occurrences_by_core`,
 * so the index serves both the lookup and the page boundary. Only published
 * runs are visible: a half-built chain is not evidence.
 */
export async function findExactPosition(
  sql: Sql,
  coreKeyHash: string,
  after?: { runId: string; ply: number } | null,
  limit = 50,
): Promise<OccurrenceHit[]> {
  const rows = await sql<
    { run_id: string; ply: number; fen: string; repetition_count: number; halfmove_clock: number }[]
  >`
    select o.run_id, o.ply, o.fen, o.repetition_count, o.halfmove_clock
    from chess.position_occurrences o
    join chess.core_positions c on c.id = o.core_position_id
    join chess.materialization_runs r on r.id = o.run_id
    where c.core_key_hash = ${coreKeyHash}
      and r.state = 'published'
      ${
        after
          ? sql`and (o.run_id, o.ply) > (${after.runId}::uuid, ${after.ply})`
          : sql``
      }
    order by o.run_id, o.ply
    limit ${limit}
  `;
  return rows.map((row) => ({
    runId: row.run_id,
    ply: row.ply,
    fen: row.fen,
    repetitionCount: row.repetition_count,
    halfmoveClock: row.halfmove_clock,
  }));
}

/** Rebuild and compare without publishing: the check before a pointer switch. */
export async function compareRebuild(
  sql: Sql,
  replayRevisionId: string,
  replay: ReplayInput,
): Promise<{ matches: boolean; publishedChecksum: string | null; rebuiltChecksum: string }> {
  const rebuilt: MaterializedReplay = materializeReplay(replay);
  const [published] = await sql<{ checksum: string }[]>`
    select checksum from chess.materialization_runs
    where replay_revision_id = ${replayRevisionId} and state = 'published'
  `;
  return {
    matches: Boolean(published) && published.checksum === rebuilt.checksum,
    publishedChecksum: published?.checksum ?? null,
    rebuiltChecksum: rebuilt.checksum,
  };
}

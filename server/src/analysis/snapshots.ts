/**
 * Cohort definitions, and freezing the games a subject analysis actually used.
 *
 * A snapshot is the answer to "which games is this claim about", written down
 * once and never edited. It pins each game's exact replay revision *and* the
 * exact materialization run the analysis will read, which is what survives a
 * provider correction: the corrected game becomes a new revision, the old
 * snapshot still names the old one, and the baseline computed from it still
 * means what it meant.
 *
 * Selection is a versioned rule, not a query someone tuned. The cohort
 * definition is immutable and hashed, so "minimum 50 games" changing is a new
 * cohort version rather than a silent shift in what every dashboard compares
 * against.
 *
 * Two rules here are worth stating because getting them backwards produces
 * false claims. Unknown is not yes: a cohort that wants rated games excludes a
 * game whose `rated` is null rather than assuming it. And a cohort that cannot
 * reach its minimum still freezes — it is marked under-covered, because
 * refusing to freeze would hide the shortfall instead of reporting it.
 */

import type { Sql } from "postgres";
import type { Queryable } from "../db/queryable.js";
import {
  cohortDefinitionHash,
  cohortDefinitionSchema,
  snapshotHash,
  type CohortDefinition,
  type SnapshotGameEntry,
} from "./contract.js";

export interface RegisteredCohortVersion {
  id: string;
  definitionHash: string;
  alreadyRegistered: boolean;
}

/** Validate, hash and freeze a cohort definition. Idempotent by hash. */
export async function registerCohortVersion(
  sql: Sql,
  input: { cohortKey: string; version: string; definition: CohortDefinition },
): Promise<RegisteredCohortVersion> {
  const definition = cohortDefinitionSchema.parse(input.definition);
  const definitionHash = cohortDefinitionHash(definition);

  const [existing] = await sql<{ id: string }[]>`
    select id from analysis.cohort_definition_versions where definition_hash = ${definitionHash}
  `;
  if (existing) return { id: existing.id, definitionHash, alreadyRegistered: true };

  const [row] = await sql<{ id: string }[]>`
    insert into analysis.cohort_definition_versions (cohort_key, version, definition, definition_hash)
    values (${input.cohortKey}, ${input.version}, ${sql.json(definition as never)}, ${definitionHash})
    returning id
  `;
  return { id: row.id, definitionHash, alreadyRegistered: false };
}

export async function readCohortDefinition(
  sql: Queryable,
  cohortVersionId: string,
): Promise<{ definition: CohortDefinition; definitionHash: string } | null> {
  const [row] = await sql<{ definition: unknown; definition_hash: string }[]>`
    select definition, definition_hash from analysis.cohort_definition_versions
    where id = ${cohortVersionId}
  `;
  if (!row) return null;
  return {
    definition: cohortDefinitionSchema.parse(row.definition),
    definitionHash: row.definition_hash,
  };
}

export interface EligibleGame extends SnapshotGameEntry {
  playedAt: string;
  inclusionReason: string;
}

/**
 * The games a cohort selects for a subject, most recent first.
 *
 * Only games whose materialization is *published* are eligible. That is the
 * difference between analysing a game and analysing a chain that is still being
 * built: an unpublished materialization is not evidence, and including it would
 * let a snapshot pin something that may never become current.
 *
 * Every predicate is expressed so that unknown fails it. `rated = true` excludes
 * a null; `speed = any(...)` excludes a null; a clock requirement excludes a
 * replay with no clock data rather than treating absence as compliance.
 */
export async function selectCohortGames(
  sql: Queryable,
  subjectId: string,
  definition: CohortDefinition,
  cutoff: string,
): Promise<EligibleGame[]> {
  const rows = await sql<
    {
      subject_game_id: string;
      replay_revision_id: string;
      materialization_run_id: string;
      played_at: string;
    }[]
  >`
    select sg.id as subject_game_id,
           rev.id as replay_revision_id,
           mr.id as materialization_run_id,
           rev.played_at
    from chess.subject_games sg
    join chess.game_replay_revisions rev on rev.id = sg.latest_replay_revision_id
    join chess.provider_games pg on pg.id = sg.provider_game_id
    join app.providers p on p.id = pg.provider_id
    join chess.materialization_runs mr
      on mr.replay_revision_id = rev.id and mr.state = 'published'
    where sg.subject_id = ${subjectId}
      and sg.status = 'included'
      and rev.played_at <= ${cutoff}::timestamptz
      ${
        definition.providers
          ? sql`and p.slug = any(${definition.providers as string[]}::text[])`
          : sql``
      }
      ${definition.rated === "rated" ? sql`and rev.rated is true` : sql``}
      ${definition.rated === "casual" ? sql`and rev.rated is false` : sql``}
      ${definition.speeds ? sql`and rev.speed = any(${definition.speeds as string[]}::text[])` : sql``}
      ${definition.playedFrom ? sql`and rev.played_at >= ${definition.playedFrom}::timestamptz` : sql``}
      ${definition.playedTo ? sql`and rev.played_at <= ${definition.playedTo}::timestamptz` : sql``}
      ${
        definition.includeBotOpponents
          ? sql``
          : sql`and not exists (
              select 1 from chess.game_revision_participants gp
              where gp.replay_revision_id = rev.id and gp.is_bot is true
            )`
      }
      ${
        definition.requireClocks
          ? sql`and exists (
              select 1 from chess.position_transitions t
              where t.run_id = mr.id and t.clock_ms is not null
            )`
          : sql``
      }
      ${
        definition.ratingMin != null || definition.ratingMax != null
          ? sql`and exists (
              select 1 from chess.game_revision_participants gp
              where gp.replay_revision_id = rev.id
                and gp.color = sg.subject_color
                and gp.rating is not null
                ${definition.ratingMin != null ? sql`and gp.rating >= ${definition.ratingMin}` : sql``}
                ${definition.ratingMax != null ? sql`and gp.rating <= ${definition.ratingMax}` : sql``}
            )`
          : sql``
      }
    order by rev.played_at desc, sg.id desc
    ${definition.maxGames != null ? sql`limit ${definition.maxGames}` : sql``}
  `;
  return rows.map((row) => ({
    subjectGameId: row.subject_game_id,
    replayRevisionId: String(row.replay_revision_id),
    materializationRunId: row.materialization_run_id,
    weight: null,
    playedAt: new Date(row.played_at).toISOString(),
    inclusionReason: "cohort_match",
  }));
}

export interface FrozenSnapshot {
  id: string;
  snapshotHash: string;
  gameCount: number;
  underCovered: boolean;
  earliestPlayedAt: string | null;
  latestPlayedAt: string | null;
  /** True when an identical snapshot already existed. */
  alreadyFrozen: boolean;
}

/**
 * Freeze the manifest for one subject, cohort and cutoff.
 *
 * Idempotent by content: the same subject, cohort, cutoff and resulting game set
 * produce the same hash, and the unique index makes recomputing return the
 * existing snapshot rather than a duplicate with a new id. That matters because
 * a snapshot id is what a run pins — two ids for one manifest would make two
 * runs look incomparable when they are identical.
 */
export async function freezeSubjectSnapshot(
  sql: Sql,
  input: { subjectId: string; cohortVersionId: string; cutoff: string },
): Promise<FrozenSnapshot> {
  const cohort = await readCohortDefinition(sql, input.cohortVersionId);
  if (!cohort) throw new Error("no such cohort definition version");

  const cutoff = new Date(input.cutoff).toISOString();
  const games = await selectCohortGames(sql, input.subjectId, cohort.definition, cutoff);
  const hash = snapshotHash({
    subjectId: input.subjectId,
    cohortDefinitionHash: cohort.definitionHash,
    cutoff,
    games,
  });

  const [existing] = await sql<{ id: string; game_count: number; under_covered: boolean }[]>`
    select id, game_count, under_covered from analysis.subject_data_snapshots
    where subject_id = ${input.subjectId}
      and cohort_definition_version_id = ${input.cohortVersionId}
      and cutoff = ${cutoff}::timestamptz
      and snapshot_hash = ${hash}
  `;
  const played = games.map((game) => game.playedAt).sort();
  const earliest = played.at(0) ?? null;
  const latest = played.at(-1) ?? null;
  if (existing) {
    return {
      id: existing.id,
      snapshotHash: hash,
      gameCount: existing.game_count,
      underCovered: existing.under_covered,
      earliestPlayedAt: earliest,
      latestPlayedAt: latest,
      alreadyFrozen: true,
    };
  }

  const underCovered = games.length < cohort.definition.minGames;

  return sql.begin(async (tx) => {
    const [snapshot] = await tx<{ id: string }[]>`
      insert into analysis.subject_data_snapshots (
        subject_id, cohort_definition_version_id, cutoff, snapshot_hash, game_count,
        earliest_played_at, latest_played_at, under_covered
      ) values (
        ${input.subjectId}, ${input.cohortVersionId}, ${cutoff}::timestamptz, ${hash},
        ${games.length}, ${earliest}, ${latest}, ${underCovered}
      )
      returning id
    `;
    if (games.length > 0) {
      // One statement, not one per game. A 1,000-game subject is the shape
      // database architecture §34 asks the fixtures to be, and a round trip per
      // row would put the freeze budget out of reach for a reason that has
      // nothing to do with the work being done.
      const rows = games.map((game) => ({
        snapshot_id: snapshot.id,
        subject_game_id: game.subjectGameId,
        replay_revision_id: game.replayRevisionId,
        materialization_run_id: game.materializationRunId,
        inclusion_reason: game.inclusionReason,
        weight: game.weight,
      }));
      await tx`insert into analysis.subject_data_snapshot_games ${tx(rows)}`;
    }
    return {
      id: snapshot.id,
      snapshotHash: hash,
      gameCount: games.length,
      underCovered,
      earliestPlayedAt: earliest,
      latestPlayedAt: latest,
      alreadyFrozen: false,
    };
  });
}

/** The frozen manifest, in the order the hash was computed over. */
export async function readSnapshotManifest(
  sql: Queryable,
  snapshotId: string,
): Promise<SnapshotGameEntry[]> {
  const rows = await sql<
    {
      subject_game_id: string;
      replay_revision_id: string;
      materialization_run_id: string;
      weight: number | null;
    }[]
  >`
    select subject_game_id, replay_revision_id, materialization_run_id, weight
    from analysis.subject_data_snapshot_games
    where snapshot_id = ${snapshotId}
    order by subject_game_id
  `;
  return rows.map((row) => ({
    subjectGameId: row.subject_game_id,
    replayRevisionId: String(row.replay_revision_id),
    materializationRunId: row.materialization_run_id,
    weight: row.weight,
  }));
}

/**
 * Recompute a stored snapshot's hash from its own manifest.
 *
 * The reconciliation check: if this disagrees with the stored value, something
 * wrote to a frozen manifest, and the immutability triggers should have made
 * that impossible. It is cheap enough to run over a whole subject, so a drift
 * is detectable rather than merely prevented.
 */
export async function verifySnapshotHash(
  sql: Queryable,
  snapshotId: string,
): Promise<{ matches: boolean; stored: string; recomputed: string }> {
  const [snapshot] = await sql<
    { subject_id: string; cutoff: string; snapshot_hash: string; cohort_definition_version_id: string }[]
  >`
    select subject_id, cutoff, snapshot_hash, cohort_definition_version_id
    from analysis.subject_data_snapshots where id = ${snapshotId}
  `;
  if (!snapshot) throw new Error("no such snapshot");
  const cohort = await readCohortDefinition(sql, snapshot.cohort_definition_version_id);
  if (!cohort) throw new Error("snapshot cites an unknown cohort definition version");
  const recomputed = snapshotHash({
    subjectId: snapshot.subject_id,
    cohortDefinitionHash: cohort.definitionHash,
    cutoff: new Date(snapshot.cutoff).toISOString(),
    games: await readSnapshotManifest(sql, snapshotId),
  });
  return { matches: recomputed === snapshot.snapshot_hash, stored: snapshot.snapshot_hash, recomputed };
}

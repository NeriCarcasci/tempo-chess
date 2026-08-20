/**
 * Atomic publication: moving a pointer, and being able to move it back.
 *
 * Database architecture §13.4 states the transaction and this file is it: take
 * the target's lock, verify the candidate run succeeded and carries every
 * declared artifact, verify its scope really is this target's, append history,
 * replace the pointer, commit once. A reader therefore sees either the complete
 * old run or the complete new run, and never a target pointing at a run whose
 * outputs are half written.
 *
 * The verification is not a formality. `publish` refuses a running run, a failed
 * run, a run of the wrong type, a run belonging to another subject, and a run
 * whose artifact manifest no longer covers what its recipe declared. Each
 * refusal names a code, because "publication failed" is not an operational
 * answer.
 *
 * Rollback is a forward append. It reads which run the current pointer displaced
 * and publishes that one again with reason `rollback`, so the history says a
 * rollback happened rather than losing the fact by deleting a row. There is no
 * code path in this file that updates or deletes a history row — the triggers in
 * 0022 refuse it, so a mistake is a failed statement rather than a lost fact.
 */

import type { Sql } from "postgres";
import type { Queryable } from "../db/queryable.js";
import type { VersionBlock } from "../v1/envelope.js";
import { assessManifest, PUBLICATION_RUN_TYPE, type PublicationReason } from "./contract.js";
import { recordAnalysisEvent } from "./telemetry.js";

export interface PublicationActor {
  kind: "user" | "system";
  id?: string | null;
}

export interface PublishInput {
  runId: string;
  reason: PublicationReason;
  actor: PublicationActor;
  traceId?: string | null;
}

export interface PublishResult {
  published: boolean;
  publicationId: string | null;
  previousRunId: string | null;
  /** Set when publication was refused. Stable, safe to return to an operator. */
  refusedCode: PublicationRefusal | null;
  detail: string | null;
}

export type PublicationRefusal =
  | "RUN_NOT_FOUND"
  | "RUN_NOT_SUCCEEDED"
  | "RUN_TYPE_MISMATCH"
  | "SCOPE_MISMATCH"
  | "MANIFEST_INCOMPLETE"
  | "ALREADY_PUBLISHED"
  | "NOTHING_TO_ROLL_BACK";

interface CandidateRun {
  id: string;
  run_type: string;
  status: string;
  subject_id: string;
  subject_game_id: string | null;
  replay_revision_id: string | null;
  subject_data_snapshot_id: string | null;
  recipe_version_id: string;
  required_artifacts: string[];
}

async function loadCandidate(tx: Queryable, runId: string): Promise<CandidateRun | null> {
  const [row] = await tx<CandidateRun[]>`
    select r.id, r.run_type, r.status, r.subject_id, r.subject_game_id, r.replay_revision_id,
           r.subject_data_snapshot_id, r.recipe_version_id, rv.required_artifacts
    from analysis.runs r
    join analysis.recipe_versions rv on rv.id = r.recipe_version_id
    where r.id = ${runId}
    for update of r
  `;
  return row ?? null;
}

/**
 * Re-check the manifest at publication time.
 *
 * `completeRun` already checked it, so this looks redundant. It is not: the run
 * became succeeded at some earlier moment, and what publication is about to
 * promise is that the outputs are *there now*. Reading the artifact rows again
 * inside the publishing transaction is the difference between trusting a status
 * column and verifying the thing the status is about.
 */
async function manifestGap(tx: Queryable, run: CandidateRun): Promise<string[]> {
  const produced = await tx<{ family: string; row_count: number; checksum: string }[]>`
    select family, row_count, checksum from analysis.run_artifacts where run_id = ${run.id}
  `;
  const assessment = assessManifest(
    run.required_artifacts,
    produced.map((row) => ({ family: row.family, count: row.row_count, checksum: row.checksum })),
  );
  return [...assessment.missing, ...assessment.undeclared];
}

/** Serialize every switch for one target, including the first one. */
async function lockTarget(tx: Queryable, namespace: number, key: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(${namespace}::int, hashtext(${key})::int)`;
}

// ---------------------------------------------------------------------------
// Subject live publication
// ---------------------------------------------------------------------------

/**
 * Make one subject-live run the current one.
 *
 * The subject is taken from the run, never from the caller: there is no
 * argument on this function that lets a caller publish run A onto subject B,
 * which is the shape of mistake that turns an authorization check into a
 * suggestion.
 */
export async function publishSubjectLive(sql: Sql, input: PublishInput): Promise<PublishResult> {
  const startedAt = Date.now();
  const result = await sql.begin(async (tx) => {
    const run = await loadCandidate(tx, input.runId);
    if (!run) return refuse("RUN_NOT_FOUND", "no such run");
    await lockTarget(tx, 1, run.subject_id);

    const guard = await guardCandidate(tx, run, PUBLICATION_RUN_TYPE.subject_live);
    if (guard) return guard;

    const [current] = await tx<{ run_id: string }[]>`
      select run_id from analysis.subject_live_publications
      where subject_id = ${run.subject_id} for update
    `;
    if (current?.run_id === run.id) {
      return refuse("ALREADY_PUBLISHED", "this run is already the current publication");
    }

    const [history] = await tx<{ id: string }[]>`
      insert into analysis.subject_live_publication_history (
        subject_id, previous_run_id, run_id, reason, actor_kind, actor_id
      ) values (
        ${run.subject_id}, ${current?.run_id ?? null}, ${run.id},
        ${current ? input.reason : "first_publication"},
        ${input.actor.kind}, ${input.actor.id ?? null}
      )
      returning id
    `;
    await tx`
      insert into analysis.subject_live_publications (
        subject_id, run_id, publication_id, subject_data_snapshot_id, recipe_version_id, published_at
      ) values (
        ${run.subject_id}, ${run.id}, ${history.id}, ${run.subject_data_snapshot_id!},
        ${run.recipe_version_id}, now()
      )
      on conflict (subject_id) do update set
        run_id = excluded.run_id,
        publication_id = excluded.publication_id,
        subject_data_snapshot_id = excluded.subject_data_snapshot_id,
        recipe_version_id = excluded.recipe_version_id,
        published_at = excluded.published_at
    `;
    return {
      published: true,
      publicationId: history.id,
      previousRunId: current?.run_id ?? null,
      refusedCode: null,
      detail: null,
    } satisfies PublishResult;
  });

  recordAnalysisEvent({
    event: "publication_switch",
    traceId: input.traceId ?? null,
    target: "subject_live",
    publicationId: result.publicationId,
    runId: input.runId,
    previousRunId: result.previousRunId,
    reason: input.reason,
    durationMs: Date.now() - startedAt,
    refusedCode: result.refusedCode,
  });
  return result;
}

/**
 * Restore the run the current live publication displaced.
 *
 * Not a delete and not an update: another history row, pointing back. The
 * displaced run is read from the history row that installed the current
 * pointer, so rollback follows the recorded chain rather than guessing at
 * "the previous one by time".
 */
export async function rollbackSubjectLive(
  sql: Sql,
  input: { subjectId: string; actor: PublicationActor; traceId?: string | null },
): Promise<PublishResult> {
  const [current] = await sql<{ publication_id: string; run_id: string }[]>`
    select publication_id, run_id from analysis.subject_live_publications
    where subject_id = ${input.subjectId}
  `;
  if (!current) return refuse("NOTHING_TO_ROLL_BACK", "the subject has no live publication");
  const [installing] = await sql<{ previous_run_id: string | null }[]>`
    select previous_run_id from analysis.subject_live_publication_history
    where id = ${current.publication_id}
  `;
  if (!installing?.previous_run_id) {
    return refuse("NOTHING_TO_ROLL_BACK", "the current publication is the first one");
  }
  return publishSubjectLive(sql, {
    runId: installing.previous_run_id,
    reason: "rollback",
    actor: input.actor,
    traceId: input.traceId ?? null,
  });
}

// ---------------------------------------------------------------------------
// Subject game publication
// ---------------------------------------------------------------------------

export async function publishSubjectGame(sql: Sql, input: PublishInput): Promise<PublishResult> {
  const startedAt = Date.now();
  const result = await sql.begin(async (tx) => {
    const run = await loadCandidate(tx, input.runId);
    if (!run) return refuse("RUN_NOT_FOUND", "no such run");
    await lockTarget(tx, 2, run.subject_game_id ?? run.id);

    const guard = await guardCandidate(tx, run, PUBLICATION_RUN_TYPE.subject_game);
    if (guard) return guard;

    const [current] = await tx<{ run_id: string }[]>`
      select run_id from analysis.subject_game_publications
      where subject_game_id = ${run.subject_game_id!} for update
    `;
    if (current?.run_id === run.id) {
      return refuse("ALREADY_PUBLISHED", "this run is already the current publication");
    }

    const [history] = await tx<{ id: string }[]>`
      insert into analysis.subject_game_publication_history (
        subject_game_id, previous_run_id, run_id, reason, actor_kind, actor_id
      ) values (
        ${run.subject_game_id!}, ${current?.run_id ?? null}, ${run.id},
        ${current ? input.reason : "first_publication"},
        ${input.actor.kind}, ${input.actor.id ?? null}
      )
      returning id
    `;
    await tx`
      insert into analysis.subject_game_publications (
        subject_game_id, run_id, publication_id, replay_revision_id, recipe_version_id, published_at
      ) values (
        ${run.subject_game_id!}, ${run.id}, ${history.id}, ${run.replay_revision_id!},
        ${run.recipe_version_id}, now()
      )
      on conflict (subject_game_id) do update set
        run_id = excluded.run_id,
        publication_id = excluded.publication_id,
        replay_revision_id = excluded.replay_revision_id,
        recipe_version_id = excluded.recipe_version_id,
        published_at = excluded.published_at
    `;
    return {
      published: true,
      publicationId: history.id,
      previousRunId: current?.run_id ?? null,
      refusedCode: null,
      detail: null,
    } satisfies PublishResult;
  });

  recordAnalysisEvent({
    event: "publication_switch",
    traceId: input.traceId ?? null,
    target: "subject_game",
    publicationId: result.publicationId,
    runId: input.runId,
    previousRunId: result.previousRunId,
    reason: input.reason,
    durationMs: Date.now() - startedAt,
    refusedCode: result.refusedCode,
  });
  return result;
}

export async function rollbackSubjectGame(
  sql: Sql,
  input: { subjectGameId: string; actor: PublicationActor; traceId?: string | null },
): Promise<PublishResult> {
  const [current] = await sql<{ publication_id: string }[]>`
    select publication_id from analysis.subject_game_publications
    where subject_game_id = ${input.subjectGameId}
  `;
  if (!current) return refuse("NOTHING_TO_ROLL_BACK", "the game has no publication");
  const [installing] = await sql<{ previous_run_id: string | null }[]>`
    select previous_run_id from analysis.subject_game_publication_history
    where id = ${current.publication_id}
  `;
  if (!installing?.previous_run_id) {
    return refuse("NOTHING_TO_ROLL_BACK", "the current publication is the first one");
  }
  return publishSubjectGame(sql, {
    runId: installing.previous_run_id,
    reason: "rollback",
    actor: input.actor,
    traceId: input.traceId ?? null,
  });
}

// ---------------------------------------------------------------------------
// Shared verification
// ---------------------------------------------------------------------------

function refuse(code: PublicationRefusal, detail: string): PublishResult {
  return { published: false, publicationId: null, previousRunId: null, refusedCode: code, detail };
}

async function guardCandidate(
  tx: Queryable,
  run: CandidateRun,
  expectedRunType: string,
): Promise<PublishResult | null> {
  if (run.status !== "succeeded") {
    return refuse("RUN_NOT_SUCCEEDED", `a ${run.status} run cannot be published`);
  }
  if (run.run_type !== expectedRunType) {
    return refuse("RUN_TYPE_MISMATCH", `a ${run.run_type} run cannot become a ${expectedRunType} publication`);
  }
  if (expectedRunType === "subject_live" && !run.subject_data_snapshot_id) {
    return refuse("SCOPE_MISMATCH", "a subject live run must pin a snapshot");
  }
  if (expectedRunType === "game_analysis" && (!run.subject_game_id || !run.replay_revision_id)) {
    return refuse("SCOPE_MISMATCH", "a game analysis run must pin a game and a revision");
  }
  const gap = await manifestGap(tx, run);
  if (gap.length > 0) {
    return refuse("MANIFEST_INCOMPLETE", `artifact manifest disagrees with the recipe: ${gap.join(", ")}`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// The version block a claim-bearing read carries
// ---------------------------------------------------------------------------

/**
 * Build the API's `§1.2` version block from a subject's live publication.
 *
 * `policyVersions` is the recipe's roles resolved to `componentKey@version`,
 * which is why the block is worth carrying: a reader can tell that yesterday's
 * dashboard used `estimator@1.2` and today's uses `estimator@1.3` without
 * anyone writing release notes.
 *
 * Returns null rather than a partially filled block when the subject has no
 * publication. A claim-bearing read with no publication has no claim to make.
 */
export async function subjectLiveVersionBlock(
  sql: Sql,
  subjectId: string,
): Promise<VersionBlock | null> {
  const [row] = await sql<
    {
      publication_id: string;
      published_at: string;
      subject_data_snapshot_id: string;
      recipe_version_id: string;
    }[]
  >`
    select publication_id, published_at, subject_data_snapshot_id, recipe_version_id
    from analysis.subject_live_publications where subject_id = ${subjectId}
  `;
  if (!row) return null;
  return {
    publicationId: row.publication_id,
    generatedAt: new Date(row.published_at).toISOString(),
    subjectSnapshotId: row.subject_data_snapshot_id,
    recipeVersionId: row.recipe_version_id,
    policyVersions: await policyVersionsOf(sql, row.recipe_version_id),
  };
}

/**
 * The same block for one game's published analysis.
 *
 * `subjectSnapshotId` is null and that is correct rather than missing: a game
 * analysis is scoped to a replay revision, not to a subject snapshot, and
 * inventing one here would attach a claim to evidence it was not built from.
 */
export async function subjectGameVersionBlock(
  sql: Sql,
  subjectGameId: string,
): Promise<VersionBlock | null> {
  const [row] = await sql<{ publication_id: string; published_at: string; recipe_version_id: string }[]>`
    select publication_id, published_at, recipe_version_id
    from analysis.subject_game_publications where subject_game_id = ${subjectGameId}
  `;
  if (!row) return null;
  return {
    publicationId: row.publication_id,
    generatedAt: new Date(row.published_at).toISOString(),
    subjectSnapshotId: null,
    recipeVersionId: row.recipe_version_id,
    policyVersions: await policyVersionsOf(sql, row.recipe_version_id),
  };
}

async function policyVersionsOf(sql: Queryable, recipeVersionId: string): Promise<Record<string, string>> {
  const rows = await sql<{ role: string; component_key: string; version: string }[]>`
    select rc.role, c.component_key, cv.version
    from analysis.recipe_components rc
    join analysis.component_versions cv on cv.id = rc.component_version_id
    join analysis.components c on c.id = cv.component_id
    where rc.recipe_version_id = ${recipeVersionId}
    order by rc.role
  `;
  return Object.fromEntries(rows.map((row) => [row.role, `${row.component_key}@${row.version}`]));
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface PublicationHistoryEntry {
  publicationId: string;
  runId: string;
  previousRunId: string | null;
  reason: string;
  actorKind: string;
  publishedAt: string;
}

export async function subjectLiveHistory(
  sql: Sql,
  subjectId: string,
  limit = 50,
): Promise<PublicationHistoryEntry[]> {
  const rows = await sql<
    {
      id: string;
      run_id: string;
      previous_run_id: string | null;
      reason: string;
      actor_kind: string;
      published_at: string;
    }[]
  >`
    select id, run_id, previous_run_id, reason, actor_kind, published_at
    from analysis.subject_live_publication_history
    where subject_id = ${subjectId}
    order by published_at desc, id desc
    limit ${limit}
  `;
  return rows.map(toHistoryEntry);
}

export async function subjectGameHistory(
  sql: Sql,
  subjectGameId: string,
  limit = 50,
): Promise<PublicationHistoryEntry[]> {
  const rows = await sql<
    {
      id: string;
      run_id: string;
      previous_run_id: string | null;
      reason: string;
      actor_kind: string;
      published_at: string;
    }[]
  >`
    select id, run_id, previous_run_id, reason, actor_kind, published_at
    from analysis.subject_game_publication_history
    where subject_game_id = ${subjectGameId}
    order by published_at desc, id desc
    limit ${limit}
  `;
  return rows.map(toHistoryEntry);
}

function toHistoryEntry(row: {
  id: string;
  run_id: string;
  previous_run_id: string | null;
  reason: string;
  actor_kind: string;
  published_at: string;
}): PublicationHistoryEntry {
  return {
    publicationId: row.id,
    runId: row.run_id,
    previousRunId: row.previous_run_id,
    reason: row.reason,
    actorKind: row.actor_kind,
    publishedAt: new Date(row.published_at).toISOString(),
  };
}

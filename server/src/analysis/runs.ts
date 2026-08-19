/**
 * Planning, running and completing an analysis run.
 *
 * The load-bearing idea is that "succeeded" is earned, not declared. A run
 * reaches `succeeded` only when its recorded artifact manifest covers exactly
 * the output families its recipe promised — no missing family, no undeclared
 * one — and the output manifest hash is written in the same statement as the
 * status. There is no path where a worker exits zero and the run says it
 * produced something it did not, which is what stops a partial run from ever
 * being publishable.
 *
 * Planning is idempotent by input manifest hash, enforced by a partial unique
 * index rather than by a check-then-insert. Two workers racing to plan the same
 * work end up with one run and one of them learning it lost, and a duplicate
 * queue delivery costs a lookup rather than a second set of outputs. A failed
 * or cancelled attempt frees its inputs, so a genuine retry is possible without
 * making duplication possible.
 *
 * Reuse is explicit. A method-only rerun records exactly which upstream runs it
 * carried over and which recipe role each covered, so "we did not recompute the
 * engine output" is auditable instead of assumed.
 */

import type { Sql } from "postgres";
import type { Queryable } from "../db/queryable.js";
import {
  assessManifest,
  outputManifestHash,
  runInputManifestHash,
  scopeViolations,
  type ArtifactManifestEntry,
  type RunScope,
  type RunStatus,
  type RunType,
} from "./contract.js";
import { compareRecipes, readRecipe, recipeRoles } from "./versions.js";

export type TriggerKind = "user_request" | "scheduled" | "backfill" | "promotion" | "shadow";
export type ActorKind = "user" | "system";

export interface RunDependencyInput {
  upstreamRunId: string;
  reusedRole: string;
  upstreamOutputHash: string;
}

export interface PlanRunInput {
  recipeVersionId: string;
  scope: RunScope & { subjectId: string };
  trigger: TriggerKind;
  actor: { kind: ActorKind; id?: string | null };
  /** Upstream runs whose outputs this run reuses instead of recomputing. */
  dependencies?: readonly RunDependencyInput[];
  /** The comparison run, for shadow evaluation. */
  parentRunId?: string | null;
  /** The ledger item that scheduled this run, when there is one. */
  workItemId?: string | null;
}

export interface PlannedRun {
  id: string;
  runType: RunType;
  inputManifestHash: string;
  /** True when identical inputs were already planned, running or succeeded. */
  alreadyPlanned: boolean;
}

/**
 * Register the intent to produce one output contract, with its inputs frozen.
 *
 * Everything the hash covers is supplied here, including the reused upstream
 * outputs, because an input manifest that grows after planning is not a
 * manifest — it is a log. Declaring reuse up front is what makes "the same
 * inputs" answerable before any work starts.
 */
export async function planRun(sql: Sql, input: PlanRunInput): Promise<PlannedRun> {
  const recipe = await readRecipe(sql, input.recipeVersionId);
  if (!recipe) throw new Error("no such recipe version");

  const scope: Required<{ [K in keyof RunScope]: RunScope[K] | null }> = {
    subjectId: input.scope.subjectId,
    subjectGameId: input.scope.subjectGameId ?? null,
    replayRevisionId: input.scope.replayRevisionId ?? null,
    subjectDataSnapshotId: input.scope.subjectDataSnapshotId ?? null,
  };
  const violations = scopeViolations(recipe.runType, scope);
  if (violations.length > 0) throw new Error(violations.join("; "));

  if (recipe.runType === "game_analysis") {
    await assertRevisionBelongsToGame(sql, scope.subjectGameId!, scope.replayRevisionId!);
  }

  const snapshotHashValue = scope.subjectDataSnapshotId
    ? await snapshotHashOf(sql, scope.subjectDataSnapshotId)
    : null;

  const dependencies = input.dependencies ?? [];
  const inputManifestHash = runInputManifestHash({
    runType: recipe.runType,
    recipeManifestHash: recipe.manifestSha256,
    scope,
    snapshotHash: snapshotHashValue,
    dependencyOutputHashes: dependencies.map((dependency) => dependency.upstreamOutputHash),
  });

  const existing = await liveRunForInput(sql, inputManifestHash);
  if (existing) {
    return {
      id: existing,
      runType: recipe.runType,
      inputManifestHash,
      alreadyPlanned: true,
    };
  }

  try {
    return await sql.begin<PlannedRun>(async (tx) => {
      const [run] = await tx<{ id: string }[]>`
        insert into analysis.runs (
          run_type, recipe_version_id, subject_id, subject_game_id, replay_revision_id,
          subject_data_snapshot_id, status, input_manifest_hash, parent_run_id,
          trigger_kind, actor_kind, actor_id, work_item_id
        ) values (
          ${recipe.runType}, ${input.recipeVersionId}, ${scope.subjectId!},
          ${scope.subjectGameId}, ${scope.replayRevisionId}, ${scope.subjectDataSnapshotId},
          'planned', ${inputManifestHash}, ${input.parentRunId ?? null},
          ${input.trigger}, ${input.actor.kind}, ${input.actor.id ?? null},
          ${input.workItemId ?? null}
        )
        returning id
      `;
      for (const dependency of dependencies) {
        await tx`
          insert into analysis.run_dependencies (
            run_id, upstream_run_id, reused_role, upstream_output_hash
          ) values (
            ${run.id}, ${dependency.upstreamRunId}, ${dependency.reusedRole},
            ${dependency.upstreamOutputHash}
          )
        `;
      }
      return { id: run.id, runType: recipe.runType, inputManifestHash, alreadyPlanned: false };
    });
  } catch (error) {
    // Lost the race against another planner. The index is the arbiter, so the
    // loser reads the winner's run rather than retrying and racing again.
    if ((error as { code?: string }).code === "23505") {
      const winner = await liveRunForInput(sql, inputManifestHash);
      if (winner) {
        return { id: winner, runType: recipe.runType, inputManifestHash, alreadyPlanned: true };
      }
    }
    throw error;
  }
}

async function liveRunForInput(sql: Queryable, inputManifestHash: string): Promise<string | null> {
  const [row] = await sql<{ id: string }[]>`
    select id from analysis.runs
    where input_manifest_hash = ${inputManifestHash}
      and status in ('planned', 'running', 'succeeded')
  `;
  return row?.id ?? null;
}

async function snapshotHashOf(sql: Queryable, snapshotId: string): Promise<string> {
  const [row] = await sql<{ snapshot_hash: string }[]>`
    select snapshot_hash from analysis.subject_data_snapshots where id = ${snapshotId}
  `;
  if (!row) throw new Error("no such subject data snapshot");
  return row.snapshot_hash;
}

/**
 * The revision a game analysis pins must be a revision *of that game*.
 *
 * The composite foreign key already proves the game belongs to the subject.
 * Nothing in the schema can express "and this revision belongs to that game"
 * without denormalising the provider game onto the run, so it is checked here
 * and asserted by the integration gate.
 */
async function assertRevisionBelongsToGame(
  sql: Queryable,
  subjectGameId: string,
  replayRevisionId: string,
): Promise<void> {
  const [row] = await sql<{ ok: boolean }[]>`
    select exists (
      select 1
      from chess.subject_games sg
      join chess.game_replay_revisions rev on rev.provider_game_id = sg.provider_game_id
      where sg.id = ${subjectGameId} and rev.id = ${replayRevisionId}
    ) as ok
  `;
  if (!row.ok) throw new Error("replay revision does not belong to the subject game");
}

/** planned -> running. Idempotent: starting a running run is a no-op. */
export async function startRun(sql: Sql, runId: string): Promise<void> {
  const [row] = await sql<{ status: RunStatus }[]>`
    update analysis.runs set status = 'running', started_at = coalesce(started_at, now())
    where id = ${runId} and status = 'planned'
    returning status
  `;
  if (row) return;
  const [current] = await sql<{ status: RunStatus }[]>`
    select status from analysis.runs where id = ${runId}
  `;
  if (!current) throw new Error("no such run");
  if (current.status !== "running") {
    throw new Error(`a ${current.status} run cannot be started`);
  }
}

/**
 * Record one produced output family.
 *
 * Artifact rows are immutable, so a retried step that already wrote its family
 * must produce the identical entry. A different checksum for the same family is
 * a real disagreement about what was produced and is refused rather than
 * silently overwritten.
 */
export async function recordArtifact(
  sql: Sql,
  runId: string,
  entry: ArtifactManifestEntry & { artifactId?: string | null },
): Promise<{ recorded: boolean }> {
  const [existing] = await sql<{ checksum: string; row_count: number }[]>`
    select checksum, row_count from analysis.run_artifacts
    where run_id = ${runId} and family = ${entry.family}
  `;
  if (existing) {
    if (existing.checksum !== entry.checksum || existing.row_count !== entry.count) {
      throw new Error(
        `run ${runId} already recorded a different ${entry.family} manifest; a rerun is a new run`,
      );
    }
    return { recorded: false };
  }
  await sql`
    insert into analysis.run_artifacts (run_id, family, row_count, checksum, artifact_id)
    values (${runId}, ${entry.family}, ${entry.count}, ${entry.checksum}, ${entry.artifactId ?? null})
  `;
  return { recorded: true };
}

export interface RunCompletion {
  status: RunStatus;
  outputManifestHash: string | null;
  missing: string[];
  undeclared: string[];
}

/**
 * Try to succeed a run.
 *
 * The manifest check and the status change are one transaction, so a run cannot
 * be observed as succeeded before its manifest was verified. An incomplete
 * manifest does not throw: it returns the run unchanged with the missing
 * families named, because the caller's next action is to fail the run with a
 * classification, and losing the reason inside an exception message helps
 * nobody.
 */
export async function completeRun(sql: Sql, runId: string): Promise<RunCompletion> {
  return sql.begin(async (tx) => {
    const [run] = await tx<{ status: RunStatus; recipe_version_id: string; output_manifest_hash: string | null }[]>`
      select status, recipe_version_id, output_manifest_hash from analysis.runs
      where id = ${runId} for update
    `;
    if (!run) throw new Error("no such run");
    if (run.status === "succeeded") {
      return {
        status: run.status,
        outputManifestHash: run.output_manifest_hash,
        missing: [],
        undeclared: [],
      };
    }
    if (run.status !== "running" && run.status !== "planned") {
      throw new Error(`a ${run.status} run cannot succeed`);
    }

    const [recipe] = await tx<{ required_artifacts: string[] }[]>`
      select required_artifacts from analysis.recipe_versions where id = ${run.recipe_version_id}
    `;
    const produced = await tx<{ family: string; row_count: number; checksum: string }[]>`
      select family, row_count, checksum from analysis.run_artifacts where run_id = ${runId}
    `;
    const entries: ArtifactManifestEntry[] = produced.map((row) => ({
      family: row.family,
      count: row.row_count,
      checksum: row.checksum,
    }));
    const assessment = assessManifest(recipe.required_artifacts, entries);
    if (!assessment.complete) {
      return {
        status: run.status,
        outputManifestHash: null,
        missing: assessment.missing,
        undeclared: assessment.undeclared,
      };
    }

    const hash = outputManifestHash(entries);
    await tx`
      update analysis.runs
      set status = 'succeeded', output_manifest_hash = ${hash}, completed_at = now(),
          started_at = coalesce(started_at, now())
      where id = ${runId}
    `;
    return { status: "succeeded" as RunStatus, outputManifestHash: hash, missing: [], undeclared: [] };
  });
}

export type FailureClass =
  | "transient"
  | "rate_limit"
  | "invalid_input"
  | "unsupported"
  | "unauthorized"
  | "budget"
  | "permanent";

/** Terminate a run without an output manifest. Its inputs become replannable. */
export async function failRun(sql: Sql, runId: string, failureClass: FailureClass): Promise<void> {
  const [row] = await sql<{ id: string }[]>`
    update analysis.runs
    set status = 'failed', failure_class = ${failureClass}, completed_at = now()
    where id = ${runId} and status in ('planned', 'running')
    returning id
  `;
  if (!row) throw new Error("only a planned or running run can fail");
}

export async function cancelRun(sql: Sql, runId: string): Promise<void> {
  const [row] = await sql<{ id: string }[]>`
    update analysis.runs set status = 'cancelled', completed_at = now()
    where id = ${runId} and status in ('planned', 'running')
    returning id
  `;
  if (!row) throw new Error("only a planned or running run can be cancelled");
}

export interface RunRecord {
  id: string;
  runType: RunType;
  status: RunStatus;
  recipeVersionId: string;
  subjectId: string;
  subjectGameId: string | null;
  replayRevisionId: string | null;
  subjectDataSnapshotId: string | null;
  inputManifestHash: string;
  outputManifestHash: string | null;
  failureClass: string | null;
  createdAt: string;
  completedAt: string | null;
}

export async function readRun(sql: Queryable, runId: string): Promise<RunRecord | null> {
  const [row] = await sql<Record<string, never>[]>`
    select id, run_type, status, recipe_version_id, subject_id, subject_game_id,
           replay_revision_id, subject_data_snapshot_id, input_manifest_hash,
           output_manifest_hash, failure_class, created_at, completed_at
    from analysis.runs where id = ${runId}
  `;
  if (!row) return null;
  const record = row as unknown as Record<string, unknown>;
  return {
    id: record.id as string,
    runType: record.run_type as RunType,
    status: record.status as RunStatus,
    recipeVersionId: record.recipe_version_id as string,
    subjectId: record.subject_id as string,
    subjectGameId: (record.subject_game_id as string | null) ?? null,
    replayRevisionId:
      record.replay_revision_id == null ? null : String(record.replay_revision_id),
    subjectDataSnapshotId: (record.subject_data_snapshot_id as string | null) ?? null,
    inputManifestHash: record.input_manifest_hash as string,
    outputManifestHash: (record.output_manifest_hash as string | null) ?? null,
    failureClass: (record.failure_class as string | null) ?? null,
    createdAt: new Date(record.created_at as string).toISOString(),
    completedAt:
      record.completed_at == null ? null : new Date(record.completed_at as string).toISOString(),
  };
}

/**
 * Which upstream outputs a rerun on the same snapshot may carry over.
 *
 * Compares the previous succeeded run's recipe to the new one and returns one
 * dependency per role that pins the identical component version. A role whose
 * version changed is absent, so it will be recomputed; that is the whole
 * compatibility rule, and it is stated in terms of pinned identity rather than
 * a version-number convention that a careless bump would defeat.
 */
export async function planReuse(
  sql: Sql,
  input: { subjectDataSnapshotId: string; newRecipeVersionId: string },
): Promise<RunDependencyInput[]> {
  const [previous] = await sql<{ id: string; recipe_version_id: string; output_manifest_hash: string }[]>`
    select id, recipe_version_id, output_manifest_hash
    from analysis.runs
    where subject_data_snapshot_id = ${input.subjectDataSnapshotId} and status = 'succeeded'
    order by completed_at desc, id desc
    limit 1
  `;
  if (!previous) return [];
  if (previous.recipe_version_id === input.newRecipeVersionId) return [];

  const [before, after] = await Promise.all([
    recipeRoles(sql, previous.recipe_version_id),
    recipeRoles(sql, input.newRecipeVersionId),
  ]);
  return compareRecipes(before, after).unchanged.map((role) => ({
    upstreamRunId: previous.id,
    reusedRole: role,
    upstreamOutputHash: previous.output_manifest_hash,
  }));
}

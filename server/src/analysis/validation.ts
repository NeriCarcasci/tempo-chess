/**
 * Validation evidence, component lifecycle, and recipe promotion.
 *
 * This is the file that decides what is allowed to become production, and its
 * whole design is one rule from platform spec §12.3 and database architecture
 * §12.10: promotion changes a pointer and must cite evidence. So a component
 * version reaches `validated` or `production` only with a validation run
 * attached, and a recipe becomes the promoted one for a production surface only
 * with a passing validation run against a fixed dataset. Both refusals are also
 * check constraints in 0022, so a call site that forgets cannot succeed.
 *
 * `research_shadow` is the deliberate exception: it is the surface a candidate
 * runs on in order to *acquire* evidence, and requiring evidence to get there
 * would make it unreachable.
 *
 * Nothing here computes a metric. Whether a candidate is better is decided by
 * the method epics that own the measurements; what this file owns is that the
 * decision was recorded, cited, and cannot be quietly reversed.
 */

import type { Sql } from "postgres";
import type { Queryable } from "../db/queryable.js";
import {
  isLifecycleTransitionAllowed,
  type LifecycleState,
  type PromotionSurface,
  type ValidationStatus,
} from "./contract.js";

export interface ValidationDatasetInput {
  datasetKey: string;
  version: string;
  manifestSha256: string;
  artifactId?: string | null;
  samplingDescription: string;
  accountDisjoint: boolean;
  chronologicalSplit: boolean;
  licence?: string | null;
  governanceClass: "public" | "licensed" | "internal" | "restricted";
}

/** Register an immutable corpus. Idempotent by key and version. */
export async function registerValidationDataset(
  sql: Sql,
  input: ValidationDatasetInput,
): Promise<{ id: string; alreadyRegistered: boolean }> {
  const [existing] = await sql<{ id: string; manifest_sha256: string }[]>`
    select id, manifest_sha256 from analysis.validation_datasets
    where dataset_key = ${input.datasetKey} and version = ${input.version}
  `;
  if (existing) {
    if (existing.manifest_sha256 !== input.manifestSha256) {
      throw new Error(
        `validation dataset ${input.datasetKey}@${input.version} already exists with a different manifest`,
      );
    }
    return { id: existing.id, alreadyRegistered: true };
  }
  const [row] = await sql<{ id: string }[]>`
    insert into analysis.validation_datasets (
      dataset_key, version, manifest_sha256, artifact_id, sampling_description,
      account_disjoint, chronological_split, licence, governance_class
    ) values (
      ${input.datasetKey}, ${input.version}, ${input.manifestSha256}, ${input.artifactId ?? null},
      ${input.samplingDescription}, ${input.accountDisjoint}, ${input.chronologicalSplit},
      ${input.licence ?? null}, ${input.governanceClass}
    )
    returning id
  `;
  return { id: row.id, alreadyRegistered: false };
}

export interface ValidationMetricInput {
  metricKey: string;
  /** Provider, rating band, time control, phase, clock availability, concept. */
  slice?: Record<string, string>;
  sampleSize: number;
  value?: number | null;
  intervalLow?: number | null;
  intervalHigh?: number | null;
  /** Supplied instead of a value when the slice could not be measured. */
  unavailableReason?: string | null;
}

export interface ValidationRunInput {
  datasetId: string;
  candidate: { componentVersionId: string } | { recipeVersionId: string };
  baseline?: { componentVersionId?: string | null; recipeVersionId?: string | null } | null;
  executionRevision: string;
  status: ValidationStatus;
  outputChecksum: string;
  summary?: Record<string, unknown>;
  metrics?: readonly ValidationMetricInput[];
}

/**
 * Record one completed evaluation and its metrics.
 *
 * Run and metrics commit together: a validation run whose metrics landed in a
 * later transaction could be cited by a promotion in between, which is exactly
 * the window where "we validated it" means nothing.
 */
export async function recordValidationRun(sql: Sql, input: ValidationRunInput): Promise<string> {
  const candidateComponent = "componentVersionId" in input.candidate ? input.candidate.componentVersionId : null;
  const candidateRecipe = "recipeVersionId" in input.candidate ? input.candidate.recipeVersionId : null;

  return sql.begin(async (tx) => {
    const [run] = await tx<{ id: string }[]>`
      insert into analysis.validation_runs (
        dataset_id, candidate_component_version_id, candidate_recipe_version_id,
        baseline_component_version_id, baseline_recipe_version_id,
        execution_revision, status, output_checksum, summary
      ) values (
        ${input.datasetId}, ${candidateComponent}, ${candidateRecipe},
        ${input.baseline?.componentVersionId ?? null}, ${input.baseline?.recipeVersionId ?? null},
        ${input.executionRevision}, ${input.status}, ${input.outputChecksum},
        ${tx.json((input.summary ?? {}) as never)}
      )
      returning id
    `;
    for (const metric of input.metrics ?? []) {
      await tx`
        insert into analysis.validation_metrics (
          validation_run_id, metric_key, slice, sample_size, value,
          interval_low, interval_high, unavailable_reason
        ) values (
          ${run.id}, ${metric.metricKey}, ${tx.json((metric.slice ?? {}) as never)},
          ${metric.sampleSize}, ${metric.value ?? null}, ${metric.intervalLow ?? null},
          ${metric.intervalHigh ?? null}, ${metric.unavailableReason ?? null}
        )
      `;
    }
    return run.id;
  });
}

// ---------------------------------------------------------------------------
// Component lifecycle
// ---------------------------------------------------------------------------

export async function currentLifecycleState(
  sql: Queryable,
  componentVersionId: string,
): Promise<LifecycleState | null> {
  const [row] = await sql<{ to_state: LifecycleState }[]>`
    select to_state from analysis.component_lifecycle_events
    where component_version_id = ${componentVersionId}
    order by id desc limit 1
  `;
  return row?.to_state ?? null;
}

export interface LifecycleTransitionInput {
  componentVersionId: string;
  to: LifecycleState;
  reason: string;
  actor: { kind: "user" | "system"; id?: string | null };
  validationRunId?: string | null;
}

/**
 * Move a component version through its lifecycle by appending an event.
 *
 * The immutable version row never changes; the current state is the latest
 * event. Both the legal transitions and the evidence requirement are checked
 * here for a clear message and enforced by constraints underneath, so the two
 * cannot drift apart into a rule that only one layer believes.
 */
export async function recordLifecycleTransition(
  sql: Sql,
  input: LifecycleTransitionInput,
): Promise<{ from: LifecycleState | null; to: LifecycleState }> {
  return sql.begin(async (tx) => {
    // Serialize concurrent transitions of one version, so two operators cannot
    // both read `shadow` and both append a move away from it.
    await tx`select pg_advisory_xact_lock(3::int, hashtext(${input.componentVersionId})::int)`;
    const from = await currentLifecycleState(tx, input.componentVersionId);
    if (from === null && input.to !== "draft") {
      throw new Error("a component version enters its lifecycle at draft");
    }
    if (from !== null && !isLifecycleTransitionAllowed(from, input.to)) {
      throw new Error(`a component version cannot move from ${from} to ${input.to}`);
    }
    if ((input.to === "validated" || input.to === "production") && !input.validationRunId) {
      throw new Error(`moving to ${input.to} requires the validation run that justifies it`);
    }
    if (input.validationRunId) {
      await assertValidationCoversComponent(tx, input.validationRunId, input.componentVersionId);
    }
    await tx`
      insert into analysis.component_lifecycle_events (
        component_version_id, from_state, to_state, validation_run_id, actor_kind, actor_id, reason
      ) values (
        ${input.componentVersionId}, ${from}, ${input.to}, ${input.validationRunId ?? null},
        ${input.actor.kind}, ${input.actor.id ?? null}, ${input.reason}
      )
    `;
    return { from, to: input.to };
  });
}

/**
 * The cited evidence must be about the thing being promoted.
 *
 * Without this, a passing validation of some other component would satisfy the
 * constraint: the column would be non-null and the promotion would look
 * evidenced. Requiring the candidate to match is what makes the citation mean
 * something.
 */
async function assertValidationCoversComponent(
  tx: Queryable,
  validationRunId: string,
  componentVersionId: string,
): Promise<void> {
  const [row] = await tx<{ candidate_component_version_id: string | null; status: string }[]>`
    select candidate_component_version_id, status from analysis.validation_runs
    where id = ${validationRunId}
  `;
  if (!row) throw new Error("no such validation run");
  if (row.candidate_component_version_id !== componentVersionId) {
    throw new Error("the cited validation run evaluated a different component version");
  }
  if (row.status !== "passed") {
    throw new Error(`the cited validation run ${row.status}; only a passing run justifies promotion`);
  }
}

// ---------------------------------------------------------------------------
// Recipe promotion
// ---------------------------------------------------------------------------

export interface PromoteRecipeInput {
  surface: PromotionSurface;
  recipeVersionId: string;
  reason: string;
  actor: { kind: "user" | "system"; id?: string | null };
  validationRunId?: string | null;
}

/** The recipe a surface currently uses, or null before its first promotion. */
export async function currentRecipeFor(
  sql: Queryable,
  surface: PromotionSurface,
): Promise<{ recipeVersionId: string; promotionId: string; promotedAt: string } | null> {
  const [row] = await sql<{ id: string; recipe_version_id: string; promoted_at: string }[]>`
    select id, recipe_version_id, promoted_at from analysis.recipe_promotions
    where surface = ${surface}
    order by id desc limit 1
  `;
  if (!row) return null;
  return {
    recipeVersionId: row.recipe_version_id,
    promotionId: String(row.id),
    promotedAt: new Date(row.promoted_at).toISOString(),
  };
}

/**
 * Select a recipe for a surface.
 *
 * This changes what *new* runs use. It does not touch an existing run, a
 * publication or a baseline: those pinned their recipe version when they were
 * created, and this row cannot reach them. That separation is the reason
 * promotion is safe to do at any time.
 */
export async function promoteRecipe(
  sql: Sql,
  input: PromoteRecipeInput,
): Promise<{ promotionId: string; previousRecipeVersionId: string | null }> {
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(4::int, hashtext(${input.surface})::int)`;
    const current = await currentRecipeFor(tx, input.surface);
    if (current?.recipeVersionId === input.recipeVersionId) {
      throw new Error(`${input.surface} already uses this recipe version`);
    }
    if (input.surface !== "research_shadow") {
      if (!input.validationRunId) {
        throw new Error(`promoting to ${input.surface} requires the validation run that justifies it`);
      }
      await assertValidationCoversRecipe(tx, input.validationRunId, input.recipeVersionId);
    }
    const [row] = await tx<{ id: string }[]>`
      insert into analysis.recipe_promotions (
        surface, recipe_version_id, previous_recipe_version_id, validation_run_id,
        actor_kind, actor_id, reason
      ) values (
        ${input.surface}, ${input.recipeVersionId}, ${current?.recipeVersionId ?? null},
        ${input.validationRunId ?? null}, ${input.actor.kind}, ${input.actor.id ?? null},
        ${input.reason}
      )
      returning id
    `;
    return { promotionId: String(row.id), previousRecipeVersionId: current?.recipeVersionId ?? null };
  });
}

async function assertValidationCoversRecipe(
  tx: Queryable,
  validationRunId: string,
  recipeVersionId: string,
): Promise<void> {
  const [row] = await tx<{ candidate_recipe_version_id: string | null; status: string }[]>`
    select candidate_recipe_version_id, status from analysis.validation_runs
    where id = ${validationRunId}
  `;
  if (!row) throw new Error("no such validation run");
  if (row.candidate_recipe_version_id !== recipeVersionId) {
    throw new Error("the cited validation run evaluated a different recipe version");
  }
  if (row.status !== "passed") {
    throw new Error(`the cited validation run ${row.status}; only a passing run justifies promotion`);
  }
}

export interface PromotionHistoryEntry {
  promotionId: string;
  recipeVersionId: string;
  previousRecipeVersionId: string | null;
  validationRunId: string | null;
  actorKind: string;
  reason: string;
  promotedAt: string;
}

export async function promotionHistory(
  sql: Sql,
  surface: PromotionSurface,
  limit = 50,
): Promise<PromotionHistoryEntry[]> {
  const rows = await sql<
    {
      id: string;
      recipe_version_id: string;
      previous_recipe_version_id: string | null;
      validation_run_id: string | null;
      actor_kind: string;
      reason: string;
      promoted_at: string;
    }[]
  >`
    select id, recipe_version_id, previous_recipe_version_id, validation_run_id,
           actor_kind, reason, promoted_at
    from analysis.recipe_promotions
    where surface = ${surface}
    order by id desc limit ${limit}
  `;
  return rows.map((row) => ({
    promotionId: String(row.id),
    recipeVersionId: row.recipe_version_id,
    previousRecipeVersionId: row.previous_recipe_version_id,
    validationRunId: row.validation_run_id,
    actorKind: row.actor_kind,
    reason: row.reason,
    promotedAt: new Date(row.promoted_at).toISOString(),
  }));
}

/**
 * Roll a surface back to the recipe it used before the current promotion.
 *
 * Another append, exactly like publication rollback: the history keeps saying
 * that a promotion happened and was reversed, rather than pretending it never
 * did. The rollback carries the same validation evidence the earlier promotion
 * carried, because that is the evidence for the version being restored.
 */
export async function rollbackRecipePromotion(
  sql: Sql,
  input: { surface: PromotionSurface; reason: string; actor: { kind: "user" | "system"; id?: string | null } },
): Promise<{ promotionId: string; recipeVersionId: string }> {
  const [current] = await sql<
    { id: string; previous_recipe_version_id: string | null }[]
  >`
    select id, previous_recipe_version_id from analysis.recipe_promotions
    where surface = ${input.surface} order by id desc limit 1
  `;
  if (!current) throw new Error(`${input.surface} has no promotion to roll back`);
  if (!current.previous_recipe_version_id) {
    throw new Error(`${input.surface} is on its first promotion; there is nothing to roll back to`);
  }
  const target = current.previous_recipe_version_id;
  const [evidence] = await sql<{ validation_run_id: string | null }[]>`
    select validation_run_id from analysis.recipe_promotions
    where surface = ${input.surface} and recipe_version_id = ${target}
    order by id desc limit 1
  `;
  const result = await promoteRecipe(sql, {
    surface: input.surface,
    recipeVersionId: target,
    reason: input.reason,
    actor: input.actor,
    validationRunId: evidence?.validation_run_id ?? null,
  });
  return { promotionId: result.promotionId, recipeVersionId: target };
}

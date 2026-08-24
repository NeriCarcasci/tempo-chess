/**
 * Registering components, versions and recipes, and validating what they pin.
 *
 * Registration is idempotent by content hash rather than by name. That is the
 * whole trick: a retry after a transport failure finds the row it already made
 * instead of forking a second "version 3" with different bytes in it, and two
 * deployments that registered the same implementation independently agree they
 * are talking about the same version.
 *
 * Validation answers two questions the database cannot answer alone. Cycles are
 * refused at insert by a trigger, so the walk here is a confirmation rather than
 * the only guard; contract compatibility is not — a dependency edge declares the
 * contract it needs, and if the component it points at emits something else, the
 * recipe is rejected before any run is planned rather than after one produced
 * output nobody can interpret.
 */

import type { Sql } from "postgres";
import type { Queryable } from "../db/queryable.js";
import {
  componentVersionHash,
  configurationHash,
  recipeManifestHash,
  type ComponentCategory,
  type RunType,
} from "./contract.js";
import { jsonParam } from "../db/json.js";

export interface ComponentInput {
  componentKey: string;
  category: ComponentCategory;
  description: string;
  inputContract: string;
  outputContract: string;
}

/**
 * Ensure the catalogue row exists and return its id.
 *
 * The catalogue is immutable, so re-registering with different attributes is a
 * conflict rather than an update: a component whose output contract changed is
 * a different component, and quietly rewriting it would invalidate every run
 * that cited the old meaning.
 */
export async function registerComponent(sql: Sql, input: ComponentInput): Promise<string> {
  const [existing] = await sql<
    { id: string; category: string; description: string; input_contract: string; output_contract: string }[]
  >`
    select id, category, description, input_contract, output_contract
    from analysis.components where component_key = ${input.componentKey}
  `;
  if (existing) {
    const differs =
      existing.category !== input.category ||
      existing.description !== input.description ||
      existing.input_contract !== input.inputContract ||
      existing.output_contract !== input.outputContract;
    if (differs) {
      throw new Error(
        `component ${input.componentKey} is already registered with different attributes; register a new component key`,
      );
    }
    return existing.id;
  }
  const [row] = await sql<{ id: string }[]>`
    insert into analysis.components (component_key, category, description, input_contract, output_contract)
    values (
      ${input.componentKey}, ${input.category}, ${input.description},
      ${input.inputContract}, ${input.outputContract}
    )
    returning id
  `;
  return row.id;
}

export interface DependencyInput {
  componentKey: string;
  version: string;
  /** The contract the dependent needs from this dependency. */
  requiredContract: string;
}

export interface ComponentVersionInput {
  componentKey: string;
  version: string;
  implementationSha256: string;
  configuration?: unknown;
  modelIdentity?: unknown;
  licence?: string | null;
  provenance?: string | null;
  deterministic: boolean;
  dependencies?: readonly DependencyInput[];
}

export interface RegisteredComponentVersion {
  id: string;
  contentHash: string;
  /** False when this call created it. */
  alreadyRegistered: boolean;
}

async function componentVersionIdOf(sql: Queryable, componentKey: string, version: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    select cv.id from analysis.component_versions cv
    join analysis.components c on c.id = cv.component_id
    where c.component_key = ${componentKey} and cv.version = ${version}
  `;
  if (!row) throw new Error(`no component version ${componentKey}@${version}`);
  return row.id;
}

/**
 * Register one immutable component version and its dependency edges.
 *
 * The edges are inserted in the same transaction as the version, so a version
 * never exists with half its dependencies: a validation that walked such a row
 * would call it compatible for the wrong reason.
 */
export async function registerComponentVersion(
  sql: Sql,
  input: ComponentVersionInput,
): Promise<RegisteredComponentVersion> {
  const configuration = input.configuration ?? {};
  const modelIdentity = input.modelIdentity ?? null;
  const contentHash = componentVersionHash({
    componentKey: input.componentKey,
    version: input.version,
    implementationSha256: input.implementationSha256,
    configuration,
    modelIdentity,
  });

  const [existing] = await sql<{ id: string }[]>`
    select id from analysis.component_versions where content_hash = ${contentHash}
  `;
  if (existing) return { id: existing.id, contentHash, alreadyRegistered: true };

  if (modelIdentity !== null && (input.licence == null || input.licence.length === 0)) {
    // The database refuses this too. Failing here names the rule instead of
    // surfacing a constraint violation to an operator registering weights.
    throw new Error(
      `component version ${input.componentKey}@${input.version} names a model artifact and must declare a licence`,
    );
  }

  return sql.begin(async (tx) => {
    const [component] = await tx<{ id: string }[]>`
      select id from analysis.components where component_key = ${input.componentKey}
    `;
    if (!component) throw new Error(`no component ${input.componentKey}`);

    let id: string;
    try {
      const [row] = await tx<{ id: string }[]>`
        insert into analysis.component_versions (
          component_id, version, implementation_sha256, configuration, configuration_hash,
          content_hash, model_identity, licence, provenance, deterministic
        ) values (
          ${component.id}, ${input.version}, ${input.implementationSha256},
          ${jsonParam(configuration)}::text::jsonb, ${configurationHash(configuration)},
          ${contentHash}, ${modelIdentity === null ? null : jsonParam(modelIdentity)}::text::jsonb,
          ${input.licence ?? null}, ${input.provenance ?? null}, ${input.deterministic}
        )
        returning id
      `;
      id = row.id;
    } catch (error) {
      if (isUniqueViolation(error, "component_versions_unique")) {
        throw new Error(
          `component version ${input.componentKey}@${input.version} already exists with different content; use a new version number`,
        );
      }
      throw error;
    }

    for (const dependency of input.dependencies ?? []) {
      const dependencyId = await componentVersionIdOf(tx, dependency.componentKey, dependency.version);
      await tx`
        insert into analysis.component_version_dependencies (
          dependent_version_id, dependency_version_id, required_contract
        ) values (${id}, ${dependencyId}, ${dependency.requiredContract})
      `;
    }

    return { id, contentHash, alreadyRegistered: false };
  });
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const candidate = error as { code?: string; constraint_name?: string };
  return candidate?.code === "23505" && candidate.constraint_name === constraint;
}

// ---------------------------------------------------------------------------
// Recipe validation
// ---------------------------------------------------------------------------

export interface RecipeValidation {
  valid: boolean;
  /** Human-readable, ordered, and safe to log: names and contracts only. */
  problems: string[];
  /** True when every pinned version is deterministic. */
  deterministic: boolean;
  /** role -> component version content hash, the manifest's own input. */
  componentHashes: Record<string, string>;
}

interface PinnedVersion {
  id: string;
  componentKey: string;
  version: string;
  contentHash: string;
  deterministic: boolean;
  outputContract: string;
}

async function pinnedVersions(sql: Queryable, ids: readonly string[]): Promise<Map<string, PinnedVersion>> {
  if (ids.length === 0) return new Map();
  const rows = await sql<
    {
      id: string;
      component_key: string;
      version: string;
      content_hash: string;
      deterministic: boolean;
      output_contract: string;
    }[]
  >`
    select cv.id, c.component_key, cv.version, cv.content_hash, cv.deterministic, c.output_contract
    from analysis.component_versions cv
    join analysis.components c on c.id = cv.component_id
    where cv.id = any(${sql.array([...ids] as string[])}::uuid[])
  `;
  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        componentKey: row.component_key,
        version: row.version,
        contentHash: row.content_hash,
        deterministic: row.deterministic,
        outputContract: row.output_contract,
      },
    ]),
  );
}

/**
 * Check a set of role pins before anything is written.
 *
 * Two failures matter and they fail differently. An *incompatible* dependency is
 * a wiring mistake: the edge asks for `transition_assessment.v2` and the version
 * it points at emits `transition_assessment.v1`, so the consumer would read
 * fields that are not there. A *cycle* is a definitional mistake: no order
 * exists in which the graph can run. Both are refused here, and neither is
 * reported as "validation failed" without naming which edge did it.
 */
export async function validateRecipe(
  sql: Queryable,
  roles: Readonly<Record<string, string>>,
): Promise<RecipeValidation> {
  const problems: string[] = [];
  const ids = Object.values(roles);
  const pinned = await pinnedVersions(sql, ids);

  for (const [role, id] of Object.entries(roles).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!pinned.has(id)) problems.push(`role ${role} pins an unknown component version`);
  }
  if (problems.length > 0) {
    return { valid: false, problems, deterministic: false, componentHashes: {} };
  }

  const closure = await dependencyClosure(sql, ids);
  for (const edge of closure.edges) {
    if (edge.requiredContract !== edge.dependencyOutputContract) {
      problems.push(
        `${edge.dependentKey}@${edge.dependentVersion} requires ${edge.requiredContract} but ` +
          `${edge.dependencyKey}@${edge.dependencyVersion} emits ${edge.dependencyOutputContract}`,
      );
    }
  }
  if (closure.cycle) {
    problems.push(`dependency cycle through ${closure.cycle.join(" -> ")}`);
  }

  const componentHashes: Record<string, string> = {};
  let deterministic = true;
  for (const [role, id] of Object.entries(roles)) {
    const version = pinned.get(id)!;
    componentHashes[role] = version.contentHash;
    if (!version.deterministic) deterministic = false;
  }

  return { valid: problems.length === 0, problems: problems.sort(), deterministic, componentHashes };
}

interface ClosureEdge {
  dependentKey: string;
  dependentVersion: string;
  dependencyKey: string;
  dependencyVersion: string;
  requiredContract: string;
  dependencyOutputContract: string;
}

/**
 * Every dependency edge reachable from the pinned versions, plus a cycle if the
 * graph somehow holds one.
 *
 * One recursive query rather than a fetch-per-node loop: the whole point of the
 * DAG is that it can be deep, and a per-node round trip would make validation
 * cost proportional to depth for no benefit.
 */
async function dependencyClosure(
  sql: Queryable,
  roots: readonly string[],
): Promise<{ edges: ClosureEdge[]; cycle: string[] | null }> {
  const rows = await sql<
    {
      dependent_key: string;
      dependent_version: string;
      dependency_key: string;
      dependency_version: string;
      required_contract: string;
      dependency_output_contract: string;
      is_cycle: boolean;
    }[]
  >`
    with recursive walk as (
      select d.dependent_version_id, d.dependency_version_id, d.required_contract,
             array[d.dependent_version_id] as path, false as is_cycle
      from analysis.component_version_dependencies d
      where d.dependent_version_id = any(${sql.array([...roots] as string[])}::uuid[])
      union all
      select d.dependent_version_id, d.dependency_version_id, d.required_contract,
             w.path || d.dependent_version_id,
             d.dependent_version_id = any(w.path)
      from analysis.component_version_dependencies d
      join walk w on w.dependency_version_id = d.dependent_version_id
      where not w.is_cycle
    )
    select dep_c.component_key as dependent_key, dep_v.version as dependent_version,
           dcy_c.component_key as dependency_key, dcy_v.version as dependency_version,
           w.required_contract, dcy_c.output_contract as dependency_output_contract, w.is_cycle
    from walk w
    join analysis.component_versions dep_v on dep_v.id = w.dependent_version_id
    join analysis.components dep_c on dep_c.id = dep_v.component_id
    join analysis.component_versions dcy_v on dcy_v.id = w.dependency_version_id
    join analysis.components dcy_c on dcy_c.id = dcy_v.component_id
  `;
  const cycleRow = rows.find((row) => row.is_cycle);
  return {
    edges: rows
      .filter((row) => !row.is_cycle)
      .map((row) => ({
        dependentKey: row.dependent_key,
        dependentVersion: row.dependent_version,
        dependencyKey: row.dependency_key,
        dependencyVersion: row.dependency_version,
        requiredContract: row.required_contract,
        dependencyOutputContract: row.dependency_output_contract,
      })),
    cycle: cycleRow
      ? [
          `${cycleRow.dependent_key}@${cycleRow.dependent_version}`,
          `${cycleRow.dependency_key}@${cycleRow.dependency_version}`,
        ]
      : null,
  };
}

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

export interface RecipeVersionInput {
  recipeKey: string;
  version: string;
  runType: RunType;
  inputSchemaVersion: string;
  outputSchemaVersion: string;
  requiredArtifacts: readonly string[];
  /** role -> { componentKey, version }. */
  roles: Readonly<Record<string, { componentKey: string; version: string }>>;
}

export interface RegisteredRecipeVersion {
  id: string;
  manifestSha256: string;
  deterministic: boolean;
  alreadyRegistered: boolean;
}

/**
 * Validate a recipe and freeze it.
 *
 * The manifest hash is the identity, so registering the same pins twice returns
 * the first row. An invalid recipe is never written at all: a rejected manifest
 * that still exists is a manifest someone will eventually promote.
 */
export async function registerRecipeVersion(
  sql: Sql,
  input: RecipeVersionInput,
): Promise<RegisteredRecipeVersion> {
  const roleIds: Record<string, string> = {};
  for (const [role, pin] of Object.entries(input.roles)) {
    roleIds[role] = await componentVersionIdOf(sql, pin.componentKey, pin.version);
  }

  const validation = await validateRecipe(sql, roleIds);
  if (!validation.valid) {
    throw new Error(`recipe ${input.recipeKey}@${input.version} is invalid: ${validation.problems.join("; ")}`);
  }

  const manifestSha256 = recipeManifestHash({
    recipeKey: input.recipeKey,
    version: input.version,
    runType: input.runType,
    inputSchemaVersion: input.inputSchemaVersion,
    outputSchemaVersion: input.outputSchemaVersion,
    requiredArtifacts: input.requiredArtifacts,
    components: validation.componentHashes,
  });

  const [existing] = await sql<{ id: string; deterministic: boolean }[]>`
    select id, deterministic from analysis.recipe_versions where manifest_sha256 = ${manifestSha256}
  `;
  if (existing) {
    return {
      id: existing.id,
      manifestSha256,
      deterministic: existing.deterministic,
      alreadyRegistered: true,
    };
  }

  return sql.begin(async (tx) => {
    const [recipe] = await tx<{ id: string }[]>`
      insert into analysis.recipe_versions (
        recipe_key, version, manifest_sha256, input_schema_version, output_schema_version,
        run_type, required_artifacts, deterministic
      ) values (
        ${input.recipeKey}, ${input.version}, ${manifestSha256}, ${input.inputSchemaVersion},
        ${input.outputSchemaVersion}, ${input.runType},
        ${tx.array([...input.requiredArtifacts].sort() as string[])}, ${validation.deterministic}
      )
      returning id
    `;
    for (const [role, id] of Object.entries(roleIds)) {
      await tx`
        insert into analysis.recipe_components (recipe_version_id, role, component_version_id)
        values (${recipe.id}, ${role}, ${id})
      `;
    }
    return {
      id: recipe.id,
      manifestSha256,
      deterministic: validation.deterministic,
      alreadyRegistered: false,
    };
  });
}

export interface RecipeSummary {
  id: string;
  recipeKey: string;
  version: string;
  manifestSha256: string;
  runType: RunType;
  requiredArtifacts: string[];
  deterministic: boolean;
}

export async function readRecipe(sql: Queryable, recipeVersionId: string): Promise<RecipeSummary | null> {
  const [row] = await sql<
    {
      id: string;
      recipe_key: string;
      version: string;
      manifest_sha256: string;
      run_type: RunType;
      required_artifacts: string[];
      deterministic: boolean;
    }[]
  >`
    select id, recipe_key, version, manifest_sha256, run_type, required_artifacts, deterministic
    from analysis.recipe_versions where id = ${recipeVersionId}
  `;
  if (!row) return null;
  return {
    id: row.id,
    recipeKey: row.recipe_key,
    version: row.version,
    manifestSha256: row.manifest_sha256,
    runType: row.run_type,
    requiredArtifacts: row.required_artifacts,
    deterministic: row.deterministic,
  };
}

/** role -> component version id, for one recipe version. */
export async function recipeRoles(sql: Queryable, recipeVersionId: string): Promise<Record<string, string>> {
  const rows = await sql<{ role: string; component_version_id: string }[]>`
    select role, component_version_id from analysis.recipe_components
    where recipe_version_id = ${recipeVersionId}
  `;
  return Object.fromEntries(rows.map((row) => [row.role, row.component_version_id]));
}

export interface RecipeDifference {
  unchanged: string[];
  changed: string[];
  added: string[];
  removed: string[];
}

/**
 * What actually differs between two recipes, by role.
 *
 * This is the function that makes "changing only the estimator reuses replay,
 * transitions, engine output and observations" a decision rather than a hope:
 * `unchanged` is exactly the set of roles whose upstream output is still valid,
 * and it is derived from pinned version identity, not from a version number
 * someone remembered to bump.
 */
export function compareRecipes(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): RecipeDifference {
  const unchanged: string[] = [];
  const changed: string[] = [];
  const added: string[] = [];
  for (const [role, id] of Object.entries(after)) {
    if (!(role in before)) added.push(role);
    else if (before[role] === id) unchanged.push(role);
    else changed.push(role);
  }
  const removed = Object.keys(before).filter((role) => !(role in after));
  return {
    unchanged: unchanged.sort(),
    changed: changed.sort(),
    added: added.sort(),
    removed: removed.sort(),
  };
}

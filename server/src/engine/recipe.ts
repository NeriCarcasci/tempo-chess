/**
 * Resolving the versions a game analysis runs under, and reading the chain it
 * runs over.
 *
 * Both halves exist because neither the engine worker nor the analysis worker
 * may invent its inputs. The roles come from the recipe the run pinned, so two
 * runs of the same game under different recipes are two different analyses
 * rather than one that quietly changed; the chain comes from E09's published
 * materialization run, so an analysis reads the same positions the review will
 * later show.
 */

import type { Queryable } from "../db/queryable.js";
import { ENGINE_COMPONENT_KEYS } from "./contract.js";
import type { OccurrenceChain } from "./history.js";

export interface EngineRoles {
  engineVersionId: string;
  calibrationVersionId: string;
  toleranceVersionId: string;
  selectorVersionId: string;
}

/**
 * The four component versions a game analysis recipe must pin.
 *
 * Resolved by component *key* rather than by recipe role name, so a recipe that
 * calls the engine role `objective` and another that calls it `engine` both
 * work, and a recipe that pins two engine versions cannot be read as pinning
 * one. A missing role is an error here rather than a null passed downstream: a
 * run whose tolerance rule is unknown cannot produce an assessment that names
 * the rule it used.
 */
export async function readEngineRoles(
  sql: Queryable,
  recipeVersionId: string,
): Promise<EngineRoles> {
  const rows = await sql<{ component_key: string; component_version_id: string }[]>`
    select c.component_key, cv.id as component_version_id
    from analysis.recipe_components rc
    join analysis.component_versions cv on cv.id = rc.component_version_id
    join analysis.components c on c.id = cv.component_id
    where rc.recipe_version_id = ${recipeVersionId}
  `;
  const byKey = new Map<string, string[]>();
  for (const row of rows) {
    byKey.set(row.component_key, [...(byKey.get(row.component_key) ?? []), row.component_version_id]);
  }
  const one = (key: string): string => {
    const found = byKey.get(key) ?? [];
    if (found.length !== 1) {
      throw new Error(`the recipe pins ${found.length} versions of ${key}; it must pin exactly one`);
    }
    return found[0]!;
  };
  return {
    engineVersionId: one(ENGINE_COMPONENT_KEYS.objectiveEngine),
    calibrationVersionId: one(ENGINE_COMPONENT_KEYS.expectedScore),
    toleranceVersionId: one(ENGINE_COMPONENT_KEYS.tolerance),
    selectorVersionId: one(ENGINE_COMPONENT_KEYS.criticalSelector),
  };
}

export interface ChainPosition {
  ply: number;
  corePositionId: string;
  corePositionKeyHash: string;
  fen: string;
  halfmoveClock: number;
  repetitionCount: number;
  sideToMove: "w" | "b";
}

export interface ChainMove {
  fromPly: number;
  uci: string;
}

export interface MaterializedChain extends OccurrenceChain {
  materializationRunId: string;
  occurrences: readonly ChainPosition[];
  transitions: readonly ChainMove[];
}

/**
 * The published occurrence chain of one materialization run.
 *
 * Two queries rather than one join, because the transitions are `ply` rows and
 * the occurrences are `ply + 1`; joining them would either drop the final
 * position or repeat every occurrence, and the final position is exactly the
 * one the last transition's "after" evidence needs.
 */
export async function readChain(
  sql: Queryable,
  materializationRunId: string,
): Promise<MaterializedChain> {
  const occurrences = await sql<
    {
      ply: number;
      core_position_id: string;
      core_key_hash: string;
      fen: string;
      halfmove_clock: number;
      repetition_count: number;
      side_to_move: "w" | "b";
    }[]
  >`
    select o.ply, o.core_position_id, cp.core_key_hash, o.fen, o.halfmove_clock,
           o.repetition_count, o.side_to_move
    from chess.position_occurrences o
    join chess.core_positions cp on cp.id = o.core_position_id
    where o.run_id = ${materializationRunId}
    order by o.ply
  `;
  const transitions = await sql<{ from_ply: number; uci: string }[]>`
    select from_ply, uci from chess.position_transitions
    where run_id = ${materializationRunId}
    order by from_ply
  `;
  return {
    materializationRunId,
    occurrences: occurrences.map((row) => ({
      ply: row.ply,
      corePositionId: String(row.core_position_id),
      corePositionKeyHash: row.core_key_hash,
      fen: row.fen,
      halfmoveClock: row.halfmove_clock,
      repetitionCount: row.repetition_count,
      sideToMove: row.side_to_move,
    })),
    transitions: transitions.map((row) => ({ fromPly: row.from_ply, uci: row.uci })),
  };
}

/** The published materialization run of one replay revision, or null. */
export async function publishedMaterializationRun(
  sql: Queryable,
  replayRevisionId: string,
): Promise<string | null> {
  const [row] = await sql<{ id: string }[]>`
    select id from chess.materialization_runs
    where replay_revision_id = ${replayRevisionId} and state = 'published'
  `;
  return row?.id ?? null;
}

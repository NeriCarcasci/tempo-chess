/**
 * The smallest canonical world the E11 gates need, and the golden versions they
 * pin.
 *
 * Two things live here. The first is a seeder that builds a real subject with
 * real provider games, replay revisions and *published* materialization runs,
 * because everything this epic does is downstream of those rows and a snapshot
 * that pinned invented ids would prove nothing about the joins it depends on.
 *
 * The second is one golden recipe lineage — a normalizer, an engine profile and
 * an estimator — with a second estimator version beside it. That pair is the
 * whole "changing only the estimator reuses everything upstream" fixture, and
 * keeping it here means the integration, security and performance gates argue
 * about the same versions rather than three similar ones.
 *
 * Deliberately small. A large synthetic corpus would make these gates slow
 * without making them prove more; the performance gate builds its own bulk.
 */

import { createHash, randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type { Queryable } from "../db/queryable.js";
import { registerCohortVersion } from "./snapshots.js";
import { registerComponent, registerComponentVersion, registerRecipeVersion } from "./versions.js";
import type { CohortDefinition } from "./contract.js";

export const SHA = (seed: string): string => createHash("sha256").update(seed).digest("hex");

export interface SeededGame {
  subjectGameId: string;
  providerGameId: string;
  replayRevisionId: string;
  materializationRunId: string;
  playedAt: string;
}

export interface SeededSubject {
  ownerUserId: string;
  subjectId: string;
  games: SeededGame[];
}

export interface SeedOptions {
  games?: number;
  rated?: boolean | null;
  speed?: string | null;
  /** Skip publishing the materialization run, so the game is not analysable. */
  publishMaterialization?: boolean;
  isBot?: boolean | null;
  rating?: number | null;
}

/**
 * One owner, one subject, and N completed games with published materialization.
 *
 * `rated` and `speed` accept null on purpose: the unknown-is-not-yes rule is
 * only testable if a fixture can actually produce an unknown.
 */
export async function seedSubject(sql: Sql, options: SeedOptions = {}): Promise<SeededSubject> {
  const count = options.games ?? 3;
  const publish = options.publishMaterialization ?? true;
  const ownerUserId = randomUUID();
  const stamp = Date.now();

  await sql`insert into app.profiles (user_id) values (${ownerUserId}) on conflict do nothing`;
  const [subject] = await sql<{ id: string }[]>`
    insert into app.analysis_subjects (kind, owner_user_id, display_label)
    values ('personal', ${ownerUserId}, 'E11 gate subject')
    returning id
  `;

  const games: SeededGame[] = [];
  for (let index = 0; index < count; index += 1) {
    const playedAt = new Date(stamp - (count - index) * 86_400_000).toISOString();
    const [providerGame] = await sql<{ id: string }[]>`
      insert into chess.provider_games (provider_id, provider_game_id)
      values (2, ${`e11-${stamp}-${randomUUID()}`})
      returning id
    `;
    const [revision] = await sql<{ id: string }[]>`
      insert into chess.game_replay_revisions (
        provider_game_id, revision_no, normalizer_component_version_id, normalized_replay,
        normalized_sha256, played_at, rated, speed, result, ply_count, revision_reason
      ) values (
        ${providerGame.id}, 1, 'norm-v1', '{"moves":[]}'::jsonb, ${SHA(`${stamp}-${index}`)},
        ${playedAt}, ${options.rated === undefined ? true : options.rated},
        ${options.speed === undefined ? "blitz" : options.speed}, 'white', 4, 'first_seen'
      )
      returning id
    `;
    await sql`
      update chess.provider_games set current_replay_revision_id = ${revision.id}
      where id = ${providerGame.id}
    `;
    for (const color of ["white", "black"] as const) {
      await sql`
        insert into chess.game_revision_participants (
          replay_revision_id, color, outcome, is_bot, rating
        ) values (
          ${revision.id}, ${color}, ${color === "white" ? "win" : "loss"},
          ${options.isBot === undefined ? false : options.isBot},
          ${options.rating === undefined ? 1500 : options.rating}
        )
      `;
    }
    const [subjectGame] = await sql<{ id: string }[]>`
      insert into chess.subject_games (subject_id, provider_game_id, latest_replay_revision_id, subject_color)
      values (${subject.id}, ${providerGame.id}, ${revision.id}, 'white')
      returning id
    `;
    const [run] = await sql<{ id: string }[]>`
      insert into chess.materialization_runs (
        replay_revision_id, materializer_version, checksum, state, occurrence_count,
        transition_count, published_at
      ) values (
        ${revision.id}, 'core-key-v1', ${SHA(`mat-${stamp}-${index}`)},
        ${publish ? "published" : "building"}, 5, 4, ${publish ? new Date().toISOString() : null}
      )
      returning id
    `;
    if (publish) {
      await sql`
        insert into chess.replay_materialization_publication_history (
          replay_revision_id, previous_run_id, run_id, reason, actor_kind
        ) values (${revision.id}, null, ${run.id}, 'first_publication', 'system')
      `;
    }
    games.push({
      subjectGameId: subjectGame.id,
      providerGameId: providerGame.id,
      replayRevisionId: revision.id,
      materializationRunId: run.id,
      playedAt,
    });
  }

  return { ownerUserId, subjectId: subject.id, games };
}

export const GOLDEN_COHORT: CohortDefinition = {
  providers: ["lichess"],
  rated: "rated",
  speeds: ["blitz"],
  includeBotOpponents: false,
  playedFrom: null,
  playedTo: null,
  maxGames: 500,
  minGames: 2,
  requireClocks: false,
  ratingMin: null,
  ratingMax: null,
};

export interface GoldenVersions {
  cohortVersionId: string;
  /** Pins normalizer@1, engine@1, estimator@1. */
  baselineRecipeId: string;
  /** Identical except estimator@2: the method-only change. */
  estimatorBumpRecipeId: string;
  estimatorV1Id: string;
  estimatorV2Id: string;
}

export const REQUIRED_ARTIFACTS = ["transition_assessments", "skill_estimates"] as const;

/**
 * The golden lineage: three components, four versions, two recipes differing in
 * exactly one role.
 *
 * The estimator depends on the engine profile through a declared contract, so
 * the same fixture also exercises the compatible half of the DAG check — the
 * incompatible half is built inline by the gate that asserts the refusal.
 */
export async function seedGoldenVersions(sql: Sql, suffix: string): Promise<GoldenVersions> {
  const normalizerKey = `norm_${suffix}`;
  const engineKey = `engine_${suffix}`;
  const estimatorKey = `estimator_${suffix}`;

  await registerComponent(sql, {
    componentKey: normalizerKey,
    category: "normalizer",
    description: "Provider replay normalizer",
    inputContract: "provider_payload.v1",
    outputContract: "normalized_replay.v1",
  });
  await registerComponent(sql, {
    componentKey: engineKey,
    category: "engine_profile",
    description: "Objective evaluation profile",
    inputContract: "normalized_replay.v1",
    outputContract: "position_evaluation.v1",
  });
  await registerComponent(sql, {
    componentKey: estimatorKey,
    category: "estimator",
    description: "Skill estimator",
    inputContract: "position_evaluation.v1",
    outputContract: "skill_estimate.v1",
  });

  await registerComponentVersion(sql, {
    componentKey: normalizerKey,
    version: "1",
    implementationSha256: SHA(`${normalizerKey}-1`),
    deterministic: true,
  });
  await registerComponentVersion(sql, {
    componentKey: engineKey,
    version: "1",
    implementationSha256: SHA(`${engineKey}-1`),
    configuration: { depth: 18, multipv: 3 },
    deterministic: true,
  });
  const estimatorV1 = await registerComponentVersion(sql, {
    componentKey: estimatorKey,
    version: "1",
    implementationSha256: SHA(`${estimatorKey}-1`),
    configuration: { halfLifeDays: 90 },
    deterministic: true,
    dependencies: [{ componentKey: engineKey, version: "1", requiredContract: "position_evaluation.v1" }],
  });
  const estimatorV2 = await registerComponentVersion(sql, {
    componentKey: estimatorKey,
    version: "2",
    implementationSha256: SHA(`${estimatorKey}-2`),
    configuration: { halfLifeDays: 45 },
    deterministic: true,
    dependencies: [{ componentKey: engineKey, version: "1", requiredContract: "position_evaluation.v1" }],
  });

  const baseline = await registerRecipeVersion(sql, {
    recipeKey: `live_${suffix}`,
    version: "1",
    runType: "subject_live",
    inputSchemaVersion: "subject_snapshot.v1",
    outputSchemaVersion: "subject_live.v1",
    requiredArtifacts: REQUIRED_ARTIFACTS,
    roles: {
      normalizer: { componentKey: normalizerKey, version: "1" },
      engine: { componentKey: engineKey, version: "1" },
      estimator: { componentKey: estimatorKey, version: "1" },
    },
  });
  const bumped = await registerRecipeVersion(sql, {
    recipeKey: `live_${suffix}`,
    version: "2",
    runType: "subject_live",
    inputSchemaVersion: "subject_snapshot.v1",
    outputSchemaVersion: "subject_live.v1",
    requiredArtifacts: REQUIRED_ARTIFACTS,
    roles: {
      normalizer: { componentKey: normalizerKey, version: "1" },
      engine: { componentKey: engineKey, version: "1" },
      estimator: { componentKey: estimatorKey, version: "2" },
    },
  });

  const cohort = await registerCohortVersion(sql, {
    cohortKey: `cohort_${suffix}`,
    version: "1",
    definition: GOLDEN_COHORT,
  });

  return {
    cohortVersionId: cohort.id,
    baselineRecipeId: baseline.id,
    estimatorBumpRecipeId: bumped.id,
    estimatorV1Id: estimatorV1.id,
    estimatorV2Id: estimatorV2.id,
  };
}

/** Record the manifest a recipe declares, so a run can legitimately succeed. */
export async function recordGoldenManifest(sql: Queryable, runId: string): Promise<void> {
  for (const family of REQUIRED_ARTIFACTS) {
    await sql`
      insert into analysis.run_artifacts (run_id, family, row_count, checksum)
      values (${runId}, ${family}, 4, ${SHA(`${runId}-${family}`)})
    `;
  }
}

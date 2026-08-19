/**
 * The smallest analysable world the E12 gates need, and a deterministic engine.
 *
 * Two things live here.
 *
 * The **world** is one owner, one subject, one real game whose replay is
 * materialized through E09's own code — not hand-written rows — and whose moves
 * deliberately repeat. `Nf3 Nf6 Ng1 Ng8 Nf3 Nf6` returns the starting position
 * at ply 4, so plies 4 to 6 have `repetition_count > 1` and require
 * `history_exact` evidence while plies 0 to 3 do not. That single game is
 * therefore the whole scope fixture: both scopes, in one chain, produced by the
 * materializer rather than asserted.
 *
 * The **engine** is deterministic and offline. Its evaluations are a function of
 * the FEN, and its candidate moves are the position's actual legal moves, so a
 * played-move rank is a real lookup rather than a coincidence of two hashes.
 * Stockfish itself is not a build dependency of the gates: platform spec §20
 * asks for "deterministic ingestion/chess/engine/statistics fixtures", and a
 * gate whose result depends on which Stockfish the machine happens to have is
 * not one.
 */

import { createHash, randomUUID } from "node:crypto";
import { Chess } from "chessops/chess";
import { parseFen } from "chessops/fen";
import { makeUci } from "chessops/util";
import type { Sql } from "postgres";
import { buildRun, publishRun } from "../positions/materialize.js";
import { registerRecipeVersion } from "../analysis/versions.js";
import { promoteRecipe, recordValidationRun, registerValidationDataset } from "../analysis/validation.js";
import {
  ENGINE_COMPONENT_KEYS,
  ENGINE_PROFILES,
  TRANSITION_ASSESSMENT_FAMILY,
  expectedScore,
  type EngineProfileKey,
} from "./contract.js";
import { registerEngineVersions, type EngineIdentity, type RegisteredEngineVersions } from "./profiles.js";
import type { EngineSession } from "./worker.js";
import type { CandidateLine, PositionEval, SearchHistory } from "./stockfish.js";

export const SHA = (seed: string): string => createHash("sha256").update(seed).digest("hex");

/** A knight shuffle: the starting position returns at ply 4. */
export const REPEATING_MOVES = ["g1f3", "g8f6", "f3g1", "f6g8", "g1f3", "g8f6"] as const;

/** A quiet opening with no repetition, for the scope contrast. */
export const PLAIN_MOVES = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "g8f6"] as const;

export const FIXTURE_ENGINE: EngineIdentity = {
  engineName: "Stockfish 18",
  engineVersion: "18",
  binarySha256: SHA("e12-fixture-engine"),
  networkHash: "deadbeef",
};

export interface SeededGame {
  ownerUserId: string;
  subjectId: string;
  subjectGameId: string;
  providerGameId: string;
  replayRevisionId: string;
  materializationRunId: string;
}

export interface SeedGameOptions {
  moves?: readonly string[];
  /** Leave the materialization unpublished, so the game is not analysable. */
  publish?: boolean;
  /** Reuse an existing owner and subject rather than creating new ones. */
  into?: { ownerUserId: string; subjectId: string };
}

/** One owner, one subject, one materialized game. */
export async function seedAnalysableGame(
  sql: Sql,
  options: SeedGameOptions = {},
): Promise<SeededGame> {
  const moves = options.moves ?? REPEATING_MOVES;
  const publish = options.publish ?? true;
  const stamp = `${Date.now()}-${randomUUID()}`;

  let ownerUserId = options.into?.ownerUserId;
  let subjectId = options.into?.subjectId;
  if (!ownerUserId || !subjectId) {
    ownerUserId = randomUUID();
    await sql`insert into app.profiles (user_id) values (${ownerUserId}) on conflict do nothing`;
    const [subject] = await sql<{ id: string }[]>`
      insert into app.analysis_subjects (kind, owner_user_id, display_label)
      values ('personal', ${ownerUserId}, 'E12 gate subject')
      returning id
    `;
    subjectId = subject!.id;
  }

  const [providerGame] = await sql<{ id: string }[]>`
    insert into chess.provider_games (provider_id, provider_game_id)
    values (2, ${`e12-${stamp}`})
    returning id
  `;
  const [revision] = await sql<{ id: string }[]>`
    insert into chess.game_replay_revisions (
      provider_game_id, revision_no, normalizer_component_version_id, normalized_replay,
      normalized_sha256, played_at, rated, speed, result, ply_count, revision_reason
    ) values (
      ${providerGame!.id}, 1, 'norm-v1',
      ${sql.json({ moves } as never)}, ${SHA(stamp)}, now(), true, 'blitz', 'white',
      ${moves.length}, 'first_seen'
    )
    returning id
  `;
  await sql`
    update chess.provider_games set current_replay_revision_id = ${revision!.id}
    where id = ${providerGame!.id}
  `;
  for (const color of ["white", "black"] as const) {
    await sql`
      insert into chess.game_revision_participants (
        replay_revision_id, color, outcome, is_bot, rating
      ) values (${revision!.id}, ${color}, ${color === "white" ? "win" : "loss"}, false, 1500)
    `;
  }
  const [subjectGame] = await sql<{ id: string }[]>`
    insert into chess.subject_games (subject_id, provider_game_id, latest_replay_revision_id, subject_color)
    values (${subjectId}, ${providerGame!.id}, ${revision!.id}, 'white')
    returning id
  `;

  const run = await buildRun(sql, revision!.id, { moves: moves.map((uci) => ({ uci })) });
  if (publish) await publishRun(sql, run.runId, { reason: "first_publication" });

  return {
    ownerUserId,
    subjectId,
    subjectGameId: subjectGame!.id,
    providerGameId: providerGame!.id,
    replayRevisionId: revision!.id,
    materializationRunId: run.runId,
  };
}

export interface SeededRecipe extends RegisteredEngineVersions {
  recipeVersionId: string;
  validationRunId: string;
}

/**
 * Register the engine lineage, a game-analysis recipe, and promote it.
 *
 * Promotion cites a validation run, because E11 refuses a production surface
 * without one. That is not ceremony to satisfy a constraint: the recipe this
 * epic ships is a method, and "which evidence justified making it current" is
 * the question the promotion table exists to answer.
 */
export async function seedPromotedRecipe(sql: Sql, suffix: string): Promise<SeededRecipe> {
  const versions = await registerEngineVersions(sql, FIXTURE_ENGINE);
  const [engineVersion] = await sql<{ version: string }[]>`
    select version from analysis.component_versions where id = ${versions.engineProfileId}
  `;

  const recipe = await registerRecipeVersion(sql, {
    recipeKey: `game_review_${suffix}`,
    version: "1",
    runType: "game_analysis",
    inputSchemaVersion: "replay.v1",
    outputSchemaVersion: "game_review.v1",
    requiredArtifacts: [TRANSITION_ASSESSMENT_FAMILY],
    roles: {
      engine: { componentKey: ENGINE_COMPONENT_KEYS.objectiveEngine, version: engineVersion!.version },
      expected_score: { componentKey: ENGINE_COMPONENT_KEYS.expectedScore, version: "1" },
      tolerance: { componentKey: ENGINE_COMPONENT_KEYS.tolerance, version: "1" },
      critical_selector: { componentKey: ENGINE_COMPONENT_KEYS.criticalSelector, version: "1" },
    },
  });

  const dataset = await registerValidationDataset(sql, {
    datasetKey: `engine_golden_${suffix}`,
    version: "1",
    manifestSha256: SHA(`engine-golden-${suffix}`),
    samplingDescription: "The committed deterministic engine corpus.",
    accountDisjoint: true,
    chronologicalSplit: false,
    governanceClass: "internal",
  });
  const validationRunId = await recordValidationRun(sql, {
    datasetId: dataset.id,
    candidate: { recipeVersionId: recipe.id },
    executionRevision: "gate",
    status: "passed",
    outputChecksum: SHA(`engine-golden-output-${suffix}`),
    metrics: [
      { metricKey: "transition_coverage", sampleSize: 6, value: 1 },
      { metricKey: "deep_selection_rate", sampleSize: 6, value: 0.5 },
    ],
  });
  await promoteRecipe(sql, {
    surface: "deep_game_analysis",
    recipeVersionId: recipe.id,
    reason: "E12 gate",
    actor: { kind: "system" },
    validationRunId,
  });

  return { ...versions, recipeVersionId: recipe.id, validationRunId };
}

// ---------------------------------------------------------------------------
// The deterministic engine
// ---------------------------------------------------------------------------

export interface FixtureEngineOptions {
  /** Throw on every search under these profiles, to exercise failure paths. */
  failOn?: readonly EngineProfileKey[];
  /** Count searches, so a gate can assert the cache stopped one happening. */
  onSearch?: (profile: EngineProfileKey, fen: string) => void;
}

/** A stable value in [-320, 320] centipawns from the position alone. */
function deterministicCentipawns(fen: string): number {
  const digest = createHash("sha256").update(fen).digest();
  return (digest.readUInt16BE(0) % 641) - 320;
}

function wdlFrom(centipawns: number): [number, number, number] {
  const win = Math.round(1_000 / (1 + 10 ** (-centipawns / 400)));
  const draw = Math.max(0, Math.min(1_000 - win, Math.round(300 - Math.abs(centipawns) / 2)));
  return [win - Math.round(draw / 2), draw, 1_000 - (win - Math.round(draw / 2)) - draw];
}

/** The position's real legal moves, deterministically ordered. */
function legalMoves(fen: string): string[] {
  const setup = parseFen(fen);
  if (setup.isErr) return [];
  const position = Chess.fromSetup(setup.value);
  if (position.isErr) return [];
  const moves: string[] = [];
  const context = position.value.ctx();
  for (const from of position.value.board[position.value.turn]) {
    for (const to of position.value.dests(from, context)) {
      moves.push(makeUci({ from, to }));
    }
  }
  return moves.sort();
}

/**
 * A `PositionEval` shaped exactly as the real engine's, for one profile.
 *
 * The provenance must match the profile the caller asked for, because
 * `assertSearchMatchesProfile` refuses to file a result under a search the
 * engine did not run — a check that would be untested if the fixture were
 * allowed to be vague about it.
 */
export function fixtureEvaluation(
  fen: string,
  profile: EngineProfileKey,
  history: SearchHistory | null,
): PositionEval {
  const spec = ENGINE_PROFILES[profile];
  const centipawns = deterministicCentipawns(fen);
  const moves = legalMoves(fen);
  const candidates: CandidateLine[] = moves.slice(0, spec.multipv).map((uci, index) => {
    const value = centipawns - index * 45;
    return {
      rank: index + 1,
      depth: 18,
      selDepth: 24,
      nodes: spec.limitValue,
      nps: 1_000_000,
      engineTimeMs: Math.max(1, Math.round(spec.limitValue / 1_000)),
      evalCp: value,
      wdl: wdlFrom(value),
      pv: [uci],
    };
  });
  const primary = candidates[0];
  return {
    fen,
    // The legacy in-process key, which E12 does not use; the durable key is
    // `evaluationCacheKey`.
    cacheKey: SHA(`${fen}:${profile}:${history ? history.moves.join(",") : ""}`),
    depth: 18,
    evalCp: primary?.evalCp ?? centipawns,
    wdl: primary?.wdl ?? wdlFrom(centipawns),
    best: primary?.pv[0],
    candidates,
    nodes: spec.limitValue,
    nps: 1_000_000,
    engineTimeMs: Math.max(1, Math.round(spec.limitValue / 1_000)),
    elapsedMs: 1,
    provenance: {
      engine: "stockfish",
      engineName: FIXTURE_ENGINE.engineName,
      engineVersion: FIXTURE_ENGINE.engineVersion ?? undefined,
      binarySha256: FIXTURE_ENGINE.binarySha256 ?? undefined,
      networkHash: FIXTURE_ENGINE.networkHash ?? undefined,
      profileId: spec.key,
      profileVersion: 1,
      limit: { type: spec.limitType as "nodes" | "depth", value: spec.limitValue },
      multiPv: spec.multipv,
      threads: spec.threads,
      hashMb: spec.hashMb,
      workerRevision: "gate",
      cacheProvenance: "tempo",
    },
  };
}

/** An `EngineSession` the gates install in place of a Stockfish process. */
export function fixtureEngineSession(options: FixtureEngineOptions = {}): EngineSession {
  return {
    startupMs: 1,
    async search({ fen, profile, history }) {
      options.onSearch?.(profile, fen);
      if (options.failOn?.includes(profile)) {
        throw new Error(`fixture engine refuses ${profile}`);
      }
      return fixtureEvaluation(fen, profile, history);
    },
    async close() {},
  };
}

/** What one expected score should be, for a gate that checks the calibration. */
export function fixtureExpectedScore(fen: string): number {
  const centipawns = deterministicCentipawns(fen);
  return expectedScore({ scoreCp: centipawns, mateIn: null, wdl: wdlFrom(centipawns) }).value;
}

/**
 * The E11 versioning contract, frozen in one place.
 *
 * Every closed set here is also a check constraint in
 * `0022_e11_analysis_versions.sql`, for the same reason E04's contract is: the
 * database refuses a value it does not recognise even when a future call site
 * invents one, and this file is what the run planner, the publisher, the
 * validation gate and the API all read, so a value that exists in one and not
 * the other fails a test rather than reaching a row.
 *
 * The hash functions are contract too, not helpers. They *define* the identity
 * of every immutable row in this epic: two component versions with the same
 * content hash are the same version, a snapshot hash is what makes a baseline
 * reproducible after a provider correction, and a run's input manifest hash is
 * what makes "the same inputs" a fact rather than an opinion. Changing one of
 * them changes what Forma means by "the same analysis".
 *
 * Sources: plans/database-architecture.md §§12–14, plans/v1-platform-spec.md
 * §§10, 12.3, 13, plans/v1-api-contract.md §1.2.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../v1/canonical-json.js";

/** Every hash in this epic is a lowercase hex SHA-256. */
export const HASH_SHAPE = /^[0-9a-f]{64}$/;

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/**
 * Database architecture §12.1's catalogue of replaceable responsibilities.
 *
 * A category is a *role in the pipeline*, not an implementation. Stockfish and
 * Lc0 are both `engine_profile`; swapping one for the other is a component
 * version, which is exactly the substitution this epic exists to make legible.
 */
export const COMPONENT_CATEGORIES = [
  "normalizer",
  "materializer",
  "canonicalizer",
  "engine_profile",
  "human_policy",
  "calibration",
  "phase_detector",
  "feature_extractor",
  "event_detector",
  "concept_model",
  "estimator",
  "trajectory_aligner",
  "finding_rules",
  "renderer",
  "projection",
] as const;
export type ComponentCategory = (typeof COMPONENT_CATEGORIES)[number];

/**
 * Database architecture §12.10's lifecycle. Held on a separate append-only
 * table so an immutable component version does not change when it is approved.
 */
export const LIFECYCLE_STATES = ["draft", "shadow", "validated", "production", "retired"] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

/**
 * The only moves a component version may make.
 *
 * `production` is reachable only from `validated`, which is the executable form
 * of "data does not continuously retrain or silently promote production
 * behaviour" (§12.10). Retirement is one-way: a retired version is never
 * un-retired, because a new version is the honest way to bring it back.
 */
export const LIFECYCLE_TRANSITIONS: Record<LifecycleState, readonly LifecycleState[]> = {
  draft: ["shadow", "retired"],
  shadow: ["validated", "draft", "retired"],
  validated: ["production", "shadow", "retired"],
  production: ["retired"],
  retired: [],
};

export function isLifecycleTransitionAllowed(from: LifecycleState, to: LifecycleState): boolean {
  return LIFECYCLE_TRANSITIONS[from].includes(to);
}

/**
 * Database architecture §13.1's run types.
 *
 * Deliberately three. Replay materialization is a `chess.materialization_runs`
 * row (E09) and validation is an `analysis.validation_runs` row (§12.10); both
 * already have their own tables, and giving them a second identity here would
 * mean two rows could disagree about one event.
 */
export const RUN_TYPES = ["game_analysis", "subject_baseline", "subject_live"] as const;
export type RunType = (typeof RUN_TYPES)[number];

export const RUN_STATUSES = ["planned", "running", "succeeded", "failed", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "cancelled"] as const;

export function isTerminalRunStatus(status: RunStatus): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

/** Database architecture §12.6. What a promotion selects a recipe *for*. */
export const PROMOTION_SURFACES = [
  "screening",
  "deep_game_analysis",
  "onboarding_examination",
  "live_player_profile",
  "research_shadow",
] as const;
export type PromotionSurface = (typeof PROMOTION_SURFACES)[number];

/**
 * Database architecture §13.4's publication targets.
 *
 * These are the three type-safe publication tables, named here only so
 * telemetry and the rollback API can talk about them. There is deliberately no
 * `scope_type`/`scope_id` column anywhere: the tables carry the target's real
 * foreign key, so a publication cannot point at a row of the wrong kind.
 */
export const PUBLICATION_TARGETS = ["subject_live", "subject_game", "replay_materialization"] as const;
export type PublicationTarget = (typeof PUBLICATION_TARGETS)[number];

/** Which run type each analysis publication accepts. Enforced when publishing. */
export const PUBLICATION_RUN_TYPE = {
  subject_live: "subject_live",
  subject_game: "game_analysis",
} as const satisfies Record<"subject_live" | "subject_game", RunType>;

/**
 * A validation run records a *finished* comparison.
 *
 * There is no `running`: in-flight execution is the work ledger's job, and a
 * second table tracking the same progress is a second thing that can be wrong
 * about it. What lives here is evidence, which is why the rows are immutable.
 */
export const VALIDATION_STATUSES = ["passed", "failed", "inconclusive"] as const;
export type ValidationStatus = (typeof VALIDATION_STATUSES)[number];

/** Why a publication moved. `rollback` is the only backwards reason. */
export const PUBLICATION_REASONS = [
  "first_publication",
  "new_run",
  "recipe_promotion",
  "rollback",
  "reconciliation",
] as const;
export type PublicationReason = (typeof PUBLICATION_REASONS)[number];

// ---------------------------------------------------------------------------
// Run scope rules
// ---------------------------------------------------------------------------

export const SCOPE_COLUMNS = [
  "subject_id",
  "subject_game_id",
  "replay_revision_id",
  "subject_data_snapshot_id",
] as const;
export type ScopeColumn = (typeof SCOPE_COLUMNS)[number];

/**
 * Database architecture §13.1: the optional scope columns are "constrained
 * according to run type".
 *
 * A game analysis pins the exact replay revision it read, so a provider
 * correction produces a *new* run rather than silently re-scoping the old one.
 * A subject run pins a frozen snapshot and never a single game, because the
 * games it used are the snapshot's manifest, not a column.
 */
export const RUN_SCOPE: Record<RunType, { requires: readonly ScopeColumn[]; forbids: readonly ScopeColumn[] }> = {
  game_analysis: {
    requires: ["subject_id", "subject_game_id", "replay_revision_id"],
    forbids: ["subject_data_snapshot_id"],
  },
  subject_baseline: {
    requires: ["subject_id", "subject_data_snapshot_id"],
    forbids: ["subject_game_id", "replay_revision_id"],
  },
  subject_live: {
    requires: ["subject_id", "subject_data_snapshot_id"],
    forbids: ["subject_game_id", "replay_revision_id"],
  },
};

export interface RunScope {
  subjectId?: string | null;
  subjectGameId?: string | null;
  replayRevisionId?: string | null;
  subjectDataSnapshotId?: string | null;
}

const SCOPE_FIELD: Record<ScopeColumn, keyof RunScope> = {
  subject_id: "subjectId",
  subject_game_id: "subjectGameId",
  replay_revision_id: "replayRevisionId",
  subject_data_snapshot_id: "subjectDataSnapshotId",
};

/** The scope columns a run type gets wrong, named. Empty means it is legal. */
export function scopeViolations(runType: RunType, scope: RunScope): string[] {
  const rule = RUN_SCOPE[runType];
  const problems: string[] = [];
  for (const column of rule.requires) {
    if (scope[SCOPE_FIELD[column]] == null) problems.push(`${runType} requires ${column}`);
  }
  for (const column of rule.forbids) {
    if (scope[SCOPE_FIELD[column]] != null) problems.push(`${runType} must not set ${column}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Artifact families
// ---------------------------------------------------------------------------

/**
 * An output family name: `transition_assessments`, `events`, `findings`.
 *
 * The *set* of families a run must produce is declared by its recipe version,
 * not hardcoded here. That is deliberate: E11 owns reproducibility, not chess
 * meaning, and a fixed list here would either invent output families no method
 * produces yet or quietly bless whatever a later epic happens to write.
 */
export const ARTIFACT_FAMILY_SHAPE = /^[a-z][a-z0-9_]{2,63}$/;

export interface ArtifactManifestEntry {
  family: string;
  /** Rows produced. Zero is a legitimate answer — a quiet game has no events. */
  count: number;
  /** SHA-256 over the family's own canonical content, produced by its writer. */
  checksum: string;
}

export interface ManifestCompleteness {
  complete: boolean;
  /** Declared by the recipe and absent from the run. */
  missing: string[];
  /** Present on the run and not declared by the recipe. */
  undeclared: string[];
}

/**
 * Database architecture §13.1: "succeeded" means the output manifest passed
 * integrity checks, not that every worker exited zero.
 *
 * A family present with `count = 0` is complete: the run states it produced
 * none. A family *absent* is incomplete, because nothing distinguishes "none"
 * from "the step never ran". An undeclared family is also a failure — a run
 * that wrote something its contract did not promise is not the run that was
 * planned.
 */
export function assessManifest(
  required: readonly string[],
  produced: readonly ArtifactManifestEntry[],
): ManifestCompleteness {
  const seen = new Set(produced.map((entry) => entry.family));
  const declared = new Set(required);
  const missing = [...declared].filter((family) => !seen.has(family)).sort();
  const undeclared = [...seen].filter((family) => !declared.has(family)).sort();
  return { complete: missing.length === 0 && undeclared.length === 0, missing, undeclared };
}

// ---------------------------------------------------------------------------
// Cohort definitions
// ---------------------------------------------------------------------------

/**
 * Database architecture §12.7's queryable cohort fields.
 *
 * Every field is a rule over columns the canonical record already has, so the
 * definition is executable rather than descriptive. Null means "no constraint";
 * it never means "include unknown". A cohort that demands rated games excludes
 * a game whose `rated` is null, because an unknown value is not a yes — that
 * asymmetry is the whole point of §3.3's missing-information rule.
 */
export const cohortDefinitionSchema = z
  .object({
    /** Provider keys, e.g. `["lichess"]`. Null accepts any provider. */
    providers: z.array(z.string().min(1).max(32)).min(1).max(16).nullable(),
    rated: z.enum(["rated", "casual", "any"]),
    /** Provider speed buckets, e.g. `["blitz", "rapid"]`. */
    speeds: z.array(z.string().min(1).max(32)).min(1).max(16).nullable(),
    /** Bots are excluded by default: a bot game is not evidence about a human opponent. */
    includeBotOpponents: z.boolean(),
    playedFrom: z.iso.datetime({ offset: true }).nullable(),
    /** The watermark. A snapshot never includes a game played after it. */
    playedTo: z.iso.datetime({ offset: true }).nullable(),
    /** Keep only the most recent N eligible games. Null keeps all of them. */
    maxGames: z.int().min(1).max(10_000).nullable(),
    /** Coverage floor. Below it the snapshot is under-covered, not silently thin. */
    minGames: z.int().min(0).max(10_000),
    /** When true, a game with no clock data is excluded rather than assumed. */
    requireClocks: z.boolean(),
    /** Subject rating band the cohort is defined over, from the game's own rating. */
    ratingMin: z.int().min(0).max(4_000).nullable(),
    ratingMax: z.int().min(0).max(4_000).nullable(),
  })
  .strict()
  .refine(
    (value) => value.ratingMin == null || value.ratingMax == null || value.ratingMin <= value.ratingMax,
    { message: "ratingMin must not exceed ratingMax" },
  )
  .refine(
    (value) => value.playedFrom == null || value.playedTo == null || value.playedFrom <= value.playedTo,
    { message: "playedFrom must not be after playedTo" },
  );

export type CohortDefinition = z.infer<typeof cohortDefinitionSchema>;

// ---------------------------------------------------------------------------
// Identity: the hashes
// ---------------------------------------------------------------------------

export interface ComponentVersionIdentity {
  componentKey: string;
  version: string;
  /** SHA-256 of the implementation artifact: source tree, binary, or weights. */
  implementationSha256: string;
  /** Immutable configuration. Key order is irrelevant; content is not. */
  configuration: unknown;
  /** Model/binary/weights identity when applicable, otherwise null. */
  modelIdentity: unknown;
}

/**
 * The content hash of one component version.
 *
 * Two rows with this hash are the same version even if someone numbered them
 * differently, which is what makes registration idempotent: re-registering an
 * identical version returns the existing row rather than forking history.
 */
export function componentVersionHash(identity: ComponentVersionIdentity): string {
  return sha256({
    componentKey: identity.componentKey,
    version: identity.version,
    implementationSha256: identity.implementationSha256,
    configuration: identity.configuration ?? null,
    modelIdentity: identity.modelIdentity ?? null,
  });
}

export function configurationHash(configuration: unknown): string {
  return sha256(configuration ?? null);
}

export interface RecipeManifestIdentity {
  recipeKey: string;
  version: string;
  runType: RunType;
  inputSchemaVersion: string;
  outputSchemaVersion: string;
  requiredArtifacts: readonly string[];
  /** role -> component version content hash. */
  components: Record<string, string>;
}

/**
 * The manifest hash of one recipe version.
 *
 * Built from the components' *content* hashes rather than their row IDs, so two
 * deployments that registered the same versions independently agree on what the
 * recipe is. Roles and artifact families are sorted: a manifest is a set of
 * commitments, not an ordered document.
 */
export function recipeManifestHash(identity: RecipeManifestIdentity): string {
  return sha256({
    recipeKey: identity.recipeKey,
    version: identity.version,
    runType: identity.runType,
    inputSchemaVersion: identity.inputSchemaVersion,
    outputSchemaVersion: identity.outputSchemaVersion,
    requiredArtifacts: [...identity.requiredArtifacts].sort(),
    components: identity.components,
  });
}

export function cohortDefinitionHash(definition: CohortDefinition): string {
  return sha256(definition);
}

export interface SnapshotGameEntry {
  subjectGameId: string;
  replayRevisionId: string;
  /** The published materialization run the analysis will actually read. */
  materializationRunId: string;
  weight: number | null;
}

/**
 * The hash of a frozen subject snapshot.
 *
 * Covers the exact revision *and* materialization run of every game, which is
 * what database architecture §12.9 buys: a provider correction or a new
 * materializer produces a different snapshot hash instead of quietly changing
 * what a published baseline was computed from.
 */
export function snapshotHash(input: {
  subjectId: string;
  cohortDefinitionHash: string;
  cutoff: string;
  games: readonly SnapshotGameEntry[];
}): string {
  const games = [...input.games]
    .map((game) => ({
      subjectGameId: game.subjectGameId,
      replayRevisionId: String(game.replayRevisionId),
      materializationRunId: game.materializationRunId,
      weight: game.weight ?? null,
    }))
    .sort((a, b) => (a.subjectGameId < b.subjectGameId ? -1 : a.subjectGameId > b.subjectGameId ? 1 : 0));
  return sha256({
    subjectId: input.subjectId,
    cohortDefinitionHash: input.cohortDefinitionHash,
    cutoff: input.cutoff,
    games,
  });
}

export interface RunInputIdentity {
  runType: RunType;
  recipeManifestHash: string;
  scope: RunScope;
  /** Snapshot content hash when the run is snapshot-scoped, otherwise null. */
  snapshotHash: string | null;
  /** Output manifest hashes of the upstream runs this one reuses. */
  dependencyOutputHashes: readonly string[];
}

/**
 * The input manifest hash of a run.
 *
 * This is the epic's idempotency key and its reproducibility claim in one
 * value: identical inputs, identical recipe and identical reused upstream
 * outputs produce the same hash, so planning the same work twice finds the
 * first run instead of forking a second. Changing only the estimator changes
 * the recipe manifest hash and therefore this one, which is why a method-only
 * rerun is a new run that can still reuse its unchanged upstream outputs.
 */
export function runInputManifestHash(identity: RunInputIdentity): string {
  return sha256({
    runType: identity.runType,
    recipeManifestHash: identity.recipeManifestHash,
    scope: {
      subjectId: identity.scope.subjectId ?? null,
      subjectGameId: identity.scope.subjectGameId ?? null,
      replayRevisionId:
        identity.scope.replayRevisionId == null ? null : String(identity.scope.replayRevisionId),
      subjectDataSnapshotId: identity.scope.subjectDataSnapshotId ?? null,
    },
    snapshotHash: identity.snapshotHash,
    dependencyOutputHashes: [...identity.dependencyOutputHashes].sort(),
  });
}

/**
 * The output manifest hash of a succeeded run.
 *
 * Sorted by family, so two runs that wrote the same families in a different
 * order are recognised as having produced the same thing.
 */
export function outputManifestHash(artifacts: readonly ArtifactManifestEntry[]): string {
  const entries = [...artifacts]
    .map((entry) => ({ family: entry.family, count: entry.count, checksum: entry.checksum }))
    .sort((a, b) => (a.family < b.family ? -1 : a.family > b.family ? 1 : 0));
  return sha256(entries);
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

/**
 * Performance budgets for the paths this epic adds, from database architecture
 * §34. Asserted by `analysis:performance` against production-shaped fixtures,
 * so a regression is a failed command rather than an impression.
 *
 * The publication transaction is the one that matters: it holds a row lock that
 * every reader of that subject queues behind, so its cost is a contention cost
 * and not just a latency.
 *
 * `publicationMs` is measured *net of one commit on the same host*. A disposable
 * benchmark server may run with `fsync` on over container storage, where a bare
 * commit costs 100ms and swamps everything this epic controls; subtracting a
 * measured commit baseline makes the number about the transaction — its extra
 * round trips, its lock hold, its index use — rather than about the disk under
 * whichever machine ran the gate. The other budgets are read paths and pay no
 * commit, so they are absolute.
 */
export const BUDGETS = {
  /** One atomic pointer switch at p95, net of one commit's cost on the host. */
  publicationMs: 250,
  /** Freezing a 1,000-game subject snapshot, including the manifest insert. */
  snapshotBuildMs: 4_000,
  /** Resolving the version block a claim-bearing read carries. */
  versionBlockMs: 50,
  /** Recipe validation: DAG walk plus contract compatibility over one recipe. */
  recipeValidationMs: 200,
  /** Reading a 1,000-game frozen manifest back, which a subject run does once. */
  snapshotManifestReadMs: 250,
  /** One keyset page of a subject's games with its publication state attached. */
  gamePageMs: 100,
} as const;

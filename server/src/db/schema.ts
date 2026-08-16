import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  boolean,
  bigint,
  timestamp,
  numeric,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------
export const platformEnum = pgEnum("platform", ["lichess", "chesscom"]);
export const colorEnum = pgEnum("color", ["white", "black"]);
export const resultEnum = pgEnum("result", ["win", "loss", "draw"]);
export const speedEnum = pgEnum("speed", [
  "bullet",
  "blitz",
  "rapid",
  "classical",
  "correspondence",
]);
export const severityEnum = pgEnum("severity", [
  "inaccuracy",
  "mistake",
  "blunder",
]);
export const phaseEnum = pgEnum("phase", ["opening", "middlegame", "endgame"]);
export const analysisStatusEnum = pgEnum("analysis_status", [
  "pending",
  "analyzing",
  "done",
  "error",
]);
export const puzzleSourceEnum = pgEnum("puzzle_source", ["mistake", "lichess"]);
export const planEnum = pgEnum("plan", ["free", "pro"]);
export const importStatusEnum = pgEnum("analysis_import_status", [
  "queued",
  "ingesting",
  "analyzing",
  "completed",
  "failed",
  "cancelled",
]);
export const taskStatusEnum = pgEnum("analysis_task_status", [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export const analysisPassEnum = pgEnum("analysis_pass", ["screening", "deep"]);
export const openingFindingStatusEnum = pgEnum("opening_finding_status", [
  "emerging",
  "stable",
  "unstable",
  "blind_spot",
  "decaying",
]);

// ---------------------------------------------------------------------------
// profiles — one row per app user (id == Supabase auth.users.id)
// ---------------------------------------------------------------------------
export const profiles = pgTable("profiles", {
  id: uuid("id").primaryKey(), // = auth.uid()
  email: text("email"),
  displayName: text("display_name"),
  plan: planEnum("plan").notNull().default("free"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// linked_accounts — a chess.com / Lichess account a user has connected
// ---------------------------------------------------------------------------
export const linkedAccounts = pgTable(
  "linked_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    platform: platformEnum("platform").notNull(),
    username: text("username").notNull(),
    normalizedUsername: text("normalized_username").notNull(),
    providerAccountId: text("provider_account_id"),
    ratings: jsonb("ratings"), // { bullet, blitz, rapid, classical }
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("linked_accounts_uq").on(
      t.userId,
      t.platform,
      t.normalizedUsername,
    ),
  ],
);

// ---------------------------------------------------------------------------
// games — one row per game (from the connected user's perspective)
// Raw PGN + full analysis JSON live in GCS; only queryable fields are here.
// ---------------------------------------------------------------------------
export const games = pgTable(
  "games",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => linkedAccounts.id, { onDelete: "cascade" }),
    platform: platformEnum("platform").notNull(),
    platformGameId: text("platform_game_id").notNull(),
    normalizedSchemaVersion: integer("normalized_schema_version")
      .notNull()
      .default(1),
    canonicalGameId: text("canonical_game_id").notNull(),
    pgnFingerprint: text("pgn_fingerprint"),
    provenance: jsonb("provenance"),
    players: jsonb("players"),
    providerAccuracy: jsonb("provider_accuracy"),
    url: text("url"),
    playedAt: timestamp("played_at", { withTimezone: true }),
    color: colorEnum("color").notNull(), // the user's color
    result: resultEnum("result").notNull(), // from the user's perspective
    termination: text("termination"),
    speed: speedEnum("speed"),
    timeControl: text("time_control"),
    userRating: integer("user_rating"),
    opponentUsername: text("opponent_username"),
    opponentRating: integer("opponent_rating"),
    eco: text("eco"),
    openingName: text("opening_name"),
    plyCount: integer("ply_count"),
    pgnKey: text("pgn_key"), // GCS object key: raw PGN
    analysisKey: text("analysis_key"), // GCS object key: per-move analysis JSON
    analysisStatus: analysisStatusEnum("analysis_status")
      .notNull()
      .default("pending"),
    accuracy: numeric("accuracy"),
    avgCpLoss: integer("avg_cp_loss"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("games_user_platform_game_uq").on(
      t.userId,
      t.platform,
      t.platformGameId,
    ),
    index("games_user_fingerprint_idx").on(t.userId, t.pgnFingerprint),
    index("games_canonical_game_idx").on(t.canonicalGameId),
    index("games_user_played_idx").on(t.userId, t.playedAt),
    index("games_user_eco_idx").on(t.userId, t.eco),
    index("games_analysis_status_idx").on(t.analysisStatus),
  ],
);

// ---------------------------------------------------------------------------
// game_sources — every linked-account/provider occurrence of a canonical game.
// A game can be visible through multiple accounts without duplicating metrics.
// ---------------------------------------------------------------------------
export const gameSources = pgTable(
  "game_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => linkedAccounts.id, { onDelete: "cascade" }),
    platform: platformEnum("platform").notNull(),
    platformGameId: text("platform_game_id").notNull(),
    accountUsername: text("account_username").notNull(),
    accountProviderId: text("account_provider_id"),
    sourceUrl: text("source_url"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("game_sources_account_provider_game_uq").on(
      t.accountId,
      t.platform,
      t.platformGameId,
    ),
    index("game_sources_game_idx").on(t.gameId),
    index("game_sources_account_idx").on(t.accountId),
  ],
);

// ---------------------------------------------------------------------------
// canonical_moves — provider-neutral replay and optional source annotations.
// ---------------------------------------------------------------------------
export const canonicalMoves = pgTable(
  "canonical_moves",
  {
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    ply: integer("ply").notNull(),
    moveNumber: integer("move_number").notNull(),
    color: colorEnum("color").notNull(),
    uci: text("uci").notNull(),
    san: text("san").notNull(),
    fenBefore: text("fen_before").notNull(),
    fenAfter: text("fen_after").notNull(),
    clockMs: bigint("clock_ms", { mode: "number" }),
    thinkTimeMs: bigint("think_time_ms", { mode: "number" }),
    providerEvaluation: jsonb("provider_evaluation"),
    annotations: jsonb("annotations")
      .notNull()
      .default({ comment: null, nags: [], raw: {} }),
  },
  (t) => [
    primaryKey({ columns: [t.gameId, t.ply] }),
    index("canonical_moves_fen_before_idx").on(t.fenBefore),
  ],
);

// ---------------------------------------------------------------------------
// mistakes — the heart: one row per inaccuracy/mistake/blunder the user made.
// fen_before IS the puzzle position; best move IS the puzzle solution.
// ---------------------------------------------------------------------------
export const mistakes = pgTable(
  "mistakes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    ply: integer("ply").notNull(),
    moveNumber: integer("move_number").notNull(),
    color: colorEnum("color").notNull(),
    fenBefore: text("fen_before").notNull(), // the position to solve
    playedUci: text("played_uci").notNull(),
    playedSan: text("played_san").notNull(),
    bestUci: text("best_uci").notNull(),
    bestSan: text("best_san").notNull(),
    evalBeforeCp: integer("eval_before_cp"),
    evalAfterCp: integer("eval_after_cp"),
    cpLoss: integer("cp_loss").notNull(),
    severity: severityEnum("severity").notNull(),
    phase: phaseEnum("phase"),
    motif: text("motif"), // primary missed idea: fork / hanging_piece / back_rank ...
    tags: jsonb("tags"), // string[] richer tags
    depthToWin: integer("depth_to_win"), // how deep the winning idea was ("where vision ends")
    reason: text("reason"), // plain-English explanation (motif engine output)
    eco: text("eco"),
    openingName: text("opening_name"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("mistakes_user_severity_idx").on(t.userId, t.severity),
    index("mistakes_user_motif_idx").on(t.userId, t.motif),
    index("mistakes_user_eco_idx").on(t.userId, t.eco),
    index("mistakes_game_idx").on(t.gameId),
  ],
);

// ---------------------------------------------------------------------------
// puzzles — generated from a user's mistakes (source='mistake'), plus room to
// import the open Lichess puzzle DB (source='lichess'). Includes SRS fields.
// ---------------------------------------------------------------------------
export const puzzles = pgTable(
  "puzzles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => profiles.id, {
      onDelete: "cascade",
    }), // null = public/shared puzzle
    source: puzzleSourceEnum("source").notNull(),
    mistakeId: uuid("mistake_id").references(() => mistakes.id, {
      onDelete: "set null",
    }),
    fen: text("fen").notNull(),
    solution: text("solution").notNull(), // space-separated UCI line
    themes: jsonb("themes"), // string[]
    rating: integer("rating"),
    sourceGameUrl: text("source_game_url"),
    // spaced-repetition scheduling
    attempts: integer("attempts").notNull().default(0),
    solves: integer("solves").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    intervalDays: integer("interval_days").notNull().default(0),
    ease: numeric("ease").notNull().default("2.5"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("puzzles_user_due_idx").on(t.userId, t.dueAt),
    index("puzzles_mistake_idx").on(t.mistakeId),
  ],
);

// ---------------------------------------------------------------------------
// position_eval — SHARED FEN->eval cache across all users (dedupes engine work)
// ---------------------------------------------------------------------------
export const positionEval = pgTable(
  "position_eval",
  {
    fen: text("fen").notNull(),
    // Digest of all compatibility-relevant engine/profile settings.
    cacheKey: text("cache_key").notNull(),
    depth: integer("depth"),
    evalCp: integer("eval_cp"), // centipawns, White's perspective
    mate: integer("mate"), // mate-in-N, signed from White's perspective
    wdlWin: integer("wdl_win"),
    wdlDraw: integer("wdl_draw"),
    wdlLoss: integer("wdl_loss"),
    bestMoveUci: text("best_move_uci"),
    pv: text("pv"), // principal variation (space-separated UCI)
    candidates: jsonb("candidates"), // CandidateLine[] for reproducible MultiPV results
    engine: text("engine").notNull().default("stockfish"),
    engineVersion: text("engine_version"),
    binarySha256: text("binary_sha256"),
    network: text("network"),
    networkHash: text("network_hash"),
    profileId: text("profile_id").notNull(),
    profileVersion: integer("profile_version").notNull(),
    limitType: text("limit_type").notNull(),
    limitValue: integer("limit_value").notNull(),
    multiPv: integer("multi_pv").notNull(),
    threads: integer("threads").notNull(),
    hashMb: integer("hash_mb").notNull(),
    nodes: integer("nodes"),
    nps: integer("nps"),
    engineTimeMs: integer("engine_time_ms"),
    elapsedMs: integer("elapsed_ms").notNull(),
    workerRevision: text("worker_revision").notNull(),
    cacheProvenance: text("cache_provenance").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.fen, t.cacheKey] })],
);

// ---------------------------------------------------------------------------
// analysis_imports / analysis_tasks — durable two-pass orchestration.
// ---------------------------------------------------------------------------
export const analysisImports = pgTable(
  "analysis_imports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => linkedAccounts.id, { onDelete: "cascade" }),
    status: importStatusEnum("status").notNull().default("queued"),
    requestedGames: integer("requested_games").notNull(),
    discoveredGames: integer("discovered_games").notNull().default(0),
    queuedTasks: integer("queued_tasks").notNull().default(0),
    runningTasks: integer("running_tasks").notNull().default(0),
    completedTasks: integer("completed_tasks").notNull().default(0),
    failedTasks: integer("failed_tasks").notNull().default(0),
    totalPositions: integer("total_positions").notNull().default(0),
    analyzedPositions: integer("analyzed_positions").notNull().default(0),
    cacheHits: integer("cache_hits").notNull().default(0),
    deepPositions: integer("deep_positions").notNull().default(0),
    maxPositions: integer("max_positions").notNull(),
    estimatedCostUsd: numeric("estimated_cost_usd").notNull().default("0"),
    actualCostUsd: numeric("actual_cost_usd").notNull().default("0"),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("analysis_imports_user_created_idx").on(t.userId, t.createdAt),
    index("analysis_imports_status_idx").on(t.status),
  ],
);

export const analysisTasks = pgTable(
  "analysis_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    importId: uuid("import_id")
      .notNull()
      .references(() => analysisImports.id, { onDelete: "cascade" }),
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    pass: analysisPassEnum("pass").notNull(),
    status: taskStatusEnum("status").notNull().default("queued"),
    priority: integer("priority").notNull().default(0),
    idempotencyKey: text("idempotency_key").notNull(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    payload: jsonb("payload").notNull().default({}),
    result: jsonb("result"),
    error: text("error"),
    workerId: text("worker_id"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("analysis_tasks_idempotency_uq").on(t.idempotencyKey),
    index("analysis_tasks_claim_idx").on(t.status, t.priority, t.createdAt),
    index("analysis_tasks_import_idx").on(t.importId),
    index("analysis_tasks_game_idx").on(t.gameId),
  ],
);

// ---------------------------------------------------------------------------
// Opening intelligence — canonical catalogue plus player observations.
// Position keys ignore move counters, so transpositions converge.
// ---------------------------------------------------------------------------
export const openingPositions = pgTable(
  "opening_positions",
  {
    positionKey: text("position_key").primaryKey(),
    fen: text("fen").notNull(),
    eco: text("eco"),
    openingName: text("opening_name"),
    family: text("family"),
    variation: text("variation"),
    ply: integer("ply").notNull(),
    representativeLineUci: text("representative_line_uci"),
    representativeLineSan: text("representative_line_san"),
    sourceRevision: text("source_revision"),
    sourceLicense: text("source_license"),
    catalogue: boolean("catalogue").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("opening_positions_family_idx").on(t.family),
    index("opening_positions_eco_idx").on(t.eco),
  ],
).enableRLS();

export const openingEdges = pgTable(
  "opening_edges",
  {
    fromKey: text("from_key")
      .notNull()
      .references(() => openingPositions.positionKey, { onDelete: "cascade" }),
    moveUci: text("move_uci").notNull(),
    toKey: text("to_key")
      .notNull()
      .references(() => openingPositions.positionKey, { onDelete: "cascade" }),
    moveSan: text("move_san").notNull(),
    catalogue: boolean("catalogue").notNull().default(false),
    sourceRevision: text("source_revision"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.fromKey, t.moveUci, t.toKey] }),
    index("opening_edges_to_idx").on(t.toKey),
  ],
).enableRLS();

export const playerOpeningObservations = pgTable(
  "player_opening_observations",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    ply: integer("ply").notNull(),
    positionKey: text("position_key")
      .notNull()
      .references(() => openingPositions.positionKey, { onDelete: "cascade" }),
    nextPositionKey: text("next_position_key")
      .notNull()
      .references(() => openingPositions.positionKey, { onDelete: "cascade" }),
    moveUci: text("move_uci").notNull(),
    moveSan: text("move_san").notNull(),
    actorIsPlayer: boolean("actor_is_player").notNull(),
    playerColor: colorEnum("player_color").notNull(),
    platform: platformEnum("platform").notNull(),
    speed: speedEnum("speed"),
    playedAt: timestamp("played_at", { withTimezone: true }),
    result: resultEnum("result").notNull(),
    eco: text("eco"),
    openingName: text("opening_name"),
    family: text("family"),
    acceptable: boolean("acceptable"),
    acceptableReason: text("acceptable_reason"),
    evaluationLossCp: integer("evaluation_loss_cp"),
    classifierVersion: integer("classifier_version").notNull().default(2),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.gameId, t.ply] }),
    index("player_opening_observations_user_position_idx").on(t.userId, t.positionKey),
    index("player_opening_observations_user_family_idx").on(t.userId, t.family),
    index("player_opening_observations_filter_idx").on(
      t.userId,
      t.platform,
      t.speed,
      t.playerColor,
      t.playedAt,
    ),
  ],
).enableRLS();

export const openingRepertoireMoves = pgTable(
  "opening_repertoire_moves",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    positionKey: text("position_key")
      .notNull()
      .references(() => openingPositions.positionKey, { onDelete: "cascade" }),
    moveUci: text("move_uci").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("opening_repertoire_moves_user_position_move_uq").on(
      t.userId,
      t.positionKey,
      t.moveUci,
    ),
    index("opening_repertoire_moves_user_position_idx").on(t.userId, t.positionKey),
  ],
).enableRLS();

export const openingDrills = pgTable(
  "opening_drills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    positionKey: text("position_key")
      .notNull()
      .references(() => openingPositions.positionKey, { onDelete: "cascade" }),
    sourceGameId: uuid("source_game_id").references(() => games.id, {
      onDelete: "set null",
    }),
    solutionUci: text("solution_uci").notNull(),
    prompt: text("prompt").notNull(),
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("opening_drills_user_position_solution_uq").on(
      t.userId,
      t.positionKey,
      t.solutionUci,
    ),
    index("opening_drills_user_status_idx").on(t.userId, t.status),
  ],
).enableRLS();

// ---------------------------------------------------------------------------
// usage_events — metered API work that is not already represented by a durable
// game/import/training row. Ownership is always the authenticated profile.
// ---------------------------------------------------------------------------
export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    accountId: uuid("account_id").references(() => linkedAccounts.id, {
      onDelete: "set null",
    }),
    kind: text("kind").notNull(),
    units: integer("units").notNull().default(1),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("usage_events_user_created_idx").on(t.userId, t.createdAt),
    index("usage_events_account_created_idx").on(t.accountId, t.createdAt),
  ],
).enableRLS();

// ---------------------------------------------------------------------------
// player_opening_stats — precomputed per-user/per-opening aggregates
// ---------------------------------------------------------------------------
export const playerOpeningStats = pgTable(
  "player_opening_stats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    color: colorEnum("color").notNull(),
    eco: text("eco").notNull(),
    openingName: text("opening_name"),
    games: integer("games").notNull().default(0),
    wins: integer("wins").notNull().default(0),
    draws: integer("draws").notNull().default(0),
    losses: integer("losses").notNull().default(0),
    avgCpLoss: integer("avg_cp_loss"),
    avgAccuracy: numeric("avg_accuracy"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("player_opening_stats_uq").on(t.userId, t.color, t.eco)],
);

// ---------------------------------------------------------------------------
// player_style — the style "fingerprint", one row per user
// ---------------------------------------------------------------------------
export const playerStyle = pgTable("player_style", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => profiles.id, { onDelete: "cascade" }),
  gamesAnalyzed: integer("games_analyzed").notNull().default(0),
  aggression: numeric("aggression"), // 0..1
  tacticality: numeric("tacticality"), // 0..1
  openGameScore: numeric("open_game_score"), // perf in open positions
  closedGameScore: numeric("closed_game_score"),
  openingAccuracy: numeric("opening_accuracy"),
  middlegameAccuracy: numeric("middlegame_accuracy"),
  endgameAccuracy: numeric("endgame_accuracy"),
  timeTroubleBlunderRate: numeric("time_trouble_blunder_rate"),
  avgGameLength: numeric("avg_game_length"),
  favoriteOpenings: jsonb("favorite_openings"),
  computedAt: timestamp("computed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// repertoire_openings — the openings a user has chosen to study/own, per side.
// Family-level so the account page can track "how well do I know the Sicilian".
// ---------------------------------------------------------------------------
export const repertoireOpenings = pgTable(
  "repertoire_openings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    color: colorEnum("color").notNull(),
    family: text("family").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("repertoire_openings_user_color_family_uq").on(t.userId, t.color, t.family)],
).enableRLS();

// ---------------------------------------------------------------------------
// opening_training_results — one row per completed repertoire-trainer drill, so
// the account page can show times practiced, accuracy, and a knowledge estimate.
// ---------------------------------------------------------------------------
export const openingTrainingResults = pgTable(
  "opening_training_results",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    color: colorEnum("color").notNull(),
    family: text("family"),
    lineUci: text("line_uci").notNull(),
    movesCorrect: integer("moves_correct").notNull().default(0),
    movesTotal: integer("moves_total").notNull().default(0),
    reveals: integer("reveals").notNull().default(0),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("opening_training_results_user_family_idx").on(t.userId, t.family)],
).enableRLS();

// ---------------------------------------------------------------------------
// lesson_progress — per-user progress through a guided opening lesson.
// ---------------------------------------------------------------------------
export const lessonProgress = pgTable(
  "lesson_progress",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    lessonSlug: text("lesson_slug").notNull(),
    completedSteps: integer("completed_steps").notNull().default(0),
    totalSteps: integer("total_steps").notNull().default(0),
    bestScore: integer("best_score").notNull().default(0),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("lesson_progress_user_lesson_uq").on(t.userId, t.lessonSlug)],
).enableRLS();

// ---------------------------------------------------------------------------
// beta_signups — the landing page's "join beta testing" form.
//
// The only table anyone can write to without an account, so it is deliberately
// dull: five short answers, no free-form essay, nothing joined to a profile.
// A signup is not a user — these people have not authenticated and may never
// sign up — so it stands alone rather than hanging off `profiles`.
//
// RLS is on and the API writes as the table owner, which is how every other
// table here works: the anon key cannot read this list, so nobody can scrape
// the email addresses of people who asked to test.
// ---------------------------------------------------------------------------
export const betaSignups = pgTable(
  "beta_signups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /** Stored lower-cased and trimmed so the unique index actually dedupes. */
    email: text("email").notNull(),
    /** lichess | chesscom | both | otb — free text, validated at the edge. */
    platform: text("platform").notNull(),
    /** Their handle on that platform. Optional: we can chase it later. */
    username: text("username"),
    /** A band ("1400-1600"), not a number: nobody knows their exact rating across sites. */
    rating: text("rating"),
    /** What they want Forma to fix. Optional, and the most useful field we have. */
    goal: text("goal"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("beta_signups_email_uq").on(t.email)],
).enableRLS();

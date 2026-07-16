import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
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
    ratings: jsonb("ratings"), // { bullet, blitz, rapid, classical }
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("linked_accounts_uq").on(t.userId, t.platform, t.username),
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
    uniqueIndex("games_platform_game_uq").on(t.platform, t.platformGameId),
    index("games_user_played_idx").on(t.userId, t.playedAt),
    index("games_user_eco_idx").on(t.userId, t.eco),
    index("games_analysis_status_idx").on(t.analysisStatus),
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

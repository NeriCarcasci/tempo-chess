CREATE TYPE "public"."analysis_status" AS ENUM('pending', 'analyzing', 'done', 'error');--> statement-breakpoint
CREATE TYPE "public"."color" AS ENUM('white', 'black');--> statement-breakpoint
CREATE TYPE "public"."phase" AS ENUM('opening', 'middlegame', 'endgame');--> statement-breakpoint
CREATE TYPE "public"."plan" AS ENUM('free', 'pro');--> statement-breakpoint
CREATE TYPE "public"."platform" AS ENUM('lichess', 'chesscom');--> statement-breakpoint
CREATE TYPE "public"."puzzle_source" AS ENUM('mistake', 'lichess');--> statement-breakpoint
CREATE TYPE "public"."result" AS ENUM('win', 'loss', 'draw');--> statement-breakpoint
CREATE TYPE "public"."severity" AS ENUM('inaccuracy', 'mistake', 'blunder');--> statement-breakpoint
CREATE TYPE "public"."speed" AS ENUM('bullet', 'blitz', 'rapid', 'classical', 'correspondence');--> statement-breakpoint
CREATE TABLE "games" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"platform" "platform" NOT NULL,
	"platform_game_id" text NOT NULL,
	"url" text,
	"played_at" timestamp with time zone,
	"color" "color" NOT NULL,
	"result" "result" NOT NULL,
	"termination" text,
	"speed" "speed",
	"time_control" text,
	"user_rating" integer,
	"opponent_username" text,
	"opponent_rating" integer,
	"eco" text,
	"opening_name" text,
	"ply_count" integer,
	"pgn_key" text,
	"analysis_key" text,
	"analysis_status" "analysis_status" DEFAULT 'pending' NOT NULL,
	"accuracy" numeric,
	"avg_cp_loss" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "linked_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"platform" "platform" NOT NULL,
	"username" text NOT NULL,
	"ratings" jsonb,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mistakes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"game_id" uuid NOT NULL,
	"ply" integer NOT NULL,
	"move_number" integer NOT NULL,
	"color" "color" NOT NULL,
	"fen_before" text NOT NULL,
	"played_uci" text NOT NULL,
	"played_san" text NOT NULL,
	"best_uci" text NOT NULL,
	"best_san" text NOT NULL,
	"eval_before_cp" integer,
	"eval_after_cp" integer,
	"cp_loss" integer NOT NULL,
	"severity" "severity" NOT NULL,
	"phase" "phase",
	"motif" text,
	"tags" jsonb,
	"depth_to_win" integer,
	"reason" text,
	"eco" text,
	"opening_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_opening_stats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"color" "color" NOT NULL,
	"eco" text NOT NULL,
	"opening_name" text,
	"games" integer DEFAULT 0 NOT NULL,
	"wins" integer DEFAULT 0 NOT NULL,
	"draws" integer DEFAULT 0 NOT NULL,
	"losses" integer DEFAULT 0 NOT NULL,
	"avg_cp_loss" integer,
	"avg_accuracy" numeric,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_style" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"games_analyzed" integer DEFAULT 0 NOT NULL,
	"aggression" numeric,
	"tacticality" numeric,
	"open_game_score" numeric,
	"closed_game_score" numeric,
	"opening_accuracy" numeric,
	"middlegame_accuracy" numeric,
	"endgame_accuracy" numeric,
	"time_trouble_blunder_rate" numeric,
	"avg_game_length" numeric,
	"favorite_openings" jsonb,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "position_eval" (
	"fen" text NOT NULL,
	"depth" integer NOT NULL,
	"eval_cp" integer,
	"mate" integer,
	"best_move_uci" text,
	"pv" text,
	"engine" text DEFAULT 'stockfish' NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "position_eval_fen_depth_pk" PRIMARY KEY("fen","depth")
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text,
	"display_name" text,
	"plan" "plan" DEFAULT 'free' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "puzzles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"source" "puzzle_source" NOT NULL,
	"mistake_id" uuid,
	"fen" text NOT NULL,
	"solution" text NOT NULL,
	"themes" jsonb,
	"rating" integer,
	"source_game_url" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"solves" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"interval_days" integer DEFAULT 0 NOT NULL,
	"ease" numeric DEFAULT '2.5' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_account_id_linked_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."linked_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linked_accounts" ADD CONSTRAINT "linked_accounts_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mistakes" ADD CONSTRAINT "mistakes_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mistakes" ADD CONSTRAINT "mistakes_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_opening_stats" ADD CONSTRAINT "player_opening_stats_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_style" ADD CONSTRAINT "player_style_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "puzzles" ADD CONSTRAINT "puzzles_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "puzzles" ADD CONSTRAINT "puzzles_mistake_id_mistakes_id_fk" FOREIGN KEY ("mistake_id") REFERENCES "public"."mistakes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "games_platform_game_uq" ON "games" USING btree ("platform","platform_game_id");--> statement-breakpoint
CREATE INDEX "games_user_played_idx" ON "games" USING btree ("user_id","played_at");--> statement-breakpoint
CREATE INDEX "games_user_eco_idx" ON "games" USING btree ("user_id","eco");--> statement-breakpoint
CREATE INDEX "games_analysis_status_idx" ON "games" USING btree ("analysis_status");--> statement-breakpoint
CREATE UNIQUE INDEX "linked_accounts_uq" ON "linked_accounts" USING btree ("user_id","platform","username");--> statement-breakpoint
CREATE INDEX "mistakes_user_severity_idx" ON "mistakes" USING btree ("user_id","severity");--> statement-breakpoint
CREATE INDEX "mistakes_user_motif_idx" ON "mistakes" USING btree ("user_id","motif");--> statement-breakpoint
CREATE INDEX "mistakes_user_eco_idx" ON "mistakes" USING btree ("user_id","eco");--> statement-breakpoint
CREATE INDEX "mistakes_game_idx" ON "mistakes" USING btree ("game_id");--> statement-breakpoint
CREATE UNIQUE INDEX "player_opening_stats_uq" ON "player_opening_stats" USING btree ("user_id","color","eco");--> statement-breakpoint
CREATE INDEX "puzzles_user_due_idx" ON "puzzles" USING btree ("user_id","due_at");--> statement-breakpoint
CREATE INDEX "puzzles_mistake_idx" ON "puzzles" USING btree ("mistake_id");
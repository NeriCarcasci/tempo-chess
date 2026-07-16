CREATE TABLE "canonical_moves" (
	"game_id" uuid NOT NULL,
	"ply" integer NOT NULL,
	"move_number" integer NOT NULL,
	"color" "color" NOT NULL,
	"uci" text NOT NULL,
	"san" text NOT NULL,
	"fen_before" text NOT NULL,
	"fen_after" text NOT NULL,
	"clock_ms" bigint,
	"think_time_ms" bigint,
	"provider_evaluation" jsonb,
	"annotations" jsonb DEFAULT '{"comment":null,"nags":[],"raw":{}}'::jsonb NOT NULL,
	CONSTRAINT "canonical_moves_game_id_ply_pk" PRIMARY KEY("game_id","ply")
);
--> statement-breakpoint
CREATE TABLE "game_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"platform" "platform" NOT NULL,
	"platform_game_id" text NOT NULL,
	"account_username" text NOT NULL,
	"account_provider_id" text,
	"source_url" text,
	"fetched_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "games_platform_game_uq";--> statement-breakpoint
DROP INDEX "linked_accounts_uq";--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "normalized_schema_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "canonical_game_id" text;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "pgn_fingerprint" text;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "provenance" jsonb;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "players" jsonb;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "provider_accuracy" jsonb;--> statement-breakpoint
ALTER TABLE "linked_accounts" ADD COLUMN "normalized_username" text;--> statement-breakpoint
ALTER TABLE "linked_accounts" ADD COLUMN "provider_account_id" text;--> statement-breakpoint
UPDATE "games"
SET "canonical_game_id" = 'game:v1:' || "platform"::text || ':' || "platform_game_id";--> statement-breakpoint
ALTER TABLE "games" ALTER COLUMN "canonical_game_id" SET NOT NULL;--> statement-breakpoint
UPDATE "linked_accounts"
SET "normalized_username" = lower(trim("username"));--> statement-breakpoint
ALTER TABLE "linked_accounts" ALTER COLUMN "normalized_username" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "canonical_moves" ADD CONSTRAINT "canonical_moves_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_sources" ADD CONSTRAINT "game_sources_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_sources" ADD CONSTRAINT "game_sources_account_id_linked_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."linked_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "canonical_moves_fen_before_idx" ON "canonical_moves" USING btree ("fen_before");--> statement-breakpoint
CREATE UNIQUE INDEX "game_sources_account_provider_game_uq" ON "game_sources" USING btree ("account_id","platform","platform_game_id");--> statement-breakpoint
CREATE INDEX "game_sources_game_idx" ON "game_sources" USING btree ("game_id");--> statement-breakpoint
CREATE INDEX "game_sources_account_idx" ON "game_sources" USING btree ("account_id");--> statement-breakpoint
INSERT INTO "game_sources" (
	"game_id", "account_id", "platform", "platform_game_id", "account_username", "source_url", "fetched_at"
)
SELECT
	g."id", g."account_id", g."platform", g."platform_game_id", a."username", g."url", g."created_at"
FROM "games" g
JOIN "linked_accounts" a ON a."id" = g."account_id";--> statement-breakpoint
CREATE UNIQUE INDEX "games_user_platform_game_uq" ON "games" USING btree ("user_id","platform","platform_game_id");--> statement-breakpoint
CREATE INDEX "games_user_fingerprint_idx" ON "games" USING btree ("user_id","pgn_fingerprint");--> statement-breakpoint
CREATE INDEX "games_canonical_game_idx" ON "games" USING btree ("canonical_game_id");--> statement-breakpoint
CREATE UNIQUE INDEX "linked_accounts_uq" ON "linked_accounts" USING btree ("user_id","platform","normalized_username");

ALTER TABLE "position_eval" DROP CONSTRAINT "position_eval_fen_depth_pk";--> statement-breakpoint
ALTER TABLE "position_eval" ADD COLUMN "cache_key" text;--> statement-breakpoint
ALTER TABLE "position_eval" ADD COLUMN "wdl_win" integer;--> statement-breakpoint
ALTER TABLE "position_eval" ADD COLUMN "wdl_draw" integer;--> statement-breakpoint
ALTER TABLE "position_eval" ADD COLUMN "wdl_loss" integer;--> statement-breakpoint
ALTER TABLE "position_eval" ADD COLUMN "engine_version" text;--> statement-breakpoint
ALTER TABLE "position_eval" ADD COLUMN "binary_sha256" text;--> statement-breakpoint
ALTER TABLE "position_eval" ADD COLUMN "network" text;--> statement-breakpoint
ALTER TABLE "position_eval" ADD COLUMN "network_hash" text;--> statement-breakpoint
ALTER TABLE "position_eval" ADD COLUMN "profile_id" text;--> statement-breakpoint
ALTER TABLE "position_eval" ADD COLUMN "profile_version" integer;--> statement-breakpoint
ALTER TABLE "position_eval" ADD COLUMN "limit_type" text;--> statement-breakpoint
ALTER TABLE "position_eval" ADD COLUMN "limit_value" integer;--> statement-breakpoint
ALTER TABLE "position_eval" ADD COLUMN "multi_pv" integer;--> statement-breakpoint
ALTER TABLE "position_eval" ADD COLUMN "threads" integer;--> statement-breakpoint
ALTER TABLE "position_eval" ADD COLUMN "hash_mb" integer;--> statement-breakpoint
ALTER TABLE "position_eval" ADD COLUMN "nodes" integer;--> statement-breakpoint
ALTER TABLE "position_eval" ADD COLUMN "nps" integer;--> statement-breakpoint
ALTER TABLE "position_eval" ADD COLUMN "engine_time_ms" integer;--> statement-breakpoint
ALTER TABLE "position_eval" ADD COLUMN "elapsed_ms" integer;--> statement-breakpoint
ALTER TABLE "position_eval" ADD COLUMN "worker_revision" text;--> statement-breakpoint
ALTER TABLE "position_eval" ADD COLUMN "cache_provenance" text;--> statement-breakpoint
UPDATE "position_eval" SET
  "cache_key" = 'legacy-depth-v1:' || "depth"::text,
  "profile_id" = 'legacy-depth',
  "profile_version" = 1,
  "limit_type" = 'depth',
  "limit_value" = "depth",
  "multi_pv" = 1,
  "threads" = 1,
  "hash_mb" = 64,
  "elapsed_ms" = 0,
  "worker_revision" = 'pre-telemetry',
  "cache_provenance" = 'tempo';--> statement-breakpoint
ALTER TABLE "position_eval" ALTER COLUMN "cache_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "position_eval" ALTER COLUMN "profile_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "position_eval" ALTER COLUMN "profile_version" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "position_eval" ALTER COLUMN "limit_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "position_eval" ALTER COLUMN "limit_value" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "position_eval" ALTER COLUMN "multi_pv" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "position_eval" ALTER COLUMN "threads" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "position_eval" ALTER COLUMN "hash_mb" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "position_eval" ALTER COLUMN "elapsed_ms" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "position_eval" ALTER COLUMN "worker_revision" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "position_eval" ALTER COLUMN "cache_provenance" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "position_eval" ALTER COLUMN "depth" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "position_eval" ADD CONSTRAINT "position_eval_fen_cache_key_pk" PRIMARY KEY("fen","cache_key");

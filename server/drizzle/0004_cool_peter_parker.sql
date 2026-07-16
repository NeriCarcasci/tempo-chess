CREATE TYPE "public"."analysis_pass" AS ENUM('screening', 'deep');--> statement-breakpoint
CREATE TYPE "public"."analysis_import_status" AS ENUM('queued', 'ingesting', 'analyzing', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."analysis_task_status" AS ENUM('queued', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "analysis_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"status" "analysis_import_status" DEFAULT 'queued' NOT NULL,
	"requested_games" integer NOT NULL,
	"discovered_games" integer DEFAULT 0 NOT NULL,
	"queued_tasks" integer DEFAULT 0 NOT NULL,
	"running_tasks" integer DEFAULT 0 NOT NULL,
	"completed_tasks" integer DEFAULT 0 NOT NULL,
	"failed_tasks" integer DEFAULT 0 NOT NULL,
	"total_positions" integer DEFAULT 0 NOT NULL,
	"analyzed_positions" integer DEFAULT 0 NOT NULL,
	"cache_hits" integer DEFAULT 0 NOT NULL,
	"deep_positions" integer DEFAULT 0 NOT NULL,
	"max_positions" integer NOT NULL,
	"estimated_cost_usd" numeric DEFAULT '0' NOT NULL,
	"actual_cost_usd" numeric DEFAULT '0' NOT NULL,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analysis_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_id" uuid NOT NULL,
	"game_id" uuid NOT NULL,
	"pass" "analysis_pass" NOT NULL,
	"status" "analysis_task_status" DEFAULT 'queued' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"error" text,
	"worker_id" text,
	"locked_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analysis_imports" ADD CONSTRAINT "analysis_imports_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_imports" ADD CONSTRAINT "analysis_imports_account_id_linked_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."linked_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_tasks" ADD CONSTRAINT "analysis_tasks_import_id_analysis_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."analysis_imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_tasks" ADD CONSTRAINT "analysis_tasks_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analysis_imports_user_created_idx" ON "analysis_imports" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "analysis_imports_status_idx" ON "analysis_imports" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_tasks_idempotency_uq" ON "analysis_tasks" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "analysis_tasks_claim_idx" ON "analysis_tasks" USING btree ("status","priority","created_at");--> statement-breakpoint
CREATE INDEX "analysis_tasks_import_idx" ON "analysis_tasks" USING btree ("import_id");--> statement-breakpoint
CREATE INDEX "analysis_tasks_game_idx" ON "analysis_tasks" USING btree ("game_id");
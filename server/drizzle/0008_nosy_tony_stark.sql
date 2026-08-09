CREATE TABLE "lesson_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"lesson_slug" text NOT NULL,
	"completed_steps" integer DEFAULT 0 NOT NULL,
	"total_steps" integer DEFAULT 0 NOT NULL,
	"best_score" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lesson_progress" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "opening_training_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"color" "color" NOT NULL,
	"family" text,
	"line_uci" text NOT NULL,
	"moves_correct" integer DEFAULT 0 NOT NULL,
	"moves_total" integer DEFAULT 0 NOT NULL,
	"reveals" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "opening_training_results" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "repertoire_openings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"color" "color" NOT NULL,
	"family" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "repertoire_openings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "lesson_progress" ADD CONSTRAINT "lesson_progress_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_training_results" ADD CONSTRAINT "opening_training_results_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repertoire_openings" ADD CONSTRAINT "repertoire_openings_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lesson_progress_user_lesson_uq" ON "lesson_progress" USING btree ("user_id","lesson_slug");--> statement-breakpoint
CREATE INDEX "opening_training_results_user_family_idx" ON "opening_training_results" USING btree ("user_id","family");--> statement-breakpoint
CREATE UNIQUE INDEX "repertoire_openings_user_color_family_uq" ON "repertoire_openings" USING btree ("user_id","color","family");
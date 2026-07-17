CREATE TABLE "opening_repertoire_moves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"position_key" text NOT NULL,
	"move_uci" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "opening_repertoire_moves" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "opening_repertoire_moves" ADD CONSTRAINT "opening_repertoire_moves_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_repertoire_moves" ADD CONSTRAINT "opening_repertoire_moves_position_key_opening_positions_position_key_fk" FOREIGN KEY ("position_key") REFERENCES "public"."opening_positions"("position_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "opening_repertoire_moves_user_position_move_uq" ON "opening_repertoire_moves" USING btree ("user_id","position_key","move_uci");--> statement-breakpoint
CREATE INDEX "opening_repertoire_moves_user_position_idx" ON "opening_repertoire_moves" USING btree ("user_id","position_key");
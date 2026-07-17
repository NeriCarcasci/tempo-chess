CREATE TYPE "public"."opening_finding_status" AS ENUM('emerging', 'stable', 'unstable', 'blind_spot', 'decaying');--> statement-breakpoint
CREATE TABLE "opening_drills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"position_key" text NOT NULL,
	"source_game_id" uuid,
	"solution_uci" text NOT NULL,
	"prompt" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "opening_drills" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "opening_edges" (
	"from_key" text NOT NULL,
	"move_uci" text NOT NULL,
	"to_key" text NOT NULL,
	"move_san" text NOT NULL,
	"catalogue" boolean DEFAULT false NOT NULL,
	"source_revision" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opening_edges_from_key_move_uci_to_key_pk" PRIMARY KEY("from_key","move_uci","to_key")
);
--> statement-breakpoint
ALTER TABLE "opening_edges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "opening_positions" (
	"position_key" text PRIMARY KEY NOT NULL,
	"fen" text NOT NULL,
	"eco" text,
	"opening_name" text,
	"family" text,
	"variation" text,
	"ply" integer NOT NULL,
	"representative_line_uci" text,
	"representative_line_san" text,
	"source_revision" text,
	"source_license" text,
	"catalogue" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "opening_positions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "player_opening_observations" (
	"user_id" uuid NOT NULL,
	"game_id" uuid NOT NULL,
	"ply" integer NOT NULL,
	"position_key" text NOT NULL,
	"next_position_key" text NOT NULL,
	"move_uci" text NOT NULL,
	"move_san" text NOT NULL,
	"actor_is_player" boolean NOT NULL,
	"player_color" "color" NOT NULL,
	"platform" "platform" NOT NULL,
	"speed" "speed",
	"played_at" timestamp with time zone,
	"result" "result" NOT NULL,
	"eco" text,
	"opening_name" text,
	"family" text,
	"acceptable" boolean,
	"acceptable_reason" text,
	"evaluation_loss_cp" integer,
	"classifier_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_opening_observations_game_id_ply_pk" PRIMARY KEY("game_id","ply")
);
--> statement-breakpoint
ALTER TABLE "player_opening_observations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "opening_drills" ADD CONSTRAINT "opening_drills_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_drills" ADD CONSTRAINT "opening_drills_position_key_opening_positions_position_key_fk" FOREIGN KEY ("position_key") REFERENCES "public"."opening_positions"("position_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_drills" ADD CONSTRAINT "opening_drills_source_game_id_games_id_fk" FOREIGN KEY ("source_game_id") REFERENCES "public"."games"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_edges" ADD CONSTRAINT "opening_edges_from_key_opening_positions_position_key_fk" FOREIGN KEY ("from_key") REFERENCES "public"."opening_positions"("position_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opening_edges" ADD CONSTRAINT "opening_edges_to_key_opening_positions_position_key_fk" FOREIGN KEY ("to_key") REFERENCES "public"."opening_positions"("position_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_opening_observations" ADD CONSTRAINT "player_opening_observations_user_id_profiles_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_opening_observations" ADD CONSTRAINT "player_opening_observations_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_opening_observations" ADD CONSTRAINT "player_opening_observations_position_key_opening_positions_position_key_fk" FOREIGN KEY ("position_key") REFERENCES "public"."opening_positions"("position_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_opening_observations" ADD CONSTRAINT "player_opening_observations_next_position_key_opening_positions_position_key_fk" FOREIGN KEY ("next_position_key") REFERENCES "public"."opening_positions"("position_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "opening_drills_user_position_solution_uq" ON "opening_drills" USING btree ("user_id","position_key","solution_uci");--> statement-breakpoint
CREATE INDEX "opening_drills_user_status_idx" ON "opening_drills" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "opening_edges_to_idx" ON "opening_edges" USING btree ("to_key");--> statement-breakpoint
CREATE INDEX "opening_positions_family_idx" ON "opening_positions" USING btree ("family");--> statement-breakpoint
CREATE INDEX "opening_positions_eco_idx" ON "opening_positions" USING btree ("eco");--> statement-breakpoint
CREATE INDEX "player_opening_observations_user_position_idx" ON "player_opening_observations" USING btree ("user_id","position_key");--> statement-breakpoint
CREATE INDEX "player_opening_observations_user_family_idx" ON "player_opening_observations" USING btree ("user_id","family");--> statement-breakpoint
CREATE INDEX "player_opening_observations_filter_idx" ON "player_opening_observations" USING btree ("user_id","platform","speed","player_color","played_at");
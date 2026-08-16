CREATE TABLE "match_players" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"user_id" uuid,
	"is_bot" boolean DEFAULT false NOT NULL,
	"name" text NOT NULL,
	"placement" integer NOT NULL,
	"score" integer NOT NULL,
	"forfeit" boolean DEFAULT false NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "match_players_match_user_key" UNIQUE("match_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_key" text NOT NULL,
	"game_id" varchar(40) NOT NULL,
	"seed" bigint NOT NULL,
	"reason" text NOT NULL,
	"ticks" integer NOT NULL,
	"player_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "matches_match_key_key" UNIQUE("match_key")
);
--> statement-breakpoint
CREATE TABLE "player_stats" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"matches" integer DEFAULT 0 NOT NULL,
	"wins" integer DEFAULT 0 NOT NULL,
	"losses" integer DEFAULT 0 NOT NULL,
	"draws" integer DEFAULT 0 NOT NULL,
	"best_placement" integer,
	"total_score" bigint DEFAULT 0 NOT NULL,
	"coins" bigint DEFAULT 0 NOT NULL,
	"distance_metres" bigint DEFAULT 0 NOT NULL,
	"playtime_seconds" integer DEFAULT 0 NOT NULL,
	"xp" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "match_players" ADD CONSTRAINT "match_players_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_players" ADD CONSTRAINT "match_players_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_stats" ADD CONSTRAINT "player_stats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_match_players_match" ON "match_players" USING btree ("match_id");--> statement-breakpoint
CREATE INDEX "idx_match_players_user" ON "match_players" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_matches_created" ON "matches" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_matches_game" ON "matches" USING btree ("game_id","created_at");
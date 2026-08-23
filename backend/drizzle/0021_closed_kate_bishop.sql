CREATE TABLE "bot_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"uid" varchar(12) NOT NULL,
	"username" varchar(15) NOT NULL,
	"character" varchar(40),
	"weapon" varchar(40),
	"skill" integer DEFAULT 50 NOT NULL,
	"persona" varchar(12) DEFAULT 'casual' NOT NULL,
	"status" varchar(12) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_accounts_uid_key" UNIQUE("uid")
);
--> statement-breakpoint
CREATE TABLE "bot_stats" (
	"bot_id" uuid PRIMARY KEY NOT NULL,
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
CREATE TABLE "world_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"world_id" varchar(16) NOT NULL,
	"sender_id" uuid,
	"bot_id" uuid,
	"uid" varchar(12) NOT NULL,
	"name" text NOT NULL,
	"body" varchar(300) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "match_players" ADD COLUMN "bot_id" uuid;--> statement-breakpoint
ALTER TABLE "bot_stats" ADD CONSTRAINT "bot_stats_bot_id_bot_accounts_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bot_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_messages" ADD CONSTRAINT "world_messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_messages" ADD CONSTRAINT "world_messages_bot_id_bot_accounts_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bot_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bot_accounts_username_lower_key" ON "bot_accounts" USING btree (lower("username"));--> statement-breakpoint
CREATE INDEX "idx_bot_accounts_status" ON "bot_accounts" USING btree ("status","last_seen_at");--> statement-breakpoint
CREATE INDEX "idx_world_msgs_world" ON "world_messages" USING btree ("world_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_world_msgs_sender" ON "world_messages" USING btree ("sender_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_world_msgs_created" ON "world_messages" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "match_players" ADD CONSTRAINT "match_players_bot_id_bot_accounts_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bot_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_match_players_bot" ON "match_players" USING btree ("bot_id");
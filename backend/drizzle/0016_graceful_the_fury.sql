CREATE TABLE "platform_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"instance" text NOT NULL,
	"online" integer NOT NULL,
	"sockets" integer NOT NULL,
	"matches" integer NOT NULL,
	"match_players" integer NOT NULL,
	"match_bots" integer NOT NULL,
	"queued" integer NOT NULL,
	"rss_mb" integer NOT NULL,
	"by_game" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "platform_history_at_instance_key" UNIQUE("at","instance")
);
--> statement-breakpoint
CREATE INDEX "idx_platform_history_at" ON "platform_history" USING btree ("at");
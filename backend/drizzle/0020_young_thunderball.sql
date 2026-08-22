CREATE TABLE "cohorts" (
	"day" date PRIMARY KEY NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"d1" integer DEFAULT 0 NOT NULL,
	"d7" integer DEFAULT 0 NOT NULL,
	"d30" integer DEFAULT 0 NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_stats" (
	"day" date PRIMARY KEY NOT NULL,
	"dau" integer DEFAULT 0 NOT NULL,
	"mau" integer DEFAULT 0 NOT NULL,
	"new_accounts" integer DEFAULT 0 NOT NULL,
	"matches" integer DEFAULT 0 NOT NULL,
	"matches_by_game" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"avg_session_sec" integer DEFAULT 0 NOT NULL,
	"funnel_signed_in" integer DEFAULT 0 NOT NULL,
	"funnel_named" integer DEFAULT 0 NOT NULL,
	"funnel_played" integer DEFAULT 0 NOT NULL,
	"reports" integer DEFAULT 0 NOT NULL,
	"sanctions" integer DEFAULT 0 NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "match_players" ADD COLUMN "inputs" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "match_players" ADD COLUMN "rejects" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "match_players" ADD COLUMN "reject_kinds" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "match_players" ADD COLUMN "cadence" integer;